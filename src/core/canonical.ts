// ---------------------------------------------------------------------------
// Canonical order encoding — the signature boundary.
// ---------------------------------------------------------------------------
// Everything here derives the EXACT bytes the maker and taker sign. Both parties
// sign a Soroban authorization entry over the `fill` arguments produced by
// `fillCanonicalArgs`; the permissionless submitter then calls `fill` with those
// same arguments. If sign-time and submit-time args differ by a single byte, the
// signatures are invalid and the fill reverts.
//
// This module is PURE — no wallet, no network, no DOM, no `window`. It takes the
// network passphrase as an argument rather than reading a global, which is what
// lets `canonical.test.ts` pin its output against fixtures/canonical-args.json.
//
// STELLAR.md invariant #2: `fillCanonicalArgs` must be deterministic — derive
// `expiration` from `order.expiration`, never `Date.now()`; never reorder args or
// change numeric encodings.
//
// Ported from the vanilla canonical.js. The golden vectors were captured from
// that file running against esm.sh, and this port must reproduce them exactly.
// ---------------------------------------------------------------------------

import { Address, Asset, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

/** The fields hashed into both parties' auth entries. */
export interface FillTerms {
  id: string;
  maker_address: string;
  taker_address: string;
  maker_token: string;
  taker_token: string;
  maker_amount: string;
  taker_amount: string;
  expiration: string;
}

/** The fields the maker signs off-chain when the RFQ is created. */
export interface SignedTerms {
  maker_address: string;
  maker_amount: string;
  maker_token: string;
  taker_address: string;
  taker_amount: string;
  taker_token: string;
  expiration: string;
  nonce: string;
}

/** token string ('XLM' | 'CODE:ISSUER') -> Asset */
export function assetFor(tokenStr: string): { asset: Asset; native: boolean } {
  if (!tokenStr || tokenStr.toUpperCase() === 'XLM') return { asset: Asset.native(), native: true };
  const [code, issuer] = tokenStr.split(':');
  return { asset: new Asset(code, issuer), native: false };
}

/** Asset -> Stellar Asset Contract id ('C...'), normalising older return shapes */
export function sacIdFor(tokenStr: string, passphrase: string): string {
  let id: unknown = assetFor(tokenStr).asset.contractId(passphrase);
  if (id instanceof Uint8Array) id = StrKey.encodeContract(Buffer.from(id));
  else if (typeof id === 'string' && !id.startsWith('C')) id = StrKey.encodeContract(Buffer.from(id, 'hex'));
  return id as string;
}

/** decimal string -> i128 stroops (7 dp) as BigInt */
export function toStroops(s: string): bigint {
  const [whole, frac = ''] = String(s).split('.');
  return BigInt(whole || '0') * 10000000n + BigInt((frac + '0000000').slice(0, 7));
}

export async function sha256Bytes(str: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}

/**
 * Canonical `fill` arguments, derived deterministically from the order so both
 * parties sign — and the submitter calls — byte-identical terms. This binding is
 * what makes settlement safe: the on-chain amounts cannot differ from what each
 * party signed.
 */
export async function fillCanonicalArgs(order: FillTerms, passphrase: string): Promise<xdr.ScVal[]> {
  const idBytes = await sha256Bytes(order.id);
  const expSec = Math.floor(new Date(order.expiration).getTime() / 1000);
  return [
    Address.fromString(order.maker_address).toScVal(),
    Address.fromString(order.taker_address).toScVal(),
    Address.fromString(sacIdFor(order.maker_token, passphrase)).toScVal(),
    Address.fromString(sacIdFor(order.taker_token, passphrase)).toScVal(),
    nativeToScVal(toStroops(order.maker_amount), { type: 'i128' }),
    nativeToScVal(toStroops(order.taker_amount), { type: 'i128' }),
    nativeToScVal(BigInt(expSec), { type: 'u64' }),
    nativeToScVal(Buffer.from(idBytes), { type: 'bytes' }),
  ];
}

/** exact bytes the maker signs off-chain — fixed key order = deterministic */
export function canonicalPayload(o: SignedTerms): string {
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
