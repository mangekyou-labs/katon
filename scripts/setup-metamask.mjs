import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bootstrap, MetaMaskWallet } from '@tenkeylabs/dappwright';
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = path.join(rootDir, '.playwright', 'metamask-local');
const extensionDir = path.join(rootDir, '.playwright', 'metamask-extension');
const cliConfigPath = path.join(rootDir, '.playwright', 'cli.config.json');
const workerIndex = process.env.TEST_WORKER_INDEX ?? '0';
const dappwrightProfileDir = path.join(os.tmpdir(), 'dappwright', 'session', 'metamask', workerIndex);
const envPath = path.join(rootDir, '.env');
const qaAccountsPath = path.join(rootDir, '.playwright', 'qa-accounts.json');

function loadDotEnv() {
  return fs.readFile(envPath, 'utf8')
    .then(contents => {
      for (const line of contents.split(/\r?\n/u)) {
        const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
        if (!match || match[1] in process.env) continue;
        const value = match[2].replace(/^(['"])(.*)\1$/u, '$2');
        process.env[match[1]] = value;
      }
    })
    .catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and set disposable local QA values.`);
  return value;
}

function validateConfig() {
  const password = required('METAMASK_PASSWORD');
  if (password.length < 8) throw new Error('METAMASK_PASSWORD must be at least 8 characters.');

  const seedPhrase = required('METAMASK_SEED_PHRASE').replace(/\s+/gu, ' ');
  const wordCount = seedPhrase.split(' ').length;
  if (![12, 15, 18, 21, 24].includes(wordCount) || !validateMnemonic(seedPhrase, wordlist)) {
    throw new Error('METAMASK_SEED_PHRASE must be a valid BIP-39 English mnemonic (12, 15, 18, 21, or 24 words).');
  }

  const rpcUrl = required('FLARE_RPC_URL');
  try {
    const parsed = new URL(rpcUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error('FLARE_RPC_URL must be an http:// or https:// URL.');
  }

  const chainId = Number(required('FLARE_CHAIN_ID'));
  if (chainId !== 114) throw new Error('FLARE_CHAIN_ID must be Coston2 (114) for the FCC acceptance profile.');

  const networkName = required('FLARE_NETWORK_NAME');
  const symbol = required('FLARE_CURRENCY_SYMBOL');
  const dappUrl = required('DAPP_URL');
  try {
    const parsed = new URL(dappUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error('DAPP_URL must be an http:// or https:// URL.');
  }

  return { password, seedPhrase, rpcUrl, chainId, networkName, symbol, dappUrl };
}

function deriveQaAccounts(seedPhrase) {
  return [
    ['seller', 0],
    ['lp-a', 1],
    ['lp-b', 2]
  ].map(([role, index]) => ({
    role,
    index,
    address: mnemonicToAccount(seedPhrase, { addressIndex: index }).address
  }));
}

async function preflightQaBalances(rpcUrl, accounts) {
  const balances = await Promise.all(accounts.map(async account => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: account.index + 1,
        method: 'eth_getBalance',
        params: [account.address, 'latest']
      })
    });
    if (!response.ok) throw new Error(`Coston2 balance preflight failed for ${account.role} (HTTP ${response.status}).`);
    const result = await response.json();
    if (result.error || typeof result.result !== 'string' || !/^0x[0-9a-f]+$/iu.test(result.result)) {
      throw new Error(`Coston2 balance preflight failed for ${account.role}.`);
    }
    return { ...account, balanceWei: result.result };
  }));
  return { chainId: 114, accounts: balances };
}

async function ensureFreshTarget() {
  for (const target of [profileDir, extensionDir]) {
    try {
      await fs.access(target);
      throw new Error(`${target} already exists. Run npm run qa:wallet:cleanup before reinitializing it.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function removeBrowserLocks(directory) {
  for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort']) {
    await fs.rm(path.join(directory, name), { force: true });
  }
}

async function persistProfile() {
  await fs.mkdir(path.dirname(profileDir), { recursive: true });
  await fs.cp(dappwrightProfileDir, profileDir, { recursive: true });
  await removeBrowserLocks(profileDir);
}

async function writeCliConfig(executablePath) {
  const config = {
    browser: {
      browserName: 'chromium',
      userDataDir: '.playwright/metamask-local',
      launchOptions: {
        headless: false,
        executablePath,
        args: [
          '--disable-extensions-except=.playwright/metamask-extension',
          '--load-extension=.playwright/metamask-extension'
        ]
      }
    },
    outputDir: 'output/playwright',
    outputMode: 'file'
  };
  await fs.mkdir(path.dirname(cliConfigPath), { recursive: true });
  await fs.writeFile(cliConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function main() {
  await loadDotEnv();
  const config = validateConfig();
  const qaAccounts = deriveQaAccounts(config.seedPhrase);
  const qaBalances = await preflightQaBalances(config.rpcUrl, qaAccounts);

  if (process.argv.includes('--validate-only')) {
    const funded = qaBalances.accounts.filter(account => BigInt(account.balanceWei) > 0n).length;
    console.log(`MetaMask QA configuration is valid for Coston2; preflighted 3 accounts (${funded}/3 funded).`);
    return;
  }

  await ensureFreshTarget();
  const version = MetaMaskWallet.recommendedVersion;
  const downloadOptions = { wallet: 'metamask', version, headless: false };
  let browserContext;

  try {
    const extensionPath = await MetaMaskWallet.download(downloadOptions);
    const [wallet, , context] = await bootstrap('chromium', {
      ...downloadOptions,
      seed: config.seedPhrase,
      password: config.password,
      showTestNets: true
    });
    browserContext = context;

    await wallet.addNetwork({
      networkName: config.networkName,
      rpc: config.rpcUrl,
      chainId: config.chainId,
      symbol: config.symbol
    });

    // dAppwright's MetaMask action derives the next HD accounts from the
    // imported seed; account labels stay in the browser profile only.
    await wallet.createAccount();
    await wallet.createAccount();

    const dappPage = await context.newPage();
    await dappPage.goto(config.dappUrl, { waitUntil: 'domcontentloaded' });
    await dappPage.waitForFunction(() => typeof window.ethereum !== 'undefined', undefined, { timeout: 15000 });
    const provider = await dappPage.evaluate(async () => ({
      hasEthereum: typeof window.ethereum !== 'undefined',
      chainId: window.ethereum?.chainId ?? null
    }));
    const expectedChainId = `0x${config.chainId.toString(16)}`;
    if (!provider.hasEthereum) throw new Error('MetaMask provider was not detected by DAPP_URL.');
    if (provider.chainId?.toLowerCase() !== expectedChainId) {
      throw new Error(`MetaMask provider reported ${provider.chainId ?? 'no chain'}, expected ${expectedChainId}.`);
    }

    await browserContext.close();
    browserContext = undefined;
    await fs.cp(extensionPath, extensionDir, { recursive: true });
    await persistProfile();
    await fs.mkdir(path.dirname(qaAccountsPath), { recursive: true });
    await fs.writeFile(qaAccountsPath, `${JSON.stringify(qaBalances, null, 2)}\n`);
    await writeCliConfig(chromium.executablePath());

    console.log(`MetaMask ${version} initialized for ${config.networkName} (${expectedChainId}).`);
    console.log(`Provider detected at ${config.dappUrl}.`);
    console.log(`Persistent profile: ${path.relative(rootDir, profileDir)}`);
    console.log('Run the CLI with: npm run qa:cli -- --config .playwright/cli.config.json open "$DAPP_URL" --headed');
  } finally {
    if (browserContext) await browserContext.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(`MetaMask QA setup failed: ${error.message}`);
  process.exitCode = 1;
});
