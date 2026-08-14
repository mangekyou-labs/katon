import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

if (process.env.FLARE_DEPLOY_PROXY_CANDIDATE !== 'true') throw new Error('PROXY_CANDIDATE_EXPLICIT_ENABLE_REQUIRED');
const root = resolve(import.meta.dirname, '..');
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const key = process.env.PRIVATE_KEY ?? readFileSync(resolve(root, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error('PRIVATE_KEY_REQUIRED');
const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const account = privateKeyToAccount(key);
const proposer = getAddress(process.env.FLARE_GOVERNANCE_PROPOSER ?? account.address);
const executor = getAddress(process.env.FLARE_GOVERNANCE_EXECUTOR ?? account.address);
const guardian = getAddress(process.env.FLARE_GOVERNANCE_GUARDIAN ?? account.address);
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const deployments = {};
const configs = {};
const priorManifest = JSON.parse(readFileSync(resolve(root, 'contracts/flare/deployments/coston2.json'), 'utf8'));

function artifact(source, contract) {
  return JSON.parse(readFileSync(resolve(root, 'contracts/flare/out', source, `${contract}.json`), 'utf8'));
}
async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
  return receipt;
}
async function deploy(source, contract, args = []) {
  const data = artifact(source, contract);
  const hash = await walletClient.deployContract({ abi: data.abi, bytecode: data.bytecode.object ?? data.bytecode, args, account });
  const receipt = await wait(hash);
  if (!receipt.contractAddress) throw new Error(`NO_CONTRACT_ADDRESS:${contract}`);
  deployments[contract] = { address: getAddress(receipt.contractAddress), deployTx: hash, abi: data.abi };
  return deployments[contract];
}
async function write(address, abi, functionName, args = []) {
  const hash = await walletClient.writeContract({ address, abi, functionName, args, account });
  await wait(hash);
  configs[`${functionName}:${address}`] = hash;
  return hash;
}

const timelock = await deploy('GovernanceTimelock.sol', 'GovernanceTimelock', [172_800, proposer, executor]);
const proxyAdmin = await deploy('TransparentProxy.sol', 'ProxyAdmin', [account.address]);
const sourceByName = {
  eligibilityRegistry: ['EligibilityRegistry.sol', 'EligibilityRegistry'],
  router: ['RFQRouter.sol', 'RFQRouter'],
  settlement: ['RFQSettlement.sol', 'RFQSettlement'],
  instructionSender: ['ConfidentialRFQInstructionSender.sol', 'ConfidentialRFQInstructionSender'],
  facilityAggregator: ['FacilityAggregator.sol', 'FacilityAggregator'],
  navProofRegistry: ['ProofGuards.sol', 'NavProofRegistry'],
  ftsoRiskGuard: ['ProofGuards.sol', 'FtsoRiskGuard'],
};
const implementations = {};
for (const [name, [source, contract]] of Object.entries(sourceByName)) implementations[name] = await deploy(source, contract);

const initByName = {
  eligibilityRegistry: encodeFunctionData({ abi: implementations.eligibilityRegistry.abi, functionName: 'initialize', args: [account.address] }),
  router: encodeFunctionData({ abi: implementations.router.abi, functionName: 'initialize', args: [account.address, account.address] }),
  settlement: encodeFunctionData({ abi: implementations.settlement.abi, functionName: 'initialize', args: [account.address] }),
  instructionSender: encodeFunctionData({ abi: implementations.instructionSender.abi, functionName: 'initialize', args: [account.address] }),
  facilityAggregator: encodeFunctionData({ abi: implementations.facilityAggregator.abi, functionName: 'initialize', args: [account.address] }),
  navProofRegistry: encodeFunctionData({ abi: implementations.navProofRegistry.abi, functionName: 'initialize', args: [account.address] }),
  ftsoRiskGuard: encodeFunctionData({ abi: implementations.ftsoRiskGuard.abi, functionName: 'initialize', args: [account.address] }),
};
const proxyArtifact = artifact('TransparentProxy.sol', 'TransparentUpgradeableProxy');
const proxies = {};
for (const name of Object.keys(sourceByName)) {
  const implementation = implementations[name];
  const hash = await walletClient.deployContract({
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode.object ?? proxyArtifact.bytecode,
    args: [implementation.address, proxyAdmin.address, initByName[name]],
    account,
  });
  const receipt = await wait(hash);
  if (!receipt.contractAddress) throw new Error(`NO_PROXY_ADDRESS:${name}`);
  proxies[name] = getAddress(receipt.contractAddress);
  configs[`proxy:${name}`] = hash;
}

await write(proxies.router, implementations.router.abi, 'setEligibilityRegistry', [proxies.eligibilityRegistry]);
await write(proxies.router, implementations.router.abi, 'setFccQuorumVerifier', [proxies.instructionSender]);
await write(proxies.router, implementations.router.abi, 'setProtocolFeeBps', [50]);
await write(proxies.router, implementations.router.abi, 'setSnapshotPolicy', [256n, true]);
await write(proxies.settlement, implementations.settlement.abi, 'setEligibilityRegistry', [proxies.eligibilityRegistry]);
await write(proxies.settlement, implementations.settlement.abi, 'setRouter', [proxies.router]);
for (const [name, implementation] of Object.entries(implementations)) {
  await write(proxies[name], implementation.abi, 'setGuardian', [guardian]);
}
const fdcVerification = process.env.FLARE_FDC_VERIFICATION ?? priorManifest.configuration?.fdcVerification;
if (fdcVerification) {
  await write(proxies.navProofRegistry, implementations.navProofRegistry.abi, 'configureFdcVerification', [getAddress(fdcVerification)]);
}
for (const [name, implementation] of Object.entries(implementations)) {
  await write(proxies[name], implementation.abi, 'transferOwnership', [timelock.address]);
}
await write(proxyAdmin.address, deployments.ProxyAdmin.abi, 'transferOwnership', [timelock.address]);

const bytecodeHashes = {};
for (const [name, address] of Object.entries(proxies)) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === '0x') throw new Error(`NO_PROXY_BYTECODE:${name}`);
  bytecodeHashes[name] = keccak256(code);
}
const manifest = {
  network: 'coston2', chainId: 114, deployer: account.address, deployedAt: new Date().toISOString(),
  candidate: 'transparent-proxy-v1',
  contractRevision: 'guardian-pause-v1',
  contracts: proxies,
  configuration: {
    routerProtocolFeeBps: 50, routerSnapshotMaxAge: 256, routerSnapshotHashRequired: true,
    routerFccQuorumVerifier: proxies.instructionSender,
    settlementEligibilityRegistry: proxies.eligibilityRegistry, settlementRouter: proxies.router,
    governanceOwner: timelock.address, proxyAdmin: proxyAdmin.address, proxyAdminOwner: timelock.address,
    implementationAddresses: Object.fromEntries(Object.entries(implementations).map(([name, value]) => [name, value.address])),
    timelock: timelock.address,
    fdcVerification: fdcVerification ?? null,
    governanceStatus: proposer === account.address || executor === account.address || guardian === account.address ? 'timelock-active-bootstrap-governance' : 'timelock-handoff-complete',
    proposer,
    executor,
    guardian,
    bootstrap: proposer === account.address || executor === account.address || guardian === account.address,
  },
  deploymentTransactions: Object.fromEntries(Object.entries(deployments).map(([name, value]) => [name, value.deployTx])),
  configurationTransactions: configs,
  bytecodeHashes,
  implementationBytecodeHashes: Object.fromEntries(await Promise.all(Object.entries(implementations).map(async ([name, value]) => {
    const code = await publicClient.getBytecode({ address: value.address });
    return [name, keccak256(code)];
  }))),
  implementationStorageLayoutHashes: Object.fromEntries(Object.entries(implementations).map(([name]) => {
    const [source, contract] = sourceByName[name];
    const data = artifact(source, contract);
    return [name, keccak256(new TextEncoder().encode(JSON.stringify(data.storageLayout)))];
  })),
};
const output = resolve(root, 'contracts/flare/deployments/coston2-proxy-candidate.json');
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`proxy-candidate=PASS manifest=${output}`);
console.log(`proxyAdmin=${proxyAdmin.address} timelock=${timelock.address} owner=${account.address}`);
