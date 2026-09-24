import { parseAtomic, routeIsInstructionBuildable, SOLANA_USDC_MINT } from '@katon/solana-core';
import { randomUUID } from 'node:crypto';
import type { QuoteCandidate } from '@katon/solana-core';
import type { DiscoveredMarket } from './adapters';
import type { LiquidationStartupGate } from './startup';

export const MAX_PREFUNDED_USDC_ATOMIC = '2000000000';
export const MIN_PROFIT_ATOMIC = '10000000';
export const MIN_PROFIT_BPS = 50;

export type FundingSource = 'jupiter-flashloan' | 'prefunded-usdc';

export interface LiquidationOpportunity {
  readonly id: string;
  readonly collateralMint: string;
  readonly debtMint: string;
  readonly debtAtomic: string;
  readonly collateralAtomic: string;
  readonly expectedGrossOutputAtomic: string;
  readonly expectedCostsAtomic: string;
  readonly expectedProfitAtomic: string;
  readonly expectedProfitBps: number;
  readonly healthFreshAtMs: number;
  readonly atomicUnwind: boolean;
  readonly computeUnits: number;
  readonly expectedResidualStockAtomic?: string;
  readonly route?: QuoteCandidate;
  /** Exact lender market identity returned by the reviewed startup discovery. */
  readonly market: DiscoveredMarket;
}

export interface SolverConfig {
  readonly nowMs: () => number;
  /** Constrained worker identity approved by the delayed Squads enablement action. */
  readonly solverIdentity?: string;
  readonly maxPrefundedAtomic?: string;
  readonly minProfitAtomic?: string;
  readonly minProfitBps?: number;
  readonly maxComputeUnits?: number;
  readonly opportunityLeaseTtlMs?: number;
  readonly workerId?: string;
}

export interface Decision {
  readonly executable: boolean;
  readonly reason?: 'stale_health' | 'non_atomic' | 'insufficient_profit' | 'compute_limit' | 'unsupported_debt' | 'unwind_missing' | 'funding_unavailable' | 'residual_risk' | 'managed_transaction' | 'simulation_failed' | 'malformed_opportunity' | 'circuit_breaker' | 'manifest_mismatch' | 'opportunity_locked' | 'safety_state_unavailable';
  readonly funding?: FundingSource;
}

export interface CircuitBreakerState {
  readonly halted: boolean;
  readonly reason?: string;
  readonly landingFailures: number;
  readonly residualSinceMs?: number;
}

export interface OpportunityLease {
  readonly opportunityId: string;
  readonly ownerId: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

export interface LiquidationSafetyState {
  readonly breaker: CircuitBreakerState;
  readonly leases: readonly OpportunityLease[];
}

/** Durable boundary for breaker history and cross-worker opportunity leases. */
export interface LiquidationSafetyStateStore {
  load(): Promise<LiquidationSafetyState | undefined>;
  save(state: LiquidationSafetyState): void | Promise<void>;
  acquireOpportunityLease(opportunityId: string, ownerId: string, nowMs: number, ttlMs: number): Promise<boolean>;
  releaseOpportunityLease(opportunityId: string, ownerId: string): Promise<void>;
}

/** Deterministic local store; production injects a transactional Redis/SQL implementation. */
export class InMemoryLiquidationSafetyStateStore implements LiquidationSafetyStateStore {
  private state: LiquidationSafetyState;

  constructor(initial: LiquidationSafetyState = { breaker: { halted: false, landingFailures: 0 }, leases: [] }) {
    this.state = { breaker: { ...initial.breaker }, leases: [...initial.leases] };
  }

  async load(): Promise<LiquidationSafetyState> {
    return { breaker: { ...this.state.breaker }, leases: this.state.leases.map((lease) => ({ ...lease })) };
  }

  save(state: LiquidationSafetyState): void {
    this.state = { breaker: { ...state.breaker }, leases: state.leases.map((lease) => ({ ...lease })) };
  }

  async acquireOpportunityLease(opportunityId: string, ownerId: string, nowMs: number, ttlMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) return false;
    const active = this.state.leases.filter((lease) => lease.expiresAtMs > nowMs && lease.opportunityId !== opportunityId);
    const existing = this.state.leases.find((lease) => lease.opportunityId === opportunityId && lease.expiresAtMs > nowMs);
    if (existing && existing.ownerId !== ownerId) {
      this.state = { ...this.state, leases: active.concat(existing) };
      return false;
    }
    this.state = { ...this.state, leases: active.concat({ opportunityId, ownerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + ttlMs }) };
    return true;
  }

  async releaseOpportunityLease(opportunityId: string, ownerId: string): Promise<void> {
    this.state = { ...this.state, leases: this.state.leases.filter((lease) => lease.opportunityId !== opportunityId || lease.ownerId !== ownerId) };
  }
}

export class LiquidationCircuitBreaker {
  private state: CircuitBreakerState;
  private persistence: Promise<void> = Promise.resolve();

  constructor(
    initialState: CircuitBreakerState = { halted: false, landingFailures: 0 },
    private readonly store?: LiquidationSafetyStateStore,
  ) {
    this.state = { ...initialState };
  }

  static async restore(store: LiquidationSafetyStateStore): Promise<LiquidationCircuitBreaker> {
    const state = await store.load();
    if (!state?.breaker) throw new Error('liquidation safety state is unavailable');
    return new LiquidationCircuitBreaker(state.breaker, store);
  }

  snapshot(): CircuitBreakerState { return { ...this.state }; }

  /** Construction guard for executable workers: only a breaker restored from
   * the same durable store as the solver may cross the execution boundary. */
  isBoundTo(store: LiquidationSafetyStateStore): boolean { return this.store === store; }

  private persist(): void {
    if (!this.store) return;
    const snapshot = this.snapshot();
    this.persistence = this.persistence.then(async () => {
      const state = await this.store?.load();
      if (!state) throw new Error('liquidation safety state is unavailable');
      await this.store?.save({ breaker: snapshot, leases: state.leases });
    }).catch(() => {
      this.state = { ...this.state, halted: true, reason: 'liquidation safety state persistence failed' };
    });
  }

  private update(state: CircuitBreakerState): CircuitBreakerState {
    this.state = state;
    this.persist();
    return this.snapshot();
  }

  recordLandingFailure(): CircuitBreakerState {
    const failures = this.state.landingFailures + 1;
    return this.update(failures >= 3 ? { ...this.state, halted: true, reason: 'three consecutive landing failures', landingFailures: failures } : { ...this.state, landingFailures: failures });
  }

  recordLandingSuccess(): CircuitBreakerState {
    return this.update({ ...this.state, landingFailures: 0 });
  }

  recordResidualStock(nowMs: number): CircuitBreakerState {
    const residualSinceMs = this.state.residualSinceMs ?? nowMs;
    return this.update(residualSinceMs + 60_000 <= nowMs ? { ...this.state, halted: true, reason: 'residual stock exceeded one minute', residualSinceMs } : { ...this.state, residualSinceMs });
  }

  recordResidualCleared(): CircuitBreakerState {
    return this.update({ ...this.state, residualSinceMs: undefined });
  }

  /**
   * Apply the post-liquidation residual invariant at the safety boundary.
   * A malformed balance observation is a safety violation, not a recoverable
   * quote rejection, so it halts this worker until an operator restores it.
   */
  enforceZeroResidualTransition(beforeAtomic: string, afterAtomic: string): CircuitBreakerState {
    if (!requiresZeroResidualStock(beforeAtomic, afterAtomic)) {
      return this.trip('zero-residual transition invariant violated');
    }
    return this.recordResidualCleared();
  }

  recordAdverseExecution(adverseBps: number, maxAdverseBps = 25): CircuitBreakerState {
    if (adverseBps > maxAdverseBps) return this.trip(`adverse execution exceeded ${maxAdverseBps} bps`);
    return this.snapshot();
  }

  trip(reason: string): CircuitBreakerState {
    return this.update({ ...this.state, halted: true, reason });
  }
}

export function chooseFundingSource(opportunity: LiquidationOpportunity, availableFlashloanAtomic: string, config: SolverConfig): Decision {
  try {
    if (opportunity.debtMint !== 'native-usdc' && opportunity.debtMint !== SOLANA_USDC_MINT) return { executable: false, reason: 'unsupported_debt' };
    const debt = parseAtomic(opportunity.debtAtomic, 'debt amount');
    const gross = parseAtomic(opportunity.expectedGrossOutputAtomic, 'expected gross output');
    const costs = parseAtomic(opportunity.expectedCostsAtomic, 'expected costs');
    const suppliedProfit = parseAtomic(opportunity.expectedProfitAtomic, 'expected profit');
    const derivedProfit = gross - costs - debt;
    if (
      debt <= 0n
      || gross < 0n
      || costs < 0n
      || suppliedProfit < 0n
      || derivedProfit < 0n
      || !Number.isSafeInteger(opportunity.computeUnits)
      || !Number.isSafeInteger(opportunity.expectedProfitBps)
      || !Number.isSafeInteger(opportunity.healthFreshAtMs)
      || opportunity.computeUnits < 0
      || opportunity.expectedProfitBps < 0
    ) return { executable: false, reason: 'malformed_opportunity' };
    if (opportunity.expectedResidualStockAtomic !== undefined && parseAtomic(opportunity.expectedResidualStockAtomic, 'expected residual stock') !== 0n) return { executable: false, reason: 'residual_risk' };
    const derivedProfitBpsBig = (derivedProfit * 10_000n) / debt;
    if (derivedProfitBpsBig > BigInt(Number.MAX_SAFE_INTEGER)) return { executable: false, reason: 'malformed_opportunity' };
    const derivedProfitBps = Number(derivedProfitBpsBig);
    if (suppliedProfit !== derivedProfit || opportunity.expectedProfitBps !== derivedProfitBps) return { executable: false, reason: 'malformed_opportunity' };
    if (opportunity.healthFreshAtMs < config.nowMs() - 30_000) return { executable: false, reason: 'stale_health' };
    if (!opportunity.atomicUnwind) return { executable: false, reason: 'non_atomic' };
    if (!opportunity.route) return { executable: false, reason: 'unwind_missing' };
    if (!routeIsInstructionBuildable(opportunity.route) || !opportunity.route.transactionBase64) return { executable: false, reason: 'managed_transaction' };
    const maxCompute = Math.min(config.maxComputeUnits ?? 1_300_000, 1_300_000);
    if (opportunity.computeUnits > maxCompute) return { executable: false, reason: 'compute_limit' };
    const minimumProfit = parseAtomic(config.minProfitAtomic ?? MIN_PROFIT_ATOMIC);
    if (derivedProfit < (minimumProfit > parseAtomic(MIN_PROFIT_ATOMIC) ? minimumProfit : parseAtomic(MIN_PROFIT_ATOMIC)) || derivedProfitBps < Math.max(config.minProfitBps ?? MIN_PROFIT_BPS, MIN_PROFIT_BPS)) return { executable: false, reason: 'insufficient_profit' };
    const availableFlashloan = parseAtomic(availableFlashloanAtomic, 'available flashloan');
    if (availableFlashloan >= debt) return { executable: true, funding: 'jupiter-flashloan' };
    const configuredPrefunded = parseAtomic(config.maxPrefundedAtomic ?? MAX_PREFUNDED_USDC_ATOMIC);
    const maxPrefunded = configuredPrefunded < parseAtomic(MAX_PREFUNDED_USDC_ATOMIC) ? configuredPrefunded : parseAtomic(MAX_PREFUNDED_USDC_ATOMIC);
    if (debt <= maxPrefunded) return { executable: true, funding: 'prefunded-usdc' };
    return { executable: false, reason: 'funding_unavailable' };
  } catch {
    return { executable: false, reason: 'malformed_opportunity' };
  }
}

export function requiresZeroResidualStock(beforeAtomic: string, afterAtomic: string): boolean {
  try {
    const before = parseAtomic(beforeAtomic, 'residual stock before');
    const after = parseAtomic(afterAtomic, 'residual stock after');
    return before > 0n && after === 0n;
  } catch {
    return false;
  }
}

export interface AtomicLiquidationBuilder {
  build(opportunity: LiquidationOpportunity, funding: FundingSource): Promise<{ readonly transactionBase64: string; readonly messageHash: string }>;
}

export interface SimulationGateway {
  simulate(transactionBase64: string): Promise<{ readonly ok: boolean; readonly error?: string; readonly unitsConsumed?: number }>;
}

type SolverFactory = (
  breaker: LiquidationCircuitBreaker,
  config: SolverConfig,
  startupGate: LiquidationStartupGate,
  safetyStore: LiquidationSafetyStateStore,
) => LiquidationSolver;

let solverFactory: SolverFactory | undefined;

export class LiquidationSolver {
  private constructor(
    private readonly breaker: LiquidationCircuitBreaker,
    private readonly config: SolverConfig,
    private readonly startupGate: LiquidationStartupGate,
    private readonly safetyStore: LiquidationSafetyStateStore,
  ) {}

  static {
    solverFactory = (breaker, config, startupGate, safetyStore) => new LiquidationSolver(breaker, config, startupGate, safetyStore);
  }

  async prepare(opportunity: LiquidationOpportunity, availableFlashloanAtomic: string, builder: AtomicLiquidationBuilder, simulator: SimulationGateway): Promise<{ readonly decision: Decision; readonly transactionBase64?: string; readonly messageHash?: string }> {
    if (this.breaker.snapshot().halted) return { decision: { executable: false, reason: 'circuit_breaker' } };
    try {
      if (!this.startupGate.check().ok || !this.startupGate.matchesMarket(opportunity.market)) return { decision: { executable: false, reason: 'manifest_mismatch' } };
    } catch {
      return { decision: { executable: false, reason: 'manifest_mismatch' } };
    }
    const decision = chooseFundingSource(opportunity, availableFlashloanAtomic, this.config);
    if (!decision.executable || !decision.funding) return { decision };
    const leaseOwner = this.config.workerId ?? 'liquidator-worker';
    let leaseAcquired = false;
    try {
      leaseAcquired = await this.safetyStore.acquireOpportunityLease(opportunity.id, leaseOwner, this.config.nowMs(), this.config.opportunityLeaseTtlMs ?? 120_000);
      if (!leaseAcquired) return { decision: { executable: false, reason: 'opportunity_locked' } };
    } catch {
      return { decision: { executable: false, reason: 'safety_state_unavailable' } };
    }
    try {
      const transaction = await builder.build(opportunity, decision.funding);
      if (!transaction.transactionBase64 || !transaction.messageHash) {
        if (leaseAcquired) await this.safetyStore?.releaseOpportunityLease(opportunity.id, leaseOwner);
        return { decision: { executable: false, reason: 'simulation_failed' } };
      }
      const simulation = await simulator.simulate(transaction.transactionBase64);
      if (!simulation.ok) {
        if (leaseAcquired) await this.safetyStore?.releaseOpportunityLease(opportunity.id, leaseOwner);
        return { decision: { executable: false, reason: 'simulation_failed' } };
      }
      return { decision, transactionBase64: transaction.transactionBase64, messageHash: transaction.messageHash };
    } catch {
      if (leaseAcquired) await this.safetyStore?.releaseOpportunityLease(opportunity.id, leaseOwner);
      return { decision: { executable: false, reason: 'simulation_failed' } };
    }
  }

  async releaseOpportunity(opportunityId: string): Promise<void> {
    await this.safetyStore.releaseOpportunityLease(opportunityId, this.config.workerId ?? 'liquidator-worker');
  }
}

/**
 * The only construction seam for an executable solver. Keeping this factory
 * beside the private constructor prevents callers from manufacturing a solver
 * without the branded startup result.
 */
export function createLiquidationSolver(
  breaker: LiquidationCircuitBreaker,
  config: SolverConfig,
  startupGate: LiquidationStartupGate,
  safetyStore: LiquidationSafetyStateStore,
): LiquidationSolver {
  if (!solverFactory) throw new Error('liquidation solver factory is not initialized');
  if (!safetyStore || !breaker.isBoundTo(safetyStore)) {
    throw new Error('liquidation solver requires breaker state restored from its durable safety store');
  }
  return solverFactory(breaker, config, startupGate, safetyStore);
}

export class OpportunityLock {
  private readonly ownerId = randomUUID();

  constructor(private readonly store: LiquidationSafetyStateStore) {}

  acquire(id: string, nowMs = Date.now(), ttlMs = 120_000): Promise<boolean> {
    return this.store.acquireOpportunityLease(id, this.ownerId, nowMs, ttlMs);
  }

  release(id: string): Promise<void> {
    return this.store.releaseOpportunityLease(id, this.ownerId);
  }

  acquireDurable(id: string, nowMs: number, ttlMs = 120_000): Promise<boolean> {
    return this.acquire(id, nowMs, ttlMs);
  }

  releaseDurable(id: string): Promise<void> {
    return this.release(id);
  }
}

export function exceedsAdverseExecution(expectedAtomic: string, actualAtomic: string, maxAdverseBps = 25): boolean {
  const expected = parseAtomic(expectedAtomic, 'expected output');
  const actual = parseAtomic(actualAtomic, 'actual output');
  if (expected === 0n) return true;
  if (actual >= expected) return false;
  return (expected - actual) * 10_000n > expected * BigInt(maxAdverseBps);
}
