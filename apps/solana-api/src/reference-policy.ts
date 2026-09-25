export type ReferencePolicyStatus = 'ready' | 'market_closed' | 'stale' | 'conflicting' | 'corporate_action_pending' | 'unavailable';
export interface ReferenceObservation {
  readonly provider: string;
  readonly symbol?: string;
  readonly licensedPrimary: boolean;
  readonly priceAtomic: string;
  readonly observedAtMs: number;
  readonly sessionOpen: boolean;
  readonly marketSession?: string;
  readonly corporateActionPending: boolean;
}
export interface ReferencePolicySnapshot {
  readonly status: ReferencePolicyStatus;
  readonly checkedAtMs: number;
  readonly primary?: ReferenceObservation;
  readonly crossCheck?: ReferenceObservation;
  /** The live Pyth feed is exposed separately so the review can show its source and session. */
  readonly pyth?: ReferenceObservation;
  readonly reason?: string;
}

export interface ReferencePolicyProvider {
  refresh(nowMs?: number): Promise<void>;
  snapshot(nowMs: number): ReferencePolicySnapshot;
}

export function evaluateReferencePolicy(
  observations: readonly ReferenceObservation[],
  nowMs: number,
  maxAgeMs = 15_000,
  maxAgreementBps = 50,
): ReferencePolicySnapshot {
  const [primary, crossCheck] = observations;
  const pyth = primary?.provider.startsWith('pyth-pro:') ? primary : undefined;
  const fail = (status: ReferencePolicyStatus, reason: string): ReferencePolicySnapshot => ({
    status,
    checkedAtMs: nowMs,
    ...(primary ? { primary } : {}),
    ...(crossCheck ? { crossCheck } : {}),
    ...(pyth ? { pyth } : {}),
    reason,
  });
  if (!Number.isSafeInteger(nowMs) || !primary || !primary.licensedPrimary) return fail('unavailable', 'licensed primary observation is required');
  if (primary.corporateActionPending) return fail('corporate_action_pending', 'corporate action review is pending');
  if (!primary.sessionOpen) return fail('market_closed', 'primary reference market session is closed');
  if (!isFreshObservation(primary, nowMs, maxAgeMs)) return fail('stale', 'primary reference observation is stale or malformed');
  if (!crossCheck || primary.provider === crossCheck.provider) return fail('unavailable', 'a separate independent cross-check is required');
  if (crossCheck.corporateActionPending) return fail('corporate_action_pending', 'corporate action review is pending');
  if (!crossCheck.sessionOpen) return fail('market_closed', 'cross-check market session is closed');
  if (!isFreshObservation(crossCheck, nowMs, maxAgeMs)) return fail('stale', 'cross-check reference observation is stale or malformed');
  const a = BigInt(primary.priceAtomic); const b = BigInt(crossCheck.priceAtomic);
  const difference = a > b ? a - b : b - a;
  if (difference * 10_000n > (a < b ? a : b) * BigInt(maxAgreementBps)) return fail('conflicting', 'primary and cross-check observations exceed agreement tolerance');
  return { status: 'ready', checkedAtMs: nowMs, primary, crossCheck, ...(pyth ? { pyth } : {}) };
}

function isFreshObservation(item: ReferenceObservation, nowMs: number, maxAgeMs: number): boolean {
  return Number.isSafeInteger(item.observedAtMs)
    && item.observedAtMs >= 0
    && item.observedAtMs <= nowMs
    && nowMs - item.observedAtMs <= maxAgeMs
    && /^[1-9][0-9]*$/.test(item.priceAtomic);
}

/** Deterministic non-DEX fixture for localnet/devnet only. */
export function localReferencePolicySnapshot(nowMs: number): ReferencePolicySnapshot {
  const observations: ReferenceObservation[] = [
    { provider: 'fixture-licensed-primary', licensedPrimary: true, priceAtomic: '100000000', observedAtMs: nowMs, sessionOpen: true, corporateActionPending: false },
    { provider: 'fixture-independent-cross-check', licensedPrimary: false, priceAtomic: '100020000', observedAtMs: nowMs, sessionOpen: true, corporateActionPending: false },
  ];
  return evaluateReferencePolicy(observations, nowMs);
}
