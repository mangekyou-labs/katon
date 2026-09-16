import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { EFFECTIVE_PRICE_DECIMALS, QUOTE_SPRINT_MS, adapterForIssuer, assertAtomicString, assertJupiterPayloadUnchanged, buildSession, effectivePriceAtomic, rankExecutableCandidates, routeAllowedForIssuer, sanitizeAudit } from '@katon/solana-core';
import { transactionHash, validateSignedTransaction } from '@katon/solana-sdk';
import type { AssetRegistryEntry, EligibilityResult, MintAccountSnapshot, QuoteCandidate, QuoteSession, QuoteSessionRequest, SanitizedAuditRow, SimulationResult, TradeReceipt, VerifiedSourceBalance } from '@katon/solana-core';
import { RejectingSourceBalanceProvider, type JupiterExecutor, type PrivateSender, type QuoteSource, type SourceBalanceProvider } from './sources';

export interface StoredSession {
  session: QuoteSession;
  candidates: QuoteCandidate[];
  sourceErrors: SanitizedAuditRow[];
  verifiedSourceBalances: Record<string, VerifiedSourceBalance>;
  collectionComplete: boolean;
  /** True when timestamps are sourced from the live service clock. */
  liveClock?: boolean;
  collectionPromise?: Promise<void>;
  finalizationPromise?: Promise<void>;
}

export interface AssetProvider {
  list(): readonly AssetRegistryEntry[];
  mintSnapshot(asset: AssetRegistryEntry): MintAccountSnapshot;
  balance(wallet: string, asset: AssetRegistryEntry): string;
}

export interface QuoteSimulationProvider {
  /** Simulate the issued transaction against the current quote context. */
  simulate(candidate: QuoteCandidate, nowMs: number): Promise<SimulationResult>;
}

export class RejectingQuoteSimulationProvider implements QuoteSimulationProvider {
  async simulate(): Promise<SimulationResult> {
    throw new Error('independent quote simulation is not configured');
  }
}

/** Explicitly local-only simulator used by the mock API and mock UI. */
export class MockQuoteSimulationProvider implements QuoteSimulationProvider {
  async simulate(candidate: QuoteCandidate, nowMs: number): Promise<SimulationResult> {
    if (!candidate.transactionBase64) return { ok: false, errorCode: 'transaction_unavailable', simulatedAtMs: nowMs };
    return { ok: true, unitsConsumed: 145_000, simulatedAtMs: nowMs };
  }
}

export class MemoryAssetProvider implements AssetProvider {
  private readonly assets: readonly AssetRegistryEntry[];
  private readonly snapshots = new Map<string, MintAccountSnapshot>();
  private readonly balances = new Map<string, string>();

  constructor(assets: readonly AssetRegistryEntry[]) {
    this.assets = assets;
    for (const asset of assets) {
      // Classic SPL assets do not expose Token-2022 extensions. Keep the
      // in-memory snapshot faithful to the signed registry so the same
      // provider exercises both classic and Token-2022 eligibility paths.
      const extensions: string[] = asset.extensionFingerprint.split('|').includes('metadata-pointer') ? ['metadata-pointer'] : [];
      if (asset.capabilities.transferHook) extensions.push('transfer-hook');
      if (asset.capabilities.pausable) extensions.push('pausable');
      if (asset.capabilities.scaledUiAmount) extensions.push('scaled-ui-amount');
      if (asset.capabilities.transferFee) extensions.push('transfer-fee-config');
      if (asset.capabilities.memoTransfer) extensions.push('memo-transfer');
      this.snapshots.set(asset.mint, {
        mint: asset.mint,
        ownerProgram: asset.tokenProgram,
        decimals: asset.decimals,
        extensionFingerprint: asset.extensionFingerprint,
        extensions,
        expectedHookProgram: asset.expectedHookProgram,
        paused: false,
        metadataPointer: extensions.includes('metadata-pointer') ? asset.mint : undefined,
        scaledUiAmountEnabled: asset.capabilities.scaledUiAmount,
        transferFeeBps: asset.capabilities.transferFee ? 0 : undefined,
        permanentDelegate: undefined,
        memoTransferRequired: asset.capabilities.memoTransfer,
      });
    }
  }

  setBalance(wallet: string, mint: string, atomic: string): void {
    this.balances.set(`${wallet}:${mint}`, atomic);
  }

  list(): readonly AssetRegistryEntry[] { return this.assets; }

  mintSnapshot(asset: AssetRegistryEntry): MintAccountSnapshot {
    const snapshot = this.snapshots.get(asset.mint);
    if (!snapshot) throw new Error('asset snapshot unavailable');
    return snapshot;
  }

  balance(wallet: string, asset: AssetRegistryEntry): string {
    return this.balances.get(`${wallet}:${asset.mint}`) ?? '0';
  }
}

function publicSession(stored: StoredSession): QuoteSession {
  const winner = stored.session.winner;
  return winner ? { ...stored.session, winner: { ...winner } } : stored.session;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage = 'operation timed out'): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new Error(timeoutMessage));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number, clock: () => number, timeoutMessage: string): Promise<T> {
  const remainingMs = deadlineMs - clock();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return Promise.reject(new Error(timeoutMessage));
  return withTimeout(promise, remainingMs, timeoutMessage).then((value) => {
    if (clock() > deadlineMs) throw new Error(timeoutMessage);
    return value;
  });
}

function normalizeSimulationResult(value: unknown, nowMs: number): SimulationResult {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('independent simulation returned malformed result');
  }
  const result = value as Partial<SimulationResult>;
  const simulatedAtMs = result.simulatedAtMs;
  if (typeof result.ok !== 'boolean' || typeof simulatedAtMs !== 'number' || !Number.isSafeInteger(simulatedAtMs) || simulatedAtMs < 0 || simulatedAtMs > nowMs) {
    throw new Error('independent simulation returned malformed result');
  }
  if (result.errorCode !== undefined && (typeof result.errorCode !== 'string' || result.errorCode.length === 0)) {
    throw new Error('independent simulation returned malformed result');
  }
  if (result.unitsConsumed !== undefined && (!Number.isSafeInteger(result.unitsConsumed) || result.unitsConsumed < 0)) {
    throw new Error('independent simulation returned malformed result');
  }
  return {
    ok: result.ok,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    ...(result.unitsConsumed === undefined ? {} : { unitsConsumed: result.unitsConsumed }),
    simulatedAtMs,
  };
}

export class QuoteDeskService {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly trades: TradeReceipt[] = [];
  private readonly listeners = new Map<string, Set<(session: QuoteSession) => void>>();

  constructor(
    private readonly assets: AssetProvider,
    private readonly sources: readonly QuoteSource[],
    private readonly jupiterExecutor: JupiterExecutor,
    private readonly privateSender: PrivateSender,
    private readonly clock: () => number = Date.now,
    private readonly simulator: QuoteSimulationProvider = new RejectingQuoteSimulationProvider(),
    private readonly sourceBalances: SourceBalanceProvider = new RejectingSourceBalanceProvider(),
    private readonly monotonicClock: () => number = () => performance.now(),
  ) {}

  listAssets(wallet: string, outputMint: string): readonly (AssetRegistryEntry & { readonly balanceAtomic: string; readonly eligibility: EligibilityResult })[] {
    return this.assets.list().map((asset) => ({
      ...asset,
      balanceAtomic: this.assets.balance(wallet, asset),
      eligibility: this.preflight(asset, wallet, outputMint),
    }));
  }

  async createSession(request: QuoteSessionRequest, nowMs?: number): Promise<QuoteSession> {
    const createdAtMs = nowMs ?? this.clock();
    const eligibility = this.checkRequest(request, createdAtMs);
    const id = randomUUID();
    const session = buildSession(id, request, createdAtMs, eligibility);
    const stored: StoredSession = { session, candidates: [], sourceErrors: [], verifiedSourceBalances: {}, collectionComplete: false, liveClock: nowMs === undefined };
    this.sessions.set(id, stored);
    this.emit(stored);
    if (session.state === 'collecting') this.startCollect(stored, createdAtMs);
    return publicSession(stored);
  }

  getSession(id: string, nowMs = this.clock()): QuoteSession {
    const stored = this.sessions.get(id);
    if (!stored) throw new Error('quote session not found');
    if (stored.collectionComplete && stored.session.state === 'collecting') this.startFinalize(stored, nowMs);
    this.expireIfNeeded(stored, nowMs);
    return publicSession(stored);
  }

  subscribe(id: string, listener: (session: QuoteSession) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set<(session: QuoteSession) => void>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    const stored = this.sessions.get(id);
    if (stored) {
      if (stored.collectionComplete && stored.session.state === 'collecting') this.startFinalize(stored, this.clock());
      listener(publicSession(stored));
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(id) === listeners) this.listeners.delete(id);
    };
  }

  async collectNow(id: string, nowMs?: number): Promise<QuoteSession> {
    const stored = this.sessions.get(id);
    if (!stored) throw new Error('quote session not found');
    this.startCollect(stored, nowMs ?? this.clock());
    await stored.collectionPromise;
    const finalizedAtMs = nowMs ?? this.clock();
    this.startFinalize(stored, finalizedAtMs);
    await stored.finalizationPromise;
    return this.getSession(id, finalizedAtMs);
  }

  async review(id: string, wallet: string, nowMs = this.clock()): Promise<QuoteSession> {
    const stored = this.sessions.get(id);
    if (!stored) throw new Error('quote session not found');
    this.expireIfNeeded(stored, nowMs);
    const winner = stored.session.winner;
    if (!winner || stored.session.state !== 'ready') throw new Error('quote is not ready for review');
    if (stored.session.request.wallet !== wallet || winner.wallet !== wallet) throw new Error('wallet does not match quoted seller');
    const remaining = winner.expiresAtMs - nowMs;
    if (remaining <= 2_000) {
      this.expireIfNeeded(stored, nowMs);
      throw new Error('quote expired; request a fresh quote');
    }
    const asset = this.assets.list().find((entry) => entry.mint === stored.session.request.inputMint);
    if (!asset) throw new Error('asset is not present in the signed registry');
    const eligibility = this.preflight(asset, wallet, stored.session.request.outputMint, stored.session.request.inputAmountAtomic, nowMs);
    if (eligibility.status !== 'eligible') {
      stored.session = { ...stored.session, eligibility, state: eligibility.status, failureMessage: eligibility.message };
      this.clearTransaction(stored);
      this.emit(stored);
      throw new Error(eligibility.message);
    }
    try {
      const simulation = normalizeSimulationResult(
        await withTimeout(this.simulator.simulate(winner, nowMs), 3_000, 'final quote simulation timed out'),
        nowMs,
      );
      stored.session = { ...stored.session, winner: { ...winner, simulation }, state: simulation.ok ? 'reviewing' : 'failed', failureMessage: simulation.ok ? undefined : simulation.errorCode ?? 'final simulation failed' };
      if (!simulation.ok) this.clearTransaction(stored);
      this.emit(stored);
      if (!simulation.ok) throw new Error(stored.session.failureMessage);
      return publicSession(stored);
    } catch (error) {
      if (stored.session.state !== 'failed') {
        stored.session = { ...stored.session, state: 'failed', failureMessage: error instanceof Error ? error.message : 'final simulation failed' };
        this.clearTransaction(stored);
        this.emit(stored);
      }
      throw error;
    }
  }

  async execute(id: string, wallet: string, signedTransactionBase64: string, nowMs = this.clock()): Promise<TradeReceipt> {
    const stored = this.sessions.get(id);
    if (!stored) throw new Error('quote session not found');
    this.expireIfNeeded(stored, nowMs);
    const winner = stored.session.winner;
    if (!winner || stored.session.state !== 'reviewing') throw new Error('quote requires final review before execution');
    if (winner.wallet !== wallet || stored.session.request.wallet !== wallet) throw new Error('wallet does not match quoted seller');
    if (!winner.transactionBase64 || !winner.transactionHash) throw new Error('winner transaction is unavailable');
    const validation = await validateSignedTransaction(signedTransactionBase64, {
      wallet,
      issuedQuoteId: winner.quoteId,
      issuedTransactionHash: winner.transactionHash,
      expiresAtMs: winner.expiresAtMs,
    }, nowMs);
    if (!validation.ok) throw new Error(validation.message);
    stored.session = { ...stored.session, state: 'signing' };
    this.emit(stored);
    stored.session = { ...stored.session, state: 'submitting' };
    this.emit(stored);
    try {
      if (winner.sourceKind === 'jupiter') assertJupiterPayloadUnchanged(winner.transactionBase64, signedTransactionBase64);
      const senderResult = winner.sourceKind === 'jupiter'
        ? await this.jupiterExecutor.execute(winner, signedTransactionBase64)
        : await this.privateSender.send(winner, signedTransactionBase64);
      const confirmedAtMs = nowMs + 250;
      stored.session = { ...stored.session, state: 'confirmed' };
      this.emit(stored);
      const receipt: TradeReceipt = {
        tradeId: randomUUID(),
        quoteId: winner.quoteId,
        wallet,
        signature: senderResult.signature,
        sourceKind: winner.sourceKind,
        sourceId: winner.sourceId,
        inputMint: winner.inputMint,
        outputMint: winner.outputMint,
        inputAmountAtomic: winner.inputAmountAtomic,
        grossOutputAtomic: winner.grossOutputAtomic,
        netOutputAtomic: winner.netOutputAtomic,
        katonFeeAtomic: winner.katonFeeAtomic,
        venueFeeAtomic: winner.venueFeeAtomic,
        deviationBps: winner.deviationBps,
        priceImpactBps: winner.priceImpactBps,
        effectivePriceAtomic: winner.effectivePriceAtomic,
        effectivePriceDecimals: winner.effectivePriceDecimals,
        createdAtMs: stored.session.createdAtMs,
        confirmedAtMs,
        finalizedAtMs: confirmedAtMs + 400,
      };
      this.trades.unshift(receipt);
      // Once a fill is submitted, no raw transaction payload is retained in
      // the session. Hashes and terms remain available for audit/receipt use.
      this.clearTransaction(stored);
      stored.session = { ...stored.session, state: 'finalized' };
      this.emit(stored);
      return receipt;
    } catch (error) {
      stored.session = { ...stored.session, state: 'failed', failureMessage: error instanceof Error ? error.message : 'transaction submission failed' };
      this.clearTransaction(stored);
      this.emit(stored);
      throw error;
    }
  }

  listTrades(wallet: string): readonly TradeReceipt[] {
    return this.trades.filter((trade) => trade.wallet === wallet);
  }

  private preflight(asset: AssetRegistryEntry, wallet: string, outputMint: string, requestedAmountAtomic?: string, nowMs = this.clock()): EligibilityResult {
    return adapterForIssuer(asset.issuer).preflight(asset, this.assets.mintSnapshot(asset), {
      wallet,
      walletBalanceAtomic: this.assets.balance(wallet, asset),
      requestedAmountAtomic,
      outputMint,
      nowMs,
    });
  }

  private checkRequest(request: QuoteSessionRequest, nowMs: number): EligibilityResult {
    const asset = this.assets.list().find((entry) => entry.mint === request.inputMint);
    if (!asset) return { status: 'unknown', code: 'policy_failure', message: 'asset is not present in the signed registry', checkedAtMs: nowMs };
    try {
      assertAtomicString(request.inputAmountAtomic, 'input amount');
    } catch {
      return { status: 'unknown', code: 'malformed_quote', message: 'input amount could not be validated', asset, checkedAtMs: nowMs };
    }
    return this.preflight(asset, request.wallet, request.outputMint, request.inputAmountAtomic, nowMs);
  }

  private startCollect(stored: StoredSession, nowMs: number): void {
    if (!stored.collectionPromise) stored.collectionPromise = this.collect(stored.session.id, nowMs);
  }

  private async collect(id: string, nowMs = this.clock()): Promise<void> {
    const stored = this.sessions.get(id);
    if (!stored || stored.session.state !== 'collecting') return;
    const asset = this.assets.list().find((entry) => entry.mint === stored.session.request.inputMint);
    if (!asset) {
      stored.collectionComplete = true;
      return;
    }
    const sprintDeadline = this.monotonicClock() + QUOTE_SPRINT_MS;
    const settled = await Promise.all(this.sources.map(async (source) => {
      try {
        const quoteNowMs = stored.liveClock ? this.clock() : nowMs;
        const sourceCandidate = await withDeadline(source.quote(stored.session.request, asset, quoteNowMs), sprintDeadline, this.monotonicClock, 'quote sprint timed out');
        if (sourceCandidate.sourceId !== source.id || sourceCandidate.sourceKind !== source.kind || sourceCandidate.settlementRoute !== source.settlementRoute) {
          throw new Error('source identity does not match quote');
        }
        if (!routeAllowedForIssuer(asset.issuer, sourceCandidate)) {
          throw new Error('source route is not allowed for issuer');
        }
        // Reliability is adapter configuration, not untrusted quote payload
        // data. Normalize it before the candidate reaches the ranker.
        const candidate = { ...sourceCandidate, reliabilityBps: source.reliabilityBps };
        const simulationNowMs = stored.liveClock ? this.clock() : nowMs;
        const independentSimulation = normalizeSimulationResult(
          await withDeadline(this.simulator.simulate(candidate, simulationNowMs), sprintDeadline, this.monotonicClock, 'quote simulation timed out'),
          simulationNowMs,
        );
        const simulatedCandidate = { ...candidate, simulation: independentSimulation };
        let verifiedSourceBalance: VerifiedSourceBalance | undefined;
        if (simulatedCandidate.sourceKind === 'private-maker') {
          try {
            const balanceNowMs = stored.liveClock ? this.clock() : nowMs;
            verifiedSourceBalance = await withDeadline(this.sourceBalances.verify(source, simulatedCandidate, asset, balanceNowMs), sprintDeadline, this.monotonicClock, 'source balance verification timed out');
          } catch {
            // Ranking fails closed when a maker's independently verified balance is absent.
          }
        }
        return { source, candidate: simulatedCandidate, verifiedSourceBalance } as const;
      } catch (error) {
        return { source, error } as const;
      }
    }));
    for (const result of settled) {
      if ('error' in result) {
        stored.sourceErrors.push({ sourceClass: result.source.kind, receivedAtMs: stored.liveClock ? this.clock() : nowMs, rejectionCode: 'source_error', status: 'rejected' });
      } else {
        stored.candidates.push(result.candidate);
        if (result.verifiedSourceBalance) stored.verifiedSourceBalances[result.candidate.sourceId] = result.verifiedSourceBalance;
      }
    }
    stored.collectionComplete = true;
  }

  private startFinalize(stored: StoredSession, nowMs: number): void {
    if (!stored.finalizationPromise) stored.finalizationPromise = this.finalizeCollection(stored, nowMs);
  }

  private async finalizeCollection(stored: StoredSession, nowMs: number): Promise<void> {
    if (!stored.collectionComplete || stored.session.state !== 'collecting') return;
    const asset = this.assets.list().find((entry) => entry.mint === stored.session.request.inputMint);
    if (!asset) {
      stored.candidates = [];
      stored.verifiedSourceBalances = {};
      stored.session = { ...stored.session, state: 'no_quote', audit: sanitizeAudit(stored.sourceErrors) };
      this.emit(stored);
      return;
    }
    const ranked = rankExecutableCandidates({
      candidates: stored.candidates,
      nowMs,
      inputMint: stored.session.request.inputMint,
      outputMint: stored.session.request.outputMint,
      inputAmountAtomic: stored.session.request.inputAmountAtomic,
      issuer: asset.issuer,
      inputDecimals: asset.decimals,
      outputDecimals: 6,
      referencePriceAtomic: asset.referencePriceAtomic,
      referencePriceDecimals: asset.referencePriceDecimals,
      wallet: stored.session.request.wallet,
      maxDeviationBps: asset.maxDeviationBps,
      verifiedSourceBalances: stored.verifiedSourceBalances,
    });
    const winner = ranked.winner
      ? {
          ...ranked.winner,
          effectivePriceAtomic: effectivePriceAtomic(
            ranked.winner.inputAmountAtomic,
            ranked.winner.netOutputAtomic,
            asset.decimals,
          ),
          effectivePriceDecimals: EFFECTIVE_PRICE_DECIMALS,
          transactionHash: ranked.winner.transactionBase64 ? await transactionHash(ranked.winner.transactionBase64) : undefined,
        }
      : undefined;
    // Losing source payloads are never retained after ranking. The only raw
    // transaction that may remain in memory is the issued winner, and it is
    // removed on expiry or after submission.
    stored.candidates = [];
    stored.verifiedSourceBalances = {};
    stored.session = { ...stored.session, state: winner ? 'ready' : 'no_quote', winner, audit: sanitizeAudit([...stored.sourceErrors, ...ranked.audit]) };
    this.emit(stored);
  }

  private expireIfNeeded(stored: StoredSession, nowMs = this.clock()): void {
    if (stored.session.winner && stored.session.winner.expiresAtMs - nowMs <= 2_000 && ['ready', 'reviewing', 'signing'].includes(stored.session.state)) {
      stored.session = { ...stored.session, state: 'expired', failureMessage: 'quote expired; request a fresh executable price' };
      this.clearTransaction(stored);
      this.emit(stored);
    }
  }

  private clearTransaction(stored: StoredSession): void {
    if (!stored.session.winner?.transactionBase64) return;
    stored.session = { ...stored.session, winner: { ...stored.session.winner, transactionBase64: undefined } };
  }

  private emit(stored: StoredSession): void {
    const listeners = this.listeners.get(stored.session.id);
    if (!listeners) return;
    const snapshot = publicSession(stored);
    for (const listener of listeners) listener(snapshot);
  }
}
