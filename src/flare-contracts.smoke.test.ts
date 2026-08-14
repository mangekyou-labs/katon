import { describe, expect, it } from 'vitest';

import { validateDeploymentSnapshot, type DeploymentSnapshot } from '../packages/flare-contracts/src/smoke';

const snapshot: DeploymentSnapshot = {
  network: 'coston2',
  chainId: 114,
  contracts: {
    eligibilityRegistry: '0x0000000000000000000000000000000000000001',
    router: '0x0000000000000000000000000000000000000002',
    settlement: '0x0000000000000000000000000000000000000003',
    instructionSender: '0x0000000000000000000000000000000000000004',
    facilityAggregator: '0x0000000000000000000000000000000000000005',
    navProofRegistry: '0x0000000000000000000000000000000000000006',
    ftsoRiskGuard: '0x0000000000000000000000000000000000000007',
  },
  configuration: {
    routerProtocolFeeBps: 50,
    routerSnapshotMaxAge: 256,
    routerSnapshotHashRequired: true,
    settlementEligibilityRegistry: '0x0000000000000000000000000000000000000001',
    settlementRouter: '0x0000000000000000000000000000000000000002',
  },
};

describe('Coston2 deployment smoke boundary', () => {
  it('accepts a complete Coston2 deployment snapshot', () => {
    expect(validateDeploymentSnapshot(snapshot)).toEqual({ network: 'coston2', chainId: 114 });
  });

  it('rejects a deployment with a wrong chain or unsafe fee policy', () => {
    expect(() => validateDeploymentSnapshot({ ...snapshot, chainId: 14 })).toThrow('DEPLOYMENT_CHAIN_ID');
    expect(() => validateDeploymentSnapshot({
      ...snapshot,
      configuration: { ...snapshot.configuration, routerProtocolFeeBps: 51 },
    })).toThrow('DEPLOYMENT_FEE');
  });

  it('rejects Settlement wiring that does not point to the deployed Router and registry', () => {
    expect(() => validateDeploymentSnapshot({
      ...snapshot,
      configuration: { ...snapshot.configuration, settlementRouter: snapshot.contracts.settlement },
    })).toThrow('DEPLOYMENT_SETTLEMENT_ROUTER');
    expect(() => validateDeploymentSnapshot({
      ...snapshot,
      configuration: { ...snapshot.configuration, settlementEligibilityRegistry: snapshot.contracts.router },
    })).toThrow('DEPLOYMENT_SETTLEMENT_REGISTRY');
  });
});
