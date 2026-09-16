import { createPublicKey, verify as verifySignature } from 'node:crypto';

export interface ProgramManifestEntry {
  readonly name: 'kamino' | 'jupiter-lend' | 'jupiter-flashloan';
  readonly programId: string;
  readonly idlSha256: string;
  readonly bytecodeSha256: string;
  readonly upgradeAuthority: string;
}

export type ManifestLenderName = Extract<ProgramManifestEntry['name'], 'kamino' | 'jupiter-lend'>;

export interface ManifestMarketIdentity {
  readonly lender: ManifestLenderName;
  readonly programId: string;
  readonly idlSha256: string;
  readonly bytecodeSha256: string;
  readonly upgradeAuthority: string;
}

export interface DeploymentManifest {
  readonly cluster: 'mainnet-beta' | 'devnet' | 'localnet';
  readonly generatedAt: string;
  readonly programs: readonly ProgramManifestEntry[];
  readonly enabledStockMints: readonly string[];
  readonly signatureAlgorithm: 'ed25519';
  /** Raw Ed25519 public key, encoded as base64. */
  readonly signerPublicKey: string;
  /** Ed25519 signature over deploymentManifestPayload(), encoded as base64. */
  readonly signature: string;
}

export interface RuntimeProgramState {
  readonly name: ProgramManifestEntry['name'];
  readonly programId: string;
  readonly idlSha256: string;
  readonly bytecodeSha256: string;
  readonly upgradeAuthority: string;
}

export interface ManifestCheck {
  readonly ok: boolean;
  readonly reason?: 'cluster_mismatch' | 'manifest_unsigned' | 'manifest_signer_untrusted' | 'manifest_signature_invalid' | 'program_missing' | 'program_id_mismatch' | 'idl_mismatch' | 'bytecode_mismatch' | 'upgrade_authority_mismatch' | 'program_unreviewed' | 'stock_mint_unreviewed' | 'market_discovery_invalid' | 'market_discovery_unavailable' | 'market_manifest_mismatch';
  readonly message: string;
}

const REQUIRED_PROGRAMS: readonly ProgramManifestEntry['name'][] = ['kamino', 'jupiter-lend', 'jupiter-flashloan'];
export const PINNED_PROGRAM_IDS: Readonly<Record<ProgramManifestEntry['name'], string>> = {
  kamino: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
  'jupiter-lend': 'jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi',
  'jupiter-flashloan': 'jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS',
};

function isPlaceholder(value: string | undefined): boolean {
  return value === undefined || !value.trim() || value.startsWith('REPLACE_WITH_');
}

export function deploymentManifestPayload(manifest: Pick<DeploymentManifest, 'cluster' | 'generatedAt' | 'programs' | 'enabledStockMints'>): string {
  return JSON.stringify({
    cluster: manifest.cluster,
    generatedAt: manifest.generatedAt,
    programs: manifest.programs.map((entry) => ({
      name: entry.name,
      programId: entry.programId,
      idlSha256: entry.idlSha256,
      bytecodeSha256: entry.bytecodeSha256,
      upgradeAuthority: entry.upgradeAuthority,
    })),
    enabledStockMints: [...manifest.enabledStockMints],
  });
}

function decodeBase64(value: string, expectedLength: number): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === expectedLength && decoded.toString('base64') === value ? decoded : undefined;
}

function verifyManifestSignature(manifest: DeploymentManifest, trustedSignerPublicKeys: readonly string[]): ManifestCheck | undefined {
  if (manifest.signatureAlgorithm !== 'ed25519' || isPlaceholder(manifest.signature) || isPlaceholder(manifest.signerPublicKey)) {
    return { ok: false, reason: 'manifest_unsigned', message: 'deployment manifest has no Ed25519 governance signature' };
  }
  const publicKeyBytes = decodeBase64(manifest.signerPublicKey, 32);
  const signatureBytes = decodeBase64(manifest.signature, 64);
  if (!publicKeyBytes || !signatureBytes) return { ok: false, reason: 'manifest_signature_invalid', message: 'deployment manifest signature encoding is invalid' };
  const trustedKey = trustedSignerPublicKeys.find((key) => key === manifest.signerPublicKey);
  if (!trustedKey) return { ok: false, reason: 'manifest_signer_untrusted', message: 'deployment manifest signer is not an approved governance key' };
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyBytes]), format: 'der', type: 'spki' });
    if (!verifySignature(null, Buffer.from(deploymentManifestPayload(manifest), 'utf8'), publicKey, signatureBytes)) {
      return { ok: false, reason: 'manifest_signature_invalid', message: 'deployment manifest signature does not match its payload' };
    }
  } catch {
    return { ok: false, reason: 'manifest_signature_invalid', message: 'deployment manifest signer key is invalid' };
  }
  return undefined;
}

export function verifyDeploymentManifest(
  manifest: DeploymentManifest,
  runtime: readonly RuntimeProgramState[],
  observedStockMints: readonly string[],
  cluster: DeploymentManifest['cluster'],
  trustedSignerPublicKeys: readonly string[],
): ManifestCheck {
  if (manifest.cluster !== cluster) return { ok: false, reason: 'cluster_mismatch', message: 'runtime cluster does not match signed deployment manifest' };
  const signatureCheck = verifyManifestSignature(manifest, trustedSignerPublicKeys);
  if (signatureCheck) return signatureCheck;
  if (new Set(manifest.programs.map((entry) => entry.name)).size !== manifest.programs.length) return { ok: false, reason: 'program_unreviewed', message: 'deployment manifest contains duplicate program entries' };
  for (const requiredName of REQUIRED_PROGRAMS) {
    if (!manifest.programs.some((entry) => entry.name === requiredName)) return { ok: false, reason: 'program_missing', message: `${requiredName} is missing from the signed deployment manifest` };
  }
  for (const expected of manifest.programs) {
    if (expected.programId !== PINNED_PROGRAM_IDS[expected.name] && manifest.cluster === 'mainnet-beta') return { ok: false, reason: 'program_id_mismatch', message: `${expected.name} is not pinned to the official mainnet program address` };
    if (isPlaceholder(expected.idlSha256) || isPlaceholder(expected.bytecodeSha256) || isPlaceholder(expected.upgradeAuthority)) return { ok: false, reason: 'manifest_unsigned', message: `${expected.name} does not have signed runtime hashes and authority` };
    const actual = runtime.find((entry) => entry.name === expected.name);
    if (!actual) return { ok: false, reason: 'program_missing', message: `${expected.name} program was not discovered` };
    if (actual.programId !== expected.programId) return { ok: false, reason: 'program_id_mismatch', message: `${expected.name} program address changed` };
    if (actual.idlSha256 !== expected.idlSha256) return { ok: false, reason: 'idl_mismatch', message: `${expected.name} IDL hash changed` };
    if (actual.bytecodeSha256 !== expected.bytecodeSha256) return { ok: false, reason: 'bytecode_mismatch', message: `${expected.name} bytecode hash changed` };
    if (actual.upgradeAuthority !== expected.upgradeAuthority) return { ok: false, reason: 'upgrade_authority_mismatch', message: `${expected.name} upgrade authority changed` };
  }
  if (runtime.some((entry) => !manifest.programs.some((expected) => expected.name === entry.name && expected.programId === entry.programId))) {
    return { ok: false, reason: 'program_unreviewed', message: 'runtime discovered an unreviewed lender or flashloan program' };
  }
  if (observedStockMints.some((mint) => !manifest.enabledStockMints.includes(mint))) {
    return { ok: false, reason: 'stock_mint_unreviewed', message: 'runtime discovered an unreviewed stock mint' };
  }
  return { ok: true, message: 'runtime matches signed deployment manifest' };
}

/**
 * Immutable startup result shared by the solver and its process bootstrap.
 * Runtime adapters must construct this gate before liquidation can prepare a
 * transaction; a failed or missing check leaves the solver dormant.
 */
export class DeploymentManifestGate {
  private readonly result: ManifestCheck;
  private readonly manifest: DeploymentManifest;

  constructor(
    manifest: DeploymentManifest,
    runtime: readonly RuntimeProgramState[],
    observedStockMints: readonly string[],
    cluster: DeploymentManifest['cluster'],
    trustedSignerPublicKeys: readonly string[],
  ) {
    this.manifest = manifest;
    this.result = verifyDeploymentManifest(manifest, runtime, observedStockMints, cluster, trustedSignerPublicKeys);
  }

  check(): ManifestCheck {
    return this.result;
  }

  verifyMarket(market: ManifestMarketIdentity): ManifestCheck {
    if (!this.result.ok) return this.result;
    const expected = this.manifest.programs.find((entry) => entry.name === market.lender);
    if (!expected || expected.programId !== market.programId || expected.idlSha256 !== market.idlSha256 || expected.bytecodeSha256 !== market.bytecodeSha256 || expected.upgradeAuthority !== market.upgradeAuthority) {
      return { ok: false, reason: 'market_manifest_mismatch', message: `${market.lender} market does not match the signed deployment manifest` };
    }
    return { ok: true, message: `${market.lender} market matches the signed deployment manifest` };
  }
}

export const MAINNET_PROGRAM_IDS = {
  kamino: PINNED_PROGRAM_IDS.kamino,
  jupiterLend: PINNED_PROGRAM_IDS['jupiter-lend'],
  jupiterFlashloan: PINNED_PROGRAM_IDS['jupiter-flashloan'],
} as const;
