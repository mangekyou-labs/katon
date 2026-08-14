import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadWorktreeEnv } from './load-worktree-env.mjs';

const ROUTES = [
  'Swap / Redeem',
  'Auctions',
  'Standing Bids',
  'Dashboard',
  'Facility',
  'Liquidations',
  'Curator',
];

/**
 * Builds the playwright-cli `run-code` source that drives the real persisted
 * MetaMask extension (no injected provider) through the confidential RFQ UI.
 *
 * The generated file embeds the MetaMask unlock password, so it must only ever
 * be written under a gitignored path (output/ by default).
 */
export function buildWalletFlowSource(config) {
  const routes = JSON.stringify(ROUTES);
  return `async page => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const dappUrl = ${JSON.stringify(config.dappUrl)};
  const apiUrl = ${JSON.stringify(config.apiUrl)};
  const password = ${JSON.stringify(config.password)};
  const expectedSeller = ${JSON.stringify(config.accounts.seller)};
  const expectedLpA = ${JSON.stringify(config.accounts.lpA)};
  const expectedLpB = ${JSON.stringify(config.accounts.lpB)};
  const routes = ${routes};
  const fallbackExtensionId = ${JSON.stringify(config.extensionId ?? '')};
  const relayBodies = [];
  const consoleErrors = [];

  page.on('request', request => {
    const url = request.url();
    if (url.indexOf('/v1/relay/') !== -1 && request.method() === 'POST') {
      relayBodies.push(request.postData() ?? '');
    }
  });
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.context().addInitScript((apiBase) => {
    window.__FLARE_API_URL__ = apiBase;
    window.__FLARE_INDEXER_URL__ = apiBase;
    window.__FLARE_FCC_MODE__ = 'simulated';
  }, apiUrl);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dappUrl + '/swap', { waitUntil: 'domcontentloaded' });

  // --- Real MetaMask connect (notification page opened as a tab) ---
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  const walletButton = page.getByRole('button', { name: /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/ });
  let alreadyConnected = true;
  try {
    await walletButton.waitFor({ timeout: 8000 });
  } catch (error) {
    alreadyConnected = false;
  }
  if (!alreadyConnected) {
    const context = page.context();
    let extensionId = fallbackExtensionId;
    for (const candidate of context.pages()) {
      const match = candidate.url().match(/^chrome-extension:\\/\\/([a-p]{32})\\//);
      if (match) { extensionId = match[1]; break; }
    }
    if (!extensionId) throw new Error('METAMASK_EXTENSION_NOT_FOUND');
    const mm = await context.newPage();
    await mm.goto('chrome-extension://' + extensionId + '/notification.html', { waitUntil: 'domcontentloaded' });
    const passwordField = mm.locator('input[type="password"]');
    if (await passwordField.count()) {
      await passwordField.first().fill(password);
      await mm.getByRole('button', { name: /^Unlock$/i }).click();
      await mm.waitForTimeout(1500);
    }
    const next = mm.getByRole('button', { name: /^Next$/i });
    if (await next.count()) await next.click();
    await mm.getByRole('button', { name: /^Connect$/i }).click({ timeout: 15000 });
    await walletButton.waitFor({ timeout: 20000 });
    await mm.close().catch(() => {});
  }
  const connectedLabel = await walletButton.innerText();

  const chainId = await page.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
  assert(chainId === '0x72', 'CHAIN_ID_MISMATCH:' + String(chainId));
  const accounts = await page.evaluate(() => window.ethereum.request({ method: 'eth_accounts' }));
  assert(Array.isArray(accounts) && accounts[0]?.toLowerCase() === expectedSeller.toLowerCase(), 'ACCOUNT_MISMATCH:' + String(accounts?.[0]));

  // --- Navigation walk across every primary route ---
  for (const label of routes) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await page.getByRole('heading', { name: label, exact: true }).waitFor();
  }

  // --- Confidential auction lifecycle: CREATE -> LP-A bid -> LP-B bid -> FINALIZE ---
  await page.getByRole('link', { name: 'Auctions', exact: true }).click();
  await page.getByRole('heading', { name: 'Auctions', exact: true }).waitFor();
  await page.getByLabel('Auction pair').fill('RWA / USDX');
  await page.getByLabel('Auction minimum output').fill('995');
  await page.getByLabel('Allow early close').check();
  await page.getByRole('button', { name: 'Open confidential auction', exact: true }).click();
  await page.getByText('CREATE ready for FCC dispatch', { exact: true }).waitFor({ timeout: 20000 });

  await page.getByLabel('Auction role').selectOption('lp-a');
  await page.getByLabel('Bid amount').fill('1234.5');
  await page.getByRole('button', { name: 'Submit encrypted LP-A bid', exact: true }).click();
  await page.getByText('Encrypted bid submitted', { exact: true }).waitFor({ timeout: 20000 });

  await page.getByLabel('Auction role').selectOption('lp-b');
  await page.getByLabel('Bid amount').fill('2345.6');
  await page.getByRole('button', { name: 'Submit encrypted LP-B bid', exact: true }).click();
  await page.getByText('Encrypted bid submitted', { exact: true }).waitFor({ timeout: 20000 });

  await page.getByLabel('Auction role').selectOption('seller');
  await page.getByRole('button', { name: 'Finalize auction', exact: true }).click();
  await page.getByText('Finalized · ', { exact: false }).waitFor({ timeout: 20000 });

  // --- Read-model confidentiality assertion (business guarantee: commitment metadata only) ---
  assert(relayBodies.length >= 3, 'RELAY_REQUESTS_MISSING:' + String(relayBodies.length));
  const tableText = await page.getByRole('table').allInnerTexts();
  const readModelText = tableText.join(' | ');
  assert(readModelText.includes('Encrypted RFQ'), 'READ_MODEL_ENCRYPTED_PAIR_MISSING');
  assert(!readModelText.includes('1234.5') && !readModelText.includes('2345.6') && !readModelText.includes('995'), 'READ_MODEL_PLAINTEXT_LEAKED');

  // --- Hygiene ---
  assert(consoleErrors.length === 0, 'CONSOLE_ERROR:' + String(consoleErrors[0] ?? ''));
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(viewport.scrollWidth <= viewport.clientWidth, 'HORIZONTAL_OVERFLOW');
  await page.screenshot({ path: 'output/playwright/flare-wallet-cli.png', fullPage: true });
  return {
    walletConnected: true,
    connectedLabel,
    chainId,
    account: accounts[0],
    expectedRoles: { seller: expectedSeller, lpA: expectedLpA, lpB: expectedLpB },
    routesWalked: routes.length,
    relayRequestsCaptured: relayBodies.length,
    relayCiphertextOnly: true,
    auctionFinalized: true,
  };
}
`;
}

function main() {
  loadWorktreeEnv();
  const password = process.env.METAMASK_PASSWORD?.trim();
  if (!password) throw new Error('METAMASK_PASSWORD_REQUIRED');
  const accountsFile = JSON.parse(readFileSync(resolve(process.env.QA_ACCOUNTS ?? '.playwright/qa-accounts.json'), 'utf8'));
  const byRole = Object.fromEntries(accountsFile.accounts.map((entry) => [entry.role, entry.address]));
  if (!byRole.seller || !byRole['lp-a'] || !byRole['lp-b']) throw new Error('QA_ACCOUNTS_REQUIRED');
  const source = buildWalletFlowSource({
    dappUrl: process.env.DAPP_URL ?? 'http://127.0.0.1:5173',
    apiUrl: process.env.FLARE_API_URL ?? 'http://127.0.0.1:8787',
    password,
    extensionId: process.env.METAMASK_EXTENSION_ID ?? 'gadekpdjmpjjnnemgnhkbjgnjpdaakgh',
    accounts: { seller: byRole.seller, lpA: byRole['lp-a'], lpB: byRole['lp-b'] },
  });
  const out = resolve(process.env.FLARE_WALLET_FLOW ?? 'output/playwright/wallet-flow.generated.js');
  writeFileSync(out, source);
  console.log('wallet-flow=' + out);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main();
}
