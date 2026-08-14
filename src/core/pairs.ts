// ---------------------------------------------------------------------------
// Pair keys — canonical ids for unordered token pairs (intent layer).
// ---------------------------------------------------------------------------
// A pair key is the two allow-listed TOKENS values sorted lexicographically
// and joined with '|' (spec §2). It is direction-agnostic: one intent covers
// both directions of the pair. Only allow-listed tokens can form pairs — the
// unknown-token quarantine (tokens.ts) keeps applying to everything rendered.
// The DB enforces the same shape via CHECK constraints
// (docs/migrations/2026-07-10-intent-layer.sql).

import { TOKENS, isKnownToken, tokenLabel } from './tokens';

export const PAIR_SEP = '|';

/** Canonical key for a pair of allow-listed tokens. Throws on unknown/equal tokens. */
export function pairKey(a: string, b: string): string {
  if (!isKnownToken(a) || !isKnownToken(b)) throw new Error(`Unknown token in pair: ${a} / ${b}`);
  if (a === b) throw new Error('A pair needs two different tokens.');
  return [a, b].sort().join(PAIR_SEP);
}

export interface Pair {
  key: string;
  /** the two TOKENS values, in canonical (sorted) order */
  tokens: [string, string];
  /** display label, e.g. "USDC / XLM" */
  label: string;
}

export const pairLabel = (key: string): string =>
  key.split(PAIR_SEP).map(tokenLabel).join(' / ');

/** Every unordered pair constructible from the allow-list, canonical order. */
export const ALL_PAIRS: Pair[] = TOKENS.flatMap((t, i) =>
  TOKENS.slice(i + 1).map((u) => {
    const key = pairKey(t.value, u.value);
    return { key, tokens: key.split(PAIR_SEP) as [string, string], label: pairLabel(key) };
  }),
);

const PAIR_KEYS = new Set(ALL_PAIRS.map((p) => p.key));

/** Membership in ALL_PAIRS — rejects non-canonical order, unknown tokens, junk. */
export const isKnownPairKey = (key: string): boolean => PAIR_KEYS.has(key);

/** The two token values of a known pair key (canonical order), or null. */
export const pairTokens = (key: string): [string, string] | null =>
  isKnownPairKey(key) ? (key.split(PAIR_SEP) as [string, string]) : null;

/** Pair key for an order/broadcast's two legs; null if either leg is unknown. */
export function orderPairKey(o: { maker_token: string; taker_token: string }): string | null {
  try {
    return pairKey(o.maker_token, o.taker_token);
  } catch {
    return null;
  }
}
