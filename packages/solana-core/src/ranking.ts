import { compareAtomic, floorFee, parseAtomic } from './amounts';
import { routeAllowedForIssuer } from './issuers';
import { DEFAULT_KATON_FEE_BPS, MAX_KATON_FEE_BPS, MAX_QUOTE_LIFETIME_MS, QUOTE_SPRINT_MS } from './quote';
import { isNativeStableMint } from './registry';
import type { AssetRegistryEntry, QuoteCandidate, SanitizedAuditRow, StructuredRejectionCode, VerifiedSourceBalance } from './types';

export const MAX_SOURCE_BALANCE_AGE_MS = QUOTE_SPRINT_MS;

export interface RankInput {
  readonly candidates: readonly QuoteCandidate[];
  readonly nowMs: number;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
  readonly issuer: AssetRegistryEntry['issuer'];
  readonly inputDecimals: number;
  readonly outputDecimals?: number;
  /** Reference terms come from the signed asset registry, never from a source. */
  readonly referencePriceAtomic?: string;
  readonly referencePriceDecimals?: number;
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

function isSafeDecimals(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255;
}

function verifiedDeviationBps(candidate: QuoteCandidate, input: RankInput): number {
  if (!isSafeDecimals(input.inputDecimals) || !isSafeDecimals(input.outputDecimals ?? 6) || !isSafeDecimals(input.referencePriceDecimals)) {
    throw new Error('reference price decimals are malformed');
  }
  if (input.referencePriceAtomic === undefined) throw new Error('reference price is unavailable');
  const inputAmount = parseAtomic(candidate.inputAmountAtomic, 'input amount');
  const netOutput = parseAtomic(candidate.netOutputAtomic, 'net output');
  const referencePrice = parseAtomic(input.referencePriceAtomic, 'reference price');
  if (inputAmount <= 0n || referencePrice <= 0n || netOutput < 0n) throw new Error('price terms are malformed');

  const actual = netOutput * 10n ** BigInt(input.inputDecimals + input.referencePriceDecimals);
  const reference = inputAmount * 10n ** BigInt(input.outputDecimals ?? 6) * referencePrice;
  const difference = actual >= reference ? actual - reference : reference - actual;
  // Round away from zero so a slightly out-of-band quote cannot pass because
  // integer truncation understated its deviation.
  const deviation = (difference * 10_000n + reference - 1n) / reference;
  const bounded = deviation > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(deviation);
  return actual >= reference ? bounded : -bounded;
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

interface CandidateCheck {
  readonly rejectionCode?: StructuredRejectionCode;
  readonly deviationBps?: number;
}

function rejectionFor(candidate: QuoteCandidate, input: RankInput): CandidateCheck {
  const maxDeviationBps = input.maxDeviationBps;
  if (!hasValidMetadata(candidate, input)) return { rejectionCode: 'malformed_quote' };
  if (candidate.rejection) return { rejectionCode: candidate.rejection.code };
  if (!routeAllowedForIssuer(input.issuer, candidate)) return { rejectionCode: 'policy_failure' };
  if (!candidate.simulation.ok) return { rejectionCode: 'failed_simulation' };
  if (candidate.inputMint !== input.inputMint || candidate.inputAmountAtomic !== input.inputAmountAtomic) return { rejectionCode: 'input_mismatch' };
  if (input.wallet !== undefined && candidate.wallet !== input.wallet) return { rejectionCode: 'input_mismatch' };
  if (!isNativeStableMint(candidate.outputMint)) return { rejectionCode: 'unsupported_output' };
  if (candidate.outputMint !== input.outputMint) return { rejectionCode: 'output_mismatch' };
  if (candidate.transactionVersion !== 'v0') return { rejectionCode: 'transaction_unavailable' };
  const lifetimeMs = candidate.expiresAtMs - candidate.createdAtMs;
  if (lifetimeMs <= 0 || lifetimeMs > MAX_QUOTE_LIFETIME_MS) return { rejectionCode: 'malformed_quote' };
  if (candidate.expiresAtMs - input.nowMs <= 2_000) return { rejectionCode: 'expired' };
  if (maxDeviationBps !== undefined && (!Number.isSafeInteger(maxDeviationBps) || maxDeviationBps < 0)) return { rejectionCode: 'malformed_quote' };
  if (!candidate.transactionBase64) return { rejectionCode: 'transaction_unavailable' };
  try {
    const gross = parseAtomic(candidate.grossOutputAtomic, 'gross output');
    const katonFee = parseAtomic(candidate.katonFeeAtomic, 'Katon fee');
    const venueFee = parseAtomic(candidate.venueFeeAtomic, 'venue fee');
    const net = parseAtomic(candidate.netOutputAtomic, 'net output');
    if (gross < 0n || katonFee < 0n || venueFee < 0n || net < 0n || gross - katonFee - venueFee !== net) return { rejectionCode: 'malformed_quote' };
    if (candidate.sourceKind === 'private-maker') {
      const feeBps = candidate.katonFeeBps ?? DEFAULT_KATON_FEE_BPS;
      if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > MAX_KATON_FEE_BPS) return { rejectionCode: 'policy_failure' };
      if (floorFee(candidate.grossOutputAtomic, feeBps) !== katonFee) return { rejectionCode: 'malformed_quote' };
    } else if (candidate.katonFeeBps !== undefined && candidate.katonFeeBps !== 0) {
      return { rejectionCode: 'policy_failure' };
    }
    let deviationBps: number | undefined;
    if (maxDeviationBps !== undefined) {
      deviationBps = verifiedDeviationBps(candidate, input);
      if (Math.abs(deviationBps) > maxDeviationBps) return { rejectionCode: 'price_band', deviationBps };
    }
    if (candidate.sourceKind === 'private-maker') {
      const evidence = input.verifiedSourceBalances?.[candidate.sourceId];
      if (!evidence || evidence.sourceId !== candidate.sourceId || evidence.outputMint !== candidate.outputMint) return { rejectionCode: 'insufficient_liquidity' };
      if (!Number.isSafeInteger(evidence.checkedAtMs) || evidence.checkedAtMs < 0 || evidence.checkedAtMs > input.nowMs || input.nowMs - evidence.checkedAtMs > MAX_SOURCE_BALANCE_AGE_MS) return { rejectionCode: 'source_error' };
      const available = parseAtomic(evidence.balanceAtomic, 'verified source balance');
      if (available < gross) return { rejectionCode: 'insufficient_liquidity' };
    }
    return { deviationBps };
  } catch {
    return { rejectionCode: 'malformed_quote' };
  }
}

export function rankExecutableCandidates(input: RankInput): RankResult {
  const audit: SanitizedAuditRow[] = [];
  const executable: QuoteCandidate[] = [];
  for (const candidate of input.candidates) {
    const receivedAtMs = isSafeTimestamp(candidate?.createdAtMs) ? candidate.createdAtMs : input.nowMs;
    const sourceClass = candidate?.sourceKind === 'private-maker' ? 'private-maker' : 'jupiter';
    let rejectionCode: StructuredRejectionCode | undefined;
    try {
      const check = rejectionFor(candidate, input);
      rejectionCode = check.rejectionCode;
      if (!rejectionCode) {
        const feeNormalized = candidate.sourceKind === 'private-maker' && candidate.katonFeeBps === undefined
          ? { ...candidate, katonFeeBps: DEFAULT_KATON_FEE_BPS }
          : candidate;
        const normalized = check.deviationBps === undefined
          ? feeNormalized
          : { ...feeNormalized, deviationBps: check.deviationBps, referencePriceAtomic: input.referencePriceAtomic, referencePriceDecimals: input.referencePriceDecimals };
        executable.push(normalized);
        audit.push({ sourceClass, netOutputAtomic: normalized.netOutputAtomic, receivedAtMs, status: 'executable' });
        continue;
      }
    } catch {
      rejectionCode = 'malformed_quote';
    }
    if (rejectionCode) {
      audit.push({ sourceClass, receivedAtMs, rejectionCode, status: 'rejected' });
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
