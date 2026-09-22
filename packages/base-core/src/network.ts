import { B20_SYSTEM_CONTRACTS } from './b20';

export type Address = `0x${string}`;
export type BaseNetwork = 'sepolia' | 'mainnet';
export const DEFAULT_SEQUENCER_GRACE_PERIOD_SECONDS = 3600;

export interface BaseNetworkConfig {
  readonly key: BaseNetwork;
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly nativeUsdc: Address;
  readonly sequencerFeed: Address;
  readonly sequencerGracePeriodSeconds: number;
  readonly b20Factory: Address;
  readonly policyRegistry: Address;
  readonly activationRegistry: Address;
}

const NETWORKS: Record<BaseNetwork, BaseNetworkConfig> = {
  sepolia: {
    key: 'sepolia',
    chainId: 84532,
    name: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    nativeUsdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    sequencerFeed: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433',
    sequencerGracePeriodSeconds: DEFAULT_SEQUENCER_GRACE_PERIOD_SECONDS,
    ...B20_SYSTEM_CONTRACTS,
  },
  mainnet: {
    key: 'mainnet',
    chainId: 8453,
    name: 'Base Mainnet',
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    nativeUsdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    sequencerFeed: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433',
    sequencerGracePeriodSeconds: DEFAULT_SEQUENCER_GRACE_PERIOD_SECONDS,
    ...B20_SYSTEM_CONTRACTS,
  },
};

export function getBaseNetworkConfig(
  network: BaseNetwork,
  expectedChainId?: number,
): BaseNetworkConfig {
  const config = NETWORKS[network];
  if (!config) {
    throw new Error('UNSUPPORTED_NETWORK');
  }
  if (expectedChainId !== undefined && expectedChainId !== config.chainId) {
    throw new Error(`CHAIN_ID_MISMATCH: expected ${config.chainId}, received ${expectedChainId}`);
  }
  return config;
}

export function supportedBaseNetworks(): readonly BaseNetworkConfig[] {
  return Object.values(NETWORKS);
}
