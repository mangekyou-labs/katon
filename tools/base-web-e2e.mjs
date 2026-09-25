import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
const ACCOUNT = '0x00000000000000000000000000000000000000aa';
const FACILITY = '0x0000000000000000000000000000000000000100';
// Keep the fixture aligned with the native Circle USDC address used by the
// public Base Sepolia runtime configuration.
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
// The browser runtime starts with the canonical Base B20 manifest and applies
// fixture overrides. Keep the injected-provider fixture on the first
// canonical asset so the sell page's deterministic first-asset selection
// exercises the same address it renders.
const B20 = '0xb200000000000000000000c2e324d24d7eecd1fb';
const ROUTER = '0x0000000000000000000000000000000000000030';
const SETTLEMENT = '0x0000000000000000000000000000000000000040';
const ORACLE_GUARD = '0x0000000000000000000000000000000000000050';
const B20_GUARD = '0x0000000000000000000000000000000000000060';
const ADAPTER = '0x0000000000000000000000000000000000000070';
const RFQ_ID = `0x${'11'.repeat(32)}`;
const DECISION_BLOCK_HASH = `0x${'22'.repeat(32)}`;
const SIMULATION_BLOCK_HASH = `0x${'23'.repeat(32)}`;
const PAYLOAD_HASH = `0x${'33'.repeat(32)}`;
const TX_HASH = `0x${'44'.repeat(32)}`;
const EXACT_STOCK = 100_000_000n;
const EXACT_USDC = 1_234_567n;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('BASE_E2E_PORT_ALLOCATE');
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('BASE_WEB_SERVER_TIMEOUT');
}

function facilityFixture() {
  return {
    address: FACILITY,
    roles: { admin: ACCOUNT, curator: ACCOUNT, guardian: ACCOUNT, executor: ACCOUNT, router: ROUTER },
    registered: true,
    paused: false,
    quotePaused: false,
    asset: USDC,
    nav: '100000000',
    idleAssets: '50000000',
    shares: '100000000',
    haircutWad: '950000000000000000',
    quoteUsdcCapacity: '47500000',
    queue: { totalAssets: '0', totalShares: '0', requests: [] },
    adapterAllocations: { [ADAPTER]: '10000000' },
    b20Inventory: { [B20]: { amount: '1000000000000000000', usdcPaid: '1000000' } },
    pinnedBlock: '42',
  };
}

function oracleFixture() {
  return {
    asset: B20,
    ticker: 'AAPLx',
    feed: '0x0000000000000000000000000000000000000080',
    answer: '1000000000000000000',
    answerUpdatedAt: '1990',
    answerAge: '10',
    heartbeat: '3600',
    fresh: true,
    registryPaused: false,
    sequencerUp: true,
    sequencerStartedAt: '1',
    sequencerInGrace: false,
    b20PausedFeatures: [],
    multiplierWad: '1000000000000000000',
    announcements: [{ id: 'announcement-1', description: 'Fixture multiplier', uri: 'https://example.test/announcement', caller: ACCOUNT, open: true }],
    pinnedBlock: '42',
  };
}

function liquidationFixture(source) {
  const finalized = source !== undefined;
  return {
    id: RFQ_ID,
    rfqId: RFQ_ID,
    debtAsset: USDC,
    collateralAsset: B20,
    marketId: `0x${'55'.repeat(32)}`,
    repayAssets: EXACT_USDC.toString(10),
    minCollateralOut: '100000000000000000000',
    deadline: '4102444800',
    status: finalized ? 'finalized' : 'open',
    bidCount: finalized ? 3 : 2,
    ...(finalized ? { winner: { identity: ACCOUNT, source } } : {}),
  };
}

function routeFixture(source) {
  return {
    chainId: '84532',
    to: ROUTER,
    target: ROUTER,
    data: '0x1234',
    value: '0',
    payloadHash: PAYLOAD_HASH,
    decisionBlock: '42',
    decisionBlockHash: DECISION_BLOCK_HASH,
    deadline: '4102444800',
    debtAsset: USDC,
    collateralAsset: B20,
    repayAssets: EXACT_USDC.toString(10),
    minCollateralOutRfq: '100000000000000000000',
    minCollateralOutFunder: '110000000000000000000',
    winner: ACCOUNT,
    source,
    recipient: ACCOUNT,
  };
}

function stockSaleQuoteFixture(status = 'WINNER') {
  return {
    requestId: `0x${'66'.repeat(32)}`,
    chainId: '84532',
    stockToken: B20,
    usdcToken: USDC,
    sellAmount: EXACT_STOCK.toString(10),
    minBuyAmount: EXACT_USDC.toString(10),
    taker: ACCOUNT,
    recipient: ACCOUNT,
    feeBps: '0',
    auctionOpenedAtMs: Date.now() - 100,
    auctionCutoffAtMs: Date.now() + 900,
    decisionBlock: '42',
    decisionBlockHash: DECISION_BLOCK_HASH,
    simulationBlock: '43',
    simulationBlockHash: SIMULATION_BLOCK_HASH,
    status,
    ...(status === 'NO_ROUTE' ? { reason: 'NO_EXECUTABLE_ROUTE' } : {}),
    ...(status === 'WINNER' ? { recommended: {
      kind: 'INTERNAL',
      source: 'KATON',
      routeId: `0x${'77'.repeat(32)}`,
      stockAmount: EXACT_STOCK.toString(10),
      grossUsdc: EXACT_USDC.toString(10),
      guaranteedUsdc: EXACT_USDC.toString(10),
      fee: '0',
      gasEstimateUsdc: '0',
      effectiveUsdc: EXACT_USDC.toString(10),
      expiry: '4102444800',
      decisionBlock: '42',
      decisionBlockHash: DECISION_BLOCK_HASH,
      allowanceTarget: SETTLEMENT,
      settlementAllowanceTarget: SETTLEMENT,
      transaction: {
        to: ROUTER,
        data: '0x1234',
        value: '0',
        chainId: 84532,
        recipient: ACCOUNT,
        stockToken: B20,
        usdcToken: USDC,
        sellAmount: EXACT_STOCK.toString(10),
        minBuyAmount: EXACT_USDC.toString(10),
      },
      legs: [],
    } } : {}),
    alternatives: [],
    external: [],
  };
}

function jsonResponse(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function createFixtureContext(browser, baseUrl, { chainId = '0x14a34', source, stockSaleStatus = 'WINNER' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const state = {
    postedBid: undefined,
    typedData: undefined,
    requests: [],
  };
  await context.addInitScript(({ account, initialChainId, decisionBlockHash, simulationBlockHash }) => {
    const chainStorageKey = '__base_e2e_chain_id__';
    let activeChainId = sessionStorage.getItem(chainStorageKey) ?? initialChainId;
    sessionStorage.setItem(chainStorageKey, activeChainId);
    const listeners = { accountsChanged: new Set(), chainChanged: new Set() };
    const calls = [];
    const transactions = [];
    window.__walletCalls = calls;
    window.__walletTransactions = transactions;
    window.__KATON_BASE_CONFIG__ = {
      network: 'sepolia',
      chainId: 84532,
      apiUrl: '/',
      rpcUrl: 'https://sepolia.base.org',
      routerAddress: '0x0000000000000000000000000000000000000030',
      settlementAddress: '0x0000000000000000000000000000000000000040',
      facilityAddress: '0x0000000000000000000000000000000000000100',
      oracleGuardAddress: '0x0000000000000000000000000000000000000050',
      b20GuardAddress: '0x0000000000000000000000000000000000000060',
      adapterAddresses: ['0x0000000000000000000000000000000000000070'],
      b20Assets: {
        '0xb200000000000000000000c2e324d24d7eecd1fb': {
          ticker: 'AAPLx',
          feed: '0x0000000000000000000000000000000000000080',
          decimals: 8,
        },
      },
      liquidationEnabled: true,
    };
    window.ethereum = {
      request: async ({ method, params }) => {
        calls.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
        if (method === 'eth_chainId') return activeChainId;
        if (method === 'net_version') return String(Number(BigInt(activeChainId)));
        if (method === 'eth_call') {
          const call = params?.[0];
          // allowance(address,address) is the only read made by the seller
          // flow. Return zero so the exact approval transaction is observable.
          if (typeof call?.data === 'string' && call.data.toLowerCase().startsWith('0xdd62ed3e')) return `0x${'00'.repeat(32)}`;
          return '0x';
        }
        // Keep the review fixture pinned to the decision block so the route
        // submission proves the fresh-block path without racing a synthetic
        // chain head between the two reads.
        if (method === 'eth_blockNumber') return '0x2a';
        if (method === 'eth_getBlockByNumber') {
          const block = params?.[0];
          const hash = block === '0x2a' ? decisionBlockHash : simulationBlockHash;
          return { number: block, hash };
        }
        if (method === 'eth_estimateGas') return '0x5208';
        if (method === 'eth_gasPrice') return '0x1';
        if (method === 'eth_getTransactionCount') return '0x0';
        if (method === 'wallet_switchEthereumChain') {
          activeChainId = params?.[0]?.chainId ?? activeChainId;
          sessionStorage.setItem(chainStorageKey, activeChainId);
          for (const listener of listeners.chainChanged) listener(activeChainId);
          return null;
        }
        if (method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction') {
          transactions.push(params?.[0]);
          return '0x4444444444444444444444444444444444444444444444444444444444444444';
        }
        if (method === 'eth_getTransactionReceipt') return {
          status: '0x1',
          blockNumber: '0x2a',
          transactionHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
        };
        if (method === 'personal_sign') return `0x${'11'.repeat(65)}`;
        if (method === 'eth_signTypedData_v4') {
          try { window.__typedData = JSON.parse(params?.[1] ?? '{}'); } catch { window.__typedData = null; }
          return `0x${'22'.repeat(65)}`;
        }
        throw new Error(`UNEXPECTED_WALLET_METHOD:${method}`);
      },
      on: (event, listener) => { listeners[event]?.add(listener); },
      removeListener: (event, listener) => { listeners[event]?.delete(listener); },
    };
  }, { account: ACCOUNT, initialChainId: chainId, decisionBlockHash: DECISION_BLOCK_HASH, simulationBlockHash: SIMULATION_BLOCK_HASH });

  await context.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    state.requests.push({ method: request.method(), path });
    if (request.method() === 'GET' && path === '/v1/facilities') {
      await route.fulfill(jsonResponse([facilityFixture()]));
      return;
    }
    if (request.method() === 'GET' && path.startsWith('/v1/facilities/')) {
      await route.fulfill(jsonResponse(facilityFixture()));
      return;
    }
    if (request.method() === 'GET' && path.startsWith('/v1/oracles/')) {
      await route.fulfill(jsonResponse(oracleFixture()));
      return;
    }
    if (request.method() === 'GET' && path === '/v1/liquidations') {
      await route.fulfill(jsonResponse([liquidationFixture(source)]));
      return;
    }
    if (request.method() === 'GET' && path === `/v1/liquidations/${RFQ_ID}`) {
      await route.fulfill(jsonResponse(liquidationFixture(source)));
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/route')) {
      await route.fulfill(jsonResponse(routeFixture(source)));
      return;
    }
    if (request.method() === 'GET' && path === '/v1/auth/nonce') {
      await route.fulfill(jsonResponse({ nonce: 'fixture-nonce', issuedAt: '2000', expirationTime: '3000', domain: 'Katon RFQ Desk', chainId: 84532 }));
      return;
    }
    if (request.method() === 'POST' && path === '/v1/auth/verify') {
      await route.fulfill(jsonResponse({ address: ACCOUNT, sessionToken: 'katon_session_fixture' }));
      return;
    }
    if (request.method() === 'POST' && path === '/v1/bids') {
      state.postedBid = JSON.parse(request.postData() ?? '{}');
      await route.fulfill(jsonResponse({ ...liquidationFixture('LP'), status: 'finalized', winner: { identity: ACCOUNT, source: 'LP' } }));
      return;
    }
    if (request.method() === 'POST' && path === '/v1/swaps/quote') {
      await route.fulfill(jsonResponse(stockSaleQuoteFixture(stockSaleStatus)));
      return;
    }
    await route.continue();
  });

  return { context, state, page: await context.newPage() };
}

async function assertAccessible(page, label) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map((violation) => `${violation.id}:${violation.nodes.map((node) => `${node.target.join('|')} (${node.failureSummary ?? 'details unavailable'})`).join(';')}`);
  assert(violations.length === 0, `a11y violations on ${label}: ${violations.join(',')}`);
}

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(dimensions.scrollWidth <= dimensions.clientWidth, `horizontal overflow on ${label}: ${JSON.stringify(dimensions)}`);
}

async function waitForConnected(page) {
  try {
    // The mobile header intentionally hides the status text. The status class
    // is still the authoritative rendered wallet state, so wait for the node
    // rather than its responsive visibility.
    await page.locator('.wallet-status--connected').waitFor({ state: 'attached' });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      status: document.querySelector('.wallet-status')?.textContent,
      calls: window.__walletCalls,
      body: document.body.innerText.slice(0, 500),
    }));
    throw new Error(`WALLET_CONNECT_TIMEOUT:${JSON.stringify(diagnostics)}:${error.message}`);
  }
}

async function runFacilityAndCurator(browser, baseUrl) {
  const { context, page } = await createFixtureContext(browser, baseUrl, { chainId: '0x1' });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${baseUrl}/facility`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Fund the facility precisely.' }).waitFor();
    await page.locator('.wallet-status--wrong-chain').waitFor();
    await page.locator('#deposit-amount').fill('1.234567');
    assert(await page.getByTestId('deposit-submit').isDisabled(), 'wrong-chain deposit was enabled');
    assert(await page.getByTestId('withdraw-submit').isDisabled(), 'wrong-chain withdrawal was enabled');
    await page.getByTestId('wrong-chain').getByRole('button', { name: 'Switch to Base' }).click();
    await waitForConnected(page);
    await page.getByTestId('deposit-submit').click();
    await page.getByText('Exact approval and deposit confirmed.', { exact: true }).waitFor();
    const depositTransactions = await page.evaluate(() => window.__walletTransactions);
    const amountWord = EXACT_USDC.toString(16).padStart(64, '0');
    assert(depositTransactions.length === 2, `deposit expected approval + deposit, got ${depositTransactions.length}`);
    assert(depositTransactions[0].data.slice(74, 138) === amountWord, 'approval amount was not exact bigint calldata');
    assert(depositTransactions[1].data.slice(10, 74) === amountWord, 'deposit amount was not exact bigint calldata');

    await page.getByTestId('withdraw-submit').click();
    await page.getByText('Synchronous withdrawal confirmed.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Queue withdrawal', exact: true }).click();
    await page.getByText('Withdrawal queued.', { exact: false }).waitFor();

    // Deposit review remains keyboard operable after the wallet state changes.
    await page.locator('#deposit-amount').focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('0.000001');
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'deposit-submit', 'deposit action is not reachable by keyboard');
    await page.keyboard.press('Enter');
    await page.getByText('Exact approval and deposit confirmed.', { exact: true }).waitFor();

    await assertAccessible(page, 'facility');
    await assertNoOverflow(page, 'facility desktop');
    mkdirSync(join(workspace, 'output'), { recursive: true });
    await page.screenshot({ path: join(workspace, 'output/base-m5-facility-desktop.png'), fullPage: true });

    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/1× · 18 decimals/).waitFor();
    await assertAccessible(page, 'overview');
    assert(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches), 'reduced-motion media preference was not applied');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/curator`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Allocate with explicit policy.' }).waitFor();
    await waitForConnected(page);
    await page.getByRole('button', { name: 'Pause quotes', exact: true }).click();
    await page.getByText('Quotes paused.', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: /global pause/i }).count() === 0, 'guardian/admin pause became a browser write control');
    await assertAccessible(page, 'curator mobile');
    await assertNoOverflow(page, 'curator mobile');
    await page.screenshot({ path: join(workspace, 'output/base-m5-curator-mobile.png'), fullPage: true });
  } finally {
    await context.close();
  }
}

async function runBid(browser, baseUrl) {
  const { context, page, state } = await createFixtureContext(browser, baseUrl, { source: undefined });
  try {
    await page.goto(`${baseUrl}/liquidations`, { waitUntil: 'domcontentloaded' });
    await page.locator('table tbody tr').first().waitFor();
    await waitForConnected(page);
    const tableText = await page.locator('table').innerText();
    assert(tableText.includes('USDC → AAPLx'), 'public RFQ pair missing');
    assert(!tableText.includes('signature') && !tableText.includes(PAYLOAD_HASH), 'private bid or route data crossed the public RFQ table');
    await page.locator('table tbody tr').first().focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('bid-review').waitFor();
    await page.getByTestId('bid-sign').focus();
    await page.keyboard.press('Enter');
    await page.getByText('Signed RFQ-bound bid submitted.', { exact: true }).waitFor();
    state.typedData = await page.evaluate(() => window.__typedData);
    assert(state.postedBid?.order?.maxRepayAssets === EXACT_USDC.toString(10), 'signed bid serialized a non-canonical amount');
    assert(state.postedBid?.order?.minCollateralOut === '100000000000000000000', 'signed bid lost B20 precision');
    assert(typeof state.postedBid?.signature === 'string' && state.postedBid.signature.startsWith('0x'), 'signed bid omitted signature DTO');
    assert(state.typedData?.message?.maxRepayAssets === EXACT_USDC.toString(10), 'EIP-712 typed data did not stringify bigint values');
    await assertAccessible(page, 'liquidation bid');
  } finally {
    await context.close();
  }
}

async function runWinnerRoute(browser, baseUrl, source) {
  const { context, page } = await createFixtureContext(browser, baseUrl, { source });
  try {
    await page.goto(`${baseUrl}/liquidations`, { waitUntil: 'domcontentloaded' });
    await page.locator('table tbody tr').first().waitFor();
    await waitForConnected(page);
    await page.getByRole('button', { name: 'Refresh route availability', exact: true }).click();
    await page.getByTestId('route-review').waitFor();
    const reviewText = await page.getByTestId('route-review').innerText();
    for (const visibleValue of ['100 AAPLx', '110 AAPLx', '4102444800', source, '42']) {
      assert(reviewText.includes(visibleValue), `winner route review omitted ${visibleValue}`);
    }
    assert(!reviewText.includes('0x222222'), 'route review exposed an unrelated private value');
    await page.getByTestId('route-submit').click();
    await page.getByText('Route transaction confirmed.', { exact: true }).waitFor();
    const transactions = await page.evaluate(() => window.__walletTransactions);
    if (source === 'LP') {
      assert(transactions.length === 2, `LP route expected approval + route, got ${transactions.length}`);
      assert(transactions[0].to.toLowerCase() === USDC, 'LP approval did not target USDC');
      assert(transactions[1].to.toLowerCase() === ROUTER, 'LP route was not sent to the router');
    } else {
      assert(transactions.length === 1, `facility route expected one executor transaction, got ${transactions.length}`);
      assert(transactions[0].to.toLowerCase() === ROUTER, 'facility route was not sent to the router');
      assert(!transactions.some((transaction) => transaction.to.toLowerCase() === USDC), 'facility executor incorrectly requested LP approval');
    }
    await assertAccessible(page, `winner route ${source}`);
  } finally {
    await context.close();
  }
}

async function runStockSale(browser, baseUrl) {
  const { context, page, state } = await createFixtureContext(browser, baseUrl);
  try {
    await page.goto(`${baseUrl}/sell`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Sell stock for native USDC.' }).waitFor();
    await waitForConnected(page);
    await page.locator('#sell-stock-amount').fill('1');
    await page.locator('#sell-min-buy').fill('1.234567');
    await page.getByTestId('sell-quote').click();
    await page.getByTestId('stock-sale-review').waitFor();
    const reviewText = await page.getByTestId('stock-sale-review').innerText();
    for (const visibleValue of ['KATON', '1.234567', '42', 'Settlement allowance target']) {
      assert(reviewText.includes(visibleValue), `stock-sale review omitted ${visibleValue}`);
    }
    const requests = state.requests.filter((request) => request.path === '/v1/swaps/quote');
    assert(requests.length === 1, `stock sale expected one authenticated quote request, got ${requests.length}`);
    const preReviewTransactions = await page.evaluate(() => window.__walletTransactions);
    assert(preReviewTransactions.length === 0, `stock sale should not request approval before the seller reviews the quote, got ${preReviewTransactions.length}`);

    await page.getByTestId('sell-submit').click();
    try {
      await page.getByText('Stock sale confirmed. USDC was delivered to the connected wallet.', { exact: true }).waitFor();
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        text: document.body.innerText.slice(-1000),
        calls: window.__walletCalls,
        transactions: window.__walletTransactions,
      }));
      throw new Error(`STOCK_SALE_SUBMIT_FAILED:${JSON.stringify(diagnostics)}:${error.message}`);
    }
    const transactions = await page.evaluate(() => window.__walletTransactions);
    assert(transactions.length === 2, `stock sale expected approval + route after review, got ${transactions.length}`);
    assert(transactions[0].to.toLowerCase() === B20, 'stock approval did not target B20');
    assert(transactions[1].to.toLowerCase() === ROUTER, 'stock sale route was not sent to the router');
    assert(transactions[1].data === '0x1234', 'stock sale submitted calldata other than the returned router transaction');
    await assertAccessible(page, 'stock sale approval, quote review, and route submission');
    mkdirSync(join(workspace, 'output'), { recursive: true });
    await page.screenshot({ path: join(workspace, 'output/base-m5-stock-sale.png'), fullPage: true });
  } finally {
    await context.close();
  }
}

async function runStockSaleUnavailable(browser, baseUrl) {
  const { context, page, state } = await createFixtureContext(browser, baseUrl, { stockSaleStatus: 'NO_ROUTE' });
  try {
    await page.goto(`${baseUrl}/sell`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Sell stock for native USDC.' }).waitFor();
    await waitForConnected(page);
    await page.locator('#sell-stock-amount').fill('1');
    await page.locator('#sell-min-buy').fill('1.234567');
    await page.getByTestId('sell-quote').click();
    await page.getByText('No executable route', { exact: true }).waitFor();
    const bodyText = await page.locator('.state-card--unavailable').innerText();
    assert(bodyText.includes('No provider quote met the minimum output'), 'no-route state omitted why the route is unavailable');
    assert(bodyText.includes('reduce the minimum'), 'no-route state omitted the next useful seller action');
    assert(bodyText.includes('NO_EXECUTABLE_ROUTE'), 'no-route state omitted the provider status');
    assert(state.requests.filter((request) => request.path === '/v1/swaps/quote').length === 1, 'no-route flow did not make one quote request');
    assert((await page.evaluate(() => window.__walletTransactions)).length === 0, 'no-route flow attempted a wallet transaction');
    assert(await page.getByTestId('sell-submit').count() === 0, 'no-route flow exposed a submit action');
    await assertAccessible(page, 'stock sale unavailable route');
  } finally {
    await context.close();
  }
}

async function runPublicEvaluation(browser, baseUrl) {
  const { context, page } = await createFixtureContext(browser, baseUrl);
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByText('Guided evaluation.', { exact: false }).waitFor();
    await page.getByText('No live route established', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Connect wallet' }).count() === 0, 'public evaluation exposed a wallet connection button');
    assert(await page.getByRole('link', { name: 'Facility' }).count() === 0, 'public evaluation exposed non-demo app navigation');
    assert((await page.evaluate(() => window.__walletCalls)).length === 0, 'public evaluation made wallet calls');
    assert((await page.evaluate(() => window.__walletTransactions)).length === 0, 'public evaluation made wallet transactions');

    await page.getByRole('link', { name: 'Walk through Sell stock' }).click();
    await page.getByText('Canonical AAPLc is not currently routable', { exact: true }).waitFor();
    await page.getByText('No approval or sale transaction', { exact: true }).waitFor();
    const receiptLinks = page.locator('a[href*="sepolia.basescan.org/tx/"]');
    assert(await receiptLinks.count() === 2, 'public sell walkthrough should link to both Sepolia receipts');

    await page.getByRole('link', { name: 'Evidence', exact: true }).click();
    await page.getByText('No live AAPLc route established', { exact: true }).waitFor();
    const providerText = await page.locator('.provider-evidence').allInnerTexts();
    assert(providerText.some((value) => value.includes('SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE')), 'public evidence omitted the 0x token eligibility response');
    await page.getByText('CoW', { exact: true }).waitFor();
    await page.getByText('1inch / maker', { exact: true }).waitFor();
    await page.getByText('8 cases passed', { exact: false }).waitFor();
    assert((await page.evaluate(() => window.__walletCalls)).length === 0, 'public evaluation made wallet calls while viewing evidence');
    const evidenceResponse = await page.request.get(`${baseUrl}/base-demo-evidence.json`);
    assert(evidenceResponse.ok(), 'sanitized evidence manifest was not served');
    const evidence = await evidenceResponse.json();
    assert(evidence.liveRoute.decision === 'no-go', 'public evidence manifest omitted the live-route decision');
    assert(evidence.canonical.forkCasesPassed === 8, 'public evidence manifest omitted pinned fork results');
    await assertAccessible(page, 'public evaluation evidence');
  } finally {
    await context.close();
  }
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn('npm', ['run', 'dev:base', '--', '--port', String(port)], {
  cwd: workspace,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await waitForServer(baseUrl);
  browser = await chromium.launch({ headless: process.env.BASE_E2E_HEADED !== 'true' });
  const only = process.env.BASE_E2E_ONLY;
  if (!only || only === 'facility') await runFacilityAndCurator(browser, baseUrl);
  if (!only || only === 'bid') await runBid(browser, baseUrl);
  if (!only || only === 'stock') {
    await runStockSale(browser, baseUrl);
    await runStockSaleUnavailable(browser, baseUrl);
  }
  if (only === 'demo') await runPublicEvaluation(browser, baseUrl);
  if (!only || only === 'winner') {
    await runWinnerRoute(browser, baseUrl, 'LP');
    await runWinnerRoute(browser, baseUrl, 'FACILITY');
  }
  console.log(only
    ? `Base injected-provider (non-extension evidence) E2E passed: ${only}`
    : 'Base injected-provider (non-extension evidence) E2E passed: E2E-INJ-1 depositor, E2E-INJ-2 curator, E2E-INJ-3 LP bid, E2E-INJ-4 stock-sale approval/quote/review/router-only submission, E2E-INJ-5 winner route, axe, keyboard, responsive, reduced-motion, and exact-multiplier evidence');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
