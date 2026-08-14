import { describe, expect, it } from 'vitest';

import {
  hashOrder,
  parseUnitsExact,
  rankSources,
  type Order,
  type RouteSource,
} from '../packages/flare-core/src/canonical';

const order: Order = {
  maker: '0x0000000000000000000000000000000000000001',
  taker: '0x0000000000000000000000000000000000000002',
  executor: '0x00000000000000000000000000000000000000bb',
  sellToken: '0x0000000000000000000000000000000000000010',
  buyToken: '0x0000000000000000000000000000000000000020',
  sellAmount: 1_000_000_000_000_000_000n,
  minBuyAmount: 950_000_000_000_000_000n,
  expiry: 2_000_000_000n,
  nonce: 7n,
  pairSalt: '0x0000000000000000000000000000000000000000000000000000000000000042',
  contextCommitment: '0x0000000000000000000000000000000000000000000000000000000000000043',
  orderType: 'rfq',
  fillMode: 'partial',
  feeBps: 0n,
};

describe('Flare canonical order boundary', () => {
  it('matches the pinned EIP-712 order vector', () => {
    expect(
      hashOrder(order, {
        name: 'TrustRFQ',
        version: '1',
        chainId: 114,
        verifyingContract: '0x00000000000000000000000000000000000000aa',
      }),
    ).toBe('0x14abeb3f994d71d79fe5f99fc15ee7b781c885e399427124da9a3da2cfe16572');
  });

  it('rejects an expiry outside the canonical uint64 range', () => {
    expect(() => hashOrder(
      { ...order, expiry: 1n << 64n },
      {
        name: 'TrustRFQ',
        version: '1',
        chainId: 114,
        verifyingContract: '0x00000000000000000000000000000000000000aa',
      },
    )).toThrow('EXPIRY_WIDTH');
  });

  it('parses decimal strings without floating-point rounding', () => {
    expect(parseUnitsExact('1.234567', 6)).toBe(1_234_567n);
    expect(parseUnitsExact('10', 6)).toBe(10_000_000n);
    expect(() => parseUnitsExact('1.2345671', 6)).toThrow('DECIMAL_PRECISION');
    expect(() => parseUnitsExact('1e3', 6)).toThrow('DECIMAL_FORMAT');
  });

  it('ranks equal-output sources by sequence and then commitment', () => {
    const sources: RouteSource[] = [
      { kind: 'lp', commitment: '0xbbb', quotedOutput: 100n, sequence: 2n },
      { kind: 'facility', commitment: '0xaaa', quotedOutput: 100n, sequence: 1n },
      { kind: 'lp', commitment: '0xccc', quotedOutput: 110n, sequence: 9n },
    ];
    expect(rankSources(sources).map((source) => source.commitment)).toEqual([
      '0xccc',
      '0xaaa',
      '0xbbb',
    ]);
  });
});
