import { describe, expect, it } from 'vitest';

import {
  buildSettlementSourceData,
  buildUnsignedLiquidationRouteTransaction,
  buildUnsignedSwapRouteTransaction,
  buildUnsignedRouteTransaction,
  createStandingBid,
} from '../packages/flare-sdk/src/index';

describe('Flare LP SDK', () => {
  it('creates a bounded standing bid without custody or floating-point amounts', () => {
    const bid = createStandingBid({
      maker: '0x0000000000000000000000000000000000000001',
      taker: '0x0000000000000000000000000000000000000002',
      sellToken: '0x0000000000000000000000000000000000000010',
      buyToken: '0x0000000000000000000000000000000000000020',
      sellAmount: 1_000n,
      minBuyAmount: 950n,
      expiry: 2_000n,
      nonce: 1n,
      pairSalt: '0x0000000000000000000000000000000000000000000000000000000000000001',
      feeBps: 0n,
    });
    expect(bid.orderType).toBe('limit');
    expect(bid.fillMode).toBe('partial');
    expect(bid.executor).toBe('0x0000000000000000000000000000000000000000');
    expect(bid.contextCommitment).toBe(`0x${'0'.repeat(64)}`);
    expect(() => createStandingBid({ ...bid, feeBps: 51n })).toThrow('FEE_TOO_HIGH');
    expect(() => createStandingBid({ ...bid, feeBps: -1n })).toThrow('FEE_TOO_LOW');
    expect(createStandingBid({ ...bid, minBuyAmount: 10_000n }).minBuyAmount).toBe(10_000n);
    expect(() => createStandingBid({ ...bid, sellToken: bid.buyToken })).toThrow('BID_PAIR');
  });

  it('assembles only an unsigned wallet transaction for the typed route', () => {
    const transaction = buildUnsignedRouteTransaction({
      router: '0x00000000000000000000000000000000000000aa',
      chainId: 114,
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000001',
      decisionBlock: 10n,
      decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      deadline: 2_000n,
      sellToken: '0x0000000000000000000000000000000000000010',
      buyToken: '0x0000000000000000000000000000000000000020',
      sellAmount: 100n,
      minOutput: 95n,
      legs: [{
        source: '0x0000000000000000000000000000000000000030',
        sellAmount: 100n,
        minOutput: 95n,
        sourceData: '0x',
      }],
    });
    expect(transaction).toMatchObject({
      to: '0x00000000000000000000000000000000000000AA',
      value: 0n,
      chainId: 114,
    });
    expect(transaction.data).toMatch(/^0x/);
  });

  it('rejects an unsigned route with a mismatched leg total', () => {
    expect(() => buildUnsignedRouteTransaction({
      router: '0x00000000000000000000000000000000000000aa',
      chainId: 114,
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000001',
      decisionBlock: 10n,
      decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      deadline: 2_000n,
      sellToken: '0x0000000000000000000000000000000000000010',
      buyToken: '0x0000000000000000000000000000000000000020',
      sellAmount: 100n,
      minOutput: 95n,
      legs: [],
    })).toThrow('ROUTE_INPUT');
  });

  it('assembles a seller-bound swap route with aggregate fee and eligibility snapshot', () => {
    const transaction = buildUnsignedSwapRouteTransaction({
      router: '0x00000000000000000000000000000000000000aa',
      chainId: 114,
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000002',
      fccActionId: '0x0000000000000000000000000000000000000000000000000000000000000009',
      decisionBlock: 10n,
      decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      deadline: 2_000n,
      seller: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
      sellToken: '0x0000000000000000000000000000000000000010',
      buyToken: '0x0000000000000000000000000000000000000020',
      sellAmount: 100n,
      minOutput: 95n,
      protocolFeeBps: 50,
      eligibilityPolicyId: '0x0000000000000000000000000000000000000000000000000000000000000003',
      eligibilityRevocationEpoch: 0n,
      eligibilityRole: 1n,
      eligibilityIssuerReference: '0x0000000000000000000000000000000000000000000000000000000000000004',
      legs: [{
        source: '0x0000000000000000000000000000000000000030',
        sellAmount: 100n,
        minOutput: 95n,
        sourceData: '0x',
      }],
    });
    expect(transaction.to).toBe('0x00000000000000000000000000000000000000AA');
    expect(transaction.data).toMatch(/^0x/);
  });

  it('assembles a typed liquidation route and rejects a zero minimum', () => {
    const transaction = buildUnsignedLiquidationRouteTransaction({
      router: '0x00000000000000000000000000000000000000aa',
      chainId: 114,
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000005',
      fccActionId: '0x0000000000000000000000000000000000000000000000000000000000000009',
      decisionBlock: 10n,
      decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      deadline: 2_000n,
      winner: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
      venue: '0x0000000000000000000000000000000000000003',
      market: '0x0000000000000000000000000000000000000004',
      position: '0x0000000000000000000000000000000000000000000000000000000000000006',
      debtToken: '0x0000000000000000000000000000000000000010',
      collateralToken: '0x0000000000000000000000000000000000000020',
      maxRepay: 100n,
      minNetCollateral: 95n,
      protocolFeeBps: 50,
      fundingSource: '0x0000000000000000000000000000000000000030',
      liquidationAdapter: '0x0000000000000000000000000000000000000040',
      eligibilityPolicyId: '0x0000000000000000000000000000000000000000000000000000000000000007',
      eligibilityRevocationEpoch: 0n,
      eligibilityRole: 8n,
      eligibilityIssuerReference: '0x0000000000000000000000000000000000000000000000000000000000000008',
    });
    expect(transaction.to).toBe('0x00000000000000000000000000000000000000AA');
    expect(transaction.data).toMatch(/^0x/);
    expect(() => buildUnsignedLiquidationRouteTransaction({
      ...argumentsForLiquidation(),
      minNetCollateral: 0n,
    })).toThrow('ROUTE_INPUT');
  });

  it('encodes a settlement source payload for a typed LP route', () => {
    const data = buildSettlementSourceData({
      order: {
        maker: '0x0000000000000000000000000000000000000001',
        taker: '0x0000000000000000000000000000000000000002',
        executor: '0x00000000000000000000000000000000000000aa',
        sellToken: '0x0000000000000000000000000000000000000010',
        buyToken: '0x0000000000000000000000000000000000000020',
        sellAmount: 100n,
        minBuyAmount: 95n,
        expiry: 2_000n,
        nonce: 1n,
        pairSalt: '0x0000000000000000000000000000000000000000000000000000000000000001',
        contextCommitment: '0x0000000000000000000000000000000000000000000000000000000000000002',
        orderType: 'rfq',
        fillMode: 'fok',
        feeBps: 50n,
      },
      sellAmount: 100n,
      buyAmount: 100n,
      signature: '0x1234',
    });
    expect(data).toMatch(/^0x/);
    expect(data.length).toBeGreaterThan(10);
  });
});

function argumentsForLiquidation() {
  return {
    router: '0x00000000000000000000000000000000000000aa' as const,
    chainId: 114,
    commitment: '0x0000000000000000000000000000000000000000000000000000000000000005' as const,
    fccActionId: '0x0000000000000000000000000000000000000000000000000000000000000009' as const,
    decisionBlock: 10n,
    decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as const,
    deadline: 2_000n,
    winner: '0x0000000000000000000000000000000000000001' as const,
    recipient: '0x0000000000000000000000000000000000000002' as const,
    venue: '0x0000000000000000000000000000000000000003' as const,
    market: '0x0000000000000000000000000000000000000004' as const,
    position: '0x0000000000000000000000000000000000000000000000000000000000000006' as const,
    debtToken: '0x0000000000000000000000000000000000000010' as const,
    collateralToken: '0x0000000000000000000000000000000000000020' as const,
    maxRepay: 100n,
    minNetCollateral: 95n,
    protocolFeeBps: 50,
    fundingSource: '0x0000000000000000000000000000000000000030' as const,
    liquidationAdapter: '0x0000000000000000000000000000000000000040' as const,
    eligibilityPolicyId: '0x0000000000000000000000000000000000000000000000000000000000000007' as const,
    eligibilityRevocationEpoch: 0n,
    eligibilityRole: 8n,
    eligibilityIssuerReference: '0x0000000000000000000000000000000000000000000000000000000000000008' as const,
  };
}
