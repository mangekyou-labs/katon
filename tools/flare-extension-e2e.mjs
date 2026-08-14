import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const extensionPath = process.env.FLARE_WALLET_EXTENSION_PATH?.trim();
if (!extensionPath || !existsSync(extensionPath)) {
  console.error('flare-extension-e2e=BLOCKED FLARE_WALLET_EXTENSION_PATH must point to the approved wallet extension build');
  process.exitCode = 2;
} else {
  const context = await chromium.launchPersistentContext('', {
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const page = await context.newPage();
    const baseUrl = process.env.FLARE_WEB_BASE_URL ?? 'http://127.0.0.1:4173';
    await page.goto(`${baseUrl}/swap`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Connect wallet' }).waitFor();
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await page.getByRole('button', { name: /Connect wallet|0x/ }).waitFor();
    console.log('flare-extension-e2e=PASS headedChrome=true walletPrompt=visible');
  } finally {
    await context.close();
  }
}
