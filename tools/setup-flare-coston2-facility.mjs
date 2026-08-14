import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

if (process.env.FLARE_FACILITY_C2_DEPLOY !== 'true') throw new Error('FACILITY_DEPLOY_EXPLICIT_ENABLE_REQUIRED');

const root = resolve(import.meta.dirname, '..');
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const manifestPath = resolve(root, 'contracts/flare/deployments/coston2.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const key = process.env.PRIVATE_KEY ?? readFileSync(resolve(root, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error('PRIVATE_KEY_REQUIRED');
if (manifest.chainId !== 114 || !manifest.mockAssets || !manifest.configuration?.mockSellerPolicyId) {
  throw new Error('COSTON2_DIRECT_MOCK_MANIFEST_REQUIRED');
}

const artifact = (source, contract) => JSON.parse(readFileSync(resolve(root, 'contracts/flare/out', source, `${contract}.json`), 'utf8'));
const facilityArtifact = artifact('LiquidityFacility.sol', 'LiquidityFacility');
const routerArtifact = artifact('RFQRouter.sol', 'RFQRouter');
const aggregatorArtifact = artifact('FacilityAggregator.sol', 'FacilityAggregator');
const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const account = privateKeyToAccount(key);
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
  return receipt;
}

async function deploy(data, args) {
  const hash = await walletClient.deployContract({ abi: data.abi, bytecode: data.bytecode.object ?? data.bytecode, args, account });
  const receipt = await wait(hash);
  if (!receipt.contractAddress) throw new Error('NO_CONTRACT_ADDRESS');
  return { address: getAddress(receipt.contractAddress), deployTx: hash };
}

async function write(address, abi, functionName, args) {
  const hash = await walletClient.writeContract({ address, abi, functionName, args, account });
  await wait(hash);
  return hash;
}

const erc20Abi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const facility = await deploy(facilityArtifact, [getAddress(manifest.mockAssets.usdx)]);
const setup = {};
setup.setRouter = await write(facility.address, facilityArtifact.abi, 'setRouter', [getAddress(manifest.contracts.router)]);
setup.setEligibilityRegistry = await write(facility.address, facilityArtifact.abi, 'setEligibilityRegistry', [getAddress(manifest.contracts.eligibilityRegistry)]);
setup.setRwaPolicy = await write(facility.address, facilityArtifact.abi, 'setRwaPolicy', [getAddress(manifest.mockAssets.rwa), 10n ** 18n, 0n, 0n, true]);
setup.approveFacility = await write(manifest.mockAssets.usdx, erc20Abi, 'approve', [facility.address, 500n * 10n ** 18n]);
setup.approveRwa = await write(manifest.mockAssets.rwa, erc20Abi, 'approve', [facility.address, 10n ** 18n]);
setup.deposit = await write(facility.address, facilityArtifact.abi, 'deposit', [500n * 10n ** 18n, account.address]);
setup.registerFacility = await write(manifest.contracts.facilityAggregator, aggregatorArtifact.abi, 'registerFacility', [facility.address]);
setup.allowFacilitySource = await write(manifest.contracts.router, routerArtifact.abi, 'setSource', [facility.address, true]);

const latest = await publicClient.getBlock({ blockTag: 'latest' });
if (!latest.number || !latest.hash || latest.number === 0n) throw new Error('BLOCK_SNAPSHOT');
const decisionBlock = latest.number - 1n;
const decision = await publicClient.getBlock({ blockNumber: decisionBlock });
if (!decision.hash) throw new Error('DECISION_BLOCK_HASH');
const amount = 10n ** 18n;
const minimum = 995000000000000000n;
const commitment = keccak256(stringToHex(`coston2-facility-swap:${latest.number}`));
const sourceData = encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
  [manifest.configuration.mockSellerPolicyId, 0n, BigInt(manifest.configuration.mockSellerPolicyRole), manifest.configuration.mockSellerPolicyIssuerReference],
);
const route = {
  chainId: 114n,
  router: getAddress(manifest.contracts.router),
  commitment,
  fccActionId: commitment,
  decisionBlock,
  decisionBlockHash: decision.hash,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  seller: account.address,
  recipient: account.address,
  sellToken: getAddress(manifest.mockAssets.rwa),
  buyToken: getAddress(manifest.mockAssets.usdx),
  sellAmount: amount,
  minOutput: minimum,
  protocolFeeBps: 50,
  eligibilityPolicyId: manifest.configuration.mockSellerPolicyId,
  eligibilityRevocationEpoch: 0n,
  eligibilityRole: BigInt(manifest.configuration.mockSellerPolicyRole),
  eligibilityIssuerReference: manifest.configuration.mockSellerPolicyIssuerReference,
  legs: [{ source: facility.address, sellAmount: amount, minOutput: amount, sourceData }],
};
const beforeRwa = await publicClient.readContract({ address: manifest.mockAssets.rwa, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
const beforeUsdx = await publicClient.readContract({ address: manifest.mockAssets.usdx, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
const routeTx = await walletClient.writeContract({ address: manifest.contracts.router, abi: routerArtifact.abi, functionName: 'executeSwapRoute', args: [route], account });
const routeReceipt = await wait(routeTx);
const afterRwa = await publicClient.readContract({ address: manifest.mockAssets.rwa, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
const afterUsdx = await publicClient.readContract({ address: manifest.mockAssets.usdx, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
if (beforeRwa - afterRwa !== amount) throw new Error('FACILITY_RWA_BALANCE_DELTA');
// The bootstrap account is also the direct deployment's fee recipient, so its
// balance receives gross output (the 5 bps fee is not a separate account here).
if (afterUsdx - beforeUsdx !== amount) throw new Error('FACILITY_USDX_GROSS_BALANCE_DELTA');

manifest.liquidityFacility = {
  address: facility.address,
  asset: manifest.mockAssets.usdx,
  rwa: manifest.mockAssets.rwa,
  mode: 'coston2-direct-mock-only',
  verifiedVenue: false,
  deployTx: facility.deployTx,
  setupTransactions: setup,
  typedFacilitySwap: { txHash: routeTx, blockNumber: routeReceipt.blockNumber.toString(), commitment, rwaDelta: amount.toString(), usdxGrossDelta: amount.toString(), minimumNetOutput: minimum.toString() },
};
manifest.deploymentTransactions = { ...manifest.deploymentTransactions, LiquidityFacility: facility.deployTx };
manifest.configurationTransactions = { ...manifest.configurationTransactions, ...Object.fromEntries(Object.entries(setup).map(([name, hash]) => [`facility:${name}`, hash])), facilitySwap: routeTx };
manifest.bytecodeHashes = { ...manifest.bytecodeHashes, liquidityFacility: keccak256(facilityArtifact.deployedBytecode.object) };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`liquidityFacility=${facility.address}`);
console.log(`facilityDeployTx=${facility.deployTx}`);
console.log(`facilitySwapTx=${routeTx}`);
console.log(`facilitySwapBlock=${routeReceipt.blockNumber}`);
console.log(`rwaDelta=${beforeRwa - afterRwa}`);
console.log(`usdxGrossDelta=${afterUsdx - beforeUsdx}`);
console.log(`minimumNetOutput=${minimum}`);
console.log('coston2-facility-mock=PASS');
