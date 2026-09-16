import { floorFee, parseAtomic, quoteLifetimeMs, withComputedPrivateFee } from '@katon/solana-core';
import type { AssetRegistryEntry, QuoteCandidate, QuoteSessionRequest, SimulationResult, VerifiedSourceBalance } from '@katon/solana-core';

export interface QuoteSource {
  readonly id: string;
  readonly kind: QuoteCandidate['sourceKind'];
  readonly reliabilityBps: number;
  quote(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): Promise<QuoteCandidate>;
}

export interface JupiterExecutor {
  execute(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<{ readonly signature: string }>;
}

export interface PrivateSender {
  send(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<{ readonly signature: string }>;
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
    if (candidate.sourceId !== source.id || candidate.sourceKind !== source.kind) throw new Error('source identity does not match quote');
    if (!asset.supportedOutputs.includes(candidate.outputMint)) throw new Error('source output is not registry-approved');
    const balanceAtomic = this.balances.get(`${source.id}:${candidate.outputMint}`);
    if (balanceAtomic === undefined) throw new Error('source balance is unavailable');
    return { sourceId: source.id, outputMint: candidate.outputMint, balanceAtomic, checkedAtMs: nowMs };
  }
}

function encodeEnvelope(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function simulation(nowMs: number): SimulationResult {
  return { ok: true, unitsConsumed: 145_000, simulatedAtMs: nowMs };
}

function baseGross(request: QuoteSessionRequest, asset: AssetRegistryEntry, premiumBps: number): bigint {
  const input = parseAtomic(request.inputAmountAtomic, 'input amount');
  const reference = parseAtomic(asset.referencePriceAtomic ?? '100000000', 'reference price');
  const gross = (input * reference * BigInt(10_000 + premiumBps)) / (10_000n * 10n ** BigInt(asset.referencePriceDecimals ?? asset.decimals));
  return gross > 0n ? gross : 1n;
}

function makeJupiterCandidate(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): QuoteCandidate {
  const gross = baseGross(request, asset, 0);
  const venueFee = (gross * 3n) / 10_000n;
  const net = gross - venueFee;
  const transactionBase64 = encodeEnvelope({ route: 'jupiter-meta-aggregator', quoteId: `jup-${nowMs}`, input: request.inputAmountAtomic, output: net.toString() });
  return {
    quoteId: `jup-${nowMs}`,
    sourceId: 'jupiter-meta-aggregator',
    sourceKind: 'jupiter',
    router: 'jupiter/order',
    wallet: request.wallet,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    grossOutputAtomic: gross.toString(),
    katonFeeAtomic: '0',
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
    transactionBase64,
    simulation: simulation(nowMs),
  };
}

function makeMakerCandidate(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): QuoteCandidate {
  const gross = baseGross(request, asset, 8);
  const venueFee = 0n;
  const provisional = {
    quoteId: `maker-${nowMs}`,
    sourceId: 'maker-sandbox-01',
    sourceKind: 'private-maker' as const,
    router: 'katon/private-rfq',
    wallet: request.wallet,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    grossOutputAtomic: gross.toString(),
    venueFeeAtomic: venueFee.toString(),
    referencePriceAtomic: asset.referencePriceAtomic,
    referencePriceDecimals: asset.referencePriceDecimals,
    deviationBps: 8,
    priceImpactBps: 1,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + quoteLifetimeMs('private-maker'),
    reliabilityBps: 9_700,
    transactionVersion: 'v0' as const,
    transactionBase64: encodeEnvelope({ route: 'katon-private-rfq', quoteId: `maker-${nowMs}`, input: request.inputAmountAtomic, output: gross.toString() }),
    simulation: simulation(nowMs),
  };
  return withComputedPrivateFee(provisional);
}

export class MockJupiterSource implements QuoteSource {
  readonly id = 'jupiter-meta-aggregator';
  readonly kind = 'jupiter' as const;
  readonly reliabilityBps = 9_900;

  async quote(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): Promise<QuoteCandidate> {
    return makeJupiterCandidate(request, asset, nowMs);
  }
}

export class MockPrivateMakerSource implements QuoteSource {
  readonly id = 'maker-sandbox-01';
  readonly kind = 'private-maker' as const;
  readonly reliabilityBps = 9_700;

  async quote(request: QuoteSessionRequest, asset: AssetRegistryEntry, nowMs: number): Promise<QuoteCandidate> {
    return makeMakerCandidate(request, asset, nowMs);
  }
}

export class MockSender implements JupiterExecutor, PrivateSender {
  async execute(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<{ readonly signature: string }> {
    if (!signedTransactionBase64 || !candidate.transactionBase64) throw new Error('missing signed transaction');
    return { signature: `mock-${candidate.sourceKind}-${candidate.quoteId}` };
  }

  async send(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<{ readonly signature: string }> {
    return this.execute(candidate, signedTransactionBase64);
  }
}

export function feeForQuote(grossOutputAtomic: string, feeBps = 10): string {
  return floorFee(grossOutputAtomic, feeBps).toString();
}
