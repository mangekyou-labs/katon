import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  padHex,
  stringToHex,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

import {
  FdcVerifierClient,
  buildUnsignedNavProofTransaction,
  calculateFdcVotingRoundFromBlock,
  decodeFdcWeb2JsonProof,
  hashFdcWeb2JsonRequestBody,
  prepareFdcRequestTransaction,
  readFdcRoundFinality,
  waitForFdcRoundFinality,
} from '../packages/flare-sdk/src/data.ts';

const root = resolve(import.meta.dirname, '..');
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const registryAddress = process.env.FLARE_CONTRACT_REGISTRY_ADDRESS ?? '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
const manifestPath = process.env.FLARE_DEPLOYMENT_MANIFEST
  ? resolve(root, process.env.FLARE_DEPLOYMENT_MANIFEST)
  : existsSync(resolve(root, 'contracts/flare/deployments/coston2-proxy-candidate.json'))
    ? resolve(root, 'contracts/flare/deployments/coston2-proxy-candidate.json')
    : resolve(root, 'contracts/flare/deployments/coston2.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const privateKey = process.env.PRIVATE_KEY ?? readFileSync(resolve(root, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
const verifierUrl = process.env.FLARE_FDC_VERIFIER_URL?.trim();
const apiKey = process.env.FLARE_FDC_API_KEY?.trim();
const daUrl = (process.env.FLARE_FDC_DA_URL ?? 'https://ctn2-data-availability.flare.network').trim();
const asset = process.env.FLARE_NAV_POLICY_ASSET?.trim();
const sourceId = process.env.FLARE_NAV_POLICY_SOURCE_ID?.trim();
const requestBodyJson = process.env.FLARE_NAV_POLICY_BODY_JSON?.trim();
if (!privateKey) throw new Error('PRIVATE_KEY_REQUIRED');
if (!verifierUrl || !apiKey) throw new Error('FDC_CREDENTIALS_REQUIRED');
if (!/^0x[0-9a-fA-F]{40}$/.test(asset ?? '') || !sourceId || !requestBodyJson) throw new Error('NAV_POLICY_CONFIGURATION_REQUIRED');

const requestBody = JSON.parse(requestBodyJson);
const requiredBodyFields = ['url', 'httpMethod', 'headers', 'queryParams', 'body', 'postProcessJq', 'abiSignature'];
if (requiredBodyFields.some((field) => typeof requestBody[field] !== 'string')) throw new Error('NAV_POLICY_BODY_SCHEMA');
const sourceIdHex = /^0x[0-9a-fA-F]{64}$/.test(sourceId) ? sourceId : padHex(stringToHex(sourceId), { dir: 'right', size: 32 });
const requestBodyHash = hashFdcWeb2JsonRequestBody(requestBody);
const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const transport = http(rpcUrl);
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const navProofRegistry = getAddress(manifest.contracts.navProofRegistry);
const navAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'web2JsonPolicies', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ name: 'sourceId', type: 'bytes32' }, { name: 'requestBodyHash', type: 'bytes32' }, { name: 'configured', type: 'bool' }] },
  { type: 'function', name: 'configureWeb2JsonPolicy', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], outputs: [] },
];
const timelockAbi = [{
  type: 'function', name: 'schedule', stateMutability: 'nonpayable',
  inputs: [
    { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'predecessor', type: 'bytes32' }, { name: 'salt', type: 'bytes32' },
  ], outputs: [{ type: 'bytes32' }],
}];

const owner = await publicClient.readContract({ address: navProofRegistry, abi: navAbi, functionName: 'owner' });
const ownerIsCaller = getAddress(owner) === account.address;
const timelock = manifest.configuration.timelock ? getAddress(manifest.configuration.timelock) : undefined;
if (!ownerIsCaller && (!timelock || getAddress(owner) !== timelock)) throw new Error(`NAV_OWNER_MISMATCH:${owner}`);
const currentPolicy = await publicClient.readContract({ address: navProofRegistry, abi: navAbi, functionName: 'web2JsonPolicies', args: [getAddress(asset)] });
if (!currentPolicy[2]) {
  const configureData = encodeFunctionData({ abi: navAbi, functionName: 'configureWeb2JsonPolicy', args: [getAddress(asset), sourceIdHex, requestBodyHash] });
  const salt = keccak256(stringToHex(`configure-nav-policy:${asset}:${sourceIdHex}:${requestBodyHash}`));
  const policyTx = ownerIsCaller
    ? await walletClient.writeContract({ address: navProofRegistry, abi: navAbi, functionName: 'configureWeb2JsonPolicy', args: [getAddress(asset), sourceIdHex, requestBodyHash], account })
    : await walletClient.writeContract({ address: timelock, abi: timelockAbi, functionName: 'schedule', args: [navProofRegistry, 0n, configureData, zeroHash, salt], account });
  await publicClient.waitForTransactionReceipt({ hash: policyTx });
  if (!ownerIsCaller) {
    manifest.configuration.pendingNavWeb2JsonPolicy = { asset: getAddress(asset), sourceId: sourceIdHex, requestBodyHash, operationSalt: salt, status: 'scheduled-not-executed' };
    manifest.configurationTransactions = { ...manifest.configurationTransactions, configureNavWeb2JsonPolicy: policyTx };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    throw new Error(`NAV_POLICY_SCHEDULED:${policyTx}`);
  }
} else if (currentPolicy[0].toLowerCase() !== sourceIdHex.toLowerCase() || currentPolicy[1].toLowerCase() !== requestBodyHash.toLowerCase()) {
  throw new Error('NAV_POLICY_MISMATCH');
}

const verifier = new FdcVerifierClient({ baseUrl: verifierUrl, apiKey });
const prepared = await verifier.prepareRequest('Web2Json', { sourceId, requestBody });
const requestTx = await prepareFdcRequestTransaction(publicClient, { network: 'coston2', registryAddress, requestBytes: prepared.abiEncodedRequest });
const requestHash = await walletClient.sendTransaction({ account, to: requestTx.to, data: requestTx.data, value: requestTx.value });
const requestReceipt = await publicClient.waitForTransactionReceipt({ hash: requestHash });
if (requestReceipt.status !== 'success') throw new Error(`FDC_REQUEST_REVERTED:${requestHash}`);
const votingRoundId = await calculateFdcVotingRoundFromBlock(publicClient, registryAddress, requestReceipt.blockNumber);
const finality = await waitForFdcRoundFinality(
  (round) => readFdcRoundFinality(publicClient, { network: 'coston2', registryAddress, votingRoundId: round }),
  votingRoundId,
  { intervalMs: Number(process.env.FLARE_FDC_POLL_MS ?? 10_000), maxAttempts: Number(process.env.FLARE_FDC_MAX_ATTEMPTS ?? 30) },
);

let proofResponse;
for (let attempt = 0; attempt < Number(process.env.FLARE_FDC_PROOF_ATTEMPTS ?? 20); attempt += 1) {
  try {
    proofResponse = await verifier.getProof(daUrl, votingRoundId, prepared.abiEncodedRequest);
    if (proofResponse.responseHex !== '0x') break;
  } catch (error) {
    if (attempt + 1 >= Number(process.env.FLARE_FDC_PROOF_ATTEMPTS ?? 20)) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FLARE_FDC_PROOF_POLL_MS ?? 5_000)));
}
if (!proofResponse?.responseHex || proofResponse.responseHex === '0x') throw new Error('FDC_PROOF_UNAVAILABLE');
const proof = decodeFdcWeb2JsonProof(proofResponse.proofs, proofResponse.responseHex);
const navTx = buildUnsignedNavProofTransaction(114, navProofRegistry, getAddress(asset), proof);
const navHash = await walletClient.sendTransaction({ account, to: navTx.to, data: navTx.data, value: navTx.value });
const navReceipt = await publicClient.waitForTransactionReceipt({ hash: navHash });
if (navReceipt.status !== 'success') throw new Error(`NAV_PROOF_REVERTED:${navHash}`);

manifest.fdcNavProof = { requestTx: requestHash, votingRoundId, protocolId: finality.protocolId, navTx: navHash, responseDigest: requestBodyHash };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`fdc-nav-coston2=PASS requestTx=${requestHash} votingRound=${votingRoundId} navTx=${navHash}`);
