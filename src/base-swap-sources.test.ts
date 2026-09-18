import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { HttpEligibilityPort, HttpSwapQuotePort } from '../apps/base-api/src/swap-sources';
import type { SwapQuoteRequest } from '../packages/base-core/src/swap';

const STOCK = '0x0000000000000000000000000000000000000101' as Address;
const USDC = '0x0000000000000000000000000000000000000102' as Address;
const TAKER = '0x0000000000000000000000000000000000000103' as Address;
const RECIPIENT = '0x0000000000000000000000000000000000000104' as Address;
const MAKER = '0x0000000000000000000000000000000000000105' as Address;
const FACILITY = '0x0000000000000000000000000000000000000106' as Address;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

const request: SwapQuoteRequest = {
  requestId: `0x${'aa'.repeat(32)}`,
  stockToken: STOCK,
  usdcToken: USDC,
  sellAmount: 100n,
  minBuyAmount: 9_000n,
  taker: TAKER,
  recipient: RECIPIENT,
  deadline: 2_000n,
  now: 1_000n,
  auctionOpenedAtMs: 1_000_000,
  auctionCutoffAtMs: 1_001_000,
  feeBps: 5n,
  chainId: 84532,
  decisionBlock: 7n,
  decisionBlockHash: `0x${'bb'.repeat(32)}`,
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('approved swap quote HTTP adapters', () => {
  it('fans out maker, facility, and venue requests and normalizes executable packets', async () => {
    const calls: { url: string; body: Record<string, unknown>; authorization?: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      calls.push({ url, body, authorization: headers.get('authorization') ?? undefined });
      if (url.endsWith('/makers')) return response({ makerQuotes: [{
        quoteId: `0x${'01'.repeat(32)}`,
        order: {
          maker: MAKER,
          signer: MAKER,
          stockToken: STOCK,
          usdcToken: USDC,
          stockAmount: '100',
          usdcAmount: '10000',
          fillMode: 1,
          expiry: '2000',
          salt: '1',
          feeCapBps: 50,
          allowedTaker: TAKER,
          rfqId: ZERO_HASH,
        },
        signature: `0x${'11'.repeat(65)}`,
        receivedAtMs: 1_000_100,
        gasEstimateUsdc: '3',
      }] });
      if (url.endsWith('/facilities')) return response({ facilityQuotes: [{
        quoteId: `0x${'02'.repeat(32)}`,
        facility: FACILITY,
        stockToken: STOCK,
        usdcToken: USDC,
        stockCapacity: '100',
        priceNumerator: '99',
        priceDenominator: '1',
        expiry: '1900',
        receivedAtMs: 1_000_101,
        gasEstimateUsdc: '2',
      }] });
      return response({ quotes: [{
        quoteId: `0x${'03'.repeat(32)}`,
        stockToken: STOCK,
        usdcToken: USDC,
        stockAmount: '100',
        usdcAmount: '9800',
        guaranteedUsdc: '9790',
        gasEstimateUsdc: '5',
        expiry: '1900',
        receivedAtMs: 1_000_102,
        transaction: {
          to: FACILITY,
          data: '0x1234',
          value: '0',
          allowanceTarget: MAKER,
          chainId: 84532,
          recipient: RECIPIENT,
          stockToken: STOCK,
          usdcToken: USDC,
          sellAmount: '100',
          minBuyAmount: '9000',
          simulation: { ok: true, block: '7' },
        },
      }] });
    };
    const port = new HttpSwapQuotePort({
      makerUrl: 'https://approved.test/makers',
      facilityUrl: 'https://approved.test/facilities',
      externalUrls: { '0x': 'https://approved.test/0x' },
      apiKeys: { '0x': 'secret-not-logged' },
      fetcher,
    });

    const result = await port.collect(request);
    expect(result.makerQuotes).toHaveLength(1);
    expect(result.facilityQuotes).toHaveLength(1);
    expect(result.externalQuotes).toHaveLength(1);
    expect(result.externalQuotes?.[0]?.transaction).toMatchObject({ to: FACILITY, data: '0x1234', value: 0n, chainId: 84532, recipient: RECIPIENT, sellAmount: 100n, minBuyAmount: 9000n, simulation: { ok: true, block: 7n } });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.body.sellAmount).toBe('100');
    expect(calls.some((call) => call.authorization === 'Bearer secret-not-logged')).toBe(true);
  });

  it('fails closed for malformed provider packets and non-OK responses', async () => {
    const fetcher: typeof fetch = async (input) => String(input).endsWith('/bad') ? response({ quotes: [{ nope: true }] }) : response({}, 503);
    const port = new HttpSwapQuotePort({
      makerUrl: 'https://approved.test/bad',
      facilityUrl: 'https://approved.test/down',
      externalUrls: { '1inch': 'https://approved.test/down' },
      fetcher,
    });
    const result = await port.collect(request);
    expect(result.makerQuotes).toEqual([]);
    expect(result.facilityQuotes).toEqual([]);
    expect(result.externalQuotes).toEqual([]);
  });

  it('stamps quote receive time at the adapter boundary instead of trusting provider clocks', async () => {
    const fetcher: typeof fetch = async () => response({ makerQuotes: [{
      quoteId: `0x${'04'.repeat(32)}`,
      order: {
        maker: MAKER,
        signer: MAKER,
        stockToken: STOCK,
        usdcToken: USDC,
        stockAmount: '100',
        usdcAmount: '10000',
        fillMode: 1,
        expiry: '2000',
        salt: '1',
        feeCapBps: 50,
        allowedTaker: TAKER,
        rfqId: ZERO_HASH,
      },
      signature: `0x${'11'.repeat(65)}`,
      receivedAtMs: 9_999_999_999,
      gasEstimateUsdc: '0',
    }] });
    const result = await new HttpSwapQuotePort({ makerUrl: 'https://approved.test/makers', fetcher }).collect(request);
    const receivedAtMs = result.makerQuotes?.[0]?.receivedAtMs;
    expect(receivedAtMs).toBeGreaterThanOrEqual(request.auctionOpenedAtMs);
    expect(receivedAtMs).toBeLessThan(request.auctionCutoffAtMs);
  });
});

describe('wallet eligibility adapter', () => {
  it('returns a wallet-bound, expiring attestation and fails closed on bad data', async () => {
    const calls: string[] = [];
    const eligible = new HttpEligibilityPort({
      url: 'https://policy.test/check',
      apiKey: 'policy-secret',
      fetcher: async (input, init) => {
        calls.push(JSON.stringify({ input: String(input), body: init?.body, authorization: new Headers(init?.headers).get('authorization') }));
        return response({ eligible: true, attestationId: 'att-1', expiresAt: '1200' });
      },
    });
    await expect(eligible.attest(TAKER, STOCK)).resolves.toEqual({ eligible: true, attestationId: 'att-1', expiresAt: 1200n });
    expect(calls[0]).toContain('Bearer policy-secret');

    const denied = new HttpEligibilityPort({ url: 'https://policy.test/check', fetcher: async () => response({ eligible: true, expiresAt: '1200' }) });
    await expect(denied.attest(TAKER, STOCK)).resolves.toEqual({ eligible: false });
  });
});
