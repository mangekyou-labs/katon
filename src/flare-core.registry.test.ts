import { describe, expect, it } from 'vitest';

import { resolveFtsoFeedIds, resolveRegistryContracts, resolveVenueDeployments } from '../packages/flare-core/src/registry';

const reader = {
  chainId: 114,
  getAddress(name: string): string | undefined {
    return {
      FtsoV2: '0x00000000000000000000000000000000000000f1',
      FdcHub: '0x00000000000000000000000000000000000000fd',
    }[name];
  },
};

describe('Flare Contract Registry boundary', () => {
  it('resolves active system contracts for the selected network', () => {
    expect(resolveRegistryContracts('coston2', reader, ['FtsoV2', 'FdcHub'])).toEqual({
      network: 'coston2',
      chainId: 114,
      addresses: {
        FtsoV2: '0x00000000000000000000000000000000000000f1',
        FdcHub: '0x00000000000000000000000000000000000000fd',
      },
    });
  });

  it('fails closed when a required registry entry is absent', () => {
    expect(() => resolveRegistryContracts('coston2', reader, ['FtsoV2', 'FAssets'])).toThrow(
      'REGISTRY_ENTRY_MISSING:FAssets',
    );
  });

  it('rejects a registry reader connected to another chain', () => {
    expect(() => resolveRegistryContracts('flare', { ...reader, chainId: 114 }, ['FtsoV2'])).toThrow(
      'REGISTRY_CHAIN_ID',
    );
  });

  it('resolves FTSO feed identifiers from the active network reader', () => {
    const feedReader = {
      chainId: 114,
      getFeedId(name: string): string | undefined {
        return name === 'USDX/USD' ? '0xfeed-usdx' : undefined;
      },
    };
    expect(resolveFtsoFeedIds('coston2', feedReader, ['USDX/USD'])).toEqual({
      'USDX/USD': '0xfeed-usdx',
    });
    expect(() => resolveFtsoFeedIds('coston2', feedReader, ['UNKNOWN/USD'])).toThrow(
      'FTSO_FEED_MISSING:UNKNOWN/USD',
    );
  });

  it('requires network-matched, verified venue deployments before enabling a route', () => {
    const venueReader = {
      chainId: 114,
      getDeployment(venue: 'morpho' | 'kinetic' | 'clearpool-tpool') {
        return venue === 'morpho'
          ? { venue, chainId: 114, address: '0x00000000000000000000000000000000000000a1', supportedAssets: ['USDX'], verifiedReference: 'coston2-manifest-1' }
          : undefined;
      },
    };
    expect(resolveVenueDeployments('coston2', venueReader, ['morpho']).morpho.address).toBe('0x00000000000000000000000000000000000000A1');
    expect(() => resolveVenueDeployments('coston2', venueReader, ['kinetic'])).toThrow('VENUE_DEPLOYMENT_INVALID:kinetic');
    expect(() => resolveVenueDeployments('flare', { ...venueReader, chainId: 114 }, ['morpho'])).toThrow('VENUE_CHAIN_ID');
  });
});
