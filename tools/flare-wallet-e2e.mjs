import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { buildSimRelayEnvelopes } from './sim-rfq-payload.mjs';

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('PORT_ALLOCATE');
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const port = await freePort();
const apiPort = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const account = '0x00000000000000000000000000000000000000aa';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertAccessible(page, route) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map((violation) => `${violation.id}:${violation.nodes.map((node) => `${node.target.join('|')} (${node.failureSummary ?? 'details unavailable'})`).join(';')}`);
  assert(violations.length === 0, `a11y violations on ${route}: ${violations.join(',')}`);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('FLARE_WEB_SERVER_TIMEOUT');
}

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/v1/health`);
      if (response.ok) return;
    } catch {
      // API is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('FLARE_API_SERVER_TIMEOUT');
}

async function runRelayApiCase() {
  const { auctionEnvelope, bidEnvelope } = buildSimRelayEnvelopes({ wallet: account });
  const opened = await fetch(`${apiUrl}/v1/relay/auctions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: account, eligibleLps: [account], duration: '24h', earlyCloseAllowed: true, envelope: auctionEnvelope }) });
  assert(opened.status === 201, `relay open failed: ${opened.status}`);
  const auction = await opened.json();
  const bid = await fetch(`${apiUrl}/v1/relay/auctions/${auction.id}/bids`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: account, idempotencyKey: 'e2e-bid', envelope: bidEnvelope }) });
  assert(bid.status === 200, `relay bid failed: ${bid.status}`);
  const finalized = await fetch(`${apiUrl}/v1/relay/auctions/${auction.id}/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: account }) });
  assert(finalized.status === 200, `relay finalize failed: ${finalized.status}`);
  const result = await finalized.json();
  assert(result.bidCount === 1 && result.status === 'finalized', 'relay lifecycle result mismatch');
  assert(typeof result.matchResult?.resultHash === 'string' && /^0x[0-9a-f]{64}$/.test(result.matchResult.resultHash), 'relay finalize missing route resultHash');
  const ftso = await fetch(`${apiUrl}/v1/oracles/ftso?feedId=0x01464c522f55534400000000000000000000000000`);
  assert(ftso.status === 503, `unconfigured FTSO boundary did not fail closed: ${ftso.status}`);
  const fdc = await fetch(`${apiUrl}/v1/oracles/fdc/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attestationType: 'EVMTransaction', sourceId: 'testETH', requestBody: {} }) });
  assert(fdc.status === 503, `unconfigured FDC boundary did not fail closed: ${fdc.status}`);
}

async function runWalletCase(browser, chainId, expectedText) {
  const context = await browser.newContext();
  await context.addInitScript(({ account: injectedAccount, chain, apiPort: injectedApiPort }) => {
    const calls = [];
    const transactions = [];
    window.__walletCalls = calls;
    window.__walletTransactions = transactions;
    window.__FLARE_FCC_MODE__ = 'simulated';
    window.ethereum = {
      request: async ({ method, params }) => {
        calls.push(method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [injectedAccount];
        if (method === 'eth_chainId') return chain;
        if (method === 'eth_blockNumber') return '0x100';
        if (method === 'eth_getBlockByNumber') return { hash: `0x${'b'.repeat(64)}` };
        if (method === 'eth_sendTransaction') {
          transactions.push(params?.[0]);
          return '0xd9dfb691b1b8c837d747551cfe22e099a2efd4db158af8be1ef84a4d096ba368';
        }
        if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
        throw new Error(`UNEXPECTED_METHOD:${method}`);
      },
    };
    window.__FLARE_API_URL__ = `http://127.0.0.1:${injectedApiPort}`;
  }, { account, chain: chainId, apiPort });

  const page = await context.newPage();
  for (const [width, height] of [[375, 800], [768, 900], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${baseUrl}/swap`, { waitUntil: 'domcontentloaded' });
    const viewport = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert(viewport.scrollWidth <= viewport.clientWidth, `horizontal overflow at ${width}px`);
    assert(await page.getByRole('button', { name: 'Connect wallet' }).count() === 1, `wallet action missing at ${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${baseUrl}/swap`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect wallet' }).waitFor();
  await page.locator('body').focus();
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return { tag: '', visible: false, outline: '' };
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, visible: rect.width > 0 && rect.height > 0, outline: getComputedStyle(element).outlineStyle };
    });
    assert(focus.visible && focus.tag !== 'BODY', `keyboard focus escaped the page at tab ${index}`);
  }
  let relayRequestBody;
  page.on('request', (request) => {
    if (request.url().endsWith('/v1/relay/auctions') && request.method() === 'POST') relayRequestBody = request.postData() ?? '';
  });
  await page.goto(`${baseUrl}/swap`);
  await page.getByRole('button', { name: 'Connect wallet' }).click();

  if (expectedText === 'connected') {
    await page.getByRole('button', { name: /0x0000…00AA/ }).waitFor();
    const calls = await page.evaluate(() => window.__walletCalls);
    assert(JSON.stringify(calls) === JSON.stringify(['eth_requestAccounts', 'eth_chainId']), 'wallet RPC call order changed');
    assert(await page.locator('.wallet-button__dot--connected').count() === 1, 'connected wallet indicator missing');
    await page.getByRole('link', { name: 'Auctions', exact: true }).click();
    await page.getByRole('heading', { name: 'Confidential auctions', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sort by Auction', exact: true }).click();
    assert(await page.getByRole('columnheader', { name: /Auction/ }).getAttribute('aria-sort') === 'ascending', 'auction sort state missing');
    await page.getByLabel('Auction pair').fill('RWA / USDX');
    await page.getByLabel('Auction minimum output').fill('995');
    await page.getByRole('button', { name: 'Open confidential auction' }).click();
    await page.getByText('Ciphertext-only relay').waitFor();
    assert(relayRequestBody && !relayRequestBody.includes('RWA / USDX') && !relayRequestBody.includes('995'), `auction plaintext crossed the relay boundary: ${relayRequestBody}`);
    await page.getByRole('cell', { name: 'Encrypted RFQ', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Refresh Confidential auctions' }).click();
    await page.getByRole('status', { name: 'Confidential auctions: Ready' }).waitFor();
    await page.getByRole('link', { name: 'Swap / Redeem', exact: true }).click();
    await page.getByRole('heading', { name: 'Swap / Redeem', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Copy address', exact: true }).first().click();
    assert(await page.getByRole('button', { name: 'Copied', exact: true }).count() === 1, 'asset address copy state missing');
    await page.getByRole('link', { name: 'Standing Bids', exact: true }).click();
    await page.getByRole('heading', { name: 'Create a standing bid', exact: true }).waitFor();
    await page.getByLabel('Standing bid capacity').fill('1');
    await page.getByRole('button', { name: 'Create standing bid' }).click();
    await page.getByText('Wallet-owned').waitFor();
    await page.getByRole('cell', { name: 'RWA / USDX', exact: true }).first().waitFor();
    await page.getByRole('link', { name: 'Facility', exact: true }).click();
    await page.getByRole('heading', { name: 'Facility position', exact: true }).waitFor();
    await page.getByLabel('Withdrawal shares').fill('1');
    await page.getByLabel('Withdrawal minimum assets').fill('995');
    await page.getByRole('button', { name: 'Queue withdrawal' }).click();
    await page.getByText('1 requests', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Liquidations', exact: true }).click();
    await page.getByRole('heading', { name: 'Review a venue route', exact: true }).waitFor();
    await page.getByLabel('Liquidation venue').fill('verified-venue');
    await page.getByLabel('Liquidation market').fill('verified-market');
    await page.getByLabel('Liquidation position').fill('position-1');
    await page.getByLabel('Maximum repay').fill('100');
    await page.getByLabel('Gross collateral').fill('120');
    await page.getByLabel('Minimum net collateral').fill('119');
    await page.getByRole('button', { name: 'Review atomic route' }).click();
    await page.getByText('Ready for verified route binding', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('heading', { name: 'Portfolio activity', exact: true }).waitFor();
    await page.getByText('Auction opened', { exact: true }).first().waitFor();
    await page.getByRole('link', { name: 'Swap / Redeem', exact: true }).click();
    await page.getByRole('heading', { name: 'Swap / Redeem', exact: true }).waitFor();
    await page.getByLabel('Amount').fill('1');
    await page.getByLabel('Minimum receive').fill('995');
    await page.getByRole('button', { name: '25%' }).click();
    assert(await page.getByLabel('Amount').inputValue() === '1.2475', '25 percent balance shortcut mismatch');
    await page.getByRole('button', { name: 'Max' }).click();
    assert(await page.getByLabel('Amount').inputValue() === '4.99', 'max balance shortcut reserve mismatch');
    await page.getByLabel('Amount').fill('1');
    await page.getByRole('button', { name: 'Request immediate quote' }).click();
    await page.getByLabel('Quote review').waitFor();
    await page.getByRole('button', { name: 'Sign and submit' }).click();
    await page.getByText('Indexed in the read model', { exact: true }).first().waitFor();
    const submitted = await page.evaluate(() => window.__walletTransactions?.[0]);
    assert(submitted?.to?.toLowerCase() === '0x7fa1817951de405a0c466696052cf50eba409333', `wallet submitted stale router: ${submitted?.to ?? 'missing'}`);
    assert(await page.getByText('Indexed in the read model', { exact: true }).count() >= 1, 'indexed state missing');
    assert(await page.getByRole('link', { name: /View transaction/ }).count() === 1, 'transaction explorer link missing');
    await assertAccessible(page, 'swap');
    for (const route of ['Auctions', 'Standing Bids', 'Facility', 'Liquidations', 'Dashboard']) {
      await page.getByRole('link', { name: route, exact: true }).click();
      await assertAccessible(page, route);
    }
  } else {
    await page.getByRole('alert').filter({ hasText: expectedText }).waitFor();
    assert(await page.getByRole('button', { name: 'Connect wallet' }).count() === 1, 'wrong-network flow changed wallet label');
  }

  await context.close();
}

const server = spawn('npm', ['run', 'dev:flare', '--', '--host', '127.0.0.1', '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const storeDirectory = mkdtempSync(join('/private/tmp', 'trustrfq-e2e-'));
const apiServer = spawn('npm', ['run', 'dev:flare-api'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FLARE_API_PORT: String(apiPort), FLARE_API_STORE: join(storeDirectory, 'store.json') },
});
let browser;
try {
  await waitForServer();
  await waitForApi();
  await runRelayApiCase();
  browser = await chromium.launch({ headless: process.env.FLARE_HEADED !== 'true' });
  await runWalletCase(browser, '0x72', 'connected');
  await runWalletCase(browser, '0xe', 'WRONG_NETWORK: expected 114, received 14');
  console.log('Flare browser E2E passed: live quote API, relay lifecycle, auctions, standing bids, facility queue, liquidation route review, dashboard read model, wallet submit lifecycle, and wrong-network flows');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  apiServer.kill('SIGTERM');
  rmSync(storeDirectory, { recursive: true, force: true });
}
