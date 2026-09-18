import type { Address } from 'viem';
import type { BaseFacilitySnapshot, BaseNotification, BaseNotificationPort, BaseOracleSnapshot, BaseSignaturePort, BaseSnapshotPort, StoredBid, StoredLiquidation, StoredRoute, StoredSwapOrder, BaseSwapQuotePort, BaseSwapPreflightPort, EligibilityPort } from './types';

export interface BaseRepository {
  ensureIndexes?(): Promise<void>;
  createLiquidation(input: StoredLiquidation): Promise<StoredLiquidation>;
  getLiquidation(id: string): Promise<StoredLiquidation | undefined>;
  listLiquidations(): Promise<readonly StoredLiquidation[]>;
  listOpenLiquidations(): Promise<readonly StoredLiquidation[]>;
  listBids(rfqId: string): Promise<readonly StoredBid[]>;
  insertBid(bid: StoredBid): Promise<void>;
  finalizeIfOpen(id: string, route: StoredRoute, bidCount: number): Promise<boolean>;
  recordFailure(id: string, failureCode: string): Promise<void>;
  expireIfOpen(id: string): Promise<boolean>;
  registerStandingBid(bid: StoredBid): Promise<void>;
  revokeStandingBid(owner: Address, orderHash: string): Promise<boolean>;
  listStandingBids(owner: Address): Promise<readonly StoredBid[]>;
  /** Returns all registered standing orders for internal candidate evaluation. */
  listAllStandingBids?(): Promise<readonly StoredBid[]>;
  insertSwapOrder?(order: StoredSwapOrder): Promise<void>;
  getSwapOrder?(orderHash: string): Promise<StoredSwapOrder | undefined>;
  listSwapOrders?(maker?: Address): Promise<readonly StoredSwapOrder[]>;
  revokeSwapOrder?(maker: Address, orderHash: string): Promise<boolean>;
  getFacilitySnapshot?(facility: Address): Promise<BaseFacilitySnapshot | undefined>;
  getOracleSnapshot?(token: Address): Promise<BaseOracleSnapshot | undefined>;
}

export interface BaseApiPorts {
  readonly repository: BaseRepository;
  readonly snapshot: BaseSnapshotPort;
  readonly signatures: BaseSignaturePort;
  readonly clock: import('./types').BaseClock;
  readonly notifications: BaseNotificationPort;
  readonly swapQuotes?: BaseSwapQuotePort;
  readonly swapPreflight?: BaseSwapPreflightPort;
  readonly eligibility?: EligibilityPort;
}

export type { BaseFacilitySnapshot, BaseNotification, BaseNotificationPort, BaseOracleSnapshot, BaseSignaturePort, BaseSnapshotPort, StoredBid, StoredLiquidation, StoredRoute };
