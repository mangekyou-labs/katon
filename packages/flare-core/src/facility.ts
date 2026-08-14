export type WithdrawalState = 'queued' | 'ready' | 'settled' | 'cancelled';
export type RedemptionState = 'open' | 'settled';

export interface WithdrawalRequest {
  readonly id: number;
  readonly owner: string;
  readonly shares: bigint;
  readonly minAssets: bigint;
  readonly assets: bigint;
  readonly state: WithdrawalState;
}

export interface RedemptionRequest {
  readonly id: number;
  readonly inventoryAmount: bigint;
  readonly expectedAssets: bigint;
  readonly state: RedemptionState;
}

export interface RedemptionSettlement {
  readonly id: number;
  readonly receivedAssets: bigint;
  readonly realizedLoss: bigint;
}

export interface InventoryLot {
  readonly id: number;
  readonly inventoryAmount: bigint;
  readonly acquisitionCost: bigint;
  readonly verifiedNav: bigint;
}

export class FacilityLedger {
  private idle = 0n;
  private deployed = 0n;
  private inventory = 0n;
  private receivables = 0n;
  private realized = 0n;
  private shares = 0n;
  private nextInventoryLotId = 1;
  private readonly inventoryLots = new Map<number, InventoryLot>();
  private nextWithdrawalId = 1;
  private nextWithdrawalToSettle = 1;
  private nextRedemptionId = 1;
  private readonly balances = new Map<string, bigint>();
  private readonly withdrawals = new Map<number, WithdrawalRequest>();
  private readonly redemptions = new Map<number, RedemptionRequest>();

  deposit(receiver: string, assets: bigint): { shares: bigint } {
    if (!receiver || assets <= 0n) throw new Error('DEPOSIT_AMOUNT');
    const currentAssets = this.totalAssets();
    const minted = this.shares === 0n ? assets : (assets * this.shares) / currentAssets;
    if (minted <= 0n) throw new Error('DEPOSIT_ROUNDING');
    this.idle += assets;
    this.shares += minted;
    this.balances.set(receiver, (this.balances.get(receiver) ?? 0n) + minted);
    return { shares: minted };
  }

  setDeployedAssets(value: bigint): void {
    if (value < 0n) throw new Error('DEPLOYED_ASSETS');
    if (value > this.deployed) {
      const delta = value - this.deployed;
      if (this.idle < delta) throw new Error('IDLE_LIQUIDITY');
      this.idle -= delta;
    } else {
      this.idle += this.deployed - value;
    }
    this.deployed = value;
  }

  setIdleAssets(value: bigint): void {
    if (value < 0n) throw new Error('IDLE_ASSETS');
    this.idle = value;
  }

  setInventoryNav(value: bigint): void {
    if (value < 0n) throw new Error('INVENTORY_NAV');
    this.inventoryLots.clear();
    this.inventory = value;
  }

  bookInventoryLot(inventoryAmount: bigint, acquisitionCost: bigint, verifiedNav: bigint): number {
    if (inventoryAmount <= 0n || acquisitionCost <= 0n || verifiedNav <= 0n) throw new Error('INVENTORY_LOT');
    const id = this.nextInventoryLotId++;
    this.inventoryLots.set(id, { id, inventoryAmount, acquisitionCost, verifiedNav });
    return id;
  }

  updateInventoryLotNav(id: number, verifiedNav: bigint): void {
    const lot = this.inventoryLots.get(id);
    if (!lot || verifiedNav <= 0n) throw new Error('INVENTORY_LOT');
    this.inventoryLots.set(id, { ...lot, verifiedNav });
  }

  inventoryCarryingValue(): bigint {
    if (this.inventoryLots.size === 0) return this.inventory;
    let carrying = 0n;
    for (const lot of this.inventoryLots.values()) {
      carrying += lot.acquisitionCost < lot.verifiedNav ? lot.acquisitionCost : lot.verifiedNav;
    }
    return carrying;
  }

  totalAssets(): bigint {
    return this.idle + this.deployed + this.inventoryCarryingValue() + this.receivables;
  }

  totalShares(): bigint {
    return this.shares;
  }

  shareBalance(owner: string): bigint {
    return this.balances.get(owner) ?? 0n;
  }

  requestWithdraw(owner: string, requestedShares: bigint, minAssets: bigint): WithdrawalRequest {
    if (!owner || requestedShares <= 0n || requestedShares > this.shareBalance(owner)) throw new Error('WITHDRAWAL_SHARES');
    if (minAssets < 0n) throw new Error('WITHDRAWAL_MIN_ASSETS');
    const assets = (requestedShares * this.totalAssets()) / this.shares;
    if (assets < minAssets) throw new Error('WITHDRAWAL_MIN_ASSETS');
    this.balances.set(owner, this.shareBalance(owner) - requestedShares);
    const id = this.nextWithdrawalId++;
    const state: WithdrawalState = this.idle >= assets ? 'ready' : 'queued';
    const request = { id, owner, shares: requestedShares, minAssets, assets, state };
    this.withdrawals.set(id, request);
    return request;
  }

  settleWithdraw(id: number): WithdrawalRequest {
    const existing = this.withdrawals.get(id);
    if (!existing) throw new Error('WITHDRAWAL_UNKNOWN');
    if (existing.state === 'settled') throw new Error('WITHDRAWAL_SETTLED');
    if (existing.state === 'cancelled') throw new Error('WITHDRAWAL_CANCELLED');
    while (this.withdrawals.get(this.nextWithdrawalToSettle)?.state === 'cancelled') {
      this.nextWithdrawalToSettle += 1;
    }
    if (id !== this.nextWithdrawalToSettle) throw new Error('WITHDRAWAL_ORDER');
    if (this.idle < existing.assets) throw new Error('WITHDRAWAL_LIQUIDITY');
    this.idle -= existing.assets;
    this.shares -= existing.shares;
    this.nextWithdrawalToSettle += 1;
    const settled = { ...existing, state: 'settled' as const };
    this.withdrawals.set(id, settled);
    return settled;
  }

  cancelWithdraw(id: number, caller: string): WithdrawalRequest {
    const existing = this.withdrawals.get(id);
    if (!existing) throw new Error('WITHDRAWAL_UNKNOWN');
    if (caller !== existing.owner) throw new Error('WITHDRAWAL_AUTH');
    if (existing.state === 'settled' || existing.state === 'cancelled') {
      throw new Error('WITHDRAWAL_CANCELLED');
    }
    this.balances.set(existing.owner, this.shareBalance(existing.owner) + existing.shares);
    const cancelled = { ...existing, state: 'cancelled' as const };
    this.withdrawals.set(id, cancelled);
    return cancelled;
  }

  bookRedemptionFromLot(lotId: number, expectedAssets: bigint): RedemptionRequest {
    const lot = this.inventoryLots.get(lotId);
    if (!lot || expectedAssets <= 0n) throw new Error('REDEMPTION_AMOUNT');
    this.inventoryLots.delete(lotId);
    const inventoryAmount = lot.inventoryAmount;
    this.receivables += expectedAssets;
    const id = this.nextRedemptionId++;
    const request = { id, inventoryAmount, expectedAssets, state: 'open' as const };
    this.redemptions.set(id, request);
    return request;
  }

  settleRedemption(id: number, receivedAssets: bigint): RedemptionSettlement {
    const request = this.redemptions.get(id);
    if (!request) throw new Error('REDEMPTION_UNKNOWN');
    if (request.state === 'settled') throw new Error('REDEMPTION_SETTLED');
    if (receivedAssets < 0n || receivedAssets > request.expectedAssets) {
      throw new Error('REDEMPTION_RECEIPT');
    }
    this.receivables -= request.expectedAssets;
    this.idle += receivedAssets;
    const realizedLoss = request.expectedAssets - receivedAssets;
    this.realized += realizedLoss;
    this.redemptions.set(id, { ...request, state: 'settled' });
    return { id, receivedAssets, realizedLoss };
  }

  realizedLoss(): bigint {
    return this.realized;
  }
}
