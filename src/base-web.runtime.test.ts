import { describe, expect, it } from 'vitest';
import {
  liquidationAvailability,
  loadRuntimeConfig,
  selectBrowserRuntimeConfig,
  type RawBaseRuntimeConfig,
} from '../apps/base-web/src/runtime';

const address = (digit: string): `0x${string}` => `0x${digit.repeat(40)}`;

const completeConfig: RawBaseRuntimeConfig = {
  network: 'sepolia',
  chainId: 84_532,
  deployment: {
    router: address('1'),
    settlement: address('2'),
    facility: address('3'),
    oracleGuard: address('4'),
    b20Guard: address('5'),
  },
  adapterAddresses: [],
};

describe('Base browser runtime config', () => {
  it('gives the window config priority over the Vite JSON fallback', () => {
    const vite = JSON.stringify({ ...completeConfig, rpcUrl: 'https://vite.invalid' });
    expect(selectBrowserRuntimeConfig(completeConfig, vite)).toBe(completeConfig);
    expect(selectBrowserRuntimeConfig(undefined, vite)).toBe(vite);
  });

  it('loads the public Vite JSON fallback without enabling mainnet', () => {
    const selected = selectBrowserRuntimeConfig(undefined, JSON.stringify(completeConfig));
    const config = loadRuntimeConfig(selected);
    expect(config.status).toBe('ready');
    expect(config.writesEnabled).toBe(true);
    expect(config.network).toBe('sepolia');
  });

  it('fails malformed Vite JSON closed as CONFIG_UNAVAILABLE', () => {
    const config = loadRuntimeConfig(selectBrowserRuntimeConfig(undefined, '{not-json'));
    expect(config.status).toBe('unavailable');
    expect(config.writesEnabled).toBe(false);
    expect(config.reason).toBe('CONFIG_UNAVAILABLE');
  });

  it('keeps facility writes enabled while liquidation fails closed without an adapter', () => {
    const config = loadRuntimeConfig(completeConfig);
    expect(config.writesEnabled).toBe(true);
    expect(liquidationAvailability(config)).toEqual({
      enabled: false,
      reason: 'PRODUCT_DISABLED',
    });
  });

  it('enables liquidation only when the product gate and venue adapter are configured', () => {
    const config = loadRuntimeConfig({ ...completeConfig, liquidationEnabled: true, adapterAddresses: [address('6')] });
    expect(liquidationAvailability(config)).toEqual({ enabled: true });
  });

  it('keeps liquidation disabled even with an adapter when the product gate is absent', () => {
    const config = loadRuntimeConfig({ ...completeConfig, adapterAddresses: [address('6')] });
    expect(liquidationAvailability(config)).toEqual({ enabled: false, reason: 'PRODUCT_DISABLED' });
  });
});
