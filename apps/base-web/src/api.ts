import type { Address, Hex } from 'viem';
import { buildFundingOrderTypedData } from '../../../packages/base-sdk/src/typed-data';
import { serializeSignedBid } from '../../../packages/base-sdk/src/dto';
import type { SignedBidDto } from '../../../packages/base-sdk/src/dto';
import type { LiquidationFundingOrder } from '../../../packages/base-core/src/eip712';
import type { BaseWallet } from './wallet';

export interface FacilityDashboardDto {
  readonly address: Address;
  readonly roles: { readonly admin: Address; readonly curator: Address; readonly guardian: Address; readonly executor: Address; readonly router?: Address };
  readonly registered: boolean;
  readonly paused: boolean;
  readonly quotePaused: boolean;
  readonly revoked?: boolean;
  readonly asset: Address;
  readonly nav: string;
  readonly idleAssets: string;
  readonly shares: string;
  readonly haircutWad: string;
  readonly quoteUsdcCapacity: string;
  readonly queue: {
    readonly totalAssets: string;
    readonly totalShares: string;
    readonly requests: readonly WithdrawalDashboardDto[];
  };
  readonly adapterAllocations: Readonly<Record<string, string>>;
  readonly b20Inventory: Readonly<Record<string, { readonly amount: string; readonly usdcPaid: string }>>;
  readonly pinnedBlock: string;
}

export interface WithdrawalDashboardDto {
  readonly requestId: string;
  readonly owner: Address;
  readonly assets: string;
  readonly shares: string;
  readonly claimedAssets?: string;
  readonly status: 'queued' | 'claimed';
  readonly queuedBlock?: string;
  readonly claimedBlock?: string;
}

export interface OracleDashboardDto {
  readonly asset: Address;
  readonly ticker: string;
  readonly feed: Address;
  readonly answer: string;
  readonly answerUpdatedAt: string;
  readonly answerAge: string;
  readonly heartbeat: string;
  readonly fresh: boolean;
  readonly registryPaused: boolean;
  readonly sequencerUp: boolean;
  readonly sequencerStartedAt: string;
  readonly sequencerInGrace: boolean;
  readonly b20PausedFeatures: readonly number[];
  readonly multiplierWad: string;
  readonly announcements: readonly Readonly<Record<string, unknown>>[];
  readonly pinnedBlock: string;
}

export interface PublicLiquidationDto {
  readonly id: string;
  readonly rfqId: Hex;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly marketId: Hex;
  readonly repayAssets: string;
  readonly minCollateralOut: string;
  readonly deadline: string;
  readonly status: 'open' | 'finalized' | 'expired' | 'failed';
  readonly bidCount?: number;
  readonly winner?: { readonly identity: Address; readonly source: 'LP' | 'FACILITY' };
}

export interface RouteDto {
  readonly chainId: string;
  readonly to: Address;
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

/** Seller-private quote bundle returned by the one-second B20 auction. */
export interface StockSaleRouteDto {
  readonly kind: 'INTERNAL' | 'EXTERNAL';
  readonly source: string;
  readonly routeId: Hex;
  readonly stockAmount: string;
  readonly grossUsdc: string;
  readonly guaranteedUsdc: string;
  readonly fee: string;
  readonly gasEstimateUsdc: string;
  readonly effectiveUsdc: string;
  readonly expiry: string;
  readonly decisionBlock?: string;
  readonly decisionBlockHash?: Hex;
  readonly allowanceTarget?: Address;
  readonly settlementAllowanceTarget?: Address;
  readonly transaction?: {
    readonly to: Address;
    readonly data: Hex;
    readonly value: string;
    readonly allowanceTarget?: Address;
    readonly chainId?: number;
    readonly recipient?: Address;
    readonly stockToken?: Address;
    readonly usdcToken?: Address;
    readonly sellAmount?: string;
    readonly minBuyAmount?: string;
  };
  readonly legs?: readonly {
    readonly source: number;
    readonly liquidity: Address;
    readonly stockAmount: string;
    readonly minUsdcOut: string;
    readonly payload: Hex;
  }[];
}

export interface StockSaleQuoteDto {
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
  readonly decisionBlock?: string;
  readonly decisionBlockHash?: Hex;
  readonly simulationBlock: string;
  readonly simulationBlockHash: Hex;
  readonly eligibility?: { readonly attestationId: string; readonly expiresAt: string };
  readonly status: 'WINNER' | 'NO_ROUTE';
  readonly reason?: string;
  readonly recommended?: StockSaleRouteDto;
  readonly alternatives: readonly StockSaleRouteDto[];
  readonly external: readonly StockSaleRouteDto[];
}

export interface BaseEvidenceDto {
  readonly chain: { readonly network: string; readonly chainId: number; readonly qa: string };
  readonly canonical: { readonly status: string; readonly block: string; readonly blockHash: Hex };
  readonly providers: readonly {
    readonly provider: string;
    readonly status: string;
    readonly detail: string;
    readonly httpStatus: number | null;
    readonly block: string | null;
    readonly quoteAgeMs: number | null;
    readonly responseHash: Hex | null;
    readonly transactionReceipt: Hex | null;
  }[];
  readonly redemption: {
    readonly status: string;
    readonly purchaseReceipt: Hex | null;
    readonly receipt: Hex | null;
    readonly block: string | null;
    readonly blockHash: Hex | null;
    readonly realizedPnl: string | null;
  };
  readonly productionEligible: false;
}

export interface SiweNonceDto {
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
  readonly domain: string;
  readonly chainId: number;
}

export interface BrowserSession {
  readonly address: Address;
  readonly sessionToken: string;
}

export class BaseApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BaseApiError';
  }
}

export class BaseBrowserApi {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private session?: BrowserSession;

  constructor(baseUrl = '/', fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    try {
      const origin = typeof window === 'undefined' ? 'http://localhost/' : window.location.origin;
      this.endpoint = new URL(baseUrl, origin);
    } catch {
      throw new BaseApiError('API_ENDPOINT_INVALID');
    }
    this.fetcher = fetcher;
  }

  setSession(session: BrowserSession | undefined): void {
    this.session = session;
  }

  getSession(): BrowserSession | undefined {
    return this.session;
  }

  async getFacilities(): Promise<readonly FacilityDashboardDto[]> {
    const result = await this.request('/v1/facilities');
    if (!Array.isArray(result)) throw new BaseApiError('DASHBOARD_RESPONSE_INVALID');
    return result as FacilityDashboardDto[];
  }

  async getFacility(address: Address): Promise<FacilityDashboardDto> {
    return this.request(`/v1/facilities/${address}`) as Promise<FacilityDashboardDto>;
  }

  async getOracle(asset: Address): Promise<OracleDashboardDto> {
    return this.request(`/v1/oracles/${asset}`) as Promise<OracleDashboardDto>;
  }

  async getLiquidations(): Promise<readonly PublicLiquidationDto[]> {
    const result = await this.request('/v1/liquidations');
    if (!Array.isArray(result)) throw new BaseApiError('LIQUIDATION_RESPONSE_INVALID');
    return result as PublicLiquidationDto[];
  }

  async getLiquidation(id: string): Promise<PublicLiquidationDto> {
    return this.request(`/v1/liquidations/${encodeURIComponent(id)}`) as Promise<PublicLiquidationDto>;
  }

  async getWinnerRoute(id: string): Promise<RouteDto> {
    return this.request(`/v1/liquidations/${encodeURIComponent(id)}/route`, true) as Promise<RouteDto>;
  }

  async quoteStockSale(input: {
    readonly stockToken: Address;
    readonly usdcToken: Address;
    readonly sellAmount: bigint;
    readonly minBuyAmount: bigint;
    readonly taker: Address;
    readonly recipient: Address;
    readonly deadline: bigint;
  }): Promise<StockSaleQuoteDto> {
    const result = await this.request('/v1/swaps/quote', true, {
      method: 'POST',
      body: JSON.stringify({
        stockToken: input.stockToken,
        usdcToken: input.usdcToken,
        sellAmount: input.sellAmount.toString(10),
        minBuyAmount: input.minBuyAmount.toString(10),
        taker: input.taker,
        recipient: input.recipient,
        deadline: input.deadline.toString(10),
      }),
    });
    return parseStockSaleQuote(result);
  }

  async getEvidence(): Promise<BaseEvidenceDto> {
    return this.request('/v1/evidence') as Promise<BaseEvidenceDto>;
  }

  async getNonce(): Promise<SiweNonceDto> {
    return this.request('/v1/auth/nonce') as Promise<SiweNonceDto>;
  }

  async verifySiwe(message: string, signature: Hex): Promise<BrowserSession> {
    const result = await this.request('/v1/auth/verify', false, {
      method: 'POST',
      body: JSON.stringify({ message, signature }),
    }) as Record<string, unknown>;
    if (typeof result.address !== 'string' || typeof result.sessionToken !== 'string') throw new BaseApiError('SESSION_RESPONSE_INVALID');
    const session = { address: result.address.toLowerCase() as Address, sessionToken: result.sessionToken };
    this.session = session;
    return session;
  }

  async postBid(bid: SignedBidDto): Promise<unknown> {
    return this.request('/v1/bids', true, { method: 'POST', body: JSON.stringify(serializeSignedBid(bid)) });
  }

  async pollWinnerRoute(id: string, options: { readonly intervalMs?: number; readonly maxAttempts?: number } = {}): Promise<RouteDto> {
    const intervalMs = options.intervalMs ?? 2_000;
    const maxAttempts = options.maxAttempts ?? 30;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.getWinnerRoute(id);
      } catch (error) {
        if (!(error instanceof BaseApiError) || !['ROUTE_NOT_READY', 'UNAUTHORIZED', 'RFQ_NOT_FOUND'].includes(error.code)) throw error;
      }
      if (attempt + 1 < maxAttempts && intervalMs > 0) await delay(intervalMs);
    }
    throw new BaseApiError('ROUTE_POLL_TIMEOUT');
  }

  private async request(path: string, authenticatedOrInit: boolean | RequestInit = false, maybeInit?: RequestInit): Promise<unknown> {
    const authenticated = typeof authenticatedOrInit === 'boolean' ? authenticatedOrInit : false;
    const init = typeof authenticatedOrInit === 'boolean' ? maybeInit : authenticatedOrInit;
    const url = new URL(path.replace(/^\//, ''), this.endpoint.href.endsWith('/') ? this.endpoint.href : `${this.endpoint.href}/`);
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    if (init?.body !== undefined) headers.set('content-type', 'application/json');
    if (authenticated) {
      if (!this.session) throw new BaseApiError('AUTH_REQUIRED');
      headers.set('authorization', `Bearer ${this.session.sessionToken}`);
    }
    const response = await this.fetcher(url.toString(), { ...init, headers });
    const text = await response.text();
    let payload: unknown;
    if (text) {
      try { payload = JSON.parse(text); } catch { throw new BaseApiError('API_RESPONSE_INVALID'); }
    }
    if (!response.ok) {
      const code = payload && typeof payload === 'object' && 'code' in payload ? String((payload as { code: unknown }).code) : `HTTP_${response.status}`;
      throw new BaseApiError(code);
    }
    return payload;
  }
}

function parseStockSaleQuote(value: unknown): StockSaleQuoteDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  const record = value as Record<string, unknown>;
  if (record.status !== 'WINNER' && record.status !== 'NO_ROUTE') throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  if (!Array.isArray(record.alternatives) || !Array.isArray(record.external)) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  if (typeof record.simulationBlock !== 'string' || !/^(0|[1-9]\d*)$/.test(record.simulationBlock) || typeof record.simulationBlockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(record.simulationBlockHash)) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  if (record.decisionBlock !== undefined && (typeof record.decisionBlock !== 'string' || !/^(0|[1-9]\d*)$/.test(record.decisionBlock))) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  if (record.decisionBlockHash !== undefined && (typeof record.decisionBlockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(record.decisionBlockHash))) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  if (record.status === 'WINNER' && (
    !positiveDecimal(record.decisionBlock)
    || !nonzeroHash(record.decisionBlockHash)
    || !positiveDecimal(record.simulationBlock)
    || !nonzeroHash(record.simulationBlockHash)
  )) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  const recommended = record.recommended === undefined ? undefined : parseStockSaleRoute(record.recommended);
  const alternatives = record.alternatives.map(parseStockSaleRoute);
  const external = record.external.map(parseStockSaleRoute);
  if (typeof record.requestId !== 'string' || typeof record.stockToken !== 'string' || typeof record.usdcToken !== 'string') throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  return { ...record, ...(recommended ? { recommended } : {}), alternatives, external } as unknown as StockSaleQuoteDto;
}

function parseStockSaleRoute(value: unknown): StockSaleRouteDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  const record = value as Record<string, unknown>;
  const required = ['kind', 'source', 'routeId', 'stockAmount', 'grossUsdc', 'guaranteedUsdc', 'fee', 'gasEstimateUsdc', 'effectiveUsdc', 'expiry', 'decisionBlock', 'decisionBlockHash'];
  if (required.some((key) => typeof record[key] !== 'string')) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  if (record.kind !== 'INTERNAL' && record.kind !== 'EXTERNAL') throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  if (!positiveDecimal(record.decisionBlock) || !nonzeroHash(record.decisionBlockHash)) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
  if (record.transaction !== undefined) {
    const transaction = record.transaction;
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
    const tx = transaction as Record<string, unknown>;
    if (typeof tx.to !== 'string' || typeof tx.data !== 'string' || typeof tx.value !== 'string') throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
    if (tx.chainId !== undefined && (typeof tx.chainId !== 'number' || !Number.isSafeInteger(tx.chainId) || tx.chainId <= 0)) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
    for (const key of ['recipient', 'stockToken', 'usdcToken'] as const) {
      if (tx[key] !== undefined && typeof tx[key] !== 'string') throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
    }
    for (const key of ['sellAmount', 'minBuyAmount'] as const) {
      if (tx[key] !== undefined && (typeof tx[key] !== 'string' || !/^(0|[1-9]\d*)$/.test(tx[key]))) throw new BaseApiError('SWAP_QUOTE_RESPONSE_INVALID');
    }
    if ('simulation' in tx || 'simulationBlock' in tx || 'simulationBlockHash' in tx) throw new BaseApiError('SWAP_PROVIDER_METADATA_FORBIDDEN');
  }
  return record as unknown as StockSaleRouteDto;
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function nonzeroHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value);
}

export async function signInWithWallet(api: BaseBrowserApi, wallet: BaseWallet): Promise<BrowserSession> {
  const address = wallet.assertWritable();
  const nonce = await api.getNonce();
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const message = buildSiweMessage(nonce, address, origin);
  const signature = await wallet.signMessage(message);
  return api.verifySiwe(message, signature);
}

export function buildSiweMessage(nonce: SiweNonceDto, address: Address, origin: string): string {
  return `${nonce.domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Katon Base.\n\nURI: ${origin}/\nVersion: 1\nChain ID: ${nonce.chainId}\nNonce: ${nonce.nonce}\nIssued At: ${nonce.issuedAt}\nExpiration Time: ${nonce.expirationTime}`;
}

export function buildRfqFundingOrder(input: {
  readonly rfq: PublicLiquidationDto;
  readonly maker: Address;
  readonly adapter: Address;
  readonly settlement: Address;
  readonly nowSeconds?: bigint;
}): LiquidationFundingOrder {
  const expiry = BigInt(input.rfq.deadline);
  const now = input.nowSeconds ?? BigInt(Math.floor(Date.now() / 1_000));
  if (expiry <= now) throw new BaseApiError('RFQ_EXPIRED');
  return {
    maker: input.maker,
    signer: input.maker,
    debtAsset: input.rfq.debtAsset,
    collateralAsset: input.rfq.collateralAsset,
    maxRepayAssets: BigInt(input.rfq.repayAssets),
    minCollateralOut: BigInt(input.rfq.minCollateralOut),
    fillMode: 0,
    expiry,
    salt: randomSalt(),
    feeLimitBps: 65_535,
    rfqId: input.rfq.rfqId,
    venue: input.adapter,
    marketId: input.rfq.marketId,
  };
}

export function fundingOrderTypedData(order: LiquidationFundingOrder, chainId: number, settlement: Address) {
  return buildFundingOrderTypedData({ chainId, verifyingContract: settlement }, order);
}

export async function signFundingBid(
  wallet: BaseWallet,
  input: { readonly rfq: PublicLiquidationDto; readonly adapter: Address; readonly chainId: number; readonly settlement: Address },
): Promise<SignedBidDto> {
  const maker = wallet.assertWritable();
  const order = buildRfqFundingOrder({ ...input, maker });
  const typed = fundingOrderTypedData(order, input.chainId, input.settlement);
  const signature = await wallet.signTypedDataV4(stringifyBigints(typed));
  return {
    rfqId: input.rfq.rfqId,
    order,
    signature,
    remainingCapacity: order.maxRepayAssets,
    minCollateralOut: order.minCollateralOut,
    adapter: input.adapter,
  };
}

function stringifyBigints(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'bigint' ? entry.toString(10) : entry);
}

function randomSalt(): bigint {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return BigInt(`0x${Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('')}`);
  }
  return BigInt(Date.now());
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
