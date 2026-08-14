import { describe, expect, it } from 'vitest';

import { NavProofRegistry, FtsoRiskGuard, normalizeFtsoPrice } from '../packages/flare-core/src/oracles';

const proof = {
  requestDigest: '0xrequest-1',
  proofOwner: '0xowner',
  asset: 'RWA-1',
  scaledValue: 123_456n,
  decimals: 2,
  sourceId: 'issuer-nav',
  asOf: 1_000,
  validUntil: 2_000,
  merkleProofValid: true,
};

describe('Flare proof and risk guard boundaries', () => {
  it('accepts typed monotonic NAV and rejects replay/stale/wrong-owner proofs', () => {
    const registry = new NavProofRegistry();
    expect(registry.accept(proof, '0xowner')).toMatchObject({ scaledValue: 123_456n });
    expect(() => registry.accept(proof, '0xother')).toThrow('PROOF_OWNER');
    expect(() => registry.accept({ ...proof, requestDigest: '0xrequest-2', asOf: 999 }, '0xowner')).toThrow(
      'NAV_NOT_MONOTONIC',
    );
    expect(() => registry.accept({ ...proof, requestDigest: '0xrequest-3', scaledValue: 0n, asOf: 1_001 }, '0xowner')).toThrow(
      'PROOF_VALUE',
    );
    expect(() => registry.accept(proof, '0xowner')).toThrow('PROOF_REPLAY');
  });

  it('rejects malformed NAV identity, time, and decimal fields', () => {
    expect(() => new NavProofRegistry().accept({ ...proof, requestDigest: '' }, '0xowner')).toThrow('PROOF_SCHEMA');
    expect(() => new NavProofRegistry().accept({ ...proof, asset: '' }, '0xowner')).toThrow('PROOF_SCHEMA');
    expect(() => new NavProofRegistry().accept({ ...proof, proofOwner: '' }, '')).toThrow('PROOF_SCHEMA');
    expect(() => new NavProofRegistry().accept({ ...proof, asOf: -1 }, '0xowner')).toThrow('PROOF_SCHEMA');
    expect(() => new NavProofRegistry().accept({ ...proof, validUntil: 2.5 }, '0xowner')).toThrow('PROOF_SCHEMA');
    expect(() => new NavProofRegistry().accept({ ...proof, decimals: 2.5 }, '0xowner')).toThrow('PROOF_VALUE');
  });

  it('normalizes positive and negative FTSO decimals without floats', () => {
    expect(normalizeFtsoPrice(12345n, 2, 6)).toBe(1_234_500_000_000n);
    expect(normalizeFtsoPrice(12345n, -2, 6)).toBe(123_450_000n);
  });

  it('accepts fresh in-range feeds and rejects stale/depegged feeds', () => {
    const guard = new FtsoRiskGuard({ feedIds: ['USDX/USD'], maxAgeSeconds: 100, maxDeviationBps: 50n });
    expect(
      guard.assertUsable({ feedId: 'USDX/USD', value: 1_000_000n, decimals: -6, timestamp: 950 }, 1_000, 1_000_000n),
    ).toBe(1_000_000_000_000_000_000n);
    expect(() =>
      guard.assertUsable({ feedId: 'USDX/USD', value: 1_000_000n, decimals: -6, timestamp: 899 }, 1_000, 1_000_000n),
    ).toThrow('FTSO_STALE');
    expect(() =>
      guard.assertUsable({ feedId: 'USDX/USD', value: 990_000n, decimals: -6, timestamp: 950 }, 1_000, 1_000_000n),
    ).toThrow('FTSO_DEVIATION');
    expect(() =>
      guard.assertUsable({ feedId: 'UNSUPPORTED', value: 1n, decimals: 0, timestamp: 999 }, 1_000, 1n),
    ).toThrow('FTSO_FEED_UNSUPPORTED');
    expect(() =>
      guard.assertUsable({ feedId: 'USDX/USD', value: 1_000_000n, decimals: -6, timestamp: 950 }, 1_000, -1n),
    ).toThrow('FTSO_REFERENCE');
    expect(() => new FtsoRiskGuard({ feedIds: [], maxAgeSeconds: 100, maxDeviationBps: 50n })).toThrow('FTSO_POLICY');
  });
});
