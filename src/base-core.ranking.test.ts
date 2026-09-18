import { describe, expect, it } from 'vitest';
import type { Address } from '../packages/base-core/src/network';
import {
  compareLiquidationBids,
  facilityQuoteHash,
  rankLiquidation,
  type FacilityLiquidationQuote,
  type LiquidationBid,
  type LiquidationRankInput,
} from '../packages/base-core/src/ranking';
import type { LiquidationFundingDomain, LiquidationFundingOrder } from '../packages/base-core/src/eip712';

const USDC = '0x0000000000000000000000000000000000000010' as Address;
const B20 = '0x0000000000000000000000000000000000000020' as Address;
const MAKER = '0x0000000000000000000000000000000000000001' as Address;
const FACILITY = '0x0000000000000000000000000000000000000002' as Address;
const ADAPTER = '0x00000000000000000000000000000000000000aa' as Address;
const FACILITY_EXECUTOR = '0x0000000000000000000000000000000000000003' as Address;
const OTHER_RECIPIENT = '0x0000000000000000000000000000000000000007' as Address;
const OTHER_ADAPTER = '0x00000000000000000000000000000000000000ab' as Address;
const DOMAIN: LiquidationFundingDomain = {
  name: 'KatonRFQSettlement',
  version: '1',
  chainId: 84532,
  verifyingContract: '0x00000000000000000000000000000000000000bb',
};

const ORDER: LiquidationFundingOrder = {
  maker: MAKER,
  signer: MAKER,
  debtAsset: USDC,
  collateralAsset: B20,
  maxRepayAssets: 1_000n,
  minCollateralOut: 900n,
  fillMode: 1,
  expiry: 2_000n,
  salt: 1n,
  feeLimitBps: 50,
  rfqId: `0x${'00'.repeat(31)}01`,
  venue: '0x0000000000000000000000000000000000000000',
  marketId: `0x${'00'.repeat(31)}02`,
};

function baseInput(overrides: Partial<LiquidationRankInput> = {}): LiquidationRankInput {
  return {
    now: 1_000n,
    nativeUsdc: USDC,
    rfq: {
      rfqId: ORDER.rfqId,
      debtAsset: USDC,
      collateralAsset: B20,
      repayAssets: 1_000n,
      minCollateralOut: 900n,
      deadline: 1_500n,
    },
    venue: {
      closeFactorWad: 1_000_000_000_000_000_000n,
      liquidationBonusWad: 1_100_000_000_000_000_000n,
      chainlinkAnswerWad: 1_000_000_000_000_000_000n,
      b20MultiplierWad: 1_000_000_000_000_000_000n,
    },
    feeBps: 0n,
    aerodrome: { impliedCollateral: 1_200n, updatedAt: 900n, maxAge: 200n },
    oracleAvailable: true,
    sequencerUp: true,
    b20TransferEnabled: true,
    b20SeizeEnabled: true,
    recipientAuthorized: true,
    decisionBlock: 123n,
    decisionBlockHash: `0x${'11'.repeat(32)}`,
    domain: DOMAIN,
    adapterSlot: ADAPTER,
    bids: [
      {
        source: 'LP',
        maker: MAKER,
        order: ORDER,
        remainingCapacity: 1_000n,
        timestamp: 10n,
        minCollateralOut: 900n,
        adapter: ADAPTER,
      },
    ],
    facilityQuotes: [],
    ...overrides,
  };
}

function facility(overrides: Partial<FacilityLiquidationQuote> = {}): FacilityLiquidationQuote {
  return {
    source: 'FACILITY',
    quoteId: `0x${'22'.repeat(32)}`,
    facility: FACILITY,
    capacity: 1_000n,
    haircutWad: 0n,
    minCollateralOut: 900n,
    timestamp: 11n,
    adapter: ADAPTER,
    ...overrides,
  };
}

function bid(overrides: Partial<LiquidationBid> = {}): LiquidationBid {
  return {
    source: 'LP',
    maker: MAKER,
    order: ORDER,
    remainingCapacity: 1_000n,
    timestamp: 10n,
    minCollateralOut: 900n,
    adapter: ADAPTER,
    ...overrides,
  };
}

describe('public liquidation ranker', () => {
  it('U-RANK-1 ranks LP and facility sources against one venue-fixed floor', () => {
    const result = rankLiquidation(baseInput({ facilityQuotes: [facility()] }));
    expect(result.status).toBe('WINNER');
    expect(result.winner?.source).toBe('LP');
    expect(result.publicView.aerodromeFloor).toBe(1_200n);
  });

  it('U-RANK-2 rejects a source worse than the Aerodrome floor', () => {
    const result = rankLiquidation(baseInput({ aerodrome: { impliedCollateral: 1_000n, updatedAt: 900n, maxAge: 200n } }));
    expect(result.status).toBe('NO_ROUTE');
    expect(result.reason).toBe('FLOOR_NOT_MET');
  });

  it('U-RANK-3 compares gross seize, timestamp, then hash', () => {
    expect(compareLiquidationBids(
      { predictedGrossSeize: 10n, timestamp: 2n, orderHash: `0x${'02'.repeat(32)}` },
      { predictedGrossSeize: 11n, timestamp: 1n, orderHash: `0x${'01'.repeat(32)}` },
    )).toBeLessThan(0);
    expect(compareLiquidationBids(
      { predictedGrossSeize: 10n, timestamp: 2n, orderHash: `0x${'02'.repeat(32)}` },
      { predictedGrossSeize: 10n, timestamp: 3n, orderHash: `0x${'01'.repeat(32)}` },
    )).toBeLessThan(0);
    expect(compareLiquidationBids(
      { predictedGrossSeize: 10n, timestamp: 2n, orderHash: `0x${'01'.repeat(32)}` },
      { predictedGrossSeize: 10n, timestamp: 2n, orderHash: `0x${'02'.repeat(32)}` },
    )).toBeLessThan(0);
  });

  it('U-RANK-4 rejects number amounts at the ranker boundary', () => {
    const invalid = baseInput({ rfq: { ...baseInput().rfq, repayAssets: 1_000 as unknown as bigint } });
    expect(() => rankLiquidation(invalid)).toThrow('INTEGER_ONLY');
  });

  it('U-RANK-5 changes only the scaled share-equivalent label', () => {
    const one = rankLiquidation(baseInput());
    const two = rankLiquidation(baseInput({ venue: { ...baseInput().venue, b20MultiplierWad: 2_000_000_000_000_000_000n } }));
    expect(two.publicView.scaledShareEquivalent).toBe(one.publicView.tokenBaseUnits * 2n);
    expect(two.route?.predictedGrossSeize).toBe(one.route?.predictedGrossSeize);
  });

  it('U-RANK-6 skips exhausted LP capacity', () => {
    const result = rankLiquidation(baseInput({ bids: [bid({ remainingCapacity: 999n })], facilityQuotes: [facility()] }));
    expect(result.winner?.source).toBe('FACILITY');
  });

  it('U-RANK-7 skips expired bids and RFQs', () => {
    const expiredBid = bid({ order: { ...ORDER, expiry: 999n } });
    expect(rankLiquidation(baseInput({ bids: [expiredBid], facilityQuotes: [facility()] })).winner?.source).toBe('FACILITY');
    expect(rankLiquidation(baseInput({ rfq: { ...baseInput().rfq, deadline: 999n } })).status).toBe('NO_ROUTE');
  });

  it('treats an RFQ at its deadline as expired', () => {
    const result = rankLiquidation(baseInput({ rfq: { ...baseInput().rfq, deadline: 1_000n } }));
    expect(result.reason).toBe('EXPIRED');
  });

  it('U-RANK-8 strips losing prices from the public view', () => {
    const result = rankLiquidation(baseInput({ facilityQuotes: [facility({ capacity: 987_654n, minCollateralOut: 876_543n })] }));
    const publicJson = JSON.stringify(result.publicView, (_, value) => typeof value === 'bigint' ? value.toString() : value);
    expect(publicJson).not.toContain('987654');
    expect(publicJson).not.toContain('876543');
    expect(publicJson).not.toContain('remainingCapacity');
  });

  it('U-RANK-9 uses timestamp and hash after identical venue seize', () => {
    const result = rankLiquidation(baseInput({ facilityQuotes: [facility({ timestamp: 20n })] }));
    expect(result.winner?.source).toBe('LP');
  });

  it('U-RANK-10 rejects gross seize above an otherwise satisfied floor', () => {
    const result = rankLiquidation(baseInput({
      aerodrome: { impliedCollateral: 1_050n, updatedAt: 900n, maxAge: 200n },
      bids: [bid({ minCollateralOut: 1n })],
    }));
    expect(result.reason).toBe('FLOOR_NOT_MET');
  });

  it('U-RANK-11 fails the whole rank when Aerodrome is missing or stale', () => {
    expect(rankLiquidation(baseInput({ aerodrome: undefined })).reason).toBe('FLOOR_NOT_MET');
    expect(rankLiquidation(baseInput({ aerodrome: { impliedCollateral: 1_200n, updatedAt: 700n, maxAge: 200n } })).reason).toBe('FLOOR_NOT_MET');
  });

  it('U-RANK-12 applies facility haircut to capacity only', () => {
    const result = rankLiquidation(baseInput({ facilityQuotes: [facility({ capacity: 1_300n, haircutWad: 200_000_000_000_000_000n })], bids: [] }));
    expect(result.winner?.source).toBe('FACILITY');
    expect(result.winner?.quoteUsdcCapacity).toBe(1_040n);
    expect(result.route?.predictedGrossSeize).toBe(1_100n);
  });

  it('U-RANK-13 skips sources whose net seize misses either minimum', () => {
    const result = rankLiquidation(baseInput({ bids: [bid({ minCollateralOut: 1_101n })] }));
    expect(result.status).toBe('NO_ROUTE');
    expect(result.rejections?.[0]?.reason).toBe('MIN_OUT');
  });

  it('U-RANK-14 returns NO_ELIGIBLE_BID without a route', () => {
    const result = rankLiquidation(baseInput({ bids: [], facilityQuotes: [] }));
    expect(result.status).toBe('NO_ROUTE');
    expect(result.reason).toBe('NO_ELIGIBLE_BID');
    expect(result.route).toBeUndefined();
  });

  it('I-API-2 hashes a canonical winner-only route record at the decision block', () => {
    const result = rankLiquidation(baseInput());
    expect(result.routeHash).toBe('0x090f3c6989f2a7cc2219d16bc01a62266dfa447948c8bf76198c662992d049e9');
    expect(result.route).toMatchObject({
      winner: MAKER,
      source: 'LP',
      repayAssets: 1_000n,
      predictedGrossSeize: 1_100n,
      predictedNet: 1_100n,
      fee: 0n,
      rfqMinCollateralOut: 900n,
      funderMinCollateralOut: 900n,
      adapter: ADAPTER,
      decisionBlock: 123n,
      decisionBlockHash: `0x${'11'.repeat(32)}`,
    });
  });

  it('T3.5 ranks a facility executor as winner while keeping the facility as recipient', () => {
    const quote = facility({
      executor: FACILITY_EXECUTOR,
      recipient: FACILITY,
      executorAuthorized: true,
      recipientAuthorized: true,
    });
    const result = rankLiquidation(baseInput({ bids: [], facilityQuotes: [quote] }));

    expect(result.winner?.winner).toBe(FACILITY_EXECUTOR);
    expect(result.winner?.recipient).toBe(FACILITY);
    expect(result.publicView.winner?.identity).toBe(FACILITY_EXECUTOR);
    expect(facilityQuoteHash(quote.quoteId, FACILITY)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('T3.5 ignores any alternate facility recipient and keeps the facility as recipient', () => {
    const quote = facility({
      executor: FACILITY_EXECUTOR,
      recipient: OTHER_RECIPIENT,
      executorAuthorized: true,
      recipientAuthorized: true,
    });
    const result = rankLiquidation(baseInput({ bids: [], facilityQuotes: [quote] }));

    expect(result.winner?.recipient).toBe(FACILITY);
  });

  it('T3.5 applies candidate-specific executor and recipient authorization', () => {
    const result = rankLiquidation(baseInput({
      bids: [bid({ maker: MAKER, executorAuthorized: false })],
      facilityQuotes: [facility({ executor: FACILITY_EXECUTOR, recipientAuthorized: true })],
    }));

    expect(result.winner?.source).toBe('FACILITY');
    expect(result.rejections).toContainEqual({ source: 'LP', identity: MAKER, reason: 'B20_PAUSED' });
  });

  it('T3.5 binds one-off RFQ and venue restrictions while retaining zero as a standing wildcard', () => {
    const mismatchedRfq = rankLiquidation(baseInput({
      bids: [bid({ order: { ...ORDER, rfqId: `0x${'33'.repeat(32)}` } })],
    }));
    expect(mismatchedRfq.status).toBe('NO_ROUTE');
    expect(mismatchedRfq.rejections?.[0]?.reason).toBe('RFQ_MISMATCH');

    const mismatchedVenue = rankLiquidation(baseInput({
      bids: [bid({ order: { ...ORDER, rfqId: `0x${'00'.repeat(32)}`, venue: OTHER_ADAPTER } })],
    }));
    expect(mismatchedVenue.status).toBe('NO_ROUTE');
    expect(mismatchedVenue.rejections?.[0]?.reason).toBe('VENUE_MISMATCH');

    const wildcard = rankLiquidation(baseInput({
      bids: [bid({ order: { ...ORDER, rfqId: `0x${'00'.repeat(32)}`, venue: '0x0000000000000000000000000000000000000000' } })],
    }));
    expect(wildcard.status).toBe('WINNER');
  });

  it('T3.5 rejects candidates whose selected adapter is not the route adapter', () => {
    const lpResult = rankLiquidation(baseInput({
      bids: [bid({ adapter: OTHER_ADAPTER })],
    }));
    expect(lpResult.status).toBe('NO_ROUTE');
    expect(lpResult.rejections?.[0]?.reason).toBe('VENUE_MISMATCH');

    const facilityResult = rankLiquidation(baseInput({
      bids: [],
      facilityQuotes: [facility({ adapter: OTHER_ADAPTER })],
    }));
    expect(facilityResult.status).toBe('NO_ROUTE');
    expect(facilityResult.rejections?.[0]?.reason).toBe('VENUE_MISMATCH');
  });
});
