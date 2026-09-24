import { PublicKey } from '@solana/web3.js';
import type { OperatorEvidence } from './operator-evidence';
import type { ProvisionedRoleIdentity } from './roles';

const RFQ_PROGRAM_ID = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
const MIN_GOVERNANCE_DELAY_SECONDS = 86_400n;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Projects active maker IDs only from the effective on-chain registry state.
 * A queued action is deliberately insufficient: the exact key must already
 * be present in the unpaused registry after the delayed Squads vault applies it.
 */
export function governedMakerIds(
  evidence: OperatorEvidence,
  identities: readonly ProvisionedRoleIdentity[],
  cluster: string,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (evidence.onChain.status !== 'observed'
    || evidence.onChain.registry.status !== 'observed'
    || evidence.onChain.pauses.status !== 'observed'
    || evidence.onChain.governanceChanges.status !== 'observed'
    || evidence.programEvidence.status !== 'observed') return result;

  const pauses = record(evidence.onChain.pauses.value);
  if (pauses?.program !== false) return result;

  const registry = record(evidence.onChain.registry.value);
  const makers = registry?.makers;
  if (!Array.isArray(makers) || makers.length !== 1) return result;
  const makerRegistry = record(makers[0]);
  if (!makerRegistry || makerRegistry.paused !== false || !Array.isArray(makerRegistry.allowlisted)
    || makerRegistry.allowlisted.some((key) => typeof key !== 'string')) return result;

  let expectedMakerRegistryAddress: string;
  try {
    const [makerRegistryAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from('makers')], new PublicKey(RFQ_PROGRAM_ID),
    );
    expectedMakerRegistryAddress = makerRegistryAddress.toBase58();
  } catch { return result; }
  if (makerRegistry.address !== expectedMakerRegistryAddress) return result;

  const governanceChanges = record(evidence.onChain.governanceChanges.value);
  const governance = record(governanceChanges?.governance);
  if (!governance || governance.programPaused !== false || typeof governance.squadsVault !== 'string') return result;
  let delaySeconds: bigint;
  try {
    if (typeof governance.changeDelaySeconds !== 'string' || !/^[0-9]+$/.test(governance.changeDelaySeconds)) return result;
    delaySeconds = BigInt(governance.changeDelaySeconds);
  } catch { return result; }
  if (delaySeconds < MIN_GOVERNANCE_DELAY_SECONDS) return result;

  const applied = record(makerRegistry.lastApplied);
  if (!applied || typeof applied.proposalId !== 'string' || !/^[a-f0-9]{64}$/.test(applied.proposalId)
    || /^0+$/.test(applied.proposalId) || typeof applied.payloadHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(applied.payloadHash) || /^0+$/.test(applied.payloadHash)
    || applied.target !== makerRegistry.address || applied.proposingVault !== governance.squadsVault
    || applied.paused !== false || !Array.isArray(applied.allowlisted)
    || applied.allowlisted.some((key) => typeof key !== 'string')) return result;

  let expectedVersion: bigint;
  let appliedRegistryVersion: bigint;
  let currentRegistryVersion: bigint;
  let createdAt: bigint;
  let applyAfter: bigint;
  let appliedAt: bigint;
  try {
    if (typeof applied.expectedVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(applied.expectedVersion)
      || typeof applied.registryVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(applied.registryVersion)
      || typeof makerRegistry.registryVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(makerRegistry.registryVersion)
      || typeof applied.createdAt !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(applied.createdAt)
      || typeof applied.applyAfter !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(applied.applyAfter)
      || typeof applied.appliedAt !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(applied.appliedAt)) return result;
    expectedVersion = BigInt(applied.expectedVersion);
    appliedRegistryVersion = BigInt(applied.registryVersion);
    currentRegistryVersion = BigInt(makerRegistry.registryVersion);
    createdAt = BigInt(applied.createdAt);
    applyAfter = BigInt(applied.applyAfter);
    appliedAt = BigInt(applied.appliedAt);
  } catch { return result; }
  if (expectedVersion + 1n !== appliedRegistryVersion || appliedRegistryVersion !== currentRegistryVersion
    || applyAfter - createdAt < MIN_GOVERNANCE_DELAY_SECONDS || appliedAt < applyAfter) return result;
  const currentAllowlist = makerRegistry.allowlisted as string[];
  const appliedAllowlist = applied.allowlisted as string[];
  if (currentAllowlist.length !== appliedAllowlist.length
    || currentAllowlist.some((key, index) => key !== appliedAllowlist[index])) return result;

  const programs = record(evidence.programEvidence.value);
  const manifest = record(record(programs?.manifest)?.value);
  const rfqProgram = record(programs?.rfqProgram);
  const squadsProgram = record(programs?.squadsProgram);
  const squads = record(programs?.squads);
  const squadsIdentity = record(squads?.value);
  const squadsProgramIdentity = record(squadsProgram?.value);
  if (manifest?.signatureVerified !== true || manifest.cluster !== cluster
    || rfqProgram?.status !== 'observed' || squadsProgram?.status !== 'observed' || squads?.status !== 'observed'
    || typeof governance.squadsVault !== 'string'
    || squadsIdentity?.vaultAddress !== governance.squadsVault
    || squadsIdentity.programId !== squadsProgramIdentity?.programId) return result;

  const allowlisted = new Set(currentAllowlist);
  for (const identity of identities) {
    if (identity.role === 'maker' && identity.makerId && allowlisted.has(identity.publicKey)) result.add(identity.makerId);
  }
  return result;
}
