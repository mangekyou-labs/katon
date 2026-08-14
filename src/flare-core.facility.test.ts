import { describe, expect, it } from 'vitest';

import { FacilityLedger } from '../packages/flare-core/src/facility';

describe('facility accounting boundary', () => {
  it('mints proportional shares and includes deployed assets in NAV', () => {
    const ledger = new FacilityLedger();
    expect(ledger.deposit('alice', 1_000n)).toEqual({ shares: 1_000n });
    ledger.setDeployedAssets(500n);
    expect(ledger.totalAssets()).toBe(1_000n);
    ledger.setInventoryNav(500n);
    expect(ledger.totalAssets()).toBe(1_500n);
    expect(ledger.deposit('bob', 500n)).toEqual({ shares: 333n });
    expect(ledger.totalShares()).toBe(1_333n);
  });

  it('queues illiquid withdrawals and settles them once after liquidity returns', () => {
    const ledger = new FacilityLedger();
    ledger.deposit('alice', 1_000n);
    ledger.setDeployedAssets(1_000n);
    const request = ledger.requestWithdraw('alice', 500n, 490n);
    expect(request.state).toBe('queued');
    expect(() => ledger.settleWithdraw(request.id)).toThrow('WITHDRAWAL_LIQUIDITY');
    ledger.setIdleAssets(500n);
    expect(ledger.settleWithdraw(request.id)).toMatchObject({ assets: 500n, state: 'settled' });
    expect(() => ledger.settleWithdraw(request.id)).toThrow('WITHDRAWAL_SETTLED');
  });

  it('locks owner shares at request time and settles withdrawals FIFO', () => {
    const ledger = new FacilityLedger();
    ledger.deposit('alice', 1_000n);
    const first = ledger.requestWithdraw('alice', 600n, 0n);
    expect(ledger.shareBalance('alice')).toBe(400n);
    expect(() => ledger.requestWithdraw('alice', 500n, 0n)).toThrow('WITHDRAWAL_SHARES');
    const second = ledger.requestWithdraw('alice', 400n, 0n);
    expect(() => ledger.settleWithdraw(second.id)).toThrow('WITHDRAWAL_ORDER');
    expect(ledger.settleWithdraw(first.id).state).toBe('settled');
    expect(ledger.settleWithdraw(second.id).state).toBe('settled');
  });

  it('cancels a queued withdrawal by restoring locked shares without blocking FIFO', () => {
    const ledger = new FacilityLedger();
    ledger.deposit('alice', 1_000n);
    const cancelled = ledger.requestWithdraw('alice', 400n, 0n);
    const remaining = ledger.requestWithdraw('alice', 600n, 0n);
    expect(ledger.shareBalance('alice')).toBe(0n);

    expect(ledger.cancelWithdraw(cancelled.id, 'alice')).toMatchObject({ state: 'cancelled', shares: 400n });
    expect(ledger.shareBalance('alice')).toBe(400n);
    expect(() => ledger.settleWithdraw(cancelled.id)).toThrow('WITHDRAWAL_CANCELLED');
    expect(ledger.settleWithdraw(remaining.id).state).toBe('settled');
    expect(ledger.totalShares()).toBe(400n);
  });

  it('recognizes exact and short redemption proceeds without replay', () => {
    const ledger = new FacilityLedger();
    ledger.deposit('alice', 1_000n);
    const exactLot = ledger.bookInventoryLot(300n, 300n, 300n);
    const shortLot = ledger.bookInventoryLot(300n, 300n, 300n);
    const exact = ledger.bookRedemptionFromLot(exactLot, 300n);
    expect(ledger.settleRedemption(exact.id, 300n)).toMatchObject({ realizedLoss: 0n });
    const short = ledger.bookRedemptionFromLot(shortLot, 300n);
    expect(ledger.settleRedemption(short.id, 250n)).toMatchObject({ realizedLoss: 50n });
    expect(() => ledger.settleRedemption(short.id, 250n)).toThrow('REDEMPTION_SETTLED');
  });

  it('carries each acquired inventory lot at the lower of cost and verified NAV', () => {
    const ledger = new FacilityLedger();
    ledger.deposit('alice', 1_000n);
    const lotId = ledger.bookInventoryLot(100n, 100n, 120n);
    expect(ledger.inventoryCarryingValue()).toBe(100n);
    ledger.updateInventoryLotNav(lotId, 80n);
    expect(ledger.inventoryCarryingValue()).toBe(80n);
    ledger.updateInventoryLotNav(lotId, 140n);
    expect(ledger.inventoryCarryingValue()).toBe(100n);
    expect(ledger.totalAssets()).toBe(1_100n);
  });

  it('redeems a selected inventory lot and removes only that lot from carrying value', () => {
    const ledger = new FacilityLedger();
    ledger.deposit('alice', 1_000n);
    const first = ledger.bookInventoryLot(40n, 100n, 80n);
    ledger.bookInventoryLot(60n, 200n, 150n);
    const redemption = ledger.bookRedemptionFromLot(first, 90n);
    expect(redemption.inventoryAmount).toBe(40n);
    expect(ledger.inventoryCarryingValue()).toBe(150n);
    expect(ledger.totalAssets()).toBe(1_240n);
  });
});
