import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { bootstrap, MetaMaskWallet } from '@tenkeylabs/dappwright';
import { chromium } from 'playwright';
import { createPublicClient, erc20Abi, formatEther, formatUnits, http } from 'viem';

import {
  BASE_FORK_BLOCK,
  BASE_FORK_BLOCK_HASH,
  assertNonstandardQaWallet,
  buildFundingReport,
  deriveBaseQaAccounts,
  findWalletSecretLeaks,
  loadBaseQaEnvironment,
  mergeBaseQaEnvironments,
  minimumFunding,
  parseBaseQaTarget,
  parseEnvContents,
  qaPaths,
  targetQaConfig,
  validateBaseQaSecrets,
} from './base-qa-lib.mjs';
import { createNextSrPChild, selectRoleAccount, switchBaseQaNetwork } from './base-wallet-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretPath = path.join(rootDir, '.env.base-qa.local');
const command = process.argv[2];
const target = parseBaseQaTarget(process.argv.slice(3));
const paths = qaPaths(rootDir, target);

async function loadFixedEnvironment() {
  let worktreeEnvironment = {};
  try {
    worktreeEnvironment = parseEnvContents(await fs.readFile(path.join(rootDir, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return mergeBaseQaEnvironments(worktreeEnvironment, await loadBaseQaEnvironment(secretPath), process.env);
}

async function inspectTarget(environment) {
  const secrets = validateBaseQaSecrets(environment);
  const config = targetQaConfig(target, environment);
  const accounts = deriveBaseQaAccounts(secrets.mnemonic);
  assertNonstandardQaWallet(accounts);
  const chain = { id: config.chainId, name: config.networkName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } };
  const client = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  const chainId = await client.getChainId().catch(() => { throw new Error('BASE_QA_RPC_UNAVAILABLE'); });
  if (chainId !== config.chainId) throw new Error(`BASE_QA_CHAIN_ID: expected ${config.chainId}, received ${chainId}`);
  if (target === 'anvil') {
    const version = await client.request({ method: 'web3_clientVersion' }).catch(() => '');
    if (!String(version).toLowerCase().includes('anvil')) throw new Error('BASE_QA_ANVIL_REQUIRED');
    const block = await client.getBlock({ blockNumber: BigInt(BASE_FORK_BLOCK) }).catch(() => null);
    if (
      !block
      || block.number !== BigInt(BASE_FORK_BLOCK)
      || block.hash?.toLowerCase() !== BASE_FORK_BLOCK_HASH.toLowerCase()
    ) throw new Error('BASE_QA_FORK_PIN_MISMATCH');
  }
  const usdcCode = await client.getCode({ address: config.nativeUsdc });
  const funding = [];
  for (const account of accounts) {
    const ethWei = await client.getBalance({ address: account.address });
    const usdcUnits = usdcCode && usdcCode !== '0x'
      ? await client.readContract({ address: config.nativeUsdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }).catch(() => 0n)
      : 0n;
    funding.push(buildFundingReport({ ...account, ethWei, usdcUnits }, minimumFunding(target, account.role)));
  }
  return { secrets, config, accounts, funding, usdcCodePresent: Boolean(usdcCode && usdcCode !== '0x') };
}

function printFunding(state) {
  console.log(`base-qa target=${target} chainId=${state.config.chainId} chainHex=${state.config.chainHex} nativeUsdc=${state.config.nativeUsdc}`);
  for (const account of state.funding) {
    console.log([
      `role=${account.role}`,
      `address=${account.address}`,
      `eth=${formatEther(account.ethWei)}`,
      `ethDeficitWei=${account.ethDeficitWei}`,
      `usdc=${formatUnits(account.usdcUnits, 6)}`,
      `usdcDeficitUnits=${account.usdcDeficitUnits}`,
    ].join(' '));
  }
  if (!state.usdcCodePresent) console.log(`base-qa nativeUsdcCode=missing target=${target}; run the Anvil deployment before wallet funding validation.`);
}

async function validate() {
  const environment = await loadFixedEnvironment();
  const state = await inspectTarget(environment);
  printFunding(state);
  const scan = await scanArtifacts(state.secrets);
  console.log(`base-qa-validate=PASS target=${target} artifacts=${scan.files}`);
}

async function setup() {
  const environment = await loadFixedEnvironment();
  const state = await inspectTarget(environment);
  printFunding(state);
  await assertFreshTargets();
  const workerIndex = target === 'sepolia' ? '845320' : '845321';
  process.env.TEST_WORKER_INDEX = workerIndex;
  const tempProfile = path.join(os.tmpdir(), 'dappwright', 'session', 'metamask', workerIndex);
  const version = MetaMaskWallet.recommendedVersion;
  const downloadOptions = { wallet: 'metamask', version, headless: false };
  let context;
  try {
    const extensionPath = await MetaMaskWallet.download(downloadOptions);
    const [wallet, , browserContext] = await bootstrap('chromium', {
      ...downloadOptions,
      seed: state.secrets.mnemonic,
      password: state.secrets.password,
      showTestNets: true,
    });
    context = browserContext;
    if (target === 'anvil') {
      // MetaMask reserves chain 8453 for its built-in Base network. Point that
      // existing network at the loopback fork instead of attempting to add a
      // conflicting custom chain, which MetaMask rejects before the dApp can
      // be exercised.
      await wallet.updateNetworkRpc({ chainId: state.config.chainId, rpc: state.config.rpcUrl });
    } else {
      await wallet.addNetwork({
        networkName: state.config.networkName,
        rpc: state.config.rpcUrl,
        chainId: state.config.chainId,
        symbol: state.config.currencySymbol,
      });
    }
    await createNextSrPChild(wallet.page, 'Depositor');
    await createNextSrPChild(wallet.page, 'LP');
    await selectRoleAccount(wallet.page, target === 'sepolia' ? 'depositor' : 'lp');
    await switchBaseQaNetwork(wallet.page, target === 'anvil' ? 'Base' : state.config.networkName);
    const dapp = await context.newPage();
    await dapp.goto(state.config.dappUrl, { waitUntil: 'domcontentloaded' });
    await dapp.getByRole('main', { name: 'Katon Base tokenized-stock desk' }).waitFor({ state: 'visible' });
    await context.close();
    context = undefined;
    await fs.mkdir(path.dirname(paths.profileDir), { recursive: true });
    await fs.cp(extensionPath, paths.extensionDir, { recursive: true });
    await fs.cp(tempProfile, paths.profileDir, { recursive: true });
    await removeBrowserLocks(paths.profileDir);
    await fs.mkdir(paths.artifactDir, { recursive: true });
    await fs.writeFile(paths.publicAccountsPath, `${JSON.stringify(publicState(state), null, 2)}\n`);
    await fs.writeFile(paths.cliConfigPath, `${JSON.stringify(cliConfig(), null, 2)}\n`);
    console.log(`base-qa-setup=PASS target=${target} metamask=${version} profile=${path.relative(rootDir, paths.profileDir)}`);
    console.log(`npm run qa:cli -- --config ${path.relative(rootDir, paths.cliConfigPath)} -s=base-${target} open ${state.config.dappUrl} --headed`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

function publicState(state) {
  return {
    target,
    chainId: state.config.chainId,
    nativeUsdc: state.config.nativeUsdc,
    accounts: state.funding.map((account) => ({
      role: account.role,
      addressIndex: account.addressIndex,
      address: account.address,
      ethWei: account.ethWei.toString(10),
      usdcUnits: account.usdcUnits.toString(10),
      ethDeficitWei: account.ethDeficitWei.toString(10),
      usdcDeficitUnits: account.usdcDeficitUnits.toString(10),
    })),
  };
}

function cliConfig() {
  return {
    browser: {
      browserName: 'chromium',
      userDataDir: path.relative(rootDir, paths.profileDir),
      launchOptions: {
        headless: false,
        executablePath: chromium.executablePath(),
        args: [
          `--disable-extensions-except=${path.relative(rootDir, paths.extensionDir)}`,
          `--load-extension=${path.relative(rootDir, paths.extensionDir)}`,
        ],
      },
    },
    outputDir: path.relative(rootDir, paths.artifactDir),
    outputMode: 'file',
  };
}

async function assertFreshTargets() {
  for (const candidate of [paths.profileDir, paths.extensionDir, paths.cliConfigPath, paths.publicAccountsPath]) {
    try {
      await fs.access(candidate);
      throw new Error(`BASE_QA_PROFILE_EXISTS:${path.relative(rootDir, candidate)}; run qa:base:cleanup first`);
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

async function scanArtifacts(secrets) {
  const files = await textFiles(paths.artifactDir);
  const secretCandidates = [secrets.mnemonic, secrets.password];
  const leaks = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    for (const leak of findWalletSecretLeaks(text, secretCandidates)) leaks.push(`${path.relative(rootDir, file)}:${leak}`);
  }
  if (leaks.length > 0) throw new Error(`BASE_QA_ARTIFACT_SECRET:${leaks.join(',')}`);
  return { files: files.length };
}

async function textFiles(directory) {
  const found = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await textFiles(fullPath));
    else if (/\.(?:json|log|md|txt|ya?ml)$/iu.test(entry.name)) found.push(fullPath);
  }
  return found;
}

async function cleanup() {
  for (const candidate of [paths.profileDir, paths.extensionDir, paths.cliConfigPath, paths.publicAccountsPath]) {
    const disposableRoot = path.join(rootDir, '.playwright');
    if (!candidate.startsWith(`${disposableRoot}${path.sep}`)) throw new Error(`BASE_QA_UNSAFE_CLEANUP:${candidate}`);
    await fs.rm(candidate, { recursive: true, force: true });
    console.log(`base-qa-cleanup removed=${path.relative(rootDir, candidate)}`);
  }
  console.log(`base-qa-cleanup=PASS target=${target} evidencePreserved=${path.relative(rootDir, paths.artifactDir)}`);
}

try {
  if (command === 'validate') await validate();
  else if (command === 'setup') await setup();
  else if (command === 'cleanup') await cleanup();
  else throw new Error('BASE_QA_COMMAND: use setup, validate, or cleanup');
} catch (error) {
  console.error(`base-qa-${command ?? 'unknown'}=FAIL target=${target} reason=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
