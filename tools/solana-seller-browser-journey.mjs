#!/usr/bin/env node
/** Seller-driven Wallet Standard settlement against offline Surfpool. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const localRpcUrl = 'http://127.0.0.1:8899';
const fixturePath = join(repo, '.local/solana-seller-localnet.json');
const allocatedPorts = new Set();
const apiPort = await freePort();
const webPort = await freePort();
const harness = spawnSync(process.execPath, ['tools/solana-seller-localnet.mjs'], {
  cwd: repo,
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, NO_DNA: '1', SOLANA_RPC_URL: localRpcUrl, SOLANA_API_PORT: String(apiPort) },
});
if (harness.status !== 0) throw new Error(`offline Surfpool fixture failed (${harness.status}):\n${harness.stdout}\n${harness.stderr}`);
process.stdout.write(harness.stdout);

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
assert.equal(fixture.rpcUrl, localRpcUrl, 'the browser walkthrough must use loopback RPC only');
assert.equal(fixture.chain, 'solana:localnet');
assert.equal(fixture.programLoaded, true);
assert.equal(fixture.testAssets, true);
assert.match(fixture.testAssetLabel, /TEST ASSETS ONLY/);
const seller = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(fixture.sellerKeypairPath, 'utf8'))));
assert.equal(seller.publicKey.toBase58(), fixture.sellerPubkey);
const sellerPkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seller.secretKey.subarray(0, 32)]).toString('base64');

const apiBase = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const api = spawn(process.execPath, ['--import', 'tsx', 'apps/solana-api/src/server.ts'], {
  cwd: repo,
  env: {
    ...process.env,
    NO_DNA: '1',
    SOLANA_API_PORT: String(apiPort),
    SOLANA_API_ORIGIN: webOrigin,
    SOLANA_CLUSTER: 'localnet',
    SOLANA_SELLER_SESSION_SECRET: 'browser-journey-seller-session-secret-with-entropy',
    SOLANA_ROLE_IDENTITIES: '',
    KATON_LOCALNET: '1',
    SOLANA_RPC_URL: localRpcUrl,
    KATON_LOCALNET_CONFIG: fixturePath,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let apiStderr = '';
api.stderr.setEncoding('utf8').on('data', (chunk) => { apiStderr += chunk; });

const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/solana-web/vite.config.ts', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  cwd: repo,
  env: { ...process.env, SOLANA_API_PROXY: apiBase },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let webStderr = '';
web.stderr.setEncoding('utf8').on('data', (chunk) => { webStderr += chunk; });

const rpc = new Connection(localRpcUrl, 'confirmed');
const tokenProgram = fixture.stockTokenProgram;
const stableTokenProgram = fixture.stableTokenProgram;
const usdc = fixture.stableMints[0];
const accounts = [
  { name: 'seller stock', address: fixture.sellerStockAccount, mint: fixture.stockMint, program: tokenProgram, owner: fixture.sellerPubkey },
  { name: 'maker stock', address: fixture.makerStockAccount, mint: fixture.stockMint, program: tokenProgram, owner: fixture.makerPublicKey },
  { name: 'maker USDC', address: fixture.makerStableAccounts[usdc], mint: usdc, program: stableTokenProgram, owner: fixture.makerPublicKey },
  { name: 'seller USDC', address: fixture.sellerStableAccounts[usdc], mint: usdc, program: stableTokenProgram, owner: fixture.sellerPubkey },
  { name: 'fee USDC', address: fixture.feeStableAccounts[usdc], mint: usdc, program: stableTokenProgram, owner: fixture.feeRecipient },
];

async function readTokenState(entry) {
  const [info, balance] = await Promise.all([
    rpc.getAccountInfo(new PublicKey(entry.address), 'confirmed'),
    rpc.getTokenAccountBalance(new PublicKey(entry.address), 'confirmed'),
  ]);
  assert.ok(info, `RPC account missing: ${entry.name}`);
  assert.equal(info.owner.toBase58(), entry.program, `${entry.name} Token program`);
  assert.equal(info.data.length, 165, `${entry.name} classic token account layout`);
  assert.equal(new PublicKey(info.data.subarray(0, 32)).toBase58(), entry.mint, `${entry.name} mint identity`);
  assert.equal(new PublicKey(info.data.subarray(32, 64)).toBase58(), entry.owner, `${entry.name} owner identity`);
  assert.equal(balance.value.decimals, 6, `${entry.name} decimals`);
  return balance.value.amount;
}

function atomicToDecimal(value, decimals = 6) {
  const amount = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

const before = Object.fromEntries(await Promise.all(accounts.map(async (entry) => [entry.name, await readTokenState(entry)])));
assert.equal(before['seller stock'], '2500000');
assert.equal(before['maker stock'], '0');
assert.equal(before['maker USDC'], '1000000000000');
assert.equal(before['seller USDC'], '0');
assert.equal(before['fee USDC'], '0');
for (const [mint, program] of [[fixture.stockMint, tokenProgram], [usdc, stableTokenProgram]]) {
  const info = await rpc.getAccountInfo(new PublicKey(mint), 'confirmed');
  assert.ok(info, `RPC mint missing: ${mint}`);
  assert.equal(info.owner.toBase58(), program, `mint ${mint} Token program`);
  assert.equal(info.data.length, 82, `mint ${mint} classic SPL layout`);
  assert.equal(info.data[44], 6, `mint ${mint} decimals`);
  assert.equal(info.data[45], 1, `mint ${mint} initialized state`);
}

async function waitReady(url, child, label, getStderr) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode}: ${getStderr()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`${label} did not become ready: ${getStderr()}`);
}

async function rpcCall(method, params) {
  const response = await fetch(localRpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`local RPC ${method}: ${body.error?.message ?? response.status}`);
  return body.result;
}

let browser;
const httpEvidence = [];
const rpcEvidence = [];
let issuedWinner;
let reviewedSprint;
let sellerSignedTransactionBase64;
let approvalMessageHash;
let executionAttempt;
try {
  await waitReady(`${apiBase}/v1/reference-policy`, api, 'Seller API', () => apiStderr);
  await waitReady(webOrigin, web, 'Seller Desk Vite app', () => webStderr);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  const evidenceByRequest = new WeakMap();
  const consoleErrors = [];
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) => browserErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/v1/')) return;
    const headers = request.headers();
    const entry = {
      method: request.method(), path: url.pathname, origin: headers.origin,
      originClaim: headers['x-katon-origin'],
      hasSellerProof: headers.authorization?.startsWith('Bearer seller-v1.') ?? false,
      cluster: headers['x-katon-cluster'], status: undefined,
    };
    evidenceByRequest.set(request, entry);
    httpEvidence.push(entry);
    if (request.method() === 'POST' && url.pathname.endsWith('/authorize')) {
      const body = request.postDataJSON();
      sellerSignedTransactionBase64 = body.signedTransactionBase64;
      approvalMessageHash = body.reviewHash;
    }
  });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/v1/')) return;
    const entry = evidenceByRequest.get(response.request());
    if (entry) entry.status = response.status();
    if (!response.ok()) return;
    if (response.request().method() === 'GET' && /^\/v1\/quote-sprints\/[^/]+$/.test(url.pathname)) {
      const payload = await response.json();
      if (payload.winner?.transactionBase64) issuedWinner = payload.winner;
    }
    if (response.request().method() === 'POST' && url.pathname.endsWith('/review')) reviewedSprint = await response.json();
    if (response.request().method() === 'POST' && url.pathname === '/v1/execution-attempts') executionAttempt = await response.json();
  });

  await page.addInitScript(({ walletAddress, publicKey, privateKeyPkcs8 }) => {
    const chain = 'solana:localnet';
    const account = {
      address: walletAddress, publicKey: Uint8Array.from(publicKey), chains: [chain],
      features: ['solana:signMessage', 'solana:signTransaction'], label: 'Offline Seller Test Wallet',
    };
    const listeners = new Set();
    const importSigningKey = () => crypto.subtle.importKey(
      'pkcs8', Uint8Array.from(atob(privateKeyPkcs8), (character) => character.charCodeAt(0)),
      { name: 'Ed25519' }, false, ['sign'],
    );
    const shortVec = (bytes, start = 0) => {
      let value = 0; let shift = 0; let offset = start;
      while (offset < bytes.length && shift < 21) {
        const byte = bytes[offset++]; value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { value, next: offset };
        shift += 7;
      }
      throw new Error('malformed transaction signature vector');
    };
    const wallet = {
      version: '1.0.0', name: 'Offline Seller Test Wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      chains: [chain], accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => {
          wallet.accounts = [account];
          for (const listener of listeners) listener({ accounts: wallet.accounts });
          return { accounts: wallet.accounts };
        } },
        'standard:events': { version: '1.0.0', on: (_event, listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
        'solana:signMessage': { version: '1.1.0', signMessage: async (...inputs) => {
          const key = await importSigningKey();
          return Promise.all(inputs.map(async ({ message }) => ({
            signedMessage: message,
            signature: new Uint8Array(await crypto.subtle.sign('Ed25519', key, message)),
            signatureType: 'ed25519',
          })));
        } },
        'solana:signTransaction': { version: '1.0.0', signTransaction: async (...inputs) => {
          const key = await importSigningKey();
          return Promise.all(inputs.map(async ({ transaction }) => {
            const signedTransaction = Uint8Array.from(transaction);
            const count = shortVec(signedTransaction);
            if (count.value !== 2 || count.next + 128 > signedTransaction.length) throw new Error('unexpected issued transaction signer set');
            const messageOffset = count.next + count.value * 64;
            const message = signedTransaction.slice(messageOffset);
            const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, message));
            signedTransaction.set(signature, count.next);
            return { signedTransaction };
          }));
        } },
      },
    };
    window.addEventListener('wallet-standard:app-ready', (event) => event.detail.register(wallet));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(wallet) }));
  }, { walletAddress: seller.publicKey.toBase58(), publicKey: [...seller.publicKey.toBytes()], privateKeyPkcs8: sellerPkcs8 });

  await page.goto(`${webOrigin}/trade`);
  await page.getByRole('heading', { name: /sell tokenized stock/i }).waitFor();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Prove Seller wallet' }).click();
  await page.getByText('Seller session active', { exact: true }).waitFor();
  await page.locator('#asset option').filter({ hasText: 'AAPLx TEST' }).waitFor({ state: 'attached' });
  await page.getByText(/RPC balance 2\.5\b/).waitFor();
  await page.locator('#amount').fill('0.1');
  await page.getByRole('button', { name: /Find best executable price/ }).click();
  await page.locator('.ready-panel').waitFor();
  await page.getByRole('button', { name: 'Review settlement' }).click();
  const review = page.getByRole('dialog', { name: 'Review stock settlement' });
  await review.waitFor();
  const reviewText = await review.innerText();
  assert.match(reviewText, /0\.1 stock/);
  assert.ok(issuedWinner?.netOutputAtomic, 'review follows an RPC-simulated issued quote');
  assert.ok(reviewText.includes(`${atomicToDecimal(issuedWinner.netOutputAtomic)} USDC`), 'review shows the exact net minimum from the issued settlement');
  assert.match(reviewText, /solana:localnet/);
  assert.match(reviewText, /settle_private_quote/);
  assert.match(reviewText, /LOCAL TEST ASSETS|Local test assets/);
  assert.match(reviewText, new RegExp(fixture.sellerPubkey));
  await review.getByRole('button', { name: 'Approve and sign settlement' }).click();
  await page.getByRole('heading', { name: 'Stock settlement complete' }).waitFor({ timeout: 60_000 });

  assert.ok(issuedWinner?.transactionBase64, 'browser flow fetched the actual Private Maker transaction');
  assert.equal(issuedWinner.sourceKind, 'private-maker');
  assert.equal(issuedWinner.inputMint, fixture.stockMint);
  assert.equal(issuedWinner.outputMint, usdc);
  assert.equal(issuedWinner.inputAmountAtomic, '100000');
  assert.ok(reviewedSprint?.winner?.simulation?.ok, 'review API reported a successful live RPC simulation');
  assert.equal(approvalMessageHash, issuedWinner.transactionHash, 'approval was bound to the issued message hash');
  assert.ok(sellerSignedTransactionBase64, 'Wallet Standard signTransaction payload was authorized');
  assert.equal(executionAttempt?.status, 'final');
  assert.ok(executionAttempt.receipt, 'confirmed execution returned a settlement receipt');
  assert.equal(httpEvidence.filter((entry) => entry.method === 'POST' && entry.path === '/v1/execution-attempts').length, 1, 'one execution attempt was submitted');

  const receipt = executionAttempt.receipt;
  const issuedTransaction = VersionedTransaction.deserialize(Buffer.from(issuedWinner.transactionBase64, 'base64'));
  const signedTransaction = VersionedTransaction.deserialize(Buffer.from(sellerSignedTransactionBase64, 'base64'));
  assert.deepEqual(Buffer.from(signedTransaction.message.serialize()), Buffer.from(issuedTransaction.message.serialize()), 'Seller signature preserved the exact issued message');
  assert.equal(signedTransaction.signatures.length, 2);
  assert.ok(signedTransaction.signatures.every((signature) => signature.some((byte) => byte !== 0)), 'both Maker and Seller signatures are present');
  assert.equal(bs58.encode(Buffer.from(signedTransaction.signatures[0])), receipt.signature, 'prederived signature matches the landed receipt');
  assert.equal(receipt.cluster, 'solana:localnet');
  assert.ok(receipt.slot > 0);
  assert.equal(receipt.commitment, 'confirmed');
  assert.equal(receipt.stockMint, fixture.stockMint);
  assert.equal(receipt.stableMint, usdc);
  assert.equal(receipt.stockTokenProgram, tokenProgram);
  assert.equal(receipt.stableTokenProgram, stableTokenProgram);

  const message = signedTransaction.message;
  assert.deepEqual(message.staticAccountKeys.slice(0, 2).map((key) => key.toBase58()), [fixture.sellerPubkey, fixture.makerPublicKey]);
  const rfqProgramId = fixture.programId;
  const rfqInstructions = message.compiledInstructions.filter((instruction) => message.staticAccountKeys[instruction.programIdIndex]?.toBase58() === rfqProgramId);
  assert.equal(rfqInstructions.length, 1, 'landed transaction contains exactly one RFQ instruction');
  const rfq = rfqInstructions[0];
  assert.deepEqual(rfq.accountKeyIndexes.map((index) => message.staticAccountKeys[index].toBase58()), [
    fixture.sellerPubkey, fixture.makerPublicKey,
    fixture.sellerStockAccount, fixture.makerStockAccount,
    fixture.makerStableAccounts[usdc], fixture.sellerStableAccounts[usdc], fixture.feeStableAccounts[usdc],
    fixture.feeRecipient, fixture.stockMint, usdc, tokenProgram, stableTokenProgram,
    fixture.assetRegistry, fixture.makerRegistry, fixture.governance,
    new PublicKey(receipt.fillReceipt).toBase58(), '11111111111111111111111111111111',
  ], 'independently decoded settlement account roles match the governed fixture');
  const data = Buffer.from(rfq.data);
  assert.equal(data.subarray(0, 8).toString('hex'), 'd177c33bf6958696');
  assert.equal(data.subarray(8, 40).toString('hex'), issuedWinner.quoteId);
  const inputAmount = data.readBigUInt64LE(56);
  const makerMinimum = data.readBigUInt64LE(64);
  const gross = data.readBigUInt64LE(72);
  const netMinimum = data.readBigUInt64LE(80);
  const feeBps = data.readUInt16LE(88);
  const fee = gross * BigInt(feeBps) / 10_000n;
  assert.equal(inputAmount.toString(), '100000');
  assert.equal(makerMinimum, inputAmount);
  assert.equal(gross.toString(), receipt.grossOutputAtomic);
  assert.equal((gross - fee).toString(), receipt.netOutputAtomic);
  assert.equal(feeBps, 10);
  assert.equal(receipt.feeStableDeltaAtomic, fee.toString());
  const expectedFillReceipt = PublicKey.findProgramAddressSync([
    Buffer.from('fill'), new PublicKey(fixture.makerPublicKey).toBuffer(), data.subarray(8, 40),
  ], new PublicKey(fixture.programId))[0];
  assert.equal(receipt.fillReceipt, expectedFillReceipt.toBase58());
  const fillInfo = await rpc.getAccountInfo(expectedFillReceipt, 'confirmed');
  assert.ok(fillInfo, 'FillReceipt account landed on the RFQ program');
  assert.equal(fillInfo.owner.toBase58(), fixture.programId);
  assert.equal(fillInfo.data.subarray(0, 8).toString('hex'), createHash('sha256').update('account:FillReceipt').digest().subarray(0, 8).toString('hex'));
  assert.equal(fillInfo.data.subarray(8, 40).toString('hex'), issuedWinner.quoteId);
  assert.equal(new PublicKey(fillInfo.data.subarray(40, 72)).toBase58(), fixture.makerPublicKey);
  assert.equal(new PublicKey(fillInfo.data.subarray(72, 104)).toBase58(), fixture.sellerPubkey);
  assert.equal(new PublicKey(fillInfo.data.subarray(104, 136)).toBase58(), fixture.sellerPubkey);
  assert.equal(fillInfo.data.readBigUInt64LE(144), gross);
  assert.equal(fillInfo.data.readBigUInt64LE(152), fee);

  const landed = await rpcCall('getTransaction', [receipt.signature, {
    encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  }]);
  assert.ok(landed, 'RPC returned the landed transaction');
  assert.equal(landed.slot, receipt.slot);
  assert.equal(landed.meta.err, null);
  const rpcMessage = landed.transaction.message;
  assert.equal(landed.transaction.signatures[0], receipt.signature, 'RPC transaction carries the prederived Seller signature');
  assert.deepEqual(rpcMessage.accountKeys.slice(0, 2), [fixture.sellerPubkey, fixture.makerPublicKey]);
  const rpcRfqInstructions = rpcMessage.instructions.filter((instruction) => rpcMessage.accountKeys[instruction.programIdIndex] === rfqProgramId);
  assert.equal(rpcRfqInstructions.length, 1, 'RPC transaction contains exactly one RFQ settlement instruction');
  assert.deepEqual(rpcRfqInstructions[0].accounts.map((index) => rpcMessage.accountKeys[index]),
    rfq.accountKeyIndexes.map((index) => message.staticAccountKeys[index].toBase58()),
    'RPC landed instruction carries the reviewed governed accounts');
  assert.deepEqual(Buffer.from(bs58.decode(rpcRfqInstructions[0].data)), Buffer.from(rfq.data),
    'RPC landed instruction data matches the reviewed settlement terms');
  const status = await rpcCall('getSignatureStatuses', [[receipt.signature], { searchTransactionHistory: true }]);
  assert.equal(status.value[0]?.err ?? null, null);
  assert.ok(['confirmed', 'finalized'].includes(status.value[0]?.confirmationStatus));

  const after = Object.fromEntries(await Promise.all(accounts.map(async (entry) => [entry.name, await readTokenState(entry)])));
  const expectedAfter = {
    'seller stock': (BigInt(before['seller stock']) - inputAmount).toString(),
    'maker stock': (BigInt(before['maker stock']) + inputAmount).toString(),
    'maker USDC': (BigInt(before['maker USDC']) - gross).toString(),
    'seller USDC': (BigInt(before['seller USDC']) + gross - fee).toString(),
    'fee USDC': (BigInt(before['fee USDC']) + fee).toString(),
  };
  assert.deepEqual(after, expectedAfter, 'independent RPC token account reads match exact settlement economics');
  for (const entry of accounts) {
    const accountIndex = rpcMessage.accountKeys.indexOf(entry.address);
    assert.notEqual(accountIndex, -1, `landed RPC transaction contains ${entry.name}`);
    const pre = landed.meta.preTokenBalances.find((balance) => balance.accountIndex === accountIndex);
    const post = landed.meta.postTokenBalances.find((balance) => balance.accountIndex === accountIndex);
    assert.ok(pre && post, `RPC transaction metadata includes before and after balances for ${entry.name}`);
    assert.equal(pre.mint, entry.mint);
    assert.equal(post.mint, entry.mint);
    assert.equal(pre.owner, entry.owner);
    assert.equal(post.owner, entry.owner);
    assert.equal(pre.programId, entry.program);
    assert.equal(post.programId, entry.program);
    assert.equal(pre.uiTokenAmount.amount, before[entry.name]);
    assert.equal(post.uiTokenAmount.amount, after[entry.name]);
  }
  assert.equal(receipt.sellerStockDeltaAtomic, `-${inputAmount}`);
  assert.equal(receipt.makerStockDeltaAtomic, inputAmount.toString());
  assert.equal(receipt.makerStableDeltaAtomic, `-${gross}`);
  assert.equal(receipt.sellerStableDeltaAtomic, (gross - fee).toString());
  assert.equal(receipt.feeStableDeltaAtomic, fee.toString());
  assert.ok(receipt.fillReceipt);

  const requiredSellerPaths = ['/v1/seller-sessions/challenge', '/v1/seller-sessions', '/v1/assets', '/v1/quote-sprints'];
  for (const path of requiredSellerPaths) assert.ok(httpEvidence.some((entry) => entry.path.startsWith(path)), `browser did not call ${path}`);
  const protectedRequests = httpEvidence.filter((entry) => entry.path === '/v1/assets' || entry.path === '/v1/trades'
    || entry.path.startsWith('/v1/quote-sprints') || entry.path === '/v1/execution-attempts');
  assert.ok(protectedRequests.length >= 7, 'expected authenticated reads, Quote Sprint, review, authorization, and execution');
  for (const request of protectedRequests) {
    assert.equal(request.hasSellerProof, true, `${request.method} ${request.path} omitted Seller proof`);
    assert.equal(request.cluster, 'localnet', `${request.method} ${request.path} omitted cluster binding`);
    assert.equal(request.originClaim, webOrigin, `${request.method} ${request.path} omitted app origin binding`);
    assert.ok([200, 201].includes(request.status), `${request.method} ${request.path} returned ${request.status}`);
  }
  assert.equal(httpEvidence.some((entry) => entry.path.includes('/v1/execution-attempts') && entry.method === 'GET'), false);
  assert.deepEqual(consoleErrors.filter((message) => !message.includes('favicon.ico')), [], `browser console errors: ${consoleErrors.join(' | ')}`);
  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join(' | ')}`);

  rpcEvidence.push({
    rpcUrl: localRpcUrl, programId: fixture.programId, stockMint: fixture.stockMint,
    stockTokenProgram: tokenProgram, stableMint: usdc, stableTokenProgram,
    accounts: accounts.map(({ name, address, mint, program }) => ({ name, address, mint, tokenProgram: program, before: before[name], after: after[name] })),
    signature: receipt.signature, slot: receipt.slot, commitment: receipt.commitment,
    inputAmountAtomic: inputAmount.toString(), grossStableAtomic: gross.toString(), feeBps,
    feeAtomic: fee.toString(), netStableAtomic: (gross - fee).toString(), fillReceipt: receipt.fillReceipt,
  });

  console.log('Seller Wallet Standard walkthrough: challenge signed, exact Private Maker v0 settlement reviewed, Seller signed issued bytes, one submission confirmed by local RPC.');
  console.log(`Settlement evidence: ${JSON.stringify(rpcEvidence[0])}`);
  console.log(`HTTP evidence: ${httpEvidence.length} authenticated Seller API calls; every protected response succeeded. No Devnet or Mainnet request was made.`);
} catch (error) {
  if (browser) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      console.error(`Browser DOM at failure:\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 7000)}`);
    }
  }
  console.error(`HTTP evidence at failure: ${JSON.stringify(httpEvidence)}\nRPC evidence at failure: ${JSON.stringify(rpcEvidence)}\nAPI stderr: ${apiStderr}\nVite stderr: ${webStderr}`);
  throw error;
} finally {
  await browser?.close();
  for (const child of [web, api]) child.kill('SIGTERM');
  await Promise.all([web, api].map((child) => Promise.race([once(child, 'exit'), delay(5_000)])));
}

async function freePort() {
  let port;
  do { port = await probePort(); } while (allocatedPorts.has(port));
  allocatedPorts.add(port);
  return port;
}
async function probePort() {
  const server = net.createServer();
  await new Promise((resolvePromise, reject) => server.listen(0, '127.0.0.1', resolvePromise).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port');
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}
