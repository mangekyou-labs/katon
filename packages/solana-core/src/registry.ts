import type { AssetRegistryEntry, MintAccountSnapshot, TokenCapabilities } from './types';

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const NATIVE_STABLE_MINTS = [SOLANA_USDC_MINT, SOLANA_USDT_MINT] as const;

export function isNativeStableMint(mint: string): boolean {
  return (NATIVE_STABLE_MINTS as readonly string[]).includes(mint);
}

export function capabilitiesFingerprint(capabilities: TokenCapabilities): string {
  return [
    capabilities.transferHook,
    capabilities.pausable,
    capabilities.scaledUiAmount,
    capabilities.transferFee,
    capabilities.permanentDelegate,
    capabilities.memoTransfer,
    capabilities.confidentialTransfer,
  ]
    .map((value) => (value ? '1' : '0'))
    .join('');
}

export function fingerprintSnapshot(snapshot: MintAccountSnapshot): string {
  return [
    ...snapshot.extensions.slice().sort(),
    snapshot.expectedHookProgram ?? '',
    snapshot.paused ? 'paused' : 'active',
    snapshot.scaledUiAmountEnabled ? 'scaled' : 'unscaled',
    snapshot.transferFeeBps?.toString() ?? 'none',
    snapshot.permanentDelegate ?? 'none',
    snapshot.memoTransferRequired ? 'memo' : 'no-memo',
  ].join('|');
}

export interface RegistryCheck {
  readonly ok: boolean;
  readonly code?: 'unknown_extension' | 'mint_mismatch' | 'program_mismatch' | 'decimals_mismatch' | 'fingerprint_mismatch' | 'hook_mismatch' | 'paused' | 'permanent_delegate' | 'confidential_transfer' | 'issuer_authority_mismatch' | 'issuer_program_mismatch' | 'jit_capability_mismatch';
  readonly message: string;
}

const KNOWN_EXTENSIONS = new Set([
  'transfer-hook',
  'pausable',
  'scaled-ui-amount',
  'transfer-fee-config',
  'memo-transfer',
  'metadata-pointer',
]);

export function checkMintAgainstRegistry(entry: AssetRegistryEntry, snapshot: MintAccountSnapshot): RegistryCheck {
  const unknownExtension = snapshot.extensions.find((extension) => !KNOWN_EXTENSIONS.has(extension));
  if (unknownExtension) return { ok: false, code: 'unknown_extension', message: `unknown Token-2022 extension: ${unknownExtension}` };
  if (snapshot.mint !== entry.mint) return { ok: false, code: 'mint_mismatch', message: 'mint does not match signed registry entry' };
  if (snapshot.ownerProgram !== entry.tokenProgram) return { ok: false, code: 'program_mismatch', message: 'token program does not match registry' };
  if (snapshot.decimals !== entry.decimals) return { ok: false, code: 'decimals_mismatch', message: 'mint decimals changed' };
  if (typeof entry.issuerAuthorityFingerprint !== 'string' || entry.issuerAuthorityFingerprint.trim().length === 0 || snapshot.issuerAuthorityFingerprint !== entry.issuerAuthorityFingerprint) return { ok: false, code: 'issuer_authority_mismatch', message: 'issuer authority fingerprint changed' };
  if (snapshot.extensionFingerprint !== entry.extensionFingerprint) return { ok: false, code: 'fingerprint_mismatch', message: 'extension fingerprint changed' };
  if ((snapshot.expectedHookProgram ?? '') !== (entry.expectedHookProgram ?? '')) return { ok: false, code: 'hook_mismatch', message: 'transfer-hook program changed' };
  if (snapshot.paused) return { ok: false, code: 'paused', message: 'issuer has paused transfers' };
  // The registry records an exact issuer metadata source for every asset.
  // Token-2022 assets expose it through the metadata-pointer extension; classic
  // SPL assets are checked against their issuer metadata account/reference by
  // the provider and still cannot proceed without the signed pointer.
  if (typeof entry.expectedMetadataPointer !== 'string' || entry.expectedMetadataPointer.trim().length === 0 || snapshot.metadataPointer !== entry.expectedMetadataPointer || (entry.extensionFingerprint.split('|').includes('metadata-pointer') && !snapshot.extensions.includes('metadata-pointer'))) {
    return { ok: false, code: 'fingerprint_mismatch', message: 'issuer metadata pointer changed or is missing' };
  }
  if (entry.issuer === 'ondo') {
    if (typeof entry.issuerProgram !== 'string' || entry.issuerProgram.trim().length === 0 || snapshot.issuerProgram !== entry.issuerProgram) return { ok: false, code: 'issuer_program_mismatch', message: 'Ondo issuer program changed' };
    if (typeof entry.jitCapabilityFingerprint !== 'string' || entry.jitCapabilityFingerprint.trim().length === 0 || snapshot.jitCapabilityFingerprint !== entry.jitCapabilityFingerprint) return { ok: false, code: 'jit_capability_mismatch', message: 'Ondo JIT capability changed' };
  }
  const requiredExtensions: Array<[boolean, string]> = [
    [entry.capabilities.transferHook, 'transfer-hook'],
    [entry.capabilities.pausable, 'pausable'],
    [entry.capabilities.scaledUiAmount, 'scaled-ui-amount'],
    [entry.capabilities.transferFee, 'transfer-fee-config'],
    [entry.capabilities.memoTransfer, 'memo-transfer'],
  ];
  for (const [required, extension] of requiredExtensions) {
    if (required !== snapshot.extensions.includes(extension)) {
      return { ok: false, code: 'fingerprint_mismatch', message: `Token-2022 capability changed: ${extension}` };
    }
  }
  if (snapshot.scaledUiAmountEnabled !== entry.capabilities.scaledUiAmount) {
    return { ok: false, code: 'fingerprint_mismatch', message: 'scaled UI amount capability changed' };
  }
  if (snapshot.memoTransferRequired !== entry.capabilities.memoTransfer) {
    return { ok: false, code: 'fingerprint_mismatch', message: 'memo transfer capability changed' };
  }
  if (!entry.capabilities.transferFee && snapshot.transferFeeBps !== undefined) {
    return { ok: false, code: 'fingerprint_mismatch', message: 'unexpected transfer fee configuration' };
  }
  if (entry.capabilities.transferFee && snapshot.transferFeeBps === undefined) {
    return { ok: false, code: 'fingerprint_mismatch', message: 'transfer fee configuration is missing' };
  }
  if (snapshot.permanentDelegate || entry.capabilities.permanentDelegate) return { ok: false, code: 'permanent_delegate', message: 'permanent delegate is not supported' };
  if (snapshot.extensions.includes('confidential-transfer') || entry.capabilities.confidentialTransfer) {
    return { ok: false, code: 'confidential_transfer', message: 'confidential transfers are not supported' };
  }
  return { ok: true, message: 'mint matches registry' };
}

export function assertSupportedOutput(entry: AssetRegistryEntry, outputMint: string): void {
  if (!isNativeStableMint(outputMint) || !entry.supportedOutputs.includes(outputMint)) {
    throw new Error('output mint is not a registry-approved native Solana stablecoin');
  }
}
