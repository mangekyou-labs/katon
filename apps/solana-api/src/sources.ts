import { createHash, randomUUID } from 'node:crypto';
import {
  blockhashBytesFromBase58,
  buildLocalnetLandingV0Transaction,
  buildQuoteBoundV0Transaction,
  decodeBase58,
  encodeBase58,
  floorFee,
  isLocalnetMode,
  localSellerPublicKey,
  parseAtomic,
  QUOTE_SPRINT_MS,
  partiallySignV0Transaction,
  publicKeyFromSeed,
  quoteLifetimeMs,
  resolveMakerSecretKey,
  withComputedPrivateFee,
} from '@katon/solana-core';
import type { AssetRegistryEntry, ExecutionEvidence, QuoteCandidate, QuoteSessionRequest, SimulationResult, VerifiedSourceBalance } from '@katon/solana-core';
import type { MakerCapability } from './roles';

export type { ExecutionEvidence } from '@katon/solana-core';

export interface QuoteSource {
  readonly id: string;
  readonly kind: QuoteCandidate['sourceKind'];
  readonly settlementRoute: QuoteCandidate['settlementRoute'];
  readonly reliabilityBps: number;
  quote(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): Promise<QuoteCandidate>;
}

export interface StreamedMakerQuote {
  readonly requestId: string;
  readonly quoteId: string;
  readonly wallet: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
  readonly outputAmountAtomic: string;
  readonly feeBps: number;
  readonly expiresAtMs: number;
  readonly transactionBase64: string;
}

/** Authenticated maker stream adapter used by real Quote Sprint collection. */
export class StreamedMakerSource implements QuoteSource {
  readonly kind = 'private-maker' as const;
  readonly settlementRoute = 'generic-spl' as const;
  readonly reliabilityBps = 9_700;
  private available = false;
  private advertisedAvailable = false;
  private governanceEnabled = false;
  private capabilities: readonly MakerCapability[] = [];
  private pending?: { requestId: string; request: QuoteSessionRequest; resolve: (quote: StreamedMakerQuote) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

  constructor(
    readonly id: string,
    readonly publicKey: string,
    private readonly requestQuote: (request: QuoteSessionRequest, expiresAtMs: number, requestId: string) => void,
  ) {}

  setGovernanceEnabled(enabled: boolean): void {
    if (this.governanceEnabled === enabled) return;
    this.governanceEnabled = enabled;
    // Require a fresh availability ad after either side of a governance
    // transition so a stale pre-approval ad cannot turn into live liquidity.
    this.advertisedAvailable = false;
    this.available = false;
    this.rejectPending('maker governance enablement changed during Quote Sprint collection');
  }

  setAvailable(available: boolean): void {
    this.advertisedAvailable = available;
    this.available = this.governanceEnabled && this.advertisedAvailable;
    if (!this.available) this.rejectPending('maker became unavailable during Quote Sprint collection');
  }

  setCapabilities(capabilities: readonly MakerCapability[]): void {
    this.capabilities = capabilities.map((capability) => ({ ...capability }));
    const request = this.pending?.request;
    if (request && !this.supports(request)) {
      const pending = this.pending!;
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.reject(new Error('maker withdrew the advertised capability during Quote Sprint collection'));
    }
  }

  private supports(request: QuoteSessionRequest): boolean {
    const input = parseAtomic(request.inputAmountAtomic, 'maker input amount');
    return this.capabilities.some((capability) => capability.inputMint === request.inputMint
      && capability.outputMint === request.outputMint
      && input >= BigInt(capability.minInputAtomic) && input <= BigInt(capability.maxInputAtomic));
  }

  private rejectPending(message: string): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(new Error(message));
    this.pending = undefined;
  }

  async quote(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): Promise<QuoteCandidate> {
    if (asset.issuer !== 'xstocks' || !asset.enabled || !asset.supportedOutputs.includes(request.outputMint) || !this.available
      || !this.supports(request)) {
      throw new Error('maker is unavailable for this asset, output, or size');
    }
    if (this.pending) throw new Error('maker already has an active Quote Sprint request');
    const requestId = randomUUID();
    const expiresAtMs = nowMs + Math.min(1_000, QUOTE_SPRINT_MS - 100);
    const quote = await new Promise<StreamedMakerQuote>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error('maker did not respond before Quote Sprint collection ended'));
      }, expiresAtMs - nowMs);
      this.pending = { requestId, request, resolve, reject, timer };
      this.requestQuote(request, expiresAtMs, requestId);
    });
    const gross = parseAtomic(quote.outputAmountAtomic, 'maker output amount');
    const venueFee = (gross * BigInt(quote.feeBps)) / 10_000n;
    return withComputedPrivateFee({
      quoteId: quote.quoteId,
      sourceId: this.id,
      sourceKind: 'private-maker',
      settlementRoute: this.settlementRoute,
      router: 'katon/private-rfq',
      wallet: quote.wallet,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inputAmountAtomic: quote.inputAmountAtomic,
      grossOutputAtomic: gross.toString(),
      venueFeeAtomic: venueFee.toString(),
      referencePriceAtomic: asset.referencePriceAtomic,
      referencePriceDecimals: asset.referencePriceDecimals,
      deviationBps: 0,
      priceImpactBps: 0,
      createdAtMs: nowMs,
      expiresAtMs: quote.expiresAtMs,
      reliabilityBps: this.reliabilityBps,
      transactionVersion: 'v0',
      transactionBase64: quote.transactionBase64,
      simulation: simulation(nowMs),
      // RFQ settle_private_quote pays the seller minimum after this fee. The
      // on-chain settlement fee is already represented as venueFeeAtomic;
      // adding a second off-chain Katon fee would rank a different amount.
      feeBps: 0,
    });
  }

  submitQuote(quote: StreamedMakerQuote): void {
    const pending = this.pending;
    if (!pending) throw new Error('maker has no active Quote Sprint request');
    if (quote.requestId !== pending.requestId || quote.wallet !== pending.request.wallet || quote.inputMint !== pending.request.inputMint
      || quote.outputMint !== pending.request.outputMint || quote.inputAmountAtomic !== pending.request.inputAmountAtomic) {
      throw new Error('maker quote terms do not match the active Quote Sprint');
    }
    if (Date.now() >= quote.expiresAtMs || quote.expiresAtMs > Date.now() + 30_000) throw new Error('maker quote expiry is invalid');
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.resolve(quote);
  }
}

export interface JupiterExecutor {
  execute(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence>;
}

export interface PrivateSender {
  send(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence>;
}

/** Independent liquidity evidence supplied by the source adapter, not by a quote payload. */
export interface SourceBalanceProvider {
  verify(source: QuoteSource, candidate: QuoteCandidate, asset: AssetRegistryEntry, nowMs: number): Promise<VerifiedSourceBalance>;
}

export class RejectingSourceBalanceProvider implements SourceBalanceProvider {
  async verify(): Promise<VerifiedSourceBalance> {
    throw new Error('source balance verification is not configured');
  }
}

export class MemorySourceBalanceProvider implements SourceBalanceProvider {
  private readonly balances = new Map<string, string>();

  setBalance(sourceId: string, outputMint: string, balanceAtomic: string): void {
    parseAtomic(balanceAtomic, 'source balance');
    this.balances.set(`${sourceId}:${outputMint}`, balanceAtomic);
  }

  async verify(source: QuoteSource, candidate: QuoteCandidate, asset: AssetRegistryEntry, nowMs: number): Promise<VerifiedSourceBalance> {
    if (candidate.sourceId !== source.id || candidate.sourceKind !== source.kind || candidate.settlementRoute !== source.settlementRoute) throw new Error('source identity does not match quote');
    if (!asset.supportedOutputs.includes(candidate.outputMint)) throw new Error('source output is not registry-approved');
    const balanceAtomic = this.balances.get(`${source.id}:${candidate.outputMint}`);
    if (balanceAtomic === undefined) throw new Error('source balance is unavailable');
    return { sourceId: source.id, outputMint: candidate.outputMint, balanceAtomic, checkedAtMs: nowMs };
  }
}

/** Local fixture wallet derived from LOCAL_SELLER_SEED (all 0x07). */
export const DEMO_WALLET = encodeBase58(localSellerPublicKey());

function simulation(nowMs: number): SimulationResult {
  return { ok: true, unitsConsumed: 145_000, simulatedAtMs: nowMs };
}

function baseGross(request: QuoteSessionRequest, asset: AssetRegistryEntry, premiumBps: number): bigint {
  const input = parseAtomic(request.inputAmountAtomic, 'input amount');
  const reference = parseAtomic(asset.referencePriceAtomic ?? '100000000', 'reference price');
  const gross = (input * reference * BigInt(10_000 + premiumBps)) / (10_000n * 10n ** BigInt(asset.referencePriceDecimals ?? asset.decimals));
  return gross > 0n ? gross : 1n;
}

function sellerPubkeyFromRequest(request: QuoteSessionRequest): Uint8Array {
  const decoded = decodeBase58(request.wallet);
  if (!decoded || decoded.length !== 32) throw new Error('wallet is not a valid base58 ed25519 public key');
  return decoded;
}

async function fetchRecentBlockhashBytes(rpcUrl = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'): Promise<Uint8Array> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
  });
  const body = await response.json() as {
    result?: { value?: { blockhash?: string } };
    error?: { message?: string };
  };
  if (!response.ok || body.error || !body.result?.value?.blockhash) {
    throw new Error(body.error?.message ?? 'getLatestBlockhash failed');
  }
  return blockhashBytesFromBase58(body.result.value.blockhash);
}

async function makeJupiterCandidate(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): Promise<QuoteCandidate> {
  const gross = baseGross(request, asset, 0);
  const venueFee = (gross * 3n) / 10_000n;
  const net = gross - venueFee;
  const quoteId = `jup-${nowMs}`;
  const sellerPubkey = sellerPubkeyFromRequest(request);
  const built = isLocalnetMode()
    ? buildLocalnetLandingV0Transaction({
      sellerPubkey,
      recentBlockhash: await fetchRecentBlockhashBytes(),
    })
    : buildQuoteBoundV0Transaction({
      sellerPubkey,
      quoteId,
      inputAmountAtomic: request.inputAmountAtomic,
      outputAtomic: net.toString(),
    });
  return {
    quoteId,
    sourceId: 'jupiter-meta-aggregator',
    sourceKind: 'jupiter',
    settlementRoute: 'generic-spl',
    router: 'jupiter/order',
    wallet: request.wallet,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    grossOutputAtomic: gross.toString(),
    katonFeeAtomic: '0',
    katonFeeBps: 0,
    venueFeeAtomic: venueFee.toString(),
    netOutputAtomic: net.toString(),
    referencePriceAtomic: asset.referencePriceAtomic,
    referencePriceDecimals: asset.referencePriceDecimals,
    deviationBps: 0,
    priceImpactBps: 3,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + quoteLifetimeMs('jupiter'),
    reliabilityBps: 9_900,
    transactionVersion: 'v0',
    transactionBase64: built.transactionBase64,
    simulation: simulation(nowMs),
  };
}

interface MakerCandidateOptions {
  readonly sourceId: string;
  readonly router: string;
  readonly settlementRoute: QuoteCandidate['settlementRoute'];
  readonly premiumBps: number;
  readonly makerSecretKey: Uint8Array;
}

async function makeMakerCandidate(
  request: QuoteSessionRequest,
  asset: AssetRegistryEntry,
  nowMs: number,
  options: MakerCandidateOptions,
): Promise<QuoteCandidate> {
  const gross = baseGross(request, asset, options.premiumBps);
  const venueFee = 0n;
  const quoteId = `${options.sourceId}-${nowMs}`;
  const makerPubkey = publicKeyFromSeed(options.makerSecretKey);
  const sellerPubkey = sellerPubkeyFromRequest(request);
  const built = isLocalnetMode()
    ? buildLocalnetLandingV0Transaction({
      sellerPubkey,
      makerPubkey,
      recentBlockhash: await fetchRecentBlockhashBytes(),
    })
    : buildQuoteBoundV0Transaction({
      sellerPubkey,
      makerPubkey,
      quoteId,
      inputAmountAtomic: request.inputAmountAtomic,
      outputAtomic: gross.toString(),
    });
  const partial = partiallySignV0Transaction({
    message: built.message,
    signatures: built.signatures,
    signerIndex: 1,
    privateKey: options.makerSecretKey,
  });
  const provisional = {
    quoteId,
    sourceId: options.sourceId,
    sourceKind: 'private-maker' as const,
    settlementRoute: options.settlementRoute,
    router: options.router,
    wallet: request.wallet,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    grossOutputAtomic: gross.toString(),
    venueFeeAtomic: venueFee.toString(),
    referencePriceAtomic: asset.referencePriceAtomic,
    referencePriceDecimals: asset.referencePriceDecimals,
    deviationBps: options.premiumBps,
    priceImpactBps: 1,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + quoteLifetimeMs('private-maker'),
    reliabilityBps: 9_700,
    transactionVersion: 'v0' as const,
    transactionBase64: Buffer.from(partial.transaction).toString('base64'),
    simulation: simulation(nowMs),
  };
  return withComputedPrivateFee(provisional);
}

/** Spec-faithful Jupiter stub: real v0 bytes, zero Katon fee, no api.jup.ag calls. */
export class JupiterStubSource implements QuoteSource {
  readonly id = 'jupiter-meta-aggregator';
  readonly kind = 'jupiter' as const;
  readonly settlementRoute = 'generic-spl' as const;
  readonly reliabilityBps = 9_900;

  async quote(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): Promise<QuoteCandidate> {
    if (asset.issuer !== 'xstocks') throw new Error('Jupiter stub route does not support Ondo managed assets');
    return await makeJupiterCandidate(request, asset, nowMs);
  }
}

/** @deprecated Use JupiterStubSource. */
export class MockJupiterSource extends JupiterStubSource {}

/** Headless Private Maker that partially signs frozen v0 bytes before review. */
export class HeadlessPrivateMakerSource implements QuoteSource {
  readonly id = 'maker-sandbox-01';
  readonly kind = 'private-maker' as const;
  readonly settlementRoute = 'generic-spl' as const;
  readonly reliabilityBps = 9_700;
  private readonly makerSecretKey: Uint8Array;

  constructor(makerSecretKey: Uint8Array = resolveMakerSecretKey()) {
    this.makerSecretKey = makerSecretKey;
  }

  get makerPublicKey(): Uint8Array {
    return publicKeyFromSeed(this.makerSecretKey);
  }

  async quote(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): Promise<QuoteCandidate> {
    if (asset.issuer !== 'xstocks') throw new Error('private maker route does not support Ondo managed assets');
    return await makeMakerCandidate(request, asset, nowMs, {
      sourceId: this.id,
      router: 'katon/private-rfq',
      settlementRoute: this.settlementRoute,
      premiumBps: 8,
      makerSecretKey: this.makerSecretKey,
    });
  }
}

/** @deprecated Use HeadlessPrivateMakerSource. */
export class MockPrivateMakerSource extends HeadlessPrivateMakerSource {}

/**
 * Submits signed bytes to a trusted Solana JSON-RPC endpoint.
 * Default target is local Surfpool / solana-test-validator at 127.0.0.1:8899.
 */
export class TrustedRpcSender implements JupiterExecutor, PrivateSender {
  constructor(
    private readonly rpcUrl = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899',
    private readonly options: { readonly simulateFirst?: boolean; readonly fetcher?: typeof fetch } = {},
  ) {}

  async execute(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence> {
    return this.submit(candidate, signedTransactionBase64);
  }

  async send(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence> {
    return this.submit(candidate, signedTransactionBase64);
  }

  private async submit(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence> {
    if (!signedTransactionBase64 || !candidate.transactionBase64) throw new Error('missing signed transaction');
    const fetcher = this.options.fetcher ?? fetch;
    if (this.options.simulateFirst !== false) {
      const simulation = await this.rpc(fetcher, 'simulateTransaction', [signedTransactionBase64, { encoding: 'base64', sigVerify: true }]);
      const value = (simulation as { value?: { err?: unknown } } | undefined)?.value;
      if (value?.err) throw new Error(`transaction simulation failed: ${JSON.stringify(value.err)}`);
    }
    const submittedAtMs = Date.now();
    const signature = await this.rpc(fetcher, 'sendTransaction', [signedTransactionBase64, { encoding: 'base64', skipPreflight: false }]);
    if (typeof signature !== 'string' || signature.length === 0) throw new Error('RPC returned no transaction signature');
    if (signature.startsWith('mock-')) throw new Error('RPC returned a mock signature');
    return {
      signature,
      submittedAtMs,
      confirmedAtMs: submittedAtMs,
      finalizedAtMs: submittedAtMs,
      commitment: 'finalized',
    };
  }

  private async rpc(fetcher: typeof fetch, method: string, params: unknown[]): Promise<unknown> {
    const response = await fetcher(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (!response.ok || body.error) throw new Error(body.error?.message ?? `RPC ${method} failed`);
    return body.result;
  }
}

/**
 * Test double that returns a deterministic non-mock signature derived from the
 * signed bytes. Prefer injecting explicit evidence in tests when asserting receipts.
 */
export class RecordingSender implements JupiterExecutor, PrivateSender {
  readonly submissions: Array<{ readonly candidate: QuoteCandidate; readonly signedTransactionBase64: string; readonly signature: string }> = [];

  async execute(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence> {
    return this.record(candidate, signedTransactionBase64);
  }

  async send(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence> {
    return this.record(candidate, signedTransactionBase64);
  }

  private record(candidate: QuoteCandidate, signedTransactionBase64: string): ExecutionEvidence {
    if (!signedTransactionBase64 || !candidate.transactionBase64) throw new Error('missing signed transaction');
    const digest = createHash('sha256').update(signedTransactionBase64).digest();
    const signature = encodeBase58(digest.subarray(0, 32));
    this.submissions.push({ candidate, signedTransactionBase64, signature });
    const submittedAtMs = Date.now();
    return { signature, submittedAtMs, confirmedAtMs: submittedAtMs + 1, finalizedAtMs: submittedAtMs + 2, commitment: 'finalized' };
  }
}

/** Legacy mock sender. Not wired by the production server. */
export class MockSender implements JupiterExecutor, PrivateSender {
  async execute(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence> {
    if (!signedTransactionBase64 || !candidate.transactionBase64) throw new Error('missing signed transaction');
    const submittedAtMs = Date.now();
    return { signature: `mock-${candidate.sourceKind}-${candidate.quoteId}`, submittedAtMs, confirmedAtMs: submittedAtMs + 1, finalizedAtMs: submittedAtMs + 2, commitment: 'finalized' };
  }

  async send(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence> {
    return this.execute(candidate, signedTransactionBase64);
  }
}

export function feeForQuote(grossOutputAtomic: string, feeBps = 10): string {
  return floorFee(grossOutputAtomic, feeBps).toString();
}
