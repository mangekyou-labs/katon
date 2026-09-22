import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress } from 'viem';

import { BASE_SEPOLIA_NATIVE_USDC } from '../tools/base-deployment-lib.mjs';
import {
  BASE_SEPOLIA_APPROVAL_EVENT,
  BASE_SEPOLIA_DEPOSIT_EVENT,
  buildBaseSepoliaDepositProof,
  selectBaseSepoliaEvent,
} from '../tools/base-sepolia-deposit-lib.mjs';
import {
  candidatePaths,
  canonicalJson,
  promoteReleaseCandidate,
  sha256Manifest,
  validateCandidateManifest,
  validateDepositEvidence,
  validateSmokeEvidence,
  validateStockSaleEvidence,
} from '../tools/base-release-gate-lib.mjs';

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

const accounts = {
  operator: '0x0000000000000000000000000000000000000001',
  depositor: '0x0000000000000000000000000000000000000002',
  lp: '0x0000000000000000000000000000000000000003',
};

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    network: 'sepolia',
    networkName: 'Base Sepolia',
    chainId: 84532,
    environment: 'sepolia',
    rpcUrl: 'https://sepolia.base.org',
    deployer: accounts.operator,
    deployedAt: '2026-09-11T00:00:00.000Z',
    blockNumber: '100',
    blockHash: `0x${'b'.repeat(64)}`,
    productionEligible: false,
    forkQa: false,
    nativeUsdc: BASE_SEPOLIA_NATIVE_USDC,
    nativeUsdcRuntimeBytecodeHash: `0x${'a'.repeat(64)}`,
    roles: {
      operator: accounts.operator,
      depositor: accounts.depositor,
      lp: accounts.lp,
      admin: accounts.operator,
      curator: accounts.depositor,
      executor: accounts.operator,
      guardian: accounts.operator,
    },
    addresses,
    transactions: Object.fromEntries(Object.keys(addresses).map((name, index) => [name, `0x${String(index + 1).padStart(64, '0')}`])),
    runtimeBytecodeHashes: Object.fromEntries(Object.keys(addresses).map((name, index) => [name, `0x${String(index + 11).padStart(64, '0')}`])),
    venueAddresses: {},
    venuePins: [],
    mockClassifications: [
      { name: 'policy-registry', address: addresses.mockPolicyRegistry, classification: 'QA_POLICY_MOCK', venueEvidence: false },
      { name: 'oracle-feed', address: addresses.mockOracleFeed, classification: 'QA_ORACLE_MOCK', venueEvidence: false },
      { name: 'sequencer-feed', address: addresses.mockSequencerFeed, classification: 'QA_SEQUENCER_MOCK', venueEvidence: false },
      { name: 'b20', address: addresses.mockB20, classification: 'QA_B20_MOCK', venueEvidence: false },
    ],
    adapters: [],
    b20Assets: { [addresses.mockB20]: { ticker: 'MOCKB20', feed: addresses.mockOracleFeed, decimals: 18, classification: 'QA_B20_MOCK' } },
    configuration: { feeBps: 0, maxDecisionBlockAge: 3, sequencerGracePeriod: 3600, oracleHeartbeat: 86400 },
    ...overrides,
  };
}

function smokeEvidence(candidateSha256: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'base-sepolia-smoke',
    target: 'sepolia',
    chainId: 84532,
    candidateSha256,
    checks: 35,
    productionEligible: false,
    nativeUsdc: BASE_SEPOLIA_NATIVE_USDC,
    addresses: { router: addresses.router, settlement: addresses.settlement, facility: addresses.facility },
    ...overrides,
  };
}

function depositEvidence(candidateSha256: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'base-sepolia-deposit',
    target: 'sepolia',
    chainId: 84532,
    candidateSha256,
    nativeUsdc: BASE_SEPOLIA_NATIVE_USDC,
    facility: addresses.facility,
    depositor: accounts.depositor,
    approval: {
      eventName: 'Approval',
      logAddress: BASE_SEPOLIA_NATIVE_USDC,
      transactionHash: `0x${'1'.repeat(64)}`,
      blockNumber: '101',
      logIndex: 0,
      owner: accounts.depositor,
      spender: addresses.facility,
      value: '1000000',
    },
    deposit: {
      eventName: 'Deposit',
      logAddress: addresses.facility,
      transactionHash: `0x${'2'.repeat(64)}`,
      blockNumber: '102',
      logIndex: 0,
      sender: accounts.depositor,
      owner: accounts.depositor,
      assets: '1000000',
      shares: '1000000',
    },
    sharesBefore: '0',
    sharesAfter: '1000000',
    ...overrides,
  };
}

function swapEvidence(candidateSha256: string, overrides: Record<string, unknown> = {}) {
  const approvalHash = `0x${'7'.repeat(64)}`;
  const settlementHash = `0x${'8'.repeat(64)}`;
  const orderHash = `0x${'9'.repeat(64)}`;
  const requestId = `0x${'a'.repeat(64)}`;
  const base = {
    schemaVersion: 1,
    kind: 'base-sepolia-stock-sale',
    target: 'sepolia',
    chainId: 84532,
    candidateSha256,
    stockToken: addresses.mockB20,
    nativeUsdc: BASE_SEPOLIA_NATIVE_USDC,
    router: addresses.router,
    settlement: addresses.settlement,
    seller: accounts.depositor,
    maker: accounts.lp,
    stockAmount: '100',
    usdcAmount: '1000',
    requestId,
    routeId: `0x${'b'.repeat(64)}`,
    orderHash,
    decisionBlock: '101',
    decisionBlockHash: `0x${'c'.repeat(64)}`,
    simulationBlock: '102',
    simulationBlockHash: `0x${'d'.repeat(64)}`,
    approval: {
      eventName: 'Approval',
      logAddress: addresses.mockB20,
      transactionHash: approvalHash,
      blockNumber: '101',
      owner: accounts.depositor,
      spender: addresses.settlement,
      value: '100',
    },
    settlementEvent: {
      eventName: 'SwapFilled',
      logAddress: addresses.settlement,
      transactionHash: settlementHash,
      blockNumber: '102',
      orderHash,
      maker: accounts.lp,
      taker: accounts.depositor,
      stockToken: addresses.mockB20,
      usdcToken: BASE_SEPOLIA_NATIVE_USDC,
      stockAmount: '100',
      usdcAmount: '1000',
    },
    route: {
      eventName: 'SwapRouteFilled',
      logAddress: addresses.router,
      transactionHash: settlementHash,
      blockNumber: '102',
      requestId,
      taker: accounts.depositor,
      recipient: accounts.depositor,
      stockToken: addresses.mockB20,
      usdcToken: BASE_SEPOLIA_NATIVE_USDC,
      stockAmount: '100',
      boughtUsdc: '1000',
    },
    approvalReceipt: { transactionHash: approvalHash, blockNumber: '101', status: 'success' },
    settlementReceipt: { transactionHash: settlementHash, blockNumber: '102', status: 'success' },
    balancesBefore: {
      seller: { stock: '100', usdc: '0' },
      maker: { stock: '0', usdc: '1000' },
      router: { stock: '0', usdc: '0' },
      settlement: { stock: '0', usdc: '0' },
    },
    balancesAfter: {
      seller: { stock: '0', usdc: '1000' },
      maker: { stock: '100', usdc: '0' },
      router: { stock: '0', usdc: '0' },
      settlement: { stock: '0', usdc: '0' },
    },
    balanceAddresses: { seller: accounts.depositor, maker: accounts.lp },
    remainingSellerStockAllowance: '0',
    dust: { routerStock: '0', routerUsdc: '0', settlementStock: '0', settlementUsdc: '0' },
  };
  return { ...base, ...overrides };
}

describe('Base Sepolia release gate', () => {
  it('keeps the candidate manifest under output/base-qa and hashes canonical content', () => {
    const root = '/tmp/katon-base-release-gate';
    const paths = candidatePaths(root, 'sepolia');
    expect(paths.manifestPath).toBe(join(root, 'output/base-qa/sepolia/candidate-manifest.json'));
    expect(paths.checkpointPath).toBe(join(root, 'output/base-qa/sepolia/candidate-checkpoint.json'));
    expect(paths.manifestPath).not.toBe(paths.publicManifestPath);
    expect(() => validateCandidateManifest(manifest(), paths.publicManifestPath, root)).toThrow('BASE_QA_CANDIDATE_PUBLIC_PATH');

    const value = manifest();
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(canonicalJson(value)).toBe(canonicalJson(reordered));
    expect(sha256Manifest(value)).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256Manifest(value)).not.toBe(sha256Manifest({ ...value, deployedAt: '2026-09-12T00:00:00.000Z' }));
  });

  it('accepts only a 35-check smoke proof bound to the candidate digest', () => {
    const candidate = manifest();
    const digest = sha256Manifest(candidate);
    expect(validateSmokeEvidence(smokeEvidence(digest), candidate, digest)).toMatchObject({ checks: 35, candidateSha256: digest });
    expect(() => validateSmokeEvidence(smokeEvidence(`${'0'.repeat(64)}`), candidate, digest)).toThrow('BASE_QA_SMOKE_PROOF_CANDIDATE_MISMATCH');
    expect(() => validateSmokeEvidence(smokeEvidence(digest, { checks: 34 }), candidate, digest)).toThrow('BASE_QA_SMOKE_PROOF_INVALID');
  });

  it('requires matching native-USDC Approval and facility Deposit events with positive share growth', () => {
    const candidate = manifest();
    const digest = sha256Manifest(candidate);
    expect(validateDepositEvidence(depositEvidence(digest), candidate, digest, accounts)).toMatchObject({
      approval: { owner: accounts.depositor, spender: addresses.facility, value: '1000000' },
      deposit: { owner: accounts.depositor, assets: '1000000', shares: '1000000' },
      sharesBefore: '0',
      sharesAfter: '1000000',
    });
    expect(() => validateDepositEvidence(depositEvidence(digest, { approval: undefined }), candidate, digest, accounts)).toThrow('BASE_QA_APPROVAL_EVENT_MISSING');
    expect(() => validateDepositEvidence(depositEvidence(digest, { deposit: undefined }), candidate, digest, accounts)).toThrow('BASE_QA_DEPOSIT_EVENT_MISSING');
    expect(() => validateDepositEvidence(depositEvidence(digest, { deposit: { ...depositEvidence(digest).deposit, shares: '0' } }), candidate, digest, accounts)).toThrow('BASE_QA_DEPOSIT_PROOF_INVALID');
  });

  it('rejects incorrect Approval owner, Deposit sender, spender, and share delta', () => {
    const candidate = manifest();
    const digest = sha256Manifest(candidate);
    const valid = depositEvidence(digest);

    expect(() => validateDepositEvidence(depositEvidence(digest, {
      approval: { ...valid.approval, owner: accounts.operator },
    }), candidate, digest, accounts)).toThrow('BASE_QA_DEPOSIT_PROOF_INVALID');
    expect(() => validateDepositEvidence(depositEvidence(digest, {
      deposit: { ...valid.deposit, sender: accounts.operator },
    }), candidate, digest, accounts)).toThrow('BASE_QA_DEPOSIT_PROOF_INVALID');
    expect(() => validateDepositEvidence(depositEvidence(digest, {
      approval: { ...valid.approval, spender: accounts.operator },
    }), candidate, digest, accounts)).toThrow('BASE_QA_DEPOSIT_PROOF_INVALID');
    expect(() => validateDepositEvidence(depositEvidence(digest, {
      sharesAfter: valid.sharesBefore,
    }), candidate, digest, accounts)).toThrow('BASE_QA_DEPOSIT_PROOF_INVALID');
  });

  it('decodes only candidate native-USDC Approval and facility Deposit logs for the depositor', () => {
    const candidate = manifest();
    const approvalLog = {
      address: BASE_SEPOLIA_NATIVE_USDC,
      topics: encodeEventTopics({ abi: [BASE_SEPOLIA_APPROVAL_EVENT], eventName: 'Approval', args: [accounts.depositor, addresses.facility] }),
      data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]),
      transactionHash: `0x${'3'.repeat(64)}`,
      blockNumber: 101n,
      logIndex: 0n,
    };
    const depositLog = {
      address: addresses.facility,
      topics: encodeEventTopics({ abi: [BASE_SEPOLIA_DEPOSIT_EVENT], eventName: 'Deposit', args: [accounts.depositor, accounts.depositor] }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1_000_000n, 1_000_000n]),
      transactionHash: `0x${'4'.repeat(64)}`,
      blockNumber: 102n,
      logIndex: 0n,
    };
    expect(selectBaseSepoliaEvent([approvalLog], 'approval', { candidate, depositor: accounts.depositor })).toMatchObject({
      eventName: 'Approval',
      owner: accounts.depositor,
      spender: addresses.facility,
      value: '1000000',
    });
    expect(selectBaseSepoliaEvent([depositLog], 'deposit', { candidate, depositor: accounts.depositor })).toMatchObject({
      eventName: 'Deposit',
      sender: accounts.depositor,
      owner: accounts.depositor,
      assets: '1000000',
      shares: '1000000',
    });
    expect(buildBaseSepoliaDepositProof({
      candidate,
      depositor: accounts.depositor,
      approvalLogs: [approvalLog],
      depositLogs: [depositLog],
      sharesBefore: 0n,
      sharesAfter: 1_000_000n,
    })).toMatchObject({ kind: 'base-sepolia-deposit', candidateSha256: sha256Manifest(candidate) });
    expect(selectBaseSepoliaEvent([depositLog], 'deposit', { candidate, depositor: accounts.operator })).toBeUndefined();
  });

  it('requires candidate-bound stock-sale conservation, receipts, and zero dust', () => {
    const candidate = manifest();
    const digest = sha256Manifest(candidate);
    const proof = swapEvidence(digest);
    expect(validateStockSaleEvidence(proof, candidate, digest, accounts)).toBe(proof);
    expect(() => validateStockSaleEvidence({ ...proof, remainingSellerStockAllowance: '1' }, candidate, digest, accounts))
      .toThrow('BASE_QA_SWAP_PROOF_ALLOWANCE');
    expect(() => validateStockSaleEvidence({ ...proof, dust: { ...proof.dust, routerUsdc: '1' } }, candidate, digest, accounts))
      .toThrow('BASE_QA_SWAP_PROOF_DUST');
    expect(() => validateStockSaleEvidence({ ...proof, balancesAfter: { ...proof.balancesAfter, seller: { stock: '1', usdc: '1000' } } }, candidate, digest, accounts))
      .toThrow('BASE_QA_SWAP_PROOF_BALANCES');
  });

  it('accepts receipt-backed approve evidence for the deployed nonstandard QA B20', () => {
    const candidate = manifest();
    const digest = sha256Manifest(candidate);
    const proof = swapEvidence(digest);
    const callData = `0x095ea7b3${addresses.settlement.slice(2).padStart(64, '0')}${BigInt(proof.stockAmount).toString(16).padStart(64, '0')}`;
    const approval = {
      eventName: 'ApprovalCall',
      evidence: 'receipt-input',
      logAddress: addresses.mockB20,
      transactionHash: proof.approvalReceipt.transactionHash,
      blockNumber: proof.approvalReceipt.blockNumber,
      owner: accounts.depositor,
      spender: addresses.settlement,
      value: proof.stockAmount,
      transactionFrom: accounts.depositor,
      transactionTo: addresses.mockB20,
      functionName: 'approve',
      callData,
    };
    expect(validateStockSaleEvidence({ ...proof, approval }, candidate, digest, accounts)).toMatchObject({ approval });
    expect(() => validateStockSaleEvidence({ ...proof, approval: { ...approval, callData: `${callData.slice(0, -1)}0` } }, candidate, digest, accounts))
      .toThrow('BASE_QA_SWAP_PROOF_APPROVAL');
  });

  it('rejects forged receipt-backed approval identities, amounts, hashes, padding, and blocks', () => {
    const candidate = manifest();
    const digest = sha256Manifest(candidate);
    const proof = swapEvidence(digest);
    const callData = `0x095ea7b3${addresses.settlement.slice(2).padStart(64, '0')}${BigInt(proof.stockAmount).toString(16).padStart(64, '0')}`;
    const approval = {
      eventName: 'ApprovalCall',
      evidence: 'receipt-input',
      logAddress: addresses.mockB20,
      transactionHash: proof.approvalReceipt.transactionHash,
      blockNumber: proof.approvalReceipt.blockNumber,
      owner: accounts.depositor,
      spender: addresses.settlement,
      value: proof.stockAmount,
      transactionFrom: accounts.depositor,
      transactionTo: addresses.mockB20,
      functionName: 'approve',
      callData,
    };
    const valid = { ...proof, approval };
    expect(() => validateStockSaleEvidence({ ...valid, approval: { ...approval, transactionFrom: accounts.operator } }, candidate, digest, accounts))
      .toThrow('BASE_QA_SWAP_PROOF_APPROVAL');
    expect(() => validateStockSaleEvidence({ ...valid, approval: { ...approval, value: '101' } }, candidate, digest, accounts))
      .toThrow('BASE_QA_SWAP_PROOF_APPROVAL');
    expect(() => validateStockSaleEvidence({ ...valid, approval: { ...approval, transactionHash: `0x${'6'.repeat(64)}` } }, candidate, digest, accounts))
      .toThrow('BASE_QA_SWAP_PROOF_APPROVAL');
    expect(() => validateStockSaleEvidence({
      ...valid,
      approval: { ...approval, callData: `0x095ea7b3${'1'.repeat(24)}${addresses.settlement.slice(2)}${BigInt(proof.stockAmount).toString(16).padStart(64, '0')}` },
    }, candidate, digest, accounts)).toThrow('BASE_QA_SWAP_PROOF_APPROVAL');
    expect(() => validateStockSaleEvidence({ ...valid, approval: { ...approval, blockNumber: '103' } }, candidate, digest, accounts))
      .toThrow('BASE_QA_SWAP_PROOF_APPROVAL');
    expect(() => validateStockSaleEvidence({
      ...valid,
      route: { ...proof.route, blockNumber: '103' },
    }, candidate, digest, accounts)).toThrow('BASE_QA_SWAP_PROOF_ROUTE');
  });

  it('accepts a successful relayed receipt when candidate-bound logs identify the depositor', () => {
    const candidate = manifest();
    const relayer = '0x0000000000000000000000000000000000000042';
    const approvalLog = {
      address: BASE_SEPOLIA_NATIVE_USDC,
      topics: encodeEventTopics({ abi: [BASE_SEPOLIA_APPROVAL_EVENT], eventName: 'Approval', args: [accounts.depositor, addresses.facility] }),
      data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]),
      transactionHash: `0x${'5'.repeat(64)}`,
      blockNumber: 101n,
      logIndex: 0n,
    };
    const depositLog = {
      address: addresses.facility,
      topics: encodeEventTopics({ abi: [BASE_SEPOLIA_DEPOSIT_EVENT], eventName: 'Deposit', args: [accounts.depositor, accounts.depositor] }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1_000_000n, 1_000_000n]),
      transactionHash: `0x${'6'.repeat(64)}`,
      blockNumber: 102n,
      logIndex: 0n,
    };

    const proof = buildBaseSepoliaDepositProof({
      candidate,
      depositor: accounts.depositor,
      approvalLogs: [approvalLog],
      depositLogs: [depositLog],
      approvalFrom: relayer,
      depositFrom: relayer,
      sharesBefore: 0n,
      sharesAfter: 1_000_000n,
    });

    expect(proof).toMatchObject({
      approval: { owner: accounts.depositor, spender: addresses.facility, value: '1000000', receiptFrom: getAddress(relayer) },
      deposit: { sender: accounts.depositor, owner: accounts.depositor, assets: '1000000', shares: '1000000', receiptFrom: getAddress(relayer) },
    });
    expect(validateDepositEvidence(proof, candidate, sha256Manifest(candidate), accounts)).toBe(proof);
  });

  it('refuses mismatched evidence without writing the public manifest and promotes atomically on success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katon-base-release-'));
    const paths = candidatePaths(root, 'sepolia');
    const candidate = manifest();
    const digest = sha256Manifest(candidate);
    const smoke = smokeEvidence(digest);
    const deposit = depositEvidence(digest);
    const swap = swapEvidence(digest);
    await mkdir(paths.candidateDir, { recursive: true });
    await writeFile(paths.manifestPath, `${JSON.stringify(candidate, null, 2)}\n`);
    await writeFile(paths.smokeProofPath, `${JSON.stringify({ ...smoke, candidateSha256: '0'.repeat(64) }, null, 2)}\n`);
    await writeFile(paths.depositProofPath, `${JSON.stringify(deposit, null, 2)}\n`);
    await writeFile(paths.swapProofPath, `${JSON.stringify(swap, null, 2)}\n`);

    await expect(promoteReleaseCandidate({ rootDir: root, expectedAccounts: accounts })).rejects.toThrow('BASE_QA_SMOKE_PROOF_CANDIDATE_MISMATCH');
    expect(existsSync(paths.publicManifestPath)).toBe(false);

    await writeFile(paths.smokeProofPath, `${JSON.stringify(smoke, null, 2)}\n`);
    await writeFile(paths.swapProofPath, `${JSON.stringify(swap, null, 2)}\n`);
    const result = await promoteReleaseCandidate({ rootDir: root, expectedAccounts: accounts });
    expect(result).toMatchObject({ candidateSha256: digest, chainId: 84532, publicManifestPath: paths.publicManifestPath });
    expect(JSON.parse(await readFile(paths.publicManifestPath, 'utf8'))).toEqual(candidate);
  });

  it('fails closed for missing smoke or deposit proof and never creates the public manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katon-base-release-missing-'));
    const paths = candidatePaths(root, 'sepolia');
    const candidate = manifest();
    await mkdir(paths.candidateDir, { recursive: true });
    await writeFile(paths.manifestPath, `${JSON.stringify(candidate, null, 2)}\n`);

    await expect(promoteReleaseCandidate({ rootDir: root, expectedAccounts: accounts }))
      .rejects.toThrow('BASE_QA_SMOKE_PROOF_REQUIRED');
    expect(existsSync(paths.publicManifestPath)).toBe(false);

    const digest = sha256Manifest(candidate);
    await writeFile(paths.smokeProofPath, `${JSON.stringify(smokeEvidence(digest), null, 2)}\n`);
    await expect(promoteReleaseCandidate({ rootDir: root, expectedAccounts: accounts }))
      .rejects.toThrow('BASE_QA_DEPOSIT_PROOF_REQUIRED');
    expect(existsSync(paths.publicManifestPath)).toBe(false);

    await writeFile(paths.depositProofPath, `${JSON.stringify(depositEvidence(sha256Manifest(candidate)), null, 2)}\n`);
    await expect(promoteReleaseCandidate({ rootDir: root, expectedAccounts: accounts }))
      .rejects.toThrow('BASE_QA_SWAP_PROOF_REQUIRED');
    expect(existsSync(paths.publicManifestPath)).toBe(false);
  });
});
