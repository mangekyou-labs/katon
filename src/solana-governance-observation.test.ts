import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { encodeBase58 } from '../packages/solana-core/src/base58';
import type { ProvisionedRoleIdentity } from '../apps/solana-api/src/roles';
import { governedMakerIds } from '../apps/solana-api/src/governance-observation';

const wallet = (byte: number) => encodeBase58(Buffer.alloc(32, byte));
const maker: ProvisionedRoleIdentity = { publicKey: wallet(14), role: 'maker', makerId: 'maker-7' };
const [makerRegistryPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('makers')], new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib'),
);
const makerRegistryAddress = makerRegistryPda.toBase58();

function evidence(options: {
  allowlisted?: string[];
  paused?: boolean;
  changeDelaySeconds?: string;
  vault?: string;
  squadsVault?: string;
  programEvidenceObserved?: boolean;
  cluster?: string;
  programPaused?: boolean;
  pausesStatus?: string;
  queued?: unknown[];
  applied?: unknown;
  registryVersion?: string;
  registryAddress?: string;
} = {}) {
  const {
    allowlisted = [maker.publicKey], paused = false, changeDelaySeconds = '86400', vault = wallet(1),
    squadsVault = vault, programEvidenceObserved = true, cluster = 'localnet', programPaused = false,
    pausesStatus = 'observed', queued = [], registryVersion = '3', registryAddress = makerRegistryAddress,
  } = options;
  const applied = options.applied === undefined ? {
    proposalId: '01'.repeat(32), payloadHash: '02'.repeat(32), target: registryAddress,
    expectedVersion: '2', proposingVault: vault, createdAt: '100', applyAfter: '86500', appliedAt: '86501',
    allowlisted, paused: false, registryVersion,
  } : options.applied;
  const observation = (value: unknown, status = 'observed') => ({ status, ...(status === 'observed' ? { value } : { reason: 'not observed' }) });
  return {
    onChain: {
      status: 'observed',
      registry: observation({ makers: [{ address: registryAddress, allowlisted, paused, registryVersion, lastApplied: applied }] }),
      pauses: observation({ program: programPaused }, pausesStatus),
      governanceChanges: observation({ governance: { squadsVault, programPaused, changeDelaySeconds }, queued }),
    },
    programEvidence: {
      status: programEvidenceObserved ? 'observed' : 'unavailable',
      ...(programEvidenceObserved ? { value: {
        manifest: observation({ signatureVerified: true, cluster }),
        rfqProgram: observation({ programId: wallet(2) }),
        squadsProgram: observation({ programId: wallet(3) }),
        squads: observation({ programId: wallet(3), vaultAddress: vault }),
      } } : { reason: 'manifest is not verified' }),
    },
  } as never;
}

describe('governed Private Maker enablement', () => {
  it('requires exact source provenance from a delayed applied Maker action', () => {
    expect(governedMakerIds(evidence(), [maker], 'localnet')).toEqual(new Set(['maker-7']));
    expect(governedMakerIds(evidence({ applied: null }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ allowlisted: [wallet(15)] }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ allowlisted: [], queued: [{ actionVariant: 1 }] }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ changeDelaySeconds: '86399' }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ paused: true }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ programPaused: true }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ pausesStatus: 'unavailable' }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ squadsVault: wallet(9) }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ programEvidenceObserved: false }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ cluster: 'devnet' }), [maker], 'localnet')).toEqual(new Set());
  });

  it('rejects provenance for a different key, vault, target, version, pause state, or delay', () => {
    const action = {
      proposalId: '01'.repeat(32), payloadHash: '02'.repeat(32), target: makerRegistryAddress,
      expectedVersion: '2', proposingVault: wallet(1), createdAt: '100', applyAfter: '86500', appliedAt: '86501',
      allowlisted: [maker.publicKey], paused: false, registryVersion: '3',
    };
    expect(governedMakerIds(evidence({ applied: { ...action, allowlisted: [wallet(15)] } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, proposingVault: wallet(9) } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, target: wallet(9) } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, expectedVersion: '1' } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, registryVersion: '4' } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, paused: true } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, applyAfter: '86499' } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, appliedAt: '86499' } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, proposalId: '00'.repeat(32) } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, payloadHash: '0'.repeat(64) } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, expectedVersion: '02' } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ applied: { ...action, allowlisted: [maker.publicKey, wallet(15)] } }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ registryVersion: '4' }), [maker], 'localnet')).toEqual(new Set());
    expect(governedMakerIds(evidence({ registryAddress: wallet(30) }), [maker], 'localnet')).toEqual(new Set());
  });
});
