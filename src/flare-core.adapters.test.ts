import { describe, expect, it } from 'vitest';

import {
  ClearpoolAdapter,
  InMemoryFacilityAdapter,
  KineticLiquidationAdapter,
  MorphoLiquidationAdapter,
  assertAdapterConformance,
  type FacilityAdapter,
} from '../packages/flare-core/src/adapters';

describe('facility adapter boundary', () => {
  it('keeps deposits and withdrawals facility-controlled and liquidity-aware', () => {
    const adapter: FacilityAdapter = new InMemoryFacilityAdapter('USDX', 'facility-1');
    expect(adapter.deposit('facility-1', 600n)).toBe(600n);
    expect(adapter.totalAssets()).toBe(600n);
    expect(adapter.maxWithdraw()).toBe(600n);
    expect(adapter.withdraw('facility-1', 200n, 'receiver-1')).toBe(200n);
    expect(adapter.balanceOf('receiver-1')).toBe(200n);
    expect(() => adapter.deposit('attacker', 1n)).toThrow('ADAPTER_CALLER');
    expect(() => adapter.withdraw('facility-1', 1n, '')).toThrow('ADAPTER_RECEIVER');
    expect(() => adapter.withdraw('facility-1', 500n, 'receiver-1')).toThrow('ADAPTER_LIQUIDITY');
  });

  it('passes the common conformance gate and rejects non-USDX Clearpool facilities', () => {
    const adapter = new ClearpoolAdapter('USDX', 'facility-1');
    expect(assertAdapterConformance(adapter)).toEqual({ asset: 'USDX', ok: true });
    expect(() => new ClearpoolAdapter('USDT', 'facility-1')).toThrow('CLEARPOOL_USDX_ONLY');
  });

  it('validates typed Morpho liquidation scope, health, and close-factor bounds', () => {
    const adapter = new MorphoLiquidationAdapter({
      facility: 'facility-1',
      venue: 'morpho',
      market: 'market-1',
      position: 'position-1',
      debtAsset: 'USDX',
      collateralAsset: 'RWA',
      debtOutstanding: 1_000n,
      collateralAvailable: 1_500n,
      healthFactorBps: 9_000n,
      closeFactorBps: 5_000n,
    });

    expect(adapter.liquidate({
      caller: 'facility-1',
      venue: 'morpho',
      market: 'market-1',
      position: 'position-1',
      debtAsset: 'USDX',
      collateralAsset: 'RWA',
      maxRepay: 500n,
      recipient: 'router',
    })).toEqual({ repaid: 500n, collateral: 750n });
    expect(() => adapter.liquidate({
      caller: 'attacker', venue: 'morpho', market: 'market-1', position: 'position-1',
      debtAsset: 'USDX', collateralAsset: 'RWA', maxRepay: 1n, recipient: 'router',
    })).toThrow('LIQUIDATION_CALLER');
    expect(() => adapter.liquidate({
      caller: 'facility-1', venue: 'morpho', market: 'market-1', position: 'position-1',
      debtAsset: 'USDX', collateralAsset: 'RWA', maxRepay: 501n, recipient: 'router',
    })).toThrow('LIQUIDATION_CLOSE_FACTOR');
  });

  it('rejects healthy or paused Kinetic liquidation positions', () => {
    const adapter = new KineticLiquidationAdapter({
      facility: 'facility-1', venue: 'kinetic', market: 'market-1', position: 'position-1',
      debtAsset: 'USDX', collateralAsset: 'RWA', debtOutstanding: 100n,
      collateralAvailable: 150n, healthFactorBps: 10_000n, closeFactorBps: 5_000n,
    });
    expect(() => adapter.liquidate({
      caller: 'facility-1', venue: 'kinetic', market: 'market-1', position: 'position-1',
      debtAsset: 'USDX', collateralAsset: 'RWA', maxRepay: 10n, recipient: 'router',
    })).toThrow('LIQUIDATION_HEALTH');
    adapter.pause();
    expect(() => adapter.liquidate({
      caller: 'facility-1', venue: 'kinetic', market: 'market-1', position: 'position-1',
      debtAsset: 'USDX', collateralAsset: 'RWA', maxRepay: 10n, recipient: 'router',
    })).toThrow('LIQUIDATION_PAUSED');
  });
});
