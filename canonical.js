// ---------------------------------------------------------------------------
// Canonical order encoding — the signature boundary.
// ---------------------------------------------------------------------------
// Everything here derives the EXACT bytes the maker and taker sign. Both parties
// sign a Soroban authorization entry over the `fill` arguments produced by
// `fillCanonicalArgs`; the permissionless submitter then calls `fill` with those
// same arguments. If sign-time and submit-time args differ by a single byte, the
// signatures are invalid and the fill reverts.
//
// So this file is deliberately its own module:
//   - it is PURE — no wallet, no network, no DOM, no `window`
//   - it takes the network passphrase as an argument rather than reading a global
//   - it is the only place allowed to decide how an order becomes ScVals
//
// The app (otc.js) imports from here and must never re-derive these values. This
// mirrors AirSwap, which keeps order canonicalization in @airswap/utils rather
// than in airswap-web, so the app cannot drift the signed payload.
//
// STELLAR.md invariant #2: `fillCanonicalArgs` must be deterministic — derive
// `expiration` from `order.expiration`, never `Date.now()`; never reorder args or
// change numeric encodings.
//
// Golden vectors for this module live in fixtures/canonical-args.json and are
// regenerated with tools/capture.html.
// ---------------------------------------------------------------------------

import * as Stellar from 'https://esm.sh/@stellar/stellar-sdk@16?bundle-deps';
import { Buffer } from 'https://esm.sh/buffer@6';

// token string ('XLM' | 'CODE:ISSUER') -> Asset
export function assetFor(tokenStr) {
  if (!tokenStr || tokenStr.toUpperCase() === 'XLM') return { asset: Stellar.Asset.native(), native: true };
  const [code, issuer] = tokenStr.split(':');
  return { asset: new Stellar.Asset(code, issuer), native: false };
}

// Asset -> Stellar Asset Contract id ('C...'), normalising older return shapes
export function sacIdFor(tokenStr, passphrase) {
  let id = assetFor(tokenStr).asset.contractId(passphrase);
  if (id instanceof Uint8Array) id = Stellar.StrKey.encodeContract(id);
  else if (typeof id === 'string' && !id.startsWith('C')) id = Stellar.StrKey.encodeContract(Buffer.from(id, 'hex'));
  return id;
}

// decimal string -> i128 stroops (7 dp) as BigInt
export function toStroops(s) {
  const [whole, frac = ''] = String(s).split('.');
  return BigInt(whole || '0') * 10000000n + BigInt((frac + '0000000').slice(0, 7));
}

export async function sha256Bytes(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}

// canonical `fill` arguments, derived deterministically from the order so both
// parties sign — and the submitter calls — byte-identical terms. This binding is
// what makes settlement safe: the on-chain amounts cannot differ from what each
// party signed.
export async function fillCanonicalArgs(order, passphrase) {
  const idBytes = await sha256Bytes(order.id);
  const expSec = Math.floor(new Date(order.expiration).getTime() / 1000);
  return [
    Stellar.Address.fromString(order.maker_address).toScVal(),
    Stellar.Address.fromString(order.taker_address).toScVal(),
    Stellar.Address.fromString(sacIdFor(order.maker_token, passphrase)).toScVal(),
    Stellar.Address.fromString(sacIdFor(order.taker_token, passphrase)).toScVal(),
    Stellar.nativeToScVal(toStroops(order.maker_amount), { type: 'i128' }),
    Stellar.nativeToScVal(toStroops(order.taker_amount), { type: 'i128' }),
    Stellar.nativeToScVal(BigInt(expSec), { type: 'u64' }),
    Stellar.nativeToScVal(Buffer.from(idBytes), { type: 'bytes' }),
  ];
}

// exact bytes the maker signs off-chain — fixed key order = deterministic
export function canonicalPayload(o) {
  return JSON.stringify({
    maker_address: o.maker_address,
    maker_amount: o.maker_amount,
    maker_token: o.maker_token,
    taker_address: o.taker_address,
    taker_amount: o.taker_amount,
    taker_token: o.taker_token,
    expiration: o.expiration,
    nonce: o.nonce,
  });
}
