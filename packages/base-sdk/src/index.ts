import { createHash, createHmac } from 'node:crypto';
import type { Hex } from 'viem';
import { deserializeStandingBid, serializeSignedBid, serializeSwapOrder } from './dto';
import type { SignedBidDto, StandingBidDto, SignedSwapOrderDto } from './dto';

export { buildFundingOrderTypedData, buildSwapOrderTypedData, LIQUIDATION_FUNDING_ORDER_TYPES, SWAP_ORDER_TYPES } from './typed-data';
export type { FundingOrderTypedData, SwapOrderTypedData } from './typed-data';
export type { SignedBidDto, StandingBidDto, SignedSwapOrderDto } from './dto';
export { deserializeStandingBid, deserializeSwapOrder, serializeOrder, serializeSignedBid, serializeSignedSwapOrder, serializeSwapOrder } from './dto';

export interface BaseLpClientOptions {
  readonly baseUrl: string;
  readonly keyId: string;
  readonly secret: string;
  readonly fetch?: typeof fetch;
  readonly allowInsecureLocal?: boolean;
  readonly clock?: () => number;
}

/** Canonical request authentication; the secret is used only locally. */
export function createCanonicalHmacHeaders(
  keyId: string,
  secret: string,
  method: string,
  path: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  if (!keyId || keyId.includes('.') || !secret) throw new Error('SDK_CREDENTIALS_INVALID');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('SDK_TIMESTAMP_INVALID');
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
  const signature = `0x${createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')}`;
  return {
    // The authorization scheme is intentionally non-Bearer: a bearer token
    // would imply that the credential itself is safe to forward or log.
    authorization: `Katon-HMAC ${keyId}:${signature}`,
    'x-katon-key-id': keyId,
    'x-katon-timestamp': String(timestamp),
    'x-katon-body-sha256': `0x${bodyHash}`,
    'x-katon-signature': signature,
  };
}

export class BaseLpClient {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;

  constructor(private readonly options: BaseLpClientOptions) {
    try {
      this.endpoint = new URL(options.baseUrl);
    } catch {
      throw new Error('SDK_ENDPOINT_INVALID');
    }
    if (this.endpoint.protocol !== 'https:') {
      const loopback = isLoopback(this.endpoint.hostname);
      if (this.endpoint.protocol !== 'http:' || !loopback || !options.allowInsecureLocal) throw new Error('HTTPS_REQUIRED');
    }
    if (!options.keyId || !options.secret) throw new Error('SDK_CREDENTIALS_INVALID');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
  }

  async placeBid(input: SignedBidDto): Promise<unknown> {
    return this.post('/v1/bids', serializeSignedBid(input));
  }

  async registerStandingBid(input: SignedBidDto): Promise<unknown> {
    return this.post('/v1/standing-bids', { action: 'register', ...serializeSignedBid(input) });
  }

  async revokeStandingBid(orderHash: Hex): Promise<unknown> {
    return this.post('/v1/standing-bids', { action: 'revoke', orderHash });
  }

  async quoteSwap(input: {
    readonly stockToken: `0x${string}`;
    readonly usdcToken: `0x${string}`;
    readonly sellAmount: bigint;
    readonly minBuyAmount: bigint;
    readonly taker: `0x${string}`;
    readonly recipient: `0x${string}`;
    readonly deadline: bigint;
  }): Promise<unknown> {
    return this.post('/v1/swaps/quote', {
      stockToken: input.stockToken,
      usdcToken: input.usdcToken,
      sellAmount: input.sellAmount.toString(10),
      minBuyAmount: input.minBuyAmount.toString(10),
      taker: input.taker,
      recipient: input.recipient,
      deadline: input.deadline.toString(10),
    });
  }

  async registerSwapOrder(input: SignedSwapOrderDto & { readonly remainingCapacity?: bigint }): Promise<unknown> {
    const remainingCapacity = input.remainingCapacity ?? input.order.stockAmount;
    return this.post('/v1/swap-orders', {
      action: 'register',
      order: serializeSwapOrder(input.order),
      signature: input.signature,
      remainingCapacity: remainingCapacity.toString(10),
    });
  }

  async revokeSwapOrder(orderHash: Hex): Promise<unknown> {
    return this.post('/v1/swap-orders', { action: 'revoke', orderHash });
  }

  async listStandingBids(): Promise<readonly StandingBidDto[]> {
    const response = await this.request('/v1/standing-bids/me', 'GET', '');
    if (!Array.isArray(response)) throw new Error('SDK_RESPONSE_INVALID');
    return response.map(deserializeStandingBid);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const serialized = JSON.stringify(body);
    return this.request(path, 'POST', serialized);
  }

  private async request(path: string, method: string, body: string): Promise<unknown> {
    const timestamp = this.clock();
    const headers = {
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...createCanonicalHmacHeaders(this.options.keyId, this.options.secret, method, path, timestamp, body),
    };
    const response = await this.fetcher(new URL(path, this.endpoint).toString(), {
      method,
      headers,
      ...(body ? { body } : {}),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try { parsed = JSON.parse(text); } catch { throw new Error('SDK_RESPONSE_INVALID'); }
    }
    if (!response.ok) {
      const code = parsed && typeof parsed === 'object' && 'code' in parsed ? String((parsed as { code: unknown }).code) : 'SDK_REQUEST_FAILED';
      throw new Error(code);
    }
    return parsed;
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export * from './bot';
