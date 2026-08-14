import { getAddress, isAddress, type Address } from 'viem';

import { getNetworkConfig, type FlareNetwork } from './network';

export type FlareRegistryContract = 'FtsoV2' | 'FdcHub' | 'FAssets';
export type FlareVenue = 'morpho' | 'kinetic' | 'clearpool-tpool';

export interface VenueDeployment {
  readonly venue: FlareVenue;
  readonly chainId: number;
  readonly address: string;
  readonly supportedAssets: readonly string[];
  readonly verifiedReference: string;
  readonly bytecodeHash?: string;
  readonly market?: string;
  readonly forkBlock?: number;
}

export interface VenueDeploymentReader {
  readonly chainId: number;
  getDeployment(venue: FlareVenue): VenueDeployment | undefined;
}

export interface ContractRegistryReader {
  readonly chainId: number;
  getAddress(name: FlareRegistryContract): string | undefined;
}

export interface FtsoFeedRegistryReader {
  readonly chainId: number;
  getFeedId(name: string): string | undefined;
}

export interface ResolvedRegistryContracts {
  readonly network: FlareNetwork;
  readonly chainId: number;
  readonly addresses: Readonly<Record<FlareRegistryContract, Address>>;
}

export function resolveRegistryContracts(
  network: FlareNetwork,
  reader: ContractRegistryReader,
  required: readonly FlareRegistryContract[],
): ResolvedRegistryContracts {
  const config = getNetworkConfig(network);
  if (reader.chainId !== config.chainId) {
    throw new Error(`REGISTRY_CHAIN_ID: expected ${config.chainId}, received ${reader.chainId}`);
  }
  if (required.length === 0) throw new Error('REGISTRY_REQUIREMENTS_EMPTY');

  const addresses = {} as Record<FlareRegistryContract, Address>;
  for (const name of required) {
    const candidate = reader.getAddress(name);
    if (!candidate || !isAddress(candidate) || getAddress(candidate) === '0x0000000000000000000000000000000000000000') {
      throw new Error(`REGISTRY_ENTRY_MISSING:${name}`);
    }
    addresses[name] = getAddress(candidate);
  }
  return { network, chainId: config.chainId, addresses };
}

export function resolveFtsoFeedIds(
  network: FlareNetwork,
  reader: FtsoFeedRegistryReader,
  names: readonly string[],
): Readonly<Record<string, string>> {
  const config = getNetworkConfig(network);
  if (reader.chainId !== config.chainId) {
    throw new Error(`REGISTRY_CHAIN_ID: expected ${config.chainId}, received ${reader.chainId}`);
  }
  if (names.length === 0 || names.some((name) => !name.trim())) throw new Error('FTSO_FEEDS_EMPTY');
  const feedIds: Record<string, string> = {};
  for (const name of names) {
    const feedId = reader.getFeedId(name);
    if (!feedId || !feedId.trim()) throw new Error(`FTSO_FEED_MISSING:${name}`);
    feedIds[name] = feedId;
  }
  return feedIds;
}

export function resolveVenueDeployments(
  network: FlareNetwork,
  reader: VenueDeploymentReader,
  required: readonly FlareVenue[],
): Readonly<Record<FlareVenue, VenueDeployment>> {
  const config = getNetworkConfig(network);
  if (reader.chainId !== config.chainId) {
    throw new Error(`VENUE_CHAIN_ID: expected ${config.chainId}, received ${reader.chainId}`);
  }
  if (required.length === 0) throw new Error('VENUE_REQUIREMENTS_EMPTY');
  const deployments = {} as Record<FlareVenue, VenueDeployment>;
  for (const venue of required) {
    const deployment = reader.getDeployment(venue);
    if (
      !deployment
      || deployment.venue !== venue
      || deployment.chainId !== config.chainId
      || !isAddress(deployment.address)
      || getAddress(deployment.address) === '0x0000000000000000000000000000000000000000'
      || deployment.supportedAssets.length === 0
      || !deployment.verifiedReference.trim()
      || (deployment.bytecodeHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(deployment.bytecodeHash))
      || (deployment.market !== undefined && !isAddress(deployment.market))
      || (deployment.forkBlock !== undefined && (!Number.isSafeInteger(deployment.forkBlock) || deployment.forkBlock < 0))
    ) {
      throw new Error(`VENUE_DEPLOYMENT_INVALID:${venue}`);
    }
    deployments[venue] = { ...deployment, address: getAddress(deployment.address) };
  }
  return deployments;
}
