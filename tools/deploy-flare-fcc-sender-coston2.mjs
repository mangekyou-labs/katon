import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, getAddress, http, keccak256, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const projectRoot = resolve(import.meta.dirname, '..');
const baseManifestPath = resolve(projectRoot, 'contracts/flare/deployments/coston2.json');
const outPath = resolve(projectRoot, process.env.FLARE_FCC_SENDER_MANIFEST ?? 'contracts/flare/deployments/coston2-fcc-sender.json');
const REQUIRED_SELECTORS = {
  dispatchConfidential: 'function dispatchConfidential(bytes32 opType, bytes32 command, bytes32 actionId, bytes32 payloadCommitment, bytes message, uint256 teeCount, uint64 expiry)',
  submitFccResult: 'function submitFccResult(bytes32 instructionId, bytes resultData, string submissionTag, uint8 status, bytes signature)',
  configureFcc: 'function configureFcc(address extensionRegistry, address machineRegistry, uint256 extensionId, uint64 quorumThreshold)',
  quorum: 'function quorum(bytes32 actionId)',
};

function loadPrivateKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  const match = readFileSync(resolve(projectRoot, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m);
  if (!match) throw new Error('PRIVATE_KEY_REQUIRED');
  return match[1].trim();
}

function artifact() {
  const path = resolve(projectRoot, 'contracts/flare/out/ConfidentialRFQInstructionSender.sol/ConfidentialRFQInstructionSender.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

const data = artifact();
const bytecode = data.bytecode.object ?? data.bytecode;
if (!bytecode || bytecode === '0x') throw new Error('SENDER_BYTECODE_MISSING');
for (const [name, signature] of Object.entries(REQUIRED_SELECTORS)) {
  const selector = toFunctionSelector(signature).slice(2);
  if (!bytecode.toLowerCase().includes(selector)) throw new Error(`SENDER_SELECTOR_MISSING:${name}`);
}

const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const account = privateKeyToAccount(loadPrivateKey());
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

console.log('network=Flare Coston2 (chainId 114)');
console.log(`deployer=${account.address}`);
console.log(`balanceWei=${await publicClient.getBalance({ address: account.address })}`);
console.log(`artifactBytecodeHash=${keccak256(bytecode)}`);

const hash = await walletClient.deployContract({
  abi: data.abi,
  bytecode,
  account,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`SENDER_DEPLOY_REVERTED:${hash}`);

const address = getAddress(receipt.contractAddress);
const onChain = await publicClient.getBytecode({ address });
if (!onChain || onChain === '0x') throw new Error(`SENDER_NO_BYTECODE:${address}`);
const onChainHash = keccak256(onChain);
for (const [name, signature] of Object.entries(REQUIRED_SELECTORS)) {
  const selector = toFunctionSelector(signature).slice(2);
  if (!onChain.toLowerCase().includes(selector)) throw new Error(`ONCHAIN_SELECTOR_MISSING:${name}`);
}

const owner = await publicClient.readContract({
  address,
  abi: data.abi,
  functionName: 'owner',
});
if (getAddress(owner) !== getAddress(account.address)) throw new Error(`SENDER_OWNER:${owner}`);

const base = JSON.parse(readFileSync(baseManifestPath, 'utf8'));
const manifest = {
  network: 'coston2',
  chainId: 114,
  deployer: account.address,
  deployedAt: new Date().toISOString(),
  purpose: 'eoa-owned ConfidentialRFQInstructionSender with dispatchConfidential/submitFccResult',
  contracts: {
    ...base.contracts,
    instructionSender: address,
    legacyInstructionSender: base.contracts.instructionSender,
  },
  configuration: {
    ...base.configuration,
    fccExtensionId: null,
    fccQuorumThreshold: null,
    configureFcc: null,
  },
  deploymentTransactions: {
    ConfidentialRFQInstructionSender: hash,
  },
  bytecodeHashes: {
    instructionSender: onChainHash,
  },
  notes: {
    doNotConfigureLegacy: base.contracts.instructionSender,
    doNotUseExtension: 66280,
  },
};
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`instructionSender=${address}`);
console.log(`deployTx=${hash}`);
console.log(`blockNumber=${receipt.blockNumber}`);
console.log(`onChainBytecodeHash=${onChainHash}`);
console.log(`onChainBytecodeBytes=${(onChain.length - 2) / 2}`);
console.log(`owner=${owner}`);
console.log(`manifest=${outPath.replace(`${projectRoot}/`, '')}`);
console.log('fcc-sender-deploy=PASS');
