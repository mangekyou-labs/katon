import { getAddress, isAddress, isHex, keccak256 } from 'viem';

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_NATIVE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_MAINNET_NATIVE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_FORK_BLOCK = 51_068_301;
export const BASE_FORK_BLOCK_HASH = '0x81ceda4cb39bf70b057c08dc2d70b201b5190ecb8ebb79ccdca3e12b1d73ea41';
export const BASE_WETH = '0x4200000000000000000000000000000000000006';
export const BASE_AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
export const BASE_AAVE_POOL_ADDRESSES_PROVIDER = '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D';
export const BASE_AAVE_USDC_ATOKEN = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
export const BASE_MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
export const BASE_MORPHO_ADAPTIVE_CURVE_IRM = '0x46415998764C29aB2a25CbeA6254146D50D22687';
export const BASE_MORPHO_CHAINLINK_ORACLE_FACTORY = '0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d';
export const BASE_EULER_EVC = '0x5301c7dD20bD945D2013b48ed0DEE3A284ca8989';
export const BASE_EULER_EVAULT_FACTORY = '0x7F321498A801A191a93C840750ed637149dDf8D0';
export const BASE_EULER_EVAULT_IMPLEMENTATION = '0x30a9A9654804F1e5b3291a86E83EdeD7cF281618';
export const BASE_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const BASE_AERODROME_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
export const BASE_AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
export const LEGACY_BASE_USDBC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
const REQUIRED_DEBUG_METHODS = ['evm_snapshot', 'evm_revert', 'anvil_setBalance', 'anvil_setCode'];
const REQUIRED_CORE_ADDRESSES = [
  'router',
  'settlement',
  'facility',
  'facilityAggregator',
  'oracleGuard',
  'b20Guard',
];

export function assertBaseDeploymentTarget(input) {
  if (!['sepolia', 'anvil'].includes(input?.target)) throw new Error('BASE_DEPLOY_TARGET');
  const expectedChainId = input.target === 'anvil' ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
  if (input.chainId !== expectedChainId) {
    throw new Error(`BASE_DEPLOY_CHAIN_ID: expected ${expectedChainId}, received ${input.chainId}`);
  }
  let rpc;
  try {
    rpc = new URL(input.rpcUrl);
  } catch {
    throw new Error('BASE_DEPLOY_RPC_URL');
  }
  if (!['http:', 'https:'].includes(rpc.protocol)) throw new Error('BASE_DEPLOY_RPC_URL');
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(rpc.hostname.toLowerCase());
  if (input.target === 'sepolia') {
    if (loopback) throw new Error('BASE_DEPLOY_SEPOLIA_LOOPBACK');
  } else {
    if (!loopback) throw new Error('BASE_DEPLOY_ANVIL_LOOPBACK');
    if (!String(input.clientVersion ?? '').toLowerCase().includes('anvil')) {
      throw new Error('BASE_DEPLOY_ANVIL_CLIENT');
    }
    const available = new Set(input.debugMethods ?? []);
    if (!REQUIRED_DEBUG_METHODS.every((method) => available.has(method))) {
      throw new Error('BASE_DEPLOY_ANVIL_DEBUG_RPC');
    }
  }
  return { target: input.target, chainId: input.chainId, rpcUrl: rpc.toString() };
}

export function parseBaseDeploymentManifest(input, expectedTarget) {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1) throw new Error('BASE_MANIFEST_SCHEMA');
  if (!['sepolia', 'anvil'].includes(expectedTarget) || input.environment !== expectedTarget) {
    throw new Error('BASE_MANIFEST_ENVIRONMENT');
  }
  const expectedChainId = expectedTarget === 'anvil' ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
  const expectedUsdc = expectedTarget === 'anvil' ? BASE_MAINNET_NATIVE_USDC : BASE_SEPOLIA_NATIVE_USDC;
  if (input.chainId !== expectedChainId) throw new Error('BASE_MANIFEST_CHAIN');
  if (input.productionEligible !== false) throw new Error('BASE_MANIFEST_PRODUCTION');
  if (!sameAddress(input.nativeUsdc, expectedUsdc)) throw new Error('BASE_MANIFEST_NATIVE_USDC');
  if (typeof input.nativeUsdcRuntimeBytecodeHash !== 'string') {
    throw new Error('BASE_MANIFEST_NATIVE_USDC_HASH');
  }
  requireHash(input.nativeUsdcRuntimeBytecodeHash, 'BASE_MANIFEST_NATIVE_USDC_HASH');
  if (expectedTarget === 'anvil') {
    if (input.forkQa !== true) throw new Error('BASE_MANIFEST_FORK_QA');
    if (input.forkBlock !== BASE_FORK_BLOCK) throw new Error('BASE_MANIFEST_FORK_BLOCK');
    if (!sameHash(input.forkBlockHash, BASE_FORK_BLOCK_HASH)) throw new Error('BASE_MANIFEST_FORK_HASH');
    if (input.forkRpcValidated !== true) throw new Error('BASE_MANIFEST_FORK_RPC');
    if (!isLoopbackHttpUrl(input.rpcUrl)) throw new Error('BASE_MANIFEST_LOOPBACK');
  }
  if (expectedTarget === 'sepolia' && (!Array.isArray(input.adapters) || input.adapters.length !== 0)) {
    throw new Error('BASE_MANIFEST_SEPOLIA_ADAPTERS');
  }
  if (!input.roles || typeof input.roles !== 'object') throw new Error('BASE_MANIFEST_ROLES');
  for (const role of ['operator', 'depositor', 'lp', 'admin', 'curator', 'executor', 'guardian']) {
    requireAddress(input.roles[role], 'BASE_MANIFEST_ROLES');
  }
  if (!input.addresses || typeof input.addresses !== 'object') throw new Error('BASE_MANIFEST_ADDRESSES');
  for (const name of REQUIRED_CORE_ADDRESSES) requireAddress(input.addresses[name], 'BASE_MANIFEST_ADDRESSES');
  for (const address of Object.values(input.addresses)) requireAddress(address, 'BASE_MANIFEST_ADDRESSES');
  if (!input.transactions || typeof input.transactions !== 'object') throw new Error('BASE_MANIFEST_TRANSACTIONS');
  for (const hash of Object.values(input.transactions)) requireHash(hash, 'BASE_MANIFEST_TRANSACTIONS');
  if (!input.runtimeBytecodeHashes || typeof input.runtimeBytecodeHashes !== 'object') throw new Error('BASE_MANIFEST_RUNTIME_HASHES');
  for (const name of Object.keys(input.addresses)) requireHash(input.runtimeBytecodeHashes[name], 'BASE_MANIFEST_RUNTIME_HASHES');
  if (
    input.configuration?.feeBps !== 0
    || input.configuration?.maxDecisionBlockAge !== 3
    || input.configuration?.sequencerGracePeriod !== 3600
  ) throw new Error('BASE_MANIFEST_CONFIGURATION');
  if (!Array.isArray(input.mockClassifications) || input.mockClassifications.length === 0) {
    throw new Error('BASE_MANIFEST_MOCK_CLASSIFICATION');
  }
  for (const mock of input.mockClassifications) {
    if (
      !mock || typeof mock.name !== 'string'
      || typeof mock.classification !== 'string'
      || !mock.classification.startsWith('QA_')
      || mock.venueEvidence !== false
    ) throw new Error('BASE_MANIFEST_MOCK_CLASSIFICATION');
    requireAddress(mock.address, 'BASE_MANIFEST_MOCK_CLASSIFICATION');
  }
  if (!Array.isArray(input.adapters)) throw new Error('BASE_MANIFEST_ADAPTERS');
  for (const adapter of input.adapters) {
    if (!adapter || typeof adapter !== 'object' || !isAddressLike(adapter.address)) {
      throw new Error('BASE_MANIFEST_ADAPTERS');
    }
  }
  if (containsAddress(input, LEGACY_BASE_USDBC)) throw new Error('BASE_MANIFEST_USDBC');
  return normalizeAddresses(structuredClone(input));
}

export function parseFoundryArtifact(input) {
  const bytecode = input?.bytecode?.object;
  const deployedBytecode = input?.deployedBytecode?.object;
  if (!Array.isArray(input?.abi) || !validNonemptyHex(bytecode) || !validNonemptyHex(deployedBytecode)) {
    throw new Error('BASE_FOUNDRY_ARTIFACT');
  }
  return { abi: input.abi, bytecode, deployedBytecode };
}

export function runtimeBytecodeHash(bytecode) {
  if (!validNonemptyHex(bytecode)) throw new Error('BASE_RUNTIME_BYTECODE');
  return keccak256(bytecode);
}

export function nextIncompleteDeploymentStep(stepNames, checkpoint = {}) {
  return stepNames.find((name) => checkpoint.steps?.[name]?.status !== 'confirmed');
}

export function assertBaseDeploymentCheckpointAccounts(checkpoint, expectedAccounts) {
  if (!isProgressedCheckpoint(checkpoint)) return;

  const expected = normalizeCheckpointAccounts(expectedAccounts);
  const actual = {
    deployer: checkpoint?.deployer,
    operator: checkpoint?.roles?.operator,
    depositor: checkpoint?.roles?.depositor,
    lp: checkpoint?.roles?.lp,
  };
  for (const role of ['deployer', 'operator', 'depositor', 'lp']) {
    if (!sameAddress(actual[role], expected[role])) {
      throw new Error(`BASE_DEPLOY_CHECKPOINT_ACCOUNT:${role}`);
    }
  }
}

function sameAddress(left, right) {
  return typeof left === 'string' && isAddress(left) && typeof right === 'string' && isAddress(right) && getAddress(left) === getAddress(right);
}

function isProgressedCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  return ['addresses', 'steps', 'transactions', 'configurationTransactions'].some((key) => {
    const value = checkpoint[key];
    return value && typeof value === 'object' && Object.keys(value).length > 0;
  });
}

function normalizeCheckpointAccounts(value) {
  const roles = value?.roles && typeof value.roles === 'object' ? value.roles : value;
  return {
    deployer: value?.deployer,
    operator: roles?.operator,
    depositor: roles?.depositor,
    lp: roles?.lp,
  };
}

function sameHash(left, right) {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function isAddressLike(value) {
  return typeof value === 'string' && isAddress(value);
}

function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function requireAddress(value, code) {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(code);
}

function requireHash(value, code) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new Error(code);
}

function validNonemptyHex(value) {
  return typeof value === 'string' && value !== '0x' && isHex(value) && value.length % 2 === 0;
}

function containsAddress(value, candidate) {
  if (typeof value === 'string') return value.toLowerCase() === candidate.toLowerCase();
  if (Array.isArray(value)) return value.some((entry) => containsAddress(entry, candidate));
  if (value && typeof value === 'object') return Object.values(value).some((entry) => containsAddress(entry, candidate));
  return false;
}

function normalizeAddresses(value) {
  if (typeof value === 'string' && isAddress(value)) return getAddress(value);
  if (Array.isArray(value)) return value.map(normalizeAddresses);
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) value[key] = normalizeAddresses(entry);
  }
  return value;
}
