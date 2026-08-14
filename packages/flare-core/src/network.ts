export type FlareNetwork = 'local' | 'coston2' | 'flare';

export interface NetworkConfig {
  readonly key: FlareNetwork;
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly explorerUrl: string;
  readonly nativeSymbol: string;
  readonly production: boolean;
}

const NETWORKS: Record<FlareNetwork, NetworkConfig> = {
  local: {
    key: 'local',
    chainId: 31337,
    name: 'Local Flare development chain',
    rpcUrl: 'http://127.0.0.1:8545',
    wsUrl: 'ws://127.0.0.1:8545',
    explorerUrl: 'http://127.0.0.1:8545',
    nativeSymbol: 'FLR',
    production: false,
  },
  coston2: {
    key: 'coston2',
    chainId: 114,
    name: 'Flare Coston2',
    rpcUrl: 'https://coston2-api.flare.network/ext/C/rpc',
    wsUrl: 'wss://coston2-api.flare.network/ext/C/ws',
    explorerUrl: 'https://coston2-explorer.flare.network',
    nativeSymbol: 'C2FLR',
    production: false,
  },
  flare: {
    key: 'flare',
    chainId: 14,
    name: 'Flare Mainnet',
    rpcUrl: 'https://flare-api.flare.network/ext/C/rpc',
    wsUrl: 'wss://flare-api.flare.network/ext/C/ws',
    explorerUrl: 'https://flare-explorer.flare.network',
    nativeSymbol: 'FLR',
    production: true,
  },
};

export function getNetworkConfig(
  network: FlareNetwork,
  expectedChainId?: number,
): NetworkConfig {
  const config = NETWORKS[network];
  if (!config) {
    throw new Error('UNSUPPORTED_NETWORK');
  }
  if (expectedChainId !== undefined && expectedChainId !== config.chainId) {
    throw new Error(
      `CHAIN_ID_MISMATCH: expected ${config.chainId}, received ${expectedChainId}`,
    );
  }
  return config;
}

export function supportedNetworks(): readonly NetworkConfig[] {
  return Object.values(NETWORKS);
}
