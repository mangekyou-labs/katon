// Normalises what a wallet hands back from signAuthEntry into the raw ed25519
// signature bytes that Stellar.authorizeEntry expects.
//
// Pure by design (no kit, no window) so it can be unit-tested in Node — the kit
// singleton next door cannot be imported outside a browser.
//
// WHY THIS EXISTS — stellar-wallets-kit 1.9.5 bug (measured 2026-07-14):
// Freighter resolves signAuthEntry with a base64 STRING, but the kit's Freighter
// module re-encodes it unconditionally:
//
//     signMessage:   typeof signedMessage === 'string' ? signedMessage : Buffer.from(...)  // guarded
//     signAuthEntry: Buffer.from(signedAuthEntry).toString('base64')                       // NOT guarded
//
// Buffer.from(<base64 string>) takes the string's utf-8 bytes, so what reaches us
// is base64 OF the base64. Decoding it once yields the 88 ASCII bytes of the
// inner base64, not a signature, and authorizeEntry rejects it with the (very
// unhelpful) "signature doesn't match payload".
//
// The unwrap is safe in both directions: a correctly-encoded signature decodes to
// 64 bytes on the first pass and is returned untouched, so this keeps working if
// the kit ever fixes the bug or another wallet module is added.

import { Buffer } from 'buffer';

/** ed25519 signature length. */
const SIG_BYTES = 64;

export function authSignatureBytes(signedAuthEntry: string): Buffer {
  const once = Buffer.from(signedAuthEntry, 'base64');
  if (once.length === SIG_BYTES) return once;

  // double-encoded: `once` is the ASCII of the real base64 signature
  const twice = Buffer.from(once.toString('latin1'), 'base64');
  if (twice.length === SIG_BYTES) return twice;

  throw new Error(
    `Wallet returned a ${once.length}-byte auth signature (expected ${SIG_BYTES}).`,
  );
}
