import { hexToString, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';

import { matchAuction } from '../packages/flare-core/src/matcher';
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
  sellAmount: 100_000_000_000_000_000_000n,
  minOutput: 95_000_000_000_000_000_000n,
  protocolFeeBps: 50,
  eligibilityPolicyId: '0x0000000000000000000000000000000000000000000000000000000000000044',
  eligibilityRevocationEpoch: 0n,
  eligibilityRole: 1n,
  eligibilityIssuerReference: '0x0000000000000000000000000000000000000000000000000000000000000055',
  legs: [{
    source: '0x00000000000000000000000000000000000000b1',
    sellAmount: 100_000_000_000_000_000_000n,
    minOutput: 95_000_000_000_000_000_000n,
    sourceData: '0x010203',
  }],
});

describe('confidential MATCH envelope for live settlement', () => {
  it('keeps the official golden hash when the fixture route is serialized', async () => {
    const { buildConfidentialMatchEnvelope } = await import('../packages/flare-core/src/fccMatch');
    const built = buildConfidentialMatchEnvelope(goldenRoute());
    expect(built.actionId).toBe(goldenRoute().fccActionId);
    expect(built.expectedHash).toBe(GOLDEN_SWAP_HASH);
    expect(built.expectedHash).toBe(hashSwapRoute(goldenRoute()));
  });

  it('binds dispatch actionId to a live router route instead of the golden dummy hash', async () => {
    const { buildConfidentialMatchEnvelope } = await import('../packages/flare-core/src/fccMatch');
    const actionId = keccak256('0x66283a11');
    const live: SwapRoutePlan = {
      ...goldenRoute(),
      router: '0x55aA4F400f3819498eD4Cbe120839E609f0897F3',
      seller: '0xeD37FD0d6F0f69236E7472B36796e133D20EcC32',
      recipient: '0xeD37FD0d6F0f69236E7472B36796e133D20EcC32',
      fccActionId: actionId,
      sellToken: '0xdeca491298a0e9f00d87d0390565cc33b3ac336f',
      buyToken: '0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0',
      sellAmount: 10n ** 18n,
      minOutput: 995n * 10n ** 18n,
      legs: [{
        source: '0x29713643c62c6743a5bf68e39ac1de8eaec0bc97',
        sellAmount: 10n ** 18n,
        minOutput: 1_000n * 10n ** 18n,
        sourceData: '0x',
      }],
    };
    const built = buildConfidentialMatchEnvelope(live);
    const wire = JSON.parse(hexToString(built.envelope));
    expect(built.actionId).toBe(actionId);
    expect(built.expectedHash).toBe(hashSwapRoute(live));
    expect(built.expectedHash).not.toBe(GOLDEN_SWAP_HASH);
    expect(wire.routePlan.fccActionId).toBe(actionId);
    expect(wire.auction.router.toLowerCase()).toBe(live.router.toLowerCase());
    expect(matchAuction(
      built.request.auction,
      built.request.bids,
      built.request.now,
      built.request.routePlan,
    ).resultHash).toBe(built.expectedHash);
  });
});
