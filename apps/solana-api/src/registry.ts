import { SOLANA_USDC_MINT, SOLANA_USDT_MINT } from '@katon/solana-core';
import type { AssetRegistryEntry, TokenCapabilities } from '@katon/solana-core';

const xstocksCapabilities: TokenCapabilities = {
  transferHook: false,
  pausable: true,
  scaledUiAmount: true,
  transferFee: false,
  permanentDelegate: false,
  memoTransfer: false,
  confidentialTransfer: false,
};

const ondoCapabilities: TokenCapabilities = {
  transferHook: true,
  pausable: true,
  scaledUiAmount: false,
  transferFee: false,
  permanentDelegate: false,
  memoTransfer: false,
  confidentialTransfer: false,
};

export const demoAssets: readonly AssetRegistryEntry[] = [
  {
    // Syntactically valid local fixture address so transaction binding and
    // PDA/ATA validation exercise the same web3 code paths as real mints.
    mint: '2gamkL7f7ikNbPAvchzyjFtVVWhLaVTPtjskiCv5i3gW',
    issuer: 'xstocks',
    ticker: 'AAPLx',
    underlyingTicker: 'AAPL',
    tokenProgram: 'token-2022',
    decimals: 6,
    issuerAuthorityFingerprint: 'xstocks-authority-demo',
    expectedMetadataPointer: 'xstk-demo-AAPL-metadata',
    extensionFingerprint: 'metadata-pointer|active|scaled|none|none|no-memo',
    capabilities: xstocksCapabilities,
    supportedOutputs: [SOLANA_USDC_MINT, SOLANA_USDT_MINT],
    referenceState: 'open',
    referencePriceAtomic: '100000000',
    referencePriceDecimals: 6,
    referenceTimestampMs: Date.now(),
    maxDeviationBps: 150,
    enabled: true,
    registryVersion: 1,
  },
  {
    mint: 'ondo-demo-MSFT-mint',
    issuer: 'ondo',
    ticker: 'MSFTon',
    underlyingTicker: 'MSFT',
    tokenProgram: 'token-2022',
    decimals: 6,
    issuerAuthorityFingerprint: 'ondo-authority-demo',
    issuerProgram: 'ondo-issuer-program-demo',
    jitCapabilityFingerprint: 'ondo-jit-capability-demo',
    expectedMetadataPointer: 'ondo-demo-MSFT-metadata',
    extensionFingerprint: 'metadata-pointer|pausable|transfer-hook|active|unscaled|none|none|no-memo',
    expectedHookProgram: 'ondo-jit-hook-demo',
    capabilities: ondoCapabilities,
    supportedOutputs: [SOLANA_USDC_MINT, SOLANA_USDT_MINT],
    referenceState: 'open',
    referencePriceAtomic: '100000000',
    referencePriceDecimals: 6,
    referenceTimestampMs: Date.now(),
    maxDeviationBps: 150,
    enabled: false,
    registryVersion: 1,
  },
];
