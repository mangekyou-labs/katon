import { describe, expect, it } from 'vitest';

import {
  decryptEnvelope,
  encryptEnvelope,
  type EnvelopeMetadata,
} from '../packages/flare-core/src/envelope';

const key = new Uint8Array(32).fill(7);
const metadata: EnvelopeMetadata = {
  keyId: 'tee-key-1',
  commitment: '0xauction-1',
  expiresAt: 2_000_000_000,
};

describe('confidential coordination envelope', () => {
  it('round-trips bytes and stores no plaintext fields', async () => {
    const plaintext = new TextEncoder().encode('{"amount":"1000000","secret":"bid"}');
    const envelope = await encryptEnvelope(plaintext, key, metadata);
    expect(JSON.stringify(envelope)).not.toContain('secret');
    expect(await decryptEnvelope(envelope, key, 1_000_000_000)).toEqual(plaintext);
  });

  it('rejects ciphertext or authenticated metadata tampering', async () => {
    const envelope = await encryptEnvelope(new Uint8Array([1, 2, 3]), key, metadata);
    const tamperedCiphertext = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -2)}00`,
    };
    const tamperedMetadata = { ...envelope, commitment: '0xother' };
    await expect(decryptEnvelope(tamperedCiphertext, key, 1_000_000_000)).rejects.toThrow(
      'ENVELOPE_AUTH_FAILED',
    );
    await expect(decryptEnvelope(tamperedMetadata, key, 1_000_000_000)).rejects.toThrow(
      'ENVELOPE_AUTH_FAILED',
    );
  });

  it('rejects expired envelopes before decryption', async () => {
    const envelope = await encryptEnvelope(new Uint8Array([1]), key, metadata);
    await expect(decryptEnvelope(envelope, key, 2_000_000_001)).rejects.toThrow('ENVELOPE_EXPIRED');
  });
});
