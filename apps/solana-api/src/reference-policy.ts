export type ReferencePolicyStatus = 'ready' | 'market_closed' | 'stale' | 'conflicting' | 'corporate_action_pending' | 'unavailable';
export interface ReferenceObservation {
  readonly provider: string;
  readonly licensedPrimary: boolean;
  readonly priceAtomic: string;
  readonly observedAtMs: number;
  readonly sessionOpen: boolean;
  readonly corporateActionPending: boolean;
}
export interface ReferencePolicySnapshot {
  readonly status: ReferencePolicyStatus;
  readonly checkedAtMs: number;
  readonly primary?: ReferenceObservation;
  readonly crossCheck?: ReferenceObservation;
  readonly reason?: string;
}

export function evaluateReferencePolicy(
  observations: readonly ReferenceObservation[],
  nowMs: number,
  maxAgeMs = 15_000,
  maxAgreementBps = 50,
): ReferencePolicySnapshot {
  const [primary, crossCheck] = observations;
  const fail = (status: ReferencePolicyStatus, reason: string): ReferencePolicySnapshot => ({ status, checkedAtMs: nowMs, ...(primary ? { primary } : {}), ...(crossCheck ? { crossCheck } : {}), reason });
  if (!Number.isSafeInteger(nowMs) || !primary || !crossCheck || !primary.licensedPrimary || primary.provider === crossCheck.provider) return fail('unavailable', 'licensed primary and independent cross-check are required');
  if (primary.corporateActionPending || crossCheck.corporateActionPending) return fail('corporate_action_pending', 'corporate action review is pending');
  if (!primary.sessionOpen || !crossCheck.sessionOpen) return fail('market_closed', 'reference market session is closed');
  if ([primary, crossCheck].some((item) => !Number.isSafeInteger(item.observedAtMs) || item.observedAtMs > nowMs || nowMs - item.observedAtMs > maxAgeMs || !/^[1-9][0-9]*$/.test(item.priceAtomic))) return fail('stale', 'reference observations are stale or malformed');
  const a = BigInt(primary.priceAtomic); const b = BigInt(crossCheck.priceAtomic);
  const difference = a > b ? a - b : b - a;
  if (difference * 10_000n > (a < b ? a : b) * BigInt(maxAgreementBps)) return fail('conflicting', 'primary and cross-check observations exceed agreement tolerance');
  return { status: 'ready', checkedAtMs: nowMs, primary, crossCheck };
}

/** Deterministic non-DEX fixture for localnet/devnet only. */
export function localReferencePolicySnapshot(nowMs: number): ReferencePolicySnapshot {
  const observations: ReferenceObservation[] = [
    { provider: 'fixture-licensed-primary', licensedPrimary: true, priceAtomic: '100000000', observedAtMs: nowMs, sessionOpen: true, corporateActionPending: false },
    { provider: 'fixture-independent-cross-check', licensedPrimary: false, priceAtomic: '100020000', observedAtMs: nowMs, sessionOpen: true, corporateActionPending: false },
  ];
  return evaluateReferencePolicy(observations, nowMs);
}
