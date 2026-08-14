import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';
import { buildUnsignedSwapRouteTransaction } from '../packages/flare-sdk/src/index.ts';

const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'contracts/flare/deployments/coston2.json'), 'utf8'));
const envKey = process.env.PRIVATE_KEY ?? readFileSync(resolve(root, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
if (!envKey) throw new Error('PRIVATE_KEY_REQUIRED');
const account = privateKeyToAccount(envKey);
const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const tokenAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];

const latest = await publicClient.getBlock({ blockTag: 'latest' });
if (!latest.number || !latest.hash) throw new Error('BLOCK_SNAPSHOT');
const decisionBlock = latest.number - 1n;
const decision = await publicClient.getBlock({ blockNumber: decisionBlock });
if (!decision.hash) throw new Error('DECISION_BLOCK_HASH');
const commitment = keccak256(stringToHex(`coston2-mock-swap:execute:${latest.number}`));
const transaction = buildUnsignedSwapRouteTransaction({
  router: manifest.contracts.router,
  chainId: 114,
  commitment,
  fccActionId: commitment,
  decisionBlock,
  decisionBlockHash: decision.hash,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3_600),
  seller: account.address,
  recipient: account.address,
  sellToken: manifest.mockAssets.rwa,
  buyToken: manifest.mockAssets.usdx,
  sellAmount: 10n ** 18n,
  minOutput: 995n * 10n ** 18n,
  protocolFeeBps: 50,
  eligibilityPolicyId: manifest.configuration.mockSellerPolicyId,
  eligibilityRevocationEpoch: 0n,
  eligibilityRole: BigInt(manifest.configuration.mockSellerPolicyRole),
  eligibilityIssuerReference: manifest.configuration.mockSellerPolicyIssuerReference,
  legs: [{
    source: manifest.mockAssets.source,
    sellAmount: 10n ** 18n,
    minOutput: 1_000n * 10n ** 18n,
    sourceData: '0x',
  }],
});

const beforeRwa = await publicClient.readContract({ address: manifest.mockAssets.rwa, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
const beforeUsdx = await publicClient.readContract({ address: manifest.mockAssets.usdx, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
await publicClient.call({ account: account.address, to: transaction.to, data: transaction.data });
const hash = await walletClient.sendTransaction({ account, to: transaction.to, data: transaction.data });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
const afterRwa = await publicClient.readContract({ address: manifest.mockAssets.rwa, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
const afterUsdx = await publicClient.readContract({ address: manifest.mockAssets.usdx, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
if (beforeRwa - afterRwa !== 10n ** 18n) throw new Error('RWA_BALANCE_DELTA');
if (afterUsdx - beforeUsdx !== 1_000n * 10n ** 18n) throw new Error('USDX_BALANCE_DELTA');
manifest.configurationTransactions = {
  ...manifest.configurationTransactions,
  mockSwap: hash,
};
manifest.mockSwap = {
  txHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  commitment,
  rwaDelta: (beforeRwa - afterRwa).toString(),
  usdxDelta: (afterUsdx - beforeUsdx).toString(),
};
writeFileSync(resolve(root, 'contracts/flare/deployments/coston2.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`txHash=${hash}`);
console.log(`blockNumber=${receipt.blockNumber}`);
console.log(`rwaDelta=${beforeRwa - afterRwa}`);
console.log(`usdxDelta=${afterUsdx - beforeUsdx}`);
console.log(`commitment=${commitment}`);
console.log('Coston2 mock swap: PASS');
