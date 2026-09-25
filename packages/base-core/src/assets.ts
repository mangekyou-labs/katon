import type { Address, BaseNetwork } from './network';
import { getBaseNetworkConfig } from './network';

/**
 * Canonical Coinbase B20 tokenized stocks are 8-decimal ERC-20s on Base, verified
 * against live mainnet bytecode. Native USDC stays a 6-decimal asset; the two
 * precisions must never be conflated when scaling stock, oracle, or quote math.
 */
export const B20_STOCK_DECIMALS = 8 as const;

export interface B20Asset {
  readonly ticker: string;
  readonly feed: Address;
  /** Token precision is address keyed; fixtures and deployments may override it. */
  readonly decimals: number;
}

/**
 * Block at which the canonical registry below was verified. Every entry is
 * asserted against live `decimals()`, `symbol()`, and contract code at this
 * block so an upstream token change cannot silently invalidate the registry.
 */
export const B20_CANONICAL_PIN = {
  network: 'mainnet',
  chainId: 8453,
  block: 51_068_301n,
  blockHash: '0x81ceda4cb39bf70b057c08dc2d70b201b5190ecb8ebb79ccdca3e12b1d73ea41',
  verifiedAt: '2026-09-22',
} as const satisfies {
  readonly network: BaseNetwork;
  readonly chainId: 8453 | 84532;
  readonly block: bigint;
  readonly blockHash: Address;
  readonly verifiedAt: string;
};

export const USDBC_ADDRESS: Address = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';

export const B20_ASSETS_BY_ADDRESS = {
  '0xb200000000000000000000C2e324d24d7eEcd1fb': { ticker: 'AAPLc', decimals: 8, feed: '0x787f13dEa48Db0897CbCDD985de77809D837F988' },
  '0xb200000000000000000000d9192b6B456483C2E8': { ticker: 'AMZNc', decimals: 8, feed: '0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295' },
  '0xb200000000000000000000c85a31389D71F3ecfb': { ticker: 'COINc', decimals: 8, feed: '0x408e44f504A7371a345F03a73dDC96A4b48e8aa7' },
  '0xB20000000000000000000019f6E7C675b73C2e4D': { ticker: 'CRCLc', decimals: 8, feed: '0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33' },
  '0xb2000000000000000000002D0BA3164cc74f58B7': { ticker: 'GOOGLc', decimals: 8, feed: '0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2' },
  '0xB2000000000000000000004AFF16039bA04bdFBc': { ticker: 'INTCc', decimals: 8, feed: '0xAB657C39bac0D5886250D70849e2E3E008F2EECB' },
  '0xb2000000000000000000008bC8786B856E61707C': { ticker: 'METAc', decimals: 8, feed: '0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D' },
  '0xB200000000000000000000Ab99cFa739E253872B': { ticker: 'MSFTc', decimals: 8, feed: '0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c' },
  '0xb2000000000000000000004884b426556b92883d': { ticker: 'MSTRc', decimals: 8, feed: '0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a' },
  '0xb20000000000000000000078ee7ce2fE4908108C': { ticker: 'NVDAc', decimals: 8, feed: '0x04689a41629776563E6822F76f2e57D148d28513' },
  '0xb200000000000000000000397293Cb8cda9a10c5': { ticker: 'SNDKc', decimals: 8, feed: '0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA' },
  '0xb2000000000000000000007b9fcbd005511aCBd5': { ticker: 'SPCXc', decimals: 8, feed: '0x6A634B235903C4ad6376892180d6fF8612e3Fa68' },
  '0xb2000000000000000000001e800a7f5189430cD0': { ticker: 'TSLAc', decimals: 8, feed: '0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4' },
} as const satisfies Record<Address, B20Asset>;

const B20_ASSETS_BY_LOWER_ADDRESS = Object.fromEntries(
  Object.entries(B20_ASSETS_BY_ADDRESS).map(([address, asset]) => [address.toLowerCase(), asset]),
) as Record<string, B20Asset>;

export function getB20AssetByAddress(address: string): B20Asset {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('INVALID_B20_ADDRESS');
  }
  const asset = B20_ASSETS_BY_LOWER_ADDRESS[address.toLowerCase()];
  if (!asset) {
    throw new Error('UNKNOWN_B20_ADDRESS');
  }
  return asset;
}

export function getB20DecimalsByAddress(address: string, configured?: Readonly<Record<string, number>>): number {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('INVALID_B20_ADDRESS');
  const override = configured?.[address.toLowerCase()];
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 0 || override > 255) throw new Error('DECIMALS_INVALID');
    return override;
  }
  return getB20AssetByAddress(address).decimals;
}

/** One live observation of a canonical asset, captured at a pinned Base block. */
export interface CanonicalB20Observation {
  readonly address: string;
  readonly ticker?: string;
  readonly symbol?: string;
  readonly decimals: number;
  readonly feed: string;
  readonly hasCode: boolean;
  readonly feedHasCode?: boolean;
}

/**
 * Fail-closed canonical metadata check. Any chain observation that disagrees
 * with the pinned registry — wrong symbol, non-8 decimals, missing bytecode, or
 * a different Chainlink feed — invalidates the asset instead of being coerced.
 */
export function assertCanonicalAssetMetadata(observation: CanonicalB20Observation): B20Asset {
  const asset = getB20AssetByAddress(observation.address);
  const observedTicker = observation.ticker ?? observation.symbol;
  if (!observedTicker) throw new Error('B20_METADATA_MISSING');
  if (observedTicker !== asset.ticker) throw new Error(`B20_SYMBOL_MISMATCH:${observation.address}`);
  if (observation.decimals !== B20_STOCK_DECIMALS) throw new Error(`B20_DECIMALS_MISMATCH:${observation.address}`);
  if (!observation.hasCode) throw new Error(`B20_CODE_MISSING:${observation.address}`);
  if (observation.feed.toLowerCase() !== asset.feed.toLowerCase()) throw new Error(`B20_FEED_MISMATCH:${observation.address}`);
  if (observation.feedHasCode === false) throw new Error(`B20_FEED_CODE_MISSING:${observation.address}`);
  return asset;
}

function assertNativeUsdc(network: BaseNetwork, address: string): Address {
  if (address.toLowerCase() === USDBC_ADDRESS.toLowerCase()) {
    throw new Error('UNSUPPORTED_ASSET:USDbC');
  }
  const nativeUsdc = getBaseNetworkConfig(network).nativeUsdc;
  if (address.toLowerCase() !== nativeUsdc.toLowerCase()) {
    throw new Error('UNSUPPORTED_ASSET');
  }
  return nativeUsdc;
}

export function assertFacilityAsset(network: BaseNetwork, address: string): Address {
  return assertNativeUsdc(network, address);
}

export function assertDebtAsset(network: BaseNetwork, address: string): Address {
  return assertNativeUsdc(network, address);
}
