import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  ExternalSwapQuote,
  ExternalSwapSource,
  SwapQuoteRequest,
} from '../../../packages/base-core/src/index';
import { getBaseNetworkConfig, type BaseNetwork } from '../../../packages/base-core/src/network';
import type { BaseSwapQuotePort, SwapQuoteCollection } from './types';

/**
 * Provider-native external swap adapters.
 *
 * These adapters replace the previous generic quote pass-throughs. Each one
 * speaks its provider's real API, then produces the strict normalized packet
 * that the core ranker already re-validates (chain, taker, recipient, tokens,
 * exact sell amount, minimum output, allowance target). Every failure mode —
 * transport, parse, drift, missing liquidity, stale quote, insufficient output,
 * non-allowlisted target — fails closed, and no provider response is ever
 * forwarded to a seller.
 *
 * CoW is deliberately *not* an executable adapter: a CoW quote is an
 * asynchronous signed intent, so it has its own provider, its own DTO, and its
 * own endpoint, and it never appears as executable swap calldata.
 */

export type ExternalProviderId = '0x' | '1inch' | 'COW';
export type ExecutableProviderId = Exclude<ExternalProviderId, 'COW'>;

/** 0x AllowanceHolder is the canonical v2 allowance target on Base. */
export const ZERO_EX_ALLOWANCE_HOLDER: Address = '0x0000000000001fF3684f28c67538d4D072C22734';
/** CoW's Base settlement contract. Orders are intents, not calls to it. */
export const COW_SETTLEMENT_BASE: Address = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
export const COW_DOMAIN_NAME = 'Gnosis Protocol';
export const COW_DOMAIN_VERSION = 'v2';
/** Valid full CoW app-data document used when the demo has no extra metadata. */
export const COW_APP_DATA_JSON = '{"version":"0.9.0","metadata":{}}';
/** CoW EIP-712 orders sign the hash of the full app-data JSON string. */
export const COW_EMPTY_APP_DATA = keccak256(stringToHex(COW_APP_DATA_JSON));

const ZERO_EX_VERSION_HEADER = 'v2';
const DEFAULT_TIMEOUT_MS = 850;
const DEFAULT_MAX_QUOTE_AGE_MS = 30_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export interface ProviderVenueSettings {
  readonly id: ExternalProviderId;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly maxQuoteAgeMs: number;
}

export interface ExternalProviderConfig {
  readonly chainId: number;
  readonly network: BaseNetwork;
  /** Execution targets (`transaction.to`) this server will hand to a wallet. */
  readonly allowedExecutionTargets: readonly Address[];
  /** Allowance spenders this server will hand to a wallet. */
  readonly allowedAllowanceTargets: readonly Address[];
  /** Native ETH price in USDC base units, required to price provider gas. */
  readonly nativeUsdcPerEth: bigint;
  readonly venues: readonly ProviderVenueSettings[];
  /** Controlled QA signer for the CoW order proof. Never submitted to mainnet. */
  readonly cowQaSignerKey?: Hex;
}

export interface ExternalProviderDeps {
  readonly fetcher?: typeof fetch;
  readonly clock?: () => number;
}

const ENV_KEYS: Readonly<Record<ExternalProviderId, { readonly url: string; readonly key: string }>> = {
  '0x': { url: 'KATON_BASE_SWAP_0X_URL', key: 'KATON_BASE_SWAP_0X_API_KEY' },
  '1inch': { url: 'KATON_BASE_SWAP_1INCH_URL', key: 'KATON_BASE_SWAP_1INCH_API_KEY' },
  COW: { url: 'KATON_BASE_SWAP_COW_URL', key: 'KATON_BASE_SWAP_COW_API_KEY' },
};

/**
 * Load the server-only provider configuration. A provider is enabled only when
 * its base URL is configured, so an unconfigured environment keeps the previous
 * quote-only behavior. Once any provider is enabled the target allowlists and
 * the native/USDC price are mandatory: without them an external packet could
 * not be validated or priced honestly, and the process fails closed instead.
 */
export function loadExternalProviderConfig(
  env: Readonly<Record<string, string | undefined>>,
  network: BaseNetwork,
  chainId: number,
): ExternalProviderConfig {
  const networkConfig = getBaseNetworkConfig(network, chainId);
  const timeoutMs = parsePositiveInteger(env.KATON_BASE_EXTERNAL_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 'KATON_BASE_EXTERNAL_TIMEOUT_MS');
  const maxQuoteAgeMs = parsePositiveInteger(env.KATON_BASE_EXTERNAL_MAX_QUOTE_AGE_MS ?? String(DEFAULT_MAX_QUOTE_AGE_MS), 'KATON_BASE_EXTERNAL_MAX_QUOTE_AGE_MS');
  const enabled = (Object.keys(ENV_KEYS) as readonly ExternalProviderId[]).filter((id) => {
    const configured = env[ENV_KEYS[id].url];
    // A configured URL alone cannot expose 1inch calldata before its live
    // AAPLc route passes the external evidence gate.
    if (id === '1inch' && env.KATON_BASE_ENABLE_1INCH_EXECUTION !== 'true') return false;
    return configured !== undefined && configured !== '';
  });
  const allowedExecutionTargets = parseAddressList(env.KATON_BASE_EXTERNAL_EXECUTION_TARGETS);
  const allowedAllowanceTargets = parseAddressList(env.KATON_BASE_EXTERNAL_ALLOWANCE_TARGETS);
  const nativeUsdcPerEth = env.KATON_BASE_NATIVE_USDC_PER_ETH
    ? parseDecimalConfig(env.KATON_BASE_NATIVE_USDC_PER_ETH, 'KATON_BASE_NATIVE_USDC_PER_ETH')
    : 0n;
  const cowQaSignerKey = normalizePrivateKey(env.KATON_BASE_COW_QA_SIGNER_KEY);
  if (enabled.length > 0) {
    if (allowedExecutionTargets.length === 0) throw new Error('EXTERNAL_EXECUTION_TARGETS_REQUIRED');
    if (allowedAllowanceTargets.length === 0) throw new Error('EXTERNAL_ALLOWANCE_TARGETS_REQUIRED');
    if (nativeUsdcPerEth <= 0n) throw new Error('EXTERNAL_NATIVE_USDC_PRICE_REQUIRED');
    // If 0x is enabled, its real allowance target must be explicitly allowlisted
    // rather than trusted implicitly from the provider response.
    if (enabled.includes('0x') && !allowedAllowanceTargets.some((entry) => sameAddress(entry, ZERO_EX_ALLOWANCE_HOLDER))) {
      throw new Error('EXTERNAL_ALLOWANCE_TARGET_REQUIRED:0x');
    }
  }
  const venues = enabled.map((id) => ({
    id,
    baseUrl: normalizeBaseUrl(env[ENV_KEYS[id].url] as string, ENV_KEYS[id].url),
    ...(env[ENV_KEYS[id].key] ? { apiKey: env[ENV_KEYS[id].key] as string } : {}),
    timeoutMs,
    maxQuoteAgeMs,
  }));
  return {
    chainId: networkConfig.chainId,
    network,
    allowedExecutionTargets,
    allowedAllowanceTargets,
    nativeUsdcPerEth,
    venues,
    ...(cowQaSignerKey ? { cowQaSignerKey } : {}),
  };
}

interface ProviderQuoteContext {
  readonly config: ExternalProviderConfig;
  readonly deps: Required<ExternalProviderDeps>;
}

export interface ExternalProviderAdapter {
  readonly id: ExecutableProviderId;
  quote(request: SwapQuoteRequest): Promise<ExternalSwapQuote | undefined>;
}

/** Build every configured *executable* provider adapter (0x, 1inch). */
export function createExternalProviderAdapters(
  config: ExternalProviderConfig,
  deps: ExternalProviderDeps = {},
): readonly ExternalProviderAdapter[] {
  const context = providerContext(config, deps);
  return config.venues
    .filter((venue): venue is ProviderVenueSettings & { id: ExecutableProviderId } => venue.id !== 'COW')
    .map((venue) => (venue.id === '0x' ? new ZeroExSwapAdapter(venue, context) : new OneInchSwapAdapter(venue, context)));
}

function providerContext(config: ExternalProviderConfig, deps: ExternalProviderDeps): ProviderQuoteContext {
  return {
    config,
    deps: {
      fetcher: deps.fetcher ?? globalThis.fetch.bind(globalThis),
      clock: deps.clock ?? (() => Date.now()),
    },
  };
}

abstract class BaseProviderAdapter implements ExternalProviderAdapter {
  constructor(
    readonly id: ExecutableProviderId,
    protected readonly venue: ProviderVenueSettings,
    protected readonly context: ProviderQuoteContext,
  ) {}

  abstract quote(request: SwapQuoteRequest): Promise<ExternalSwapQuote | undefined>;

  /** Provider-specific request shaping; shared transport owns timeout and parse. */
  protected abstract buildRequest(request: SwapQuoteRequest): { readonly url: string; readonly init: RequestInit };

  protected async fetchQuote(request: SwapQuoteRequest): Promise<{ readonly value: unknown; readonly receivedAtMs: number }> {
    const { url, init } = this.buildRequest(request);
    const startedAt = this.context.deps.clock();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.venue.timeoutMs);
    try {
      const response = await this.context.deps.fetcher(url, { ...init, signal: controller.signal });
      // Receive time is anchored to the auction open so wall-clock skew cannot
      // make a late provider response look eligible.
      const receivedAtMs = request.auctionOpenedAtMs + Math.max(0, this.context.deps.clock() - startedAt);
      if ([400, 404, 422].includes(response.status)) return { value: { noLiquidity: true }, receivedAtMs };
      if (!response.ok) throw new Error(`EXTERNAL_PROVIDER_HTTP_${response.status}`);
      const text = await response.text();
      if (!text) throw new Error('EXTERNAL_PROVIDER_RESPONSE_INVALID');
      return { value: JSON.parse(text) as unknown, receivedAtMs };
    } finally {
      clearTimeout(timer);
    }
  }

  protected assertFresh(receivedAtMs: number, request: SwapQuoteRequest): void {
    if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) throw new Error('EXTERNAL_QUOTE_RECEIVED_AT');
    if (receivedAtMs > request.auctionCutoffAtMs) throw new Error('EXTERNAL_QUOTE_LATE');
    if (this.context.deps.clock() - receivedAtMs > this.venue.maxQuoteAgeMs) throw new Error('EXTERNAL_QUOTE_STALE');
  }
}

class ZeroExSwapAdapter extends BaseProviderAdapter {
  constructor(venue: ProviderVenueSettings, context: ProviderQuoteContext) {
    super('0x', venue, context);
  }

  protected buildRequest(request: SwapQuoteRequest): { readonly url: string; readonly init: RequestInit } {
    const params = new URLSearchParams({
      chainId: String(this.context.config.chainId),
      sellToken: request.stockToken,
      buyToken: request.usdcToken,
      sellAmount: request.sellAmount.toString(10),
      taker: request.taker,
      recipient: request.recipient,
    });
    const headers = new Headers({ accept: 'application/json', '0x-version': ZERO_EX_VERSION_HEADER });
    if (this.venue.apiKey) headers.set('0x-api-key', this.venue.apiKey);
    return {
      url: `${this.venue.baseUrl}/swap/allowance-holder/quote?${params.toString()}`,
      init: { method: 'GET', headers },
    };
  }

  async quote(request: SwapQuoteRequest): Promise<ExternalSwapQuote | undefined> {
    const { value, receivedAtMs } = await this.fetchQuote(request);
    const record = object(value);
    if (record.noLiquidity === true || record.liquidityAvailable === false) return undefined;
    const transaction = object(record.transaction);
    this.assertFresh(receivedAtMs, request);
    return normalizeExternalQuote({
      source: '0x',
      config: this.context.config,
      request,
      receivedAtMs,
      responseHash: responseHashOf(value),
      stockAmount: decimal(record.sellAmount, 'sellAmount'),
      usdcAmount: decimal(record.buyAmount, 'buyAmount'),
      minimumBuyAmount: decimal(record.minBuyAmount, 'minBuyAmount'),
      allowanceTarget: address(record.allowanceTarget, 'allowanceTarget'),
      transaction: {
        to: address(transaction.to, 'transaction.to'),
        data: hex(transaction.data, 'transaction.data'),
        value: decimal(transaction.value ?? '0', 'transaction.value'),
      },
      networkFeeWei: optionalDecimal(record.totalNetworkFee) ?? 0n,
    });
  }
}

class OneInchSwapAdapter extends BaseProviderAdapter {
  constructor(venue: ProviderVenueSettings, context: ProviderQuoteContext) {
    super('1inch', venue, context);
  }

  protected buildRequest(request: SwapQuoteRequest): { readonly url: string; readonly init: RequestInit } {
    // 1inch Classic Swap 6.1: `/swap` returns the executable tx for a quote.
    const params = new URLSearchParams({
      src: request.stockToken,
      dst: request.usdcToken,
      amount: request.sellAmount.toString(10),
      from: request.taker,
      receiver: request.recipient,
      slippage: '0',
      disableEstimate: 'true',
      includeGas: 'true',
    });
    const headers = new Headers({ accept: 'application/json' });
    if (this.venue.apiKey) headers.set('authorization', `Bearer ${this.venue.apiKey}`);
    return {
      url: `${this.venue.baseUrl}/swap/v6.1/${this.context.config.chainId}/swap?${params.toString()}`,
      init: { method: 'GET', headers },
    };
  }

  async quote(request: SwapQuoteRequest): Promise<ExternalSwapQuote | undefined> {
    const { value, receivedAtMs } = await this.fetchQuote(request);
    const record = object(value);
    if (record.noLiquidity === true) return undefined;
    const transaction = object(record.tx);
    this.assertFresh(receivedAtMs, request);
    const gas = decimal(transaction.gas, 'tx.gas');
    const gasPrice = decimal(transaction.gasPrice, 'tx.gasPrice');
    const allowanceTarget = record.allowanceTarget === undefined
      ? this.context.config.allowedAllowanceTargets[0]
      : address(record.allowanceTarget, 'allowanceTarget');
    return normalizeExternalQuote({
      source: '1inch',
      config: this.context.config,
      request,
      receivedAtMs,
      responseHash: responseHashOf(value),
      stockAmount: decimal(record.srcAmount, 'srcAmount'),
      usdcAmount: decimal(record.dstAmount, 'dstAmount'),
      minimumBuyAmount: decimal(record.dstAmount, 'dstAmount'),
      allowanceTarget,
      transaction: {
        to: address(transaction.to, 'tx.to'),
        data: hex(transaction.data, 'tx.data'),
        value: decimal(transaction.value ?? '0', 'tx.value'),
      },
      networkFeeWei: gas * gasPrice,
    });
  }
}

interface NormalizeInput {
  readonly source: ExternalSwapSource;
  readonly config: ExternalProviderConfig;
  readonly request: SwapQuoteRequest;
  readonly receivedAtMs: number;
  readonly responseHash: Hex;
  readonly stockAmount: bigint;
  readonly usdcAmount: bigint;
  readonly minimumBuyAmount: bigint;
  readonly allowanceTarget: Address;
  readonly transaction: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  readonly networkFeeWei: bigint;
}

/**
 * Convert one provider response into the strict normalized packet. Every check
 * the core ranker depends on is asserted here too, so a malformed or drifted
 * provider response can never reach a wallet as executable calldata.
 */
function normalizeExternalQuote(input: NormalizeInput): ExternalSwapQuote {
  const { request, config } = input;
  if (input.stockAmount !== request.sellAmount) throw new Error('EXTERNAL_QUOTE_SELL_AMOUNT');
  if (input.usdcAmount <= 0n) throw new Error('EXTERNAL_QUOTE_BUY_AMOUNT');
  if (input.minimumBuyAmount < request.minBuyAmount) throw new Error('EXTERNAL_QUOTE_MIN_OUT');
  if (input.transaction.value !== 0n) throw new Error('EXTERNAL_QUOTE_NATIVE_VALUE');
  if (isZeroAddress(input.transaction.to)) throw new Error('EXTERNAL_QUOTE_TARGET');
  if (isZeroAddress(input.allowanceTarget)) throw new Error('EXTERNAL_QUOTE_ALLOWANCE_TARGET');
  if (input.transaction.data === '0x' || input.transaction.data.length < 10) throw new Error('EXTERNAL_QUOTE_CALLDATA');
  if (request.chainId !== undefined && request.chainId !== config.chainId) throw new Error('EXTERNAL_QUOTE_CHAIN');
  if (!config.allowedAllowanceTargets.some((entry) => sameAddress(entry, input.allowanceTarget))) {
    throw new Error('EXTERNAL_QUOTE_ALLOWANCE_TARGET_NOT_ALLOWED');
  }
  if (!config.allowedExecutionTargets.some((entry) => sameAddress(entry, input.transaction.to))) {
    throw new Error('EXTERNAL_QUOTE_TARGET_NOT_ALLOWED');
  }
  if (config.nativeUsdcPerEth <= 0n) throw new Error('EXTERNAL_NATIVE_USDC_PRICE_REQUIRED');
  const gasEstimateUsdc = input.networkFeeWei * config.nativeUsdcPerEth / 10n ** 18n;
  return {
    source: input.source,
    quoteId: input.responseHash,
    stockToken: request.stockToken,
    usdcToken: request.usdcToken,
    stockAmount: input.stockAmount,
    usdcAmount: input.usdcAmount,
    guaranteedUsdc: input.minimumBuyAmount,
    gasEstimateUsdc,
    expiry: request.deadline,
    receivedAtMs: input.receivedAtMs,
    transaction: {
      to: input.transaction.to,
      data: input.transaction.data,
      value: input.transaction.value,
      allowanceTarget: input.allowanceTarget,
      chainId: config.chainId,
      recipient: request.recipient,
      stockToken: request.stockToken,
      usdcToken: request.usdcToken,
      sellAmount: request.sellAmount,
      minBuyAmount: input.minimumBuyAmount,
    },
  };
}

/**
 * Fan out every configured executable provider in parallel. A provider that
 * fails, times out, or reports no liquidity simply yields nothing: it never
 * blocks another venue and never degrades into a fabricated packet.
 */
export async function collectExternalProviderQuotes(
  adapters: readonly ExternalProviderAdapter[],
  request: SwapQuoteRequest,
): Promise<readonly ExternalSwapQuote[]> {
  const settled = await Promise.all(adapters.map(async (adapter) => {
    try {
      const quote = await adapter.quote(request);
      return quote ? [quote] : [];
    } catch {
      return [] as readonly ExternalSwapQuote[];
    }
  }));
  return settled.flat();
}

/**
 * Compose the legacy HTTP maker/facility port with the provider-native external
 * adapters. The service only needs `collect`, so the composite stays a thin
 * fan-out with no decision authority of its own.
 */
export class CompositeSwapQuotePort implements BaseSwapQuotePort {
  constructor(
    private readonly parts: readonly BaseSwapQuotePort[],
    private readonly externalProviders: readonly ExternalProviderAdapter[] = [],
  ) {}

  async collect(request: SwapQuoteRequest): Promise<SwapQuoteCollection> {
    const collected = await Promise.all(this.parts.map(async (part) => {
      try {
        return part.collect ? await part.collect(request) : await collectGranular(part, request);
      } catch {
        return {} as SwapQuoteCollection;
      }
    }));
    const external = await collectExternalProviderQuotes(this.externalProviders, request);
    return {
      makerQuotes: collected.flatMap((entry) => entry.makerQuotes ?? []),
      facilityQuotes: collected.flatMap((entry) => entry.facilityQuotes ?? []),
      externalQuotes: [...collected.flatMap((entry) => entry.externalQuotes ?? []), ...external],
    };
  }
}

async function collectGranular(port: BaseSwapQuotePort, request: SwapQuoteRequest): Promise<SwapQuoteCollection> {
  const [makers, facilities, external] = await Promise.all([
    port.getMakerQuotes ? port.getMakerQuotes(request).catch(() => []) : Promise.resolve([]),
    port.getFacilityQuotes ? port.getFacilityQuotes(request).catch(() => []) : Promise.resolve([]),
    port.getExternalQuotes ? port.getExternalQuotes(request).catch(() => []) : Promise.resolve([]),
  ]);
  return { makerQuotes: makers, facilityQuotes: facilities, externalQuotes: external };
}

// ---------------------------------------------------------------------------
// CoW: async signed intent (quote + EIP-712 order, local recovery only)
// ---------------------------------------------------------------------------

export interface CowLiveQuote {
  readonly responseHash: Hex;
  readonly receivedAtMs: number;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly receiver: Address;
  readonly owner: Address;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  readonly feeAmount: bigint;
  readonly validTo: number;
  readonly appData: Hex;
}

export interface CowOrderTypedData {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly types: {
    readonly Order: readonly { readonly name: string; readonly type: string }[];
  };
  readonly primaryType: 'Order';
  readonly message: {
    readonly sellToken: Address;
    readonly buyToken: Address;
    readonly receiver: Address;
    readonly sellAmount: string;
    readonly buyAmount: string;
    readonly validTo: number;
    readonly appData: Hex;
    readonly feeAmount: string;
    readonly kind: 'sell';
    readonly partiallyFillable: boolean;
    readonly sellTokenBalance: 'erc20';
    readonly buyTokenBalance: 'erc20';
  };
}

export const COW_ORDER_TYPES = [
  { name: 'sellToken', type: 'address' },
  { name: 'buyToken', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'sellAmount', type: 'uint256' },
  { name: 'buyAmount', type: 'uint256' },
  { name: 'validTo', type: 'uint32' },
  { name: 'appData', type: 'bytes32' },
  { name: 'feeAmount', type: 'uint256' },
  { name: 'kind', type: 'string' },
  { name: 'partiallyFillable', type: 'bool' },
  { name: 'sellTokenBalance', type: 'string' },
  { name: 'buyTokenBalance', type: 'string' },
] as const;

/**
 * Distinct CoW DTO. A CoW quote is an asynchronous signed intent, so it is
 * never rendered or submitted as an executable swap transaction.
 */
export interface CowQuoteDto {
  readonly schemaVersion: 1;
  readonly provider: 'COW';
  readonly kind: 'SIGNED_INTENT';
  readonly executable: false;
  readonly submitted: false;
  readonly chainId: string;
  readonly settlement: Address;
  readonly owner: Address;
  readonly receiver: Address;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: string;
  readonly buyAmount: string;
  readonly feeAmount: string;
  readonly validTo: string;
  readonly appData: Hex;
  readonly quoteAgeMs: number;
  readonly responseHash: Hex;
  readonly typedData: CowOrderTypedData;
  readonly orderDigest: Hex;
  readonly signature?: Hex;
  readonly signer?: Address;
  readonly recoveryMatches?: boolean;
}

/** Fetch a live CoW quote on Base. No liquidity yields `undefined`. */
export function createCowQuoteProvider(
  config: ExternalProviderConfig,
  deps: ExternalProviderDeps = {},
): { quote(request: SwapQuoteRequest): Promise<CowLiveQuote | undefined> } {
  const venue = config.venues.find((entry) => entry.id === 'COW');
  if (!venue) throw new Error('EXTERNAL_PROVIDER_NOT_CONFIGURED:COW');
  const context = providerContext(config, deps);
  return {
    async quote(request: SwapQuoteRequest): Promise<CowLiveQuote | undefined> {
      if (config.network !== 'mainnet') throw new Error('COW_QUOTE_MAINNET_ONLY');
      const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
      if (venue.apiKey) headers.set('authorization', `Bearer ${venue.apiKey}`);
      const startedAt = context.deps.clock();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), venue.timeoutMs);
      try {
        const response = await context.deps.fetcher(`${venue.baseUrl}/base/api/v1/quote`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            sellToken: request.stockToken,
            buyToken: request.usdcToken,
            receiver: request.recipient,
            from: request.taker,
            kind: 'sell',
            sellAmountBeforeFee: request.sellAmount.toString(10),
            // The quote API requires the full document to register it and
            // return its hash. An unknown hash-only placeholder is rejected.
            appData: COW_APP_DATA_JSON,
            validTo: Number(request.deadline),
            partiallyFillable: false,
            signingScheme: 'eip712',
            sellTokenBalance: 'erc20',
            buyTokenBalance: 'erc20',
          }),
        });
        const receivedAtMs = request.auctionOpenedAtMs + Math.max(0, context.deps.clock() - startedAt);
        if ([400, 404, 422].includes(response.status)) return undefined;
        if (!response.ok) throw new Error(`EXTERNAL_PROVIDER_HTTP_${response.status}`);
        const text = await response.text();
        if (!text) throw new Error('EXTERNAL_PROVIDER_RESPONSE_INVALID');
        const value = JSON.parse(text) as unknown;
        const record = object(value);
        const quote = object(record.quote);
        if (typeof quote.appData !== 'string') throw new Error('COW_APP_DATA_DOCUMENT');
        const appData = hex(quote.appDataHash, 'quote.appDataHash');
        if (appData !== keccak256(stringToHex(quote.appData))) throw new Error('COW_APP_DATA_HASH');
        return {
          responseHash: responseHashOf(value),
          receivedAtMs,
          sellToken: address(quote.sellToken, 'quote.sellToken'),
          buyToken: address(quote.buyToken, 'quote.buyToken'),
          receiver: address(quote.receiver, 'quote.receiver'),
          // The live OrderQuoteResponse puts the signer at the top-level
          // `from`; older/mirrored payloads may include it inside `quote`.
          owner: address(record.from ?? quote.from ?? quote.owner, 'quote.owner'),
          sellAmount: decimal(quote.sellAmount, 'quote.sellAmount'),
          buyAmount: decimal(quote.buyAmount, 'quote.buyAmount'),
          feeAmount: decimal(quote.feeAmount, 'quote.feeAmount'),
          validTo: Number(decimal(quote.validTo, 'quote.validTo')),
          appData,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Build the exact EIP-712 order for a live CoW quote. When a controlled QA key
 * is configured the order is signed locally and the signer is recovered to
 * prove the signature matches the configured QA key and taker; it is never
 * submitted to mainnet solvers.
 */
export async function buildCowOrder(input: {
  readonly config: ExternalProviderConfig;
  readonly request: SwapQuoteRequest;
  readonly liveQuote: CowLiveQuote;
  readonly nowMs: number;
}): Promise<CowQuoteDto> {
  const { config, request, liveQuote } = input;
  if (config.network !== 'mainnet') throw new Error('COW_QUOTE_MAINNET_ONLY');
  if (config.chainId !== getBaseNetworkConfig('mainnet').chainId) throw new Error('COW_QUOTE_CHAIN');
  if (liveQuote.sellToken.toLowerCase() !== request.stockToken.toLowerCase()) throw new Error('COW_QUOTE_ASSET_MISMATCH');
  if (liveQuote.buyToken.toLowerCase() !== request.usdcToken.toLowerCase()) throw new Error('COW_QUOTE_ASSET_MISMATCH');
  if (liveQuote.receiver.toLowerCase() !== request.recipient.toLowerCase()) throw new Error('COW_QUOTE_RECIPIENT');
  if (liveQuote.owner.toLowerCase() !== request.taker.toLowerCase()) throw new Error('COW_QUOTE_OWNER');
  if (liveQuote.sellAmount + liveQuote.feeAmount !== request.sellAmount) throw new Error('COW_QUOTE_SELL_AMOUNT');
  if (liveQuote.buyAmount < request.minBuyAmount) throw new Error('COW_QUOTE_MIN_OUT');
  if (!Number.isSafeInteger(liveQuote.validTo) || liveQuote.validTo <= Number(request.now)) throw new Error('COW_QUOTE_EXPIRED');

  const domain = {
    name: COW_DOMAIN_NAME,
    version: COW_DOMAIN_VERSION,
    chainId: config.chainId,
    verifyingContract: COW_SETTLEMENT_BASE,
  } as const;
  const message = {
    sellToken: liveQuote.sellToken,
    buyToken: liveQuote.buyToken,
    receiver: liveQuote.receiver,
    sellAmount: liveQuote.sellAmount.toString(10),
    buyAmount: liveQuote.buyAmount.toString(10),
    validTo: liveQuote.validTo,
    appData: liveQuote.appData,
    feeAmount: liveQuote.feeAmount.toString(10),
    kind: 'sell' as const,
    partiallyFillable: false,
    sellTokenBalance: 'erc20' as const,
    buyTokenBalance: 'erc20' as const,
  };
  const types = { Order: COW_ORDER_TYPES as unknown as readonly { readonly name: string; readonly type: string }[] };
  const typedData: CowOrderTypedData = {
    domain,
    types: { Order: COW_ORDER_TYPES },
    primaryType: 'Order',
    message,
  };
  const orderDigest = hashTypedData({ domain, types, primaryType: 'Order', message } as never);

  let signature: Hex | undefined;
  let signer: Address | undefined;
  let recoveryMatches: boolean | undefined;
  if (config.cowQaSignerKey) {
    const account = privateKeyToAccount(config.cowQaSignerKey);
    signature = await account.signTypedData({ domain, types, primaryType: 'Order', message } as never);
    const recovered = await recoverTypedDataAddress({ domain, types, primaryType: 'Order', message, signature } as never);
    signer = account.address;
    recoveryMatches = recovered.toLowerCase() === account.address.toLowerCase()
      && recovered.toLowerCase() === liveQuote.owner.toLowerCase();
    if (!recoveryMatches) throw new Error('COW_QUOTE_SIGNER_MISMATCH');
  }

  return {
    schemaVersion: 1,
    provider: 'COW',
    kind: 'SIGNED_INTENT',
    executable: false,
    submitted: false,
    chainId: String(config.chainId),
    settlement: COW_SETTLEMENT_BASE,
    owner: liveQuote.owner,
    receiver: request.recipient,
    sellToken: liveQuote.sellToken,
    buyToken: liveQuote.buyToken,
    sellAmount: liveQuote.sellAmount.toString(10),
    buyAmount: liveQuote.buyAmount.toString(10),
    feeAmount: liveQuote.feeAmount.toString(10),
    validTo: String(liveQuote.validTo),
    appData: liveQuote.appData,
    quoteAgeMs: Math.max(0, input.nowMs - liveQuote.receivedAtMs),
    responseHash: liveQuote.responseHash,
    typedData,
    orderDigest,
    ...(signature ? { signature } : {}),
    ...(signer ? { signer } : {}),
    ...(recoveryMatches === undefined ? {} : { recoveryMatches }),
  };
}

// ---------------------------------------------------------------------------
// Small strict parsers
// ---------------------------------------------------------------------------

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EXTERNAL_PROVIDER_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`EXTERNAL_PROVIDER_ADDRESS:${field}`);
  return value.toLowerCase() as Address;
}

function hex(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`EXTERNAL_PROVIDER_HEX:${field}`);
  return value.toLowerCase() as Hex;
}

function decimal(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`EXTERNAL_PROVIDER_DECIMAL:${field}`);
}

function optionalDecimal(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  return decimal(value, 'amount');
}

function responseHashOf(value: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(value)));
}

function parseAddressList(value: string | undefined): readonly Address[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => address(entry, 'allowlist')))];
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`EXTERNAL_CONFIG_INTEGER:${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`EXTERNAL_CONFIG_INTEGER:${name}`);
  return parsed;
}

function parseDecimalConfig(value: string, name: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`EXTERNAL_CONFIG_DECIMAL:${name}`);
  return BigInt(value);
}

function normalizePrivateKey(value: string | undefined): Hex | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('EXTERNAL_CONFIG_SIGNER_KEY');
  return value as Hex;
}

function normalizeBaseUrl(value: string, name: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`EXTERNAL_CONFIG_URL:${name}`); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(`EXTERNAL_CONFIG_URL:${name}`);
  return (parsed.origin + parsed.pathname).replace(/\/$/, '');
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}
