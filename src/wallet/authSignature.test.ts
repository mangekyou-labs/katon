import { hash, Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import { authSignatureBytes } from './authSignature';

const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const payload = hash(Buffer.from('a soroban auth-entry preimage'));
const sig = kp.sign(payload); // the raw 64-byte ed25519 signature

// what a SEP-43 wallet is supposed to hand back: base64 of the signature
const plain = sig.toString('base64');
// what stellar-wallets-kit 1.9.5 actually hands back when Freighter resolves
// with a base64 STRING: Buffer.from(<string>) takes its utf-8 bytes, so the
// re-encode produces base64 OF the base64.
const doubled = Buffer.from(plain).toString('base64');

// stellar-sdk hands back a Node Buffer while this module returns an npm-`buffer`
// Buffer (vite.config aliases the bare import). Same bytes, different prototype —
// compare the bytes, and let kp.verify be the real proof.
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('authSignatureBytes', () => {
  it('decodes a well-behaved wallet signature', () => {
    expect(hex(authSignatureBytes(plain))).toBe(hex(sig));
  });

  it('unwraps the double-base64 the kit produces, and the result verifies', () => {
    const out = authSignatureBytes(doubled);
    expect(hex(out)).toBe(hex(sig));
    expect(kp.verify(payload, out)).toBe(true);
  });

  it('refuses anything that is not a 64-byte signature', () => {
    expect(() => authSignatureBytes(Buffer.alloc(32).toString('base64'))).toThrow(/64/);
  });
});
