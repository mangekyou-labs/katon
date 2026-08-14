import { describe, expect, it } from 'vitest';

import { resolveRuntimeConfig, type RuntimeConfigInput } from '../packages/flare-core/src/runtime';

const valid: RuntimeConfigInput = {
  network: 'coston2',
  chainId: 114,
  rpcUrl: 'https://coston2-api.flare.network/ext/C/rpc',
  apiBaseUrl: 'https://api.example.test',
  routerAddress: '0x00000000000000000000000000000000000000aa',
  fccMode: 'simulated',
};

describe('Flare runtime configuration', () => {
  it('validates public config against the selected network', () => {
    expect(resolveRuntimeConfig(valid)).toMatchObject({
      chainId: 114,
      network: 'coston2',
      fccMode: 'simulated',
    });
  });

  it('fails closed when a production network uses simulated FCC', () => {
    expect(() => resolveRuntimeConfig({ ...valid, network: 'flare', chainId: 14 })).toThrow(
      'FCC_PRODUCTION_ATTESTATION_REQUIRED',
    );
  });

  it('rejects invalid contract addresses and missing RPC values', () => {
    expect(() => resolveRuntimeConfig({ ...valid, routerAddress: '0x123' })).toThrow(
      'INVALID_ROUTER_ADDRESS',
    );
    expect(() => resolveRuntimeConfig({ ...valid, rpcUrl: '' })).toThrow('RPC_URL_REQUIRED');
  });
});
