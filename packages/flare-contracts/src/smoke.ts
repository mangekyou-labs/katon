import { getAddress, isAddress } from 'viem';

const CONTRACT_KEYS = [
  'eligibilityRegistry',
  'router',
  'settlement',
  'instructionSender',
  'facilityAggregator',
  'navProofRegistry',
  'ftsoRiskGuard',
] as const;

type ContractKey = (typeof CONTRACT_KEYS)[number];

export interface DeploymentSnapshot {
  readonly network: 'coston2';
  readonly chainId: number;
  readonly contracts: Readonly<Record<ContractKey, string>>;
  readonly configuration: {
    readonly routerProtocolFeeBps: number;
    readonly routerSnapshotMaxAge: number;
    readonly routerSnapshotHashRequired: boolean;
    readonly settlementEligibilityRegistry: string;
    readonly settlementRouter: string;
    readonly governanceOwner?: string;
  };
}

export function validateDeploymentSnapshot(snapshot: DeploymentSnapshot): { network: 'coston2'; chainId: 114 } {
  if (snapshot.network !== 'coston2' || snapshot.chainId !== 114) throw new Error('DEPLOYMENT_CHAIN_ID');
  for (const key of CONTRACT_KEYS) {
    const address = snapshot.contracts[key];
    if (!address || !isAddress(address) || getAddress(address) === '0x0000000000000000000000000000000000000000') {
      throw new Error(`DEPLOYMENT_ADDRESS:${key}`);
    }
  }
  if (!Number.isInteger(snapshot.configuration.routerProtocolFeeBps) || snapshot.configuration.routerProtocolFeeBps < 0 || snapshot.configuration.routerProtocolFeeBps > 50) {
    throw new Error('DEPLOYMENT_FEE');
  }
  if (!Number.isInteger(snapshot.configuration.routerSnapshotMaxAge) || snapshot.configuration.routerSnapshotMaxAge < 0 || snapshot.configuration.routerSnapshotMaxAge > 256) {
    throw new Error('DEPLOYMENT_SNAPSHOT_AGE');
  }
  if (!snapshot.configuration.routerSnapshotHashRequired) throw new Error('DEPLOYMENT_SNAPSHOT_HASH');
  if (getAddress(snapshot.configuration.settlementRouter) !== getAddress(snapshot.contracts.router)) {
    throw new Error('DEPLOYMENT_SETTLEMENT_ROUTER');
  }
  if (getAddress(snapshot.configuration.settlementEligibilityRegistry) !== getAddress(snapshot.contracts.eligibilityRegistry)) {
    throw new Error('DEPLOYMENT_SETTLEMENT_REGISTRY');
  }
  return { network: 'coston2', chainId: 114 };
}
