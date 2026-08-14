import { hashTypedData, type Address, type Hex } from 'viem';

export type OrderType = 'rfq' | 'limit';
export type FillMode = 'partial' | 'fok';

export interface Order {
  readonly maker: Address;
  readonly taker: Address;
  readonly executor: Address;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly minBuyAmount: bigint;
  readonly expiry: bigint;
  readonly nonce: bigint;
  readonly pairSalt: Hex;
  readonly contextCommitment: Hex;
  readonly orderType: OrderType;
  readonly fillMode: FillMode;
  readonly feeBps: bigint;
}

export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface RouteSource {
  readonly kind: 'lp' | 'facility';
  readonly commitment: string;
  readonly quotedOutput: bigint;
  readonly sequence: bigint;
}

const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'executor', type: 'address' },
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'minBuyAmount', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'pairSalt', type: 'bytes32' },
    { name: 'contextCommitment', type: 'bytes32' },
    { name: 'orderType', type: 'uint8' },
    { name: 'fillMode', type: 'uint8' },
    { name: 'feeBps', type: 'uint16' },
  ],
} as const;

const ORDER_TYPE_CODE: Record<OrderType, number> = { rfq: 0, limit: 1 };
const FILL_MODE_CODE: Record<FillMode, number> = { partial: 0, fok: 1 };
const MAX_UINT64 = (1n << 64n) - 1n;

export function hashOrder(order: Order, domain: Eip712Domain): Hex {
  if (order.expiry < 0n || order.expiry > MAX_UINT64) throw new Error('EXPIRY_WIDTH');
  return hashTypedData({
    domain,
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: {
      maker: order.maker,
      taker: order.taker,
      executor: order.executor,
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      sellAmount: order.sellAmount,
      minBuyAmount: order.minBuyAmount,
      expiry: order.expiry,
      nonce: order.nonce,
      pairSalt: order.pairSalt,
      contextCommitment: order.contextCommitment,
      orderType: ORDER_TYPE_CODE[order.orderType],
      fillMode: FILL_MODE_CODE[order.fillMode],
      feeBps: Number(order.feeBps),
    },
  });
}

export function parseUnitsExact(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals >  stringMaxDecimals()) {
    throw new Error('DECIMAL_SCALE');
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error('DECIMAL_FORMAT');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new Error('DECIMAL_PRECISION');
  }
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function stringMaxDecimals(): number {
  return 255;
}

export function rankSources(sources: readonly RouteSource[]): RouteSource[] {
  return [...sources].sort((left, right) => {
    if (left.quotedOutput !== right.quotedOutput) {
      return left.quotedOutput > right.quotedOutput ? -1 : 1;
    }
    if (left.sequence !== right.sequence) {
      return left.sequence < right.sequence ? -1 : 1;
    }
    if (left.commitment === right.commitment) return 0;
    return left.commitment < right.commitment ? -1 : 1;
  });
}
