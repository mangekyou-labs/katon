import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const maker = roleIdentity('maker', 'browser-live-maker');
const operator = roleIdentity('operator');
const apiPort = await freePort();
const webPort = await freePort();
const apiBase = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const roleSessionSecret = 'live-maker-browser-session-secret-with-enough-entropy';

const api = spawn(process.execPath, ['--import', 'tsx', 'apps/solana-api/src/server.ts'], {
  cwd: repo,
  env: {
    ...process.env,
    SOLANA_API_PORT: String(apiPort),
    SOLANA_API_AUTOSTART: 'true',
    SOLANA_API_ORIGIN: webOrigin,
    SOLANA_CLUSTER: 'localnet',
    KATON_LOCALNET: '1',
    SOLANA_ROLE_IDENTITIES: JSON.stringify([maker.identity, operator.identity]),
    SOLANA_ROLE_SESSION_SECRET: roleSessionSecret,
    SOLANA_SELLER_SESSION_SECRET: 'live-maker-browser-seller-secret-with-enough-entropy',
    SOLANA_RPC_URL: '',
    SOLANA_DEPLOYMENT_MANIFEST: '',
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

const browserRequests = [];
const browserConsole = [];
const browserPageErrors = [];
let browser;
try {
  await waitReady(`${apiBase}/v1/reference-policy`, api, 'role API', () => apiStderr);
  await waitReady(webOrigin, web, 'web app', () => webStderr);

  browser = await chromium.launch({ headless: true });
  const makerPage = await browser.newPage();
  makerPage.setDefaultTimeout(10_000);
  watchBrowser(makerPage, browserConsole, browserPageErrors, 'maker');
  watchApi(makerPage, browserRequests, 'maker');
  await installWallet(makerPage, maker);
  await makerPage.goto(`${webOrigin}/maker`);
  await makerPage.getByRole('heading', { name: /Quote with/ }).waitFor();
  await makerPage.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await makerPage.getByRole('button', { name: 'Authenticate maker' }).click();
  await makerPage.getByText('maker role session active', { exact: true }).waitFor();
  await makerPage.getByText('browser-live-maker', { exact: true }).waitFor();
  await makerPage.getByText('Disabled · unavailable', { exact: true }).waitFor();
  await makerPage.getByText('0 ranges', { exact: true }).waitFor();
  await makerPage.getByText('0 accepted', { exact: true }).waitFor();
  await makerPage.getByRole('heading', { name: 'Fill details' }).waitFor();
  assert.equal(await makerPage.getByRole('button', { name: 'Disable my maker source' }).isDisabled(), true,
    'a Maker without observed governance enablement must remain disabled');
  assert.equal(await makerPage.getByRole('button', { name: /governance|enable|liquidation|ondo/i }).count(), 0,
    'Maker browser must not expose governance or asset enablement actions');
  assert.equal((await makerPage.locator('body').innerText()).includes('Seller wallet'), false,
    'Maker status must not expose Seller identity');

  const makerReads = browserRequests.filter((entry) => entry.role === 'maker' && entry.path === '/v1/makers/me');
  assert.ok(makerReads.length > 0, 'Maker page did not read its authenticated API status');
  for (const entry of makerReads) {
    assert.equal(entry.status, 200, 'Maker status read was not accepted by the running API');
    assert.match(entry.authorization ?? '', /^Bearer v1\./, 'Maker status read omitted its role session');
  }
  assert.ok(browserRequests.some((entry) => entry.role === 'maker' && entry.path === '/v1/role-sessions/challenge' && entry.method === 'POST'));
  assert.ok(browserRequests.some((entry) => entry.role === 'maker' && entry.path === '/v1/role-sessions' && entry.method === 'POST'));
  assert.equal(browserRequests.some((entry) => entry.role === 'maker' && (entry.path.startsWith('/v1/operator') || entry.path.startsWith('/v1/seller-sessions'))), false);

  const operatorPage = await browser.newPage();
  operatorPage.setDefaultTimeout(10_000);
  watchBrowser(operatorPage, browserConsole, browserPageErrors, 'operator');
  watchApi(operatorPage, browserRequests, 'operator');
  await installWallet(operatorPage, operator);
  await operatorPage.goto(`${webOrigin}/operator`);
  await operatorPage.getByRole('heading', { name: /Keep the desk/ }).waitFor();
  await operatorPage.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await operatorPage.getByRole('button', { name: 'Authenticate operator' }).click();
  await operatorPage.getByText('operator role session active', { exact: true }).waitFor();
  await operatorPage.getByRole('heading', { name: 'Liquidation Execution' }).waitFor();
  await operatorPage.getByText('Ondo and Liquidation Execution are disabled. Governance queue and pause data are read only. The browser has no governance write action.', { exact: true }).waitFor();
  const operatorText = await operatorPage.locator('body').innerText();
  assert.ok(operatorText.includes('Local source controls'));
  assert.ok(operatorText.toLowerCase().includes('local proof'));
  assert.ok(operatorText.includes('This browser has no governance apply or surface enablement action.'));
  assert.match(operatorText, /Liquidation Execution[\s\S]*Unavailable/);
  assert.equal(await operatorPage.locator('article.operations-card p ul').count(), 0,
    'operator evidence detail must use valid list markup');
  assert.equal(await operatorPage.getByRole('button', { name: /governance|enable|liquidation|ondo/i }).count(), 0,
    'Operator browser must not expose governance, asset, or liquidation enablement actions');
  assert.ok(browserRequests.some((entry) => entry.role === 'operator' && entry.path === '/v1/operator' && entry.status === 200 && /^Bearer v1\./.test(entry.authorization ?? '')),
    'Operator page did not read its authenticated API status');
  assert.equal(browserPageErrors.length, 0, `browser raised uncaught errors: ${JSON.stringify(browserPageErrors)}`);
  assert.equal(browserConsole.some(({ text }) => /validateDOMNesting|cannot appear as a descendant|In HTML, <ul>/i.test(text)), false,
    `browser reported invalid nested markup: ${JSON.stringify(browserConsole)}`);

  console.log('live Maker browser journey: Wallet Standard role proof and Maker status read against the running authenticated API; source remains disabled before governance enablement');
  console.log('operator browser evidence: local source state, unavailable governance and Liquidation Execution, and no enablement actions');
  console.log(`browser console check: ${browserConsole.length} warning/error message(s); no React nesting warning; ${browserPageErrors.length} uncaught page error(s)`);
  console.log(`authenticated browser HTTP evidence: ${browserRequests.filter((entry) => entry.status !== undefined).map(({ role, method, path, status }) => `${role} ${method} ${path} ${status}`).join('; ')}`);
} catch (error) {
  if (browser) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      console.error(`${page.url()} DOM at failure:\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 4000)}`);
    }
  }
  console.error(`Browser API evidence: ${JSON.stringify(browserRequests)}\nAPI stderr: ${apiStderr}\nVite stderr: ${webStderr}`);
  throw error;
} finally {
  await browser?.close();
  for (const child of [web, api]) child.kill('SIGTERM');
  await Promise.all([web, api].map((child) => Promise.race([once(child, 'exit'), delay(5_000)])));
}

function roleIdentity(role, makerId) {
  const pair = Keypair.generate();
  const publicKey = pair.publicKey.toBase58();
  const privateKeyPkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    pair.secretKey.slice(0, 32),
  ]).toString('base64');
  return {
    publicKey,
    privateKeyPkcs8,
    publicKeyBytes: [...pair.publicKey.toBytes()],
    identity: { publicKey, role, ...(makerId ? { makerId } : {}) },
  };
}

async function installWallet(page, identity) {
  await page.addInitScript(({ walletAddress, publicKey, privateKeyPkcs8 }) => {
    const chain = 'solana:localnet';
    const account = { address: walletAddress, publicKey: Uint8Array.from(publicKey), chains: [chain], features: ['solana:signMessage'], label: 'Live API fixture wallet' };
    const listeners = new Set();
    const wallet = {
      version: '1.0.0', name: 'Live API fixture wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: [chain], accounts: [],
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
  }, { walletAddress: identity.publicKey, publicKey: identity.publicKeyBytes, privateKeyPkcs8: identity.privateKeyPkcs8 });
}

function watchApi(page, evidence, role) {
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/v1/')) return;
    evidence.push({ role, method: request.method(), path: url.pathname, authorization: request.headers().authorization });
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/v1/')) return;
    const entry = evidence.findLast((candidate) => candidate.role === role && candidate.path === url.pathname && candidate.status === undefined);
    if (entry) entry.status = response.status();
  });
}

function watchBrowser(page, consoleEvidence, pageErrors, role) {
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      consoleEvidence.push({ role, type: message.type(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => pageErrors.push({ role, text: error.message }));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
