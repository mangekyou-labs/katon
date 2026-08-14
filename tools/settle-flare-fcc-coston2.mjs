import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, getAddress, http, keccak256, maxUint256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

import { buildConfidentialMatchEnvelope } from '../packages/flare-core/src/fccMatch.ts';
import { assertLiveFccE2eEvidence } from '../packages/flare-core/src/fccE2e.ts';
import { expectedRecipientBuyTokenDelta } from '../packages/flare-core/src/fccSettle.ts';
import { parseFccActionResponse } from '../packages/flare-core/src/fccRelay.ts';
import { hashSwapRoute } from '../packages/flare-core/src/routeHash.ts';
import { buildDispatchConfidentialTransaction, buildSubmitFccResultTransaction } from '../packages/flare-sdk/src/fcc.ts';
import { buildUnsignedSwapRouteTransaction } from '../packages/flare-sdk/src/index.ts';
import { loadWorktreeEnv } from './load-worktree-env.mjs';
import { formatWakeResult, wakeFccProxies } from './wake-fcc-proxies.mjs';

const INSTRUCTION_FEE = 1_000_000n;
const DEFAULT_HOSTS = [
  'https://trustrfq-tee-a.onrender.com',
  'https://trustrfq-tee-b.onrender.com',
  'https://trustrfq-tee-c.onrender.com',
];

loadWorktreeEnv();

const root = resolve(import.meta.dirname, '..');
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const manifestPath = resolve(root, process.env.FLARE_DEPLOYMENT_MANIFEST ?? 'contracts/flare/deployments/coston2-fcc-router.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sender = getAddress(manifest.contracts.instructionSender);
const router = getAddress(manifest.contracts.router);
const hosts = (process.env.FCC_TEE_HOSTS ?? DEFAULT_HOSTS.join(','))
  .split(',')
  .map((value) => value.trim().replace(/\/info$/i, '').replace(/\/$/, ''))
  .filter(Boolean);
if (hosts.length !== 3) throw new Error('FCC_TEE_COUNT');

const envKey = process.env.PRIVATE_KEY ?? readFileSync(resolve(root, '.env'), 'utf8').match(/^PRIVATE_KEY=(.+)$/m)?.[1]?.trim();
if (!envKey) throw new Error('PRIVATE_KEY_REQUIRED');
const account = privateKeyToAccount(envKey.startsWith('0x') ? envKey : `0x${envKey}`);
const chain = { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } };
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

const senderAbi = [
  { type: 'function', name: 'fccExtensionId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'fccQuorumThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'quorum', stateMutability: 'view', inputs: [{ name: 'actionId', type: 'bytes32' }], outputs: [{ name: 'ready', type: 'bool' }, { name: 'selectedHash', type: 'bytes32' }] },
  { type: 'event', name: 'FccInstructionSubmitted', inputs: [
    { indexed: true, name: 'instructionId', type: 'bytes32' },
    { indexed: true, name: 'actionId', type: 'bytes32' },
    { indexed: false, name: 'teeCount', type: 'uint256' },
    { indexed: false, name: 'quorumThreshold', type: 'uint64' },
  ] },
];
const routerAbi = [
  { type: 'function', name: 'fccQuorumVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'feeRecipient', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'protocolFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'event', name: 'SwapRouteExecuted', inputs: [
    { indexed: true, name: 'commitment', type: 'bytes32' },
    { indexed: true, name: 'seller', type: 'address' },
    { indexed: true, name: 'recipient', type: 'address' },
    { indexed: false, name: 'sellToken', type: 'address' },
    { indexed: false, name: 'buyToken', type: 'address' },
    { indexed: false, name: 'inputAmount', type: 'uint256' },
    { indexed: false, name: 'grossOutput', type: 'uint256' },
    { indexed: false, name: 'netOutput', type: 'uint256' },
  ] },
];
const tokenAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
];

async function pollResult(host, instructionId, timeoutMs) {
  const url = `${host}/action/result/${instructionId}`;
  const started = Date.now();
  let lastStatus = 0;
  while (Date.now() - started <= timeoutMs) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      lastStatus = response.status;
      if (response.ok) {
        const body = await response.json();
        const status = body?.result?.status;
        if (status === 1) return { host, result: parseFccActionResponse(body) };
        if (status === 0) return { host, error: body?.result?.log ?? 'RESULT_STATUS' };
      }
    } catch {
      lastStatus = 0;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  return { host, error: `FCC_RESULT_TIMEOUT http=${lastStatus}` };
}

const [extensionId, quorumThreshold, verifier, feeRecipient, liveFeeBps] = await Promise.all([
  publicClient.readContract({ address: sender, abi: senderAbi, functionName: 'fccExtensionId' }),
  publicClient.readContract({ address: sender, abi: senderAbi, functionName: 'fccQuorumThreshold' }),
  publicClient.readContract({ address: router, abi: routerAbi, functionName: 'fccQuorumVerifier' }),
  publicClient.readContract({ address: router, abi: routerAbi, functionName: 'feeRecipient' }),
  publicClient.readContract({ address: router, abi: routerAbi, functionName: 'protocolFeeBps' }),
]);
const expectedExtensionId = BigInt(process.env.FLARE_FCC_EXTENSION_ID ?? manifest.configuration.fccExtensionId ?? 0);
if (expectedExtensionId < 65536n) throw new Error(`FCC_EXTENSION_ID:${expectedExtensionId}`);
if (extensionId !== expectedExtensionId || quorumThreshold !== 2n) {
  throw new Error(`FCC_SENDER_NOT_CONFIGURED:${extensionId}:${quorumThreshold}:expected=${expectedExtensionId}`);
}
if (getAddress(verifier) !== sender) throw new Error(`FCC_VERIFIER:${verifier}`);
if (liveFeeBps !== 50) throw new Error(`FEE_BPS:${liveFeeBps}`);

const sellAmount = 10n ** 18n;
const grossOutput = 1_000n * 10n ** 18n;
const netOutput = 995n * 10n ** 18n;
const rwa = getAddress(manifest.mockAssets.rwa);
const usdx = getAddress(manifest.mockAssets.usdx);
const source = getAddress(manifest.mockAssets.source);

const [sellerRwa, sourceUsdx, allowance] = await Promise.all([
  publicClient.readContract({ address: rwa, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] }),
  publicClient.readContract({ address: usdx, abi: tokenAbi, functionName: 'balanceOf', args: [source] }),
  publicClient.readContract({ address: rwa, abi: tokenAbi, functionName: 'allowance', args: [account.address, source] }),
]);
if (sellerRwa < sellAmount) throw new Error(`RWA_BALANCE:${sellerRwa}`);
if (sourceUsdx < grossOutput) {
  const refill = await walletClient.writeContract({ address: usdx, abi: tokenAbi, functionName: 'mint', args: [source, 10_000n * 10n ** 18n], account });
  const refillReceipt = await publicClient.waitForTransactionReceipt({ hash: refill });
  if (refillReceipt.status !== 'success') throw new Error(`USDX_REFILL_REVERTED:${refill}`);
  console.log(`usdxRefill=${refill}`);
}
if (allowance < sellAmount) {
  const approve = await walletClient.writeContract({ address: rwa, abi: tokenAbi, functionName: 'approve', args: [source, maxUint256], account });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approve });
  if (approveReceipt.status !== 'success') throw new Error(`RWA_APPROVE_REVERTED:${approve}`);
  console.log(`rwaApprove=${approve}`);
}

const latest = await publicClient.getBlock({ blockTag: 'latest' });
if (!latest.number || !latest.hash) throw new Error('BLOCK_SNAPSHOT');
const decisionBlock = latest.number - 1n;
const decision = await publicClient.getBlock({ blockNumber: decisionBlock });
if (!decision.hash) throw new Error('DECISION_BLOCK_HASH');
const actionId = keccak256(toHex(`fcc-settle:${router}:${latest.number}`));
const route = {
  router,
  chainId: 114,
  commitment: keccak256(toHex(`fcc-settle-commit:${router}:${latest.number}`)),
  fccActionId: actionId,
  decisionBlock,
  decisionBlockHash: decision.hash,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3_600),
  seller: account.address,
  recipient: account.address,
  sellToken: rwa,
  buyToken: usdx,
  sellAmount,
  minOutput: netOutput,
  protocolFeeBps: 50,
  eligibilityPolicyId: manifest.configuration.mockSellerPolicyId,
  eligibilityRevocationEpoch: 0n,
  eligibilityRole: BigInt(manifest.configuration.mockSellerPolicyRole),
  eligibilityIssuerReference: manifest.configuration.mockSellerPolicyIssuerReference,
  legs: [{ source, sellAmount, minOutput: grossOutput, sourceData: '0x' }],
};
const hashed = hashSwapRoute({ ...route, chainId: 114n });
const match = buildConfidentialMatchEnvelope({ ...route, chainId: 114n });
if (match.actionId !== actionId || match.expectedHash !== hashed) throw new Error('MATCH_HASH_BIND');

const wake = await wakeFccProxies(hosts.map((host) => `${host}/info`));
console.log(formatWakeResult(wake));

const expiry = Math.floor(Date.now() / 1_000) + 3_600;
const dispatch = buildDispatchConfidentialTransaction({
  from: account.address,
  instructionSender: sender,
  opType: 'MATCH',
  command: 'FINALIZE',
  actionId,
  envelope: match.envelope,
  expiry,
  value: INSTRUCTION_FEE,
});
await publicClient.call({ account: account.address, to: dispatch.to, data: dispatch.data, value: dispatch.value });
const dispatchHash = await walletClient.sendTransaction({
  account, to: dispatch.to, data: dispatch.data, value: dispatch.value,
});
const dispatchReceipt = await publicClient.waitForTransactionReceipt({ hash: dispatchHash });
if (dispatchReceipt.status !== 'success') throw new Error(`DISPATCH_REVERTED:${dispatchHash}`);
const submitted = dispatchReceipt.logs
  .map((log) => {
    try {
      return decodeEventLog({ abi: senderAbi, data: log.data, topics: log.topics });
    } catch {
      return null;
    }
  })
  .find((event) => event?.eventName === 'FccInstructionSubmitted');
if (!submitted) throw new Error(`FCC_INSTRUCTION_EVENT_MISSING:${dispatchHash}`);
const instructionId = submitted.args.instructionId;
console.log(`dispatch=${dispatchHash} instructionId=${instructionId} actionId=${actionId} expectedHash=${hashed}`);

const timeoutMs = Number(process.env.FCC_RESULT_TIMEOUT_MS ?? 300_000);
const collected = await Promise.all(hosts.map((host) => pollResult(host, instructionId, timeoutMs)));
const accepted = collected.filter((row) => row.result);
const failed = collected.filter((row) => row.error);
for (const row of failed) console.log(`tee-result=${new URL(row.host).host} error=${row.error}`);
for (const row of accepted) console.log(`tee-result=${new URL(row.host).host} hash=${row.result.data} tag=${row.result.submissionTag}`);
if (accepted.length < 2) {
  console.error(`fcc-settle=BLOCKED accepted=${accepted.length} need=2`);
  process.exit(2);
}

const submits = [];
for (const row of accepted) {
  const tx = buildSubmitFccResultTransaction({ from: account.address, instructionSender: sender, result: row.result });
  await publicClient.call({ account: account.address, to: tx.to, data: tx.data });
  const hash = await walletClient.sendTransaction({ account, to: tx.to, data: tx.data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`SUBMIT_REVERTED:${hash}`);
  submits.push(hash);
  console.log(`submitFccResult=${hash} signerHost=${new URL(row.host).host}`);
}

const [ready, selectedHash] = await publicClient.readContract({
  address: sender, abi: senderAbi, functionName: 'quorum', args: [actionId],
});
console.log(`quorum.ready=${ready} selectedHash=${selectedHash} expected=${hashed}`);
if (!ready || selectedHash.toLowerCase() !== hashed.toLowerCase()) {
  console.error('fcc-settle=BLOCKED QUORUM_MISMATCH');
  process.exit(2);
}

const beforeRwa = await publicClient.readContract({ address: rwa, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
const beforeUsdx = await publicClient.readContract({ address: usdx, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
const swap = buildUnsignedSwapRouteTransaction(route);
await publicClient.call({ account: account.address, to: swap.to, data: swap.data });
const swapHash = await walletClient.sendTransaction({ account, to: swap.to, data: swap.data });
const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
if (swapReceipt.status !== 'success') throw new Error(`SWAP_REVERTED:${swapHash}`);
console.log(`swap=${swapHash} blockNumber=${swapReceipt.blockNumber}`);
const executed = swapReceipt.logs
  .map((log) => {
    try {
      return decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
    } catch {
      return null;
    }
  })
  .find((event) => event?.eventName === 'SwapRouteExecuted');
if (!executed) throw new Error(`SWAP_EVENT_MISSING:${swapHash}`);
if (executed.args.grossOutput !== grossOutput || executed.args.netOutput !== netOutput) {
  throw new Error(`SWAP_AMOUNTS:${executed.args.grossOutput}:${executed.args.netOutput}`);
}
const expectedUsdx = expectedRecipientBuyTokenDelta({
  grossOutput,
  netOutput,
  recipient: account.address,
  feeRecipient,
});
const afterRwa = await publicClient.readContract({ address: rwa, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
const afterUsdx = await publicClient.readContract({ address: usdx, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
if (beforeRwa - afterRwa !== sellAmount) throw new Error(`RWA_BALANCE_DELTA:${beforeRwa - afterRwa}`);
if (afterUsdx - beforeUsdx !== expectedUsdx) throw new Error(`USDX_BALANCE_DELTA:${afterUsdx - beforeUsdx}:expected=${expectedUsdx}`);

manifest.configurationTransactions = {
  ...manifest.configurationTransactions,
  confidentialSwap: swapHash,
};
manifest.confidentialSwap = {
  txHash: swapHash,
  blockNumber: swapReceipt.blockNumber.toString(),
  dispatch: dispatchHash,
  instructionId,
  actionId,
  selectedHash,
  submits,
  rwaDelta: (beforeRwa - afterRwa).toString(),
  usdxDelta: (afterUsdx - beforeUsdx).toString(),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const evidencePath = resolve(root, process.env.FLARE_FCC_E2E_EVIDENCE ?? 'output/playwright/fcc-live-e2e.json');
mkdirSync(dirname(evidencePath), { recursive: true });
const evidence = assertLiveFccE2eEvidence({
  router,
  extensionId: 66283,
  instructionSender: sender,
  dispatchHash,
  actionId,
  routeHash: hashed,
  swapHash,
});
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

console.log(`swap=${swapHash} blockNumber=${swapReceipt.blockNumber}`);
console.log(`rwaDelta=${beforeRwa - afterRwa} usdxDelta=${afterUsdx - beforeUsdx}`);
console.log(`fcc-settle=PASS dispatch=${dispatchHash} swap=${swapHash}`);
console.log(`e2eEvidence=${evidencePath}`);
