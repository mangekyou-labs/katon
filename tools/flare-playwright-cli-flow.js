async page => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const account = '0x00000000000000000000000000000000000000aa';
  const transactionHash = `0x${'d9'.repeat(32)}`;

  await page.context().addInitScript(({ injectedAccount, injectedTransactionHash }) => {
    const listeners = new Map();
    window.__FLARE_API_URL__ = 'http://127.0.0.1:8787';
    window.__FLARE_INDEXER_URL__ = 'http://127.0.0.1:8787';
    window.__FLARE_FCC_MODE__ = 'simulated';
    window.__walletTransactions = [];
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [injectedAccount];
        if (method === 'eth_chainId') return '0x72';
        if (method === 'eth_blockNumber') return '0x100';
        if (method === 'eth_getBlockByNumber') return { hash: `0x${'b'.repeat(64)}` };
        if (method === 'eth_sendTransaction') {
          window.__walletTransactions.push(params?.[0]);
          return injectedTransactionHash;
        }
        if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
        throw new Error(`UNEXPECTED_WALLET_METHOD:${method}`);
      },
      on: (event, listener) => listeners.set(event, listener),
      removeListener: (event, listener) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
    };
  }, { injectedAccount: account, injectedTransactionHash: transactionHash });

  let relayRequestBody = '';
  page.on('request', request => {
    if (request.url().endsWith('/v1/relay/auctions') && request.method() === 'POST') {
      relayRequestBody = request.postData() ?? '';
    }
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:5173/swap', { waitUntil: 'domcontentloaded' });
  const connect = page.getByRole('button', { name: 'Connect wallet', exact: true });
  if (await connect.count()) await connect.click();
  await page.getByRole('button', { name: /0x0000…00AA/ }).waitFor();

  await page.getByRole('link', { name: 'Auctions', exact: true }).click();
  await page.getByRole('heading', { name: 'Confidential auctions', exact: true }).waitFor();
  await page.getByLabel('Auction pair').fill('RWA / USDX');
  await page.getByLabel('Auction minimum output').fill('995');
  await page.getByLabel('Allow early close').check();
  await page.getByRole('button', { name: 'Open confidential auction', exact: true }).click();
  await page.getByRole('cell', { name: 'Encrypted RFQ', exact: true }).first().waitFor();
  assert(relayRequestBody.length > 0, 'AUCTION_RELAY_REQUEST_MISSING');
  assert(!relayRequestBody.includes('RWA / USDX') && !relayRequestBody.includes('995'), 'AUCTION_PLAINTEXT_LEAKED');

  await page.getByRole('link', { name: 'Standing Bids', exact: true }).click();
  await page.getByLabel('Standing bid capacity').fill('1');
  await page.getByRole('button', { name: 'Create standing bid', exact: true }).click();
  await page.getByRole('cell', { name: 'RWA / USDX', exact: true }).first().waitFor();

  await page.getByRole('link', { name: 'Facility', exact: true }).click();
  await page.getByLabel('Withdrawal shares').fill('1');
  await page.getByLabel('Withdrawal minimum assets').fill('995');
  await page.getByRole('button', { name: 'Queue withdrawal', exact: true }).click();
  await page.getByText('1 requests', { exact: true }).waitFor();

  await page.getByRole('link', { name: 'Liquidations', exact: true }).click();
  await page.getByLabel('Liquidation venue').fill('verified-venue');
  await page.getByLabel('Liquidation market').fill('verified-market');
  await page.getByLabel('Liquidation position').fill('position-1');
  await page.getByLabel('Maximum repay').fill('100');
  await page.getByLabel('Gross collateral').fill('120');
  await page.getByLabel('Minimum net collateral').fill('119');
  await page.getByRole('button', { name: 'Review atomic route', exact: true }).click();
  await page.getByText('Ready for verified route binding', { exact: true }).waitFor();

  await page.getByRole('link', { name: 'Swap / Redeem', exact: true }).click();
  await page.getByLabel('Amount').fill('1');
  await page.getByLabel('Minimum receive').fill('995');
  await page.getByRole('button', { name: 'Request immediate quote', exact: true }).click();
  await page.getByLabel('Quote review').waitFor();
  await page.getByRole('button', { name: 'Sign and submit', exact: true }).click();
  await page.getByText('Indexed in the read model', { exact: true }).first().waitFor();
  const submitted = await page.evaluate(() => window.__walletTransactions?.[0]);
  assert(submitted?.to?.toLowerCase() === '0x7fa1817951de405a0c466696052cf50eba409333', 'WRONG_ROUTER_SUBMITTED');

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(viewport.scrollWidth <= viewport.clientWidth, 'HORIZONTAL_OVERFLOW');
  await page.screenshot({ path: 'output/playwright/flare-confidential-rfq-cli.png', fullPage: true });
  return {
    auctionCiphertextOnly: true,
    facilityWithdrawalQueued: true,
    liquidationReviewBound: true,
    swapIndexed: true,
    transactionHash,
  };
}
