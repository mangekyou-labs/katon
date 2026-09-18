import type { Address, Hex } from 'viem';
import { hashLiquidationFundingOrder, hashSwapOrder, type SwapOrder } from '../../../packages/base-core/src/eip712';
import type { LiquidationRankInput } from '../../../packages/base-core/src/ranking';
import type { BaseRepository } from './ports';
import type {
  BaseClock,
  BaseFacilitySnapshot,
  BaseNotification,
  BaseNotificationPort,
  BaseOracleSnapshot,
  BaseSignaturePort,
  BaseSnapshotPort,
  BaseSignatureVerificationResult,
  BaseApiConfig,
  StoredBid,
  StoredLiquidation,
  StoredRoute,
  StoredSwapOrder,
} from './types';

export class InMemoryBaseRepository implements BaseRepository {
  private readonly liquidations = new Map<string, StoredLiquidation>();
  private readonly opportunityKeys = new Map<string, string>();
  private readonly bids = new Map<string, StoredBid>();
  private readonly bidsByRfq = new Map<string, string[]>();
  private readonly standing = new Map<string, Map<string, StoredBid>>();
  private readonly routes = new Map<string, StoredRoute>();
  private readonly swapOrders = new Map<string, StoredSwapOrder>();
  private readonly facilitySnapshots = new Map<string, BaseFacilitySnapshot>();
  private readonly oracleSnapshots = new Map<string, BaseOracleSnapshot>();

  createLiquidation(input: StoredLiquidation): Promise<StoredLiquidation> {
    const existingId = this.opportunityKeys.get(input.opportunityKey);
    if (existingId) {
      const existing = this.liquidations.get(existingId);
      if (existing && existing.status === 'open') return Promise.resolve(existing);
      this.opportunityKeys.delete(input.opportunityKey);
    }
    this.opportunityKeys.set(input.opportunityKey, input.id);
    this.liquidations.set(input.id, input);
    return Promise.resolve(input);
  }

  getLiquidation(id: string): Promise<StoredLiquidation | undefined> {
    return Promise.resolve(this.liquidations.get(id));
  }

  listLiquidations(): Promise<readonly StoredLiquidation[]> {
    return Promise.resolve([...this.liquidations.values()].sort((left, right) => Number(BigInt(left.createdAt) - BigInt(right.createdAt))));
  }

  listOpenLiquidations(): Promise<readonly StoredLiquidation[]> {
    return Promise.resolve([...this.liquidations.values()].filter((liquidation) => liquidation.status === 'open'));
  }

  listBids(rfqId: string): Promise<readonly StoredBid[]> {
    return Promise.resolve((this.bidsByRfq.get(rfqId) ?? []).map((hash) => this.bids.get(hash)).filter((bid): bid is StoredBid => Boolean(bid)));
  }

  insertBid(bid: StoredBid): Promise<void> {
    if (this.bids.has(bid.orderHash)) throw new Error('ORDER_HASH_EXISTS');
    this.bids.set(bid.orderHash, bid);
    const current = this.bidsByRfq.get(bid.rfqId) ?? [];
    current.push(bid.orderHash);
    this.bidsByRfq.set(bid.rfqId, current);
    return Promise.resolve();
  }

  finalizeIfOpen(id: string, route: StoredRoute, bidCount: number): Promise<boolean> {
    const current = this.liquidations.get(id);
    if (!current || current.status !== 'open') return Promise.resolve(false);
    if (this.routes.has(route.rfqId)) return Promise.resolve(false);
    const finalized: StoredLiquidation = {
      ...current,
      status: 'finalized',
      bidCount,
      winner: { identity: route.winner, source: route.source, orderHash: route.orderHash },
      route,
      failureCode: undefined,
    };
    this.liquidations.set(id, finalized);
    this.opportunityKeys.delete(current.opportunityKey);
    this.routes.set(route.rfqId, route);
    return Promise.resolve(true);
  }

  recordFailure(id: string, failureCode: string): Promise<void> {
    const current = this.liquidations.get(id);
    if (current?.status === 'open') this.liquidations.set(id, { ...current, failureCode });
    return Promise.resolve();
  }

  expireIfOpen(id: string): Promise<boolean> {
    const current = this.liquidations.get(id);
    if (!current || current.status !== 'open') return Promise.resolve(false);
    this.liquidations.set(id, { ...current, status: 'expired', failureCode: undefined });
    this.opportunityKeys.delete(current.opportunityKey);
    return Promise.resolve(true);
  }

  registerStandingBid(bid: StoredBid): Promise<void> {
    const owner = bid.maker.toLowerCase();
    const records = this.standing.get(owner) ?? new Map<string, StoredBid>();
    if (records.has(bid.orderHash)) throw new Error('ORDER_HASH_EXISTS');
    records.set(bid.orderHash, bid);
    this.standing.set(owner, records);
    return Promise.resolve();
  }

  revokeStandingBid(owner: Address, orderHash: string): Promise<boolean> {
    const records = this.standing.get(owner.toLowerCase());
    if (!records) return Promise.resolve(false);
    return Promise.resolve(records.delete(orderHash));
  }

  listStandingBids(owner: Address): Promise<readonly StoredBid[]> {
    return Promise.resolve([...(this.standing.get(owner.toLowerCase())?.values() ?? [])]);
  }

  listAllStandingBids(): Promise<readonly StoredBid[]> {
    return Promise.resolve([...this.standing.values()].flatMap((records) => [...records.values()]));
  }

  insertSwapOrder(order: StoredSwapOrder): Promise<void> {
    const key = order.orderHash.toLowerCase();
    if (this.swapOrders.has(key)) throw new Error('ORDER_HASH_EXISTS');
    this.swapOrders.set(key, order);
    return Promise.resolve();
  }

  getSwapOrder(orderHash: string): Promise<StoredSwapOrder | undefined> {
    return Promise.resolve(this.swapOrders.get(orderHash.toLowerCase()));
  }

  listSwapOrders(maker?: Address): Promise<readonly StoredSwapOrder[]> {
    const values = [...this.swapOrders.values()];
    return Promise.resolve(maker ? values.filter((order) => order.maker.toLowerCase() === maker.toLowerCase()) : values);
  }

  revokeSwapOrder(maker: Address, orderHash: string): Promise<boolean> {
    const order = this.swapOrders.get(orderHash.toLowerCase());
    if (!order || order.maker.toLowerCase() !== maker.toLowerCase()) return Promise.resolve(false);
    this.swapOrders.delete(orderHash.toLowerCase());
    return Promise.resolve(true);
  }

  setFacilitySnapshot(snapshot: BaseFacilitySnapshot): void { this.facilitySnapshots.set(snapshot.facility.toLowerCase(), snapshot); }
  setOracleSnapshot(snapshot: BaseOracleSnapshot): void { this.oracleSnapshots.set(snapshot.token.toLowerCase(), snapshot); }
  getFacilitySnapshot(facility: Address): Promise<BaseFacilitySnapshot | undefined> { return Promise.resolve(this.facilitySnapshots.get(facility.toLowerCase())); }
  getOracleSnapshot(token: Address): Promise<BaseOracleSnapshot | undefined> { return Promise.resolve(this.oracleSnapshots.get(token.toLowerCase())); }
}

export class InMemoryClock implements BaseClock {
  constructor(private seconds: bigint) {}

  nowSeconds(): bigint { return this.seconds; }
  nowMilliseconds(): number { return Number(this.seconds) * 1000; }
  set(seconds: bigint): void { this.seconds = seconds; }
  advance(seconds: bigint): void { this.seconds += seconds; }
}

export class InMemoryChainSnapshotPort implements BaseSnapshotPort {
  private readonly snapshots = new Map<string, LiquidationRankInput>();

  set(rfqId: Hex, input: LiquidationRankInput): void { this.snapshots.set(rfqId, input); }

  getForRfq(liquidation: StoredLiquidation, _now: bigint): Promise<LiquidationRankInput> {
    const input = this.snapshots.get(liquidation.rfqId);
    if (!input) return Promise.reject(new Error('SNAPSHOT_UNAVAILABLE'));
    return Promise.resolve(input);
  }
}

export class InMemorySignatureVerificationPort implements BaseSignaturePort {
  private readonly accepted = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly filled = new Map<string, bigint>();
  private readonly delegated = new Set<string>();
  private readonly acceptedSwap = new Set<string>();
  private readonly cancelledSwap = new Set<string>();
  private readonly filledSwap = new Map<string, bigint>();

  accept(orderHash: Hex): void { this.accepted.add(orderHash); }
  cancel(orderHash: Hex): void { this.cancelled.add(orderHash); }
  fill(orderHash: Hex, amount: bigint): void { this.filled.set(orderHash, amount); }
  delegate(maker: Address, signer: Address): void { this.delegated.add(`${maker}:${signer}`); }
  acceptSwap(orderHash: Hex): void { this.acceptedSwap.add(orderHash); }
  cancelSwap(orderHash: Hex): void { this.cancelledSwap.add(orderHash); }
  fillSwap(orderHash: Hex, amount: bigint): void { this.filledSwap.set(orderHash, amount); }

  verifyOrder(order: import('../../../packages/base-core/src/eip712').LiquidationFundingOrder, _signature: Hex, domain: import('../../../packages/base-core/src/eip712').LiquidationFundingDomain): Promise<BaseSignatureVerificationResult> {
    const hash = hashLiquidationFundingOrder(order, domain);
    if (this.accepted.size > 0 && !this.accepted.has(hash)) return Promise.resolve({ valid: false, reason: 'SIGNATURE_INVALID' });
    return Promise.resolve({ valid: true });
  }

  getState(orderHash: Hex): Promise<{ readonly cancelled: boolean; readonly filled: bigint }> {
    return Promise.resolve({ cancelled: this.cancelled.has(orderHash), filled: this.filled.get(orderHash) ?? 0n });
  }

  isDelegatedSigner(maker: Address, signer: Address): Promise<boolean> {
    return Promise.resolve(maker === signer || this.delegated.has(`${maker}:${signer}`));
  }

  verifySwapOrder(order: SwapOrder, _signature: Hex, domain: import('../../../packages/base-core/src/eip712').SwapOrderDomain): Promise<BaseSignatureVerificationResult> {
    const hash = hashSwapOrder(order, domain);
    if (this.acceptedSwap.size > 0 && !this.acceptedSwap.has(hash)) return Promise.resolve({ valid: false, reason: 'SIGNATURE_INVALID' });
    return Promise.resolve({ valid: true });
  }

  getSwapState(orderHash: Hex): Promise<{ readonly cancelled: boolean; readonly filled: bigint }> {
    return Promise.resolve({ cancelled: this.cancelledSwap.has(orderHash), filled: this.filledSwap.get(orderHash) ?? 0n });
  }
}

export class InMemoryNotificationPort implements BaseNotificationPort {
  private readonly values: BaseNotification[] = [];
  private readonly listeners = new Map<string, Set<(notification: BaseNotification) => void>>();

  publish(notification: BaseNotification): void {
    const copy = { ...notification, audience: [...notification.audience], payload: { ...notification.payload } };
    this.values.push(copy);
    for (const identity of copy.audience) {
      for (const listener of this.listeners.get(identity.toLowerCase()) ?? []) listener(copy);
    }
  }

  subscribe(identity: Address, listener: (notification: BaseNotification) => void): () => void {
    const key = identity.toLowerCase();
    const listeners = this.listeners.get(key) ?? new Set<(notification: BaseNotification) => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  all(): readonly BaseNotification[] { return this.values; }

  for(identity: Address): readonly BaseNotification[] {
    return this.values.filter((notification) => notification.audience.includes(identity));
  }
}

export function defaultTestConfig(overrides: Partial<BaseApiConfig> = {}): BaseApiConfig {
  return {
    chainId: 84532,
    domainName: 'Katon RFQ Desk',
    domainVersion: '1',
    routerAddress: '0x0000000000000000000000000000000000000030',
    settlementAddress: '0x0000000000000000000000000000000000000040',
    // Legacy liquidation tests opt in explicitly; production config defaults
    // to false until an official B20 lending market is verified.
    liquidationEnabled: true,
    feeBps: 0n,
    decisionBlockMaxAge: 3n,
    sessionTtlSeconds: 900,
    clockToleranceSeconds: 300,
    trustProxyHops: 1,
    allowInsecureLocal: true,
    botCredentials: [],
    ...overrides,
  };
}
