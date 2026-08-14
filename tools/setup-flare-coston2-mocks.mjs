import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const projectRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'contracts/flare/deployments/coston2.json'), 'utf8'));

function privateKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  const env = readFileSync(resolve(projectRoot, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m);
  if (!env) throw new Error('PRIVATE_KEY_REQUIRED');
  return env[1].trim();
}

function artifact(source, contract) {
  return JSON.parse(readFileSync(resolve(projectRoot, 'contracts/flare/out', source, `${contract}.json`), 'utf8'));
}

const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const account = privateKeyToAccount(privateKey());
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const tokenArtifact = artifact('TypedSwapRoute.t.sol', 'TypedSwapToken');
const sourceArtifact = artifact('TypedSwapRoute.t.sol', 'TypedSwapSource');
const registryArtifact = artifact('EligibilityRegistry.sol', 'EligibilityRegistry');
const routerArtifact = artifact('RFQRouter.sol', 'RFQRouter');

if (manifest.mockAssets && manifest.configuration?.mockSellerPolicyId) {
  console.log('mocks=already-configured');
  process.exit(0);
}

async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
  return receipt;
}

async function deploy(data, args = []) {
  const hash = await walletClient.deployContract({
    abi: data.abi,
    bytecode: data.bytecode.object ?? data.bytecode,
    args,
    account,
  });
  const receipt = await wait(hash);
  if (!receipt.contractAddress) throw new Error('NO_CONTRACT_ADDRESS');
  return { address: receipt.contractAddress, abi: data.abi, deployTx: hash };
}

async function write(contract, functionName, args) {
  const hash = await walletClient.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
    account,
  });
  await wait(hash);
  return hash;
}

const rwa = await deploy(tokenArtifact);
const usdx = await deploy(tokenArtifact);
const source = await deploy(sourceArtifact, [rwa.address, usdx.address, 1_000n * 10n ** 18n]);
// A failed setup may have committed the policy before the later allowlist
// transaction timed out. Use a run-scoped id so retries can complete without
// attempting to overwrite an immutable policy slot.
const policyId = keccak256(stringToHex(`coston2-mock-seller-policy:${Date.now()}:${account.address}`));
const issuerReference = keccak256(stringToHex('coston2-mock-issuer'));

const mintAbi = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }];
const approveAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }];
await write({ ...rwa, abi: mintAbi }, 'mint', [account.address, 100n * 10n ** 18n]);
await write({ ...usdx, abi: mintAbi }, 'mint', [source.address, 1_000n * 10n ** 18n]);
await write({ ...rwa, abi: approveAbi }, 'approve', [source.address, 100n * 10n ** 18n]);

const now = BigInt(Math.floor(Date.now() / 1000));
const registryAbi = [{
  type: 'function', name: 'setPolicy', stateMutability: 'nonpayable',
  inputs: [
    { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' },
    { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' },
  ], outputs: [],
}];
const policyTx = await write({ address: manifest.contracts.eligibilityRegistry, abi: registryAbi }, 'setPolicy', [
  policyId, account.address, 1n, now - 60n, 18_000_000_000n, issuerReference,
]);

const routerAbi = [{
  type: 'function', name: 'setSource', stateMutability: 'nonpayable',
  inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [],
}];
const sourceAllowlistTx = await write({ address: manifest.contracts.router, abi: routerAbi }, 'setSource', [source.address, true]);

manifest.mockAssets = {
  seller: account.address,
  rwa: rwa.address,
  usdx: usdx.address,
  source: source.address,
};
manifest.configuration = {
  ...manifest.configuration,
  mockSellerPolicyId: policyId,
  mockSellerPolicyRole: 1,
  mockSellerPolicyIssuerReference: issuerReference,
};
manifest.deploymentTransactions = {
  ...manifest.deploymentTransactions,
  rwa: rwa.deployTx,
  usdx: usdx.deployTx,
  source: source.deployTx,
};
manifest.configurationTransactions = {
  ...manifest.configurationTransactions,
  mockSellerPolicy: policyTx,
  mockSourceAllowlist: sourceAllowlistTx,
};
writeFileSync(resolve(projectRoot, 'contracts/flare/deployments/coston2.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`seller=${account.address}`);
console.log(`rwa=${rwa.address}`);
console.log(`usdx=${usdx.address}`);
console.log(`source=${source.address}`);
console.log(`policyId=${policyId}`);
console.log(`issuerReference=${issuerReference}`);
console.log(`rwaDeployTx=${rwa.deployTx}`);
console.log(`usdxDeployTx=${usdx.deployTx}`);
console.log(`sourceDeployTx=${source.deployTx}`);
console.log(`policyTx=${policyTx}`);
console.log(`sourceAllowlist=${sourceAllowlistTx}`);
