import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { getAddress, keccak256 } from 'viem';

import {
  assertMainnetVenuePinsComplete,
  firstWaveMarkets,
  getVenuePins,
  parseVenueManifest,
} from '../packages/base-core/src/venues';
import { getB20AssetByAddress, USDBC_ADDRESS } from '../packages/base-core/src/assets';
import type { BaseNetwork } from '../packages/base-core/src/network';

const root = process.cwd();

function loadManifest(network: BaseNetwork) {
  return parseVenueManifest(
    JSON.parse(readFileSync(join(root, `fixtures/base/venues-${network}.json`), 'utf8')),
  );
}

function withPin(manifest: ReturnType<typeof loadManifest>, index: number, patch: Record<string, unknown>) {
  return {
    ...manifest,
    pins: manifest.pins.map((pin, pinIndex) => (pinIndex === index ? { ...pin, ...patch } : pin)),
  } as ReturnType<typeof loadManifest>;
}

describe('Base venue manifests', () => {
  it('parses manifests and requires the complete mainnet pin set', () => {
    const parsed = loadManifest('mainnet');

    expect(parsed.network).toBe('mainnet');
    expect(() => assertMainnetVenuePinsComplete(parsed)).not.toThrow();
    expect(getVenuePins('mainnet')).toHaveLength(11);
    expect(firstWaveMarkets).toHaveLength(0);
  });

  it('validates every manifest entry shape, checksum, source, date, and chain id', () => {
    for (const network of ['mainnet', 'sepolia'] as const) {
      const manifest = loadManifest(network);
      expect(manifest.chainId).toBe(network === 'mainnet' ? 8453 : 84532);
      expect(manifest.pins).toEqual(getVenuePins(network));
      for (const pin of manifest.pins) {
        expect(pin.name).toEqual(expect.any(String));
        expect(pin.address).toBe(getAddress(pin.address));
        expect(pin.chainId).toBe(manifest.chainId);
        expect(pin.bytecodeHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(pin.sourceUrl).toMatch(/^https:\/\/[^\s]+$/);
        expect(pin.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('rejects malformed schema fields before consumers can use a manifest', () => {
    const manifest = loadManifest('mainnet');
    const cases = [
      ['network', { network: 'base' }],
      ['chain id', { chainId: 84532 }],
      ['entry name', { pins: [{ ...manifest.pins[0], name: '' }, ...manifest.pins.slice(1)] }],
      ['address shape', { pins: [{ ...manifest.pins[0], address: '0x1234' }, ...manifest.pins.slice(1)] }],
      ['bytecode hash shape', { pins: [{ ...manifest.pins[0], bytecodeHash: '0x12' }, ...manifest.pins.slice(1)] }],
      ['official source URL', { pins: [{ ...manifest.pins[0], sourceUrl: 'http://example.com' }, ...manifest.pins.slice(1)] }],
      ['pinned date', { pins: [{ ...manifest.pins[0], pinnedAt: '09-09-2026' }, ...manifest.pins.slice(1)] }],
    ] as const;

    for (const [label, change] of cases) {
      expect(() => parseVenueManifest({ ...manifest, ...change }), label).toThrow('INVALID_VENUE_MANIFEST');
    }
  });

  it.each([
    ['empty', ''],
    ['zero', '0x0000000000000000000000000000000000000000'],
  ])('fails a required mainnet pin with an %s address', (_label, address) => {
    expect(() => assertMainnetVenuePinsComplete(withPin(loadManifest('mainnet'), 0, { address }))).toThrow(
      'EMPTY_MAINNET_ADDRESS',
    );
  });

  it('fails a required mainnet pin with an empty bytecode hash', () => {
    expect(() => assertMainnetVenuePinsComplete(withPin(loadManifest('mainnet'), 0, { bytecodeHash: '' }))).toThrow(
      'EMPTY_MAINNET_BYTECODE_HASH',
    );
  });

  it('keeps first-wave markets explicitly empty and rejects USDbC or ticker-only lookups', () => {
    expect(firstWaveMarkets).toEqual([]);
    expect(JSON.stringify(loadManifest('mainnet'))).not.toContain(USDBC_ADDRESS);
    expect(() => getB20AssetByAddress('AAPLc')).toThrow('INVALID_B20_ADDRESS');
  });

  it('records a distinct Sepolia Morpho Blue runtime hash and exposes the keccak helper vector', () => {
    const mainnet = loadManifest('mainnet');
    const sepolia = loadManifest('sepolia');
    const mainnetMorpho = mainnet.pins.find((pin) => pin.name === 'morphoBlue');
    const sepoliaMorpho = sepolia.pins.find((pin) => pin.name === 'morphoBlue');
    expect(mainnetMorpho?.bytecodeHash).not.toBe(sepoliaMorpho?.bytecodeHash);
    expect(keccak256('0x6001600055')).toBe(
      '0x7efcce47028dabcb0d42f3a7eda8820bf6f7f4e618398c2547d52f703cafb073',
    );
  });
});
