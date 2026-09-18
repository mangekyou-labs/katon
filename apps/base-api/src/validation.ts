import type { Address, Hex } from 'viem';
import { SWAP_EIP712_DOMAIN_VERSION, type LiquidationFundingOrder, type SwapOrder } from '../../../packages/base-core/src/eip712';
import type { BaseApiConfig } from './types';

const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export interface LiquidationRequestInput {
  readonly rfqId: Hex;
  readonly borrower: Address;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly marketId: Hex;
  readonly repayAssets: bigint;
  readonly minCollateralOut: bigint;
  readonly deadline: bigint;
  readonly opportunityKey: string;
}

export interface BidRequestInput {
  readonly rfqId: Hex;
  readonly order: LiquidationFundingOrder;
  readonly signature: Hex;
  readonly remainingCapacity: bigint;
  readonly minCollateralOut: bigint;
  readonly adapter: Address;
}

export interface StandingBidRequestInput {
  readonly action: 'register' | 'revoke';
  readonly bid?: Omit<BidRequestInput, 'rfqId'> & { readonly rfqId: Hex };
  readonly orderHash?: Hex;
}

export interface SwapQuoteRequestInput {
  readonly stockToken: Address;
  readonly usdcToken: Address;
  readonly sellAmount: bigint;
  readonly minBuyAmount: bigint;
  readonly taker: Address;
  readonly recipient: Address;
  readonly deadline: bigint;
}

export interface SwapOrderRequestInput {
  readonly action: 'register' | 'revoke';
  readonly order?: SwapOrder;
  readonly signature?: Hex;
  readonly remainingCapacity?: bigint;
  readonly orderHash?: Hex;
}

export function parseSwapOrderRequest(value: unknown): SwapOrderRequestInput {
  const record = recordValue(value);
  if (record.action === 'revoke') {
    exactKeys(record, ['action', 'orderHash'], 'swap-order-revoke');
    return { action: 'revoke', orderHash: hex(record.orderHash, 'orderHash', 32) };
  }
  if (record.action !== 'register') throw new Error('SWAP_ORDER_ACTION_INVALID');
  exactKeys(record, ['action', 'order', 'signature', 'remainingCapacity'], 'swap-order-register');
  const orderRecord = recordValue(record.order);
  exactKeys(orderRecord, ['maker', 'signer', 'stockToken', 'usdcToken', 'stockAmount', 'usdcAmount', 'fillMode', 'expiry', 'salt', 'feeCapBps', 'allowedTaker', 'rfqId'], 'swap-order');
  const fillMode = integer(orderRecord.fillMode, 'order.fillMode');
  const feeCapBps = integer(orderRecord.feeCapBps, 'order.feeCapBps');
  if (fillMode < 0 || fillMode > 1 || feeCapBps < 0 || feeCapBps > 65_535) throw new Error('ORDER_INTEGER_INVALID');
  return {
    action: 'register',
    order: {
      maker: address(orderRecord.maker, 'order.maker'),
      signer: address(orderRecord.signer, 'order.signer'),
      stockToken: address(orderRecord.stockToken, 'order.stockToken'),
      usdcToken: address(orderRecord.usdcToken, 'order.usdcToken'),
      stockAmount: decimal(orderRecord.stockAmount, 'order.stockAmount'),
      usdcAmount: decimal(orderRecord.usdcAmount, 'order.usdcAmount'),
      fillMode,
      expiry: decimal(orderRecord.expiry, 'order.expiry'),
      salt: decimal(orderRecord.salt, 'order.salt'),
      feeCapBps,
      allowedTaker: address(orderRecord.allowedTaker, 'order.allowedTaker'),
      rfqId: hex(orderRecord.rfqId, 'order.rfqId', 32),
    },
    signature: hex(record.signature, 'signature'),
    remainingCapacity: decimal(record.remainingCapacity, 'remainingCapacity'),
  };
}

export function parseSwapQuoteRequest(value: unknown): SwapQuoteRequestInput {
  const record = recordValue(value);
  exactKeys(record, ['stockToken', 'usdcToken', 'sellAmount', 'minBuyAmount', 'taker', 'recipient', 'deadline'], 'swap');
  return {
    stockToken: address(record.stockToken, 'stockToken'),
    usdcToken: address(record.usdcToken, 'usdcToken'),
    sellAmount: decimal(record.sellAmount, 'sellAmount'),
    minBuyAmount: decimal(record.minBuyAmount, 'minBuyAmount'),
    taker: address(record.taker, 'taker'),
    recipient: address(record.recipient, 'recipient'),
    deadline: decimal(record.deadline, 'deadline'),
  };
}

export function parseLiquidationRequest(value: unknown): LiquidationRequestInput {
  const record = recordValue(value);
  exactKeys(record, ['rfqId', 'borrower', 'debtAsset', 'collateralAsset', 'marketId', 'repayAssets', 'minCollateralOut', 'deadline', 'opportunityKey'], 'liquidation');
  return {
    rfqId: hex(record.rfqId, 'rfqId', 32),
    borrower: address(record.borrower, 'borrower'),
    debtAsset: address(record.debtAsset, 'debtAsset'),
    collateralAsset: address(record.collateralAsset, 'collateralAsset'),
    marketId: hex(record.marketId, 'marketId', 32),
    repayAssets: decimal(record.repayAssets, 'repayAssets'),
    minCollateralOut: decimal(record.minCollateralOut, 'minCollateralOut'),
    deadline: decimal(record.deadline, 'deadline'),
    opportunityKey: nonEmptyString(record.opportunityKey, 'opportunityKey'),
  };
}

export function parseBidRequest(value: unknown): BidRequestInput {
  const record = recordValue(value);
  exactKeys(record, ['rfqId', 'order', 'signature', 'remainingCapacity', 'minCollateralOut', 'adapter'], 'bid');
  const orderRecord = recordValue(record.order);
  exactKeys(orderRecord, ['maker', 'signer', 'debtAsset', 'collateralAsset', 'maxRepayAssets', 'minCollateralOut', 'fillMode', 'expiry', 'salt', 'feeLimitBps', 'rfqId', 'venue', 'marketId'], 'order');
  const fillMode = integer(orderRecord.fillMode, 'order.fillMode');
  const feeLimitBps = integer(orderRecord.feeLimitBps, 'order.feeLimitBps');
  if (fillMode < 0 || fillMode > 1 || feeLimitBps < 0 || feeLimitBps > 65535) throw new Error('ORDER_INTEGER_INVALID');
  return {
    rfqId: hex(record.rfqId, 'rfqId', 32),
    order: {
      maker: address(orderRecord.maker, 'order.maker'),
      signer: address(orderRecord.signer, 'order.signer'),
      debtAsset: address(orderRecord.debtAsset, 'order.debtAsset'),
      collateralAsset: address(orderRecord.collateralAsset, 'order.collateralAsset'),
      maxRepayAssets: decimal(orderRecord.maxRepayAssets, 'order.maxRepayAssets'),
      minCollateralOut: decimal(orderRecord.minCollateralOut, 'order.minCollateralOut'),
      fillMode,
      expiry: decimal(orderRecord.expiry, 'order.expiry'),
      salt: decimal(orderRecord.salt, 'order.salt'),
      feeLimitBps,
      rfqId: hex(orderRecord.rfqId, 'order.rfqId', 32),
      venue: address(orderRecord.venue, 'order.venue'),
      marketId: hex(orderRecord.marketId, 'order.marketId', 32),
    },
    signature: hex(record.signature, 'signature'),
    remainingCapacity: decimal(record.remainingCapacity, 'remainingCapacity'),
    minCollateralOut: decimal(record.minCollateralOut, 'minCollateralOut'),
    adapter: address(record.adapter, 'adapter'),
  };
}

export function parseStandingBidRequest(value: unknown): StandingBidRequestInput {
  const record = recordValue(value);
  if (record.action === 'register') {
    exactKeys(record, ['action', 'rfqId', 'order', 'signature', 'remainingCapacity', 'minCollateralOut', 'adapter'], 'standing-bid-register');
    const bidRecord = { ...record };
    delete bidRecord.action;
    const bid = parseBidRequest(bidRecord);
    if (bid.rfqId !== ZERO_HASH || bid.order.rfqId !== ZERO_HASH) throw new Error('STANDING_RFQ_INVALID');
    return { action: 'register', bid };
  }
  if (record.action === 'revoke') {
    exactKeys(record, ['action', 'orderHash'], 'standing-bid-revoke');
    return { action: 'revoke', orderHash: hex(record.orderHash, 'orderHash', 32) };
  }
  throw new Error('STANDING_ACTION_INVALID');
}

export function orderToStored(order: LiquidationFundingOrder): import('./types').StoredFundingOrder {
  return {
    maker: order.maker,
    signer: order.signer,
    debtAsset: order.debtAsset,
    collateralAsset: order.collateralAsset,
    maxRepayAssets: order.maxRepayAssets.toString(10),
    minCollateralOut: order.minCollateralOut.toString(10),
    fillMode: order.fillMode,
    expiry: order.expiry.toString(10),
    salt: order.salt.toString(10),
    feeLimitBps: order.feeLimitBps,
    rfqId: order.rfqId,
    venue: order.venue,
    marketId: order.marketId,
  };
}

export function storedToOrder(order: import('./types').StoredFundingOrder): LiquidationFundingOrder {
  return {
    maker: order.maker,
    signer: order.signer,
    debtAsset: order.debtAsset,
    collateralAsset: order.collateralAsset,
    maxRepayAssets: BigInt(order.maxRepayAssets),
    minCollateralOut: BigInt(order.minCollateralOut),
    fillMode: order.fillMode,
    expiry: BigInt(order.expiry),
    salt: BigInt(order.salt),
    feeLimitBps: order.feeLimitBps,
    rfqId: order.rfqId,
    venue: order.venue,
    marketId: order.marketId,
  };
}

export function domainFor(config: Pick<BaseApiConfig, 'chainId' | 'domainName' | 'domainVersion' | 'settlementAddress'>) {
  return {
    name: 'KatonRFQSettlement',
    version: config.domainVersion,
    chainId: config.chainId,
    verifyingContract: config.settlementAddress,
  } as const;
}

export function swapDomainFor(config: Pick<BaseApiConfig, 'chainId' | 'domainName' | 'swapDomainVersion' | 'settlementAddress'>) {
  const version = config.swapDomainVersion ?? SWAP_EIP712_DOMAIN_VERSION;
  if (version !== SWAP_EIP712_DOMAIN_VERSION) throw new Error('SWAP_DOMAIN_VERSION_INVALID');
  return {
    name: 'KatonRFQSettlement',
    version: SWAP_EIP712_DOMAIN_VERSION,
    chainId: config.chainId,
    verifyingContract: config.settlementAddress,
  } as const;
}

export function swapOrderToStored(order: SwapOrder): import('./types').StoredSwapOrder['order'] {
  return {
    maker: order.maker,
    signer: order.signer,
    stockToken: order.stockToken,
    usdcToken: order.usdcToken,
    stockAmount: order.stockAmount.toString(10),
    usdcAmount: order.usdcAmount.toString(10),
    fillMode: order.fillMode,
    expiry: order.expiry.toString(10),
    salt: order.salt.toString(10),
    feeCapBps: order.feeCapBps,
    allowedTaker: order.allowedTaker,
    rfqId: order.rfqId,
  };
}

export function storedToSwapOrder(order: import('./types').StoredSwapOrder['order']): SwapOrder {
  return {
    maker: order.maker,
    signer: order.signer,
    stockToken: order.stockToken,
    usdcToken: order.usdcToken,
    stockAmount: BigInt(order.stockAmount),
    usdcAmount: BigInt(order.usdcAmount),
    fillMode: order.fillMode,
    expiry: BigInt(order.expiry),
    salt: BigInt(order.salt),
    feeCapBps: order.feeCapBps,
    allowedTaker: order.allowedTaker,
    rfqId: order.rfqId,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('REQUEST_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`REQUEST_FIELD_UNKNOWN:${label}.${unknown}`);
  for (const key of allowed) if (!(key in value)) throw new Error(`REQUEST_FIELD_MISSING:${label}.${key}`);
}

function address(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`ADDRESS_INVALID:${name}`);
  return value.toLowerCase() as Address;
}

function hex(value: unknown, name: string, bytes?: number): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || (bytes !== undefined && value.length !== 2 + bytes * 2) || value.length % 2 !== 0) throw new Error(`HEX_INVALID:${name}`);
  return value.toLowerCase() as Hex;
}

function decimal(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`DECIMAL_INVALID:${name}`);
  return BigInt(value);
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`INTEGER_INVALID:${name}`);
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error(`STRING_INVALID:${name}`);
  return value;
}

export { ZERO_ADDRESS, ZERO_HASH };
