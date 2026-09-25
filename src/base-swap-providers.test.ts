import { describe, expect, it } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { hashTypedData, type Address, type Hex } from 'viem';

import {
  COW_EMPTY_APP_DATA,
  COW_APP_DATA_JSON,
  COW_SETTLEMENT_BASE,
  CompositeSwapQuotePort,
  ZERO_EX_ALLOWANCE_HOLDER,
  buildCowOrder,
  collectExternalProviderQuotes,
  createCowQuoteProvider,
  createExternalProviderAdapters,
  loadExternalProviderConfig,
  type ExternalProviderConfig,
} from '../apps/base-api/src/external-providers';
import type { SwapQuoteRequest } from '../packages/base-core/src/swap';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb' as Address;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address;
const TAKER = '0x1111111111111111111111111111111111111111' as Address;
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Address;
const EXECUTION_TARGET = '0x3333333333333333333333333333333333333333' as Address;
const RESPONSE_HASH = `0x${'a'.repeat(64)}` as Hex;

const NOW_MS = 1_700_000_000_000;
const CLOCK = (): number => NOW_MS;

function request(overrides: Partial<SwapQuoteRequest> = {}): SwapQuoteRequest {
  return {
    requestId: RESPONSE_HASH,
    stockToken: AAPL,
    usdcToken: USDC,
    sellAmount: 100_000_000n,
    minBuyAmount: 300_000_000n,
    taker: TAKER,
    recipient: RECIPIENT,
    deadline: 1_700_000_100n,
    now: 1_700_000_000n,
    auctionOpenedAtMs: NOW_MS,
    auctionCutoffAtMs: NOW_MS + 1_000,
    feeBps: 0n,
    chainId: 8453,
    decisionBlock: 0n,
    decisionBlockHash: RESPONSE_HASH,
    ...overrides,
  };
}

const BASE_ENV = {
  KATON_BASE_SWAP_0X_URL: 'https://api.0x.org',
  KATON_BASE_SWAP_1INCH_URL: 'https://api.1inch.dev',
  KATON_BASE_ENABLE_1INCH_EXECUTION: 'true',
  KATON_BASE_EXTERNAL_EXECUTION_TARGETS: EXECUTION_TARGET,
  KATON_BASE_EXTERNAL_ALLOWANCE_TARGETS: `${ZERO_EX_ALLOWANCE_HOLDER},0x4444444444444444444444444444444444444444`,
  KATON_BASE_NATIVE_USDC_PER_ETH: '3000000000',
} as const;

function config(overrides: Record<string, string | undefined> = {}): ExternalProviderConfig {
  return loadExternalProviderConfig({ ...BASE_ENV, ...overrides }, 'mainnet', 8453);
}

function jsonFetcher(payload: unknown, capture?: { urls: string[]; inits: RequestInit[] }): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    capture?.urls.push(String(url));
    if (init) capture?.inits.push(init);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function zeroExPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    liquidityAvailable: true,
    sellToken: AAPL,
    buyToken: USDC,
    sellAmount: '100000000',
    buyAmount: '310000000',
    minBuyAmount: '305000000',
    allowanceTarget: ZERO_EX_ALLOWANCE_HOLDER,
    totalNetworkFee: '100000000000000',
    transaction: { to: EXECUTION_TARGET, data: '0xdeadbeef', value: '0' },
    ...overrides,
  };
}

function oneInchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    srcToken: AAPL,
    dstToken: USDC,
    srcAmount: '100000000',
    dstAmount: '309000000',
    tx: {
      to: EXECUTION_TARGET,
      data: '0xabcdef12',
      gas: '200000',
      gasPrice: '1000000000',
    },
    ...overrides,
  };
}

describe('provider-native external swap adapters', () => {
  it('quotes 0x through AllowanceHolder v2 and emits the strict normalized packet', async () => {
    const capture = { urls: [] as string[], inits: [] as RequestInit[] };
    const adapters = createExternalProviderAdapters(
      config({ KATON_BASE_SWAP_0X_API_KEY: 'test-key', KATON_BASE_SWAP_1INCH_URL: undefined }),
      { fetcher: jsonFetcher(zeroExPayload(), capture), clock: CLOCK },
    );
    expect(adapters).toHaveLength(1);

    const quotes = await collectExternalProviderQuotes(adapters, request());
    expect(quotes).toHaveLength(1);
    const quote = quotes[0];
    expect(quote.source).toBe('0x');
    expect(quote.stockAmount).toBe(100_000_000n);
    expect(quote.usdcAmount).toBe(310_000_000n);
    expect(quote.guaranteedUsdc).toBe(305_000_000n);
    // 0.0001 ETH at 3000 USDC/ETH
    expect(quote.gasEstimateUsdc).toBe(300_000n);
    expect(quote.transaction).toMatchObject({
      to: EXECUTION_TARGET,
      chainId: 8453,
      recipient: RECIPIENT,
      stockToken: AAPL,
      usdcToken: USDC,
      sellAmount: 100_000_000n,
      minBuyAmount: 305_000_000n,
      allowanceTarget: ZERO_EX_ALLOWANCE_HOLDER.toLowerCase(),
    });
    expect(capture.urls[0]).toContain('/swap/allowance-holder/quote?');
    expect(capture.urls[0]).toContain('sellAmount=100000000');
    const headers = new Headers(capture.inits[0]?.headers);
    expect(headers.get('0x-api-key')).toBe('test-key');
    expect(headers.get('0x-version')).toBe('v2');
  });

  it('treats a no-liquidity 0x response as an honest empty result', async () => {
    const adapters = createExternalProviderAdapters(
      config({ KATON_BASE_SWAP_1INCH_URL: undefined }),
      { fetcher: jsonFetcher({ liquidityAvailable: false }), clock: CLOCK },
    );
    expect(await collectExternalProviderQuotes(adapters, request())).toEqual([]);
  });

  it('fails closed on every drifted or unvalidatable 0x field', async () => {
    const cases: Record<string, unknown>[] = [
      zeroExPayload({ sellAmount: '99999999' }),
      zeroExPayload({ minBuyAmount: '299999999' }),
      zeroExPayload({ allowanceTarget: '0x9999999999999999999999999999999999999999' }),
      zeroExPayload({ transaction: { to: '0x8888888888888888888888888888888888888888', data: '0xdeadbeef', value: '0' } }),
      zeroExPayload({ transaction: { to: EXECUTION_TARGET, data: '0x', value: '0' } }),
      zeroExPayload({ transaction: { to: EXECUTION_TARGET, data: '0xdeadbeef', value: '1' } }),
      zeroExPayload({ buyAmount: '0' }),
      zeroExPayload({ transaction: { to: EXECUTION_TARGET, data: 'not-hex', value: '0' } }),
    ];
    for (const payload of cases) {
      const adapters = createExternalProviderAdapters(
        config({ KATON_BASE_SWAP_1INCH_URL: undefined }),
        { fetcher: jsonFetcher(payload), clock: CLOCK },
      );
      expect(await collectExternalProviderQuotes(adapters, request()), JSON.stringify(payload)).toEqual([]);
    }
  });

  it('rejects a 0x quote whose chain does not match the configured chain', async () => {
    const adapters = createExternalProviderAdapters(
      config({ KATON_BASE_SWAP_1INCH_URL: undefined }),
      { fetcher: jsonFetcher(zeroExPayload()), clock: CLOCK },
    );
    expect(await collectExternalProviderQuotes(adapters, request({ chainId: 84532 }))).toEqual([]);
  });

  it('quotes 1inch Classic Swap v6.1 and prices gas in USDC', async () => {
    const capture = { urls: [] as string[], inits: [] as RequestInit[] };
    const adapters = createExternalProviderAdapters(
      config({ KATON_BASE_SWAP_0X_URL: undefined }),
      { fetcher: jsonFetcher(oneInchPayload(), capture), clock: CLOCK },
    );
    const quotes = await collectExternalProviderQuotes(adapters, request());
    expect(quotes).toHaveLength(1);
    expect(quotes[0].source).toBe('1inch');
    expect(quotes[0].guaranteedUsdc).toBe(309_000_000n);
    // 200000 gas * 1 gwei = 0.0002 ETH -> 600000 USDC base units
    expect(quotes[0].gasEstimateUsdc).toBe(600_000n);
    expect(capture.urls[0]).toContain('/swap/v6.1/8453/swap?');
    expect(quotes[0].transaction.allowanceTarget).toBeDefined();
  });

  it('rejects a 1inch quote below the requested minimum output', async () => {
    const adapters = createExternalProviderAdapters(
      config({ KATON_BASE_SWAP_0X_URL: undefined }),
      { fetcher: jsonFetcher(oneInchPayload({ dstAmount: '299999999' })), clock: CLOCK },
    );
    expect(await collectExternalProviderQuotes(adapters, request())).toEqual([]);
  });

  it('surfaces a live provider alongside a failing one without inventing liquidity', async () => {
    const first = createExternalProviderAdapters(
      config({ KATON_BASE_SWAP_1INCH_URL: undefined }),
      { fetcher: jsonFetcher(zeroExPayload()), clock: CLOCK },
    );
    const second = createExternalProviderAdapters(
      config({ KATON_BASE_SWAP_0X_URL: undefined, KATON_BASE_EXTERNAL_ALLOWANCE_TARGETS: '0x4444444444444444444444444444444444444444' }),
      {
        fetcher: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch,
        clock: CLOCK,
      },
    );
    const quotePort = new CompositeSwapQuotePort([], [...first, ...second]);
    const collection = await quotePort.collect(request());
    expect(collection.externalQuotes).toHaveLength(1);
    expect(collection.externalQuotes?.[0].source).toBe('0x');
  });
});

describe('server-only provider configuration', () => {
  it('stays disabled until a provider URL is configured', () => {
    const providerless = loadExternalProviderConfig({}, 'mainnet', 8453);
    expect(providerless.venues).toEqual([]);
    expect(() => createExternalProviderAdapters(providerless)).not.toThrow();
  });

  it('fails closed when a provider is enabled without allowlists or gas pricing', () => {
    expect(() => loadExternalProviderConfig({ KATON_BASE_SWAP_0X_URL: 'https://api.0x.org' }, 'mainnet', 8453))
      .toThrow('EXTERNAL_EXECUTION_TARGETS_REQUIRED');
    expect(() => loadExternalProviderConfig({
      KATON_BASE_SWAP_0X_URL: 'https://api.0x.org',
      KATON_BASE_EXTERNAL_EXECUTION_TARGETS: EXECUTION_TARGET,
    }, 'mainnet', 8453)).toThrow('EXTERNAL_ALLOWANCE_TARGETS_REQUIRED');
    expect(() => loadExternalProviderConfig({
      KATON_BASE_SWAP_0X_URL: 'https://api.0x.org',
      KATON_BASE_EXTERNAL_EXECUTION_TARGETS: EXECUTION_TARGET,
      KATON_BASE_EXTERNAL_ALLOWANCE_TARGETS: ZERO_EX_ALLOWANCE_HOLDER,
    }, 'mainnet', 8453)).toThrow('EXTERNAL_NATIVE_USDC_PRICE_REQUIRED');
    // 0x must have its real AllowanceHolder target allowlisted explicitly.
    expect(() => loadExternalProviderConfig({
      KATON_BASE_SWAP_0X_URL: 'https://api.0x.org',
      KATON_BASE_EXTERNAL_EXECUTION_TARGETS: EXECUTION_TARGET,
      KATON_BASE_EXTERNAL_ALLOWANCE_TARGETS: '0x4444444444444444444444444444444444444444',
      KATON_BASE_NATIVE_USDC_PER_ETH: '3000000000',
    }, 'mainnet', 8453)).toThrow('EXTERNAL_ALLOWANCE_TARGET_REQUIRED:0x');
  });

  it('carries explicit timeout and quote-age limits and rejects bad values', () => {
    const loaded = config({ KATON_BASE_EXTERNAL_TIMEOUT_MS: '900', KATON_BASE_EXTERNAL_MAX_QUOTE_AGE_MS: '15000' });
    expect(loaded.venues.every((venue) => venue.timeoutMs === 900 && venue.maxQuoteAgeMs === 15_000)).toBe(true);
    expect(() => config({ KATON_BASE_EXTERNAL_TIMEOUT_MS: '0' })).toThrow('EXTERNAL_CONFIG_INTEGER');
    expect(() => config({ KATON_BASE_NATIVE_USDC_PER_ETH: '-1' })).toThrow('EXTERNAL_CONFIG_DECIMAL');
    expect(() => config({ KATON_BASE_COW_QA_SIGNER_KEY: '0x1234' })).toThrow('EXTERNAL_CONFIG_SIGNER_KEY');
    expect(() => config({ KATON_BASE_SWAP_0X_URL: 'not-a-url' })).toThrow('EXTERNAL_CONFIG_URL');
  });
});

describe('CoW signed intent flow', () => {
  const signerKey = generatePrivateKey();
  const cowAccount = privateKeyToAccount(signerKey);

  function cowConfig(): ExternalProviderConfig {
    return config({
      KATON_BASE_SWAP_0X_URL: undefined,
      KATON_BASE_SWAP_1INCH_URL: undefined,
      KATON_BASE_SWAP_COW_URL: 'https://api.cow.fi',
      KATON_BASE_COW_QA_SIGNER_KEY: signerKey,
    });
  }

  function cowPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      from: cowAccount.address,
      quote: {
        sellToken: AAPL,
        buyToken: USDC,
        receiver: RECIPIENT,
        sellAmount: '99000000',
        buyAmount: '308000000',
        feeAmount: '1000000',
        validTo: 1_700_000_050,
        appData: COW_APP_DATA_JSON,
        appDataHash: COW_EMPTY_APP_DATA,
      },
      ...overrides,
    };
  }

  it('builds, signs, and locally recovers the exact CoW EIP-712 order', async () => {
    const capture = { urls: [] as string[], inits: [] as RequestInit[] };
    const provider = createCowQuoteProvider(cowConfig(), { fetcher: jsonFetcher(cowPayload(), capture), clock: CLOCK });
    const cowRequest = request({ taker: cowAccount.address });
    const live = await provider.quote(cowRequest);
    expect(live).toBeDefined();
    expect(live?.owner.toLowerCase()).toBe(cowAccount.address.toLowerCase());
    expect(JSON.parse(String(capture.inits[0]?.body)).appData).toBe(COW_APP_DATA_JSON);
    expect(live?.appData).toBe(COW_EMPTY_APP_DATA);
    const dto = await buildCowOrder({ config: cowConfig(), request: cowRequest, liveQuote: live!, nowMs: NOW_MS });

    expect(dto).toMatchObject({
      provider: 'COW',
      kind: 'SIGNED_INTENT',
      executable: false,
      submitted: false,
      settlement: COW_SETTLEMENT_BASE,
      chainId: '8453',
      sellAmount: '99000000',
      buyAmount: '308000000',
      feeAmount: '1000000',
      signer: cowAccount.address,
      recoveryMatches: true,
    });
    expect(dto.typedData.domain).toMatchObject({
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: 8453,
      verifyingContract: COW_SETTLEMENT_BASE,
    });
    expect(dto.typedData.message.appData).toBe(COW_EMPTY_APP_DATA);
    expect(dto.typedData.message.kind).toBe('sell');
    expect(dto.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(dto.orderDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(dto.orderDigest).toBe(hashTypedData({
      domain: dto.typedData.domain,
      types: { Order: dto.typedData.types.Order as never },
      primaryType: 'Order',
      message: dto.typedData.message,
    } as never));
  });

  it('rejects a CoW quote whose app-data document does not match its hash', async () => {
    const payload = cowPayload({ quote: {
      sellToken: AAPL, buyToken: USDC, receiver: RECIPIENT,
      sellAmount: '99000000', buyAmount: '308000000', feeAmount: '1000000',
      validTo: 1_700_000_050, appData: COW_APP_DATA_JSON,
      appDataHash: `0x${'11'.repeat(32)}`,
    } });
    const provider = createCowQuoteProvider(cowConfig(), { fetcher: jsonFetcher(payload), clock: CLOCK });
    await expect(provider.quote(request({ taker: cowAccount.address }))).rejects.toThrow('COW_APP_DATA_HASH');
  });

  it('reports no liquidity without fabricating an order', async () => {
    const provider = createCowQuoteProvider(cowConfig(), {
      fetcher: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
      clock: CLOCK,
    });
    expect(await provider.quote(request({ taker: cowAccount.address }))).toBeUndefined();
  });

  it('refuses a signature that does not match the taker', async () => {
    const provider = createCowQuoteProvider(cowConfig(), { fetcher: jsonFetcher(cowPayload()), clock: CLOCK });
    const live = await provider.quote(request({ taker: cowAccount.address }));
    await expect(buildCowOrder({
      config: cowConfig(),
      request: request({ taker: TAKER }),
      liveQuote: { ...live!, owner: TAKER },
      nowMs: NOW_MS,
    })).rejects.toThrow('COW_QUOTE_SIGNER_MISMATCH');
  });

  it('rejects a CoW quote with the wrong sell amount, minimum output, or expiry', async () => {
    const cfg = cowConfig();
    const live = {
      responseHash: RESPONSE_HASH,
      receivedAtMs: NOW_MS,
      sellToken: AAPL,
      buyToken: USDC,
      receiver: RECIPIENT,
      owner: cowAccount.address,
      sellAmount: 99_000_000n,
      buyAmount: 308_000_000n,
      feeAmount: 1_000_000n,
      validTo: 1_700_000_050,
      appData: COW_EMPTY_APP_DATA,
    };
    const taker = cowAccount.address;
    await expect(buildCowOrder({ config: cfg, request: request({ taker }), liveQuote: { ...live, sellAmount: 98_000_000n }, nowMs: NOW_MS }))
      .rejects.toThrow('COW_QUOTE_SELL_AMOUNT');
    await expect(buildCowOrder({ config: cfg, request: request({ taker }), liveQuote: { ...live, buyAmount: 1n }, nowMs: NOW_MS }))
      .rejects.toThrow('COW_QUOTE_MIN_OUT');
    await expect(buildCowOrder({ config: cfg, request: request({ taker }), liveQuote: { ...live, validTo: 1n }, nowMs: NOW_MS }))
      .rejects.toThrow('COW_QUOTE_EXPIRED');
    await expect(buildCowOrder({ config: cfg, request: request({ taker }), liveQuote: { ...live, receiver: TAKER }, nowMs: NOW_MS }))
      .rejects.toThrow('COW_QUOTE_RECIPIENT');
    await expect(buildCowOrder({ config: cfg, request: request({ taker }), liveQuote: { ...live, owner: TAKER }, nowMs: NOW_MS }))
      .rejects.toThrow('COW_QUOTE_OWNER');
  });

  it('keeps 1inch disabled unless its explicit execution gate is enabled', () => {
    const disabled = loadExternalProviderConfig({
      KATON_BASE_SWAP_1INCH_URL: 'https://api.1inch.dev',
    }, 'mainnet', 8453);
    expect(disabled.venues).toEqual([]);
    expect(config().venues.some((venue) => venue.id === '1inch')).toBe(true);
  });

  it('keeps CoW out of the executable fan-out and off non-mainnet networks', async () => {
    expect(createExternalProviderAdapters(cowConfig(), { fetcher: jsonFetcher(cowPayload()), clock: CLOCK })).toEqual([]);
    const sepolia = loadExternalProviderConfig({
      KATON_BASE_SWAP_COW_URL: 'https://api.cow.fi',
      KATON_BASE_EXTERNAL_EXECUTION_TARGETS: EXECUTION_TARGET,
      KATON_BASE_EXTERNAL_ALLOWANCE_TARGETS: '0x4444444444444444444444444444444444444444',
      KATON_BASE_NATIVE_USDC_PER_ETH: '3000000000',
    }, 'sepolia', 84532);
    await expect(createCowQuoteProvider(sepolia, { fetcher: jsonFetcher(cowPayload()), clock: CLOCK }).quote(request()))
      .rejects.toThrow('COW_QUOTE_MAINNET_ONLY');
  });
});
