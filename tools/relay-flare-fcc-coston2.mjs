import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, getAddress, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { flareTestnet } from 'viem/chains';

import { parseFccActionResponse } from '../packages/flare-core/src/fccRelay.ts';
import { buildDispatchConfidentialTransaction, buildSubmitFccResultTransaction } from '../packages/flare-sdk/src/fcc.ts';
import { loadWorktreeEnv } from './load-worktree-env.mjs';
import { formatWakeResult, wakeFccProxies } from './wake-fcc-proxies.mjs';

const GOLDEN_ROUTE_HASH = '0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975';
const INSTRUCTION_FEE = 1_000_000n;
const DEFAULT_HOSTS = [
  'https://trustrfq-tee-a.onrender.com',
  'https://trustrfq-tee-b.onrender.com',
  'https://trustrfq-tee-c.onrender.com',
];

loadWorktreeEnv();

const root = resolve(import.meta.dirname, '..');
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const manifest = JSON.parse(readFileSync(resolve(root, process.env.FLARE_DEPLOYMENT_MANIFEST ?? 'contracts/flare/deployments/coston2.json'), 'utf8'));
const sender = getAddress(manifest.contracts.instructionSender);
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

function goldenMessage() {
  const auction = {
    commitment: '0x0000000000000000000000000000000000000000000000000000000000000011',
    chainId: 114,
    router: '0x00000000000000000000000000000000000000aa',
    sellToken: '0x0000000000000000000000000000000000000010',
    buyToken: '0x0000000000000000000000000000000000000020',
    sellAmount: '100000000000000000000',
    minOutput: '95000000000000000000',
    decisionDeadline: 2000,
  };
  const bid = {
    commitment: '0x0000000000000000000000000000000000000000000000000000000000000099',
    bidder: '0x00000000000000000000000000000000000000b1',
    sellToken: '0x0000000000000000000000000000000000000010',
    buyToken: '0x0000000000000000000000000000000000000020',
    sellAmount: '100000000000000000000',
    quotedOutput: '95000000000000000000',
    sequence: '1',
    expiresAt: 2100,
  };
  const routePlan = {
    chainId: 114,
    router: '0x00000000000000000000000000000000000000aa',
    commitment: '0x0000000000000000000000000000000000000000000000000000000000000011',
    fccActionId: '0x0000000000000000000000000000000000000000000000000000000000000022',
    decisionBlock: '1234567',
    decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000033',
    deadline: '2000000000',
    seller: '0x00000000000000000000000000000000000000c1',
    recipient: '0x00000000000000000000000000000000000000c2',
    sellToken: '0x0000000000000000000000000000000000000010',
    buyToken: '0x0000000000000000000000000000000000000020',
    sellAmount: '100000000000000000000',
    minOutput: '95000000000000000000',
    protocolFeeBps: 50,
    eligibilityPolicyId: '0x0000000000000000000000000000000000000000000000000000000000000044',
    eligibilityRevocationEpoch: '0',
    eligibilityRole: '1',
    eligibilityIssuerReference: '0x0000000000000000000000000000000000000000000000000000000000000055',
    legs: [{
      source: '0x00000000000000000000000000000000000000b1',
      sellAmount: '100000000000000000000',
      minOutput: '95000000000000000000',
      sourceData: '0x010203',
    }],
  };
  return toHex(JSON.stringify({ auction, bids: [bid], now: 1000, routePlan }));
}

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

const [extensionId, quorumThreshold] = await Promise.all([
  publicClient.readContract({ address: sender, abi: senderAbi, functionName: 'fccExtensionId' }),
  publicClient.readContract({ address: sender, abi: senderAbi, functionName: 'fccQuorumThreshold' }),
]);
const expectedExtensionId = BigInt(process.env.FLARE_FCC_EXTENSION_ID ?? manifest.configuration.fccExtensionId ?? 0);
if (expectedExtensionId < 65536n) throw new Error(`FCC_EXTENSION_ID:${expectedExtensionId}`);
if (extensionId !== expectedExtensionId || quorumThreshold !== 2n) {
  throw new Error(`FCC_SENDER_NOT_CONFIGURED:${extensionId}:${quorumThreshold}:expected=${expectedExtensionId}`);
}

const wake = await wakeFccProxies(hosts.map((host) => `${host}/info`));
console.log(formatWakeResult(wake));

const actionId = keccak256(toHex(`submitFccResult:${Date.now()}`));
const expiry = Math.floor(Date.now() / 1_000) + 3_600;
const dispatch = buildDispatchConfidentialTransaction({
  from: account.address,
  instructionSender: sender,
  opType: 'MATCH',
  command: 'FINALIZE',
  actionId,
  envelope: goldenMessage(),
  expiry,
  value: INSTRUCTION_FEE,
});

await publicClient.call({ account: account.address, to: dispatch.to, data: dispatch.data, value: dispatch.value });
const dispatchHash = await walletClient.sendTransaction({
  account,
  to: dispatch.to,
  data: dispatch.data,
  value: dispatch.value,
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
console.log(`dispatch=${dispatchHash} instructionId=${instructionId} actionId=${actionId}`);

const timeoutMs = Number(process.env.FCC_RESULT_TIMEOUT_MS ?? 300_000);
const collected = await Promise.all(hosts.map((host) => pollResult(host, instructionId, timeoutMs)));
const accepted = collected.filter((row) => row.result);
const failed = collected.filter((row) => row.error);
for (const row of failed) console.log(`tee-result=${new URL(row.host).host} error=${row.error}`);
for (const row of accepted) console.log(`tee-result=${new URL(row.host).host} hash=${row.result.data} tag=${row.result.submissionTag}`);

if (accepted.length < 2) {
  console.error(`fcc-relay=BLOCKED accepted=${accepted.length} need=2`);
  process.exitCode = 2;
} else {
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
  console.log(`quorum.ready=${ready} selectedHash=${selectedHash} expected=${GOLDEN_ROUTE_HASH}`);
  if (!ready || selectedHash.toLowerCase() !== GOLDEN_ROUTE_HASH) {
    console.error('fcc-relay=BLOCKED QUORUM_MISMATCH');
    process.exitCode = 2;
  } else {
    console.log(`fcc-relay=PASS submits=${submits.length} dispatch=${dispatchHash}`);
  }
}
