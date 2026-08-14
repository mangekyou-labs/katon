import { encodeAbiParameters, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

import type { FillMode, Order, OrderType } from '../../flare-core/src/index';

export * from './fcc';
export * from './qaAccounts';

export interface StandingBidInput {
  readonly maker: Address;
  readonly taker: Address;
  readonly executor?: Address;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly minBuyAmount: bigint;
  readonly expiry: bigint;
  readonly nonce: bigint;
  readonly pairSalt: Hex;
  readonly contextCommitment?: Hex;
  readonly feeBps: bigint;
}

export interface RouteLegInput {
  readonly source: Address;
  readonly sellAmount: bigint;
  readonly minOutput: bigint;
  readonly sourceData: Hex;
}

export interface RouteInput {
  readonly router: Address;
  readonly chainId: number;
  readonly commitment: Hex;
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
  readonly deadline: bigint;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly minOutput: bigint;
  readonly legs: readonly RouteLegInput[];
}

export interface EligibilityInput {
  readonly eligibilityPolicyId: Hex;
  readonly eligibilityRevocationEpoch: bigint;
  readonly eligibilityRole: bigint;
  readonly eligibilityIssuerReference: Hex;
}

export interface SwapRouteInput extends EligibilityInput {
  readonly router: Address;
  readonly chainId: number;
  readonly commitment: Hex;
  readonly fccActionId: Hex;
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
  readonly deadline: bigint;
  readonly seller: Address;
  readonly recipient: Address;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly minOutput: bigint;
  readonly protocolFeeBps: number;
  readonly legs: readonly RouteLegInput[];
}

export interface LiquidationRouteInput extends EligibilityInput {
  readonly router: Address;
  readonly chainId: number;
  readonly commitment: Hex;
  readonly fccActionId: Hex;
  readonly decisionBlock: bigint;
  readonly decisionBlockHash: Hex;
  readonly deadline: bigint;
  readonly winner: Address;
  readonly recipient: Address;
  readonly venue: Address;
  readonly market: Address;
  readonly position: Hex;
  readonly debtToken: Address;
  readonly collateralToken: Address;
  readonly maxRepay: bigint;
  readonly minNetCollateral: bigint;
  readonly protocolFeeBps: number;
  readonly fundingSource: Address;
  readonly liquidationAdapter: Address;
}

export interface UnsignedRouteTransaction {
  readonly to: Address;
  readonly chainId: number;
  readonly value: bigint;
  readonly data: Hex;
}

export interface SettlementSourceDataInput {
  readonly order: Order;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  readonly signature: Hex;
}

const ROUTER_ABI = [
  {
    type: 'function',
    name: 'executeRoute',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'route',
        type: 'tuple',
        components: [
          { name: 'chainId', type: 'uint256' },
          { name: 'router', type: 'address' },
          { name: 'commitment', type: 'bytes32' },
          { name: 'decisionBlock', type: 'uint256' },
          { name: 'decisionBlockHash', type: 'bytes32' },
          { name: 'deadline', type: 'uint256' },
          { name: 'sellToken', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'minOutput', type: 'uint256' },
          {
            name: 'legs',
            type: 'tuple[]',
            components: [
              { name: 'source', type: 'address' },
              { name: 'sellAmount', type: 'uint256' },
              { name: 'minOutput', type: 'uint256' },
              { name: 'sourceData', type: 'bytes' },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const TYPED_ROUTER_ABI = [
  {
    type: 'function',
    name: 'executeSwapRoute',
    stateMutability: 'nonpayable',
    inputs: [{
      name: 'route',
      type: 'tuple',
      components: [
        { name: 'chainId', type: 'uint256' },
        { name: 'router', type: 'address' },
        { name: 'commitment', type: 'bytes32' },
        { name: 'fccActionId', type: 'bytes32' },
        { name: 'decisionBlock', type: 'uint256' },
        { name: 'decisionBlockHash', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
        { name: 'seller', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'sellToken', type: 'address' },
        { name: 'buyToken', type: 'address' },
        { name: 'sellAmount', type: 'uint256' },
        { name: 'minOutput', type: 'uint256' },
        { name: 'protocolFeeBps', type: 'uint16' },
        { name: 'eligibilityPolicyId', type: 'bytes32' },
        { name: 'eligibilityRevocationEpoch', type: 'uint256' },
        { name: 'eligibilityRole', type: 'uint256' },
        { name: 'eligibilityIssuerReference', type: 'bytes32' },
        {
          name: 'legs',
          type: 'tuple[]',
          components: [
            { name: 'source', type: 'address' },
            { name: 'sellAmount', type: 'uint256' },
            { name: 'minOutput', type: 'uint256' },
            { name: 'sourceData', type: 'bytes' },
          ],
        },
      ],
    }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executeLiquidationRoute',
    stateMutability: 'nonpayable',
    inputs: [{
      name: 'route',
      type: 'tuple',
      components: [
        { name: 'chainId', type: 'uint256' },
        { name: 'router', type: 'address' },
        { name: 'commitment', type: 'bytes32' },
        { name: 'fccActionId', type: 'bytes32' },
        { name: 'decisionBlock', type: 'uint256' },
        { name: 'decisionBlockHash', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
        { name: 'winner', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'venue', type: 'address' },
        { name: 'market', type: 'address' },
        { name: 'position', type: 'bytes32' },
        { name: 'debtToken', type: 'address' },
        { name: 'collateralToken', type: 'address' },
        { name: 'maxRepay', type: 'uint256' },
        { name: 'minNetCollateral', type: 'uint256' },
        { name: 'protocolFeeBps', type: 'uint16' },
        { name: 'fundingSource', type: 'address' },
        { name: 'liquidationAdapter', type: 'address' },
        { name: 'eligibilityPolicyId', type: 'bytes32' },
        { name: 'eligibilityRevocationEpoch', type: 'uint256' },
        { name: 'eligibilityRole', type: 'uint256' },
        { name: 'eligibilityIssuerReference', type: 'bytes32' },
      ],
    }],
    outputs: [],
  },
] as const;

export function createStandingBid(input: StandingBidInput): Order {
  if (input.sellAmount <= 0n || input.minBuyAmount <= 0n) {
    throw new Error('BID_AMOUNT');
  }
  if (getAddress(input.sellToken) === getAddress(input.buyToken)) throw new Error('BID_PAIR');
  if (input.expiry <= 0n) throw new Error('BID_EXPIRY');
  if (input.feeBps < 0n) throw new Error('FEE_TOO_LOW');
  if (input.feeBps > 50n) throw new Error('FEE_TOO_HIGH');
  // Standing bids are public limit orders: open executor/context unless the caller binds them.
  const orderType: OrderType = 'limit';
  const fillMode: FillMode = 'partial';
  const zeroAddress = '0x0000000000000000000000000000000000000000' as Address;
  const zeroBytes32 = `0x${'0'.repeat(64)}` as Hex;
  return {
    maker: input.maker,
    taker: input.taker,
    executor: input.executor ?? zeroAddress,
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    sellAmount: input.sellAmount,
    minBuyAmount: input.minBuyAmount,
    expiry: input.expiry,
    nonce: input.nonce,
    pairSalt: input.pairSalt,
    contextCommitment: input.contextCommitment ?? zeroBytes32,
    feeBps: input.feeBps,
    orderType,
    fillMode,
  };
}

export function buildSettlementSourceData(input: SettlementSourceDataInput): Hex {
  if (input.sellAmount <= 0n || input.buyAmount <= 0n || input.signature === '0x') {
    throw new Error('SETTLEMENT_SOURCE_INPUT');
  }
  if (input.order.orderType !== 'rfq' && input.order.orderType !== 'limit') throw new Error('SETTLEMENT_ORDER_TYPE');
  if (input.order.fillMode !== 'partial' && input.order.fillMode !== 'fok') throw new Error('SETTLEMENT_FILL_MODE');
  return encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        {
          name: 'order',
          type: 'tuple',
          components: [
            { name: 'maker', type: 'address' },
            { name: 'taker', type: 'address' },
            { name: 'executor', type: 'address' },
            { name: 'sellToken', type: 'address' },
            { name: 'buyToken', type: 'address' },
            { name: 'sellAmount', type: 'uint256' },
            { name: 'minBuyAmount', type: 'uint256' },
            { name: 'expiry', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'pairSalt', type: 'bytes32' },
            { name: 'contextCommitment', type: 'bytes32' },
            { name: 'orderType', type: 'uint8' },
            { name: 'fillMode', type: 'uint8' },
            { name: 'feeBps', type: 'uint16' },
          ],
        },
        { name: 'orderSellAmount', type: 'uint256' },
        { name: 'orderBuyAmount', type: 'uint256' },
        { name: 'signature', type: 'bytes' },
      ],
    }],
    [{
      order: {
        maker: input.order.maker,
        taker: input.order.taker,
        executor: input.order.executor,
        sellToken: input.order.sellToken,
        buyToken: input.order.buyToken,
        sellAmount: input.order.sellAmount,
        minBuyAmount: input.order.minBuyAmount,
        expiry: input.order.expiry,
        nonce: input.order.nonce,
        pairSalt: input.order.pairSalt,
        contextCommitment: input.order.contextCommitment,
        orderType: input.order.orderType === 'rfq' ? 0 : 1,
        fillMode: input.order.fillMode === 'partial' ? 0 : 1,
        feeBps: Number(input.order.feeBps),
      },
      orderSellAmount: input.sellAmount,
      orderBuyAmount: input.buyAmount,
      signature: input.signature,
    }],
  );
}

export function buildUnsignedRouteTransaction(route: RouteInput): UnsignedRouteTransaction {
  const zeroCommitment = `0x${'0'.repeat(64)}`;
  const inputTotal = route.legs.reduce((total, leg) => total + leg.sellAmount, 0n);
  if (
    route.chainId <= 0 ||
    route.commitment === zeroCommitment ||
    route.decisionBlock < 0n ||
    route.deadline <= 0n ||
    route.sellAmount <= 0n ||
    route.minOutput <= 0n ||
    inputTotal !== route.sellAmount ||
    route.legs.some((leg) => leg.sellAmount <= 0n || leg.minOutput <= 0n)
  ) {
    throw new Error('ROUTE_INPUT');
  }
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'executeRoute',
    args: [
      {
        chainId: BigInt(route.chainId),
        router: route.router,
        commitment: route.commitment,
        decisionBlock: route.decisionBlock,
        decisionBlockHash: route.decisionBlockHash,
        deadline: route.deadline,
        sellToken: route.sellToken,
        buyToken: route.buyToken,
        sellAmount: route.sellAmount,
        minOutput: route.minOutput,
        legs: route.legs,
      },
    ],
  });
  return {
    to: getAddress(route.router),
    chainId: route.chainId,
    value: 0n,
    data,
  };
}

export function buildUnsignedSwapRouteTransaction(route: SwapRouteInput): UnsignedRouteTransaction {
  assertTypedRoute(route, route.seller, route.recipient);
  const inputTotal = route.legs.reduce((total, leg) => total + leg.sellAmount, 0n);
  if (inputTotal !== route.sellAmount || route.protocolFeeBps < 0 || route.protocolFeeBps > 50) {
    throw new Error('ROUTE_INPUT');
  }
  const data = encodeFunctionData({
    abi: TYPED_ROUTER_ABI,
    functionName: 'executeSwapRoute',
    args: [{ ...route, chainId: BigInt(route.chainId), legs: route.legs }],
  });
  return { to: getAddress(route.router), chainId: route.chainId, value: 0n, data };
}

export function buildUnsignedLiquidationRouteTransaction(
  route: LiquidationRouteInput,
): UnsignedRouteTransaction {
  assertTypedRoute(route, route.winner, route.recipient);
  if (
    route.maxRepay <= 0n
    || route.minNetCollateral <= 0n
    || route.protocolFeeBps < 0
    || route.protocolFeeBps > 50
    || getAddress(route.debtToken) === getAddress(route.collateralToken)
  ) {
    throw new Error('ROUTE_INPUT');
  }
  const data = encodeFunctionData({
    abi: TYPED_ROUTER_ABI,
    functionName: 'executeLiquidationRoute',
    args: [{ ...route, chainId: BigInt(route.chainId) }],
  });
  return { to: getAddress(route.router), chainId: route.chainId, value: 0n, data };
}

export * from './data';

function assertTypedRoute(
  route: EligibilityInput & { readonly router: Address; readonly chainId: number; readonly commitment: Hex; readonly fccActionId: Hex; readonly decisionBlock: bigint; readonly deadline: bigint; readonly minOutput?: bigint; readonly minNetCollateral?: bigint },
  actor: Address,
  recipient: Address,
): void {
  const zero = `0x${'0'.repeat(64)}`;
  if (
    route.chainId <= 0
    || route.commitment === zero
    || route.fccActionId === zero
    || route.decisionBlock < 0n
    || route.deadline <= 0n
    || actor === '0x0000000000000000000000000000000000000000'
    || recipient === '0x0000000000000000000000000000000000000000'
    || route.eligibilityPolicyId === zero
    || route.eligibilityIssuerReference === zero
    || (route.minOutput !== undefined && route.minOutput <= 0n)
    || (route.minNetCollateral !== undefined && route.minNetCollateral <= 0n)
  ) {
    throw new Error('ROUTE_INPUT');
  }
}
