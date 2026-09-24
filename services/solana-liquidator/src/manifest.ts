import { createPublicKey, verify as verifySignature } from 'node:crypto';

/** Immutable identity of a reviewed on-chain deployment. */
export interface DeploymentIdentity {
  readonly programId: string;
  readonly idlSha256: string;
  readonly bytecodeSha256: string;
  readonly upgradeAuthority: string;
}

export type DeploymentIdentityField = keyof DeploymentIdentity;

/** Returns the first identity field that differs, or undefined when equal. */
export function compareDeploymentIdentity(expected: DeploymentIdentity, actual: DeploymentIdentity): DeploymentIdentityField | undefined {
  for (const field of ['programId', 'idlSha256', 'bytecodeSha256', 'upgradeAuthority'] as const) {
    if (expected[field] !== actual[field]) return field;
  }
  return undefined;
}

export function deploymentIdentityMatches(expected: DeploymentIdentity, actual: DeploymentIdentity): boolean {
  return compareDeploymentIdentity(expected, actual) === undefined;
}

export interface ProgramManifestEntry extends DeploymentIdentity {
  readonly name: 'kamino' | 'jupiter-lend' | 'jupiter-flashloan';
}

/** Optional identities used by the read-only Seller Desk operator evidence reader. */
export interface SellerDeskManifest {
  readonly rfqProgram: DeploymentIdentity;
  readonly squadsProgram: DeploymentIdentity;
  readonly governance: {
    readonly squadsProgramId: string;
    readonly multisigAddress: string;
    readonly createKey: string;
    readonly vaultIndex: number;
    readonly vaultAddress: string;
  };
}

export type ManifestLenderName = Extract<ProgramManifestEntry['name'], 'kamino' | 'jupiter-lend'>;

export interface ManifestMarketIdentity extends DeploymentIdentity {
  readonly lender: ManifestLenderName;
}

export interface DeploymentManifest {
  readonly cluster: 'mainnet-beta' | 'devnet' | 'localnet';
  readonly generatedAt: string;
  readonly programs: readonly ProgramManifestEntry[];
  readonly enabledStockMints: readonly string[];
  /** Signed identity data for the read-only Seller Desk operator panel. */
  readonly sellerDesk?: SellerDeskManifest;
  readonly signatureAlgorithm: 'ed25519';
  /** Raw Ed25519 public key, encoded as base64. */
  readonly signerPublicKey: string;
  /** Ed25519 signature over deploymentManifestPayload(), encoded as base64. */
  readonly signature: string;
}

export interface RuntimeProgramState extends DeploymentIdentity {
  readonly name: ProgramManifestEntry['name'];
}

export interface ManifestCheck {
  readonly ok: boolean;
  readonly reason?: 'cluster_mismatch' | 'manifest_unsigned' | 'manifest_signer_untrusted' | 'manifest_signature_invalid' | 'program_missing' | 'program_id_mismatch' | 'idl_mismatch' | 'bytecode_mismatch' | 'upgrade_authority_mismatch' | 'program_unreviewed' | 'stock_mint_unreviewed' | 'market_discovery_invalid' | 'market_discovery_unavailable' | 'market_manifest_mismatch' | 'safety_state_unavailable' | 'liquidation_enablement_unavailable' | 'liquidation_enablement_invalid';
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

export function deploymentManifestPayload(manifest: Pick<DeploymentManifest, 'cluster' | 'generatedAt' | 'programs' | 'enabledStockMints' | 'sellerDesk'>): string {
  const payload = {
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
    ...(manifest.sellerDesk === undefined ? {} : {
      sellerDesk: {
        rfqProgram: {
          programId: manifest.sellerDesk.rfqProgram.programId,
          idlSha256: manifest.sellerDesk.rfqProgram.idlSha256,
          bytecodeSha256: manifest.sellerDesk.rfqProgram.bytecodeSha256,
          upgradeAuthority: manifest.sellerDesk.rfqProgram.upgradeAuthority,
        },
        squadsProgram: {
          programId: manifest.sellerDesk.squadsProgram.programId,
          idlSha256: manifest.sellerDesk.squadsProgram.idlSha256,
          bytecodeSha256: manifest.sellerDesk.squadsProgram.bytecodeSha256,
          upgradeAuthority: manifest.sellerDesk.squadsProgram.upgradeAuthority,
        },
        governance: {
          squadsProgramId: manifest.sellerDesk.governance.squadsProgramId,
          multisigAddress: manifest.sellerDesk.governance.multisigAddress,
          createKey: manifest.sellerDesk.governance.createKey,
          vaultIndex: manifest.sellerDesk.governance.vaultIndex,
          vaultAddress: manifest.sellerDesk.governance.vaultAddress,
        },
      },
    }),
  };
  return JSON.stringify(payload);
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

/** Verifies that a manifest payload is signed by one of the trusted Ed25519 keys. */
export function verifyDeploymentManifestSignature(
  manifest: DeploymentManifest,
  trustedSignerPublicKeys: readonly string[],
): ManifestCheck {
  const error = verifyManifestSignature(manifest, trustedSignerPublicKeys);
  return error ?? { ok: true, message: 'deployment manifest signature is valid and trusted' };
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
    const mismatch = compareDeploymentIdentity(expected, actual);
    if (mismatch === 'programId') return { ok: false, reason: 'program_id_mismatch', message: `${expected.name} program address changed` };
    if (mismatch === 'idlSha256') return { ok: false, reason: 'idl_mismatch', message: `${expected.name} IDL hash changed` };
    if (mismatch === 'bytecodeSha256') return { ok: false, reason: 'bytecode_mismatch', message: `${expected.name} bytecode hash changed` };
    if (mismatch === 'upgradeAuthority') return { ok: false, reason: 'upgrade_authority_mismatch', message: `${expected.name} upgrade authority changed` };
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
    if (!expected || !deploymentIdentityMatches(expected, market)) {
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
