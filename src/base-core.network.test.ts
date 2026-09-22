import { describe, expect, it } from 'vitest';

import { getBaseNetworkConfig, supportedBaseNetworks } from '../packages/base-core/src/network';

describe('Base network configuration', () => {
  it('returns the exact Base Sepolia identity and native asset', () => {
    expect(getBaseNetworkConfig('sepolia')).toMatchObject({
      key: 'sepolia',
      chainId: 84532,
      rpcUrl: 'https://sepolia.base.org',
      explorerUrl: 'https://sepolia.basescan.org',
      nativeUsdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    });
  });

  it('returns Base mainnet as a separate network identity', () => {
    expect(getBaseNetworkConfig('mainnet')).toMatchObject({
      key: 'mainnet',
      chainId: 8453,
      rpcUrl: 'https://mainnet.base.org',
      explorerUrl: 'https://basescan.org',
      nativeUsdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
  });

  it('rejects a chain id that does not belong to the selected network', () => {
    expect(() => getBaseNetworkConfig('mainnet', 84532)).toThrow('CHAIN_ID_MISMATCH');
  });

  it('only exposes the two supported Base deployment keys', () => {
    expect(supportedBaseNetworks().map((network) => network.chainId)).toEqual([84532, 8453]);
  });
});
