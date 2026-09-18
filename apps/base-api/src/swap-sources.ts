import type { Address, Hex } from 'viem';
import type {
  ExternalSwapQuote,
  FacilitySwapQuote,
  MakerSwapQuote,
  SwapOrder,
  SwapQuoteRequest,
} from '../../../packages/base-core/src/index';
import type { BaseSwapQuotePort, EligibilityPort, SwapQuoteCollection } from './types';

export interface HttpSwapQuotePortOptions {
  readonly makerUrl?: string;
  readonly facilityUrl?: string;
  readonly externalUrls?: Readonly<Partial<Record<'0x' | '1inch' | 'AERODROME', string>>>;
  readonly apiKeys?: Readonly<Partial<Record<'0x' | '1inch' | 'AERODROME', string>>>;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

export interface HttpEligibilityPortOptions {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
  /** Optional bearer credential for a private policy service. */
  readonly apiKey?: string;
}

/**
 * Adapter for the policy/eligibility service used by the retail mainnet gate.
 * It deliberately accepts only a strict `{eligible, attestationId, expiresAt}`
 * response and turns every transport/parse failure into an ineligible result.
 */
export class HttpEligibilityPort implements EligibilityPort {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpEligibilityPortOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 850;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 5_000) {
      throw new Error('ELIGIBILITY_TIMEOUT_INVALID');
    }
    let parsed: URL;
    try { parsed = new URL(options.url); } catch { throw new Error('ELIGIBILITY_URL_INVALID'); }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('ELIGIBILITY_URL_INVALID');
  }

  async attest(taker: Address, stockToken: Address): Promise<{
    readonly eligible: boolean;
    readonly attestationId?: string;
    readonly expiresAt?: bigint;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
      if (this.options.apiKey) headers.set('authorization', `Bearer ${this.options.apiKey}`);
      const response = await this.fetcher(this.options.url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({ taker, stockToken }),
      });
      if (!response.ok) return { eligible: false };
      const value = object(JSON.parse(await response.text()) as unknown);
      if (typeof value.eligible !== 'boolean' || !value.eligible) return { eligible: false };
      if (typeof value.attestationId !== 'string' || value.attestationId.length === 0) return { eligible: false };
      const expiresAt = decimal(value.expiresAt);
      return { eligible: true, attestationId: value.attestationId, expiresAt };
    } catch {
      return { eligible: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Fail-closed HTTP adapters for approved quote venues. The adapter only
 * accepts normalized packets; raw provider responses are never forwarded to a
 * seller and malformed/late packets are discarded by the core ranker.
 */
export class HttpSwapQuotePort implements BaseSwapQuotePort {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpSwapQuotePortOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 850;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 5_000) throw new Error('SWAP_PROVIDER_TIMEOUT_INVALID');
  }

  async collect(request: SwapQuoteRequest): Promise<SwapQuoteCollection> {
    const [makers, facilities, external] = await Promise.all([
      this.options.makerUrl ? this.fetchStamped(this.options.makerUrl, request).then(({ value, receivedAtMs }) => parseMakers(value, receivedAtMs)).catch((error) => rethrowProviderMetadata(error)) : Promise.resolve<readonly MakerSwapQuote[]>([]),
      this.options.facilityUrl ? this.fetchStamped(this.options.facilityUrl, request).then(({ value, receivedAtMs }) => parseFacilities(value, receivedAtMs)).catch((error) => rethrowProviderMetadata(error)) : Promise.resolve<readonly FacilitySwapQuote[]>([]),
      this.fetchExternal(request),
    ]);
    return {
      makerQuotes: makers,
      facilityQuotes: facilities,
      externalQuotes: external,
    };
  }

  private async fetchExternal(request: SwapQuoteRequest): Promise<readonly ExternalSwapQuote[]> {
    const entries = Object.entries(this.options.externalUrls ?? {}) as readonly (['0x' | '1inch' | 'AERODROME', string])[];
    const responses = await Promise.all(entries.map(async ([source, url]) => {
      try {
        const { value, receivedAtMs } = await this.fetchStamped(url, request, source);
        return parseExternal(value, source, receivedAtMs);
      } catch (error) {
        rethrowProviderMetadata(error);
        return [] as readonly ExternalSwapQuote[];
      }
    }));
    return responses.flat();
  }

  private async fetchStamped(url: string, request: SwapQuoteRequest, source?: '0x' | '1inch' | 'AERODROME'): Promise<{ readonly value: unknown; readonly receivedAtMs: number }> {
    const startedAt = Date.now();
    const value = await this.fetchJson(url, request, source);
    const elapsed = Date.now() - startedAt;
    const receivedAtMs = request.auctionOpenedAtMs + Math.max(0, elapsed);
    return { value, receivedAtMs };
  }

  private async fetchJson(url: string, request: SwapQuoteRequest, source?: '0x' | '1inch' | 'AERODROME'): Promise<unknown> {
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { throw new Error('SWAP_PROVIDER_URL_INVALID'); }
    if (!['https:', 'http:'].includes(parsedUrl.protocol)) throw new Error('SWAP_PROVIDER_URL_INVALID');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
      const apiKey = source ? this.options.apiKeys?.[source] : undefined;
      if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
      const response = await this.fetcher(parsedUrl.toString(), {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          requestId: request.requestId,
          stockToken: request.stockToken,
          usdcToken: request.usdcToken,
          sellAmount: request.sellAmount.toString(10),
          minBuyAmount: request.minBuyAmount.toString(10),
          taker: request.taker,
          recipient: request.recipient,
          deadline: request.deadline.toString(10),
          ...(request.chainId === undefined ? {} : { chainId: request.chainId }),
          auctionCutoffAtMs: request.auctionCutoffAtMs,
        }),
      });
      if (!response.ok) throw new Error(`SWAP_PROVIDER_HTTP_${response.status}`);
      const text = await response.text();
      if (!text) throw new Error('SWAP_PROVIDER_RESPONSE_INVALID');
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseMakers(value: unknown, receivedAtMs?: number): readonly MakerSwapQuote[] {
  rejectProviderMetadata(value);
  const values = list(value, 'makerQuotes');
  return values.map((entry) => {
    const record = object(entry);
    const order = parseSwapOrder(record.order);
    return {
      source: 'LP',
      quoteId: hex(record.quoteId),
      order,
      signature: signature(record.signature),
      capacity: optionalDecimal(record.capacity),
      receivedAtMs: receivedAtMs ?? integer(record.receivedAtMs),
      gasEstimateUsdc: decimal(record.gasEstimateUsdc),
      ...(record.guaranteedUsdc === undefined ? {} : { guaranteedUsdc: decimal(record.guaranteedUsdc) }),
      ...(record.minUsdcOut === undefined ? {} : { minUsdcOut: decimal(record.minUsdcOut) }),
    };
  });
}

function parseFacilities(value: unknown, receivedAtMs?: number): readonly FacilitySwapQuote[] {
  rejectProviderMetadata(value);
  const values = list(value, 'facilityQuotes');
  return values.map((entry) => {
    const record = object(entry);
    return {
      source: 'FACILITY',
      quoteId: hex(record.quoteId),
      facility: address(record.facility),
      stockToken: address(record.stockToken),
      usdcToken: address(record.usdcToken),
      stockCapacity: decimal(record.stockCapacity),
      priceNumerator: decimal(record.priceNumerator),
      priceDenominator: decimal(record.priceDenominator),
      expiry: decimal(record.expiry),
      receivedAtMs: receivedAtMs ?? integer(record.receivedAtMs),
      gasEstimateUsdc: decimal(record.gasEstimateUsdc),
      ...(record.guaranteedUsdc === undefined ? {} : { guaranteedUsdc: decimal(record.guaranteedUsdc) }),
      ...(record.minUsdcOut === undefined ? {} : { minUsdcOut: decimal(record.minUsdcOut) }),
    };
  });
}

function parseExternal(value: unknown, source: '0x' | '1inch' | 'AERODROME', receivedAtMs?: number): readonly ExternalSwapQuote[] {
  rejectProviderMetadata(value);
  const values = list(value, 'quotes');
  return values.map((entry) => {
    const record = object(entry);
    rejectProviderMetadata(record);
    const transaction = object(record.transaction);
    rejectProviderMetadata(transaction);
    return {
      source,
      quoteId: hex(record.quoteId),
      stockToken: address(record.stockToken),
      usdcToken: address(record.usdcToken),
      stockAmount: decimal(record.stockAmount),
      usdcAmount: decimal(record.usdcAmount),
      ...(record.guaranteedUsdc === undefined ? {} : { guaranteedUsdc: decimal(record.guaranteedUsdc) }),
      gasEstimateUsdc: decimal(record.gasEstimateUsdc),
      expiry: decimal(record.expiry),
      receivedAtMs: receivedAtMs ?? integer(record.receivedAtMs),
      transaction: {
        to: address(transaction.to),
        data: hex(transaction.data),
        value: decimal(transaction.value),
        ...(transaction.allowanceTarget === undefined ? {} : { allowanceTarget: address(transaction.allowanceTarget) }),
        ...(transaction.chainId === undefined ? {} : { chainId: integer(transaction.chainId) }),
        ...(transaction.recipient === undefined ? {} : { recipient: address(transaction.recipient) }),
        ...(transaction.stockToken === undefined ? {} : { stockToken: address(transaction.stockToken) }),
        ...(transaction.usdcToken === undefined ? {} : { usdcToken: address(transaction.usdcToken) }),
        ...(transaction.sellAmount === undefined ? {} : { sellAmount: decimal(transaction.sellAmount) }),
        ...(transaction.minBuyAmount === undefined ? {} : { minBuyAmount: decimal(transaction.minBuyAmount) }),
        ...(transaction.simulation === undefined ? {} : { simulation: parseSimulation(transaction.simulation) }),
      },
    };
  });
}

function parseSwapOrder(value: unknown): SwapOrder {
  const record = object(value);
  return {
    maker: address(record.maker),
    signer: address(record.signer),
    stockToken: address(record.stockToken),
    usdcToken: address(record.usdcToken),
    stockAmount: decimal(record.stockAmount),
    usdcAmount: decimal(record.usdcAmount),
    fillMode: integer(record.fillMode),
    expiry: decimal(record.expiry),
    salt: decimal(record.salt),
    feeCapBps: integer(record.feeCapBps),
    allowedTaker: address(record.allowedTaker),
    rfqId: hex(record.rfqId),
  };
}

function list(value: unknown, property: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  const record = object(value);
  if (!Array.isArray(record[property])) throw new Error('SWAP_PROVIDER_RESPONSE_INVALID');
  return record[property] as readonly unknown[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SWAP_PROVIDER_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('SWAP_PROVIDER_ADDRESS_INVALID');
  return value.toLowerCase() as Address;
}

function hex(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) throw new Error('SWAP_PROVIDER_HEX_INVALID');
  return value.toLowerCase() as Hex;
}

function signature(value: unknown): Hex {
  const parsed = hex(value);
  if (parsed === '0x') throw new Error('SWAP_PROVIDER_SIGNATURE_INVALID');
  return parsed;
}

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('SWAP_PROVIDER_DECIMAL_INVALID');
  return BigInt(value);
}

function optionalDecimal(value: unknown): bigint | undefined {
  return value === undefined ? undefined : decimal(value);
}

function parseSimulation(value: unknown): { readonly ok: boolean; readonly block?: bigint } {
  const record = object(value);
  if (typeof record.ok !== 'boolean') throw new Error('SWAP_PROVIDER_SIMULATION_INVALID');
  const block = record.block === undefined ? undefined : decimal(record.block);
  return { ok: record.ok, ...(block === undefined ? {} : { block }) };
}

function rejectProviderMetadata(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (['decisionBlock', 'decisionBlockHash', 'simulationBlock', 'simulationBlockHash', 'preflight'].some((key) => key in record)) {
    throw new Error('SWAP_PROVIDER_METADATA_FORBIDDEN');
  }
  for (const key of ['makerQuotes', 'facilityQuotes', 'quotes']) {
    const entries = record[key];
    if (Array.isArray(entries)) for (const entry of entries) rejectProviderMetadata(entry);
  }
}

function rethrowProviderMetadata(error: unknown): [] {
  if (error instanceof Error && error.message === 'SWAP_PROVIDER_METADATA_FORBIDDEN') throw error;
  return [];
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('SWAP_PROVIDER_INTEGER_INVALID');
  return value;
}
