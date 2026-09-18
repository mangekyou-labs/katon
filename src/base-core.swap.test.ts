import { describe, expect, it } from 'vitest';
import {
  EIP712_DOMAIN_NAME,
  SWAP_EIP712_DOMAIN_VERSION,
  hashSwapOrder,
  type SwapOrder,
} from '../packages/base-core/src/eip712';
import {
  rankSwapQuotes,
  type FacilitySwapQuote,
  type MakerSwapQuote,
  type ExternalSwapQuote,
  type SwapQuoteRequest,
} from '../packages/base-core/src/swap';

const STOCK = '0x0000000000000000000000000000000000000011' as const;
const USDC = '0x0000000000000000000000000000000000000022' as const;
const TAKER = '0x0000000000000000000000000000000000000033' as const;
const RECIPIENT = '0x0000000000000000000000000000000000000044' as const;
const MAKER_A = '0x0000000000000000000000000000000000000055' as const;
const MAKER_B = '0x0000000000000000000000000000000000000066' as const;
const FACILITY = '0x0000000000000000000000000000000000000077' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ZERO_HASH = `0x${'00'.repeat(32)}` as const;

const request: SwapQuoteRequest = {
  requestId: `0x${'ab'.repeat(32)}`,
  stockToken: STOCK,
  usdcToken: USDC,
  sellAmount: 100n,
  minBuyAmount: 9_900n,
  taker: TAKER,
  recipient: RECIPIENT,
  deadline: 2_000n,
  now: 1_000n,
  auctionOpenedAtMs: 10_000,
  auctionCutoffAtMs: 11_000,
  feeBps: 50n,
  chainId: 84532,
  decisionBlock: 42n,
  decisionBlockHash: `0x${'cd'.repeat(32)}`,
};

function order(maker: typeof MAKER_A, stockAmount: bigint, usdcAmount: bigint, salt: bigint): SwapOrder {
  return {
    maker,
    signer: maker,
    stockToken: STOCK,
    usdcToken: USDC,
    stockAmount,
    usdcAmount,
    fillMode: 1,
    expiry: 2_000n,
    salt,
    feeCapBps: 50,
    allowedTaker: TAKER,
    rfqId: request.requestId,
  };
}

function makerQuote(maker: typeof MAKER_A, quoteId: string, stockAmount: bigint, usdcAmount: bigint, receivedAtMs: number): MakerSwapQuote {
  return {
    source: 'LP',
    quoteId: quoteId as `0x${string}`,
    order: order(maker, stockAmount, usdcAmount, BigInt(receivedAtMs)),
    receivedAtMs,
    gasEstimateUsdc: 0n,
    signature: '0x1234',
  };
}

describe('SwapOrder EIP-712 and stock auction ranking', () => {
  it('binds the stock order to settlement domain version 2 and chain', () => {
    const value = order(MAKER_A, 100n, 10_000n, 1n);
    const domain = {
      name: EIP712_DOMAIN_NAME,
      version: SWAP_EIP712_DOMAIN_VERSION,
      chainId: 84532,
      verifyingContract: '0x0000000000000000000000000000000000000088' as const,
    };
    const digest = hashSwapOrder(value, domain);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest).not.toBe(hashSwapOrder(value, { ...domain, chainId: 8453 }));
    expect(digest).not.toBe(hashSwapOrder(value, { ...domain, version: '1' }));
  });

  it('greedily blends best maker and facility prices and excludes late quotes', () => {
    const facility: FacilitySwapQuote = {
      source: 'FACILITY',
      quoteId: `0x${'ef'.repeat(32)}`,
      facility: FACILITY,
      stockToken: STOCK,
      usdcToken: USDC,
      stockCapacity: 40n,
      priceNumerator: 99n,
      priceDenominator: 1n,
      expiry: 1_800n,
      receivedAtMs: 10_500,
      gasEstimateUsdc: 0n,
    };
    const result = rankSwapQuotes({
      request,
      makerQuotes: [
        makerQuote(MAKER_A, `0x${'01'.repeat(32)}`, 60n, 6_060n, 10_100),
        makerQuote(MAKER_B, `0x${'02'.repeat(32)}`, 100n, 9_800n, 11_001),
      ],
      facilityQuotes: [facility],
      externalQuotes: [],
    });

    expect(result.internal?.legs).toHaveLength(2);
    expect(result.internal?.legs[0]?.source).toBe('LP');
    expect(result.internal?.legs[0]?.fillAmount).toBe(60n);
    expect(result.internal?.legs[1]?.source).toBe('FACILITY');
    expect(result.internal?.legs[1]?.fillAmount).toBe(40n);
    expect(result.internal?.guaranteedUsdc).toBe(9_970n);
    expect(result.rejections?.some((item) => item.quoteId === `0x${'02'.repeat(32)}` && item.reason === 'LATE')).toBe(true);
  });

  it('can consume a full fill-or-kill maker order as one leg of a blended route', () => {
    const facility: FacilitySwapQuote = {
      source: 'FACILITY',
      quoteId: `0x${'f1'.repeat(32)}`,
      facility: FACILITY,
      stockToken: STOCK,
      usdcToken: USDC,
      stockCapacity: 40n,
      priceNumerator: 99n,
      priceDenominator: 1n,
      expiry: 1_800n,
      receivedAtMs: 10_500,
      gasEstimateUsdc: 0n,
    };
    const fok = {
      ...makerQuote(MAKER_A, `0x${'f2'.repeat(32)}`, 60n, 6_060n, 10_100),
      order: { ...order(MAKER_A, 60n, 6_060n, 5n), fillMode: 0 as const },
    };
    const result = rankSwapQuotes({
      request,
      makerQuotes: [fok],
      facilityQuotes: [facility],
      externalQuotes: [],
    });

    expect(result.internal?.legs.map((leg) => leg.fillAmount)).toEqual([60n, 40n]);
  });

  it('rejects a route below seller minimum and mismatched taker orders', () => {
    const badTaker = makerQuote(MAKER_A, `0x${'03'.repeat(32)}`, 100n, 9_000n, 10_100);
    const mismatched = { ...badTaker, order: { ...badTaker.order, allowedTaker: ZERO } };
    const result = rankSwapQuotes({
      request: { ...request, minBuyAmount: 10_000n },
      makerQuotes: [mismatched],
      facilityQuotes: [],
      externalQuotes: [],
    });
    expect(result.internal).toBeUndefined();
    expect(result.reason).toBe('MIN_OUT');
  });

  it('rejects a fill-or-kill maker quote whose capacity is smaller than its signed order', () => {
    const quote = {
      ...makerQuote(MAKER_A, `0x${'04'.repeat(32)}`, 100n, 10_000n, 10_100),
      capacity: 40n,
      order: { ...order(MAKER_A, 100n, 10_000n, 4n), fillMode: 0 as const },
    };
    const result = rankSwapQuotes({
      request: { ...request, sellAmount: 40n, minBuyAmount: 3_900n },
      makerQuotes: [quote],
      facilityQuotes: [],
      externalQuotes: [],
    });

    expect(result.status).toBe('NO_ROUTE');
    expect(result.rejections).toContainEqual({
      source: 'LP',
      quoteId: `0x${'04'.repeat(32)}`,
      reason: 'CAPACITY',
    });
  });

  it('rejects malformed numeric maker order fields before ranking', () => {
    const malformed = {
      ...makerQuote(MAKER_A, `0x${'05'.repeat(32)}`, 100n, 10_000n, 10_100),
      order: { ...order(MAKER_A, 100n, 10_000n, 5n), fillMode: Number.NaN },
    };
    const result = rankSwapQuotes({
      request,
      makerQuotes: [malformed],
      facilityQuotes: [],
      externalQuotes: [],
    });

    expect(result.status).toBe('NO_ROUTE');
    expect(result.rejections).toContainEqual({
      source: 'LP',
      quoteId: `0x${'05'.repeat(32)}`,
      reason: 'INVALID_AMOUNT',
    });
  });

  it('rejects a maker leg whose minimum exceeds its signed output', () => {
    const quote = {
      ...makerQuote(MAKER_A, `0x${'06'.repeat(32)}`, 100n, 10_000n, 10_100),
      minUsdcOut: 10_001n,
    };
    const result = rankSwapQuotes({
      request,
      makerQuotes: [quote],
      facilityQuotes: [],
      externalQuotes: [],
    });

    expect(result.status).toBe('NO_ROUTE');
    expect(result.rejections).toContainEqual({
      source: 'LP',
      quoteId: `0x${'06'.repeat(32)}`,
      reason: 'MIN_OUT',
    });
  });

  it('requires an external packet to attest chain, pair, recipient, amounts, allowance, and simulation', () => {
    const external: ExternalSwapQuote = {
      source: '0x',
      quoteId: `0x${'07'.repeat(32)}`,
      stockToken: STOCK,
      usdcToken: USDC,
      stockAmount: request.sellAmount,
      usdcAmount: 10_000n,
      gasEstimateUsdc: 1n,
      expiry: 1_900n,
      receivedAtMs: 10_100,
      transaction: {
        to: FACILITY,
        data: '0x1234',
        value: 0n,
        chainId: 84532,
        recipient: RECIPIENT,
        stockToken: STOCK,
        usdcToken: USDC,
        sellAmount: request.sellAmount,
        minBuyAmount: request.minBuyAmount,
        allowanceTarget: MAKER_A,
        simulation: { ok: true, block: 42n },
      },
    };
    expect(rankSwapQuotes({ request, makerQuotes: [], facilityQuotes: [], externalQuotes: [external] }).status).toBe('WINNER');

    const invalid = { ...external, transaction: { ...external.transaction, recipient: MAKER_A, simulation: { ok: false } } };
    const result = rankSwapQuotes({ request, makerQuotes: [], facilityQuotes: [], externalQuotes: [invalid] });
    expect(result.status).toBe('NO_ROUTE');
    expect(result.rejections).toEqual(expect.arrayContaining([
      { source: '0x', quoteId: external.quoteId, reason: 'TAKER_MISMATCH' },
    ]));
  });
});
