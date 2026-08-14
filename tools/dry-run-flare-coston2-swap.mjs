import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { flareTestnet } from 'viem/chains';
import { buildUnsignedSwapRouteTransaction } from '../packages/flare-sdk/src/index.ts';

const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'contracts/flare/deployments/coston2.json'), 'utf8'));
const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const seller = manifest.mockAssets.seller;
const latest = await client.getBlock({ blockTag: 'latest' });
if (!latest.number || latest.number < 1n || !latest.hash) throw new Error('BLOCK_SNAPSHOT');
const decisionBlock = latest.number - 1n;
const decision = await client.getBlock({ blockNumber: decisionBlock });
if (!decision.hash) throw new Error('DECISION_BLOCK_HASH');
const commitment = keccak256(stringToHex(`coston2-mock-swap:${latest.number}`));

const transaction = buildUnsignedSwapRouteTransaction({
  router: manifest.contracts.router,
  chainId: 114,
  commitment,
  fccActionId: commitment,
  decisionBlock,
  decisionBlockHash: decision.hash,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3_600),
  seller,
  recipient: seller,
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

await client.call({ account: seller, to: transaction.to, data: transaction.data });
console.log(`decisionBlock=${decisionBlock}`);
console.log(`commitment=${commitment}`);
console.log('typedSwapEthCall=PASS');
console.log('stateChanged=false');
