import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { encodeBase58 } from '@katon/solana-core';
import { SolanaOperatorEvidenceReader } from '../apps/solana-api/src/operator-evidence';
import { deploymentManifestPayload } from '../services/solana-liquidator/src/manifest';

const programId = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
const squadsProgramId = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const upgradeableLoaderId = 'BPFLoaderUpgradeab1e11111111111111111111111';
function disc(name: string): Buffer { return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8); }
function key(byte: number): Buffer { return Buffer.alloc(32, byte); }
function u64(value: bigint): Buffer { const data = Buffer.alloc(8); data.writeBigUInt64LE(value); return data; }
function i64(value: bigint): Buffer { const data = Buffer.alloc(8); data.writeBigInt64LE(value); return data; }
function u32(value: number): Buffer { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data; }
function u16(value: number): Buffer { const data = Buffer.alloc(2); data.writeUInt16LE(value); return data; }

function governanceAccount(vaultAddress = encodeBase58(key(1))): Buffer {
  return Buffer.concat([disc('GovernanceConfig'), new PublicKey(vaultAddress).toBuffer(), key(2), Buffer.from([0]), i64(86_400n), u64(4n), u16(10), u16(25), i64(30n), u64(99_000n)]);
}

function assetAccount({ badBoolean = false }: { badBoolean?: boolean } = {}): Buffer {
  return Buffer.concat([
    disc('AssetRegistry'), key(3), key(4), key(5), key(6), key(7), Buffer.from([0]), key(8), key(9), key(10),
    Buffer.from([0]), key(11), Buffer.from([6]), key(12), Buffer.from([0]), key(13), u32(0),
    Buffer.from([badBoolean ? 2 : 1, 0]), u64(7n),
  ]);
}

function makerAccount(lastApplied?: Buffer): Buffer {
  const encoded = Buffer.concat([disc('MakerRegistry'), u32(1), key(14), Buffer.from([0]), u64(3n), lastApplied ?? Buffer.from([0])]);
  return Buffer.concat([encoded, Buffer.alloc(4096 - encoded.length)]);
}
function appliedMakerAction(): Buffer {
  return Buffer.concat([
    Buffer.from([1]), key(20), key(21), key(22), u64(2n), key(1), i64(100n), i64(86_500n), i64(86_501n),
    u32(1), key(14), Buffer.from([0]), u64(3n),
  ]);
}
function queuedChange(): Buffer {
  return Buffer.concat([disc('QueuedGovernanceAction'), key(15), key(16), key(17), u64(2n), key(1), i64(100n), i64(86_500n), Buffer.from([4])]);
}

function rpcFetcher(accounts: Record<string, Buffer>, owner = programId, pubkey = encodeBase58(key(30)), accountInfos: Record<string, unknown> = {}): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let result: unknown;
    if (request.method === 'getProgramAccounts') {
      const options = request.params[1] as { filters: Array<{ memcmp: { bytes: string } }> };
      const discriminator = options.filters[0]!.memcmp.bytes;
      const match = Object.entries(accounts).find(([name]) => encodeBase58(disc(name)) === discriminator);
      result = match ? [{ pubkey, account: { owner, executable: false, data: [match[1].toString('base64'), 'base64'] } }] : [];
    } else if (request.method === 'getAccountInfo') {
      const address = String(request.params[0]);
      result = { context: { slot: 42 }, value: accountInfos[address] ?? null };
    } else {
      throw new Error(`unexpected RPC method ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.params[0], result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function accountInfo(owner: string, executable: boolean, data: Buffer): Record<string, unknown> {
  return { owner, executable, lamports: 1, data: [data.toString('base64'), 'base64'] };
}

function addUpgradeableProgram(
  accountInfos: Record<string, unknown>,
  identity: { programId: string; bytecodeSha256: string; upgradeAuthority: string },
): void {
  const programData = Keypair.generate().publicKey;
  const elf = Buffer.from(`verified-fixture:${identity.programId}`);
  accountInfos[identity.programId] = accountInfo(upgradeableLoaderId, true, Buffer.concat([u32(2), programData.toBuffer()]));
  accountInfos[programData.toBase58()] = identity.upgradeAuthority === 'immutable'
    ? accountInfo(upgradeableLoaderId, false, Buffer.concat([u32(3), u64(100n), Buffer.from([0]), elf]))
    : accountInfo(upgradeableLoaderId, false, Buffer.concat([
      u32(3), u64(100n), Buffer.from([1]), new PublicKey(identity.upgradeAuthority).toBuffer(), elf,
    ]));
  identity.bytecodeSha256 = createHash('sha256').update(elf).digest('hex');
}

function squadsAddresses(createKey: PublicKey, vaultIndex: number): { multisigAddress: string; vaultAddress: string } {
  const [multisig] = PublicKey.findProgramAddressSync(
    [Buffer.from('multisig'), Buffer.from('multisig'), createKey.toBuffer()],
    new PublicKey(squadsProgramId),
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('multisig'), multisig.toBuffer(), Buffer.from('vault'), Buffer.from([vaultIndex])],
    new PublicKey(squadsProgramId),
  );
  return { multisigAddress: multisig.toBase58(), vaultAddress: vault.toBase58() };
}

describe('validated read-only operator evidence', () => {
  it('projects observed registry, pause, and delayed queue data from Anchor-owned accounts', async () => {
    const reader = new SolanaOperatorEvidenceReader({
      rpcUrl: 'http://rpc.invalid', cluster: 'localnet', fetcher: rpcFetcher({
        AssetRegistry: assetAccount(), MakerRegistry: makerAccount(), GovernanceConfig: governanceAccount(), QueuedGovernanceAction: queuedChange(),
      }),
    });

    const evidence = await reader.read();
    expect(evidence.onChain.registry).toMatchObject({ status: 'observed', value: { assets: [{ issuer: 'xstocks', enabled: true, paused: false }], makers: [{ allowlisted: [encodeBase58(key(14))], allowlistedCount: 1, paused: false, lastApplied: null }] } });
    expect(evidence.onChain.pauses).toMatchObject({ status: 'observed', value: { program: false } });
    expect(evidence.onChain.governanceChanges).toMatchObject({ status: 'observed', value: { queued: [{ expectedVersion: '2', actionVariant: 4 }] } });
    expect(evidence.programEvidence).toMatchObject({ status: 'unavailable', reason: 'deployment manifest path is not configured' });
  });

  it('decodes the persisted applied Maker action separately from bootstrap allowlist state', async () => {
    const evidence = await new SolanaOperatorEvidenceReader({
      rpcUrl: 'http://rpc.invalid', cluster: 'localnet', fetcher: rpcFetcher({ MakerRegistry: makerAccount(appliedMakerAction()) }),
    }).read();
    expect(evidence.onChain.registry).toMatchObject({ status: 'observed', value: { makers: [{
      lastApplied: {
        proposalId: key(20).toString('hex'), payloadHash: key(21).toString('hex'), target: encodeBase58(key(22)),
        expectedVersion: '2', proposingVault: encodeBase58(key(1)), createdAt: '100', applyAfter: '86500', appliedAt: '86501',
        allowlisted: [encodeBase58(key(14))], paused: false, registryVersion: '3',
      },
    }] } });
  });

  it('fails closed on a wrong owner or malformed Anchor account data', async () => {
    const wrongOwner = await new SolanaOperatorEvidenceReader({
      rpcUrl: 'http://rpc.invalid', cluster: 'localnet', fetcher: rpcFetcher({ AssetRegistry: assetAccount() }, '11111111111111111111111111111111'),
    }).read();
    expect(wrongOwner.onChain.registry.status).toBe('unavailable');
    expect(wrongOwner.onChain.registry.reason).toMatch(/owner/);

    const malformed = await new SolanaOperatorEvidenceReader({
      rpcUrl: 'http://rpc.invalid', cluster: 'localnet', fetcher: rpcFetcher({ AssetRegistry: assetAccount({ badBoolean: true }) }),
    }).read();
    expect(malformed.onChain.registry.status).toBe('unavailable');
    expect(malformed.onChain.registry.reason).toMatch(/boolean/);

    const invalidAddress = await new SolanaOperatorEvidenceReader({
      rpcUrl: 'http://rpc.invalid', cluster: 'localnet', fetcher: rpcFetcher({ AssetRegistry: assetAccount() }, programId, 'not-a-public-key'),
    }).read();
    expect(invalidAddress.onChain.registry.status).toBe('unavailable');
    expect(invalidAddress.onChain.registry.reason).toMatch(/account address/);

    const nonZeroPadding = await new SolanaOperatorEvidenceReader({
      rpcUrl: 'http://rpc.invalid', cluster: 'localnet', fetcher: rpcFetcher({ MakerRegistry: Buffer.concat([makerAccount(), Buffer.from([1])]) }),
    }).read();
    expect(nonZeroPadding.onChain.registry.status).toBe('unavailable');
    expect(nonZeroPadding.onChain.registry.reason).toMatch(/non-zero trailing bytes/);
  });

  it('reports explicit unavailable states when the RPC or cluster is absent', async () => {
    const evidence = await new SolanaOperatorEvidenceReader({ rpcUrl: '', cluster: 'mainnet' }).read();
    expect(evidence.onChain.registry).toMatchObject({ status: 'unavailable', reason: 'Solana RPC reader is not configured' });
    expect(evidence.onChain.pauses.status).toBe('unavailable');
    expect(evidence.onChain.governanceChanges.status).toBe('unavailable');
    expect(evidence.programEvidence.status).toBe('unavailable');
  });

  it('validates a trusted signature and explains which signed Seller Desk identity is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'katon-operator-manifest-'));
    try {
      const pair = generateKeyPairSync('ed25519');
      const signerPublicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      const unsigned = {
        cluster: 'devnet' as const,
        generatedAt: '2026-09-23T00:00:00.000Z',
        programs: (['kamino', 'jupiter-lend', 'jupiter-flashloan'] as const).map((name) => ({
          name,
          programId: encodeBase58(key(name.length)),
          idlSha256: 'a'.repeat(64),
          bytecodeSha256: 'b'.repeat(64),
          upgradeAuthority: encodeBase58(key(name.length + 10)),
        })),
        enabledStockMints: [],
      };
      const manifest = {
        ...unsigned,
        signatureAlgorithm: 'ed25519' as const,
        signerPublicKey,
        signature: sign(null, Buffer.from(deploymentManifestPayload(unsigned)), pair.privateKey).toString('base64'),
      };
      const manifestPath = join(directory, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest));
      const trusted = await new SolanaOperatorEvidenceReader({
        cluster: 'devnet', manifestPath, trustedManifestSigners: [signerPublicKey],
      }).read();
      expect(trusted.programEvidence).toMatchObject({
        status: 'unavailable',
        reason: expect.stringMatching(/Seller Desk/),
        value: { manifest: { status: 'observed' }, rfqProgram: { status: 'unavailable' }, squadsProgram: { status: 'unavailable' }, squads: { status: 'unavailable' } },
      });

      const tampered = await new SolanaOperatorEvidenceReader({
        cluster: 'devnet', manifestPath, trustedManifestSigners: [signerPublicKey + 'x'],
      }).read();
      expect(tampered.programEvidence).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/not an approved governance key/) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('matches signed RFQ and lender identities to live executable hashes, authorities, and the Squads vault', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'katon-operator-live-manifest-'));
    try {
      const pair = generateKeyPairSync('ed25519');
      const signerPublicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      const accountInfos: Record<string, unknown> = {};
      const programs = (['kamino', 'jupiter-lend', 'jupiter-flashloan'] as const).map((name) => ({
        name,
        programId: Keypair.generate().publicKey.toBase58(),
        idlSha256: 'a'.repeat(64),
        bytecodeSha256: '',
        upgradeAuthority: Keypair.generate().publicKey.toBase58(),
      }));
      const rfqProgram = {
        programId,
        idlSha256: 'c'.repeat(64),
        bytecodeSha256: '',
        upgradeAuthority: Keypair.generate().publicKey.toBase58(),
      };
      const squadsProgram = {
        programId: squadsProgramId,
        idlSha256: 'd'.repeat(64),
        bytecodeSha256: '',
        upgradeAuthority: Keypair.generate().publicKey.toBase58(),
      };
      for (const identity of [...programs, rfqProgram, squadsProgram]) addUpgradeableProgram(accountInfos, identity);

      const createKey = Keypair.generate().publicKey;
      const vaultIndex = 0;
      const { multisigAddress, vaultAddress } = squadsAddresses(createKey, vaultIndex);
      accountInfos[multisigAddress] = accountInfo(squadsProgramId, false, Buffer.concat([disc('Multisig'), createKey.toBuffer(), Buffer.alloc(32)]));

      const unsigned = {
        cluster: 'devnet' as const,
        generatedAt: '2026-09-23T00:00:00.000Z',
        programs,
        enabledStockMints: [],
        sellerDesk: {
          rfqProgram,
          squadsProgram,
          governance: { squadsProgramId, multisigAddress, createKey: createKey.toBase58(), vaultIndex, vaultAddress },
        },
      };
      const manifest = {
        ...unsigned,
        signatureAlgorithm: 'ed25519' as const,
        signerPublicKey,
        signature: sign(null, Buffer.from(deploymentManifestPayload(unsigned)), pair.privateKey).toString('base64'),
      };
      const manifestPath = join(directory, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest));
      const evidence = await new SolanaOperatorEvidenceReader({
        rpcUrl: 'http://rpc.invalid', cluster: 'devnet', manifestPath, trustedManifestSigners: [signerPublicKey],
        fetcher: rpcFetcher({ GovernanceConfig: governanceAccount(vaultAddress) }, programId, encodeBase58(key(30)), accountInfos),
      }).read();

      expect(evidence.programEvidence).toMatchObject({ status: 'observed' });
      expect(evidence.programEvidence.value).toMatchObject({
        manifest: { status: 'observed', value: { signatureVerified: true, cluster: 'devnet' } },
        rfqProgram: { status: 'observed', value: { programId, bytecodeSha256: rfqProgram.bytecodeSha256, upgradeAuthority: rfqProgram.upgradeAuthority } },
        squadsProgram: { status: 'observed', value: { programId: squadsProgramId, bytecodeSha256: squadsProgram.bytecodeSha256, upgradeAuthority: squadsProgram.upgradeAuthority } },
        lenderPrograms: [
          { name: 'kamino', status: 'observed' },
          { name: 'jupiter-lend', status: 'observed' },
          { name: 'jupiter-flashloan', status: 'observed' },
        ],
        squads: { status: 'observed', value: { programId: squadsProgramId, multisigAddress, vaultAddress, vaultIndex } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a trusted manifest unavailable when live bytecode, upgrade authority, or Squads vault identity differs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'katon-operator-mismatch-'));
    try {
      const pair = generateKeyPairSync('ed25519');
      const signerPublicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      const accountInfos: Record<string, unknown> = {};
      const programs = (['kamino', 'jupiter-lend', 'jupiter-flashloan'] as const).map((name) => ({
        name, programId: Keypair.generate().publicKey.toBase58(), idlSha256: 'a'.repeat(64), bytecodeSha256: '',
        upgradeAuthority: Keypair.generate().publicKey.toBase58(),
      }));
      for (const identity of programs) addUpgradeableProgram(accountInfos, identity);
      const rfqProgram = { programId, idlSha256: 'c'.repeat(64), bytecodeSha256: 'f'.repeat(64), upgradeAuthority: Keypair.generate().publicKey.toBase58() };
      addUpgradeableProgram(accountInfos, { ...rfqProgram, bytecodeSha256: '' });
      const squadsProgram = { programId: squadsProgramId, idlSha256: 'd'.repeat(64), bytecodeSha256: '', upgradeAuthority: Keypair.generate().publicKey.toBase58() };
      addUpgradeableProgram(accountInfos, squadsProgram);
      squadsProgram.upgradeAuthority = Keypair.generate().publicKey.toBase58();
      const createKey = Keypair.generate().publicKey;
      const vaultIndex = 0;
      const addresses = squadsAddresses(createKey, vaultIndex);
      const unsigned = {
        cluster: 'devnet' as const,
        generatedAt: '2026-09-23T00:00:00.000Z',
        programs,
        enabledStockMints: [],
        sellerDesk: { rfqProgram, squadsProgram, governance: { squadsProgramId, ...addresses, createKey: createKey.toBase58(), vaultIndex } },
      };
      const manifest = {
        ...unsigned,
        signatureAlgorithm: 'ed25519' as const,
        signerPublicKey,
        signature: sign(null, Buffer.from(deploymentManifestPayload(unsigned)), pair.privateKey).toString('base64'),
      };
      const manifestPath = join(directory, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest));
      const evidence = await new SolanaOperatorEvidenceReader({
        rpcUrl: 'http://rpc.invalid', cluster: 'devnet', manifestPath, trustedManifestSigners: [signerPublicKey],
        fetcher: rpcFetcher({ GovernanceConfig: governanceAccount(encodeBase58(key(1))) }, programId, encodeBase58(key(30)), accountInfos),
      }).read();
      expect(evidence.programEvidence.status).toBe('unavailable');
      expect(evidence.programEvidence.value).toMatchObject({
        rfqProgram: { status: 'unavailable', reason: expect.stringMatching(/bytecode hash/) },
        squadsProgram: { status: 'unavailable', reason: expect.stringMatching(/upgrade authority/) },
        squads: { status: 'unavailable', reason: expect.stringMatching(/governance vault/) },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
