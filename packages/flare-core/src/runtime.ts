import { getAddress, isAddress } from 'viem';

import { getNetworkConfig, type FlareNetwork, type NetworkConfig } from './network';

export interface RuntimeConfigInput {
  readonly network: FlareNetwork;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly apiBaseUrl: string;
  readonly routerAddress: string;
  readonly fccMode: 'simulated' | 'real';
}

export interface RuntimeConfig extends RuntimeConfigInput {
  readonly networkConfig: NetworkConfig;
  readonly routerAddress: `0x${string}`;
}

export function resolveRuntimeConfig(input: RuntimeConfigInput): RuntimeConfig {
  const networkConfig = getNetworkConfig(input.network, input.chainId);
  if (!input.rpcUrl.trim()) {
    throw new Error('RPC_URL_REQUIRED');
  }
  if (!input.apiBaseUrl.trim()) {
    throw new Error('API_URL_REQUIRED');
  }
  if (!isAddress(input.routerAddress)) {
    throw new Error('INVALID_ROUTER_ADDRESS');
  }
  if (networkConfig.production && input.fccMode !== 'real') {
    throw new Error('FCC_PRODUCTION_ATTESTATION_REQUIRED');
  }
  return {
    ...input,
    networkConfig,
    routerAddress: getAddress(input.routerAddress),
  };
}
