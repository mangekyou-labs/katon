import type { Address, Hex } from 'viem';
import type { LiquidationFundingOrder } from '../../base-core/src/eip712';
import type { SwapOrder } from '../../base-core/src/eip712';

export interface SignedBidDto {
  readonly rfqId: Hex;
  readonly order: LiquidationFundingOrder;
  readonly signature: Hex;
  readonly remainingCapacity: bigint;
  readonly minCollateralOut: bigint;
  readonly adapter: Address;
}

export interface StandingBidDto extends SignedBidDto {
  readonly orderHash?: Hex;
  readonly maker?: Address;
  readonly timestamp?: bigint;
}

export interface SignedSwapOrderDto {
  readonly order: SwapOrder;
  readonly signature: Hex;
}

export function serializeSwapOrder(order: SwapOrder): Record<string, unknown> {
  return {
    maker: order.maker,
    signer: order.signer,
    stockToken: order.stockToken,
    usdcToken: order.usdcToken,
    stockAmount: decimal(order.stockAmount),
    usdcAmount: decimal(order.usdcAmount),
    fillMode: order.fillMode,
    expiry: decimal(order.expiry),
    salt: decimal(order.salt),
    feeCapBps: order.feeCapBps,
    allowedTaker: order.allowedTaker,
    rfqId: order.rfqId,
  };
}

export function serializeSignedSwapOrder(input: SignedSwapOrderDto): Record<string, unknown> {
  return { order: serializeSwapOrder(input.order), signature: input.signature };
}

export function deserializeSwapOrder(value: unknown): SwapOrder {
  if (!value || typeof value !== 'object') throw new Error('SDK_RESPONSE_INVALID');
  const record = value as Record<string, unknown>;
  return {
    maker: address(record.maker),
    signer: address(record.signer),
    stockToken: address(record.stockToken),
    usdcToken: address(record.usdcToken),
    stockAmount: decimalBigint(record.stockAmount),
    usdcAmount: decimalBigint(record.usdcAmount),
    fillMode: integer(record.fillMode),
    expiry: decimalBigint(record.expiry),
    salt: decimalBigint(record.salt),
    feeCapBps: integer(record.feeCapBps),
    allowedTaker: address(record.allowedTaker),
    rfqId: hex(record.rfqId),
  };
}

export function serializeSignedBid(input: SignedBidDto): Record<string, unknown> {
  return {
    rfqId: input.rfqId,
    order: serializeOrder(input.order),
    signature: input.signature,
    remainingCapacity: decimal(input.remainingCapacity),
    minCollateralOut: decimal(input.minCollateralOut),
    adapter: input.adapter,
  };
}

export function serializeOrder(order: LiquidationFundingOrder): Record<string, unknown> {
  return {
    maker: order.maker,
    signer: order.signer,
    debtAsset: order.debtAsset,
    collateralAsset: order.collateralAsset,
    maxRepayAssets: decimal(order.maxRepayAssets),
    minCollateralOut: decimal(order.minCollateralOut),
    fillMode: order.fillMode,
    expiry: decimal(order.expiry),
    salt: decimal(order.salt),
    feeLimitBps: order.feeLimitBps,
    rfqId: order.rfqId,
    venue: order.venue,
    marketId: order.marketId,
  };
}

export function deserializeStandingBid(value: unknown): StandingBidDto {
  if (!value || typeof value !== 'object') throw new Error('SDK_RESPONSE_INVALID');
  const record = value as Record<string, unknown>;
  const orderRecord = record.order;
  if (!orderRecord || typeof orderRecord !== 'object') throw new Error('SDK_RESPONSE_INVALID');
  const order = orderRecord as Record<string, unknown>;
  return {
    orderHash: hex(record.orderHash),
    maker: address(record.maker),
    rfqId: hex(record.rfqId),
    order: {
      maker: address(order.maker),
      signer: address(order.signer),
      debtAsset: address(order.debtAsset),
      collateralAsset: address(order.collateralAsset),
      maxRepayAssets: decimalBigint(order.maxRepayAssets),
      minCollateralOut: decimalBigint(order.minCollateralOut),
      fillMode: integer(order.fillMode),
      expiry: decimalBigint(order.expiry),
      salt: decimalBigint(order.salt),
      feeLimitBps: integer(order.feeLimitBps),
      rfqId: hex(order.rfqId),
      venue: address(order.venue),
      marketId: hex(order.marketId),
    },
    signature: hex(record.signature),
    remainingCapacity: decimalBigint(record.remainingCapacity),
    minCollateralOut: decimalBigint(record.minCollateralOut),
    adapter: address(record.adapter),
    ...(record.timestamp !== undefined ? { timestamp: decimalBigint(record.timestamp) } : {}),
  };
}

function decimal(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('SDK_INTEGER_INVALID');
  return value.toString(10);
}

function decimalBigint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('SDK_RESPONSE_INVALID');
  return BigInt(value);
}

function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('SDK_RESPONSE_INVALID');
  return value.toLowerCase() as Address;
}

function hex(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) throw new Error('SDK_RESPONSE_INVALID');
  return value.toLowerCase() as Hex;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('SDK_RESPONSE_INVALID');
  return value;
}
