import { floorFee, parseAtomic } from './amounts';
import type { QuoteCandidate, QuoteSession, QuoteSessionRequest } from './types';

export const QUOTE_SPRINT_MS = 3_000;
export const DEFAULT_PRIVATE_QUOTE_LIFETIME_MS = 15_000;
export const MAX_QUOTE_LIFETIME_MS = 30_000;
export const MIN_REVIEW_REMAINING_MS = 2_000;
export const DEFAULT_KATON_FEE_BPS = 10;
export const MAX_KATON_FEE_BPS = 25;
export const EFFECTIVE_PRICE_DECIMALS = 6;

export function quoteLifetimeMs(sourceKind: QuoteCandidate['sourceKind'], requestedMs?: number): number {
  const fallback = sourceKind === 'private-maker' ? DEFAULT_PRIVATE_QUOTE_LIFETIME_MS : MAX_QUOTE_LIFETIME_MS;
  return Math.min(MAX_QUOTE_LIFETIME_MS, Math.max(1_000, requestedMs ?? fallback));
}

export function withComputedPrivateFee(candidate: Omit<QuoteCandidate, 'katonFeeAtomic' | 'netOutputAtomic'> & { readonly feeBps?: number }): QuoteCandidate {
  const feeBps = candidate.feeBps ?? DEFAULT_KATON_FEE_BPS;
  const fee = floorFee(candidate.grossOutputAtomic, feeBps);
  const net = parseAtomic(candidate.grossOutputAtomic) - fee - parseAtomic(candidate.venueFeeAtomic);
  if (net < 0n) throw new Error('route fees exceed gross output');
  const { feeBps: _feeBps, ...base } = candidate;
  return { ...base, katonFeeAtomic: fee.toString(), netOutputAtomic: net.toString() };
}

/** Return the net output per input unit as an integer at a fixed price scale. */
export function effectivePriceAtomic(
  inputAmountAtomic: string,
  netOutputAtomic: string,
  inputDecimals: number,
  outputDecimals = EFFECTIVE_PRICE_DECIMALS,
  priceDecimals = EFFECTIVE_PRICE_DECIMALS,
): string {
  const input = parseAtomic(inputAmountAtomic, 'input amount');
  const output = parseAtomic(netOutputAtomic, 'net output');
  if (input <= 0n) throw new Error('input amount must be greater than zero');
  if (![inputDecimals, outputDecimals, priceDecimals].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new Error('price decimals must be an integer between 0 and 255');
  }
  const numerator = output * 10n ** BigInt(inputDecimals + priceDecimals);
  const denominator = input * 10n ** BigInt(outputDecimals);
  return (numerator / denominator).toString();
}

export function canReviewQuote(candidate: QuoteCandidate, nowMs: number): boolean {
  return candidate.expiresAtMs - nowMs > MIN_REVIEW_REMAINING_MS && candidate.simulation.ok;
}

export function buildSession(id: string, request: QuoteSessionRequest, createdAtMs: number, eligibility: QuoteSession['eligibility']): QuoteSession {
  return { id, request, eligibility, state: eligibility.status === 'eligible' ? 'collecting' : eligibility.status, createdAtMs, collectionDeadlineMs: createdAtMs + QUOTE_SPRINT_MS, audit: [] };
}
