import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const projectRoot = resolve(import.meta.dirname, '..');

function loadPrivateKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  const envPath = resolve(projectRoot, '.env');
  const match = readFileSync(envPath, 'utf8').match(/^PRIVATE_KEY=(.+)$/m);
  if (!match) throw new Error('PRIVATE_KEY_REQUIRED');
  return match[1].trim();
}

function artifact(source, contract) {
  const path = resolve(projectRoot, 'contracts/flare/out', source, `${contract}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const chain = {
  ...flareTestnet,
  id: 114,
  rpcUrls: { default: { http: [rpcUrl] } },
};
const account = privateKeyToAccount(loadPrivateKey());
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const deploymentTransactions = {};
const configurationTransactions = {};

async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
  return receipt;
}

async function deploy(source, contract) {
  const data = artifact(source, contract);
  const hash = await walletClient.deployContract({
    abi: data.abi,
    bytecode: data.bytecode.object ?? data.bytecode,
    account,
  });
  const receipt = await wait(hash);
  if (!receipt.contractAddress) throw new Error(`NO_CONTRACT_ADDRESS:${contract}`);
  deploymentTransactions[contract] = hash;
  console.log(`${contract}=${receipt.contractAddress}`);
  console.log(`${contract}.deployTx=${hash}`);
  return { address: receipt.contractAddress, abi: data.abi };
}

async function call(contract, functionName, args) {
  const hash = await walletClient.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
    account,
  });
  await wait(hash);
  configurationTransactions[functionName] = hash;
  console.log(`${functionName}Tx=${hash}`);
  return hash;
}

console.log(`network=Flare Coston2 (chainId 114)`);
console.log(`deployer=${account.address}`);
console.log(`balanceWei=${await publicClient.getBalance({ address: account.address })}`);

const eligibility = await deploy('EligibilityRegistry.sol', 'EligibilityRegistry');
const router = await deploy('RFQRouter.sol', 'RFQRouter');
const settlement = await deploy('RFQSettlement.sol', 'RFQSettlement');
const instructionSender = await deploy('ConfidentialRFQInstructionSender.sol', 'ConfidentialRFQInstructionSender');
const aggregator = await deploy('FacilityAggregator.sol', 'FacilityAggregator');
const navProofs = await deploy('ProofGuards.sol', 'NavProofRegistry');
const ftsoGuard = await deploy('ProofGuards.sol', 'FtsoRiskGuard');

await call(router, 'setEligibilityRegistry', [eligibility.address]);
await call(router, 'setFccQuorumVerifier', [instructionSender.address]);
await call(router, 'setProtocolFeeBps', [50]);
await call(router, 'setSnapshotPolicy', [256n, true]);
await call(settlement, 'setEligibilityRegistry', [eligibility.address]);
await call(settlement, 'setRouter', [router.address]);

console.log(`eligibilityRegistry=${await publicClient.readContract({ address: router.address, abi: router.abi, functionName: 'eligibilityRegistry' })}`);
console.log(`settlementRouter=${await publicClient.readContract({ address: settlement.address, abi: settlement.abi, functionName: 'router' })}`);
console.log(`settlementEligibility=${await publicClient.readContract({ address: settlement.address, abi: settlement.abi, functionName: 'eligibilityRegistry' })}`);
console.log(`instructionSender=${instructionSender.address}`);
console.log(`facilityAggregator=${aggregator.address}`);
console.log(`navProofRegistry=${navProofs.address}`);
console.log(`ftsoRiskGuard=${ftsoGuard.address}`);

const manifest = {
  network: 'coston2',
  chainId: 114,
  deployer: account.address,
  deployedAt: new Date().toISOString(),
  contracts: {
    eligibilityRegistry: eligibility.address,
    router: router.address,
    settlement: settlement.address,
    instructionSender: instructionSender.address,
    facilityAggregator: aggregator.address,
    navProofRegistry: navProofs.address,
    ftsoRiskGuard: ftsoGuard.address,
  },
  configuration: {
    routerProtocolFeeBps: 50,
    routerSnapshotMaxAge: 256,
    routerSnapshotHashRequired: true,
    routerFccQuorumVerifier: instructionSender.address,
    settlementEligibilityRegistry: eligibility.address,
    settlementRouter: router.address,
  },
  deploymentTransactions,
  configurationTransactions,
  bytecodeHashes: Object.fromEntries(await Promise.all(Object.entries({
    eligibilityRegistry: eligibility.address,
    router: router.address,
    settlement: settlement.address,
    instructionSender: instructionSender.address,
    facilityAggregator: aggregator.address,
    navProofRegistry: navProofs.address,
    ftsoRiskGuard: ftsoGuard.address,
  }).map(async ([name, address]) => {
    const bytecode = await publicClient.getBytecode({ address });
    if (!bytecode || bytecode === '0x') throw new Error(`NO_BYTECODE:${name}`);
    return [name, keccak256(bytecode)];
  }))),
};
writeFileSync(resolve(projectRoot, 'contracts/flare/deployments/coston2.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('manifest=contracts/flare/deployments/coston2.json');
