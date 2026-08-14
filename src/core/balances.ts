// ---------------------------------------------------------------------------
// Wallet balances — pure parsing + affordability checks over Horizon JSON.
// ---------------------------------------------------------------------------
// The balance gate is client-side FRICTION, not enforcement (spec §5): it
// stops honest mistakes and lazy spam; a hostile client can bypass it, and the
// on-chain `fill` (SAC transfer reverts) remains the real boundary. So this
// module only needs to be honest, not tamper-proof — but it must FAIL CLOSED:
// an unknown balance (null map) is never treated as spendable (`canAfford`).
//
// Only allow-listed TOKENS reach the map — a look-alike trustline with an
// attacker issuer (USDC:GATTACKER…) is dropped here, same quarantine rule as
// tokens.ts. Spendable = balance − selling_liabilities, and XLM additionally
// subtracts the minimum reserve (2 + subentries) × 0.5 (spec §4.5 refinement).
//
// Pure by the src/core rule: no fetch, no window, no react. The Horizon
// `GET /accounts/{id}` response arrives as parsed-but-untrusted JSON (unknown)
// from src/data/useBalances.ts. Decimal math goes through Number — acceptable
// at Testnet scale for ≤7dp amounts — and every output is re-rounded to 7dp
// and rendered as a plain decimal string (never exponent notation).

import { isKnownToken, validAmount } from './tokens';

/**
 * TOKENS value ('XLM' or 'CODE:ISSUER') → SPENDABLE balance, decimal string
 * (≤7dp). Allow-listed tokens with no trustline are ABSENT — callers treat
 * absent as 0 (`balanceOf`).
 */
export type BalanceMap = Record<string, string>;

/** XLM per reserve unit; minimum balance = (2 + subentry_count) × this. */
const BASE_RESERVE = 0.5;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** Horizon amount field → finite number, or null for missing/garbage. */
const num = (v: unknown): number | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Round to 7dp, clamp at 0, plain decimal string with trailing zeros trimmed.
 *  toFixed never produces exponent notation below 1e21 — far beyond any
 *  Stellar amount (total XLM supply ≈ 1e11). */
const toDec7 = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n.toFixed(7).replace(/\.?0+$/, '');
};

/**
 * Parsed JSON of Horizon `GET /accounts/{id}` → spendable balances for
 * allow-listed tokens only. Defensive on shape: anything unexpected (missing
 * balances[], malformed entries, unknown asset types) is skipped, never thrown.
 */
export function parseAccountBalances(account: unknown): BalanceMap {
  const out: BalanceMap = {};
  if (!isRecord(account) || !Array.isArray(account.balances)) return out;

  const subentries = num(account.subentry_count) ?? 0;
  const reserve = (2 + subentries) * BASE_RESERVE;

  for (const entry of account.balances) {
    if (!isRecord(entry)) continue;
    const balance = num(entry.balance);
    if (balance === null) continue;
    const selling = num(entry.selling_liabilities) ?? 0;

    if (entry.asset_type === 'native') {
      out.XLM = toDec7(balance - selling - reserve);
    } else if (entry.asset_type === 'credit_alphanum4' || entry.asset_type === 'credit_alphanum12') {
      if (typeof entry.asset_code !== 'string' || typeof entry.asset_issuer !== 'string') continue;
      const key = `${entry.asset_code}:${entry.asset_issuer}`;
      if (!isKnownToken(key)) continue; // quarantine: unknown issuers never reach the map
      out[key] = toDec7(balance - selling);
    }
    // other asset_types (liquidity_pool_shares, …) are not tradable here — skip
  }
  return out;
}

/** The map for a LOADED but unfunded account (Horizon 404) — all zeros. */
export const emptyBalances = (): BalanceMap => ({});

/** Spendable balance for a token; absent trustline (or null map) reads as '0'. */
export const balanceOf = (balances: BalanceMap | null, token: string): string =>
  balances?.[token] ?? '0';

/**
 * Can the wallet give `amount` of `token`? False while balances are unknown
 * (null = not loaded / fetch failed → fail closed), false for anything that
 * isn't a validAmount, else amount ≤ spendable (exact-equal affords).
 */
export function canAfford(balances: BalanceMap | null, token: string, amount: string): boolean {
  if (balances === null) return false;
  if (!validAmount(amount)) return false;
  return parseFloat(amount) <= parseFloat(balanceOf(balances, token));
}

/** Display helper: ≤7dp, trailing zeros trimmed, '0' for zero/absent/garbage. */
export const fmtBalance = (v: string): string => toDec7(Number(v));
