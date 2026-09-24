import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const seller = Keypair.generate();
const pkcs8 = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  seller.secretKey.slice(0, 32),
]).toString('base64');

const allocatedPorts = new Set();
async function freePort() {
  let allocated;
  do { allocated = await probePort(); } while (allocatedPorts.has(allocated));
  allocatedPorts.add(allocated);
  return allocated;
}

async function probePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port');
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitReady(url, child, label, getStderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode}: ${getStderr()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`${label} did not become ready: ${getStderr()}`);
}

const apiPort = await freePort();
const webPort = await freePort();
const rpcMethods = [];
const rpc = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  rpcMethods.push(payload.method);
  if (payload.method !== 'getLatestBlockhash') {
    response.writeHead(501, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: `unexpected local fixture RPC: ${payload.method}` } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 99 } } }));
});
await new Promise((resolve, reject) => rpc.listen(0, '127.0.0.1', resolve).once('error', reject));
const rpcAddress = rpc.address();
if (!rpcAddress || typeof rpcAddress === 'string') throw new Error('could not start local fixture RPC');

const webOrigin = `http://127.0.0.1:${webPort}`;
const apiBase = `http://127.0.0.1:${apiPort}`;
const api = spawn(process.execPath, ['--import', 'tsx', 'apps/solana-api/src/server.ts'], {
  cwd: repo,
  env: {
    ...process.env,
    SOLANA_API_PORT: String(apiPort),
    SOLANA_API_AUTOSTART: 'true',
    SOLANA_API_ORIGIN: webOrigin,
    SOLANA_CLUSTER: 'localnet',
    SOLANA_SELLER_SESSION_SECRET: 'browser-journey-seller-session-secret-with-entropy',
    SOLANA_ROLE_IDENTITIES: '',
    KATON_LOCALNET: '1',
    SOLANA_RPC_URL: `http://127.0.0.1:${rpcAddress.port}`,
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

let browser;
const httpEvidence = [];
try {
  await waitReady(`${apiBase}/v1/reference-policy`, api, 'authenticated Seller API', () => apiStderr);
  await waitReady(webOrigin, web, 'Seller Desk Vite app', () => webStderr);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const evidenceByRequest = new WeakMap();
  const sprintPayloads = [];
  const consoleErrors = [];
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) => browserErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`));
  rpc.on('request', () => undefined);
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', (request) => {
    if (!new URL(request.url()).pathname.startsWith('/v1/')) return;
    const headers = request.headers();
    const evidence = {
      method: request.method(),
      path: new URL(request.url()).pathname,
      origin: headers.origin,
      originClaim: headers['x-katon-origin'],
      hasSellerProof: headers.authorization?.startsWith('Bearer seller-v1.') ?? false,
      cluster: headers['x-katon-cluster'],
      status: undefined,
    };
    evidenceByRequest.set(request, evidence);
    httpEvidence.push(evidence);
  });
  page.on('response', async (response) => {
    if (!new URL(response.url()).pathname.startsWith('/v1/')) return;
    const entry = evidenceByRequest.get(response.request());
    if (entry) entry.status = response.status();
    const path = new URL(response.url()).pathname;
    if (response.request().method() === 'GET' && /^\/v1\/quote-sprints\/[^/]+$/.test(path) && response.ok()) {
      const sprint = await response.json();
      sprintPayloads.push(sprint);
    }
  });

  const publicKeyBytes = seller.publicKey.toBytes();
  await page.addInitScript(({ walletAddress, publicKey, privateKeyPkcs8 }) => {
    const chain = 'solana:localnet';
    const account = { address: walletAddress, publicKey: Uint8Array.from(publicKey), chains: [chain], features: ['solana:signMessage'], label: 'Local Seller Fixture' };
    const listeners = new Set();
    const wallet = {
      version: '1.0.0', name: 'Local Seller Fixture', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: [chain], accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => { wallet.accounts = [account]; for (const listener of listeners) listener({ accounts: wallet.accounts }); return { accounts: wallet.accounts }; } },
        'standard:events': { version: '1.0.0', on: (_event, listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
        'solana:signMessage': { version: '1.1.0', signMessage: async (...inputs) => {
          const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(privateKeyPkcs8), (character) => character.charCodeAt(0)), { name: 'Ed25519' }, false, ['sign']);
          return Promise.all(inputs.map(async ({ message }) => ({ signedMessage: message, signature: new Uint8Array(await crypto.subtle.sign('Ed25519', key, message)), signatureType: 'ed25519' })));
        } },
      },
    };
    window.addEventListener('wallet-standard:app-ready', (event) => event.detail.register(wallet));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(wallet) }));
  }, { walletAddress: seller.publicKey.toBase58(), publicKey: [...publicKeyBytes], privateKeyPkcs8: pkcs8 });

  await page.goto(`${webOrigin}/trade`);
  await page.getByRole('heading', { name: /sell tokenized stock/i }).waitFor();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Prove Seller wallet' }).click();
  await page.getByText('Seller session active', { exact: true }).waitFor();
  await page.locator('#asset option').filter({ hasText: 'AAPLx' }).waitFor({ state: 'attached' });
  await page.getByText(/Balance 2\.5\b/).waitFor();
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.getByRole('heading', { name: 'Your exits.' }).waitFor();
  await page.getByText('No localnet attempts yet').waitFor();
  await page.getByRole('link', { name: 'Seller Desk', exact: true }).click();
  await page.locator('#amount').fill('0.1');
  await page.getByRole('button', { name: /Find best executable price/ }).click();
  await page.locator('.ready-panel').waitFor();
  await page.getByRole('button', { name: /Review 1 lamport transfer/ }).click();
  await page.getByRole('heading', { name: 'Review proof transfer' }).waitFor();
  assert.match(await page.locator('.review-panel').innerText(), /1 lamport/);
  assert.equal(await page.getByRole('button', { name: /Approve and sign 1 lamport transfer/ }).count(), 1);

  const requiredSellerPaths = ['/v1/seller-sessions/challenge', '/v1/seller-sessions', '/v1/assets', '/v1/trades', '/v1/quote-sprints'];
  const seenPaths = new Set(httpEvidence.map((entry) => entry.path));
  for (const path of requiredSellerPaths) assert.ok(seenPaths.has(path), `browser did not call ${path}`);
  const sellerProtected = httpEvidence.filter((entry) => entry.path === '/v1/assets' || entry.path === '/v1/trades' || entry.path.startsWith('/v1/quote-sprints'));
  assert.ok(sellerProtected.length >= 5, 'expected wallet reads, Quote Sprint creation, full Sprint polling, and review');
  for (const request of sellerProtected) {
    assert.equal(request.hasSellerProof, true, `${request.method} ${request.path} omitted Seller proof`);
    assert.equal(request.cluster, 'localnet', `${request.method} ${request.path} omitted cluster binding`);
    assert.ok(request.origin === undefined || request.origin === webOrigin, `${request.method} ${request.path} carried the wrong browser origin`);
    assert.equal(request.originClaim, webOrigin, `${request.method} ${request.path} omitted or changed the SDK origin binding`);
    assert.ok([200, 201].includes(request.status), `${request.method} ${request.path} returned ${request.status}`);
  }
  assert.ok(sprintPayloads.some((sprint) => typeof sprint.winner?.transactionBase64 === 'string'), 'authenticated full Sprint GET did not return its transaction bytes');
  assert.ok(rpcMethods.length > 0 && rpcMethods.every((method) => method === 'getLatestBlockhash'), `unexpected RPC activity: ${rpcMethods.join(', ')}`);
  assert.equal(httpEvidence.some((entry) => entry.path === '/v1/execution-attempts'), false, 'browser journey must stop before transaction submission');
  assert.deepEqual(consoleErrors.filter((message) => !message.includes('favicon.ico')), [], `browser console errors: ${consoleErrors.join(' | ')}`);
  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join(' | ')}`);

  console.log('Seller browser journey: signed one-use challenge, authenticated asset/activity reads, Quote Sprint creation/full polling/review; no transaction signed or submitted');
  console.log(`HTTP evidence: ${httpEvidence.length} requests; POST Origin headers and the configured same-origin GET fallback, bearer proof, and localnet cluster checked separately from local RPC evidence (${rpcMethods.join(', ')})`);
} catch (error) {
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const page of pages) {
      console.error(`Browser DOM at failure:\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 5000)}`);
    }
  }
  console.error(`HTTP evidence at failure: ${JSON.stringify(httpEvidence)}\nAPI stderr: ${apiStderr}\nVite stderr: ${webStderr}`);
  throw error;
} finally {
  await browser?.close();
  for (const child of [web, api]) child.kill('SIGTERM');
  await Promise.all([web, api].map((child) => Promise.race([once(child, 'exit'), delay(5_000)])));
  await new Promise((resolve) => rpc.close(() => resolve()));
}
