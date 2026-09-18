import type { Address, Hex } from 'viem';
import type { BaseNetwork } from '../../../packages/base-core/src/network';
import type {
  FacilityLiquidationQuote,
  LiquidationFundingDomain,
  LiquidationFundingOrder,
  LiquidationRankInput,
  RankedLiquidationRoute,
  ExternalSwapQuote,
  FacilitySwapQuote,
  MakerSwapQuote,
  SwapQuoteRequest,
} from '../../../packages/base-core/src/index';
import type { SwapOrder } from '../../../packages/base-core/src/eip712';

export type BotScope = 'keeper' | 'lp' | 'internal';
export type AuthKind = 'siwe' | 'bot';

export interface BotCredential {
  readonly id: string;
  readonly secret: string;
  readonly scopes: readonly BotScope[];
  readonly identity?: Address;
}

export interface BaseApiConfig {
  readonly network?: BaseNetwork;
  readonly chainId: number;
  readonly domainName: string;
  readonly domainVersion: string;
  /** Version used by stock swap orders. Defaults to the breaking v2 domain. */
  readonly swapDomainVersion?: string;
  readonly routerAddress: Address;
  readonly settlementAddress: Address;
  /** Canonical native USDC address for the selected Base network. */
  readonly nativeUsdcAddress?: Address;
  readonly facilityAddresses?: readonly Address[];
  readonly oracleGuardAddress?: Address;
  readonly b20GuardAddress?: Address;
  readonly adapterAddresses?: readonly Address[];
  readonly browserOrigins?: readonly string[];
  /** False when the process is running without the required deployment addresses. */
  readonly deploymentConfigured?: boolean;
  /** Mainnet remains behind the rollout gate until production manifests exist. */
  readonly mainnetEnabled?: boolean;
  /** Legacy liquidation routing stays disabled until an official B20 lending market is verified. */
  readonly liquidationEnabled?: boolean;
  /** True only for the loopback Base-mainnet fork QA process. */
  readonly forkQa?: boolean;
  readonly productionEligible?: boolean;
  readonly feeBps: bigint;
  readonly decisionBlockMaxAge: bigint;
  readonly sessionTtlSeconds: number;
  readonly clockToleranceSeconds: number;
  readonly trustProxyHops: number;
  readonly allowInsecureLocal: boolean;
  readonly botCredentials: readonly BotCredential[];
  readonly rpcUrl?: string;
  readonly mongoUri?: string;
  readonly mongoDbName?: string;
  /** Collection window is deliberately fixed to one second unless overridden in tests. */
  readonly swapAuctionWindowMs?: number;
  /** Gas charge used only for off-chain route ranking. */
  readonly conservativeGasUsdc?: bigint;
  /** Optional approved-source endpoints; absent endpoints are not queried. */
  readonly swapMakerQuoteUrl?: string;
  readonly swapFacilityQuoteUrl?: string;
  readonly swapExternalQuoteUrls?: Readonly<Partial<Record<'0x' | '1inch' | 'AERODROME', string>>>;
  readonly swapProviderApiKeys?: Readonly<Partial<Record<'0x' | '1inch' | 'AERODROME', string>>>;
  readonly swapProviderTimeoutMs?: number;
  /** Optional fail-closed wallet eligibility attestation endpoint. */
  readonly eligibilityUrl?: string;
}

export interface BaseAuthContext {
  readonly kind: AuthKind;
  readonly identity: Address;
  readonly scopes: readonly BotScope[];
  readonly credentialId?: string;
}

export interface StoredLiquidation {
  readonly id: string;
  readonly opportunityKey: string;
  readonly rfqId: Hex;
  readonly poster: Address;
  readonly borrower: Address;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly marketId: Hex;
  readonly repayAssets: string;
  readonly minCollateralOut: string;
  readonly deadline: string;
  readonly createdAt: string;
  readonly status: 'open' | 'finalized' | 'expired' | 'failed';
  readonly bidCount?: number;
  readonly winner?: { readonly identity: Address; readonly source: 'LP' | 'FACILITY'; readonly orderHash: Hex };
  readonly failureCode?: string;
  readonly route?: StoredRoute;
}

export interface StoredFundingOrder {
  readonly maker: Address;
  readonly signer: Address;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly maxRepayAssets: string;
  readonly minCollateralOut: string;
  readonly fillMode: number;
  readonly expiry: string;
  readonly salt: string;
  readonly feeLimitBps: number;
  readonly rfqId: Hex;
  readonly venue: Address;
  readonly marketId: Hex;
}

export interface StoredBid {
  readonly orderHash: Hex;
  readonly rfqId: Hex;
  readonly maker: Address;
  readonly order: StoredFundingOrder;
  readonly signature: Hex;
  readonly remainingCapacity: string;
  readonly minCollateralOut: string;
  readonly adapter: Address;
  readonly timestamp: string;
  readonly standing: boolean;
}

/**
 * Seller-private v2 maker order. Amounts stay as decimal strings at the API
 * persistence boundary so Mongo and JSON never coerce uint256 values.
 */
export interface StoredSwapOrder {
  readonly orderHash: Hex;
  readonly maker: Address;
  readonly order: {
    readonly maker: Address;
    readonly signer: Address;
    readonly stockToken: Address;
    readonly usdcToken: Address;
    readonly stockAmount: string;
    readonly usdcAmount: string;
    readonly fillMode: number;
    readonly expiry: string;
    readonly salt: string;
    readonly feeCapBps: number;
    readonly allowedTaker: Address;
    readonly rfqId: Hex;
  };
  readonly signature: Hex;
  readonly remainingCapacity: string;
  readonly timestamp: string;
  readonly standing: boolean;
}

export interface StoredRoute {
  readonly rfqId: Hex;
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: string;
  readonly payloadHash: Hex;
  readonly winner: Address;
  readonly recipient: Address;
  readonly source: 'LP' | 'FACILITY';
  readonly orderHash: Hex;
  readonly decisionBlock: string;
  readonly decisionBlockHash: Hex;
  readonly deadline: string;
  readonly debtAsset?: Address;
  readonly collateralAsset?: Address;
  readonly repayAssets?: string;
  readonly minCollateralOutRfq?: string;
  readonly minCollateralOutFunder?: string;
}

export interface BaseClock {
  nowSeconds(): bigint;
  nowMilliseconds(): number;
}

export interface BaseSnapshotPort {
  getForRfq(liquidation: StoredLiquidation, now: bigint): Promise<LiquidationRankInput>;
  getFacilitySnapshot?(facility: Address): Promise<BaseFacilitySnapshot | undefined>;
  getOracleSnapshot?(token: Address): Promise<BaseOracleSnapshot | undefined>;
}

/** Wallet-bound eligibility proof. The API stores only this opaque identifier. */
export interface EligibilityPort {
  attest(taker: Address, stockToken: Address): Promise<{
    readonly eligible: boolean;
    readonly attestationId?: string;
    readonly expiresAt?: bigint;
  }>;
}

export interface SwapQuoteCollection {
  readonly makerQuotes?: readonly MakerSwapQuote[];
  readonly facilityQuotes?: readonly FacilitySwapQuote[];
  readonly externalQuotes?: readonly ExternalSwapQuote[];
}

export interface BaseSwapTransaction {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** A server-owned decision block and the block used for the read-only call. */
export interface BaseSwapPreflightSnapshot {
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
  readonly simulationBlock: bigint;
  readonly simulationBlockHash: Hex;
}

/** Input to the read-only internal-router simulation seam. */
export interface BaseSwapInternalSimulationRequest {
  readonly request: import('../../../packages/base-core/src/index').SwapQuoteRequest;
  readonly route: import('../../../packages/base-core/src/index').RankedInternalSwapRoute;
  readonly snapshot: BaseSwapPreflightSnapshot;
  readonly allowanceTarget: Address;
  readonly transaction: BaseSwapTransaction;
}

/** Server-owned block pin and complete router transaction preflight. */
export interface BaseSwapPreflightRequest {
  readonly request: import('../../../packages/base-core/src/index').SwapQuoteRequest;
  readonly allowanceTarget: Address;
  readonly buildTransaction: (metadata: {
    readonly decisionBlock: bigint;
    readonly decisionBlockHash: Hex;
  }) => BaseSwapTransaction;
}

export interface BaseSwapPreflightResult {
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
  readonly simulationBlock: bigint;
  readonly simulationBlockHash: Hex;
  readonly allowanceTarget: Address;
}

export interface BaseSwapPreflightPort {
  /** Capture N-1/N and their canonical hashes before ranking executable data. */
  captureSnapshot(): Promise<BaseSwapPreflightSnapshot>;
  /** Validate the serialized router call and exact settlement allowance at N. */
  simulateInternalRoute(input: BaseSwapInternalSimulationRequest): Promise<BaseSwapPreflightResult>;
  /** @deprecated compatibility adapter for pre-M5 in-memory ports only. */
  preflight?(input: BaseSwapPreflightRequest): Promise<BaseSwapPreflightResult>;
}

/**
 * Quote sources are intentionally read-only. Implementations should fan out to
 * approved makers, facilities, and venue APIs in parallel; each quote carries
 * its server receive timestamp so late responses are discarded deterministically.
 */
export interface BaseSwapQuotePort {
  collect?(request: SwapQuoteRequest): Promise<SwapQuoteCollection>;
  getMakerQuotes?(request: SwapQuoteRequest): Promise<readonly MakerSwapQuote[]>;
  getFacilityQuotes?(request: SwapQuoteRequest): Promise<readonly FacilitySwapQuote[]>;
  getExternalQuotes?(request: SwapQuoteRequest): Promise<readonly ExternalSwapQuote[]>;
}

export interface BaseFacilitySnapshot {
  readonly facility: Address;
  readonly curator?: Address;
  readonly registered: boolean;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly deposits: string;
  readonly withdrawals: string;
  readonly queuedWithdrawals: string;
  readonly claimedWithdrawals: string;
  readonly withdrawalRequests?: Readonly<Record<string, {
    readonly requestId: string;
    readonly owner: Address;
    readonly assets: string;
    readonly shares: string;
    readonly claimedAssets?: string;
    readonly status: 'queued' | 'claimed';
    readonly queuedBlock?: string;
    readonly claimedBlock?: string;
  }>>;
  readonly allocatedByAdapter: Readonly<Record<string, string>>;
  readonly inventoryByToken: Readonly<Record<string, { readonly amount: string; readonly usdcPaid: string }>>;
}

export interface BaseOracleSnapshot {
  readonly token: Address;
  readonly pausedFeatures: readonly number[];
  readonly announcements: Readonly<Record<string, {
    readonly id: string;
    readonly description: string;
    readonly uri: string;
    readonly caller: Address;
    readonly open: boolean;
  }>>;
  readonly multiplier?: {
    readonly oldMultiplier?: string;
    readonly newMultiplier: string;
    readonly effectiveAt?: string;
    readonly source: 'canonical' | 'legacy';
    readonly eventKey: string;
  };
  readonly multiplierCancellation?: { readonly multiplier: string; readonly effectiveAt: string };
}

export interface BaseSignatureVerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

export interface BaseSignaturePort {
  verifyOrder(
    order: LiquidationFundingOrder,
    signature: Hex,
    domain: LiquidationFundingDomain,
  ): Promise<BaseSignatureVerificationResult>;
  getState(orderHash: Hex, maker?: Address): Promise<{ readonly cancelled: boolean; readonly filled: bigint }>;
  isDelegatedSigner(maker: Address, signer: Address): Promise<boolean>;
  verifySwapOrder?(
    order: SwapOrder,
    signature: Hex,
    domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: Address },
  ): Promise<BaseSignatureVerificationResult>;
  getSwapState?(orderHash: Hex, maker?: Address): Promise<{ readonly cancelled: boolean; readonly filled: bigint }>;
}

export interface BaseNotification {
  readonly type: 'route_ready' | 'rank_failed' | 'rfq_expired';
  readonly audience: readonly Address[];
  readonly payload: Readonly<Record<string, string>>;
}

export interface BaseNotificationPort {
  publish(notification: BaseNotification): void;
  subscribe?(identity: Address, listener: (notification: BaseNotification) => void): () => void;
}

export interface BaseRouteResponse {
  readonly chainId: string;
  readonly to: Address;
  /** Alias used by browser review screens; the transaction target remains `to`. */
  readonly target: Address;
  readonly data: Hex;
  readonly value: string;
  readonly payloadHash: Hex;
  readonly decisionBlock: string;
  readonly decisionBlockHash: Hex;
  readonly deadline: string;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly repayAssets: string;
  readonly minCollateralOutRfq: string;
  readonly minCollateralOutFunder: string;
  readonly winner: Address;
  readonly source: 'LP' | 'FACILITY';
  readonly recipient: Address;
}

export interface BaseSwapQuoteResponse {
  readonly requestId: Hex;
  readonly chainId: string;
  readonly stockToken: Address;
  readonly usdcToken: Address;
  readonly sellAmount: string;
  readonly minBuyAmount: string;
  readonly taker: Address;
  readonly recipient: Address;
  readonly feeBps: string;
  readonly auctionOpenedAtMs: number;
  readonly auctionCutoffAtMs: number;
  /** Server-owned decision block used to bind route calldata. */
  readonly decisionBlock: string;
  readonly decisionBlockHash: Hex;
  readonly simulationBlock: string;
  readonly simulationBlockHash: Hex;
  readonly eligibility?: { readonly attestationId: string; readonly expiresAt: string };
  readonly recommended?: Readonly<Record<string, unknown>>;
  readonly alternatives: readonly Readonly<Record<string, unknown>>[];
  readonly external: readonly Readonly<Record<string, unknown>>[];
  readonly status: 'WINNER' | 'NO_ROUTE';
  readonly reason?: string;
}

export interface BaseRankedSource {
  readonly route: RankedLiquidationRoute;
  readonly bid?: StoredBid;
  readonly facility?: FacilityLiquidationQuote;
}
