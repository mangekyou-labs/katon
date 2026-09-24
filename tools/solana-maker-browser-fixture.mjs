import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';

const port = 4187;
const baseUrl = `http://127.0.0.1:${port}`;
const keypair = Keypair.generate();
const seed = keypair.secretKey.slice(0, 32);
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]).toString('base64');
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--config', 'apps/solana-web/vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(),
  stdio: 'ignore',
});

let browser;
try {
  await Promise.race([
    (async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          const response = await fetch(baseUrl);
          if (response.ok) return;
        } catch {}
        await delay(100);
      }
      throw new Error('Vite did not become ready for the Maker browser fixture');
    })(),
    once(server, 'exit').then(([code]) => { throw new Error(`Vite exited before startup (${code})`); }),
  ]);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const walletAddress = keypair.publicKey.toBase58();
  let makerEnabled = true;
  const challengeMessage = 'fixture challenge for provisioned maker-7';
  const receipt = {
    tradeId: 'fill-private-21', quoteId: 'maker-quote-21', sourceKind: 'private-maker',
    wallet: 'seller-wallet-private-marker', inputMint: '2gamkL7f7ikNbPAvchzyjFtVVWhLaVTPtjskiCv5i3gW',
    outputMint: 'EPjFWdd5AufqSSqeM2q3d9d6MqfzNehVdJJ7c6g2gr9', inputAmountAtomic: '100000000',
    grossOutputAtomic: '201000000', venueFeeAtomic: '1000000', netOutputAtomic: '200000000',
    signature: 'maker-fill-signature-21', commitment: 'confirmed', confirmedAtMs: Date.now(),
    sellerWallet: 'SELLER-WALLET-MUST-NOT-RENDER', transactionBase64: 'TX-BYTES-MUST-NOT-RENDER',
  };

  await page.addInitScript(({ walletAddress, publicKey, privateKeyPkcs8 }) => {
    const chain = 'solana:localnet';
    const account = {
      address: walletAddress,
      publicKey: Uint8Array.from(publicKey),
      chains: [chain],
      features: ['solana:signMessage'],
      label: 'Fixture Maker',
    };
    const listeners = new Set();
    const wallet = {
      version: '1.0.0', name: 'Fixture Maker Wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      chains: [chain], accounts: [],
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
  }, { walletAddress, publicKey: [...keypair.publicKey.toBytes()], privateKeyPkcs8: pkcs8 });

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = async (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/v1/role-sessions/challenge' && method === 'POST') {
      const body = request.postDataJSON();
      assert.deepEqual(body, { publicKey: walletAddress, role: 'maker' });
      return json({ challengeId: 'challenge-maker-21', message: challengeMessage });
    }
    if (url.pathname === '/v1/role-sessions' && method === 'POST') {
      const body = request.postDataJSON();
      assert.deepEqual(Object.keys(body).sort(), ['challengeId', 'publicKey', 'role', 'signature']);
      assert.equal(body.challengeId, 'challenge-maker-21');
      assert.equal(body.publicKey, walletAddress);
      assert.equal(body.role, 'maker');
      assert.match(body.signature, /^[A-Za-z0-9_-]{86}$/);
      return json({ token: 'fixture-short-lived-maker-session' });
    }
    if (url.pathname === '/v1/makers/me' && method === 'GET') {
      assert.equal(request.headers().authorization, 'Bearer fixture-short-lived-maker-session');
      return json({
        maker: {
          makerId: 'maker-7', enabled: makerEnabled, operatorDisabled: false, availability: makerEnabled ? 'available' : 'unavailable',
          lastSeenAtMs: Date.now(), quotesReceived: 8, quotesRejected: 2,
          capabilities: [{ inputMint: receipt.inputMint, outputMint: receipt.outputMint, minInputAtomic: '1000000', maxInputAtomic: '500000000' }],
        },
        receipts: [receipt],
      });
    }
    if (url.pathname === '/v1/makers/me/disable' && method === 'POST') {
      assert.equal(request.headers().authorization, 'Bearer fixture-short-lived-maker-session');
      makerEnabled = false;
      return json({ ok: true });
    }
    return json({ error: 'unexpected endpoint' }, 404);
  });

  await page.goto(`${baseUrl}/maker`);
  await page.getByRole('heading', { name: /quote with discipline/i }).waitFor();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Authenticate maker' }).click();
  await page.getByText('maker role session active').waitFor();
  await page.getByRole('heading', { name: 'Fill details' }).waitFor();
  await page.getByText('maker-7', { exact: true }).waitFor();
  await page.getByText('8 accepted', { exact: false }).waitFor();
  await page.getByText('2 rejected', { exact: false }).waitFor();
  await page.locator('.maker-receipt summary').click();
  await page.getByText('maker-quote-21', { exact: true }).waitFor();
  await page.getByText('100 stock → 200 USDC').waitFor();
  assert.equal((await page.locator('body').innerText()).includes('SELLER-WALLET-MUST-NOT-RENDER'), false);
  assert.equal((await page.locator('body').innerText()).includes('TX-BYTES-MUST-NOT-RENDER'), false);

  await page.getByRole('button', { name: 'Disable my maker source' }).click();
  await page.getByText(/Disabled · unavailable/).waitFor();
  assert.equal(await page.getByRole('button', { name: /Stop new Quote Sprints/ }).count(), 0);
  console.log('authenticated Maker browser fixture: Wallet Standard challenge, private capabilities/outcomes/fill details, privacy, and self-disable passed');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
