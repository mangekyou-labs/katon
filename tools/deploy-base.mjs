import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  stringToHex,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

import {
  BASE_AERODROME_FACTORY,
  BASE_AERODROME_ROUTER,
  BASE_AAVE_POOL,
  BASE_AAVE_POOL_ADDRESSES_PROVIDER,
  BASE_AAVE_USDC_ATOKEN,
  BASE_EULER_EVAULT_FACTORY,
  BASE_EULER_EVAULT_IMPLEMENTATION,
  BASE_EULER_EVC,
  BASE_FORK_BLOCK,
  BASE_FORK_BLOCK_HASH,
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_NATIVE_USDC,
  BASE_MORPHO_ADAPTIVE_CURVE_IRM,
  BASE_MORPHO_BLUE,
  BASE_PERMIT2,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_NATIVE_USDC,
  assertBaseDeploymentCheckpointAccounts,
  assertBaseDeploymentTarget,
  nextIncompleteDeploymentStep,
  parseBaseDeploymentManifest,
  parseFoundryArtifact,
  runtimeBytecodeHash,
} from './base-deployment-lib.mjs';
import { candidatePaths, sha256Manifest } from './base-release-gate-lib.mjs';
import {
  assertNonstandardQaWallet,
  buildFundingReport,
  deriveBaseQaAccounts,
  minimumFunding,
  parseBaseQaTarget,
  parseEnvContents,
  validateBaseQaSecrets,
} from './base-qa-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QA_STOCK_DECIMALS = 8;
const QA_STOCK_UNIT = 10n ** BigInt(QA_STOCK_DECIMALS);
const target = parseBaseQaTarget(process.argv.slice(2));
const sepoliaReleasePaths = candidatePaths(rootDir, 'sepolia');
const environment = await readEnvironment();
const secrets = target === 'anvil'
  ? validateBaseQaSecrets(environment)
  : { mnemonic: environment.BASE_QA_MNEMONIC?.trim() };
if (!secrets.mnemonic) throw new Error('BASE_QA_MNEMONIC');

const rpcUrl = target === 'anvil'
  ? environment.BASE_ANVIL_RPC_URL?.trim() || 'http://127.0.0.1:8545'
  : environment.BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org';
const manifestRpcUrl = target === 'sepolia' ? 'https://sepolia.base.org' : rpcUrl;
const chainId = target === 'anvil' ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
const nativeUsdc = getAddress(target === 'anvil'
  ? BASE_MAINNET_NATIVE_USDC
  : BASE_SEPOLIA_NATIVE_USDC);
const chain = {
  id: chainId,
  name: target === 'anvil' ? 'Base Mainnet Fork (local)' : 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};
const account = mnemonicToAccount(secrets.mnemonic, { addressIndex: 0 });
const roleAccounts = deriveBaseQaAccounts(secrets.mnemonic);
assertNonstandardQaWallet(roleAccounts);
const byRole = Object.fromEntries(roleAccounts.map((entry) => [entry.role, entry.address]));
const checkpointAccounts = {
  deployer: getAddress(account.address),
  roles: {
    operator: getAddress(byRole.operator),
    depositor: getAddress(byRole.depositor),
    lp: getAddress(byRole.lp),
  },
};
const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }),
});
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const wallets = {
  operator: walletClient,
  depositor: createWalletClient({ account: mnemonicToAccount(secrets.mnemonic, { addressIndex: 1 }), chain, transport: http(rpcUrl) }),
  lp: createWalletClient({ account: mnemonicToAccount(secrets.mnemonic, { addressIndex: 2 }), chain, transport: http(rpcUrl) }),
};

const checkpointPath = target === 'anvil'
  ? path.join(rootDir, 'output/base-qa/anvil.checkpoint.json')
  : sepoliaReleasePaths.checkpointPath;
const manifestPath = target === 'anvil'
  ? path.join(rootDir, 'output/base-qa/anvil.json')
  : sepoliaReleasePaths.manifestPath;
const checkpoint = await loadCheckpoint();
const deploymentTransactions = { ...(checkpoint.transactions ?? {}) };
const configurationTransactions = { ...(checkpoint.configurationTransactions ?? {}) };
const addresses = { ...(checkpoint.addresses ?? {}) };
const scenarios = {};
const artifacts = new Map();

await preflight();
await reconcileCheckpoint();
assertBaseDeploymentCheckpointAccounts(checkpoint, checkpointAccounts);
console.log(`base-deploy target=${target} chainId=${chainId} nativeUsdc=${nativeUsdc}`);
console.log(`deployer=${getAddress(account.address)}`);

const mockPolicyRegistry = await deployStep('mockPolicyRegistry', 'BaseQaMocks.sol', 'BaseQaPolicyRegistry');
const mockOracleFeed = await deployStep('mockOracleFeed', 'BaseQaMocks.sol', 'BaseQaOracleFeed', [false]);
const mockSequencerFeed = await deployStep('mockSequencerFeed', 'BaseQaMocks.sol', 'BaseQaOracleFeed', [true]);
const mockB20 = await deployStep('mockB20', 'BaseQaMocks.sol', 'BaseQaB20');
await writeStep('initializeMockB20', mockB20, 'BaseQaMocks.sol', 'BaseQaB20', 'initialize', ['Katon Control B20', 'B20', QA_STOCK_DECIMALS]);
const mockMutableOracle = await deployStep('mockMutableOracle', 'BaseQaMocks.sol', 'BaseQaMutableOracle', [10n ** 24n]);

const router = await deployStep('router', 'RFQRouter.sol', 'RFQRouter');
const settlement = await deployStep('settlement', 'RFQSettlement.sol', 'RFQSettlement', [nativeUsdc]);
const facility = await deployStep('facility', 'LiquidityFacility.sol', 'LiquidityFacility', [nativeUsdc, byRole.depositor, byRole.operator, byRole.operator]);
const facilityAggregator = await deployStep('facilityAggregator', 'FacilityAggregator.sol', 'FacilityAggregator', [router]);
const oracleGuard = await deployStep('oracleGuard', 'OracleGuard.sol', 'OracleGuard', [mockSequencerFeed, mockPolicyRegistry, 3_600n]);
const b20Guard = await deployStep('b20Guard', 'B20Guard.sol', 'B20Guard', [mockPolicyRegistry]);

await writeStep('routerOracleGuard', router, 'RFQRouter.sol', 'RFQRouter', 'setOracleGuard', [oracleGuard]);
await writeStep('routerB20Guard', router, 'RFQRouter.sol', 'RFQRouter', 'setB20Guard', [b20Guard]);
await writeStep('routerSettlement', router, 'RFQRouter.sol', 'RFQRouter', 'setSettlement', [settlement, true]);
await writeStep('routerFacility', router, 'RFQRouter.sol', 'RFQRouter', 'setFacility', [facility, true]);
await writeStep('routerFee', router, 'RFQRouter.sol', 'RFQRouter', 'setFeeBps', [0]);
await writeStep('routerDecisionAge', router, 'RFQRouter.sol', 'RFQRouter', 'setMaxDecisionBlockAge', [3]);
await writeStep('routerFeeRecipient', router, 'RFQRouter.sol', 'RFQRouter', 'setFeeRecipient', [byRole.operator]);
await writeStep('settlementRouter', settlement, 'RFQSettlement.sol', 'RFQSettlement', 'setRouter', [router]);
await writeStep('settlementFee', settlement, 'RFQSettlement.sol', 'RFQSettlement', 'setActiveFeeBps', [0]);
await writeStep('facilityRouter', facility, 'LiquidityFacility.sol', 'LiquidityFacility', 'setRouter', [router]);
await writeStep('aggregatorFacility', facilityAggregator, 'FacilityAggregator.sol', 'FacilityAggregator', 'registerFacility', [byRole.depositor, facility, [mockB20]]);
await writeStep('oracleGuardB20', oracleGuard, 'OracleGuard.sol', 'OracleGuard', 'configureFeed', [mockB20, mockOracleFeed, 86_400n]);

const mockAavePool = await deployStep('mockAavePool', 'BaseQaMocks.sol', 'BaseQaAavePool', [nativeUsdc, mockB20, 1_100_000_000_000_000_000n]);
const mockMorphoBlue = await deployStep('mockMorphoBlue', 'BaseQaMocks.sol', 'BaseQaMorphoBlue', [nativeUsdc]);
const mockEulerDebtVault = await deployStep('mockEulerDebtVault', 'BaseQaMocks.sol', 'BaseQaEulerVault', [nativeUsdc]);
const mockEulerCollateralVault = await deployStep('mockEulerCollateralVault', 'BaseQaMocks.sol', 'BaseQaEulerVault', [mockB20]);
const mockAerodromePool = await deployStep('mockAerodromePool', 'BaseQaMocks.sol', 'BaseQaAerodromePool', [nativeUsdc, mockB20, 10_000_000_000n, 10_000n * QA_STOCK_UNIT]);
await writeStep('mockEulerCollateralLink', mockEulerDebtVault, 'BaseQaMocks.sol', 'BaseQaEulerVault', 'setCollateralVault', [mockEulerCollateralVault]);
await writeStep('mockAaveLimit', mockAavePool, 'BaseQaMocks.sol', 'BaseQaAavePool', 'setLiquidationDebtLimit', [8_000_000n]);
await writeStep('mockMorphoTotals', mockMorphoBlue, 'BaseQaMocks.sol', 'BaseQaMorphoBlue', 'setMarketTotals', [controlMarketParams(mockB20), 1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n]);
await writeStep('mockMorphoLimit', mockMorphoBlue, 'BaseQaMocks.sol', 'BaseQaMorphoBlue', 'setLiquidationRepayLimit', [8_000_000n]);
await writeStep('mockEulerLimits', mockEulerDebtVault, 'BaseQaMocks.sol', 'BaseQaEulerVault', 'setLiquidationLimits', [8_000_000n, 8_800_000_000_000_000_000n]);

const controlAaveMarketId = keccak256(stringToHex('KATON_BASE_CONTROL_AAVE_B20'));
const controlMorphoParams = controlMarketParams(mockB20);
const controlMorphoMarketId = keccak256(encodeAbiTuple(controlMorphoParams));
const controlEulerMarketId = keccak256(stringToHex('KATON_BASE_CONTROL_EULER_B20'));
const aaveLiquidationAdapter = await deployStep('aaveLiquidationAdapter', 'AaveLiquidationAdapter.sol', 'AaveLiquidationAdapter', [mockAavePool, nativeUsdc, mockB20, controlAaveMarketId]);
const morphoLiquidationAdapter = await deployStep('morphoLiquidationAdapter', 'MorphoLiquidationAdapter.sol', 'MorphoLiquidationAdapter', [mockMorphoBlue, controlMorphoParams]);
const eulerLiquidationAdapter = await deployStep('eulerLiquidationAdapter', 'EulerLiquidationAdapter.sol', 'EulerLiquidationAdapter', [mockEulerDebtVault, mockEulerCollateralVault, nativeUsdc, controlEulerMarketId]);
const morphoYieldAdapter = await deployStep('morphoYieldAdapter', 'MorphoYieldAdapter.sol', 'MorphoYieldAdapter', [nativeUsdc, mockMorphoBlue, controlMorphoParams]);
const eulerYieldAdapter = await deployStep('eulerYieldAdapter', 'EulerYieldAdapter.sol', 'EulerYieldAdapter', [nativeUsdc, mockEulerDebtVault]);

for (const [name, adapter] of Object.entries({ aaveLiquidationAdapter, morphoLiquidationAdapter, eulerLiquidationAdapter })) {
  await writeStep(`routerAdapter:${name}`, router, 'RFQRouter.sol', 'RFQRouter', 'setLiquidationAdapter', [adapter, true]);
}
await writeAsRole('facilityMorphoAllowed', 'depositor', facility, 'LiquidityFacility.sol', 'LiquidityFacility', 'setAdapterAllowed', [morphoYieldAdapter, true]);
await writeAsRole('facilityEulerAllowed', 'depositor', facility, 'LiquidityFacility.sol', 'LiquidityFacility', 'setAdapterAllowed', [eulerYieldAdapter, true]);

const realAdapters = {};
if (target === 'anvil') {
  await fundForkAccounts();
  await seedControlVenues({ mockB20, mockMorphoBlue, mockAerodromePool });
  await seedFacility({ facility, morphoYieldAdapter, eulerYieldAdapter });
  realAdapters.aaveYield = await deployStep('aaveYieldAdapter', 'AaveYieldAdapter.sol', 'AaveYieldAdapter', [nativeUsdc, BASE_AAVE_POOL, BASE_AAVE_USDC_ATOKEN]);
  realAdapters.aaveWethLiquidation = await deployStep('aaveWethLiquidationAdapter', 'AaveLiquidationAdapter.sol', 'AaveLiquidationAdapter', [BASE_AAVE_POOL, nativeUsdc, '0x4200000000000000000000000000000000000006', keccak256(stringToHex('KATON_BASE_AAVE_WETH'))]);
  await seedRealAaveWeth();
  await tryCreateRealMorphoMarket(realAdapters);
  await tryCreateRealEulerVaults(realAdapters);
  scenarios.aave = { kind: 'real-base-pool', pool: BASE_AAVE_POOL, collateral: '0x4200000000000000000000000000000000000006', debt: nativeUsdc, healthFactorProgression: 'fork-control-time-interest' };
  scenarios.morpho = { kind: 'fork-created-real-market', singleton: BASE_MORPHO_BLUE, irm: BASE_MORPHO_ADAPTIVE_CURVE_IRM, oracle: mockMutableOracle, collateral: mockB20, debt: nativeUsdc };
  scenarios.euler = { kind: 'fork-created-real-vaults', evc: BASE_EULER_EVC, factory: BASE_EULER_EVAULT_FACTORY, implementation: BASE_EULER_EVAULT_IMPLEMENTATION, collateral: mockB20, debt: nativeUsdc };
  scenarios.aerodrome = { kind: 'read-only-controlled-quote', router: BASE_AERODROME_ROUTER, factory: BASE_AERODROME_FACTORY, pool: mockAerodromePool, swapSubmitted: false };
}

const block = await publicClient.getBlock();
const nativeCode = await publicClient.getBytecode({ address: nativeUsdc });
if (!nativeCode || nativeCode === '0x') throw new Error('BASE_DEPLOY_NATIVE_USDC_CODE');
const deployedAt = new Date().toISOString();
const allAdapters = target === 'anvil'
  ? [
      adapterEntry('aave-control', aaveLiquidationAdapter, controlAaveMarketId, mockAavePool),
      adapterEntry('morpho-control', morphoLiquidationAdapter, controlMorphoMarketId, mockMorphoBlue),
      adapterEntry('euler-control', eulerLiquidationAdapter, controlEulerMarketId, mockEulerDebtVault),
      ...(realAdapters.morphoLiquidation ? [adapterEntry('morpho-real-fork-market', realAdapters.morphoLiquidation, realAdapters.morphoMarketId, BASE_MORPHO_BLUE)] : []),
      ...(realAdapters.eulerLiquidation ? [adapterEntry('euler-real-fork-vaults', realAdapters.eulerLiquidation, realAdapters.eulerMarketId, realAdapters.eulerDebtVault)] : []),
    ]
  : [];

const manifest = {
  schemaVersion: 1,
  network: target === 'anvil' ? 'mainnet' : 'sepolia',
  networkName: target === 'anvil' ? 'Base Mainnet Fork (local)' : 'Base Sepolia',
  chainId,
  environment: target,
  rpcUrl: manifestRpcUrl,
  deployer: getAddress(account.address),
  deployedAt,
  blockNumber: block.number.toString(10),
  blockHash: block.hash,
  productionEligible: false,
  ...(target === 'sepolia' ? { releaseCandidate: true, stockSaleGate: true } : {}),
  forkQa: target === 'anvil',
  ...(target === 'anvil' ? {
    forkBlock: BASE_FORK_BLOCK,
    forkBlockHash: BASE_FORK_BLOCK_HASH,
    forkRpcValidated: true,
  } : {}),
  nativeUsdc,
  nativeUsdcRuntimeBytecodeHash: runtimeBytecodeHash(nativeCode),
  roles: {
    operator: getAddress(byRole.operator),
    depositor: getAddress(byRole.depositor),
    lp: getAddress(byRole.lp),
    admin: getAddress(byRole.operator),
    curator: getAddress(byRole.depositor),
    executor: getAddress(byRole.operator),
    guardian: getAddress(byRole.operator),
  },
  addresses: {
    ...Object.fromEntries(Object.entries(addresses).map(([name, address]) => [name, getAddress(address)])),
    ...(realAdapters.aaveYield ? { aaveYieldAdapter: getAddress(realAdapters.aaveYield) } : {}),
    ...(realAdapters.aaveWethLiquidation ? { aaveWethLiquidationAdapter: getAddress(realAdapters.aaveWethLiquidation) } : {}),
    ...(realAdapters.morphoLiquidation ? { morphoRealLiquidationAdapter: getAddress(realAdapters.morphoLiquidation) } : {}),
    ...(realAdapters.eulerLiquidation ? { eulerRealLiquidationAdapter: getAddress(realAdapters.eulerLiquidation) } : {}),
  },
  transactions: { ...deploymentTransactions, ...configurationTransactions },
  runtimeBytecodeHashes: {},
  venueAddresses: {
    weth: '0x4200000000000000000000000000000000000006',
    aavePool: getAddress(BASE_AAVE_POOL),
    aavePoolAddressesProvider: getAddress(BASE_AAVE_POOL_ADDRESSES_PROVIDER),
    aaveUsdcAToken: getAddress(BASE_AAVE_USDC_ATOKEN),
    morphoBlue: getAddress(BASE_MORPHO_BLUE),
    morphoAdaptiveCurveIrm: getAddress(BASE_MORPHO_ADAPTIVE_CURVE_IRM),
    eulerEvc: getAddress(BASE_EULER_EVC),
    eulerEvaultFactory: getAddress(BASE_EULER_EVAULT_FACTORY),
    eulerEvaultImplementation: getAddress(BASE_EULER_EVAULT_IMPLEMENTATION),
    aerodromeRouter: getAddress(BASE_AERODROME_ROUTER),
    aerodromePoolFactory: getAddress(BASE_AERODROME_FACTORY),
  },
  venuePins: await readVenuePins(target),
  mockClassifications: [
    mockEntry('policy-registry', mockPolicyRegistry, 'QA_POLICY_REGISTRY'),
    mockEntry('oracle-feed', mockOracleFeed, 'QA_ORACLE_FEED'),
    mockEntry('sequencer-feed', mockSequencerFeed, 'QA_SEQUENCER_FEED'),
    mockEntry('mutable-oracle', mockMutableOracle, 'QA_MUTABLE_ORACLE'),
    mockEntry('b20', mockB20, 'QA_B20_CONTROL'),
    mockEntry('aave-pool', mockAavePool, 'QA_AAVE_CONTROL'),
    mockEntry('morpho-blue', mockMorphoBlue, 'QA_MORPHO_CONTROL'),
    mockEntry('euler-debt-vault', mockEulerDebtVault, 'QA_EULER_CONTROL'),
    mockEntry('euler-collateral-vault', mockEulerCollateralVault, 'QA_EULER_CONTROL'),
    mockEntry('aerodrome-pool', mockAerodromePool, 'QA_AERODROME_CONTROL'),
  ],
  adapters: allAdapters,
  b20Assets: {
    [getAddress(mockB20)]: {
      ticker: 'B20',
      feed: getAddress(mockOracleFeed),
      decimals: QA_STOCK_DECIMALS,
      classification: 'QA_B20_CONTROL',
    },
  },
  scenarios,
  configuration: {
    feeBps: 0,
    maxDecisionBlockAge: 3,
    sequencerGracePeriod: 3_600,
    oracleHeartbeat: 86_400,
    settlementUsdc: nativeUsdc,
    firstWaveMarkets: [],
    aerodromeSwapSubmitted: false,
  },
};
for (const [name, address] of Object.entries(manifest.addresses)) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === '0x') throw new Error(`BASE_DEPLOY_NO_BYTECODE:${name}`);
  manifest.runtimeBytecodeHashes[name] = runtimeBytecodeHash(code);
}
const candidateSha256 = target === 'sepolia' ? sha256Manifest(manifest) : undefined;
parseBaseDeploymentManifest(manifest, target);
await fs.mkdir(path.dirname(manifestPath), { recursive: true });
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await fs.writeFile(checkpointPath, `${JSON.stringify({
  ...checkpoint,
  schemaVersion: 1,
  target,
  environment: target,
  chainId,
  rpcUrl: manifestRpcUrl,
  nativeUsdc,
  deployer: checkpointAccounts.deployer,
  roles: checkpointAccounts.roles,
  forkQa: target === 'anvil',
  ...(target === 'anvil' ? { forkBlock: BASE_FORK_BLOCK, forkBlockHash: BASE_FORK_BLOCK_HASH, forkRpcValidated: true } : {}),
  ...(target === 'sepolia' ? { candidateManifestPath: manifestPath, candidateSha256 } : {}),
  addresses,
  transactions: deploymentTransactions,
  configurationTransactions,
  steps: checkpoint.steps ?? {},
  status: 'confirmed',
}, null, 2)}\n`, { mode: 0o600 });
console.log(`base-deploy=PASS target=${target} chainId=${chainId} block=${block.number} manifest=${path.relative(rootDir, manifestPath)}${candidateSha256 ? ` candidateSha256=${candidateSha256}` : ''} adapters=${allAdapters.length} productionEligible=false`);

async function readEnvironment() {
  let fileEnvironment = {};
  try {
    fileEnvironment = parseEnvContents(await fs.readFile(path.join(rootDir, '.env.base-qa.local'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...fileEnvironment, ...process.env };
}

async function loadCheckpoint() {
  try {
    const value = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    if ((target === 'anvil' && value?.chainId === BASE_SEPOLIA_CHAIN_ID) || value?.nativeUsdc?.toLowerCase() === '0xd9aec86b65d86f6a7b5b1b0c42ffa531710b6ca') {
      throw new Error('BASE_DEPLOY_STALE_CHECKPOINT');
    }
    if (target === 'anvil' && value?.chainId !== undefined && (
      value.chainId !== BASE_MAINNET_CHAIN_ID
      || value.forkBlock !== BASE_FORK_BLOCK
      || value.forkBlockHash?.toLowerCase() !== BASE_FORK_BLOCK_HASH.toLowerCase()
      || value.forkRpcValidated !== true
    )) throw new Error('BASE_DEPLOY_STALE_CHECKPOINT');
    if (value?.target && value.target !== target) throw new Error('BASE_DEPLOY_CHECKPOINT_TARGET');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { steps: {}, transactions: {}, configurationTransactions: {}, addresses: {} };
    if (error.message?.startsWith('BASE_DEPLOY_')) throw error;
    throw new Error('BASE_DEPLOY_CHECKPOINT_JSON');
  }
}

async function preflight() {
  const clientVersion = await publicClient.request({ method: 'web3_clientVersion' }).catch(() => '');
  const debugMethods = [];
  if (target === 'anvil') {
    for (const method of ['evm_snapshot', 'evm_revert', 'anvil_setBalance', 'anvil_setCode']) {
      try {
        const params = method === 'evm_revert' ? ['0x1']
          : method === 'anvil_setBalance' ? ['0x000000000000000000000000000000000000dEaD', '0x1']
            : method === 'anvil_setCode' ? ['0x000000000000000000000000000000000000dEaD', '0x00'] : [];
        await publicClient.request({ method, params });
        debugMethods.push(method);
      } catch {
        // assertBaseDeploymentTarget below reports the stable failure code.
      }
    }
  }
  const observedChainId = await publicClient.getChainId();
  assertBaseDeploymentTarget({ target, rpcUrl, chainId: observedChainId, clientVersion, debugMethods });
  const code = await publicClient.getBytecode({ address: nativeUsdc });
  if (!code || code === '0x') throw new Error('BASE_DEPLOY_NATIVE_USDC_CODE');
  const decimals = await publicClient.readContract({ address: nativeUsdc, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals' });
  if (Number(decimals) !== 6) throw new Error('BASE_DEPLOY_NATIVE_USDC_DECIMALS');
  if (target === 'sepolia') await assertZeroDeficitFunding();
  if (target === 'anvil') {
    const pinned = await publicClient.getBlock({ blockNumber: BigInt(BASE_FORK_BLOCK) });
    if (pinned.number !== BigInt(BASE_FORK_BLOCK) || pinned.hash?.toLowerCase() !== BASE_FORK_BLOCK_HASH.toLowerCase()) {
      throw new Error('BASE_DEPLOY_FORK_PIN');
    }
    await validateVenuePins();
  }
}

async function assertZeroDeficitFunding() {
  const deficits = [];
  for (const account of roleAccounts) {
    const ethWei = await publicClient.getBalance({ address: account.address }).catch(() => { throw new Error('BASE_DEPLOY_FUNDING_PREFLIGHT'); });
    const usdcUnits = await publicClient.readContract({ address: nativeUsdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }).catch(() => { throw new Error('BASE_DEPLOY_FUNDING_PREFLIGHT'); });
    const report = buildFundingReport({ ...account, ethWei, usdcUnits }, minimumFunding('sepolia', account.role));
    if (report.ethDeficitWei > 0n || report.usdcDeficitUnits > 0n) deficits.push(account.role);
  }
  if (deficits.length > 0) throw new Error(`BASE_DEPLOY_FUNDING_DEFICIT:${deficits.join(',')}`);
}

async function reconcileCheckpoint() {
  const previousAddresses = Object.values(addresses).filter((address) => typeof address === 'string');
  if (previousAddresses.length === 0) return;
  const live = await Promise.all(previousAddresses.map((address) => hasCode(address)));
  if (live.every(Boolean)) return;
  for (const key of Object.keys(addresses)) delete addresses[key];
  for (const key of Object.keys(deploymentTransactions)) delete deploymentTransactions[key];
  for (const key of Object.keys(configurationTransactions)) delete configurationTransactions[key];
  checkpoint.steps = {};
  checkpoint.transactions = {};
  checkpoint.configurationTransactions = {};
}

async function validateVenuePins() {
  const fixture = JSON.parse(await fs.readFile(path.join(rootDir, 'fixtures/base/venues-mainnet.json'), 'utf8'));
  for (const pin of fixture.pins ?? []) {
    const code = await publicClient.getBytecode({ address: pin.address });
    if (!code || code === '0x' || runtimeBytecodeHash(code).toLowerCase() !== pin.bytecodeHash.toLowerCase()) {
      throw new Error(`BASE_DEPLOY_VENUE_PIN:${pin.name}`);
    }
  }
}

async function readVenuePins(networkTarget) {
  if (networkTarget !== 'anvil') return [];
  const fixture = JSON.parse(await fs.readFile(path.join(rootDir, 'fixtures/base/venues-mainnet.json'), 'utf8'));
  return fixture.pins ?? [];
}

async function deployStep(name, source, contract, args = []) {
  const artifact = await getArtifact(source, contract);
  const oldAddress = addresses[name] ?? checkpoint.steps?.[name]?.address;
  if (oldAddress && await hasCode(oldAddress)) {
    addresses[name] = getAddress(oldAddress);
    return getAddress(oldAddress);
  }
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account,
    gas: 8_000_000n,
  });
  const receipt = await wait(hash);
  if (!receipt.contractAddress) throw new Error(`BASE_DEPLOY_NO_CONTRACT:${name}`);
  const address = getAddress(receipt.contractAddress);
  addresses[name] = address;
  deploymentTransactions[name] = hash;
  checkpoint.steps = { ...(checkpoint.steps ?? {}), [name]: { status: 'confirmed', address, transactionHash: hash } };
  await saveCheckpoint();
  console.log(`deployed=${name} address=${address}`);
  return address;
}

async function writeStep(name, targetAddress, source, contract, functionName, args, signer = wallets.operator) {
  const step = checkpoint.steps?.[name];
  if (step?.status === 'confirmed' && step.transactionHash) {
    configurationTransactions[name] = step.transactionHash;
    return step.transactionHash;
  }
  const artifact = await getArtifact(source, contract);
  const hash = await signer.writeContract({ address: targetAddress, abi: artifact.abi, functionName, args, account: signer.account, gas: 1_000_000n });
  await wait(hash);
  configurationTransactions[name] = hash;
  checkpoint.steps = { ...(checkpoint.steps ?? {}), [name]: { status: 'confirmed', transactionHash: hash } };
  await saveCheckpoint();
  return hash;
}

async function writeAsRole(name, role, targetAddress, source, contract, functionName, args) {
  return writeStep(name, targetAddress, source, contract, functionName, args, wallets[role]);
}

async function writeExternalStep(
  name,
  targetAddress,
  abi,
  functionName,
  args,
  signer = wallets.operator,
  value = 0n,
  gas = 3_000_000n,
) {
  if (configurationTransactions[name]) return configurationTransactions[name];
  const hash = await signer.writeContract({
    address: targetAddress,
    abi,
    functionName,
    args,
    account: signer.account,
    value,
    gas,
  });
  await wait(hash);
  configurationTransactions[name] = hash;
  await saveCheckpoint();
  return hash;
}

async function getArtifact(source, contract) {
  const key = `${source}:${contract}`;
  if (artifacts.has(key)) return artifacts.get(key);
  const file = path.join(rootDir, 'contracts/base/out', source, `${contract}.json`);
  const artifact = parseFoundryArtifact(JSON.parse(await fs.readFile(file, 'utf8')));
  artifacts.set(key, artifact);
  return artifact;
}

async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const trace = await publicClient.request({
      method: 'debug_traceTransaction',
      params: [hash, { tracer: 'callTracer' }],
    }).catch(() => undefined);
    if (trace) {
      const calls = [];
      const collectCalls = (call, depth = 0) => {
        if (!call || depth > 8 || calls.length >= 32) return;
        calls.push({
          depth,
          to: call.to,
          input: call.input?.slice(0, 74),
          error: call.error,
          output: call.output?.slice(0, 74),
        });
        for (const child of call.calls ?? []) collectCalls(child, depth + 1);
      };
      collectCalls(trace);
      console.error(`base-deploy-revert-trace=${JSON.stringify({
        failed: trace.failed,
        error: trace.error,
        returnValue: trace.returnValue,
        output: trace.output?.slice(0, 74),
        calls,
      })}`);
    }
    throw new Error(`BASE_DEPLOY_TRANSACTION_REVERTED:${hash}`);
  }
  return receipt;
}

async function hasCode(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(address)) return false;
  const code = await publicClient.getBytecode({ address }).catch(() => undefined);
  return Boolean(code && code !== '0x');
}

async function saveCheckpoint() {
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.writeFile(checkpointPath, `${JSON.stringify({
    ...checkpoint,
    schemaVersion: 1,
    target,
    environment: target,
    chainId,
    rpcUrl: manifestRpcUrl,
    nativeUsdc,
    deployer: checkpointAccounts.deployer,
    roles: checkpointAccounts.roles,
    forkQa: target === 'anvil',
    ...(target === 'anvil' ? { forkBlock: BASE_FORK_BLOCK, forkBlockHash: BASE_FORK_BLOCK_HASH, forkRpcValidated: true } : {}),
    ...(target === 'sepolia' ? { candidateManifestPath: manifestPath } : {}),
    addresses,
    transactions: deploymentTransactions,
    configurationTransactions,
  }, null, 2)}\n`, { mode: 0o600 });
}

function controlMarketParams(collateralToken) {
  return {
    loanToken: nativeUsdc,
    collateralToken,
    oracle: '0x0000000000000000000000000000000000000000',
    irm: '0x0000000000000000000000000000000000000000',
    lltv: 800_000_000_000_000_000n,
  };
}

function encodeAbiTuple(params) {
  return encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
    ],
    [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
  );
}

function adapterEntry(name, address, marketId, venue) {
  return { name, address: getAddress(address), marketId, venue: getAddress(venue), actualAmounts: true };
}

function mockEntry(name, address, classification) {
  return { name, address: getAddress(address), classification, venueEvidence: false };
}

async function seedRealAaveWeth() {
  const weth = '0x4200000000000000000000000000000000000006';
  const aaveAbi = [
    { type: 'function', name: 'getReserveData', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [
      { name: 'configuration', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint128' },
      { name: 'currentLiquidityRate', type: 'uint128' },
      { name: 'variableBorrowIndex', type: 'uint128' },
      { name: 'currentVariableBorrowRate', type: 'uint128' },
      { name: 'currentStableBorrowRate', type: 'uint128' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
      { name: 'id', type: 'uint16' },
      { name: 'aTokenAddress', type: 'address' },
      { name: 'stableDebtTokenAddress', type: 'address' },
      { name: 'variableDebtTokenAddress', type: 'address' },
      { name: 'accruedToTreasury', type: 'uint128' },
      { name: 'unbacked', type: 'uint128' },
      { name: 'isolationModeTotalDebt', type: 'uint128' },
    ] },
    { type: 'function', name: 'supply', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], outputs: [] },
    { type: 'function', name: 'borrow', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'referralCode', type: 'uint16' }, { name: 'onBehalfOf', type: 'address' }], outputs: [] },
    { type: 'function', name: 'getUserAccountData', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' }, { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' }, { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' }] },
  ];
  const tokenAbi = [
    { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  ];
  const reserveData = await publicClient.readContract({ address: BASE_AAVE_POOL, abi: aaveAbi, functionName: 'getReserveData', args: [weth] });
  const aToken = getAddress(reserveData.aTokenAddress ?? reserveData[8]);
  const accountData = () => publicClient.readContract({ address: BASE_AAVE_POOL, abi: aaveAbi, functionName: 'getUserAccountData', args: [byRole.operator] });
  let data = await accountData();
  let debtBase = data.totalDebtBase ?? data[1] ?? 0n;
  const supplied = await publicClient.readContract({ address: aToken, abi: tokenAbi, functionName: 'balanceOf', args: [byRole.operator] });
  if (supplied === 0n) {
    const amount = 10n * 10n ** 18n;
    await writeExternalStep('realAaveWethDeposit', weth, [
      { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
    ], 'deposit', [], wallets.operator, amount);
    await writeExternalStep('realAaveWethApproval', weth, tokenAbi, 'approve', [BASE_AAVE_POOL, amount]);
    await writeExternalStep('realAaveWethSupply', BASE_AAVE_POOL, aaveAbi, 'supply', [weth, amount, byRole.operator, 0]);
    await writeExternalStep('realAaveWethApprovalClear', weth, tokenAbi, 'approve', [BASE_AAVE_POOL, 0n]);
    data = await accountData();
    debtBase = data.totalDebtBase ?? data[1] ?? 0n;
  }
  if (debtBase === 0n) {
    const availableBorrowsBase = data.availableBorrowsBase ?? data[2] ?? 0n;
    const borrowAmount = availableBorrowsBase * 990_000n / 100_000_000n;
    if (borrowAmount === 0n) throw new Error('BASE_FORK_AAVE_BORROW_ZERO');
    await writeExternalStep('realAaveWethBorrow', BASE_AAVE_POOL, aaveAbi, 'borrow', [nativeUsdc, borrowAmount, 2, 0, byRole.operator]);
  }
  data = await accountData();
  let healthFactor = data.healthFactor ?? data[5] ?? 0n;
  let progressionYears = 0;
  while (healthFactor >= 1_000_000_000_000_000_000n && progressionYears < 100) {
    await rpc('evm_increaseTime', [31_536_000]);
    await rpc('evm_mine');
    data = await accountData();
    healthFactor = data.healthFactor ?? data[5] ?? 0n;
    progressionYears += 1;
  }
  if (healthFactor >= 1_000_000_000_000_000_000n) throw new Error('BASE_FORK_AAVE_HEALTHY_AFTER_PROGRESSION');
}

async function fundForkAccounts() {
  for (const role of ['operator', 'depositor', 'lp']) {
    await rpc('anvil_setBalance', [byRole[role], '0x3635C9ADC5DEA00000']);
  }
  const masterMinter = await publicClient.readContract({
    address: nativeUsdc,
    abi: [{ type: 'function', name: 'masterMinter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
    functionName: 'masterMinter',
  });
  await rpc('anvil_impersonateAccount', [masterMinter]);
  await rpc('anvil_setBalance', [masterMinter, '0x3635C9ADC5DEA00000']);
  const minterAbi = [
    { type: 'function', name: 'configureMinter', stateMutability: 'nonpayable', inputs: [{ name: 'minter', type: 'address' }, { name: 'minterAllowedAmount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'removeMinter', stateMutability: 'nonpayable', inputs: [{ name: 'minter', type: 'address' }], outputs: [{ type: 'bool' }] },
  ];
  await rawImpersonatedWrite(masterMinter, encodeFunctionData({ abi: minterAbi, functionName: 'configureMinter', args: [byRole.operator, 1_000_000_000_000n] }), 'fundConfigureMinter');
  const mintAbi = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
  for (const role of ['operator', 'depositor', 'lp']) {
    const balance = await publicClient.readContract({ address: nativeUsdc, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [byRole[role]] });
    const required = role === 'lp'
      ? 200_000_000n
      : role === 'operator' ? 20_000_000_000n : 2_000_000_000n;
    if (balance < required) {
      const hash = await wallets.operator.writeContract({ address: nativeUsdc, abi: mintAbi, functionName: 'mint', args: [byRole[role], required - balance], account: wallets.operator.account });
      await wait(hash);
    }
  }
  await rawImpersonatedWrite(masterMinter, encodeFunctionData({ abi: minterAbi, functionName: 'removeMinter', args: [byRole.operator] }), 'fundRemoveMinter').catch(() => {});
  await rpc('anvil_stopImpersonatingAccount', [masterMinter]).catch(() => {});
}

async function rawImpersonatedWrite(from, data, label) {
  const hash = await rpc('eth_sendTransaction', [{ from, to: nativeUsdc, data, value: '0x0' }]);
  await wait(hash);
  configurationTransactions[label] = hash;
}

async function seedControlVenues({ mockB20: b20, mockMorphoBlue: morpho, mockAerodromePool: pool }) {
  const mint = async (name, recipient, amount) => writeStep(name, b20, 'BaseQaMocks.sol', 'BaseQaB20', 'mint', [recipient, amount]);
  await mint('mintB20Operator', byRole.operator, 300n * QA_STOCK_UNIT);
  await mint('mintB20Morpho', morpho, 10_000n * QA_STOCK_UNIT);
  await mint('mintB20Pool', pool, 10_000n * QA_STOCK_UNIT);
  if (!configurationTransactions.fundPoolUsdc) {
    const erc20Abi = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
    const hash = await wallets.operator.writeContract({ address: nativeUsdc, abi: erc20Abi, functionName: 'transfer', args: [pool, 10_000_000_000n], account: wallets.operator.account });
    await wait(hash);
    configurationTransactions.fundPoolUsdc = hash;
    await saveCheckpoint();
  }
}

async function seedFacility({ facility: targetFacility, morphoYieldAdapter: morphoAdapter, eulerYieldAdapter: eulerAdapter }) {
  const erc20Abi = [
    { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  ];
  const depositAmount = 1_000_000_000n;
  const approve = await wallets.depositor.writeContract({ address: nativeUsdc, abi: erc20Abi, functionName: 'approve', args: [targetFacility, depositAmount], account: wallets.depositor.account });
  await wait(approve);
  configurationTransactions.facilityDepositApproval = approve;
  await writeAsRole('facilityDeposit', 'depositor', targetFacility, 'LiquidityFacility.sol', 'LiquidityFacility', 'deposit', [depositAmount, byRole.depositor]);
  await writeAsRole('facilityAllocateMorpho', 'depositor', targetFacility, 'LiquidityFacility.sol', 'LiquidityFacility', 'allocate', [morphoAdapter, 100_000_000n]);
  await writeAsRole('facilityAllocateEuler', 'depositor', targetFacility, 'LiquidityFacility.sol', 'LiquidityFacility', 'allocate', [eulerAdapter, 100_000_000n]);
}

async function tryCreateRealMorphoMarket(result) {
  const abi = [
    { type: 'function', name: 'isIrmEnabled', stateMutability: 'view', inputs: [{ name: 'irm', type: 'address' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'isLltvEnabled', stateMutability: 'view', inputs: [{ name: 'lltv', type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'createMarket', stateMutability: 'nonpayable', inputs: [{ name: 'marketParams', type: 'tuple', components: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] }], outputs: [] },
    { type: 'function', name: 'market', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ name: 'market', type: 'tuple', components: [{ name: 'totalSupplyAssets', type: 'uint128' }, { name: 'totalSupplyShares', type: 'uint128' }, { name: 'totalBorrowAssets', type: 'uint128' }, { name: 'totalBorrowShares', type: 'uint128' }, { name: 'lastUpdate', type: 'uint128' }, { name: 'fee', type: 'uint128' }] }] },
    { type: 'function', name: 'position', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'user', type: 'address' }], outputs: [{ name: 'position', type: 'tuple', components: [{ name: 'supplyShares', type: 'uint256' }, { name: 'borrowShares', type: 'uint128' }, { name: 'collateral', type: 'uint128' }] }] },
    { type: 'function', name: 'supply', stateMutability: 'nonpayable', inputs: [{ name: 'marketParams', type: 'tuple', components: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] }, { name: 'assets', type: 'uint256' }, { name: 'shares', type: 'uint256' }, { name: 'onBehalf', type: 'address' }, { name: 'data', type: 'bytes' }], outputs: [{ name: 'assetsSupplied', type: 'uint256' }, { name: 'sharesSupplied', type: 'uint256' }] },
    { type: 'function', name: 'supplyCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'marketParams', type: 'tuple', components: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] }, { name: 'assets', type: 'uint256' }, { name: 'onBehalf', type: 'address' }, { name: 'data', type: 'bytes' }], outputs: [] },
    { type: 'function', name: 'borrow', stateMutability: 'nonpayable', inputs: [{ name: 'marketParams', type: 'tuple', components: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] }, { name: 'assets', type: 'uint256' }, { name: 'shares', type: 'uint256' }, { name: 'onBehalf', type: 'address' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'assetsBorrowed', type: 'uint256' }, { name: 'sharesBorrowed', type: 'uint256' }] },
  ];
  if (!await publicClient.readContract({ address: BASE_MORPHO_BLUE, abi, functionName: 'isIrmEnabled', args: [BASE_MORPHO_ADAPTIVE_CURVE_IRM] }).catch(() => false)) {
    throw new Error('BASE_FORK_MORPHO_IRM_DISABLED');
  }
  const lltv = await firstEnabledLltv(abi);
  const params = { loanToken: nativeUsdc, collateralToken: addresses.mockB20, oracle: addresses.mockMutableOracle, irm: BASE_MORPHO_ADAPTIVE_CURVE_IRM, lltv };
  const marketId = keccak256(encodeAbiTuple(params));
  const existingMarket = await publicClient.readContract({ address: BASE_MORPHO_BLUE, abi, functionName: 'market', args: [marketId] });
  const lastUpdate = existingMarket?.lastUpdate ?? existingMarket?.[4] ?? 0n;
  if (lastUpdate === 0n) {
    await writeExternalStep('realMorphoCreateMarket', BASE_MORPHO_BLUE, abi, 'createMarket', [params]);
  }
  const position = await publicClient.readContract({ address: BASE_MORPHO_BLUE, abi, functionName: 'position', args: [marketId, byRole.operator] });
  const supplyShares = position?.supplyShares ?? position?.[0] ?? 0n;
  const borrowShares = position?.borrowShares ?? position?.[1] ?? 0n;
  const collateralAssets = position?.collateral ?? position?.[2] ?? 0n;
  const tokenAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
  const oracleAbi = [{ type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'setPrice', stateMutability: 'nonpayable', inputs: [{ name: 'nextPrice', type: 'uint256' }], outputs: [] }];
  if (borrowShares === 0n) {
    await setForkOraclePrice('realMorphoOracleHealthy', addresses.mockMutableOracle, oracleAbi, 10n ** 24n);
    if (supplyShares === 0n) {
      await writeExternalStep('realMorphoSupplyApproval', nativeUsdc, tokenAbi, 'approve', [BASE_MORPHO_BLUE, 100_000_000n]);
      await writeExternalStep('realMorphoSupply', BASE_MORPHO_BLUE, abi, 'supply', [params, 100_000_000n, 0n, byRole.operator, '0x']);
    }
    if (collateralAssets === 0n) {
      await writeExternalStep('realMorphoCollateralApproval', addresses.mockB20, tokenAbi, 'approve', [BASE_MORPHO_BLUE, 100n * QA_STOCK_UNIT]);
      await writeExternalStep('realMorphoSupplyCollateral', BASE_MORPHO_BLUE, abi, 'supplyCollateral', [params, 100n * QA_STOCK_UNIT, byRole.operator, '0x']);
    }
    await writeExternalStep('realMorphoBorrow', BASE_MORPHO_BLUE, abi, 'borrow', [params, 10_000_000n, 0n, byRole.operator, byRole.operator]);
  }
  await setForkOraclePrice('realMorphoOracleUnhealthy', addresses.mockMutableOracle, oracleAbi, 11n * 10n ** 22n);
  const liquidation = await deployStep('morphoRealLiquidationAdapter', 'MorphoLiquidationAdapter.sol', 'MorphoLiquidationAdapter', [BASE_MORPHO_BLUE, params]);
  result.morphoLiquidation = liquidation;
  result.morphoMarketId = marketId;
  result.morphoMarketParams = params;
}

async function firstEnabledLltv(abi) {
  for (const candidate of [800_000_000_000_000_000n, 860_000_000_000_000_000n, 770_000_000_000_000_000n, 650_000_000_000_000_000n, 500_000_000_000_000_000n]) {
    if (await publicClient.readContract({ address: BASE_MORPHO_BLUE, abi, functionName: 'isLltvEnabled', args: [candidate] }).catch(() => false)) return candidate;
  }
  throw new Error('BASE_FORK_MORPHO_LLTV_DISABLED');
}

async function setForkOraclePrice(name, oracle, abi, nextPrice) {
  const current = await publicClient.readContract({ address: oracle, abi, functionName: 'price' });
  if (current === nextPrice) return;
  await writeExternalStep(name, oracle, abi, 'setPrice', [nextPrice]);
}

async function tryCreateRealEulerVaults(result) {
  const factoryAbi = [
    { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'getProxyListLength', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'proxyList', stateMutability: 'view', inputs: [{ name: 'index', type: 'uint256' }], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'createProxy', stateMutability: 'nonpayable', inputs: [{ name: 'desiredImplementation', type: 'address' }, { name: 'upgradeable', type: 'bool' }, { name: 'trailingData', type: 'bytes' }], outputs: [{ name: 'proxy', type: 'address' }] },
  ];
  const implementation = await publicClient.readContract({ address: BASE_EULER_EVAULT_FACTORY, abi: factoryAbi, functionName: 'implementation' });
  if (getAddress(implementation) !== getAddress(BASE_EULER_EVAULT_IMPLEMENTATION)) throw new Error('BASE_FORK_EULER_IMPLEMENTATION');
  // GenericFactory adds its four-byte zero prefix before forwarding this
  // metadata.  The EVault proxy therefore expects exactly the three
  // addresses below (60 bytes) as trailingData.
  const metadata = (asset) => encodePacked(['address', 'address', 'address'], [asset, addresses.mockMutableOracle, nativeUsdc]);
  let debtVault = addresses.realEulerDebtVault;
  let collateralVault = addresses.realEulerCollateralVault;
  if (!(await hasCode(debtVault) && await hasCode(collateralVault))) {
    const before = await publicClient.readContract({ address: BASE_EULER_EVAULT_FACTORY, abi: factoryAbi, functionName: 'getProxyListLength' });
    await writeExternalStep('realEulerDebtVaultCreate', BASE_EULER_EVAULT_FACTORY, factoryAbi, 'createProxy', [BASE_EULER_EVAULT_IMPLEMENTATION, false, metadata(nativeUsdc)]);
    await writeExternalStep('realEulerCollateralVaultCreate', BASE_EULER_EVAULT_FACTORY, factoryAbi, 'createProxy', [BASE_EULER_EVAULT_IMPLEMENTATION, false, metadata(addresses.mockB20)]);
    debtVault = getAddress(await publicClient.readContract({ address: BASE_EULER_EVAULT_FACTORY, abi: factoryAbi, functionName: 'proxyList', args: [before] }));
    collateralVault = getAddress(await publicClient.readContract({ address: BASE_EULER_EVAULT_FACTORY, abi: factoryAbi, functionName: 'proxyList', args: [before + 1n] }));
    addresses.realEulerDebtVault = debtVault;
    addresses.realEulerCollateralVault = collateralVault;
    await saveCheckpoint();
  }
  const vaultAbi = [
    { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'permit2Address', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'debtOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'setHookConfig', stateMutability: 'nonpayable', inputs: [{ name: 'newHookTarget', type: 'address' }, { name: 'newHookedOps', type: 'uint32' }], outputs: [] },
    { type: 'function', name: 'setLTV', stateMutability: 'nonpayable', inputs: [{ name: 'collateral', type: 'address' }, { name: 'borrowLTV', type: 'uint16' }, { name: 'liquidationLTV', type: 'uint16' }, { name: 'rampDuration', type: 'uint32' }], outputs: [] },
    { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }] },
    { type: 'function', name: 'borrow', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }] },
  ];
  if (getAddress(await publicClient.readContract({ address: debtVault, abi: vaultAbi, functionName: 'asset' })) !== getAddress(nativeUsdc)) throw new Error('BASE_FORK_EULER_DEBT_ASSET');
  if (getAddress(await publicClient.readContract({ address: collateralVault, abi: vaultAbi, functionName: 'asset' })) !== getAddress(addresses.mockB20)) throw new Error('BASE_FORK_EULER_COLLATERAL_ASSET');
  const tokenAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
  const permit2Abi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }], outputs: [] }];
  const oracleAbi = [{ type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'setPrice', stateMutability: 'nonpayable', inputs: [{ name: 'nextPrice', type: 'uint256' }], outputs: [] }];
  const evcAbi = [
    { type: 'function', name: 'enableCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }, { name: 'vault', type: 'address' }], outputs: [] },
    { type: 'function', name: 'enableController', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }, { name: 'vault', type: 'address' }], outputs: [] },
  ];
  await setForkOraclePrice('realEulerOracleHealthy', addresses.mockMutableOracle, oracleAbi, 10n ** 24n);
  await writeExternalStep('realEulerDebtEnableOperations', debtVault, vaultAbi, 'setHookConfig', [
    '0x0000000000000000000000000000000000000000',
    0,
  ]);
  await writeExternalStep('realEulerCollateralEnableOperations', collateralVault, vaultAbi, 'setHookConfig', [
    '0x0000000000000000000000000000000000000000',
    0,
  ]);
  await writeExternalStep('realEulerSetLTV', debtVault, vaultAbi, 'setLTV', [collateralVault, 7_500, 8_000, 0]);
  const borrower = byRole.depositor;
  const borrowerWallet = wallets.depositor;
  await writeExternalStep('realEulerEnableCollateral', BASE_EULER_EVC, evcAbi, 'enableCollateral', [borrower, collateralVault], borrowerWallet);
  const debtPermit2 = getAddress(await publicClient.readContract({ address: debtVault, abi: vaultAbi, functionName: 'permit2Address' }));
  const collateralPermit2 = getAddress(await publicClient.readContract({ address: collateralVault, abi: vaultAbi, functionName: 'permit2Address' }));
  if (debtPermit2 !== getAddress(BASE_PERMIT2) || collateralPermit2 !== getAddress(BASE_PERMIT2)) {
    throw new Error('BASE_FORK_EULER_PERMIT2');
  }
  await writeStep('mintB20EulerBorrower', addresses.mockB20, 'BaseQaMocks.sol', 'BaseQaB20', 'mint', [borrower, 100n * QA_STOCK_UNIT]);
  const currentDebt = await publicClient.readContract({ address: debtVault, abi: vaultAbi, functionName: 'debtOf', args: [borrower] });
  if (currentDebt === 0n) {
    await writeExternalStep('realEulerDebtPermit2TokenApproval', nativeUsdc, tokenAbi, 'approve', [debtPermit2, 100_000_000n]);
    await writeExternalStep('realEulerDebtPermit2Approval', debtPermit2, permit2Abi, 'approve', [nativeUsdc, debtVault, 100_000_000n, 281_474_976_710_655n]);
    await writeExternalStep('realEulerDebtApproval', nativeUsdc, tokenAbi, 'approve', [debtVault, 100_000_000n]);
    await writeExternalStep('realEulerDebtDeposit', debtVault, vaultAbi, 'deposit', [100_000_000n, byRole.operator], wallets.operator, 0n, 2_000_000n);
    await writeExternalStep('realEulerDebtPermit2TokenApprovalClear', nativeUsdc, tokenAbi, 'approve', [debtPermit2, 0n]);
    await writeExternalStep('realEulerDebtPermit2ApprovalClear', debtPermit2, permit2Abi, 'approve', [nativeUsdc, debtVault, 0n, 281_474_976_710_655n]);
    await writeExternalStep('realEulerDebtApprovalClear', nativeUsdc, tokenAbi, 'approve', [debtVault, 0n]);
  }
  const collateralShares = await publicClient.readContract({ address: collateralVault, abi: vaultAbi, functionName: 'balanceOf', args: [borrower] });
  if (collateralShares === 0n) {
    await writeExternalStep('realEulerCollateralPermit2TokenApproval', addresses.mockB20, tokenAbi, 'approve', [collateralPermit2, 100n * QA_STOCK_UNIT], borrowerWallet);
    await writeExternalStep('realEulerCollateralPermit2Approval', collateralPermit2, permit2Abi, 'approve', [addresses.mockB20, collateralVault, 100n * QA_STOCK_UNIT, 281_474_976_710_655n], borrowerWallet);
    await writeExternalStep('realEulerCollateralApproval', addresses.mockB20, tokenAbi, 'approve', [collateralVault, 100n * QA_STOCK_UNIT], borrowerWallet);
    await writeExternalStep('realEulerCollateralDeposit', collateralVault, vaultAbi, 'deposit', [100n * QA_STOCK_UNIT, borrower], borrowerWallet, 0n, 2_000_000n);
    await writeExternalStep('realEulerCollateralPermit2TokenApprovalClear', addresses.mockB20, tokenAbi, 'approve', [collateralPermit2, 0n], borrowerWallet);
    await writeExternalStep('realEulerCollateralPermit2ApprovalClear', collateralPermit2, permit2Abi, 'approve', [addresses.mockB20, collateralVault, 0n, 281_474_976_710_655n], borrowerWallet);
    await writeExternalStep('realEulerCollateralApprovalClear', addresses.mockB20, tokenAbi, 'approve', [collateralVault, 0n], borrowerWallet);
  }
  if (currentDebt === 0n) {
    await writeExternalStep('realEulerEnableController', BASE_EULER_EVC, evcAbi, 'enableController', [borrower, debtVault], borrowerWallet);
    await writeExternalStep('realEulerBorrow', debtVault, vaultAbi, 'borrow', [10_000_000n, borrower], borrowerWallet);
  }
  await setForkOraclePrice('realEulerOracleUnhealthy', addresses.mockMutableOracle, oracleAbi, 11n * 10n ** 22n);
  const marketId = keccak256(stringToHex('KATON_BASE_EULER_REAL_B20'));
  const liquidation = await deployStep('eulerRealLiquidationAdapter', 'EulerLiquidationAdapter.sol', 'EulerLiquidationAdapter', [debtVault, collateralVault, nativeUsdc, marketId]);
  result.eulerDebtVault = debtVault;
  result.eulerCollateralVault = collateralVault;
  result.eulerLiquidation = liquidation;
  result.eulerMarketId = marketId;
}

async function rpc(method, params = []) {
  return publicClient.request({ method, params });
}
