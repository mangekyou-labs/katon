import { compareAtomic, parseAtomic } from './amounts';
import { MAX_QUOTE_LIFETIME_MS, QUOTE_SPRINT_MS } from './quote';
import { isNativeStableMint } from './registry';
import type { QuoteCandidate, SanitizedAuditRow, StructuredRejectionCode, VerifiedSourceBalance } from './types';

export const MAX_SOURCE_BALANCE_AGE_MS = QUOTE_SPRINT_MS;

export interface RankInput {
  readonly candidates: readonly QuoteCandidate[];
  readonly nowMs: number;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
  readonly wallet?: string;
  readonly maxDeviationBps?: number;
  readonly verifiedSourceBalances?: Readonly<Record<string, VerifiedSourceBalance>>;
}

export interface RankResult {
  readonly winner?: QuoteCandidate;
  readonly audit: readonly SanitizedAuditRow[];
}

function isSafeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isOptionalSafeBps(value: number | undefined): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function hasValidMetadata(candidate: QuoteCandidate, input: RankInput): boolean {
  return isSafeTimestamp(candidate?.createdAtMs)
    && isSafeTimestamp(candidate?.expiresAtMs)
    && isSafeTimestamp(candidate?.simulation?.simulatedAtMs)
    && candidate.createdAtMs <= input.nowMs
    && candidate.simulation.simulatedAtMs <= input.nowMs
    && Number.isSafeInteger(candidate.reliabilityBps)
    && candidate.reliabilityBps >= 0
    && candidate.reliabilityBps <= 10_000
    && isOptionalSafeBps(candidate.deviationBps)
    && isOptionalSafeBps(candidate.priceImpactBps);
}

function rejectionFor(candidate: QuoteCandidate, input: RankInput): StructuredRejectionCode | undefined {
  if (!hasValidMetadata(candidate, input)) return 'malformed_quote';
  if (candidate.rejection) return candidate.rejection.code;
  if (!candidate.simulation.ok) return 'failed_simulation';
  if (candidate.inputMint !== input.inputMint || candidate.inputAmountAtomic !== input.inputAmountAtomic) return 'input_mismatch';
  if (input.wallet !== undefined && candidate.wallet !== input.wallet) return 'input_mismatch';
  if (!isNativeStableMint(candidate.outputMint)) return 'unsupported_output';
  if (candidate.outputMint !== input.outputMint) return 'output_mismatch';
  if (candidate.transactionVersion !== 'v0') return 'transaction_unavailable';
  const lifetimeMs = candidate.expiresAtMs - candidate.createdAtMs;
  if (lifetimeMs <= 0 || lifetimeMs > MAX_QUOTE_LIFETIME_MS) return 'malformed_quote';
  if (candidate.expiresAtMs - input.nowMs <= 2_000) return 'expired';
  if (input.maxDeviationBps !== undefined && candidate.deviationBps !== undefined && Math.abs(candidate.deviationBps) > input.maxDeviationBps) return 'price_band';
  if (!candidate.transactionBase64) return 'transaction_unavailable';
  try {
    const gross = parseAtomic(candidate.grossOutputAtomic, 'gross output');
    const katonFee = parseAtomic(candidate.katonFeeAtomic, 'Katon fee');
    const venueFee = parseAtomic(candidate.venueFeeAtomic, 'venue fee');
    const net = parseAtomic(candidate.netOutputAtomic, 'net output');
    if (gross < 0n || katonFee < 0n || venueFee < 0n || net < 0n || gross - katonFee - venueFee !== net) return 'malformed_quote';
    if (candidate.sourceKind === 'private-maker') {
      const evidence = input.verifiedSourceBalances?.[candidate.sourceId];
      if (!evidence || evidence.sourceId !== candidate.sourceId || evidence.outputMint !== candidate.outputMint) return 'insufficient_liquidity';
      if (!Number.isSafeInteger(evidence.checkedAtMs) || evidence.checkedAtMs < 0 || evidence.checkedAtMs > input.nowMs || input.nowMs - evidence.checkedAtMs > MAX_SOURCE_BALANCE_AGE_MS) return 'source_error';
      const available = parseAtomic(evidence.balanceAtomic, 'verified source balance');
      if (available < gross) return 'insufficient_liquidity';
    }
  } catch {
    return 'malformed_quote';
  }
  return undefined;
}

export function rankExecutableCandidates(input: RankInput): RankResult {
  const audit: SanitizedAuditRow[] = [];
  const executable: QuoteCandidate[] = [];
  for (const candidate of input.candidates) {
    let rejectionCode: StructuredRejectionCode | undefined;
    try {
      rejectionCode = rejectionFor(candidate, input);
    } catch {
      rejectionCode = 'malformed_quote';
    }
    const receivedAtMs = isSafeTimestamp(candidate?.createdAtMs) ? candidate.createdAtMs : input.nowMs;
    const sourceClass = candidate?.sourceKind === 'private-maker' ? 'private-maker' : 'jupiter';
    if (rejectionCode) {
      audit.push({ sourceClass, receivedAtMs, rejectionCode, status: 'rejected' });
    } else {
      executable.push(candidate);
      audit.push({ sourceClass, netOutputAtomic: candidate.netOutputAtomic, receivedAtMs, status: 'executable' });
    }
  }
  executable.sort((left, right) => {
    const net = compareAtomic(right.netOutputAtomic, left.netOutputAtomic);
    if (net !== 0) return net;
    const validity = right.expiresAtMs - input.nowMs - (left.expiresAtMs - input.nowMs);
    if (validity !== 0) return validity;
    if (right.reliabilityBps !== left.reliabilityBps) return right.reliabilityBps - left.reliabilityBps;
    return left.sourceId.localeCompare(right.sourceId);
  });
  return { winner: executable[0], audit };
}

export function sanitizeAudit(rows: readonly SanitizedAuditRow[]): SanitizedAuditRow[] {
  return rows.map((row) => ({ ...row }));
}
