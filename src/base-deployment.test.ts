import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASE_FORK_BLOCK,
  BASE_FORK_BLOCK_HASH,
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_NATIVE_USDC,
  BASE_SEPOLIA_NATIVE_USDC,
  assertBaseDeploymentCheckpointAccounts,
  assertBaseDeploymentTarget,
  nextIncompleteDeploymentStep,
  parseBaseDeploymentManifest,
  parseFoundryArtifact,
  runtimeBytecodeHash,
} from '../tools/base-deployment-lib.mjs';

const addresses = {
  router: '0x0000000000000000000000000000000000000011',
  settlement: '0x0000000000000000000000000000000000000012',
  facility: '0x0000000000000000000000000000000000000013',
  facilityAggregator: '0x0000000000000000000000000000000000000014',
  oracleGuard: '0x0000000000000000000000000000000000000015',
  b20Guard: '0x0000000000000000000000000000000000000016',
  mockPolicyRegistry: '0x0000000000000000000000000000000000000017',
  mockOracleFeed: '0x0000000000000000000000000000000000000018',
  mockSequencerFeed: '0x0000000000000000000000000000000000000019',
  mockB20: '0x0000000000000000000000000000000000000020',
};

const checkpointAccounts = {
  deployer: '0x0000000000000000000000000000000000000031',
  roles: {
    operator: '0x0000000000000000000000000000000000000032',
    depositor: '0x0000000000000000000000000000000000000033',
    lp: '0x0000000000000000000000000000000000000034',
  },
};

function progressedCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    addresses: { router: addresses.router },
    steps: { router: { status: 'confirmed' } },
    transactions: { router: `0x${'1'.repeat(64)}` },
    configurationTransactions: {},
    deployer: checkpointAccounts.deployer,
    roles: { ...checkpointAccounts.roles },
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    chainId: 84532,
    environment: 'sepolia',
    rpcUrl: 'https://sepolia.base.org',
    productionEligible: false,
    nativeUsdc: BASE_SEPOLIA_NATIVE_USDC,
    nativeUsdcRuntimeBytecodeHash: `0x${'a'.repeat(64)}`,
    roles: {
      operator: '0x0000000000000000000000000000000000000001',
      depositor: '0x0000000000000000000000000000000000000002',
      lp: '0x0000000000000000000000000000000000000003',
      admin: '0x0000000000000000000000000000000000000001',
      curator: '0x0000000000000000000000000000000000000001',
      executor: '0x0000000000000000000000000000000000000003',
      guardian: '0x0000000000000000000000000000000000000001',
    },
    addresses,
    transactions: Object.fromEntries(Object.keys(addresses).map((name, index) => [name, `0x${String(index + 1).padStart(64, '0')}`])),
    runtimeBytecodeHashes: Object.fromEntries(Object.keys(addresses).map((name, index) => [name, `0x${String(index + 11).padStart(64, '0')}`])),
    configuration: { feeBps: 0, maxDecisionBlockAge: 3, sequencerGracePeriod: 3600, oracleHeartbeat: 86400 },
    mockClassifications: [
      { name: 'policy-registry', address: addresses.mockPolicyRegistry, classification: 'QA_POLICY_MOCK', venueEvidence: false },
      { name: 'oracle-feed', address: addresses.mockOracleFeed, classification: 'QA_ORACLE_MOCK', venueEvidence: false },
      { name: 'sequencer-feed', address: addresses.mockSequencerFeed, classification: 'QA_SEQUENCER_MOCK', venueEvidence: false },
      { name: 'b20', address: addresses.mockB20, classification: 'QA_B20_MOCK', venueEvidence: false },
    ],
    adapters: [],
    b20Assets: { [addresses.mockB20]: { ticker: 'MOCKB20', feed: addresses.mockOracleFeed, decimals: 18, classification: 'QA_B20_MOCK' } },
    ...overrides,
  };
}

describe('Base deployment validation', () => {
  it('exposes the resumable deploy and read-only Sepolia smoke commands', () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts).toMatchObject({
      'deploy:base:sepolia': 'node tools/deploy-base.mjs --target=sepolia',
      'deploy:base:anvil': 'node tools/deploy-base.mjs --target=anvil',
      'smoke:base:sepolia': 'node tools/smoke-base-sepolia.mjs',
      'qa:base:deposit': 'node tools/verify-base-sepolia-deposit.mjs',
      'promote:base:sepolia': 'node tools/promote-base-sepolia.mjs',
    });
    expect(existsSync(join(root, 'tools/deploy-base.mjs'))).toBe(true);
    expect(existsSync(join(root, 'tools/smoke-base-sepolia.mjs'))).toBe(true);
    expect(existsSync(join(root, 'tools/verify-base-sepolia-deposit.mjs'))).toBe(true);
    expect(existsSync(join(root, 'tools/promote-base-sepolia.mjs'))).toBe(true);
  });

  it('requires the exact public Sepolia target and rejects loopback or mainnet', () => {
    expect(assertBaseDeploymentTarget({ target: 'sepolia', rpcUrl: 'https://sepolia.base.org', chainId: 84532 })).toEqual(expect.objectContaining({ target: 'sepolia', chainId: 84532 }));
    expect(() => assertBaseDeploymentTarget({ target: 'sepolia', rpcUrl: 'http://127.0.0.1:8545', chainId: 84532 })).toThrow('BASE_DEPLOY_SEPOLIA_LOOPBACK');
    expect(() => assertBaseDeploymentTarget({ target: 'sepolia', rpcUrl: 'https://mainnet.base.org', chainId: 8453 })).toThrow('BASE_DEPLOY_CHAIN_ID');
  });

  it('requires loopback Anvil, its client identity, and debug RPC probes', () => {
    expect(assertBaseDeploymentTarget({
      target: 'anvil', rpcUrl: 'http://localhost:8545', chainId: BASE_MAINNET_CHAIN_ID,
      clientVersion: 'anvil/v1.4.0', debugMethods: ['evm_snapshot', 'evm_revert', 'anvil_setBalance', 'anvil_setCode'],
    })).toEqual(expect.objectContaining({ target: 'anvil' }));
    expect(() => assertBaseDeploymentTarget({ target: 'anvil', rpcUrl: 'https://rpc.example', chainId: BASE_MAINNET_CHAIN_ID, clientVersion: 'anvil', debugMethods: [] })).toThrow('BASE_DEPLOY_ANVIL_LOOPBACK');
    expect(() => assertBaseDeploymentTarget({ target: 'anvil', rpcUrl: 'http://127.0.0.1:8545', chainId: BASE_MAINNET_CHAIN_ID, clientVersion: 'geth', debugMethods: [] })).toThrow('BASE_DEPLOY_ANVIL_CLIENT');
    expect(() => assertBaseDeploymentTarget({ target: 'anvil', rpcUrl: 'http://127.0.0.1:8545', chainId: BASE_MAINNET_CHAIN_ID, clientVersion: 'anvil', debugMethods: ['evm_snapshot'] })).toThrow('BASE_DEPLOY_ANVIL_DEBUG_RPC');
    expect(() => assertBaseDeploymentTarget({ target: 'anvil', rpcUrl: 'http://127.0.0.1:8545', chainId: 84532, clientVersion: 'anvil', debugMethods: [] })).toThrow('BASE_DEPLOY_CHAIN_ID');
  });

  it('parses only an explicitly non-production Sepolia manifest with native USDC and no adapters', () => {
    expect(parseBaseDeploymentManifest(manifest(), 'sepolia')).toMatchObject({
      chainId: 84532,
      environment: 'sepolia',
      nativeUsdc: BASE_SEPOLIA_NATIVE_USDC,
      productionEligible: false,
      adapters: [],
    });
    expect(() => parseBaseDeploymentManifest(manifest({ chainId: 8453 }), 'sepolia')).toThrow('BASE_MANIFEST_CHAIN');
    expect(() => parseBaseDeploymentManifest(manifest({ productionEligible: true }), 'sepolia')).toThrow('BASE_MANIFEST_PRODUCTION');
    expect(() => parseBaseDeploymentManifest(manifest({ nativeUsdc: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' }), 'sepolia')).toThrow('BASE_MANIFEST_NATIVE_USDC');
    expect(() => parseBaseDeploymentManifest(manifest({ adapters: [{ address: addresses.router }] }), 'sepolia')).toThrow('BASE_MANIFEST_SEPOLIA_ADAPTERS');
  });

  it('rejects mock classifications that could be confused with venue evidence', () => {
    const bad = manifest({ mockClassifications: [{ name: 'oracle', address: addresses.mockOracleFeed, classification: 'official', venueEvidence: true }] });
    expect(() => parseBaseDeploymentManifest(bad, 'sepolia')).toThrow('BASE_MANIFEST_MOCK_CLASSIFICATION');
  });

  it('parses Foundry creation/runtime bytecode and hashes observed runtime code', () => {
    expect(parseFoundryArtifact({ abi: [], bytecode: { object: '0x6000' }, deployedBytecode: { object: '0x6001' } })).toEqual({ abi: [], bytecode: '0x6000', deployedBytecode: '0x6001' });
    expect(() => parseFoundryArtifact({ abi: [], bytecode: { object: '0x' }, deployedBytecode: { object: '0x' } })).toThrow('BASE_FOUNDRY_ARTIFACT');
    expect(runtimeBytecodeHash('0x6001')).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(() => runtimeBytecodeHash('0x')).toThrow('BASE_RUNTIME_BYTECODE');
  });

  it('resumes at the first unconfirmed checkpoint without accepting a sent-only step', () => {
    const steps = ['router', 'settlement', 'wireSettlement'];
    expect(nextIncompleteDeploymentStep(steps, { steps: { router: { status: 'confirmed' }, settlement: { status: 'sent', transactionHash: `0x${'1'.repeat(64)}` } } })).toBe('settlement');
    expect(nextIncompleteDeploymentStep(steps, { steps: { router: { status: 'confirmed' }, settlement: { status: 'confirmed' }, wireSettlement: { status: 'confirmed' } } })).toBeUndefined();
  });

  it('rejects progressed checkpoints that are unbound or bound to another account tuple', () => {
    expect(() => assertBaseDeploymentCheckpointAccounts(progressedCheckpoint({ deployer: undefined }), checkpointAccounts)).toThrow('BASE_DEPLOY_CHECKPOINT_ACCOUNT:deployer');
    expect(() => assertBaseDeploymentCheckpointAccounts(progressedCheckpoint({ roles: { ...checkpointAccounts.roles, operator: undefined } }), checkpointAccounts)).toThrow('BASE_DEPLOY_CHECKPOINT_ACCOUNT:operator');
    expect(() => assertBaseDeploymentCheckpointAccounts(progressedCheckpoint({ roles: { ...checkpointAccounts.roles, depositor: '0x0000000000000000000000000000000000000093' } }), checkpointAccounts)).toThrow('BASE_DEPLOY_CHECKPOINT_ACCOUNT:depositor');
    expect(() => assertBaseDeploymentCheckpointAccounts(progressedCheckpoint({ roles: { ...checkpointAccounts.roles, lp: '0x0000000000000000000000000000000000000094' } }), checkpointAccounts)).toThrow('BASE_DEPLOY_CHECKPOINT_ACCOUNT:lp');
  });

  it('accepts an empty checkpoint without account bindings', () => {
    expect(() => assertBaseDeploymentCheckpointAccounts({ addresses: {}, steps: {}, transactions: {}, configurationTransactions: {} }, checkpointAccounts)).not.toThrow();
  });

  it('accepts a progressed checkpoint with matching deployer and QA role bindings', () => {
    expect(() => assertBaseDeploymentCheckpointAccounts(progressedCheckpoint(), checkpointAccounts)).not.toThrow();
  });

  it.each(['deployer', 'operator', 'depositor', 'lp'] as const)('rejects a progressed checkpoint missing %s', (role) => {
    const checkpoint = progressedCheckpoint();
    if (role === 'deployer') {
      delete checkpoint.deployer;
    } else {
      delete checkpoint.roles[role];
    }
    expect(() => assertBaseDeploymentCheckpointAccounts(checkpoint, checkpointAccounts)).toThrow(`BASE_DEPLOY_CHECKPOINT_ACCOUNT:${role}`);
  });

  it.each(['deployer', 'operator', 'depositor', 'lp'] as const)('rejects a progressed checkpoint with a mismatched %s', (role) => {
    const checkpoint = progressedCheckpoint();
    if (role === 'deployer') {
      checkpoint.deployer = '0x0000000000000000000000000000000000000091';
    } else {
      checkpoint.roles[role] = `0x000000000000000000000000000000000000009${role === 'operator' ? '2' : role === 'depositor' ? '3' : '4'}`;
    }
    expect(() => assertBaseDeploymentCheckpointAccounts(checkpoint, checkpointAccounts)).toThrow(`BASE_DEPLOY_CHECKPOINT_ACCOUNT:${role}`);
  });

  it('rejects a legacy 84532 manifest from the fork target', () => {
    const legacy = manifest({
      environment: 'anvil',
      chainId: 84532,
      nativeUsdc: BASE_SEPOLIA_NATIVE_USDC,
      rpcUrl: 'http://127.0.0.1:8545',
      forkQa: true,
      forkBlock: BASE_FORK_BLOCK,
      forkBlockHash: BASE_FORK_BLOCK_HASH,
      forkRpcValidated: true,
    });
    expect(() => parseBaseDeploymentManifest(legacy, 'anvil')).toThrow('BASE_MANIFEST_CHAIN');
    expect(BASE_MAINNET_NATIVE_USDC).not.toBe(BASE_SEPOLIA_NATIVE_USDC);
  });
});
