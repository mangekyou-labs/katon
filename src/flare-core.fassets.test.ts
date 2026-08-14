import { describe, expect, it } from 'vitest';

import { FAssetsRail } from '../packages/flare-core/src/fassets';

describe('optional FAssets funding rail', () => {
  it('cannot block or silently activate the core RFQ product', () => {
    const rail = new FAssetsRail({ enabled: false, resolveRegistryName: () => '0xregistry' });
    expect(rail.status()).toBe('disabled');
    expect(() => rail.resolveFxrp()).toThrow('FASSETS_DISABLED');
  });

  it('resolves AssetManager and fAsset through the registry and keeps mint pending', () => {
    const rail = new FAssetsRail({
      enabled: true,
      resolveRegistryName: (name) => (name === 'AssetManagerFXRP' ? '0xmanager' : '0xother'),
      readFAsset: () => '0xfasset',
    });
    expect(rail.resolveFxrp()).toEqual({ assetManager: '0xmanager', fAsset: '0xfasset' });
    expect(rail.prepareMint({ destinationTag: 42, amountUBA: 100n })).toMatchObject({
      state: 'awaiting-user-payment',
      spendable: false,
    });
  });

  it('prepares FXRP redeem without signing and rejects invalid inputs', () => {
    const rail = new FAssetsRail({
      enabled: true,
      resolveRegistryName: () => '0xmanager',
      readFAsset: () => '0xfasset',
    });
    expect(rail.prepareRedeem({ amountUBA: 250n, underlyingAddress: 'rXRPAddressExample01' })).toEqual({
      state: 'awaiting-user-confirmation',
      amountUBA: 250n,
      underlyingAddress: 'rXRPAddressExample01',
      spendable: false,
    });
    expect(() => rail.prepareRedeem({ amountUBA: 0n, underlyingAddress: 'rXRPAddressExample01' })).toThrow(
      'FASSETS_AMOUNT',
    );
    expect(() => rail.prepareRedeem({ amountUBA: 1n, underlyingAddress: '  short  ' })).toThrow('FASSETS_UNDERLYING');
    const disabled = new FAssetsRail({ enabled: false, resolveRegistryName: () => '0x' });
    expect(() => disabled.prepareRedeem({ amountUBA: 1n, underlyingAddress: 'rXRPAddressExample01' })).toThrow(
      'FASSETS_DISABLED',
    );
  });
});
