export interface NavProof {
  readonly requestDigest: string;
  readonly proofOwner: string;
  readonly asset: string;
  readonly scaledValue: bigint;
  readonly decimals: number;
  readonly sourceId: string;
  readonly asOf: number;
  readonly validUntil: number;
  readonly merkleProofValid: boolean;
}

export class NavProofRegistry {
  private readonly records = new Map<string, NavProof>();
  private readonly requests = new Set<string>();

  accept(proof: NavProof, caller: string): NavProof {
    if (caller !== proof.proofOwner) throw new Error('PROOF_OWNER');
    if (this.requests.has(proof.requestDigest)) throw new Error('PROOF_REPLAY');
    if (!proof.merkleProofValid) throw new Error('PROOF_INVALID');
    if (
      !proof.requestDigest || !proof.asset || !proof.proofOwner || !proof.sourceId ||
      !Number.isInteger(proof.asOf) || proof.asOf < 0 ||
      !Number.isInteger(proof.validUntil) || proof.validUntil < proof.asOf
    ) {
      throw new Error('PROOF_SCHEMA');
    }
    if (proof.scaledValue <= 0n || !Number.isInteger(proof.decimals) || proof.decimals < 0 || proof.decimals > 36) {
      throw new Error('PROOF_VALUE');
    }
    const previous = this.records.get(proof.asset);
    if (previous && proof.asOf <= previous.asOf) throw new Error('NAV_NOT_MONOTONIC');
    this.requests.add(proof.requestDigest);
    this.records.set(proof.asset, proof);
    return proof;
  }

  latest(asset: string): NavProof | undefined {
    return this.records.get(asset);
  }
}

export interface FtsoFeed {
  readonly feedId: string;
  readonly value: bigint;
  readonly decimals: number;
  readonly timestamp: number;
}

export interface FtsoRiskPolicy {
  readonly feedIds: readonly string[];
  readonly maxAgeSeconds: number;
  readonly maxDeviationBps: bigint;
}

export function normalizeFtsoPrice(value: bigint, decimals: number, targetDecimals = 18): bigint {
  if (decimals < -36 || decimals > 36 || targetDecimals < 0 || targetDecimals > 36) {
    throw new Error('FTSO_DECIMALS');
  }
  // FTSO's signed decimal is the exponent applied to the raw value. To move
  // raw `value * 10^decimals` to the target scale, use target + decimals.
  const exponent = targetDecimals + decimals;
  if (exponent >= 0) return value * 10n ** BigInt(exponent);
  return value / 10n ** BigInt(-exponent);
}

export class FtsoRiskGuard {
  private readonly feedIds: ReadonlySet<string>;
  private readonly policy: FtsoRiskPolicy;

  constructor(policy: FtsoRiskPolicy) {
    if (
      policy.feedIds.length === 0 || policy.feedIds.some((feedId) => !feedId.trim()) ||
      !Number.isInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds < 0 ||
      policy.maxDeviationBps < 0n || policy.maxDeviationBps > 10_000n
    ) {
      throw new Error('FTSO_POLICY');
    }
    this.policy = policy;
    this.feedIds = new Set(policy.feedIds);
  }

  assertUsable(feed: FtsoFeed, nowSeconds: number, referenceValue: bigint): bigint {
    if (!this.feedIds.has(feed.feedId)) throw new Error('FTSO_FEED_UNSUPPORTED');
    if (referenceValue <= 0n) throw new Error('FTSO_REFERENCE');
    if (feed.timestamp > nowSeconds || nowSeconds - feed.timestamp > this.policy.maxAgeSeconds) {
      throw new Error('FTSO_STALE');
    }
    if (feed.value <= 0n) throw new Error('FTSO_VALUE');
    const normalized = normalizeFtsoPrice(feed.value, feed.decimals);
    const reference = normalizeFtsoPrice(referenceValue, feed.decimals);
    const deviation = (normalized > reference ? normalized - reference : reference - normalized) * 10_000n;
    if (reference === 0n || deviation / reference > this.policy.maxDeviationBps) {
      throw new Error('FTSO_DEVIATION');
    }
    return normalized;
  }
}
