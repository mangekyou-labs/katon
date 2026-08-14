import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
} from 'viem';
import { flareTestnet } from 'viem/chains';

import { validateDeploymentSnapshot } from '../packages/flare-contracts/src/smoke.ts';
import { loadWorktreeEnv } from './load-worktree-env.mjs';

loadWorktreeEnv();

const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const manifestPath = process.env.FLARE_DEPLOYMENT_MANIFEST
  ? resolve(process.env.FLARE_DEPLOYMENT_MANIFEST)
  : existsSync(resolve(import.meta.dirname, '../contracts/flare/deployments/coston2-proxy-candidate.json'))
    ? resolve(import.meta.dirname, '../contracts/flare/deployments/coston2-proxy-candidate.json')
    : resolve(import.meta.dirname, '../contracts/flare/deployments/coston2.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
validateDeploymentSnapshot(manifest);

const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const equalAddress = (left, right) => getAddress(left) === getAddress(right);

const routerAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'guardian', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'eligibilityRegistry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'protocolFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'maxDecisionBlockAge', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decisionBlockHashRequired', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
];
const settlementAbi = [
  { type: 'function', name: 'feeRecipient', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'guardian', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'router', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'eligibilityRegistry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const eligibilityAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'guardian', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'POLICY_DELAY', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
];
const navAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'guardian', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fdcVerification', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const guardianAbi = [
  { type: 'function', name: 'guardian', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const proxyAbi = [
  { type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const proxyAdminAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const timelockAbi = [
  { type: 'function', name: 'minDelay', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'proposer', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'executor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

const chainId = await client.getChainId();
if (chainId !== manifest.chainId) throw new Error(`CHAIN_ID:${chainId}`);

for (const [name, address] of Object.entries(manifest.contracts)) {
  const bytecode = await client.getBytecode({ address });
  if (!bytecode || bytecode === '0x') throw new Error(`NO_BYTECODE:${name}`);
  if (manifest.bytecodeHashes?.[name] && keccak256(bytecode) !== manifest.bytecodeHashes[name]) {
    throw new Error(`BYTECODE_HASH:${name}`);
  }
  console.log(`${name}=bytecode`);
}

const router = manifest.contracts.router;
const settlement = manifest.contracts.settlement;
const eligibility = manifest.contracts.eligibilityRegistry;
const expectedOwner = manifest.configuration.governanceOwner ?? manifest.deployer;
if (manifest.configuration.proxyAdmin) {
  for (const [name, address] of Object.entries(manifest.contracts)) {
    const proxyAdmin = await client.readContract({ address, abi: proxyAbi, functionName: 'admin' });
    if (!equalAddress(proxyAdmin, manifest.configuration.proxyAdmin)) throw new Error(`PROXY_ADMIN:${name}`);
    const implementation = await client.readContract({ address, abi: proxyAbi, functionName: 'implementation' });
    if (!manifest.configuration.implementationAddresses?.[name] || !equalAddress(implementation, manifest.configuration.implementationAddresses[name])) throw new Error(`PROXY_IMPLEMENTATION:${name}`);
  }
  const proxyAdminOwner = await client.readContract({ address: manifest.configuration.proxyAdmin, abi: proxyAdminAbi, functionName: 'owner' });
  if (!manifest.configuration.proxyAdminOwner || !equalAddress(proxyAdminOwner, manifest.configuration.proxyAdminOwner)) throw new Error('PROXY_ADMIN_OWNER');
  if (!manifest.configuration.timelock) throw new Error('TIMELOCK_REQUIRED');
  const [minDelay, proposer, executor] = await Promise.all([
    client.readContract({ address: manifest.configuration.timelock, abi: timelockAbi, functionName: 'minDelay' }),
    client.readContract({ address: manifest.configuration.timelock, abi: timelockAbi, functionName: 'proposer' }),
    client.readContract({ address: manifest.configuration.timelock, abi: timelockAbi, functionName: 'executor' }),
  ]);
  if (minDelay < 172_800n) throw new Error('TIMELOCK_DELAY');
  if (manifest.configuration.proposer && !equalAddress(proposer, manifest.configuration.proposer)) throw new Error('TIMELOCK_PROPOSER');
  if (manifest.configuration.executor && !equalAddress(executor, manifest.configuration.executor)) throw new Error('TIMELOCK_EXECUTOR');
}
const [routerOwner, routerRegistry, routerFee, routerMaxAge, routerHashRequired] = await Promise.all([
  client.readContract({ address: router, abi: routerAbi, functionName: 'owner' }),
  client.readContract({ address: router, abi: routerAbi, functionName: 'eligibilityRegistry' }),
  client.readContract({ address: router, abi: routerAbi, functionName: 'protocolFeeBps' }),
  client.readContract({ address: router, abi: routerAbi, functionName: 'maxDecisionBlockAge' }),
  client.readContract({ address: router, abi: routerAbi, functionName: 'decisionBlockHashRequired' }),
]);
if (manifest.configuration.guardian) {
  const routerGuardian = await client.readContract({ address: router, abi: routerAbi, functionName: 'guardian' });
  if (!equalAddress(routerGuardian, manifest.configuration.guardian)) throw new Error('ROUTER_GUARDIAN');
}
if (!equalAddress(routerOwner, expectedOwner)) throw new Error('ROUTER_OWNER');
if (!equalAddress(routerRegistry, eligibility)) throw new Error('ROUTER_REGISTRY');
if (Number(routerFee) !== manifest.configuration.routerProtocolFeeBps) throw new Error('ROUTER_FEE');
if (routerMaxAge !== BigInt(manifest.configuration.routerSnapshotMaxAge)) throw new Error('ROUTER_SNAPSHOT_AGE');
if (routerHashRequired !== manifest.configuration.routerSnapshotHashRequired) throw new Error('ROUTER_SNAPSHOT_HASH');

const [settlementOwner, settlementRouter, settlementRegistry] = await Promise.all([
  client.readContract({ address: settlement, abi: settlementAbi, functionName: 'feeRecipient' }),
  client.readContract({ address: settlement, abi: settlementAbi, functionName: 'router' }),
  client.readContract({ address: settlement, abi: settlementAbi, functionName: 'eligibilityRegistry' }),
]);
if (manifest.configuration.guardian) {
  const settlementGuardian = await client.readContract({ address: settlement, abi: settlementAbi, functionName: 'guardian' });
  if (!equalAddress(settlementGuardian, manifest.configuration.guardian)) throw new Error('SETTLEMENT_GUARDIAN');
}
if (!equalAddress(settlementOwner, expectedOwner)) throw new Error('SETTLEMENT_OWNER');
if (!equalAddress(settlementRouter, router)) throw new Error('SETTLEMENT_ROUTER');
if (!equalAddress(settlementRegistry, eligibility)) throw new Error('SETTLEMENT_REGISTRY');

const [eligibilityOwner, policyDelay] = await Promise.all([
  client.readContract({ address: eligibility, abi: eligibilityAbi, functionName: 'owner' }),
  client.readContract({ address: eligibility, abi: eligibilityAbi, functionName: 'POLICY_DELAY' }),
]);
if (manifest.configuration.guardian) {
  const eligibilityGuardian = await client.readContract({ address: eligibility, abi: eligibilityAbi, functionName: 'guardian' });
  if (!equalAddress(eligibilityGuardian, manifest.configuration.guardian)) throw new Error('ELIGIBILITY_GUARDIAN');
}
if (!equalAddress(eligibilityOwner, expectedOwner)) throw new Error('ELIGIBILITY_OWNER');
if (policyDelay !== 172_800n) throw new Error('ELIGIBILITY_POLICY_DELAY');
const [navOwner, navVerifier] = await Promise.all([
  client.readContract({ address: manifest.contracts.navProofRegistry, abi: navAbi, functionName: 'owner' }),
  client.readContract({ address: manifest.contracts.navProofRegistry, abi: navAbi, functionName: 'fdcVerification' }),
]);
if (manifest.configuration.guardian) {
  const navGuardian = await client.readContract({ address: manifest.contracts.navProofRegistry, abi: navAbi, functionName: 'guardian' });
  if (!equalAddress(navGuardian, manifest.configuration.guardian)) throw new Error('NAV_GUARDIAN');
}
if (!equalAddress(navOwner, expectedOwner)) throw new Error('NAV_OWNER');
if (!manifest.configuration.fdcVerification || !equalAddress(navVerifier, manifest.configuration.fdcVerification)) throw new Error('NAV_FDC_VERIFIER');
if (manifest.configuration.guardian) {
  for (const name of ['instructionSender', 'facilityAggregator', 'ftsoRiskGuard']) {
    const guardian = await client.readContract({ address: manifest.contracts[name], abi: guardianAbi, functionName: 'guardian' });
    if (!equalAddress(guardian, manifest.configuration.guardian)) throw new Error(`${name.toUpperCase()}_GUARDIAN`);
  }
}

console.log(`chainId=${chainId}`);
console.log(`router=${router}`);
console.log(`settlement=${settlement}`);
console.log(`eligibilityRegistry=${eligibility}`);
console.log(`eligibilityPolicyDelay=${policyDelay}`);
console.log('Coston2 deployment smoke: PASS');
