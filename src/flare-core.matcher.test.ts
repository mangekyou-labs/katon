import { describe, expect, it } from 'vitest';

import {
  matchAuction,
  verifyQuorum,
  type MatcherBid,
  type MatcherAuction,
} from '../packages/flare-core/src/matcher';
import { hashSwapRoute, type SwapRoutePlan } from '../packages/flare-core/src/routeHash';

const GOLDEN_SWAP_HASH = '0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975';

const goldenRoute = (): SwapRoutePlan => ({
  chainId: 114n,
  router: '0x00000000000000000000000000000000000000aa',
  commitment: '0x0000000000000000000000000000000000000000000000000000000000000011',
  fccActionId: '0x0000000000000000000000000000000000000000000000000000000000000022',
  decisionBlock: 1_234_567n,
  decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000033',
  deadline: 2_000_000_000n,
  seller: '0x00000000000000000000000000000000000000c1',
  recipient: '0x00000000000000000000000000000000000000c2',
  sellToken: '0x0000000000000000000000000000000000000010',
  buyToken: '0x0000000000000000000000000000000000000020',
  sellAmount: 100n,
  minOutput: 90n,
  protocolFeeBps: 50,
  eligibilityPolicyId: '0x0000000000000000000000000000000000000000000000000000000000000044',
  eligibilityRevocationEpoch: 0n,
  eligibilityRole: 1n,
  eligibilityIssuerReference: '0x0000000000000000000000000000000000000000000000000000000000000055',
  legs: [{
    source: '0x00000000000000000000000000000000000000b1',
    sellAmount: 100n,
    minOutput: 90n,
    sourceData: '0x010203',
  }],
});

const auction: MatcherAuction = {
  commitment: '0x0000000000000000000000000000000000000000000000000000000000000011',
  chainId: 114,
  router: '0x00000000000000000000000000000000000000aa',
  sellToken: '0x0000000000000000000000000000000000000010',
  buyToken: '0x0000000000000000000000000000000000000020',
  sellAmount: 100n,
  minOutput: 90n,
  decisionDeadline: 2_000,
};

const bid = (commitment: string, output: bigint, sequence: bigint): MatcherBid => ({
  commitment,
  bidder: 'lp-1',
  sellToken: auction.sellToken,
  buyToken: auction.buyToken,
  sellAmount: 100n,
  quotedOutput: output,
  sequence,
  expiresAt: 2_100,
});

describe('deterministic confidential matcher', () => {
  it('produces the same winner independent of bid arrival order', () => {
    const first = matchAuction(auction, [bid('0xb', 100n, 2n), bid('0xa', 100n, 1n)], 1_000, goldenRoute());
    const second = matchAuction(auction, [bid('0xa', 100n, 1n), bid('0xb', 100n, 2n)], 1_000, goldenRoute());
    expect(first).toEqual(second);
    expect(first.winner.commitment).toBe('0xa');
  });

  it('fails closed for duplicate commitments, wrong pair, or insufficient output', () => {
    expect(() => matchAuction(auction, [bid('0xa', 100n, 1n), bid('0xa', 101n, 2n)], 1_000, goldenRoute())).toThrow(
      'DUPLICATE_BID',
    );
    expect(() =>
      matchAuction(auction, [{ ...bid('0xa', 100n, 1n), buyToken: '0xwrong' }], 1_000, goldenRoute()),
    ).toThrow('BID_PAIR');
    expect(() => matchAuction(auction, [bid('0xa', 89n, 1n)], 1_000, goldenRoute())).toThrow('NO_EXECUTABLE_ROUTE');
  });

  it('rejects malformed auction routing and bid metadata before ranking', () => {
    expect(() => matchAuction({ ...auction, router: '' }, [bid('0xa', 100n, 1n)], 1_000, goldenRoute())).toThrow(
      'AUCTION_INPUT',
    );
    expect(() => matchAuction(auction, [{ ...bid('0xa', 100n, -1n) }], 1_000, goldenRoute())).toThrow('BID_INPUT');
    expect(() => matchAuction(auction, [{ ...bid('0xa', 100n, 1n), bidder: '' }], 1_000, goldenRoute())).toThrow('BID_INPUT');
    expect(() => matchAuction(auction, [bid('0xa', 100n, 1n)], 1_000)).toThrow('ROUTE_PLAN_REQUIRED');
  });

  it('accepts exactly two matching signed results and rejects split-brain results', () => {
    expect(
      verifyQuorum([
        { resultHash: '0x1', teeId: 'a', attested: true },
        { resultHash: '0x1', teeId: 'b', attested: true },
        { resultHash: '0x2', teeId: 'c', attested: true },
      ]),
    ).toEqual({ resultHash: '0x1', signers: ['a', 'b'] });
    expect(() =>
      verifyQuorum([
        { resultHash: '0x1', teeId: 'a', attested: true },
        { resultHash: '0x2', teeId: 'b', attested: true },
        { resultHash: '0x3', teeId: 'c', attested: true },
      ]),
    ).toThrow('QUORUM_UNAVAILABLE');
    expect(() => verifyQuorum([
      { resultHash: '0x1', teeId: 'a', attested: true },
      { resultHash: '0x1', teeId: 'b', attested: true },
      { resultHash: '0x1', teeId: 'c', attested: true },
    ], 1)).toThrow('QUORUM_UNAVAILABLE');
    expect(() => verifyQuorum([
      { resultHash: '0x1', teeId: 'a', attested: true },
      { resultHash: '0x1', teeId: 'b', attested: true },
      { resultHash: '0x1', teeId: 'c', attested: true },
    ], 3)).toThrow('QUORUM_UNAVAILABLE');
  });

  it('emits RFQRouter.hashSwapRoute (abi.encode) not JSON keccak as resultHash', () => {
    const fixture: SwapRoutePlan = {
      ...goldenRoute(),
      sellAmount: 100_000_000_000_000_000_000n,
      minOutput: 95_000_000_000_000_000_000n,
      legs: [{
        source: '0x00000000000000000000000000000000000000b1',
        sellAmount: 100_000_000_000_000_000_000n,
        minOutput: 95_000_000_000_000_000_000n,
        sourceData: '0x010203',
      }],
    };
    expect(hashSwapRoute(fixture)).toBe(GOLDEN_SWAP_HASH);
    const matched = matchAuction(
      {
        ...auction,
        sellAmount: fixture.sellAmount,
        minOutput: fixture.minOutput,
      },
      [{
        ...bid('0xa', fixture.minOutput, 1n),
        sellAmount: fixture.sellAmount,
      }],
      1_000,
      fixture,
    );
    expect(matched.resultHash).toBe(GOLDEN_SWAP_HASH);
  });
});
