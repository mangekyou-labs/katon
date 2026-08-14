// Counterparty-address validation, graded so the ticket can say WHAT is wrong
// rather than just "invalid". The checksum step is the real gate — ADDR_RE
// (tokens.ts) only proves the shape, and a mistyped character inside a
// well-shaped address passes it. StrKey does the base32 + version-byte +
// CRC16 check, so nothing here rolls its own crypto.
//
// Pure: no wallet, no network, no window.

import { StrKey } from '@stellar/stellar-sdk';

export type AddrCode = 'ok' | 'empty' | 'start' | 'charset' | 'length' | 'checksum' | 'self';

/** `self` = the connected wallet, so we can reject an order addressed to yourself. */
export function checkAddress(raw: string, self?: string | null): AddrCode {
  if (!raw) return 'empty';
  if (raw[0] !== 'G') return 'start';
  if (/[^A-Z2-7]/.test(raw)) return 'charset';
  if (raw.length !== 56) return 'length';
  if (!StrKey.isValidEd25519PublicKey(raw)) return 'checksum';
  if (self && raw === self) return 'self';
  return 'ok';
}

export const ADDR_MSG: Record<Exclude<AddrCode, 'ok'>, string> = {
  empty: 'Enter the counterparty’s wallet address.',
  start: 'That’s not a valid Stellar address — it should start with G and be 56 characters.',
  length: 'That’s not a valid Stellar address — it should start with G and be 56 characters.',
  charset: 'Stellar addresses only use A–Z and 2–7 — check for 0/O or 1/I mix-ups.',
  checksum: 'Looks like a Stellar address, but the checksum doesn’t match — re-copy it from your counterparty.',
  self: 'Counterparty cannot be your own address.',
};

/** Uppercase + strip whitespace, the only normalisation the field applies. */
export const normalizeAddress = (s: string): string => s.replace(/\s+/g, '').toUpperCase().slice(0, 64);
