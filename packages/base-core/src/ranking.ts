import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { hashLiquidationFundingOrder, type LiquidationFundingDomain, type LiquidationFundingOrder } from './eip712';
import type { Address } from './network';

export const WAD = 1_000_000_000_000_000_000n;
export const BPS = 10_000n;

export type RankReason =
  | 'NO_ELIGIBLE_BID'
  | 'FLOOR_NOT_MET'
  | 'ORACLE_UNAVAILABLE'
  | 'SEQUENCER_DOWN'
  | 'B20_PAUSED'
  | 'EXPIRED'
  | 'MIN_OUT'
  | 'CAPACITY'
  | 'ASSET_MISMATCH'
  | 'RFQ_MISMATCH'
  | 'VENUE_MISMATCH'
  | 'MARKET_MISMATCH'
  | 'FEE_LIMIT';

export interface LiquidationRfqSnapshot {
  readonly rfqId: Hex;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly repayAssets: bigint;
  readonly minCollateralOut: bigint;
  readonly deadline: bigint;
  readonly venue?: Address;
  readonly marketId?: Hex;
}

export interface VenueLiquidationSnapshot {
  readonly closeFactorWad: bigint;
  readonly liquidationBonusWad: bigint;
  readonly chainlinkAnswerWad: bigint;
  readonly b20MultiplierWad: bigint;
}

export interface AerodromeFloorSnapshot {
  readonly impliedCollateral: bigint;
  readonly updatedAt: bigint;
  readonly maxAge: bigint;
}

export interface LiquidationBid {
  readonly source: 'LP';
  readonly maker: Address;
  readonly order: LiquidationFundingOrder;
  readonly remainingCapacity: bigint;
  readonly timestamp: bigint;
  readonly minCollateralOut: bigint;
  readonly adapter: Address;
  /** Optional executor authorization is resolved per candidate. */
  readonly executorAuthorized?: boolean;
  /** Optional recipient authorization is resolved per candidate. */
  readonly recipientAuthorized?: boolean;
}

export interface FacilityLiquidationQuote {
  readonly source: 'FACILITY';
  readonly quoteId: Hex;
  readonly facility: Address;
  readonly capacity: bigint;
  readonly haircutWad: bigint;
  readonly minCollateralOut: bigint;
  readonly timestamp: bigint;
  readonly adapter: Address;
  readonly executor?: Address;
  /** Compatibility input only; facility routes always return the facility. */
  readonly recipient?: Address;
  readonly executorAuthorized?: boolean;
  readonly recipientAuthorized?: boolean;
}

export interface LiquidationCandidateAuthorization {
  readonly source: 'LP' | 'FACILITY';
  readonly identity: Address;
  readonly executorAuthorized: boolean;
  readonly recipientAuthorized: boolean;
}

export interface LiquidationRankInput {
  readonly now: bigint;
  readonly nativeUsdc: Address;
  readonly rfq: LiquidationRfqSnapshot;
  readonly venue: VenueLiquidationSnapshot;
  readonly feeBps: bigint;
  readonly aerodrome?: AerodromeFloorSnapshot;
  readonly oracleAvailable: boolean;
  readonly sequencerUp: boolean;
  readonly b20TransferEnabled: boolean;
  readonly b20SeizeEnabled: boolean;
  readonly recipientAuthorized: boolean;
  readonly candidateAuthorizations?: readonly LiquidationCandidateAuthorization[];
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
  readonly domain: LiquidationFundingDomain;
  readonly adapterSlot: Address;
  readonly bids: readonly LiquidationBid[];
  readonly facilityQuotes: readonly FacilityLiquidationQuote[];
}

export interface ComparableLiquidationBid {
  readonly predictedGrossSeize: bigint;
  readonly timestamp: bigint;
  readonly orderHash: Hex;
}

export interface PublicLiquidationView {
  readonly rfqId: Hex;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly tokenBaseUnits: bigint;
  readonly scaledShareEquivalent: bigint;
  readonly repayAssets: bigint;
  readonly minCollateralOut: bigint;
  readonly deadline: bigint;
  readonly status: 'WINNER' | 'NO_ROUTE';
  readonly bidCount?: number;
  readonly winner?: { readonly identity: Address; readonly source: 'LP' | 'FACILITY'; readonly orderHash: Hex };
  readonly aerodromeFloor?: bigint;
}

export interface RankedLiquidationRoute {
  readonly winner: Address;
  readonly recipient: Address;
  readonly source: 'LP' | 'FACILITY';
  readonly orderHash: Hex;
  readonly repayAssets: bigint;
  readonly predictedGrossSeize: bigint;
  readonly predictedNet: bigint;
  readonly fee: bigint;
  readonly rfqMinCollateralOut: bigint;
  readonly funderMinCollateralOut: bigint;
  readonly quoteUsdcCapacity: bigint;
  readonly adapter: Address;
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
}

export interface RankRejection {
  readonly source: 'LP' | 'FACILITY';
  readonly identity: Address;
  readonly reason: RankReason;
}

export interface RankResult {
  readonly status: 'WINNER' | 'NO_ROUTE';
  readonly reason?: RankReason;
  readonly publicView: PublicLiquidationView;
  readonly winner?: RankedLiquidationRoute;
  readonly route?: RankedLiquidationRoute;
  readonly routeHash?: Hex;
  readonly rejections?: readonly RankRejection[];
}

export function mulDiv(numerator: bigint, multiplier: bigint, denominator: bigint): bigint {
  requireBigInt(numerator, 'numerator');
  requireBigInt(multiplier, 'multiplier');
  requireBigInt(denominator, 'denominator');
  if (numerator < 0n || multiplier < 0n || denominator <= 0n) throw new Error('INVALID_MULDIV');
  return numerator * multiplier / denominator;
}

export function compareLiquidationBids(a: ComparableLiquidationBid, b: ComparableLiquidationBid): number {
  requireBigInt(a.predictedGrossSeize, 'predictedGrossSeize');
  requireBigInt(a.timestamp, 'timestamp');
  requireBigInt(b.predictedGrossSeize, 'predictedGrossSeize');
  requireBigInt(b.timestamp, 'timestamp');
  if (a.predictedGrossSeize !== b.predictedGrossSeize) return a.predictedGrossSeize < b.predictedGrossSeize ? -1 : 1;
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return compareHex(a.orderHash, b.orderHash);
}

export function venueSeize(repayAssets: bigint, venue: VenueLiquidationSnapshot): bigint {
  return mulDiv(
    mulDiv(repayAssets, venue.closeFactorWad, WAD),
    venue.liquidationBonusWad,
    WAD,
  ) * venue.chainlinkAnswerWad / WAD;
}

export function rankLiquidation(input: LiquidationRankInput): RankResult {
  validateInput(input);
  const publicBase = {
    rfqId: input.rfq.rfqId,
    debtAsset: input.rfq.debtAsset,
    collateralAsset: input.rfq.collateralAsset,
    tokenBaseUnits: input.rfq.repayAssets,
    scaledShareEquivalent: mulDiv(input.rfq.repayAssets, input.venue.b20MultiplierWad, WAD),
    repayAssets: input.rfq.repayAssets,
    minCollateralOut: input.rfq.minCollateralOut,
    deadline: input.rfq.deadline,
    aerodromeFloor: input.aerodrome?.impliedCollateral,
  };

  if (input.rfq.deadline <= input.now) {
    return { status: 'NO_ROUTE', reason: 'EXPIRED', publicView: { ...publicBase, status: 'NO_ROUTE' } };
  }
  const blockedReason = globalBlockReason(input);
  if (blockedReason) return { status: 'NO_ROUTE', reason: blockedReason, publicView: { ...publicBase, status: 'NO_ROUTE' } };

  const floor = input.aerodrome as AerodromeFloorSnapshot;
  const candidates: InternalCandidate[] = [];
  const rejections: RankRejection[] = [];
  let floorRejected = false;
  let floorPassed = false;

  for (const bid of input.bids) {
    const identity = bid.maker;
    const hash = hashLiquidationFundingOrder(bid.order, input.domain);
    const gross = venueSeize(input.rfq.repayAssets, input.venue);
    const rejection = checkBid(input, bid, gross, floor);
    if (rejection) {
      rejections.push({ source: 'LP', identity, reason: rejection });
      if (rejection === 'FLOOR_NOT_MET') floorRejected = true;
      else if (rejection !== 'EXPIRED' && rejection !== 'CAPACITY') floorPassed = true;
      continue;
    }
    floorPassed = true;
    const authorization = candidateAuthorization(input, 'LP', identity, bid.executorAuthorized, bid.recipientAuthorized);
    if (!authorization.executorAuthorized || !authorization.recipientAuthorized) {
      rejections.push({ source: 'LP', identity, reason: 'B20_PAUSED' });
      continue;
    }
    candidates.push(makeCandidate(input, identity, identity, 'LP', hash, bid.timestamp, bid.minCollateralOut, bid.remainingCapacity, bid.adapter, gross));
  }

  for (const quote of input.facilityQuotes) {
    const identity = quote.executor ?? quote.facility;
    // The facility is both the funding source and the route recipient. The
    // executor is the winning identity, but cannot redirect facility proceeds.
    const recipient = quote.facility;
    const hash = facilityQuoteHash(quote.quoteId, quote.facility);
    const gross = venueSeize(input.rfq.repayAssets, input.venue);
    const quoteCapacity = mulDiv(quote.capacity, WAD - quote.haircutWad, WAD);
    const rejection = checkFacility(input, quote, gross, quoteCapacity, floor);
    if (rejection) {
      rejections.push({ source: 'FACILITY', identity, reason: rejection });
      if (rejection === 'FLOOR_NOT_MET') floorRejected = true;
      else if (rejection !== 'EXPIRED' && rejection !== 'CAPACITY') floorPassed = true;
      continue;
    }
    floorPassed = true;
    const authorization = candidateAuthorization(input, 'FACILITY', identity, quote.executorAuthorized, quote.recipientAuthorized);
    if (!authorization.executorAuthorized || !authorization.recipientAuthorized) {
      rejections.push({ source: 'FACILITY', identity, reason: 'B20_PAUSED' });
      continue;
    }
    candidates.push(makeCandidate(input, identity, recipient, 'FACILITY', hash, quote.timestamp, quote.minCollateralOut, quoteCapacity, quote.adapter, gross));
  }

  if (candidates.length === 0) {
    const reason = floorRejected && !floorPassed ? 'FLOOR_NOT_MET' : 'NO_ELIGIBLE_BID';
    return {
      status: 'NO_ROUTE',
      reason,
      publicView: { ...publicBase, status: 'NO_ROUTE' },
      rejections,
    };
  }

  candidates.sort((a, b) => compareLiquidationBids(a, b));
  const winner = candidates[0];
  const publicView: PublicLiquidationView = {
    ...publicBase,
    status: 'WINNER',
    bidCount: candidates.length,
    winner: { identity: winner.winner, source: winner.source, orderHash: winner.orderHash },
  };
  const route: RankedLiquidationRoute = {
    winner: winner.winner,
    recipient: winner.recipient,
    source: winner.source,
    orderHash: winner.orderHash,
    repayAssets: input.rfq.repayAssets,
    predictedGrossSeize: winner.predictedGrossSeize,
    predictedNet: winner.predictedNet,
    fee: winner.fee,
    rfqMinCollateralOut: input.rfq.minCollateralOut,
    funderMinCollateralOut: winner.funderMinCollateralOut,
    quoteUsdcCapacity: winner.quoteUsdcCapacity,
    adapter: winner.adapter,
    decisionBlock: input.decisionBlock,
    decisionBlockHash: input.decisionBlockHash,
  };
  return {
    status: 'WINNER',
    publicView,
    winner: route,
    route,
    routeHash: hashRoute(route),
    rejections: rejections.length === 0 ? undefined : rejections,
  };
}

function makeCandidate(
  input: LiquidationRankInput,
  winner: Address,
  recipient: Address,
  source: 'LP' | 'FACILITY',
  orderHash: Hex,
  timestamp: bigint,
  funderMinCollateralOut: bigint,
  quoteUsdcCapacity: bigint,
  adapter: Address,
  predictedGrossSeize: bigint,
): InternalCandidate {
  const fee = mulDiv(predictedGrossSeize, input.feeBps, BPS);
  return {
    winner,
    recipient,
    source,
    orderHash,
    timestamp,
    predictedGrossSeize,
    predictedNet: predictedGrossSeize - fee,
    fee,
    funderMinCollateralOut,
    quoteUsdcCapacity,
    adapter,
  };
}

interface InternalCandidate extends ComparableLiquidationBid {
  readonly winner: Address;
  readonly recipient: Address;
  readonly source: 'LP' | 'FACILITY';
  readonly predictedNet: bigint;
  readonly fee: bigint;
  readonly funderMinCollateralOut: bigint;
  readonly quoteUsdcCapacity: bigint;
  readonly adapter: Address;
}

function checkBid(input: LiquidationRankInput, bid: LiquidationBid, gross: bigint, floor: AerodromeFloorSnapshot): RankReason | undefined {
  if (bid.adapter.toLowerCase() !== input.adapterSlot.toLowerCase()) return 'VENUE_MISMATCH';
  if (bid.order.debtAsset !== input.rfq.debtAsset || bid.order.collateralAsset !== input.rfq.collateralAsset) return 'ASSET_MISMATCH';
  if (!isZeroHash(bid.order.rfqId) && bid.order.rfqId !== input.rfq.rfqId) return 'RFQ_MISMATCH';
  if (!isZeroAddress(bid.order.venue) && bid.order.venue.toLowerCase() !== bid.adapter.toLowerCase()) return 'VENUE_MISMATCH';
  if (input.rfq.marketId && !isZeroHash(bid.order.marketId) && bid.order.marketId !== input.rfq.marketId) return 'MARKET_MISMATCH';
  if (bid.order.expiry <= input.now) return 'EXPIRED';
  if (bid.remainingCapacity < input.rfq.repayAssets) return 'CAPACITY';
  if (BigInt(bid.order.feeLimitBps) < input.feeBps) return 'FEE_LIMIT';
  const capacity = bid.minCollateralOut;
  const fee = mulDiv(gross, input.feeBps, BPS);
  if (gross - fee < input.rfq.minCollateralOut || gross - fee < capacity) return 'MIN_OUT';
  if (gross > floor.impliedCollateral) return 'FLOOR_NOT_MET';
  return undefined;
}

function checkFacility(
  input: LiquidationRankInput,
  quote: FacilityLiquidationQuote,
  gross: bigint,
  quoteCapacity: bigint,
  floor: AerodromeFloorSnapshot,
): RankReason | undefined {
  if (quote.adapter.toLowerCase() !== input.adapterSlot.toLowerCase()) return 'VENUE_MISMATCH';
  if (input.rfq.debtAsset !== input.nativeUsdc) return 'ASSET_MISMATCH';
  if (quoteCapacity < input.rfq.repayAssets) return 'CAPACITY';
  const fee = mulDiv(gross, input.feeBps, BPS);
  if (gross - fee < input.rfq.minCollateralOut || gross - fee < quote.minCollateralOut) return 'MIN_OUT';
  if (gross > floor.impliedCollateral) return 'FLOOR_NOT_MET';
  return undefined;
}

function globalBlockReason(input: LiquidationRankInput): RankReason | undefined {
  if (!input.oracleAvailable) return 'ORACLE_UNAVAILABLE';
  if (!input.sequencerUp) return 'SEQUENCER_DOWN';
  if (!input.b20TransferEnabled || !input.b20SeizeEnabled) return 'B20_PAUSED';
  if (input.rfq.debtAsset !== input.nativeUsdc) return 'ASSET_MISMATCH';
  if (!input.aerodrome || input.now < input.aerodrome.updatedAt || input.now - input.aerodrome.updatedAt > input.aerodrome.maxAge) return 'FLOOR_NOT_MET';
  return undefined;
}

export function facilityQuoteHash(quoteId: Hex, facility: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [quoteId, facility]));
}

export function hashLiquidationRoute(route: RankedLiquidationRoute): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'address' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' },
    ],
    [
      route.winner, route.source === 'LP' ? 0 : 1, route.orderHash, route.repayAssets,
      route.predictedGrossSeize, route.predictedNet, route.fee, route.rfqMinCollateralOut,
      route.funderMinCollateralOut, route.adapter, route.decisionBlock, route.decisionBlockHash,
    ],
  ));
}

/** Backward-compatible alias for the pinned route-record hash. */
const hashRoute = hashLiquidationRoute;

function candidateAuthorization(
  input: LiquidationRankInput,
  source: 'LP' | 'FACILITY',
  identity: Address,
  executorAuthorized: boolean | undefined,
  recipientAuthorized: boolean | undefined,
): { readonly executorAuthorized: boolean; readonly recipientAuthorized: boolean } {
  const configured = input.candidateAuthorizations?.find(
    (candidate) => candidate.source === source && candidate.identity.toLowerCase() === identity.toLowerCase(),
  );
  return {
    executorAuthorized: executorAuthorized ?? configured?.executorAuthorized ?? true,
    recipientAuthorized: recipientAuthorized ?? configured?.recipientAuthorized ?? input.recipientAuthorized,
  };
}

function isZeroAddress(value: Address): boolean {
  return /^0x0{40}$/i.test(value);
}

function isZeroHash(value: Hex): boolean {
  return /^0x0{64}$/i.test(value);
}

function validateInput(input: LiquidationRankInput): void {
  const values: readonly [string, unknown][] = [
    ['now', input.now], ['rfq.repayAssets', input.rfq.repayAssets], ['rfq.minCollateralOut', input.rfq.minCollateralOut],
    ['rfq.deadline', input.rfq.deadline], ['venue.closeFactorWad', input.venue.closeFactorWad],
    ['venue.liquidationBonusWad', input.venue.liquidationBonusWad], ['venue.chainlinkAnswerWad', input.venue.chainlinkAnswerWad],
    ['venue.b20MultiplierWad', input.venue.b20MultiplierWad], ['feeBps', input.feeBps],
    ['decisionBlock', input.decisionBlock],
  ];
  for (const [name, value] of values) requireBigInt(value, name);
  requireBigInt(input.venue.b20MultiplierWad, 'venue.b20MultiplierWad');
  if (input.aerodrome) {
    requireBigInt(input.aerodrome.impliedCollateral, 'aerodrome.impliedCollateral');
    requireBigInt(input.aerodrome.updatedAt, 'aerodrome.updatedAt');
    requireBigInt(input.aerodrome.maxAge, 'aerodrome.maxAge');
  }
  for (const bid of input.bids) {
    requireBigInt(bid.remainingCapacity, 'bid.remainingCapacity');
    requireBigInt(bid.timestamp, 'bid.timestamp');
    requireBigInt(bid.minCollateralOut, 'bid.minCollateralOut');
    requireBigInt(bid.order.maxRepayAssets, 'order.maxRepayAssets');
    requireBigInt(bid.order.minCollateralOut, 'order.minCollateralOut');
    requireBigInt(bid.order.expiry, 'order.expiry');
    requireBigInt(bid.order.salt, 'order.salt');
  }
  for (const quote of input.facilityQuotes) {
    requireBigInt(quote.capacity, 'quote.capacity');
    requireBigInt(quote.haircutWad, 'quote.haircutWad');
    requireBigInt(quote.minCollateralOut, 'quote.minCollateralOut');
    requireBigInt(quote.timestamp, 'quote.timestamp');
  }
  if (input.feeBps > 50n || input.feeBps < 0n) throw new Error('FEE_CAP');
  if (input.venue.b20MultiplierWad <= 0n) throw new Error('INVALID_MULTIPLIER');
}

function requireBigInt(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== 'bigint') throw new Error(`INTEGER_ONLY: ${name}`);
}

function compareHex(a: Hex, b: Hex): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left < right ? -1 : 1;
}
