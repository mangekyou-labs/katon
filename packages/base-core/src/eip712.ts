import { hashTypedData, type Hex } from 'viem';
import type { Address } from './network';

export const EIP712_DOMAIN_NAME = 'KatonRFQSettlement' as const;
export const EIP712_DOMAIN_VERSION = '1' as const;
/**
 * Spot stock orders deliberately use a new settlement domain version.  The
 * liquidation type remains available as a later route type and keeps its
 * v1 digest so old liquidation signatures cannot be silently reinterpreted.
 */
export const SWAP_EIP712_DOMAIN_VERSION = '2' as const;

export interface LiquidationFundingOrder {
  readonly maker: Address;
  readonly signer: Address;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly maxRepayAssets: bigint;
  readonly minCollateralOut: bigint;
  readonly fillMode: number;
  readonly expiry: bigint;
  readonly salt: bigint;
  readonly feeLimitBps: number;
  readonly rfqId: Hex;
  readonly venue: Address;
  readonly marketId: Hex;
}

export interface LiquidationFundingDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface SwapOrder {
  readonly maker: Address;
  readonly signer: Address;
  readonly stockToken: Address;
  readonly usdcToken: Address;
  readonly stockAmount: bigint;
  readonly usdcAmount: bigint;
  /** 0 = fill-or-kill, 1 = proportional/partial. */
  readonly fillMode: number;
  readonly expiry: bigint;
  readonly salt: bigint;
  readonly feeCapBps: number;
  /** Zero address means any taker; otherwise the request taker is bound. */
  readonly allowedTaker: Address;
  /** Zero hash is a reusable standing order; otherwise binds this RFQ. */
  readonly rfqId: Hex;
}

export interface SwapOrderDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export const SWAP_ORDER_TYPES = {
  SwapOrder: [
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'stockToken', type: 'address' },
    { name: 'usdcToken', type: 'address' },
    { name: 'stockAmount', type: 'uint256' },
    { name: 'usdcAmount', type: 'uint256' },
    { name: 'fillMode', type: 'uint8' },
    { name: 'expiry', type: 'uint256' },
    { name: 'salt', type: 'uint256' },
    { name: 'feeCapBps', type: 'uint16' },
    { name: 'allowedTaker', type: 'address' },
    { name: 'rfqId', type: 'bytes32' },
  ],
} as const;

export const LIQUIDATION_FUNDING_ORDER_TYPES = {
  LiquidationFundingOrder: [
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'debtAsset', type: 'address' },
    { name: 'collateralAsset', type: 'address' },
    { name: 'maxRepayAssets', type: 'uint256' },
    { name: 'minCollateralOut', type: 'uint256' },
    { name: 'fillMode', type: 'uint8' },
    { name: 'expiry', type: 'uint256' },
    { name: 'salt', type: 'uint256' },
    { name: 'feeLimitBps', type: 'uint16' },
    { name: 'rfqId', type: 'bytes32' },
    { name: 'venue', type: 'address' },
    { name: 'marketId', type: 'bytes32' },
  ],
} as const;

export function hashLiquidationFundingOrder(
  order: LiquidationFundingOrder,
  domain: LiquidationFundingDomain,
): Hex {
  return hashTypedData({
    domain,
    types: LIQUIDATION_FUNDING_ORDER_TYPES,
    primaryType: 'LiquidationFundingOrder',
    message: order,
  });
}

export function hashSwapOrder(order: SwapOrder, domain: SwapOrderDomain): Hex {
  return hashTypedData({
    domain,
    types: SWAP_ORDER_TYPES,
    primaryType: 'SwapOrder',
    message: order,
  });
}
