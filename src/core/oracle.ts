// ---------------------------------------------------------------------------
// Reflector fair-price math — pure. No window, no network, no wallet.
// ---------------------------------------------------------------------------
// The Reflector "External CEXs & DEXs" oracle prices every asset in USD (14
// decimals) and has NO x_last_price, so a pair rate is computed here from two
// single-asset prices: rate(maker→taker) = price(maker) / price(taker). Both
// prices share the same 10^14 scale, so the scale cancels and the ratio is a
// plain unitless number — how many taker-tokens one maker-token is worth.
//
// This is a REFERENCE aid only. It pre-fills an input the maker still edits and
// signs; it never touches the signed payload (src/core/canonical.ts).

import { tokenLabel } from './tokens';

// The symbols this oracle actually carries that we surface (verified against
// the live testnet feed 2026-07-15). Anything outside this set → no suggestion.
const SUPPORTED = new Set(['XLM', 'USDC']);

/** A TOKENS `value` → its Reflector symbol, or null if unsupported. */
export function oracleSymbol(tokenValue: string): string | null {
  const sym = tokenLabel(tokenValue); // drops the issuer: 'USDC:G…' → 'USDC'
  return SUPPORTED.has(sym) ? sym : null;
}

/**
 * takerPrice-per-makerPrice as a plain number. Scaled bigint division keeps
 * precision and avoids Number overflow on large i128 prices. null on
 * non-positive inputs.
 */
export function crossRate(makerPrice: bigint, takerPrice: bigint): number | null {
  if (makerPrice <= 0n || takerPrice <= 0n) return null;
  const SCALE = 1_000_000n;
  return Number((makerPrice * SCALE) / takerPrice) / Number(SCALE);
}

/** True when a price timestamp (seconds) is older than maxAge (default 10 min). */
export function isStale(timestampSec: number, nowMs: number, maxAgeMs = 600_000): boolean {
  return nowMs - timestampSec * 1000 > maxAgeMs;
}

/** base × rate, rounded to 7 decimals (SAC precision, so it passes validAmount). */
export function suggestedAmount(base: number, rate: number): number {
  return Math.round(base * rate * 1e7) / 1e7;
}
