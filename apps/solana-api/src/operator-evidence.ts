import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';
import { encodeBase58 } from '@katon/solana-core';
import type { DeploymentIdentity, DeploymentManifest, ProgramManifestEntry, SellerDeskManifest } from '../../../services/solana-liquidator/src/manifest';

const PROGRAM_ID = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
const UPGRADEABLE_LOADER_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const SQUADS_V4_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ANCHOR_DISCRIMINATORS = {
  AssetRegistry: discriminator('account:AssetRegistry'),
  MakerRegistry: discriminator('account:MakerRegistry'),
  GovernanceConfig: discriminator('account:GovernanceConfig'),
  QueuedGovernanceAction: discriminator('account:QueuedGovernanceAction'),
} as const;

function discriminator(value: string): Buffer {
  return createHash('sha256').update(value).digest().subarray(0, 8);
}

export interface EvidenceValue<T = unknown> {
  readonly status: 'observed' | 'unavailable';
  readonly reason?: string;
  readonly observedAt?: string;
  readonly value?: T;
}

interface ProgramRuntimeObservation {
  readonly programId: string;
  readonly idlSha256: string;
  readonly bytecodeSha256: string;
  readonly upgradeAuthority: string;
}

type LenderProgramObservation = EvidenceValue<ProgramRuntimeObservation> & { readonly name: string };

interface ProgramEvidenceDetails {
  readonly manifest: EvidenceValue<{ readonly signatureVerified: true; readonly cluster: string; readonly signerPublicKey: string }>;
  readonly lenderPrograms: readonly LenderProgramObservation[];
  readonly rfqProgram: EvidenceValue<ProgramRuntimeObservation>;
  readonly squadsProgram: EvidenceValue<ProgramRuntimeObservation>;
  readonly squads: EvidenceValue<{ readonly programId: string; readonly multisigAddress: string; readonly createKey: string; readonly vaultAddress: string; readonly vaultIndex: number; readonly vaultAccount: 'observed' | 'uninitialized-derived-pda' }>;
}

export interface OperatorEvidence {
  readonly onChain: {
    readonly status: 'observed' | 'unavailable';
    readonly registry: EvidenceValue;
    readonly pauses: EvidenceValue;
    readonly governanceChanges: EvidenceValue;
  };
  readonly programEvidence: EvidenceValue<ProgramEvidenceDetails>;
}

interface RpcAccount {
  readonly pubkey: string;
  readonly account: {
    readonly owner: string;
    readonly executable: boolean;
    readonly data: readonly [string, string];
  };
}

interface RpcResponse<T> {
  readonly result?: T;
  readonly error?: { readonly message?: string };
}

interface RpcAccountInfo {
  readonly owner: string;
  readonly executable: boolean;
  readonly data: readonly [string, string];
}

interface RpcAccountInfoResult {
  readonly context?: { readonly slot?: number };
  readonly value: RpcAccountInfo | null;
}

interface ObservedProgramIdentity {
  readonly programId: string;
  readonly bytecodeSha256: string;
  readonly upgradeAuthority: string;
}

class ReaderError extends Error {}

const LENDER_NAMES = ['kamino', 'jupiter-lend', 'jupiter-flashloan'] as const;

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('non-canonical');
    return key;
  } catch {
    throw new ReaderError(`${label} is not a canonical Solana address`);
  }
}

function parseDeploymentIdentity(value: unknown, label: string): DeploymentIdentity {
  const record = expectRecord(value, label);
  if (Object.keys(record).some((key) => !['programId', 'idlSha256', 'bytecodeSha256', 'upgradeAuthority'].includes(key))
    || typeof record.programId !== 'string'
    || typeof record.idlSha256 !== 'string'
    || typeof record.bytecodeSha256 !== 'string'
    || typeof record.upgradeAuthority !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.idlSha256)
    || !/^[a-f0-9]{64}$/.test(record.bytecodeSha256)) throw new ReaderError(`${label} identity schema is invalid`);
  canonicalPublicKey(record.programId, `${label} program ID`);
  if (record.upgradeAuthority !== 'immutable') canonicalPublicKey(record.upgradeAuthority, `${label} upgrade authority`);
  return {
    programId: record.programId,
    idlSha256: record.idlSha256,
    bytecodeSha256: record.bytecodeSha256,
    upgradeAuthority: record.upgradeAuthority,
  };
}

function parseDeploymentManifest(value: unknown): DeploymentManifest {
  const record = expectRecord(value, 'deployment manifest');
  const allowed = ['cluster', 'generatedAt', 'programs', 'enabledStockMints', 'sellerDesk', 'signatureAlgorithm', 'signerPublicKey', 'signature'];
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || !['mainnet-beta', 'devnet', 'localnet'].includes(String(record.cluster))
    || typeof record.generatedAt !== 'string'
    || !Array.isArray(record.programs)
    || !Array.isArray(record.enabledStockMints)
    || record.enabledStockMints.some((mint) => typeof mint !== 'string')
    || record.signatureAlgorithm !== 'ed25519'
    || typeof record.signerPublicKey !== 'string'
    || typeof record.signature !== 'string') throw new ReaderError('deployment manifest schema is invalid');

  const programs = record.programs.map((value) => {
    const item = expectRecord(value, 'program manifest entry');
    if (!LENDER_NAMES.includes(item.name as typeof LENDER_NAMES[number])) throw new ReaderError('deployment manifest contains an unsupported program name');
    return { name: item.name as ProgramManifestEntry['name'], ...parseDeploymentIdentity({
      programId: item.programId, idlSha256: item.idlSha256, bytecodeSha256: item.bytecodeSha256, upgradeAuthority: item.upgradeAuthority,
    }, `${String(item.name)} program`) };
  });

  let sellerDesk: SellerDeskManifest | undefined;
  if (record.sellerDesk !== undefined) {
    const seller = expectRecord(record.sellerDesk, 'Seller Desk manifest');
    if (Object.keys(seller).some((key) => !['rfqProgram', 'squadsProgram', 'governance'].includes(key))) throw new ReaderError('Seller Desk manifest schema is invalid');
    const governance = expectRecord(seller.governance, 'Seller Desk governance identity');
    if (Object.keys(governance).some((key) => !['squadsProgramId', 'multisigAddress', 'createKey', 'vaultIndex', 'vaultAddress'].includes(key))
      || typeof governance.squadsProgramId !== 'string'
      || typeof governance.multisigAddress !== 'string'
      || typeof governance.createKey !== 'string'
      || !Number.isSafeInteger(governance.vaultIndex)
      || (governance.vaultIndex as number) < 0 || (governance.vaultIndex as number) > 255
      || typeof governance.vaultAddress !== 'string') throw new ReaderError('Seller Desk governance identity schema is invalid');
    for (const [key, value] of Object.entries(governance)) if (key !== 'vaultIndex') canonicalPublicKey(value as string, `Seller Desk ${key}`);
    sellerDesk = {
      rfqProgram: parseDeploymentIdentity(seller.rfqProgram, 'RFQ program'),
      squadsProgram: parseDeploymentIdentity(seller.squadsProgram, 'Squads v4 program'),
      governance: {
        squadsProgramId: governance.squadsProgramId,
        multisigAddress: governance.multisigAddress,
        createKey: governance.createKey,
        vaultIndex: governance.vaultIndex as number,
        vaultAddress: governance.vaultAddress,
      },
    };
  }

  return {
    cluster: record.cluster as DeploymentManifest['cluster'],
    generatedAt: record.generatedAt,
    programs,
    enabledStockMints: record.enabledStockMints as string[],
    ...(sellerDesk === undefined ? {} : { sellerDesk }),
    signatureAlgorithm: 'ed25519',
    signerPublicKey: record.signerPublicKey,
    signature: record.signature,
  };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ReaderError(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function accountBytes(account: RpcAccount): Buffer {
  if (account.account.owner !== PROGRAM_ID || account.account.executable || !Array.isArray(account.account.data) || account.account.data[1] !== 'base64') {
    throw new ReaderError('account owner, executable flag, or data encoding is invalid');
  }
  const [encoded] = account.account.data;
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new ReaderError('account data is not canonical base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new ReaderError('account data is not canonical base64');
  return bytes;
}

class Cursor {
  private offset = 8;
  constructor(private readonly data: Buffer) {}
  get remaining(): number { return this.data.length - this.offset; }
  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.remaining < length) throw new ReaderError('account data is truncated');
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  u8(): number { return this.bytes(1)[0]!; }
  u16(): number { return this.bytes(2).readUInt16LE(0); }
  u32(): number { return this.bytes(4).readUInt32LE(0); }
  u64(): string { return this.bytes(8).readBigUInt64LE(0).toString(); }
  i64(): string { return this.bytes(8).readBigInt64LE(0).toString(); }
  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new ReaderError('account boolean is invalid');
    return value === 1;
  }
  pubkey(): string { return encodeBase58(this.bytes(32)); }
  optionPubkey(): string | null {
    const present = this.u8();
    if (present === 0) return null;
    if (present !== 1) throw new ReaderError('account option tag is invalid');
    return this.pubkey();
  }
  finish(): void {
    if (this.data.subarray(this.offset).some((byte) => byte !== 0)) throw new ReaderError('account data has non-zero trailing bytes');
    this.offset = this.data.length;
  }
}

function validatedCursor(account: RpcAccount, expected: Buffer): Cursor {
  const data = accountBytes(account);
  if (data.length < 8 || !data.subarray(0, 8).equals(expected)) throw new ReaderError('Anchor account discriminator is invalid');
  return new Cursor(data);
}

function parseGovernance(account: RpcAccount) {
  const cursor = validatedCursor(account, ANCHOR_DISCRIMINATORS.GovernanceConfig);
  const value = {
    squadsVault: cursor.pubkey(), guardian: cursor.pubkey(), programPaused: cursor.bool(),
    changeDelaySeconds: cursor.i64(), governanceVersion: cursor.u64(), feeBps: cursor.u16(),
    maxFeeBps: cursor.u16(), maxQuoteLifetimeSeconds: cursor.i64(), maxStockInputAtomic: cursor.u64(),
  };
  cursor.finish();
  return value;
}

function parseMakerRegistry(account: RpcAccount) {
  const cursor = validatedCursor(account, ANCHOR_DISCRIMINATORS.MakerRegistry);
  const count = cursor.u32();
  if (count > 64) throw new ReaderError('maker registry exceeds its maximum size');
  const allowlisted = Array.from({ length: count }, () => cursor.pubkey());
  const paused = cursor.bool();
  const registryVersion = cursor.u64();
  const appliedActionTag = cursor.u8();
  if (appliedActionTag > 1) throw new ReaderError('maker registry applied-action option tag is invalid');
  let lastApplied: {
    proposalId: string; payloadHash: string; target: string; expectedVersion: string; proposingVault: string;
    createdAt: string; applyAfter: string; appliedAt: string; allowlisted: string[]; paused: boolean; registryVersion: string;
  } | null = null;
  if (appliedActionTag === 1) {
    const proposalId = cursor.bytes(32).toString('hex');
    const payloadHash = cursor.bytes(32).toString('hex');
    const target = cursor.pubkey();
    const expectedVersion = cursor.u64();
    const proposingVault = cursor.pubkey();
    const createdAt = cursor.i64();
    const applyAfter = cursor.i64();
    const appliedAt = cursor.i64();
    const appliedMakerCount = cursor.u32();
    if (appliedMakerCount > 64) throw new ReaderError('applied maker action exceeds its maximum size');
    const appliedAllowlisted = Array.from({ length: appliedMakerCount }, () => cursor.pubkey());
    const appliedPaused = cursor.bool();
    const appliedRegistryVersion = cursor.u64();
    lastApplied = {
      proposalId, payloadHash, target, expectedVersion, proposingVault, createdAt, applyAfter, appliedAt,
      allowlisted: appliedAllowlisted, paused: appliedPaused, registryVersion: appliedRegistryVersion,
    };
  }
  cursor.finish();
  return { allowlisted, allowlistedCount: count, paused, registryVersion, lastApplied };
}

function parseAssetRegistry(account: RpcAccount) {
  const cursor = validatedCursor(account, ANCHOR_DISCRIMINATORS.AssetRegistry);
  const mint = cursor.pubkey();
  cursor.pubkey(); // token program
  cursor.pubkey(); // stable token program
  cursor.bytes(64); // stable outputs
  const issuer = cursor.u8();
  if (issuer > 1) throw new ReaderError('asset issuer enum is invalid');
  cursor.pubkey(); // metadata pointer
  cursor.pubkey(); // issuer authority
  cursor.bytes(32); // issuer authority fingerprint
  cursor.optionPubkey();
  cursor.bytes(32); // JIT capability fingerprint
  cursor.u8(); // decimals
  cursor.bytes(32); // extension fingerprint
  cursor.optionPubkey();
  cursor.bytes(32); // hook validation hash
  const hookCount = cursor.u32();
  if (hookCount > 16) throw new ReaderError('asset hook metadata exceeds its maximum size');
  cursor.bytes(hookCount * 67);
  const enabled = cursor.bool();
  const paused = cursor.bool();
  const registryVersion = cursor.u64();
  cursor.finish();
  return { mint, issuer: issuer === 0 ? 'xstocks' : 'ondo', enabled, paused, registryVersion };
}

function parseQueuedChange(account: RpcAccount) {
  const cursor = validatedCursor(account, ANCHOR_DISCRIMINATORS.QueuedGovernanceAction);
  const proposalId = cursor.bytes(32).toString('hex');
  const payloadHash = cursor.bytes(32).toString('hex');
  const target = cursor.pubkey();
  const expectedVersion = cursor.u64();
  const proposingVault = cursor.pubkey();
  const createdAt = cursor.i64();
  const applyAfter = cursor.i64();
  const actionVariant = cursor.u8();
  if (actionVariant > 4) throw new ReaderError('governance action enum is invalid');
  if (actionVariant === 0) { cursor.pubkey(); cursor.bool(); cursor.bool(); }
  else if (actionVariant === 1) {
    const count = cursor.u32();
    if (count > 64) throw new ReaderError('governance maker action exceeds its maximum size');
    for (let index = 0; index < count; index += 1) cursor.pubkey();
    cursor.bool();
  } else if (actionVariant === 2) { cursor.u16(); cursor.u16(); cursor.i64(); cursor.u64(); }
  else if (actionVariant === 3) { cursor.pubkey(); cursor.pubkey(); }
  cursor.finish();
  return { proposalId, payloadHash, target, expectedVersion, proposingVault, createdAt, applyAfter, actionVariant };
}

function unavailable<T = unknown>(reason: string, value?: T): EvidenceValue<T> { return { status: 'unavailable', reason, ...(value === undefined ? {} : { value }) }; }
function observed<T>(value: T): EvidenceValue<T> { return { status: 'observed', observedAt: new Date().toISOString(), value }; }
function unavailableProgram(reason: string): EvidenceValue<ProgramRuntimeObservation> { return unavailable<ProgramRuntimeObservation>(reason); }

function decodeRpcData(data: readonly [string, string], label: string): Buffer {
  if (!Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data[0])) {
    throw new ReaderError(`${label} data is not canonical base64`);
  }
  const bytes = Buffer.from(data[0], 'base64');
  if (bytes.toString('base64') !== data[0]) throw new ReaderError(`${label} data is not canonical base64`);
  return bytes;
}

function expectedSellerDeskEvidence(reason: string): NonNullable<OperatorEvidence['programEvidence']['value']> {
  return {
    manifest: unavailable(reason),
    lenderPrograms: LENDER_NAMES.map((name) => ({ name, ...unavailableProgram(reason) })),
    rfqProgram: unavailableProgram(reason),
    squadsProgram: unavailableProgram(reason),
    squads: unavailable(reason),
  };
}

function validateAccountAddress(value: string): void {
  if (!value || [...value].some((character) => !BASE58_ALPHABET.includes(character))) {
    throw new ReaderError('Solana RPC returned an invalid account address');
  }
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(BASE58_ALPHABET.indexOf(character));
  const decodedLength = number === 0n ? 0 : Math.ceil(number.toString(16).length / 2);
  const leadingZeroes = [...value].findIndex((character) => character !== '1');
  const byteLength = (leadingZeroes === -1 ? value.length : leadingZeroes) + decodedLength;
  if (byteLength !== 32) throw new ReaderError('Solana RPC returned an invalid account address');
}

export class SolanaOperatorEvidenceReader {
  constructor(
    private readonly options: {
      readonly rpcUrl?: string;
      readonly cluster?: string;
      readonly manifestPath?: string;
      readonly trustedManifestSigners?: readonly string[];
      readonly fetcher?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {}

  async read(): Promise<OperatorEvidence> {
    const onChain = await this.readAccounts();
    return { onChain, programEvidence: await this.readManifest(onChain) };
  }

  private async readAccounts(): Promise<OperatorEvidence['onChain']> {
    const { rpcUrl = '', cluster = '' } = this.options;
    if (!rpcUrl || !['localnet', 'devnet', 'mainnet-beta'].includes(cluster)) {
      const reason = !rpcUrl ? 'Solana RPC reader is not configured' : 'Solana cluster is not configured';
      return { status: 'unavailable', registry: unavailable(reason), pauses: unavailable(reason), governanceChanges: unavailable(reason) };
    }
    try {
      const [assets, makers, governance, changes] = await Promise.all([
        this.programAccounts('AssetRegistry'), this.programAccounts('MakerRegistry'),
        this.programAccounts('GovernanceConfig'), this.programAccounts('QueuedGovernanceAction'),
      ]);
      const assetRows = assets.map((account) => ({ address: account.pubkey, ...parseAssetRegistry(account) }));
      const makerRows = makers.map((account) => ({ address: account.pubkey, ...parseMakerRegistry(account) }));
      if (governance.length > 1) throw new ReaderError('more than one governance account was observed');
      const governanceRow = governance[0] ? { address: governance[0].pubkey, ...parseGovernance(governance[0]) } : undefined;
      const changeRows = changes.map((account) => ({ address: account.pubkey, ...parseQueuedChange(account) }));
      const observedAt = new Date().toISOString();
      return {
        status: 'observed',
        registry: { status: 'observed', observedAt, value: { assets: assetRows, makers: makerRows } },
        pauses: governanceRow ? { status: 'observed', observedAt, value: {
          program: governanceRow.programPaused,
          assets: assetRows.map(({ address, mint, paused }) => ({ address, mint, paused })),
          makers: makerRows.map(({ address, paused }) => ({ address, paused })),
        } } : unavailable('governance account is missing'),
        governanceChanges: { status: 'observed', observedAt, value: { governance: governanceRow ?? null, queued: changeRows } },
      };
    } catch (error) {
      const reason = error instanceof ReaderError ? error.message : 'Solana RPC account read failed';
      return { status: 'unavailable', registry: unavailable(reason), pauses: unavailable(reason), governanceChanges: unavailable(reason) };
    }
  }

  private async programAccounts(name: keyof typeof ANCHOR_DISCRIMINATORS): Promise<RpcAccount[]> {
    const discriminatorBytes = ANCHOR_DISCRIMINATORS[name];
    const response = await this.rpc<RpcAccount[]>('getProgramAccounts', [PROGRAM_ID, {
      encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: encodeBase58(discriminatorBytes) } }],
    }]);
    if (!Array.isArray(response) || response.length > 10_000) throw new ReaderError('Solana RPC returned an invalid account set');
    for (const account of response) {
      if (typeof account.pubkey !== 'string') throw new ReaderError('Solana RPC returned an invalid account address');
      validateAccountAddress(account.pubkey);
      validatedCursor(account, discriminatorBytes);
    }
    return response;
  }

  private async rpc<T>(method: string, params: readonly unknown[]): Promise<T> {
    const response = await (this.options.fetcher ?? fetch)(this.options.rpcUrl!, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'operator-evidence', method, params }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    });
    if (!response.ok) throw new ReaderError(`Solana RPC returned HTTP ${response.status}`);
    const payload = expectRecord(await response.json(), 'Solana RPC response') as RpcResponse<T>;
    if (payload.error) throw new ReaderError(payload.error.message ?? 'Solana RPC returned an error');
    if (payload.result === undefined) throw new ReaderError('Solana RPC response is missing result');
    return payload.result;
  }

  private async readManifest(onChain: OperatorEvidence['onChain']): Promise<OperatorEvidence['programEvidence']> {
    if (!this.options.manifestPath) {
      const reason = 'deployment manifest path is not configured';
      return unavailable(reason, expectedSellerDeskEvidence(reason));
    }

    let manifest: DeploymentManifest;
    try {
      manifest = parseDeploymentManifest(JSON.parse(await readFile(this.options.manifestPath, 'utf8')) as unknown);
    } catch (error) {
      const reason = error instanceof ReaderError ? error.message : 'deployment manifest could not be read';
      return unavailable(reason, expectedSellerDeskEvidence(reason));
    }

    const cluster = this.options.cluster;
    if (!cluster || !['localnet', 'devnet', 'mainnet-beta'].includes(cluster)) {
      const reason = 'Solana cluster is not configured';
      return unavailable(reason, expectedSellerDeskEvidence(reason));
    }
    if (manifest.cluster !== cluster) {
      const reason = 'deployment manifest cluster does not match the operator cluster';
      return unavailable(reason, expectedSellerDeskEvidence(reason));
    }

    const { verifyDeploymentManifest, verifyDeploymentManifestSignature } = await import('../../../services/solana-liquidator/src/manifest');
    const trustedSigners = this.options.trustedManifestSigners ?? [];
    const signatureCheck = verifyDeploymentManifestSignature(manifest, trustedSigners);
    if (!signatureCheck.ok) return unavailable(signatureCheck.message, expectedSellerDeskEvidence(signatureCheck.message));

    const manifestEvidence = observed({ signatureVerified: true as const, cluster, signerPublicKey: manifest.signerPublicKey });
    const rpcUnavailable = !this.options.rpcUrl ? 'Solana RPC reader is not configured' : undefined;
    const lenderPrograms: LenderProgramObservation[] = await Promise.all(manifest.programs.map(async (program): Promise<LenderProgramObservation> => ({
      name: program.name,
      ...(rpcUnavailable ? unavailableProgram(rpcUnavailable) : await this.observeProgram(program, `${program.name} program`)),
    })));
    for (const name of LENDER_NAMES) {
      if (!manifest.programs.some((program) => program.name === name)) {
        lenderPrograms.push({ name, ...unavailableProgram(`signed deployment manifest is missing ${name}`) });
      }
    }
    const lenderRuntime = lenderPrograms.flatMap((entry) => entry.status === 'observed' && entry.value ? [{
      name: entry.name as ProgramManifestEntry['name'],
      programId: entry.value.programId,
      idlSha256: entry.value.idlSha256,
      bytecodeSha256: entry.value.bytecodeSha256,
      upgradeAuthority: entry.value.upgradeAuthority,
    }] : []);
    const lenderCheck = verifyDeploymentManifest(manifest, lenderRuntime, [], cluster, trustedSigners);

    let rfqProgram: ProgramEvidenceDetails['rfqProgram'];
    if (!manifest.sellerDesk) {
      rfqProgram = unavailableProgram('signed deployment manifest is missing the Seller Desk RFQ program identity');
    } else if (rpcUnavailable) {
      rfqProgram = unavailableProgram(rpcUnavailable);
    } else if (manifest.sellerDesk.rfqProgram.programId !== PROGRAM_ID) {
      rfqProgram = unavailableProgram('signed Seller Desk RFQ program ID does not match the configured RFQ program');
    } else {
      rfqProgram = await this.observeProgram(manifest.sellerDesk.rfqProgram, 'RFQ program');
    }

    let squadsProgram: ProgramEvidenceDetails['squadsProgram'];
    if (!manifest.sellerDesk) {
      squadsProgram = unavailableProgram('signed deployment manifest is missing the Squads v4 program identity');
    } else if (rpcUnavailable) {
      squadsProgram = unavailableProgram(rpcUnavailable);
    } else if (manifest.sellerDesk.squadsProgram.programId !== SQUADS_V4_PROGRAM_ID
      || manifest.sellerDesk.governance.squadsProgramId !== manifest.sellerDesk.squadsProgram.programId) {
      squadsProgram = unavailableProgram('signed Squads v4 program ID does not match the canonical governance program ID');
    } else {
      squadsProgram = await this.observeProgram(manifest.sellerDesk.squadsProgram, 'Squads v4 program');
    }

    let squads: ProgramEvidenceDetails['squads'];
    if (!manifest.sellerDesk) {
      squads = unavailable('signed deployment manifest is missing the Squads v4 governance identity');
    } else if (rpcUnavailable) {
      squads = unavailable(rpcUnavailable);
    } else {
      squads = await this.observeSquads(manifest.sellerDesk, this.observedGovernanceVault(onChain));
    }

    const value = { manifest: manifestEvidence, lenderPrograms, rfqProgram, squadsProgram, squads };
    const reasons = [
      ...lenderPrograms.flatMap((entry) => entry.status === 'unavailable' ? [entry.reason ?? `${entry.name} program is unavailable`] : []),
      ...(!lenderCheck.ok ? [lenderCheck.message] : []),
      ...(rfqProgram.status === 'unavailable' ? [rfqProgram.reason ?? 'RFQ program evidence is unavailable'] : []),
      ...(squadsProgram.status === 'unavailable' ? [squadsProgram.reason ?? 'Squads v4 program evidence is unavailable'] : []),
      ...(squads.status === 'unavailable' ? [squads.reason ?? 'Squads governance evidence is unavailable'] : []),
    ];
    return reasons.length > 0
      ? unavailable([...new Set(reasons)].join('; '), value)
      : observed(value);
  }

  private async observeProgram(expected: DeploymentIdentity, label: string): Promise<EvidenceValue<ProgramRuntimeObservation>> {
    try {
      const actual = await this.readUpgradeableProgram(expected.programId);
      if (actual.bytecodeSha256 !== expected.bytecodeSha256) throw new ReaderError(`${label} bytecode hash does not match the signed manifest`);
      if (actual.upgradeAuthority !== expected.upgradeAuthority) throw new ReaderError(`${label} upgrade authority does not match the signed manifest`);
      return observed({
        programId: expected.programId,
        idlSha256: expected.idlSha256,
        bytecodeSha256: actual.bytecodeSha256,
        upgradeAuthority: actual.upgradeAuthority,
      });
    } catch (error) {
      return unavailableProgram(error instanceof ReaderError ? error.message : `${label} live identity could not be read`);
    }
  }

  private async readUpgradeableProgram(programId: string): Promise<ObservedProgramIdentity> {
    canonicalPublicKey(programId, 'program ID');
    const program = await this.readAccountInfo(programId);
    if (!program) throw new ReaderError('program account is missing');
    if (program.owner !== UPGRADEABLE_LOADER_ID || !program.executable) throw new ReaderError('program account is not an executable upgradeable-loader program');
    const programBytes = decodeRpcData(program.data, 'program account');
    if (programBytes.length !== 36 || programBytes.readUInt32LE(0) !== 2) throw new ReaderError('program account loader state is invalid');
    const programDataAddress = encodeBase58(programBytes.subarray(4, 36));
    const programData = await this.readAccountInfo(programDataAddress);
    if (!programData) throw new ReaderError('program data account is missing');
    if (programData.owner !== UPGRADEABLE_LOADER_ID || programData.executable) throw new ReaderError('program data account owner or executable flag is invalid');
    const programDataBytes = decodeRpcData(programData.data, 'program data account');
    if (programDataBytes.length < 13 || programDataBytes.readUInt32LE(0) !== 3) throw new ReaderError('program data loader state is invalid');
    const authorityOption = programDataBytes[12];
    let bytecodeOffset: number;
    let upgradeAuthority: string;
    if (authorityOption === 0) {
      bytecodeOffset = 13;
      upgradeAuthority = 'immutable';
    } else if (authorityOption === 1 && programDataBytes.length >= 45) {
      upgradeAuthority = encodeBase58(programDataBytes.subarray(13, 45));
      bytecodeOffset = 45;
    } else {
      throw new ReaderError('program data upgrade authority option is invalid');
    }
    const bytecode = programDataBytes.subarray(bytecodeOffset);
    if (bytecode.length === 0) throw new ReaderError('program data executable bytes are empty');
    return {
      programId,
      bytecodeSha256: createHash('sha256').update(bytecode).digest('hex'),
      upgradeAuthority,
    };
  }

  private async observeSquads(sellerDesk: SellerDeskManifest, observedVault: string | undefined): Promise<NonNullable<OperatorEvidence['programEvidence']['value']>['squads']> {
    try {
      const governance = sellerDesk.governance;
      if (governance.squadsProgramId !== SQUADS_V4_PROGRAM_ID
        || sellerDesk.squadsProgram.programId !== governance.squadsProgramId) throw new ReaderError('signed governance program ID is not the canonical Squads v4 program');
      const squadsProgram = canonicalPublicKey(governance.squadsProgramId, 'Squads v4 program ID');
      const createKey = canonicalPublicKey(governance.createKey, 'Squads create key');
      const [derivedMultisig] = PublicKey.findProgramAddressSync(
        [Buffer.from('multisig'), Buffer.from('multisig'), createKey.toBuffer()], squadsProgram,
      );
      if (derivedMultisig.toBase58() !== governance.multisigAddress) throw new ReaderError('signed Squads multisig address does not match its create-key PDA');
      const [derivedVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('multisig'), derivedMultisig.toBuffer(), Buffer.from('vault'), Buffer.from([governance.vaultIndex])], squadsProgram,
      );
      if (derivedVault.toBase58() !== governance.vaultAddress) throw new ReaderError('signed Squads vault address does not match its multisig and index PDA');
      if (!observedVault) throw new ReaderError('RFQ GovernanceConfig account is unavailable; configured Squads vault could not be compared');
      if (observedVault !== governance.vaultAddress) throw new ReaderError('RFQ GovernanceConfig governance vault does not match the signed Squads vault');

      const squadsProgramAccount = await this.readAccountInfo(governance.squadsProgramId);
      if (!squadsProgramAccount || squadsProgramAccount.owner !== UPGRADEABLE_LOADER_ID || !squadsProgramAccount.executable) {
        throw new ReaderError('Squads v4 program account is missing or not executable under the upgradeable loader');
      }
      const multisigAccount = await this.readAccountInfo(governance.multisigAddress);
      if (!multisigAccount || multisigAccount.owner !== governance.squadsProgramId || multisigAccount.executable) {
        throw new ReaderError('Squads multisig account is missing or not owned by the Squads v4 program');
      }
      const multisigData = decodeRpcData(multisigAccount.data, 'Squads multisig account');
      if (multisigData.length < 40 || !multisigData.subarray(0, 8).equals(discriminator('account:Multisig'))) {
        throw new ReaderError('Squads multisig account discriminator or create-key data is invalid');
      }
      if (!multisigData.subarray(8, 40).equals(createKey.toBuffer())) throw new ReaderError('Squads multisig account create key does not match the signed identity');

      const vaultAccount = await this.readAccountInfo(governance.vaultAddress);
      let vaultAccountStatus: 'observed' | 'uninitialized-derived-pda' = 'uninitialized-derived-pda';
      if (vaultAccount) {
        const vaultData = decodeRpcData(vaultAccount.data, 'Squads vault account');
        if (vaultAccount.owner !== SYSTEM_PROGRAM_ID || vaultAccount.executable || vaultData.length !== 0) {
          throw new ReaderError('derived Squads vault account has an unexpected owner, executable flag, or data');
        }
        vaultAccountStatus = 'observed';
      }
      return observed({
        programId: governance.squadsProgramId,
        multisigAddress: governance.multisigAddress,
        createKey: governance.createKey,
        vaultAddress: governance.vaultAddress,
        vaultIndex: governance.vaultIndex,
        vaultAccount: vaultAccountStatus,
      });
    } catch (error) {
      return unavailable(error instanceof ReaderError ? error.message : 'Squads v4 account identity could not be read');
    }
  }

  private observedGovernanceVault(onChain: OperatorEvidence['onChain']): string | undefined {
    const evidence = onChain.governanceChanges;
    if (evidence.status !== 'observed' || typeof evidence.value !== 'object' || evidence.value === null) return undefined;
    const value = evidence.value as { governance?: { squadsVault?: unknown } | null };
    return typeof value.governance?.squadsVault === 'string' ? value.governance.squadsVault : undefined;
  }

  private async readAccountInfo(address: string): Promise<RpcAccountInfo | null> {
    const result = await this.rpc<RpcAccountInfoResult>('getAccountInfo', [address, { commitment: 'confirmed', encoding: 'base64' }]);
    if (typeof result !== 'object' || result === null || !('value' in result)) throw new ReaderError('Solana RPC account-info response is invalid');
    if (result.value === null) return null;
    const account = expectRecord(result.value, 'Solana RPC account-info value');
    if (typeof account.owner !== 'string' || typeof account.executable !== 'boolean' || !Array.isArray(account.data)) {
      throw new ReaderError('Solana RPC account-info fields are invalid');
    }
    return account as unknown as RpcAccountInfo;
  }
}

export function createSolanaOperatorEvidenceReaderFromEnv(): SolanaOperatorEvidenceReader {
  return new SolanaOperatorEvidenceReader({
    rpcUrl: process.env.SOLANA_RPC_URL,
    cluster: process.env.SOLANA_CLUSTER,
    manifestPath: process.env.SOLANA_DEPLOYMENT_MANIFEST,
    trustedManifestSigners: (process.env.SOLANA_MANIFEST_TRUSTED_SIGNERS ?? '').split(',').filter(Boolean),
  });
}
