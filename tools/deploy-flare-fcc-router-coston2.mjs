import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, getAddress, http, keccak256, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const projectRoot = resolve(import.meta.dirname, '..');
const senderManifestPath = resolve(projectRoot, process.env.FLARE_FCC_SENDER_MANIFEST ?? 'contracts/flare/deployments/coston2-fcc-sender.json');
const baseManifestPath = resolve(projectRoot, 'contracts/flare/deployments/coston2.json');
const outPath = resolve(projectRoot, process.env.FLARE_FCC_ROUTER_MANIFEST ?? 'contracts/flare/deployments/coston2-fcc-router.json');
const REQUIRED_SELECTORS = {
  fccQuorumVerifier: 'function fccQuorumVerifier()',
  setFccQuorumVerifier: 'function setFccQuorumVerifier(address verifier)',
  executeSwapRoute: 'function executeSwapRoute((uint256,address,bytes32,bytes32,uint256,bytes32,uint256,address,address,address,address,uint256,uint256,uint16,bytes32,uint256,uint256,bytes32,(address,uint256,uint256,bytes)[]) route)',
  hashSwapRoute: 'function hashSwapRoute((uint256,address,bytes32,bytes32,uint256,bytes32,uint256,address,address,address,address,uint256,uint256,uint16,bytes32,uint256,uint256,bytes32,(address,uint256,uint256,bytes)[]) route)',
};

function loadPrivateKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  const match = readFileSync(resolve(projectRoot, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m);
  if (!match) throw new Error('PRIVATE_KEY_REQUIRED');
  return match[1].trim();
}

function artifact() {
  const path = resolve(projectRoot, 'contracts/flare/out/RFQRouter.sol/RFQRouter.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

const data = artifact();
const bytecode = data.bytecode.object ?? data.bytecode;
if (!bytecode || bytecode === '0x') throw new Error('ROUTER_BYTECODE_MISSING');
for (const [name, signature] of Object.entries(REQUIRED_SELECTORS)) {
  const selector = toFunctionSelector(signature).slice(2);
  if (!bytecode.toLowerCase().includes(selector)) throw new Error(`ROUTER_SELECTOR_MISSING:${name}`);
}

const senderManifest = JSON.parse(readFileSync(senderManifestPath, 'utf8'));
const baseManifest = JSON.parse(readFileSync(baseManifestPath, 'utf8'));
const sender = getAddress(senderManifest.contracts.instructionSender);
const eligibility = getAddress(senderManifest.contracts.eligibilityRegistry ?? baseManifest.contracts.eligibilityRegistry);
const source = getAddress(baseManifest.mockAssets.source);

const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const account = privateKeyToAccount(loadPrivateKey());
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
  return receipt;
}

console.log('network=Flare Coston2 (chainId 114)');
console.log(`deployer=${account.address}`);
console.log(`balanceWei=${await publicClient.getBalance({ address: account.address })}`);
console.log(`artifactBytecodeHash=${keccak256(bytecode)}`);
console.log(`fccVerifier=${sender}`);

const hash = await walletClient.deployContract({ abi: data.abi, bytecode, account });
const receipt = await wait(hash);
if (!receipt.contractAddress) throw new Error(`ROUTER_DEPLOY_REVERTED:${hash}`);

const address = getAddress(receipt.contractAddress);
const onChain = await publicClient.getBytecode({ address });
if (!onChain || onChain === '0x') throw new Error(`ROUTER_NO_BYTECODE:${address}`);
const onChainHash = keccak256(onChain);
for (const [name, signature] of Object.entries(REQUIRED_SELECTORS)) {
  const selector = toFunctionSelector(signature).slice(2);
  if (!onChain.toLowerCase().includes(selector)) throw new Error(`ONCHAIN_SELECTOR_MISSING:${name}`);
}

const owner = await publicClient.readContract({ address, abi: data.abi, functionName: 'owner' });
if (getAddress(owner) !== getAddress(account.address)) throw new Error(`ROUTER_OWNER:${owner}`);

const configurationTransactions = {};
async function call(functionName, args) {
  const tx = await walletClient.writeContract({ address, abi: data.abi, functionName, args, account });
  await wait(tx);
  configurationTransactions[functionName] = tx;
  console.log(`${functionName}Tx=${tx}`);
  return tx;
}

await call('setEligibilityRegistry', [eligibility]);
await call('setFccQuorumVerifier', [sender]);
await call('setProtocolFeeBps', [50]);
await call('setSnapshotPolicy', [256n, true]);
await call('setSource', [source, true]);

const verifier = await publicClient.readContract({ address, abi: data.abi, functionName: 'fccQuorumVerifier' });
if (getAddress(verifier) !== sender) throw new Error(`FCC_VERIFIER:${verifier}`);

const manifest = {
  network: 'coston2',
  chainId: 114,
  deployer: account.address,
  deployedAt: new Date().toISOString(),
  purpose: 'eoa-owned RFQRouter with fccQuorumVerifier bound to 66283 sender',
  contracts: {
    ...senderManifest.contracts,
    router: address,
    legacyRouter: senderManifest.contracts.router,
    instructionSender: sender,
  },
  configuration: {
    ...senderManifest.configuration,
    settlementRouter: address,
    routerFccQuorumVerifier: sender,
    routerProtocolFeeBps: 50,
    routerSnapshotMaxAge: 256,
    routerSnapshotHashRequired: true,
  },
  mockAssets: baseManifest.mockAssets,
  deploymentTransactions: {
    RFQRouter: hash,
  },
  configurationTransactions,
  bytecodeHashes: {
    router: onChainHash,
  },
  notes: {
    doNotUpgradeBrowserProxy: '0x7fA1817951dE405a0c466696052cF50Eba409333',
    doNotReuseLegacyRouter: senderManifest.contracts.router,
    fccExtensionId: 66283,
  },
};
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`router=${address}`);
console.log(`deployTx=${hash}`);
console.log(`blockNumber=${receipt.blockNumber}`);
console.log(`onChainBytecodeHash=${onChainHash}`);
console.log(`onChainBytecodeBytes=${(onChain.length - 2) / 2}`);
console.log(`fccQuorumVerifier=${verifier}`);
console.log(`owner=${owner}`);
console.log(`manifest=${outPath.replace(`${projectRoot}/`, '')}`);
console.log('fcc-router-deploy=PASS');
