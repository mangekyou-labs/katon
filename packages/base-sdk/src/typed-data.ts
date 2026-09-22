import type {
  LiquidationFundingDomain,
  LiquidationFundingOrder,
  SwapOrder,
} from '../../base-core/src/eip712';
import { LIQUIDATION_FUNDING_ORDER_TYPES, SWAP_ORDER_TYPES, SWAP_EIP712_DOMAIN_VERSION } from '../../base-core/src/eip712';

const EIP712_DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

type FundingOrderTypes = typeof LIQUIDATION_FUNDING_ORDER_TYPES & {
  readonly EIP712Domain: typeof EIP712_DOMAIN_TYPES;
};

export interface FundingOrderTypedData {
  readonly domain: LiquidationFundingDomain;
  readonly types: FundingOrderTypes;
  readonly primaryType: 'LiquidationFundingOrder';
  readonly message: LiquidationFundingOrder;
}

/** Build the RFQ-bound EIP-712 payload without importing the Node-only SDK client. */
export function buildFundingOrderTypedData(
  domain: Pick<LiquidationFundingDomain, 'chainId' | 'verifyingContract'> & Partial<Pick<LiquidationFundingDomain, 'name' | 'version'>>,
  order: LiquidationFundingOrder,
): FundingOrderTypedData {
  return {
    domain: {
      name: domain.name ?? 'KatonRFQSettlement',
      version: domain.version ?? '1',
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    // MetaMask's v4 signer uses the supplied domain type when present. Keep
    // it explicit so the wallet and server use the same EIP-712 domain hash.
    types: { EIP712Domain: EIP712_DOMAIN_TYPES, ...LIQUIDATION_FUNDING_ORDER_TYPES },
    primaryType: 'LiquidationFundingOrder',
    message: order,
  };
}

export interface SwapOrderTypedData {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: `0x${string}`;
  };
  readonly types: typeof SWAP_ORDER_TYPES & { readonly EIP712Domain: typeof EIP712_DOMAIN_TYPES };
  readonly primaryType: 'SwapOrder';
  readonly message: SwapOrder;
}

/** Build a v2 EIP-712 maker order bound to one stock/USDC request. */
export function buildSwapOrderTypedData(
  domain: Pick<LiquidationFundingDomain, 'chainId' | 'verifyingContract'> & Partial<Pick<LiquidationFundingDomain, 'name' | 'version'>>,
  order: SwapOrder,
): SwapOrderTypedData {
  return {
    domain: {
      name: domain.name ?? 'KatonRFQSettlement',
      version: domain.version ?? SWAP_EIP712_DOMAIN_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: { EIP712Domain: EIP712_DOMAIN_TYPES, ...SWAP_ORDER_TYPES },
    primaryType: 'SwapOrder',
    message: order,
  };
}

export { LIQUIDATION_FUNDING_ORDER_TYPES, SWAP_ORDER_TYPES };
