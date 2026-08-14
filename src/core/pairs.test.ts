import { describe, expect, it } from 'vitest';
import { ALL_PAIRS, isKnownPairKey, orderPairKey, pairKey, pairLabel, pairTokens } from './pairs';
import { TOKENS } from './tokens';

const USDC = TOKENS[1].value;
// the exact worked example in the spec (§2) — pins the canonical form
const SPEC_KEY = 'USDC:GBJH2XCGKRMFKCBYPFJHHGISZGLOYZ3TM3IMFQPQSK7NT2L7JUARLC26|XLM';

// the CHECK constraint the DB enforces on intents.pair_key / broadcasts.pair_key
// (docs/migrations/2026-07-10-intent-layer.sql) — client and DB must agree
const DB_PAIR_RE = /^[A-Z0-9]{1,12}(:G[A-Z2-7]{55})?\|[A-Z0-9]{1,12}(:G[A-Z2-7]{55})?$/;

describe('pairKey (canonical, direction-agnostic)', () => {
  it('produces the spec example and ignores direction', () => {
    expect(pairKey('XLM', USDC)).toBe(SPEC_KEY);
    expect(pairKey(USDC, 'XLM')).toBe(SPEC_KEY);
  });

  it('rejects unknown tokens (quarantine applies to pairs too)', () => {
    expect(() => pairKey('XLM', 'USDC')).toThrow(); // bare code is NOT the real USDC
    expect(() => pairKey('USDC:GATTACKERATTACKERATTACKERATTACKERATTACKERATTACKERATTA', 'XLM')).toThrow();
    expect(() => pairKey('', 'XLM')).toThrow();
  });

  it('rejects a token paired with itself', () => {
    expect(() => pairKey('XLM', 'XLM')).toThrow();
    expect(() => pairKey(USDC, USDC)).toThrow();
  });
});

describe('ALL_PAIRS / isKnownPairKey / pairTokens', () => {
  it('enumerates every unordered pair from the allow-list', () => {
    const n = TOKENS.length;
    expect(ALL_PAIRS).toHaveLength((n * (n - 1)) / 2);
    expect(ALL_PAIRS.map((p) => p.key)).toContain(SPEC_KEY);
  });

  it('every generated key satisfies the DB CHECK constraint', () => {
    for (const p of ALL_PAIRS) expect(p.key).toMatch(DB_PAIR_RE);
  });

  it('isKnownPairKey accepts only the canonical form', () => {
    expect(isKnownPairKey(SPEC_KEY)).toBe(true);
    expect(isKnownPairKey(`XLM|${USDC}`)).toBe(false); // reversed = non-canonical
    expect(isKnownPairKey('USDC|XLM')).toBe(false); // bare codes
    expect(isKnownPairKey('')).toBe(false);
  });

  it('pairTokens round-trips a known key and rejects the rest', () => {
    expect(pairTokens(SPEC_KEY)).toEqual([USDC, 'XLM']);
    expect(pairTokens('XLM|USDC')).toBeNull();
  });

  it('labels drop issuers', () => {
    expect(pairLabel(SPEC_KEY)).toBe('USDC / XLM');
  });
});

describe('orderPairKey', () => {
  it('derives the same key from either direction of a trade', () => {
    expect(orderPairKey({ maker_token: 'XLM', taker_token: USDC })).toBe(SPEC_KEY);
    expect(orderPairKey({ maker_token: USDC, taker_token: 'XLM' })).toBe(SPEC_KEY);
  });

  it('returns null when a leg is unknown', () => {
    expect(orderPairKey({ maker_token: 'XLM', taker_token: 'USDC:GFAKE' })).toBeNull();
  });

  // Load-bearing for the ticket: both of its token selects are populated from
  // TOKENS, so "unknown token" is unreachable there and a null key can ONLY mean
  // the two legs are the same. That is what blocks a same-token broadcast (a
  // broadcast needs a pair) while leaving a same-token DIRECTED order legal —
  // XLM→XLM is the two-wallet settlement E2E's vehicle.
  it('returns null when both legs are the same token', () => {
    expect(orderPairKey({ maker_token: 'XLM', taker_token: 'XLM' })).toBeNull();
    expect(orderPairKey({ maker_token: USDC, taker_token: USDC })).toBeNull();
  });
});
