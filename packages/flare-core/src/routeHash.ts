import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

export interface SwapRouteLeg {
  readonly source: Address;
  readonly sellAmount: bigint;
  readonly minOutput: bigint;
  readonly sourceData: Hex;
}

export interface SwapRoutePlan {
  readonly chainId: bigint;
  readonly router: Address;
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
  readonly eligibilityPolicyId: Hex;
  readonly eligibilityRevocationEpoch: bigint;
  readonly eligibilityRole: bigint;
  readonly eligibilityIssuerReference: Hex;
  readonly legs: readonly SwapRouteLeg[];
}

export interface LiquidationRoutePlan {
  readonly chainId: bigint;
  readonly router: Address;
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
  readonly eligibilityPolicyId: Hex;
  readonly eligibilityRevocationEpoch: bigint;
  readonly eligibilityRole: bigint;
  readonly eligibilityIssuerReference: Hex;
}

const SWAP_ROUTE_ABI = [{
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
}] as const;

const LIQUIDATION_ROUTE_ABI = [{
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
}] as const;

/** keccak256(abi.encode(route)) — same bytes as RFQRouter.hashSwapRoute. */
export function hashSwapRoute(route: SwapRoutePlan): Hex {
  if (route.protocolFeeBps < 0 || route.protocolFeeBps > 65_535) throw new Error('FEE_WIDTH');
  if (route.legs.length === 0) throw new Error('ROUTE_LEGS');
  return keccak256(encodeAbiParameters(SWAP_ROUTE_ABI, [route]));
}

/** keccak256(abi.encode(route)) — same bytes as RFQRouter.hashLiquidationRoute. */
export function hashLiquidationRoute(route: LiquidationRoutePlan): Hex {
  if (route.protocolFeeBps < 0 || route.protocolFeeBps > 65_535) throw new Error('FEE_WIDTH');
  return keccak256(encodeAbiParameters(LIQUIDATION_ROUTE_ABI, [route]));
}
