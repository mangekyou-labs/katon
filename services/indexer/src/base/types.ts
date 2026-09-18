import type { Address, Hex } from 'viem';

export interface BaseChainEvent {
  readonly chainId: number;
  readonly txHash: Hex | string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash?: Hex | string;
  readonly address: Address | string;
  readonly eventName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface BaseCursor {
  readonly chainId: number;
  readonly address: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly blockHash?: string;
}

export interface BaseRouteExecution {
  readonly eventKey: string;
  readonly chainId: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly rfqId: string;
  readonly winner: string;
  readonly recipient: string;
  readonly adapter: string;
  readonly repayAssets: string;
  readonly collateralSeized: string;
  readonly fee: string;
  readonly blockNumber: string;
}

export interface BaseSwapRouteExecution {
  readonly eventKey: string;
  readonly chainId: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly requestId: string;
  readonly taker: string;
  readonly recipient: string;
  readonly stockToken: string;
  readonly usdcToken: string;
  readonly stockAmount: string;
  readonly boughtUsdc: string;
  readonly fee: string;
  readonly blockNumber: string;
}

export interface BaseLiquidationProjection {
  readonly rfqId: string;
  readonly routeTxHash?: string;
  readonly routeLogIndex?: number;
  readonly winner?: string;
  readonly recipient?: string;
  readonly adapter?: string;
  readonly repayAssets?: string;
  readonly collateralSeized?: string;
  readonly fee?: string;
}

export interface BaseOrderProjection {
  readonly orderHash: string;
  readonly maker?: string;
  readonly status: 'active' | 'filled' | 'cancelled';
  readonly filledAssets: string;
  readonly signerAuthorization: Readonly<Record<string, boolean>>;
  readonly lastEventKey: string;
  readonly kind?: 'LIQUIDATION' | 'SWAP';
  readonly stockToken?: string;
  readonly usdcToken?: string;
  readonly filledStock?: string;
  readonly filledUsdc?: string;
  readonly lastTaker?: string;
}

export interface BaseRedemptionProjection {
  readonly lotId: string;
  readonly token: string;
  readonly amount: string;
  readonly acquisitionCost: string;
  readonly operator: string;
  readonly status: 'booked' | 'settled';
  readonly usdcProceeds?: string;
  readonly realizedPnl?: string;
}

export interface BaseFacilityProjection {
  readonly facility: string;
  readonly curator?: string;
  readonly registered: boolean;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly deposits: string;
  readonly withdrawals: string;
  readonly queuedWithdrawals: string;
  readonly claimedWithdrawals: string;
  /** Request-ID keyed queue state; the map is stable across reloads/replays. */
  readonly withdrawalRequests: Readonly<Record<string, BaseWithdrawalProjection>>;
  readonly allocatedByAdapter: Readonly<Record<string, string>>;
  readonly inventoryByToken: Readonly<Record<string, { readonly amount: string; readonly usdcPaid: string }>>;
  readonly stockPrices: Readonly<Record<string, { readonly priceWad: string; readonly updatedAt: string }>>;
  readonly stockMultipliers: Readonly<Record<string, string>>;
  readonly redemptionLots: Readonly<Record<string, BaseRedemptionProjection>>;
  readonly realizedProfit: string;
  readonly realizedLoss: string;
}

export interface BaseWithdrawalProjection {
  readonly requestId: string;
  readonly owner: string;
  readonly assets: string;
  readonly shares: string;
  readonly claimedAssets?: string;
  readonly status: 'queued' | 'claimed';
  readonly queuedBlock?: string;
  readonly claimedBlock?: string;
}

export interface BaseAnnouncementProjection {
  readonly id: string;
  readonly description: string;
  readonly uri: string;
  readonly caller: string;
  readonly open: boolean;
}

export interface BaseMultiplierProjection {
  readonly oldMultiplier?: string;
  readonly newMultiplier: string;
  readonly effectiveAt?: string;
  readonly source: 'canonical' | 'legacy';
  readonly eventKey: string;
}

export interface BaseTokenProjection {
  readonly token: string;
  readonly pausedFeatures: readonly number[];
  readonly announcements: Readonly<Record<string, BaseAnnouncementProjection>>;
  readonly announcement?: BaseAnnouncementProjection;
  readonly multiplier?: BaseMultiplierProjection;
  readonly multiplierCancellation?: { readonly multiplier: string; readonly effectiveAt: string };
}

export interface BaseProjectionSnapshot {
  readonly routeExecutions: readonly BaseRouteExecution[];
  readonly swapRouteExecutions: readonly BaseSwapRouteExecution[];
  readonly liquidations: Readonly<Record<string, BaseLiquidationProjection>>;
  readonly orders: Readonly<Record<string, BaseOrderProjection>>;
  readonly facilities: Readonly<Record<string, BaseFacilityProjection>>;
  readonly tokens: Readonly<Record<string, BaseTokenProjection>>;
}

export interface BaseCursorStore {
  get(chainId: number, address: string): Promise<BaseCursor | undefined>;
  set(cursor: BaseCursor): Promise<void>;
}

export interface BaseEventProjector {
  apply(events: readonly BaseChainEvent[]): void | Promise<void>;
  snapshot?(): BaseProjectionSnapshot;
  events?(): readonly BaseChainEvent[];
}

export interface BaseProjectionReadModelPort {
  getSnapshot(): Promise<BaseProjectionSnapshot | undefined>;
  getFacilitySnapshot(facility: string): Promise<BaseFacilityProjection | undefined>;
  getOracleSnapshot(token: string): Promise<BaseTokenProjection | undefined>;
}
