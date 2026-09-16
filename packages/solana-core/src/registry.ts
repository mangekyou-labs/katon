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
  readonly code?: 'unknown_extension' | 'mint_mismatch' | 'program_mismatch' | 'decimals_mismatch' | 'fingerprint_mismatch' | 'hook_mismatch' | 'paused' | 'permanent_delegate' | 'confidential_transfer';
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
  if (snapshot.extensionFingerprint !== entry.extensionFingerprint) return { ok: false, code: 'fingerprint_mismatch', message: 'extension fingerprint changed' };
  if ((snapshot.expectedHookProgram ?? '') !== (entry.expectedHookProgram ?? '')) return { ok: false, code: 'hook_mismatch', message: 'transfer-hook program changed' };
  if (snapshot.paused) return { ok: false, code: 'paused', message: 'issuer has paused transfers' };
  // Metadata pointers are part of the signed fingerprint for Token-2022
  // issuer assets that use them. Classic SPL mints do not have extensions,
  // so requiring the pointer unconditionally would incorrectly reject a
  // registry-approved classic asset.
  const metadataPointerRequired = entry.extensionFingerprint.split('|').includes('metadata-pointer');
  if (metadataPointerRequired && (!snapshot.extensions.includes('metadata-pointer') || !snapshot.metadataPointer)) {
    return { ok: false, code: 'fingerprint_mismatch', message: 'issuer metadata pointer is missing' };
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
