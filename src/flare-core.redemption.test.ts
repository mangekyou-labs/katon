import { describe, expect, it } from 'vitest';

import {
  RedemptionProofRegistry,
  type RedemptionProof,
  type RedemptionRequest,
} from '../packages/flare-core/src/redemption';

const request: RedemptionRequest = {
  id: 1,
  asset: 'RWA-1',
  expectedAssets: 1_000n,
  inventoryAmount: 10n,
  recipient: 'facility-1',
  issuerReference: 'issuer-receipt-1',
  openedAt: 100,
  deadline: 2_000,
};

const proof: RedemptionProof = {
  requestId: 1,
  requestDigest: '0xproof-1',
  asset: 'RWA-1',
  inventoryAmount: 10n,
  expectedAssets: 1_000n,
  receivedAssets: 950n,
  recipient: 'facility-1',
  issuerReference: 'issuer-receipt-1',
  sourceId: 'issuer-api',
  asOf: 500,
  validUntil: 600,
  proofOwner: 'attestor-1',
  proofValid: true,
};

describe('typed redemption proof boundary', () => {
  it('settles an open request and records a realized shortfall exactly once', () => {
    const registry = new RedemptionProofRegistry();
    registry.open(request);
    expect(registry.accept(proof, 'attestor-1', 550)).toEqual({
      requestId: 1,
      receivedAssets: 950n,
      realizedLoss: 50n,
    });
    expect(() => registry.accept(proof, 'attestor-1', 550)).toThrow('PROOF_REPLAY');
    expect(() => registry.accept({ ...proof, requestDigest: '0xproof-2' }, 'attestor-1', 550)).toThrow(
      'REDEMPTION_SETTLED',
    );
  });

  it('fails closed for owner, source, schema, time, and request mismatches', () => {
    const registry = new RedemptionProofRegistry();
    registry.open(request);
    expect(() => registry.accept({ ...proof, proofOwner: 'other' }, 'attestor-1', 550)).toThrow('PROOF_OWNER');
    expect(() => registry.accept({ ...proof, sourceId: '' }, 'attestor-1', 550)).toThrow('PROOF_SCHEMA');
    expect(() => registry.accept({ ...proof, asOf: 400, validUntil: 499 }, 'attestor-1', 550)).toThrow('PROOF_EXPIRED');
    expect(() => registry.accept({ ...proof, requestId: 2 }, 'attestor-1', 550)).toThrow('REDEMPTION_UNKNOWN');
    expect(() => registry.accept({ ...proof, receivedAssets: 1_001n }, 'attestor-1', 550)).toThrow('PROOF_AMOUNT');
  });
});
