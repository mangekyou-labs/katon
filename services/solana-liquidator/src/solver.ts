import { parseAtomic, routeIsInstructionBuildable, SOLANA_USDC_MINT } from '@katon/solana-core';
import type { QuoteCandidate } from '@katon/solana-core';
import type { ManifestCheck } from './manifest';

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
}

export interface SolverConfig {
  readonly nowMs: () => number;
  readonly maxPrefundedAtomic?: string;
  readonly minProfitAtomic?: string;
  readonly minProfitBps?: number;
  readonly maxComputeUnits?: number;
}

export interface ManifestGate {
  check(): ManifestCheck;
}

export interface LiquidationStartupGate extends ManifestGate {
  readonly kind: 'liquidation-startup';
}

export interface Decision {
  readonly executable: boolean;
  readonly reason?: 'stale_health' | 'non_atomic' | 'insufficient_profit' | 'compute_limit' | 'unsupported_debt' | 'unwind_missing' | 'funding_unavailable' | 'residual_risk' | 'managed_transaction' | 'simulation_failed' | 'malformed_opportunity' | 'circuit_breaker' | 'manifest_mismatch';
  readonly funding?: FundingSource;
}

export interface CircuitBreakerState {
  readonly halted: boolean;
  readonly reason?: string;
  readonly landingFailures: number;
  readonly residualSinceMs?: number;
}

export class LiquidationCircuitBreaker {
  private state: CircuitBreakerState = { halted: false, landingFailures: 0 };

  snapshot(): CircuitBreakerState { return this.state; }

  recordLandingFailure(): CircuitBreakerState {
    const failures = this.state.landingFailures + 1;
    this.state = failures >= 3 ? { ...this.state, halted: true, reason: 'three consecutive landing failures', landingFailures: failures } : { ...this.state, landingFailures: failures };
    return this.state;
  }

  recordLandingSuccess(): CircuitBreakerState {
    this.state = { ...this.state, landingFailures: 0 };
    return this.state;
  }

  recordResidualStock(nowMs: number): CircuitBreakerState {
    const residualSinceMs = this.state.residualSinceMs ?? nowMs;
    this.state = residualSinceMs + 60_000 <= nowMs ? { ...this.state, halted: true, reason: 'residual stock exceeded one minute', residualSinceMs } : { ...this.state, residualSinceMs };
    return this.state;
  }

  recordResidualCleared(): CircuitBreakerState {
    this.state = { ...this.state, residualSinceMs: undefined };
    return this.state;
  }

  recordAdverseExecution(adverseBps: number, maxAdverseBps = 25): CircuitBreakerState {
    if (adverseBps > maxAdverseBps) return this.trip(`adverse execution exceeded ${maxAdverseBps} bps`);
    return this.state;
  }

  trip(reason: string): CircuitBreakerState {
    this.state = { ...this.state, halted: true, reason };
    return this.state;
  }
}

export function chooseFundingSource(opportunity: LiquidationOpportunity, availableFlashloanAtomic: string, config: SolverConfig): Decision {
  try {
    if (opportunity.debtMint !== 'native-usdc' && opportunity.debtMint !== SOLANA_USDC_MINT) return { executable: false, reason: 'unsupported_debt' };
    const debt = parseAtomic(opportunity.debtAtomic, 'debt amount');
    const gross = parseAtomic(opportunity.expectedGrossOutputAtomic, 'expected gross output');
    const costs = parseAtomic(opportunity.expectedCostsAtomic, 'expected costs');
    const profit = parseAtomic(opportunity.expectedProfitAtomic, 'expected profit');
    if (
      debt <= 0n
      || gross < 0n
      || costs < 0n
      || profit < 0n
      || !Number.isSafeInteger(opportunity.computeUnits)
      || !Number.isSafeInteger(opportunity.expectedProfitBps)
      || !Number.isSafeInteger(opportunity.healthFreshAtMs)
      || opportunity.computeUnits < 0
      || opportunity.expectedProfitBps < 0
    ) return { executable: false, reason: 'malformed_opportunity' };
    if (opportunity.expectedResidualStockAtomic !== undefined && parseAtomic(opportunity.expectedResidualStockAtomic, 'expected residual stock') !== 0n) return { executable: false, reason: 'residual_risk' };
    if (opportunity.healthFreshAtMs < config.nowMs() - 30_000) return { executable: false, reason: 'stale_health' };
    if (!opportunity.atomicUnwind) return { executable: false, reason: 'non_atomic' };
    if (!opportunity.route) return { executable: false, reason: 'unwind_missing' };
    if (!routeIsInstructionBuildable(opportunity.route) || !opportunity.route.transactionBase64) return { executable: false, reason: 'managed_transaction' };
    const maxCompute = Math.min(config.maxComputeUnits ?? 1_300_000, 1_300_000);
    if (opportunity.computeUnits > maxCompute) return { executable: false, reason: 'compute_limit' };
    const minimumProfit = parseAtomic(config.minProfitAtomic ?? MIN_PROFIT_ATOMIC);
    if (profit < (minimumProfit > parseAtomic(MIN_PROFIT_ATOMIC) ? minimumProfit : parseAtomic(MIN_PROFIT_ATOMIC)) || opportunity.expectedProfitBps < Math.max(config.minProfitBps ?? MIN_PROFIT_BPS, MIN_PROFIT_BPS)) return { executable: false, reason: 'insufficient_profit' };
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
  void beforeAtomic;
  return parseAtomic(afterAtomic) === 0n;
}

export interface AtomicLiquidationBuilder {
  build(opportunity: LiquidationOpportunity, funding: FundingSource): Promise<{ readonly transactionBase64: string; readonly messageHash: string }>;
}

export interface SimulationGateway {
  simulate(transactionBase64: string): Promise<{ readonly ok: boolean; readonly error?: string; readonly unitsConsumed?: number }>;
}

export class LiquidationSolver {
  constructor(
    private readonly breaker: LiquidationCircuitBreaker,
    private readonly config: SolverConfig,
    private readonly manifestGate: LiquidationStartupGate = new MissingManifestGate(),
  ) {}

  async prepare(opportunity: LiquidationOpportunity, availableFlashloanAtomic: string, builder: AtomicLiquidationBuilder, simulator: SimulationGateway): Promise<{ readonly decision: Decision; readonly transactionBase64?: string; readonly messageHash?: string }> {
    if (this.breaker.snapshot().halted) return { decision: { executable: false, reason: 'circuit_breaker' } };
    try {
      if (this.manifestGate.kind !== 'liquidation-startup') return { decision: { executable: false, reason: 'manifest_mismatch' } };
      if (!this.manifestGate.check().ok) return { decision: { executable: false, reason: 'manifest_mismatch' } };
    } catch {
      return { decision: { executable: false, reason: 'manifest_mismatch' } };
    }
    const decision = chooseFundingSource(opportunity, availableFlashloanAtomic, this.config);
    if (!decision.executable || !decision.funding) return { decision };
    try {
      const transaction = await builder.build(opportunity, decision.funding);
      if (!transaction.transactionBase64 || !transaction.messageHash) return { decision: { executable: false, reason: 'simulation_failed' } };
      const simulation = await simulator.simulate(transaction.transactionBase64);
      if (!simulation.ok) return { decision: { executable: false, reason: 'simulation_failed' } };
      return { decision, transactionBase64: transaction.transactionBase64, messageHash: transaction.messageHash };
    } catch {
      return { decision: { executable: false, reason: 'simulation_failed' } };
    }
  }
}

class MissingManifestGate implements LiquidationStartupGate {
  readonly kind = 'liquidation-startup' as const;

  check(): ManifestCheck {
    return { ok: false, reason: 'manifest_unsigned', message: 'liquidation deployment manifest gate is not configured' };
  }
}

/** A process-local lock is the minimum guard; production backs this with Redis. */
export class OpportunityLock {
  private readonly held = new Set<string>();

  acquire(id: string): boolean {
    if (this.held.has(id)) return false;
    this.held.add(id);
    return true;
  }

  release(id: string): void { this.held.delete(id); }

  isHeld(id: string): boolean { return this.held.has(id); }
}

export function exceedsAdverseExecution(expectedAtomic: string, actualAtomic: string, maxAdverseBps = 25): boolean {
  const expected = parseAtomic(expectedAtomic, 'expected output');
  const actual = parseAtomic(actualAtomic, 'actual output');
  if (expected === 0n) return true;
  if (actual >= expected) return false;
  return (expected - actual) * 10_000n > expected * BigInt(maxAdverseBps);
}
