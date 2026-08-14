import { describe, expect, it } from 'vitest';

import { getNetworkConfig, type FlareNetwork } from '../packages/flare-core/src/network';

describe('Flare network configuration', () => {
  it('returns the exact chain and RPC identity for Coston2', () => {
    expect(getNetworkConfig('coston2')).toMatchObject({
      key: 'coston2',
      chainId: 114,
      rpcUrl: 'https://coston2-api.flare.network/ext/C/rpc',
      explorerUrl: 'https://coston2-explorer.flare.network',
    });
  });

  it('rejects a chain id that does not belong to the selected network', () => {
    expect(() => getNetworkConfig('flare', 114)).toThrow(
      'CHAIN_ID_MISMATCH',
    );
  });

  it('only accepts the supported Flare deployment keys', () => {
    const supported: FlareNetwork[] = ['local', 'coston2', 'flare'];
    expect(supported.map((network) => getNetworkConfig(network).chainId)).toEqual([
      31337, 114, 14,
    ]);
  });
});
