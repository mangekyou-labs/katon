import { describe, expect, it } from 'vitest';

import { buildWalletFlowSource } from '../tools/write-flare-wallet-flow.mjs';

const config = {
  dappUrl: 'http://127.0.0.1:5173',
  apiUrl: 'http://127.0.0.1:8787',
  password: 'test-password-1234',
  accounts: {
    seller: '0x00000000000000000000000000000000000000aa',
    lpA: '0x00000000000000000000000000000000000000bb',
    lpB: '0x00000000000000000000000000000000000000cc',
  },
};

describe('playwright-cli MetaMask wallet flow generator', () => {
  it('drives the real extension instead of injecting a mock provider', () => {
    const source = buildWalletFlowSource(config);
    expect(source).not.toContain('window.ethereum =');
    expect(source).not.toContain('window.ethereum=');
    expect(source).toContain('Connect wallet');
  });

  it('unlocks MetaMask through the extension notification page and approves the connection', () => {
    const source = buildWalletFlowSource(config);
    expect(source).toContain('chrome-extension://');
    expect(source).toMatch(/type="password"|getByLabel\('Password'\)/);
    expect(source).toContain('test-password-1234');
    expect(source).toMatch(/name: \/\^Connect\$\/i|name: \/\^Next\$\/i/);
  });

  it('asserts the Coston2 chain id and the persisted QA seller account from the real provider', () => {
    const source = buildWalletFlowSource(config);
    expect(source).toContain('eth_chainId');
    expect(source).toContain("'0x72'");
    expect(source).toContain('eth_accounts');
    expect(source).toContain(config.accounts.seller);
  });

  it('walks every primary navigation route and fails on console errors or overflow', () => {
    const source = buildWalletFlowSource(config);
    for (const label of ['Swap / Redeem', 'Auctions', 'Standing Bids', 'Dashboard', 'Facility', 'Liquidations', 'Curator']) {
      expect(source).toContain(label);
    }
    expect(source).toContain('HORIZONTAL_OVERFLOW');
    expect(source).toMatch(/console.*error|CONSOLE_ERROR/);
  });

  it('drives the confidential auction lifecycle across the three QA roles', () => {
    const source = buildWalletFlowSource(config);
    expect(source).toContain('Open confidential auction');
    expect(source).toContain('Submit encrypted LP-A bid');
    expect(source).toContain('Submit encrypted LP-B bid');
    expect(source).toContain('Finalize auction');
    expect(source).toContain('Finalized · ');
  });

  it('asserts ciphertext-only relay payloads for auction create and bids', () => {
    const source = buildWalletFlowSource(config);
    expect(source).toContain('/v1/relay/');
    expect(source).toContain('PLAINTEXT_LEAKED');
  });

  it('asserts the read model hides sensitive RFQ and bid plaintext', () => {
    const source = buildWalletFlowSource(config);
    expect(source).toContain('READ_MODEL_PLAINTEXT_LEAKED');
    expect(source).toContain("'Encrypted RFQ'");
  });

  it('opens the MetaMask notification page as a tab to approve the connection', () => {
    const source = buildWalletFlowSource(config);
    expect(source).toContain('notification.html');
    expect(source).toContain('context.newPage()');
  });

  it('never embeds the dummy transaction hash or the browser-proxy router', () => {
    const source = buildWalletFlowSource(config);
    expect(source).not.toContain(`0x${'d9'.repeat(32)}`);
    expect(source).not.toContain('0x7fa1817951de405a');
  });
});
