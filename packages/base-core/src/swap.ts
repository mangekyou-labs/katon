import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { SwapOrder } from './eip712';
import type { Address } from './network';

export const SWAP_AUCTION_WINDOW_MS = 1_000 as const;
export const SWAP_MAX_FEE_BPS = 50n;

export type ExternalSwapSource = '0x' | '1inch' | 'AERODROME' | 'COW' | 'RAVE';

export interface SwapQuoteRequest {
  readonly requestId: Hex;
  readonly stockToken: Address;
  readonly usdcToken: Address;
  readonly sellAmount: bigint;
  readonly minBuyAmount: bigint;
  readonly taker: Address;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly now: bigint;
  readonly auctionOpenedAtMs: number;
  readonly auctionCutoffAtMs: number;
  readonly feeBps: bigint;
  /** Expected execution chain for provider packet verification. */
  readonly chainId?: number;
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
}

export interface MakerSwapQuote {
  readonly source: 'LP';
  readonly quoteId: Hex;
  readonly order: SwapOrder;
  readonly signature?: Hex;
  /** Available unfilled stock capacity for this signed order. */
  readonly capacity?: bigint;
  /** Server receive time. A response after the cutoff is never eligible. */
  readonly receivedAtMs: number;
  /** Conservative USDC gas charge used for ranking only. */
  readonly gasEstimateUsdc: bigint;
  readonly guaranteedUsdc?: bigint;
  readonly minUsdcOut?: bigint;
}

export interface FacilitySwapQuote {
  readonly source: 'FACILITY';
  readonly quoteId: Hex;
  readonly facility: Address;
  readonly stockToken: Address;
  readonly usdcToken: Address;
  readonly stockCapacity: bigint;
  /** Price is represented as integer USDC base units per stock base unit. */
  readonly priceNumerator: bigint;
  readonly priceDenominator: bigint;
  readonly expiry: bigint;
  readonly receivedAtMs: number;
  readonly gasEstimateUsdc: bigint;
  readonly guaranteedUsdc?: bigint;
  readonly minUsdcOut?: bigint;
}

export interface ExternalSwapTransaction {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly allowanceTarget?: Address;
  /** Provider-side execution assertions, checked before a packet is executable. */
  readonly chainId?: number;
  readonly recipient?: Address;
  readonly stockToken?: Address;
  readonly usdcToken?: Address;
  readonly sellAmount?: bigint;
  readonly minBuyAmount?: bigint;
  readonly simulation?: {
    readonly ok: boolean;
    readonly block?: bigint;
  };
}

export interface ExternalSwapQuote {
  readonly source: ExternalSwapSource;
  readonly quoteId: Hex;
  readonly stockToken: Address;
  readonly usdcToken: Address;
  readonly stockAmount: bigint;
  readonly usdcAmount: bigint;
  readonly guaranteedUsdc?: bigint;
  readonly gasEstimateUsdc: bigint;
  readonly expiry: bigint;
  readonly receivedAtMs: number;
  /** The provider packet is returned unchanged; Katon never blends it. */
  readonly transaction: ExternalSwapTransaction;
}

export interface SwapAuctionInput {
  readonly request: SwapQuoteRequest;
  readonly makerQuotes: readonly MakerSwapQuote[];
  readonly facilityQuotes: readonly FacilitySwapQuote[];
  readonly externalQuotes: readonly ExternalSwapQuote[];
}

export interface SwapRouteLeg {
  readonly source: 'LP' | 'FACILITY';
  readonly quoteId: Hex;
  readonly liquidity: Address;
  readonly fillAmount: bigint;
  readonly usdcOut: bigint;
  readonly minUsdcOut: bigint;
  readonly expiry: bigint;
  readonly order?: SwapOrder;
  readonly signature?: Hex;
}

export interface RankedInternalSwapRoute {
  readonly kind: 'INTERNAL';
  readonly source: 'KATON';
  readonly routeId: Hex;
  readonly stockAmount: bigint;
  readonly grossUsdc: bigint;
  readonly guaranteedUsdc: bigint;
  readonly fee: bigint;
  readonly gasEstimateUsdc: bigint;
  readonly effectiveUsdc: bigint;
  readonly expiry: bigint;
  readonly legs: readonly SwapRouteLeg[];
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
}

export interface RankedExternalSwapRoute {
  readonly kind: 'EXTERNAL';
  readonly source: ExternalSwapSource;
  readonly routeId: Hex;
  readonly stockAmount: bigint;
  readonly grossUsdc: bigint;
  readonly guaranteedUsdc: bigint;
  readonly fee: bigint;
  readonly gasEstimateUsdc: bigint;
  readonly effectiveUsdc: bigint;
  readonly expiry: bigint;
  readonly transaction: ExternalSwapTransaction;
}

export type RankedSwapRoute = RankedInternalSwapRoute | RankedExternalSwapRoute;

export type SwapRejectReason =
  | 'ASSET_MISMATCH'
  | 'TAKER_MISMATCH'
  | 'RFQ_MISMATCH'
  | 'EXPIRED'
  | 'LATE'
  | 'CAPACITY'
  | 'FEE_CAP'
  | 'INVALID_PRICE'
  | 'MIN_OUT'
  | 'INVALID_AMOUNT';

export interface SwapQuoteRejection {
  readonly source: 'LP' | 'FACILITY' | ExternalSwapSource;
  readonly quoteId: Hex;
  readonly reason: SwapRejectReason;
}

export interface SwapRankResult {
  readonly status: 'WINNER' | 'NO_ROUTE';
  readonly reason?: 'EXPIRED' | 'MIN_OUT' | 'CAPACITY' | 'NO_ELIGIBLE_QUOTE';
  readonly internal?: RankedInternalSwapRoute;
  readonly external: readonly RankedExternalSwapRoute[];
  readonly recommended?: RankedSwapRoute;
  readonly alternatives: readonly RankedSwapRoute[];
  readonly rejections?: readonly SwapQuoteRejection[];
}

interface FillCandidate {
  readonly source: 'LP' | 'FACILITY';
  readonly quoteId: Hex;
  readonly liquidity: Address;
  readonly capacity: bigint;
  readonly unitNumerator: bigint;
  readonly unitDenominator: bigint;
  readonly expiry: bigint;
  readonly gasEstimateUsdc: bigint;
  readonly guaranteedUsdc?: bigint;
  readonly minUsdcOut?: bigint;
  readonly order?: SwapOrder;
  readonly signature?: Hex;
}

/**
 * Rank a one-second stock auction. Internal liquidity is greedily blended by
 * linear price; venue-native alternatives are ranked independently and never
 * enter the internal route.
 */
export function rankSwapQuotes(input: SwapAuctionInput): SwapRankResult {
  validateRequest(input.request);
  const request = input.request;
  const rejections: SwapQuoteRejection[] = [];
  const candidates: FillCandidate[] = [];

  for (const quote of input.makerQuotes) {
    const rejection = validateMakerQuote(quote, request);
    if (rejection) {
      rejections.push({ source: 'LP', quoteId: quote.quoteId, reason: rejection });
      continue;
    }
    candidates.push({
      source: 'LP',
      quoteId: quote.quoteId,
      liquidity: quote.order.maker,
      capacity: quote.capacity ?? quote.order.stockAmount,
      unitNumerator: quote.order.usdcAmount,
      unitDenominator: quote.order.stockAmount,
      expiry: quote.order.expiry,
      gasEstimateUsdc: quote.gasEstimateUsdc,
      guaranteedUsdc: quote.guaranteedUsdc,
      minUsdcOut: quote.minUsdcOut,
      order: quote.order,
      signature: quote.signature,
    });
  }
  for (const quote of input.facilityQuotes) {
    const rejection = validateFacilityQuote(quote, request);
    if (rejection) {
      rejections.push({ source: 'FACILITY', quoteId: quote.quoteId, reason: rejection });
      continue;
    }
    candidates.push({
      source: 'FACILITY',
      quoteId: quote.quoteId,
      liquidity: quote.facility,
      capacity: quote.stockCapacity,
      unitNumerator: quote.priceNumerator,
      unitDenominator: quote.priceDenominator,
      expiry: quote.expiry,
      gasEstimateUsdc: quote.gasEstimateUsdc,
      guaranteedUsdc: quote.guaranteedUsdc,
      minUsdcOut: quote.minUsdcOut,
    });
  }

  candidates.sort(compareCandidates);
  const internal = buildInternalRoute(candidates, request);
  if (internal && internal.guaranteedUsdc < request.minBuyAmount) {
    rejections.push({ source: 'LP', quoteId: internal.routeId, reason: 'MIN_OUT' });
  }

  const external = input.externalQuotes
    .map((quote) => {
      const rejection = validateExternalQuote(quote, request);
      if (rejection) {
        rejections.push({ source: quote.source, quoteId: quote.quoteId, reason: rejection });
        return undefined;
      }
      return buildExternalRoute(quote, request);
    })
    .filter((route): route is RankedExternalSwapRoute => route !== undefined)
    .filter((route) => route.guaranteedUsdc >= request.minBuyAmount)
    .sort(compareRoutes);

  const eligibleInternal = internal && internal.guaranteedUsdc >= request.minBuyAmount ? internal : undefined;
  const routes: RankedSwapRoute[] = [
    ...(eligibleInternal ? [eligibleInternal] : []),
    ...external,
  ].sort(compareRoutes);
  const recommended = routes[0];
  const reason = recommended
    ? undefined
    : internal && internal.guaranteedUsdc < request.minBuyAmount
      ? 'MIN_OUT'
      : candidates.length === 0 && external.length === 0
        ? 'NO_ELIGIBLE_QUOTE'
        : 'CAPACITY';
  return {
    status: recommended ? 'WINNER' : 'NO_ROUTE',
    ...(reason ? { reason } : {}),
    ...(eligibleInternal ? { internal: eligibleInternal } : {}),
    external,
    ...(recommended ? { recommended } : {}),
    alternatives: routes.slice(recommended ? 1 : 0),
    ...(rejections.length > 0 ? { rejections } : {}),
  };
}

/** Alias used by API integrations that call the result a route ranker. */
export const rankSwapRoutes = rankSwapQuotes;
export const buildBestSwapRoute = rankSwapQuotes;

function buildInternalRoute(candidates: readonly FillCandidate[], request: SwapQuoteRequest): RankedInternalSwapRoute | undefined {
  let remaining = request.sellAmount;
  const legs: SwapRouteLeg[] = [];
  let grossUsdc = 0n;
  let gasEstimateUsdc = 0n;
  let expiry = request.deadline;
  for (const candidate of candidates) {
    if (remaining === 0n) break;
    const fillAmount = candidate.capacity < remaining ? candidate.capacity : remaining;
    if (fillAmount === 0n) continue;
    // Fill-or-kill orders are indivisible: a FOK maker may participate only
    // when its entire signed capacity is exactly the remaining request.
    if (candidate.source === 'LP' && candidate.order?.fillMode === 0 && fillAmount !== candidate.capacity) continue;
    const usdcOut = fillAmount * candidate.unitNumerator / candidate.unitDenominator;
    if (usdcOut === 0n) continue;
    const minUsdcOut = candidate.minUsdcOut === undefined
      ? usdcOut
      : candidate.minUsdcOut * fillAmount / candidate.capacity;
    legs.push({
      source: candidate.source,
      quoteId: candidate.quoteId,
      liquidity: candidate.liquidity,
      fillAmount,
      usdcOut,
      minUsdcOut,
      expiry: candidate.expiry,
      ...(candidate.order ? { order: candidate.order } : {}),
      ...(candidate.signature ? { signature: candidate.signature } : {}),
    });
    remaining -= fillAmount;
    grossUsdc += usdcOut;
    gasEstimateUsdc += candidate.gasEstimateUsdc;
    if (candidate.expiry < expiry) expiry = candidate.expiry;
  }
  if (remaining !== 0n) return undefined;
  const fee = grossUsdc * request.feeBps / 10_000n;
  const guaranteedUsdc = grossUsdc - fee;
  const effectiveUsdc = guaranteedUsdc > gasEstimateUsdc ? guaranteedUsdc - gasEstimateUsdc : 0n;
  const routeId = hashSwapRoute({
    kind: 'INTERNAL',
    stockAmount: request.sellAmount,
    grossUsdc,
    guaranteedUsdc,
    fee,
    gasEstimateUsdc,
    effectiveUsdc,
    expiry,
    legs,
    decisionBlock: request.decisionBlock,
    decisionBlockHash: request.decisionBlockHash,
  });
  return {
    kind: 'INTERNAL',
    source: 'KATON',
    routeId,
    stockAmount: request.sellAmount,
    grossUsdc,
    guaranteedUsdc,
    fee,
    gasEstimateUsdc,
    effectiveUsdc,
    expiry,
    legs,
    decisionBlock: request.decisionBlock,
    decisionBlockHash: request.decisionBlockHash,
  };
}

function buildExternalRoute(quote: ExternalSwapQuote, request: SwapQuoteRequest): RankedExternalSwapRoute {
  const grossUsdc = quote.usdcAmount;
  const fee = grossUsdc * request.feeBps / 10_000n;
  const guaranteedUsdc = quote.guaranteedUsdc ?? grossUsdc - fee;
  const effectiveUsdc = guaranteedUsdc > quote.gasEstimateUsdc ? guaranteedUsdc - quote.gasEstimateUsdc : 0n;
  return {
    kind: 'EXTERNAL',
    source: quote.source,
    routeId: quote.quoteId,
    stockAmount: quote.stockAmount,
    grossUsdc,
    guaranteedUsdc,
    fee,
    gasEstimateUsdc: quote.gasEstimateUsdc,
    effectiveUsdc,
    expiry: quote.expiry,
    transaction: quote.transaction,
  };
}

function validateMakerQuote(quote: MakerSwapQuote, request: SwapQuoteRequest): SwapRejectReason | undefined {
  if (quote.order.stockToken.toLowerCase() !== request.stockToken.toLowerCase() || quote.order.usdcToken.toLowerCase() !== request.usdcToken.toLowerCase()) return 'ASSET_MISMATCH';
  if (!isZeroAddress(quote.order.allowedTaker) && quote.order.allowedTaker.toLowerCase() !== request.taker.toLowerCase()) return 'TAKER_MISMATCH';
  if (!isZeroHash(quote.order.rfqId) && quote.order.rfqId.toLowerCase() !== request.requestId.toLowerCase()) return 'RFQ_MISMATCH';
  if (quote.order.expiry <= request.now) return 'EXPIRED';
  if (quote.receivedAtMs > request.auctionCutoffAtMs) return 'LATE';
  if (quote.order.stockAmount <= 0n || quote.order.usdcAmount <= 0n) return 'INVALID_AMOUNT';
  const capacity = quote.capacity ?? quote.order.stockAmount;
  if (capacity <= 0n || capacity > quote.order.stockAmount) return 'CAPACITY';
  if (!Number.isSafeInteger(quote.order.fillMode) || !Number.isSafeInteger(quote.order.feeCapBps)) return 'INVALID_AMOUNT';
  if (quote.order.fillMode < 0 || quote.order.fillMode > 1 || quote.order.feeCapBps < 0 || quote.order.feeCapBps > 65_535) return 'INVALID_AMOUNT';
  if (quote.order.fillMode === 0 && capacity !== quote.order.stockAmount) return 'CAPACITY';
  if (BigInt(quote.order.feeCapBps) < request.feeBps) return 'FEE_CAP';
  if (!quote.signature || quote.signature === '0x') return 'INVALID_AMOUNT';
  if (!Number.isSafeInteger(quote.receivedAtMs) || quote.receivedAtMs < 0) return 'INVALID_AMOUNT';
  if (quote.gasEstimateUsdc < 0n) return 'INVALID_AMOUNT';
  const quotedUsdc = capacity * quote.order.usdcAmount / quote.order.stockAmount;
  if (quote.guaranteedUsdc !== undefined && (quote.guaranteedUsdc < 0n || quote.guaranteedUsdc > quotedUsdc)) return 'INVALID_PRICE';
  if (quote.minUsdcOut !== undefined && (quote.minUsdcOut < 0n || quote.minUsdcOut > quotedUsdc)) return 'MIN_OUT';
  return undefined;
}

function validateFacilityQuote(quote: FacilitySwapQuote, request: SwapQuoteRequest): SwapRejectReason | undefined {
  if (quote.stockToken.toLowerCase() !== request.stockToken.toLowerCase() || quote.usdcToken.toLowerCase() !== request.usdcToken.toLowerCase()) return 'ASSET_MISMATCH';
  if (quote.expiry <= request.now) return 'EXPIRED';
  if (quote.receivedAtMs > request.auctionCutoffAtMs) return 'LATE';
  if (quote.stockCapacity <= 0n || quote.priceNumerator <= 0n || quote.priceDenominator <= 0n) return 'INVALID_PRICE';
  if (!Number.isSafeInteger(quote.receivedAtMs) || quote.receivedAtMs < 0) return 'INVALID_AMOUNT';
  if (quote.gasEstimateUsdc < 0n) return 'INVALID_PRICE';
  const quotedUsdc = quote.stockCapacity * quote.priceNumerator / quote.priceDenominator;
  if (quote.guaranteedUsdc !== undefined && (quote.guaranteedUsdc < 0n || quote.guaranteedUsdc > quotedUsdc)) return 'INVALID_PRICE';
  if (quote.minUsdcOut !== undefined && (quote.minUsdcOut < 0n || quote.minUsdcOut > quotedUsdc)) return 'MIN_OUT';
  return undefined;
}

function validateExternalQuote(quote: ExternalSwapQuote, request: SwapQuoteRequest): SwapRejectReason | undefined {
  if (quote.stockToken.toLowerCase() !== request.stockToken.toLowerCase() || quote.usdcToken.toLowerCase() !== request.usdcToken.toLowerCase()) return 'ASSET_MISMATCH';
  if (quote.expiry <= request.now) return 'EXPIRED';
  if (quote.receivedAtMs > request.auctionCutoffAtMs) return 'LATE';
  if (quote.stockAmount !== request.sellAmount) return 'INVALID_AMOUNT';
  if (quote.usdcAmount <= 0n || quote.gasEstimateUsdc < 0n || quote.transaction.value < 0n) return 'CAPACITY';
  if (isZeroAddress(quote.transaction.to) || quote.transaction.data === '0x') return 'INVALID_AMOUNT';
  if (request.chainId !== undefined) {
    const packet = quote.transaction;
    if (typeof packet.chainId !== 'number' || !Number.isSafeInteger(packet.chainId) || packet.chainId !== request.chainId || !isAddress(packet.recipient) || packet.recipient.toLowerCase() !== request.recipient.toLowerCase()) return 'TAKER_MISMATCH';
    if (!isAddress(packet.stockToken) || packet.stockToken.toLowerCase() !== request.stockToken.toLowerCase() || !isAddress(packet.usdcToken) || packet.usdcToken.toLowerCase() !== request.usdcToken.toLowerCase()) return 'ASSET_MISMATCH';
    if (typeof packet.sellAmount !== 'bigint' || packet.sellAmount !== request.sellAmount) return 'INVALID_AMOUNT';
    if (typeof packet.minBuyAmount !== 'bigint' || packet.minBuyAmount < request.minBuyAmount) return 'MIN_OUT';
    if (!isAddress(packet.allowanceTarget) || isZeroAddress(packet.allowanceTarget)) return 'INVALID_AMOUNT';
  }
  if (quote.guaranteedUsdc !== undefined && (quote.guaranteedUsdc < 0n || quote.guaranteedUsdc > quote.usdcAmount)) return 'INVALID_PRICE';
  return undefined;
}

function compareCandidates(left: FillCandidate, right: FillCandidate): number {
  const leftPrice = left.unitNumerator * right.unitDenominator;
  const rightPrice = right.unitNumerator * left.unitDenominator;
  if (leftPrice !== rightPrice) return leftPrice > rightPrice ? -1 : 1;
  if (left.expiry !== right.expiry) return left.expiry > right.expiry ? -1 : 1;
  return compareHex(left.quoteId, right.quoteId);
}

function compareRoutes(left: RankedSwapRoute, right: RankedSwapRoute): number {
  if (left.effectiveUsdc !== right.effectiveUsdc) return left.effectiveUsdc > right.effectiveUsdc ? -1 : 1;
  if (left.guaranteedUsdc !== right.guaranteedUsdc) return left.guaranteedUsdc > right.guaranteedUsdc ? -1 : 1;
  if (left.expiry !== right.expiry) return left.expiry > right.expiry ? -1 : 1;
  return compareHex(left.routeId, right.routeId);
}

export function hashSwapRoute(route: Pick<RankedInternalSwapRoute, 'stockAmount' | 'grossUsdc' | 'guaranteedUsdc' | 'fee' | 'gasEstimateUsdc' | 'effectiveUsdc' | 'expiry' | 'legs' | 'decisionBlock' | 'decisionBlockHash'> & { readonly kind?: 'INTERNAL' }): Hex {
  const legsHash = keccak256(encodeAbiParameters(
    [{ type: 'bytes32[]' }, { type: 'uint256[]' }, { type: 'uint256[]' }],
    [
      route.legs.map((leg) => leg.quoteId),
      route.legs.map((leg) => leg.fillAmount),
      route.legs.map((leg) => leg.usdcOut),
    ],
  ));
  return keccak256(encodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' },
    ],
    [route.stockAmount, route.grossUsdc, route.guaranteedUsdc, route.fee, route.gasEstimateUsdc, route.effectiveUsdc, route.expiry, keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [legsHash, route.decisionBlockHash]))],
  ));
}

function validateRequest(request: SwapQuoteRequest): void {
  for (const [name, value] of [
    ['sellAmount', request.sellAmount], ['minBuyAmount', request.minBuyAmount], ['deadline', request.deadline],
    ['now', request.now], ['feeBps', request.feeBps], ['decisionBlock', request.decisionBlock],
  ] as const) {
    if (typeof value !== 'bigint' || value < 0n) throw new Error(`INTEGER_ONLY:${name}`);
  }
  if (request.sellAmount === 0n || request.minBuyAmount === 0n || request.deadline <= request.now) throw new Error('INVALID_REQUEST');
  if (request.feeBps > SWAP_MAX_FEE_BPS) throw new Error('FEE_CAP');
  if (request.chainId !== undefined && (!Number.isSafeInteger(request.chainId) || request.chainId <= 0)) throw new Error('CHAIN_ID_INVALID');
  if (request.auctionCutoffAtMs - request.auctionOpenedAtMs !== SWAP_AUCTION_WINDOW_MS) throw new Error('AUCTION_WINDOW_INVALID');
  if (!Number.isSafeInteger(request.auctionOpenedAtMs) || !Number.isSafeInteger(request.auctionCutoffAtMs)) throw new Error('AUCTION_TIME_INVALID');
}

function isZeroAddress(value: Address): boolean { return /^0x0{40}$/i.test(value); }
function isAddress(value: unknown): value is Address { return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value); }
function isZeroHash(value: Hex): boolean { return /^0x0{64}$/i.test(value); }
function compareHex(left: Hex, right: Hex): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a < b ? -1 : 1;
}
