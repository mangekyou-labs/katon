import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

const root = resolve(import.meta.dirname, '..');
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const manifestPath = resolve(root, 'contracts/flare/deployments/coston2.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const key = process.env.PRIVATE_KEY ?? readFileSync(resolve(root, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error('PRIVATE_KEY_REQUIRED');

const artifact = JSON.parse(readFileSync(resolve(root, 'contracts/flare/out/ProofGuards.sol/NavProofRegistry.json'), 'utf8'));
const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const account = privateKeyToAccount(key);
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const registry = process.env.FLARE_CONTRACT_REGISTRY_ADDRESS ?? '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
const registryAbi = [{ type: 'function', name: 'getContractAddressByName', stateMutability: 'view', inputs: [{ type: 'string' }], outputs: [{ type: 'address' }] }];
const navAbi = artifact.abi;

const verification = process.env.FLARE_FDC_VERIFICATION_ADDRESS
  ?? await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'getContractAddressByName', args: ['FdcVerification'] });
if (!/^0x[0-9a-fA-F]{40}$/.test(verification) || /^0x0{40}$/.test(verification)) throw new Error('FDC_VERIFICATION_ADDRESS');

const deployHash = await walletClient.deployContract({ abi: navAbi, bytecode: artifact.bytecode.object ?? artifact.bytecode, account });
const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
if (!receipt.contractAddress || receipt.status !== 'success') throw new Error(`NAV_DEPLOY_FAILED:${deployHash}`);
const navProofRegistry = receipt.contractAddress;
const configureHash = await walletClient.writeContract({
  address: navProofRegistry,
  abi: navAbi,
  functionName: 'configureFdcVerification',
  args: [verification],
  account,
});
const configureReceipt = await publicClient.waitForTransactionReceipt({ hash: configureHash });
if (configureReceipt.status !== 'success') throw new Error(`NAV_CONFIG_FAILED:${configureHash}`);
let policyHash;
let policyTx;
const policyAsset = process.env.FLARE_NAV_POLICY_ASSET?.trim();
const policySourceId = process.env.FLARE_NAV_POLICY_SOURCE_ID?.trim();
const policyBody = process.env.FLARE_NAV_POLICY_BODY_JSON?.trim();
if (policyAsset || policySourceId || policyBody) {
  if (!policyAsset || !policySourceId || !policyBody) throw new Error('NAV_POLICY_REQUIRES_ASSET_SOURCE_BODY');
  if (!/^0x[0-9a-fA-F]{40}$/.test(policyAsset) || !/^0x[0-9a-fA-F]{64}$/.test(policySourceId)) throw new Error('NAV_POLICY_ADDRESS_OR_SOURCE');
  const requestBody = JSON.parse(policyBody);
  const fields = ['url', 'httpMethod', 'headers', 'queryParams', 'body', 'postProcessJq', 'abiSignature'];
  if (fields.some((field) => typeof requestBody[field] !== 'string')) throw new Error('NAV_POLICY_BODY_SCHEMA');
  policyHash = keccak256(encodeAbiParameters([{ type: 'tuple', components: fields.map((name) => ({ name, type: 'string' })) }], [requestBody]));
  policyTx = await walletClient.writeContract({
    address: navProofRegistry,
    abi: navAbi,
    functionName: 'configureWeb2JsonPolicy',
    args: [policyAsset, policySourceId, policyHash],
    account,
  });
  const policyReceipt = await publicClient.waitForTransactionReceipt({ hash: policyTx });
  if (policyReceipt.status !== 'success') throw new Error(`NAV_POLICY_FAILED:${policyTx}`);
}
const bytecode = await publicClient.getBytecode({ address: navProofRegistry });
if (!bytecode || bytecode === '0x') throw new Error('NAV_BYTECODE_MISSING');

manifest.contracts.navProofRegistry = navProofRegistry;
manifest.deploymentTransactions.NavProofRegistryFdc = deployHash;
manifest.configuration.fdcVerification = verification;
manifest.configurationTransactions.configureFdcVerification = configureHash;
if (policyHash && policyTx) {
  manifest.configuration.navWeb2JsonPolicy = { asset: policyAsset, sourceId: policySourceId, requestBodyHash: policyHash };
  manifest.configurationTransactions.configureNavWeb2JsonPolicy = policyTx;
}
manifest.bytecodeHashes.navProofRegistry = keccak256(bytecode);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`navProofRegistry=${navProofRegistry}`);
console.log(`fdcVerification=${verification}`);
console.log(`deployTx=${deployHash}`);
console.log(`configureTx=${configureHash}`);
if (policyHash && policyTx) console.log(`policyTx=${policyTx}`);
console.log('nav-fdc-coston2=PASS');
