import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  EFFECTIVE_PRICE_DECIMALS,
  QUOTE_SPRINT_MS,
  adapterForIssuer,
  assertAtomicString,
  assertJupiterPayloadUnchanged,
  buildSession,
  effectivePriceAtomic,
  encodeBase58,
  rankExecutableCandidates,
  routeAllowedForIssuer,
  sanitizeAudit,
} from '@katon/solana-core';
import { transactionHash, validateSignedTransaction } from '@katon/solana-sdk';
import type {
  AssetCapability,
  AssetRegistryEntry,
  EligibilityResult,
  ExecutionAttempt,
  ExecutionEvidence,
  MintAccountSnapshot,
  QuoteCandidate,
  QuoteSession,
  QuoteSessionRequest,
  SanitizedAuditRow,
  SimulationResult,
  TradeReceipt,
  VerifiedSourceBalance,
} from '@katon/solana-core';
import { RejectingSourceBalanceProvider, SubmissionUncertainError, type JupiterExecutor, type PrivateSender, type QuoteSource, type SourceBalanceProvider } from './sources';
import { localReferencePolicySnapshot, type ReferencePolicyProvider, type ReferencePolicySnapshot } from './reference-policy';

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
  authorizedSignedTransactionBase64?: string;
  executionAttempts: Map<string, { attempt: ExecutionAttempt; receipt?: TradeReceipt }>;
}

export interface AssetProvider {
  list(): readonly AssetRegistryEntry[];
  mintSnapshot(asset: AssetRegistryEntry): MintAccountSnapshot;
  balance(wallet: string, asset: AssetRegistryEntry): string;
  /** Refresh policy, mint, token-account, and wallet balances from RPC before a gated action. */
  refresh?(wallet: string, inputMint: string, outputMint?: string): Promise<void>;
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
        metadataPointer: asset.expectedMetadataPointer,
        issuerAuthorityFingerprint: asset.issuerAuthorityFingerprint,
        issuerProgram: asset.issuerProgram,
        jitCapabilityFingerprint: asset.jitCapabilityFingerprint,
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

export type PublicQuoteSession = QuoteSession & { readonly referencePolicy?: ReferencePolicySnapshot };

function publicSession(stored: StoredSession, referencePolicy?: ReferencePolicySnapshot): PublicQuoteSession {
  const winner = stored.session.winner;
  return {
    ...(winner ? { ...stored.session, winner: { ...winner } } : stored.session),
    ...(referencePolicy ? { referencePolicy } : {}),
  };
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

type NormalizedExecutionEvidence = Omit<ExecutionEvidence, 'submittedAtMs' | 'confirmedAtMs'> & {
  readonly submittedAtMs: number;
  readonly confirmedAtMs: number;
};

function normalizeExecutionEvidence(value: unknown): NormalizedExecutionEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('sender returned malformed commitment evidence');
  const evidence = value as Partial<ExecutionEvidence>;
  if (typeof evidence.signature !== 'string' || evidence.signature.length === 0) throw new Error('sender returned no transaction signature');
  if (evidence.signature.startsWith('mock-')) throw new Error('sender returned a mock signature');
  if (evidence.commitment !== 'confirmed' && evidence.commitment !== 'finalized') throw new Error('sender returned an unsupported commitment');
  const timestamps = [evidence.submittedAtMs, evidence.confirmedAtMs, evidence.finalizedAtMs];
  if (timestamps.some((timestamp) => timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < 0))) throw new Error('sender returned malformed commitment timestamps');
  if (evidence.submittedAtMs === undefined || evidence.confirmedAtMs === undefined || evidence.confirmedAtMs < evidence.submittedAtMs) throw new Error('sender omitted confirmation evidence');
  const submittedAtMs = evidence.submittedAtMs;
  const confirmedAtMs = evidence.confirmedAtMs;
  if (evidence.finalizedAtMs !== undefined && evidence.finalizedAtMs < confirmedAtMs) throw new Error('sender returned non-monotonic commitment evidence');
  if (evidence.commitment === 'confirmed' && evidence.finalizedAtMs !== undefined) throw new Error('sender returned finalization evidence with confirmed commitment');
  if (evidence.commitment === 'finalized' && (evidence.finalizedAtMs === undefined || evidence.finalizedAtMs < evidence.confirmedAtMs)) throw new Error('sender omitted finalization evidence');
  return {
    signature: evidence.signature,
    submittedAtMs,
    confirmedAtMs,
    ...(evidence.finalizedAtMs === undefined ? {} : { finalizedAtMs: evidence.finalizedAtMs }),
    commitment: evidence.commitment,
    ...(evidence.cluster === undefined ? {} : { cluster: evidence.cluster }),
    ...(evidence.slot === undefined ? {} : { slot: evidence.slot }),
    ...(evidence.stockMint === undefined ? {} : { stockMint: evidence.stockMint }),
    ...(evidence.stableMint === undefined ? {} : { stableMint: evidence.stableMint }),
    ...(evidence.stockTokenProgram === undefined ? {} : { stockTokenProgram: evidence.stockTokenProgram }),
    ...(evidence.stableTokenProgram === undefined ? {} : { stableTokenProgram: evidence.stableTokenProgram }),
    ...(evidence.sellerStockDeltaAtomic === undefined ? {} : { sellerStockDeltaAtomic: evidence.sellerStockDeltaAtomic }),
    ...(evidence.makerStockDeltaAtomic === undefined ? {} : { makerStockDeltaAtomic: evidence.makerStockDeltaAtomic }),
    ...(evidence.makerStableDeltaAtomic === undefined ? {} : { makerStableDeltaAtomic: evidence.makerStableDeltaAtomic }),
    ...(evidence.sellerStableDeltaAtomic === undefined ? {} : { sellerStableDeltaAtomic: evidence.sellerStableDeltaAtomic }),
    ...(evidence.feeStableDeltaAtomic === undefined ? {} : { feeStableDeltaAtomic: evidence.feeStableDeltaAtomic }),
    ...(evidence.fillReceipt === undefined ? {} : { fillReceipt: evidence.fillReceipt }),
  };
}

function projectCapability(asset: AssetRegistryEntry, eligibility: EligibilityResult): AssetCapability {
  if (asset.issuer === 'ondo' && !asset.enabled) return 'informational';
  if (!asset.enabled) return 'unavailable';
  if (eligibility.status === 'eligible') return 'executable';
  if (eligibility.status === 'action_required' || eligibility.status === 'ineligible') return 'informational';
  return 'unavailable';
}

function notFoundError(): Error {
  return new Error('quote sprint not found');
}

function makerPublicKeysFromSources(sources: readonly QuoteSource[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const source of sources) {
    const maybe = source as QuoteSource & { readonly makerPublicKey?: Uint8Array };
    if (maybe.makerPublicKey instanceof Uint8Array && maybe.makerPublicKey.length === 32) {
      keys[source.id] = encodeBase58(maybe.makerPublicKey);
    }
  }
  return keys;
}

export class QuoteDeskService {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly trades: TradeReceipt[] = [];
  private readonly listeners = new Map<string, Set<(session: QuoteSession) => void>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly makerPublicKeys: Record<string, string>;
  private readonly sources: QuoteSource[];
  private readonly disabledSourceIds = new Set<string>();
  private readonly operatorDisabledSourceIds = new Set<string>();
  private readonly governedMakerSourceIds = new Set<string>();
  private newQuoteSprintsEnabled = true;

  constructor(
    private readonly assets: AssetProvider,
    sources: readonly QuoteSource[],
    private readonly jupiterExecutor: JupiterExecutor,
    private readonly privateSender: PrivateSender,
    private readonly clock: () => number = Date.now,
    private readonly simulator: QuoteSimulationProvider = new RejectingQuoteSimulationProvider(),
    private readonly sourceBalances: SourceBalanceProvider = new RejectingSourceBalanceProvider(),
    private readonly monotonicClock: () => number = () => performance.now(),
    private readonly referencePolicyProvider?: ReferencePolicyProvider,
  ) {
    this.sources = [...sources];
    this.makerPublicKeys = makerPublicKeysFromSources(sources);
  }

  registerMakerSource(source: QuoteSource, makerPublicKey: string): void {
    if (source.kind !== 'private-maker' || !makerPublicKey || this.sources.some((entry) => entry.id === source.id)) throw new Error('maker source is invalid or already registered');
    this.sources.push(source);
    this.makerPublicKeys[source.id] = makerPublicKey;
  }

  /** Applies read-only, exact-key governance evidence. It cannot clear an immediate disable. */
  observeGovernedMaker(sourceId: string, makerPublicKey: string, enabled: boolean): void {
    const source = this.sources.find((entry) => entry.id === sourceId);
    if (!source || source.kind !== 'private-maker' || this.makerPublicKeys[sourceId] !== makerPublicKey) {
      throw new Error('governance observation does not match the configured Private Maker identity');
    }
    if (enabled) this.governedMakerSourceIds.add(sourceId);
    else this.governedMakerSourceIds.delete(sourceId);
  }

  listAssets(wallet: string, outputMint: string): readonly (AssetRegistryEntry & { readonly balanceAtomic: string; readonly eligibility: EligibilityResult; readonly capability: AssetCapability; readonly referencePolicy: ReferencePolicySnapshot })[] {
    const referencePolicy = this.referencePolicyStatus();
    return this.assets.list().map((asset) => {
      const eligibility = asset.issuer === 'ondo' && !asset.enabled
        ? {
            status: 'ineligible' as const,
            code: 'policy_failure' as const,
            message: 'Managed Route not enabled',
            asset,
            balanceAtomic: this.assets.balance(wallet, asset),
            checkedAtMs: this.clock(),
          }
        : this.preflight(asset, wallet, outputMint);
      return {
        ...asset,
        balanceAtomic: this.assets.balance(wallet, asset),
        eligibility,
        capability: projectCapability(asset, eligibility),
        referencePolicy,
      };
    });
  }

  async createSession(request: QuoteSessionRequest, nowMs?: number): Promise<PublicQuoteSession> {
    await this.refreshReferencePolicy(nowMs ?? this.clock());
    await this.assets.refresh?.(request.wallet, request.inputMint, request.outputMint);
    const createdAtMs = nowMs ?? this.clock();
    const eligibility = this.checkRequest(request, createdAtMs);
    const id = randomUUID();
    const session = buildSession(id, request, createdAtMs, eligibility);
    const stored: StoredSession = {
      session,
      candidates: [],
      sourceErrors: [],
      verifiedSourceBalances: {},
      collectionComplete: false,
      liveClock: nowMs === undefined,
      executionAttempts: new Map(),
    };
    this.sessions.set(id, stored);
    this.emit(stored);
    if (session.state === 'collecting') this.startCollect(stored, createdAtMs);
    return this.publicSession(stored);
  }

  /** External Quote Sprint create alias. */
  createQuoteSprint(request: QuoteSessionRequest, nowMs?: number): Promise<PublicQuoteSession> {
    return this.createSession(request, nowMs);
  }

  getSession(id: string, nowMs = this.clock()): PublicQuoteSession {
    const stored = this.requireSession(id);
    if (stored.collectionComplete && stored.session.state === 'collecting') this.startFinalize(stored, nowMs);
    this.expireIfNeeded(stored, nowMs);
    return this.publicSession(stored);
  }

  getQuoteSprint(id: string, nowMs = this.clock()): PublicQuoteSession {
    return this.getSession(id, nowMs);
  }

  subscribe(id: string, listener: (session: PublicQuoteSession) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set<(session: QuoteSession) => void>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    const stored = this.sessions.get(id);
    if (stored) {
      if (stored.collectionComplete && stored.session.state === 'collecting') this.startFinalize(stored, this.clock());
      listener(this.publicSession(stored));
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(id) === listeners) this.listeners.delete(id);
    };
  }

  async collectNow(id: string, nowMs?: number): Promise<PublicQuoteSession> {
    const stored = this.requireSession(id);
    this.startCollect(stored, nowMs ?? this.clock());
    await stored.collectionPromise;
    const finalizedAtMs = nowMs ?? this.clock();
    this.startFinalize(stored, finalizedAtMs);
    await stored.finalizationPromise;
    return this.getSession(id, finalizedAtMs);
  }

  async review(id: string, wallet: string, nowMs = this.clock()): Promise<PublicQuoteSession> {
    await this.refreshReferencePolicy(nowMs);
    const stored = this.requireSession(id);
    const reviewNowMs = stored.liveClock ? this.clock() : nowMs;
    this.expireIfNeeded(stored, reviewNowMs);
    const winner = stored.session.winner;
    if (!winner || stored.session.state !== 'winner_ready') throw new Error('quote is not ready for review');
    if (stored.session.request.wallet !== wallet || winner.wallet !== wallet) throw new Error('wallet does not match quoted seller');
    this.assertReferencePolicyReady(stored, reviewNowMs, 'review');
    const remaining = winner.expiresAtMs - reviewNowMs;
    if (remaining <= 2_000) {
      this.expireIfNeeded(stored, reviewNowMs);
      throw new Error('quote expired; request a fresh quote');
    }
    const asset = this.assets.list().find((entry) => entry.mint === stored.session.request.inputMint);
    if (!asset) throw new Error('asset is not present in the signed registry');
    await this.assets.refresh?.(wallet, asset.mint, stored.session.request.outputMint);
    const eligibility = this.preflight(asset, wallet, stored.session.request.outputMint, stored.session.request.inputAmountAtomic, reviewNowMs);
    if (eligibility.status !== 'eligible') {
      stored.session = { ...stored.session, eligibility, state: eligibility.status, failureMessage: eligibility.message };
      this.clearTransaction(stored);
      this.emit(stored);
      throw new Error(eligibility.message);
    }
    try {
      const simulation = normalizeSimulationResult(
        await withTimeout(this.simulator.simulate(winner, reviewNowMs), 3_000, 'final quote simulation timed out'),
        reviewNowMs,
      );
      await this.refreshReferencePolicy(stored.liveClock ? this.clock() : nowMs);
      const finalReviewNowMs = stored.liveClock ? this.clock() : nowMs;
      this.assertReferencePolicyReady(stored, finalReviewNowMs, 'review');
      if (winner.expiresAtMs - finalReviewNowMs <= 2_000) {
        this.expireIfNeeded(stored, finalReviewNowMs);
        throw new Error('quote expired; request a fresh quote');
      }
      // Review is audit-only / final sim. Lifecycle stays winner_ready.
      stored.session = {
        ...stored.session,
        winner: { ...winner, simulation },
        state: simulation.ok ? 'winner_ready' : 'failed',
        failureMessage: simulation.ok ? undefined : simulation.errorCode ?? 'final simulation failed',
      };
      if (!simulation.ok) this.clearTransaction(stored);
      this.emit(stored);
      if (!simulation.ok) throw new Error(stored.session.failureMessage);
      return this.publicSession(stored);
    } catch (error) {
      if (stored.session.state !== 'failed' && stored.session.state !== 'expired') {
        stored.session = { ...stored.session, state: 'failed', failureMessage: error instanceof Error ? error.message : 'final simulation failed' };
        this.clearTransaction(stored);
        this.emit(stored);
      }
      throw error;
    }
  }

  async authorize(
    id: string,
    wallet: string,
    reviewHash: string,
    signedTransactionBase64: string,
    nowMs = this.clock(),
  ): Promise<PublicQuoteSession> {
    await this.refreshReferencePolicy(nowMs);
    const stored = this.requireSession(id);
    const authorizeNowMs = stored.liveClock ? this.clock() : nowMs;
    this.expireIfNeeded(stored, authorizeNowMs);
    this.assertReferencePolicyReady(stored, authorizeNowMs, 'authorization');
    const winner = stored.session.winner;
    if (stored.session.state === 'expired') throw new Error('quote expired; request a fresh quote');
    if (!winner || stored.session.state !== 'winner_ready') throw new Error('quote is not ready for authorization');
    this.assertSourceActive(winner.sourceId, 'authorization');
    if (winner.wallet !== wallet || stored.session.request.wallet !== wallet) throw new Error('wallet does not match quoted seller');
    if (!winner.transactionBase64 || !winner.transactionHash) throw new Error('winner transaction is unavailable');
    if (reviewHash !== winner.transactionHash) throw new Error('review hash does not match issued winner transaction');
    const makerPublicKey = winner.sourceKind === 'private-maker' ? this.makerPublicKeys[winner.sourceId] : undefined;
    const validation = await validateSignedTransaction(signedTransactionBase64, {
      wallet,
      issuedQuoteId: winner.quoteId,
      issuedTransactionHash: winner.transactionHash,
      expiresAtMs: winner.expiresAtMs,
      ...(makerPublicKey === undefined ? {} : { makerPublicKey }),
    }, authorizeNowMs);
    if (!validation.ok) throw new Error(validation.message);
    if (winner.sourceKind === 'jupiter') assertJupiterPayloadUnchanged(winner.transactionBase64, signedTransactionBase64);
    const postValidateNowMs = stored.liveClock ? this.clock() : nowMs;
    if (winner.expiresAtMs - postValidateNowMs <= 2_000) {
      this.expireIfNeeded(stored, postValidateNowMs);
      throw new Error('quote expired; request a fresh quote');
    }
    stored.authorizedSignedTransactionBase64 = signedTransactionBase64;
    stored.session = { ...stored.session, state: 'authorized' };
    this.emit(stored);
    return this.publicSession(stored);
  }

  async createExecutionAttempt(
    input: { readonly quoteSprintId: string; readonly idempotencyKey: string },
    nowMs = this.clock(),
  ): Promise<{ attempt: ExecutionAttempt; receipt?: TradeReceipt }> {
    const stored = this.requireSession(input.quoteSprintId);
    const existing = stored.executionAttempts.get(input.idempotencyKey);
    if (existing) return { attempt: existing.attempt, ...(existing.receipt === undefined ? {} : { receipt: existing.receipt }) };

    await this.refreshReferencePolicy(nowMs);
    const executeNowMs = stored.liveClock ? this.clock() : nowMs;
    this.expireIfNeeded(stored, executeNowMs);
    this.assertReferencePolicyReady(stored, executeNowMs, 'execution');
    const winner = stored.session.winner;
    if (!winner || stored.session.state !== 'authorized') throw new Error('quote requires authorization before execution');
    this.assertSourceActive(winner.sourceId, 'execution');
    if (!winner.transactionBase64 || !winner.transactionHash) throw new Error('winner transaction is unavailable');
    const signedTransactionBase64 = stored.authorizedSignedTransactionBase64;
    if (!signedTransactionBase64) throw new Error('authorized transaction is unavailable');
    if (winner.expiresAtMs - executeNowMs <= 2_000) {
      this.expireIfNeeded(stored, executeNowMs);
      throw new Error('quote expired; request a fresh quote');
    }

    const attemptId = randomUUID();
    let attempt: ExecutionAttempt = {
      id: attemptId,
      quoteSprintId: input.quoteSprintId,
      idempotencyKey: input.idempotencyKey,
      state: 'submitting',
      createdAtMs: executeNowMs,
    };
    stored.executionAttempts.set(input.idempotencyKey, { attempt });
    stored.session = { ...stored.session, state: 'signing' };
    this.emit(stored);
    stored.session = { ...stored.session, state: 'submitting' };
    this.emit(stored);

    try {
      if (winner.sourceKind === 'jupiter') assertJupiterPayloadUnchanged(winner.transactionBase64, signedTransactionBase64);
      const senderResult = winner.sourceKind === 'jupiter'
        ? await this.jupiterExecutor.execute(winner, signedTransactionBase64)
        : await this.privateSender.send(winner, signedTransactionBase64);
      const evidence = normalizeExecutionEvidence(senderResult);
      stored.session = { ...stored.session, state: 'confirmed' };
      this.emit(stored);
      const receipt: TradeReceipt = {
        tradeId: randomUUID(),
        quoteId: winner.quoteId,
        wallet: winner.wallet,
        signature: evidence.signature,
        sourceKind: winner.sourceKind,
        sourceId: winner.sourceId,
        inputMint: winner.inputMint,
        outputMint: winner.outputMint,
        inputAmountAtomic: winner.inputAmountAtomic,
        grossOutputAtomic: winner.grossOutputAtomic,
        netOutputAtomic: winner.netOutputAtomic,
        katonFeeAtomic: winner.katonFeeAtomic,
        katonFeeBps: winner.katonFeeBps,
        venueFeeAtomic: winner.venueFeeAtomic,
        deviationBps: winner.deviationBps,
        priceImpactBps: winner.priceImpactBps,
        effectivePriceAtomic: winner.effectivePriceAtomic,
        effectivePriceDecimals: winner.effectivePriceDecimals,
        createdAtMs: stored.session.createdAtMs,
        submittedAtMs: evidence.submittedAtMs,
        confirmedAtMs: evidence.confirmedAtMs,
        commitment: evidence.commitment,
        ...(evidence.finalizedAtMs === undefined ? {} : { finalizedAtMs: evidence.finalizedAtMs }),
        ...(evidence.cluster === undefined ? {} : { cluster: evidence.cluster }),
        ...(evidence.slot === undefined ? {} : { slot: evidence.slot }),
        ...(evidence.stockMint === undefined ? {} : { stockMint: evidence.stockMint }),
        ...(evidence.stableMint === undefined ? {} : { stableMint: evidence.stableMint }),
        ...(evidence.stockTokenProgram === undefined ? {} : { stockTokenProgram: evidence.stockTokenProgram }),
        ...(evidence.stableTokenProgram === undefined ? {} : { stableTokenProgram: evidence.stableTokenProgram }),
        ...(evidence.sellerStockDeltaAtomic === undefined ? {} : { sellerStockDeltaAtomic: evidence.sellerStockDeltaAtomic }),
        ...(evidence.makerStockDeltaAtomic === undefined ? {} : { makerStockDeltaAtomic: evidence.makerStockDeltaAtomic }),
        ...(evidence.makerStableDeltaAtomic === undefined ? {} : { makerStableDeltaAtomic: evidence.makerStableDeltaAtomic }),
        ...(evidence.sellerStableDeltaAtomic === undefined ? {} : { sellerStableDeltaAtomic: evidence.sellerStableDeltaAtomic }),
        ...(evidence.feeStableDeltaAtomic === undefined ? {} : { feeStableDeltaAtomic: evidence.feeStableDeltaAtomic }),
        ...(evidence.fillReceipt === undefined ? {} : { fillReceipt: evidence.fillReceipt }),
      };
      this.trades.unshift(receipt);
      this.clearTransaction(stored);
      stored.authorizedSignedTransactionBase64 = undefined;
      attempt = {
        ...attempt,
        state: evidence.commitment === 'finalized' ? 'finalized' : 'confirmed',
        signature: evidence.signature,
        tradeId: receipt.tradeId,
        submittedAtMs: evidence.submittedAtMs,
        confirmedAtMs: evidence.confirmedAtMs,
        ...(evidence.finalizedAtMs === undefined ? {} : { finalizedAtMs: evidence.finalizedAtMs }),
      };
      stored.executionAttempts.set(input.idempotencyKey, { attempt, receipt });
      if (evidence.commitment === 'finalized') {
        stored.session = { ...stored.session, state: 'finalized' };
        this.emit(stored);
      }
      return { attempt, receipt };
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : 'transaction submission failed';
      const uncertain = error instanceof SubmissionUncertainError;
      attempt = { ...attempt, state: uncertain ? 'reconciling' : 'failed', ...(uncertain ? { signature: error.signature } : {}), failureMessage };
      stored.executionAttempts.set(input.idempotencyKey, { attempt });
      stored.session = { ...stored.session, state: uncertain ? 'reconciling' : 'failed', failureMessage };
      this.clearTransaction(stored);
      stored.authorizedSignedTransactionBase64 = undefined;
      this.emit(stored);
      if (uncertain) return { attempt };
      throw error;
    }
  }

  listTrades(wallet: string): readonly TradeReceipt[] {
    return this.trades.filter((trade) => trade.wallet === wallet);
  }

  listMakerTrades(sourceId: string): readonly TradeReceipt[] {
    return this.trades.filter((trade) => trade.sourceId === sourceId);
  }

  disableSource(sourceId: string, by: 'maker' | 'operator' = 'operator'): void {
    if (!this.sources.some((source) => source.id === sourceId)) throw new Error('source is not configured');
    this.disabledSourceIds.add(sourceId);
    if (by === 'operator') this.operatorDisabledSourceIds.add(sourceId);
  }

  stopNewQuoteSprints(): void { this.newQuoteSprintsEnabled = false; }
  quoteSprintsEnabled(): boolean { return this.newQuoteSprintsEnabled; }

  operatorSourceStatus(): readonly {
    readonly sourceId: string;
    readonly sourceKind: string;
    readonly enabled: boolean;
    readonly governanceEnabled: boolean;
    readonly operatorDisabled: boolean;
  }[] {
    const configured = this.sources.map((source) => ({
      sourceId: source.id,
      sourceKind: source.kind,
      enabled: this.isSourceActive(source.id),
      governanceEnabled: source.kind === 'private-maker' ? this.governedMakerSourceIds.has(source.id) : true,
      operatorDisabled: this.operatorDisabledSourceIds.has(source.id),
    }));
    const known = new Set(configured.map((source) => source.sourceId));
    return [...configured, ...[...this.operatorDisabledSourceIds].filter((sourceId) => !known.has(sourceId)).map((sourceId) => ({
      sourceId,
      sourceKind: 'private-maker',
      enabled: false,
      governanceEnabled: false,
      operatorDisabled: true,
    }))];
  }

  referencePolicyStatus(nowMs = this.clock()): ReferencePolicySnapshot {
    if (this.referencePolicyProvider) return this.referencePolicyProvider.snapshot(nowMs);
    // No production vendor adapters are wired in this release. An environment
    // flag alone cannot turn the local fixture into licensed market evidence.
    if (process.env.NODE_ENV === 'production') {
      return { status: 'unavailable', checkedAtMs: nowMs, reason: 'production reference policy providers are not configured' };
    }
    return localReferencePolicySnapshot(nowMs);
  }

  async refreshReferencePolicy(nowMs = this.clock()): Promise<void> {
    await this.referencePolicyProvider?.refresh(nowMs);
  }

  private requireSession(id: string): StoredSession {
    const stored = this.sessions.get(id);
    if (!stored) throw notFoundError();
    return stored;
  }

  private isSourceActive(sourceId: string): boolean {
    if (this.disabledSourceIds.has(sourceId)) return false;
    const source = this.sources.find((entry) => entry.id === sourceId);
    return source?.kind !== 'private-maker' || this.governedMakerSourceIds.has(sourceId);
  }

  private assertSourceActive(sourceId: string, action: 'authorization' | 'execution'): void {
    if (this.disabledSourceIds.has(sourceId)) throw new Error(`source was disabled before ${action}`);
    const source = this.sources.find((entry) => entry.id === sourceId);
    if (!source || (source.kind === 'private-maker' && !this.governedMakerSourceIds.has(sourceId))) {
      throw new Error('Private Maker source is not enabled by observed governance');
    }
  }

  private preflight(asset: AssetRegistryEntry, wallet: string, outputMint: string, requestedAmountAtomic?: string, nowMs = this.clock()): EligibilityResult {
    const reference = this.referencePolicyStatus(nowMs);
    if (reference.status !== 'ready') return { status: 'unknown', code: 'capability_unavailable', message: `reference policy ${reference.status}: ${reference.reason ?? 'observations unavailable'}`, asset, checkedAtMs: nowMs };
    return adapterForIssuer(asset.issuer).preflight(asset, this.assets.mintSnapshot(asset), {
      wallet,
      walletBalanceAtomic: this.assets.balance(wallet, asset),
      requestedAmountAtomic,
      outputMint,
      nowMs,
    });
  }

  private assertReferencePolicyReady(stored: StoredSession, nowMs: number, action: 'review' | 'authorization' | 'execution'): void {
    const reference = this.referencePolicyStatus(nowMs);
    if (reference.status === 'ready') return;
    const message = `reference policy ${reference.status} before ${action}: ${reference.reason ?? 'observations unavailable'}`;
    const asset = this.assets.list().find((entry) => entry.mint === stored.session.request.inputMint);
    stored.session = {
      ...stored.session,
      state: 'failed',
      eligibility: { status: 'unknown', code: 'capability_unavailable', message, ...(asset ? { asset } : {}), checkedAtMs: nowMs },
      failureMessage: message,
    };
    this.clearTransaction(stored);
    stored.authorizedSignedTransactionBase64 = undefined;
    this.emit(stored);
    throw new Error(message);
  }

  private checkRequest(request: QuoteSessionRequest, nowMs: number): EligibilityResult {
    const asset = this.assets.list().find((entry) => entry.mint === request.inputMint);
    if (!asset) return { status: 'unknown', code: 'policy_failure', message: 'asset is not present in the signed registry', checkedAtMs: nowMs };
    if (!this.newQuoteSprintsEnabled) return { status: 'unknown', code: 'capability_unavailable', message: 'operator has stopped new Quote Sprints', asset, checkedAtMs: nowMs };
    try {
      assertAtomicString(request.inputAmountAtomic, 'input amount');
    } catch {
      return { status: 'unknown', code: 'malformed_quote', message: 'input amount could not be validated', asset, checkedAtMs: nowMs };
    }
    return this.preflight(asset, request.wallet, request.outputMint, request.inputAmountAtomic, nowMs);
  }

  private startCollect(stored: StoredSession, nowMs: number): void {
    if (!stored.collectionPromise) {
      stored.collectionPromise = this.collect(stored.session.id, nowMs).catch((error: unknown) => {
        // A provider failure is still a terminal collection outcome. This
        // prevents an SSE subscriber from waiting forever on a rejected task.
        if (stored.session.state !== 'collecting') return;
        stored.collectionComplete = true;
        stored.candidates = [];
        stored.verifiedSourceBalances = {};
        stored.session = {
          ...stored.session,
          state: 'failed',
          failureMessage: error instanceof Error ? error.message : 'quote collection failed',
        };
        this.clearTransaction(stored);
        this.emit(stored);
      });
    }
  }

  private async collect(id: string, nowMs = this.clock()): Promise<void> {
    const stored = this.sessions.get(id);
    if (!stored || stored.session.state !== 'collecting') return;
    await this.refreshReferencePolicy(stored.liveClock ? this.clock() : nowMs);
    await this.assets.refresh?.(stored.session.request.wallet, stored.session.request.inputMint, stored.session.request.outputMint);
    const asset = this.assets.list().find((entry) => entry.mint === stored.session.request.inputMint);
    if (!asset) {
      stored.collectionComplete = true;
      if (this.listeners.has(stored.session.id)) this.startFinalize(stored, stored.liveClock ? this.clock() : nowMs);
      return;
    }
    const referencePolicy = this.referencePolicyStatus(stored.liveClock ? this.clock() : nowMs);
    if (referencePolicy.status !== 'ready' || !referencePolicy.primary) {
      stored.sourceErrors.push({ sourceClass: 'private-maker', receivedAtMs: nowMs, rejectionCode: 'capability_unavailable', status: 'rejected' });
      stored.collectionComplete = true;
      if (this.listeners.has(stored.session.id)) this.startFinalize(stored, stored.liveClock ? this.clock() : nowMs);
      return;
    }
    // Licensed primary observations drive quotes; registry prices remain signed metadata.
    const quoteAsset: AssetRegistryEntry = {
      ...asset,
      referencePriceAtomic: referencePolicy.primary.priceAtomic,
      referenceTimestampMs: referencePolicy.primary.observedAtMs,
    };
    const sprintDeadline = this.monotonicClock() + QUOTE_SPRINT_MS;
    const settled = await Promise.all(this.sources.filter((source) => this.isSourceActive(source.id)).map(async (source) => {
      try {
        const quoteNowMs = stored.liveClock ? this.clock() : nowMs;
        const sourceCandidate = await withDeadline(source.quote(stored.session.request, quoteAsset, quoteNowMs), sprintDeadline, this.monotonicClock, 'quote sprint timed out');
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
          verifiedSourceBalance = await withDeadline(this.sourceBalances.verify(source, simulatedCandidate, quoteAsset, balanceNowMs), sprintDeadline, this.monotonicClock, 'source balance verification timed out');
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
    // Collection completion is itself an event boundary. Start finalization
    // here so an already-connected SSE client cannot miss the terminal state.
    if (this.listeners.has(stored.session.id)) this.startFinalize(stored, stored.liveClock ? this.clock() : nowMs);
  }

  private startFinalize(stored: StoredSession, nowMs: number): void {
    if (!stored.finalizationPromise) {
      stored.finalizationPromise = this.finalizeCollection(stored, nowMs).catch((error: unknown) => {
        // Ranking and transaction hashing are trust boundaries. If either
        // fails, connected SSE clients still receive one terminal state.
        if (stored.session.state !== 'collecting') return;
        stored.session = {
          ...stored.session,
          state: 'failed',
          failureMessage: error instanceof Error ? error.message : 'quote finalization failed',
        };
        this.clearTransaction(stored);
        this.emit(stored);
      });
    }
  }

  private async finalizeCollection(stored: StoredSession, nowMs: number): Promise<void> {
    if (!stored.collectionComplete || stored.session.state !== 'collecting') return;
    await this.refreshReferencePolicy(stored.liveClock ? this.clock() : nowMs);
    const asset = this.assets.list().find((entry) => entry.mint === stored.session.request.inputMint);
    if (!asset) {
      stored.candidates = [];
      stored.verifiedSourceBalances = {};
      stored.session = { ...stored.session, state: 'no_quote', audit: sanitizeAudit(stored.sourceErrors) };
      this.emit(stored);
      return;
    }
    const referencePolicy = this.referencePolicyStatus(nowMs);
    if (referencePolicy.status !== 'ready' || !referencePolicy.primary) {
      stored.candidates = [];
      stored.verifiedSourceBalances = {};
      stored.sourceErrors.push({ sourceClass: 'private-maker', receivedAtMs: nowMs, rejectionCode: 'capability_unavailable', status: 'rejected' });
      stored.session = { ...stored.session, state: 'no_quote', audit: sanitizeAudit(stored.sourceErrors) };
      this.emit(stored);
      return;
    }
    const ranked = rankExecutableCandidates({
      candidates: stored.candidates.filter((candidate) => this.isSourceActive(candidate.sourceId)),
      nowMs,
      inputMint: stored.session.request.inputMint,
      outputMint: stored.session.request.outputMint,
      inputAmountAtomic: stored.session.request.inputAmountAtomic,
      issuer: asset.issuer,
      inputDecimals: asset.decimals,
      outputDecimals: 6,
      referencePriceAtomic: referencePolicy.primary.priceAtomic,
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
    stored.session = { ...stored.session, state: winner ? 'winner_ready' : 'no_quote', winner, audit: sanitizeAudit([...stored.sourceErrors, ...ranked.audit]) };
    this.emit(stored);
    if (winner && stored.liveClock) this.scheduleExpiry(stored, winner.expiresAtMs);
  }

  private expireIfNeeded(stored: StoredSession, nowMs = this.clock()): void {
    const winner = stored.session.winner;
    if (!winner || winner.expiresAtMs - nowMs > 2_000) return;

    // The executable bytes are disposable as soon as the quote enters its
    // expiry window, including while a sender is in flight. The sender owns
    // its request buffer; the desk must not retain another executable copy.
    const hadTransaction = Boolean(winner.transactionBase64) || Boolean(stored.authorizedSignedTransactionBase64);
    this.clearTransaction(stored);
    stored.authorizedSignedTransactionBase64 = undefined;
    if (['winner_ready', 'authorized', 'signing'].includes(stored.session.state)) {
      stored.session = { ...stored.session, state: 'expired', failureMessage: 'quote expired; request a fresh executable price' };
      this.emit(stored);
    } else if (hadTransaction) {
      // Keep an in-flight submission observable, but publish the payload
      // removal so connected clients can stop treating it as executable.
      this.emit(stored);
    }
  }

  private clearTransaction(stored: StoredSession): void {
    const timer = this.expiryTimers.get(stored.session.id);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(stored.session.id);
    }
    if (!stored.session.winner?.transactionBase64) return;
    stored.session = { ...stored.session, winner: { ...stored.session.winner, transactionBase64: undefined } };
  }

  private scheduleExpiry(stored: StoredSession, expiresAtMs: number): void {
    const previous = this.expiryTimers.get(stored.session.id);
    if (previous) clearTimeout(previous);
    const delayMs = Math.max(0, expiresAtMs - this.clock() - 2_000);
    const timer = setTimeout(() => {
      this.expiryTimers.delete(stored.session.id);
      this.expireIfNeeded(stored, this.clock());
    }, delayMs);
    // Timers are safety cleanup, not process-liveness handles.
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') (timer as unknown as { unref: () => void }).unref();
    this.expiryTimers.set(stored.session.id, timer);
  }

  private emit(stored: StoredSession): void {
    const listeners = this.listeners.get(stored.session.id);
    if (!listeners) return;
    const snapshot = this.publicSession(stored);
    for (const listener of listeners) listener(snapshot);
  }

  private publicSession(stored: StoredSession): PublicQuoteSession {
    const nowMs = stored.liveClock ? this.clock() : stored.session.createdAtMs;
    return publicSession(stored, this.referencePolicyStatus(nowMs));
  }
}
