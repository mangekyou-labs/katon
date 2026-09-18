import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createPublicClient, getAddress, http } from 'viem';

import {
  BASE_SEPOLIA_NATIVE_USDC,
  assertBaseDeploymentTarget,
  parseFoundryArtifact,
  runtimeBytecodeHash,
} from './base-deployment-lib.mjs';
import { parseEnvContents } from './base-qa-lib.mjs';
import {
  candidatePaths,
  parseReleasePathArg,
  readCandidateManifest,
  validateSmokeEvidence,
} from './base-release-gate-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  await main();
} catch (error) {
  console.error(`smoke-base-sepolia=FAIL reason=${stableReason(error)}`);
  process.exitCode = 1;
}

async function main() {
  const environment = await readOptionalEnvironment();
  const rpcUrl = environment.BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org';
  const releasePaths = candidatePaths(rootDir, 'sepolia');
  const candidate = await readCandidateManifest(rootDir, parseReleasePathArg(process.argv.slice(2), '--candidate'));
  const manifest = candidate.manifest;
  const chain = {
    id: 84532,
    name: 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }) });
  const chainId = await client.getChainId();
  assertBaseDeploymentTarget({ target: 'sepolia', rpcUrl, chainId });

  for (const [name, address] of Object.entries(manifest.addresses)) {
    const code = await client.getCode({ address });
    assertEqual(runtimeBytecodeHash(code), manifest.runtimeBytecodeHashes[name], `BYTECODE_HASH:${name}`);
  }
  const nativeCode = await client.getCode({ address: BASE_SEPOLIA_NATIVE_USDC });
  assertEqual(runtimeBytecodeHash(nativeCode), manifest.nativeUsdcRuntimeBytecodeHash, 'NATIVE_USDC_BYTECODE_HASH');

  const artifacts = {
    router: await artifact('RFQRouter.sol', 'RFQRouter'),
    settlement: await artifact('RFQSettlement.sol', 'RFQSettlement'),
    facility: await artifact('LiquidityFacility.sol', 'LiquidityFacility'),
    facilityAggregator: await artifact('FacilityAggregator.sol', 'FacilityAggregator'),
    oracleGuard: await artifact('OracleGuard.sol', 'OracleGuard'),
    b20Guard: await artifact('B20Guard.sol', 'B20Guard'),
  };
  const read = (name, functionName, args = []) => client.readContract({ address: manifest.addresses[name], abi: artifacts[name].abi, functionName, args });
  const operator = manifest.roles.operator;
  assertAddress(await read('router', 'admin'), operator, 'ROUTER_ADMIN');
  assertAddress(await read('router', 'feeRecipient'), operator, 'FEE_RECIPIENT');
  assertEqual(Number(await read('router', 'feeBps')), 0, 'ROUTER_FEE');
  assertEqual(Number(await read('router', 'maxDecisionBlockAge')), 3, 'DECISION_AGE');
  assertAddress(await read('router', 'oracleGuard'), manifest.addresses.oracleGuard, 'ROUTER_ORACLE_GUARD');
  assertAddress(await read('router', 'b20Guard'), manifest.addresses.b20Guard, 'ROUTER_B20_GUARD');
  assertEqual(await read('router', 'settlements', [manifest.addresses.settlement]), true, 'ROUTER_SETTLEMENT');
  assertEqual(await read('router', 'facilities', [manifest.addresses.facility]), true, 'ROUTER_FACILITY');

  assertAddress(await read('settlement', 'admin'), operator, 'SETTLEMENT_ADMIN');
  assertAddress(await read('settlement', 'router'), manifest.addresses.router, 'SETTLEMENT_ROUTER');
  assertAddress(await read('settlement', 'usdc'), BASE_SEPOLIA_NATIVE_USDC, 'SETTLEMENT_USDC');
  assertEqual(Number(await read('settlement', 'activeFeeBps')), 0, 'SETTLEMENT_FEE');

  assertAddress(await read('facility', 'admin'), operator, 'FACILITY_ADMIN');
  assertAddress(await read('facility', 'curator'), manifest.roles.curator, 'FACILITY_CURATOR');
  assertAddress(await read('facility', 'executor'), manifest.roles.executor, 'FACILITY_EXECUTOR');
  assertAddress(await read('facility', 'guardian'), manifest.roles.guardian, 'FACILITY_GUARDIAN');
  assertAddress(await read('facility', 'asset'), BASE_SEPOLIA_NATIVE_USDC, 'FACILITY_USDC');
  assertAddress(await read('facility', 'router'), manifest.addresses.router, 'FACILITY_ROUTER');
  assertEqual(await read('facility', 'haircutWad'), 0n, 'FACILITY_HAIRCUT');

  assertAddress(await read('facilityAggregator', 'admin'), operator, 'AGGREGATOR_ADMIN');
  assertAddress(await read('facilityAggregator', 'router'), manifest.addresses.router, 'AGGREGATOR_ROUTER');
  assertEqual(await read('facilityAggregator', 'registered', [manifest.addresses.facility]), true, 'FACILITY_REGISTERED');
  assertEqual(await read('facilityAggregator', 'facilityCount'), 1n, 'FACILITY_COUNT');
  assertAddress(await read('facilityAggregator', 'facilityAt', [0n]), manifest.addresses.facility, 'FACILITY_AT');

  assertAddress(await read('oracleGuard', 'admin'), operator, 'ORACLE_ADMIN');
  assertAddress(await read('oracleGuard', 'sequencerFeed'), manifest.addresses.mockSequencerFeed, 'SEQUENCER_FEED');
  assertAddress(await read('oracleGuard', 'oracleRegistry'), manifest.addresses.mockPolicyRegistry, 'ORACLE_REGISTRY');
  assertEqual(await read('oracleGuard', 'gracePeriod'), 3_600n, 'SEQUENCER_GRACE');
  const feedConfig = await read('oracleGuard', 'feedConfigs', [manifest.addresses.mockB20]);
  assertAddress(feedConfig[0], manifest.addresses.mockOracleFeed, 'B20_FEED');
  assertEqual(feedConfig[1], 86_400n, 'B20_HEARTBEAT');
  assertAddress(await read('b20Guard', 'admin'), operator, 'B20_ADMIN');
  assertAddress(await read('b20Guard', 'policyRegistry'), manifest.addresses.mockPolicyRegistry, 'B20_POLICY');

  assertEqual(manifest.adapters.length, 0, 'SEPOLIA_ADAPTER_LIST');
  const evidence = {
    schemaVersion: 1,
    kind: 'base-sepolia-smoke',
    target: 'sepolia',
    chainId,
    candidateSha256: candidate.candidateSha256,
    checks: 35,
    productionEligible: false,
    nativeUsdc: manifest.nativeUsdc,
    addresses: {
      router: manifest.addresses.router,
      settlement: manifest.addresses.settlement,
      facility: manifest.addresses.facility,
    },
    checkedAt: new Date().toISOString(),
  };
  validateSmokeEvidence(evidence, manifest, candidate.candidateSha256);
  await fs.mkdir(releasePaths.candidateDir, { recursive: true });
  await fs.writeFile(releasePaths.smokeProofPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`smoke-base-sepolia=PASS checks=35 chainId=${chainId} candidateSha256=${candidate.candidateSha256} proof=${path.relative(rootDir, releasePaths.smokeProofPath)} nativeUsdc=${manifest.nativeUsdc} adapters=0 productionEligible=false`);
}

async function readOptionalEnvironment() {
  try {
    return parseEnvContents(await fs.readFile(path.join(rootDir, '.env.base-qa.local'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function artifact(source, contract) {
  return parseFoundryArtifact(JSON.parse(await fs.readFile(path.join(rootDir, 'contracts/base/out', source, `${contract}.json`), 'utf8')));
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) throw new Error(`BASE_SMOKE_${code}: expected ${expected}, received ${actual}`);
}

function assertAddress(actual, expected, code) {
  assertEqual(getAddress(actual), getAddress(expected), code);
}

function stableReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^BASE_[A-Z0-9_:-]+$/u.test(message)) return message;
  if (message.startsWith('BASE_QA_')) return message.split(':', 1)[0];
  return 'BASE_QA_SMOKE_RPC';
}
