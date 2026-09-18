import path from 'node:path';
import fs from 'node:fs/promises';

import { getAddress } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { resolveCandidateManifestPath } from './base-release-gate-lib.mjs';

export const BASE_QA_TARGETS = Object.freeze(['sepolia', 'anvil']);
export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_MAINNET_CHAIN_HEX = '0x2105';
export const BASE_MAINNET_NATIVE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_FORK_BLOCK = 51_068_301;
export const BASE_FORK_BLOCK_HASH = '0x81ceda4cb39bf70b057c08dc2d70b201b5190ecb8ebb79ccdca3e12b1d73ea41';
const STANDARD_ANVIL_ADDRESSES = new Set([
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
]);

export function parseBaseQaTarget(argv) {
  const equals = argv.find((value) => value.startsWith('--target='));
  const separated = argv.indexOf('--target');
  const target = equals?.slice('--target='.length) ?? (separated >= 0 ? argv[separated + 1] : undefined);
  if (!BASE_QA_TARGETS.includes(target)) {
    throw new Error('BASE_QA_TARGET: use --target=sepolia or --target=anvil');
  }
  return target;
}

export function deriveBaseQaAccounts(mnemonic) {
  const normalized = mnemonic.trim().replace(/\s+/gu, ' ');
  if (![12, 15, 18, 21, 24].includes(normalized.split(' ').length)) throw new Error('BASE_QA_MNEMONIC');
  return ['operator', 'depositor', 'lp'].map((role, addressIndex) => ({
    role,
    addressIndex,
    address: getAddress(mnemonicToAccount(normalized, { addressIndex }).address),
  }));
}

export function assertNonstandardQaWallet(accounts) {
  const matches = accounts.filter((account) => STANDARD_ANVIL_ADDRESSES.has(account.address.toLowerCase()));
  if (matches.length > 0) {
    throw new Error(`BASE_QA_STANDARD_WALLET_FORBIDDEN:${matches.map((account) => account.role).join(',')}`);
  }
}

export function qaPaths(rootDir, target, requestedManifestPath) {
  if (!BASE_QA_TARGETS.includes(target)) throw new Error('BASE_QA_TARGET');
  const prefix = `base-${target}`;
  return {
    profileDir: path.join(rootDir, `.playwright/${prefix}-profile`),
    extensionDir: path.join(rootDir, `.playwright/${prefix}-extension`),
    cliConfigPath: path.join(rootDir, `.playwright/${prefix}-cli.config.json`),
    publicAccountsPath: path.join(rootDir, `.playwright/${prefix}-accounts.json`),
    artifactDir: path.join(rootDir, `output/playwright/${prefix}`),
    manifestPath: target === 'sepolia'
      ? resolveCandidateManifestPath(rootDir, requestedManifestPath)
      : path.join(rootDir, 'output/base-qa/anvil.json'),
  };
}

export function minimumFunding(targetName, role) {
  const oneEth = 10n ** 18n;
  const oneUsdc = 10n ** 6n;
  if (targetName === 'sepolia') {
    if (role === 'operator') return { ethWei: oneEth / 50n, usdcUnits: 0n };
    if (role === 'depositor') return { ethWei: oneEth / 200n, usdcUnits: oneUsdc };
    return { ethWei: oneEth / 500n, usdcUnits: 0n };
  }
  if (role === 'operator') return { ethWei: oneEth / 100n, usdcUnits: 0n };
  if (role === 'depositor') return { ethWei: oneEth / 100n, usdcUnits: 10n * oneUsdc };
  return { ethWei: oneEth / 100n, usdcUnits: 100n * oneUsdc };
}

export function buildFundingReport(balance, required) {
  return {
    ...balance,
    ethDeficitWei: balance.ethWei >= required.ethWei ? 0n : required.ethWei - balance.ethWei,
    usdcDeficitUnits: balance.usdcUnits >= required.usdcUnits ? 0n : required.usdcUnits - balance.usdcUnits,
  };
}

export function sanitizePublicProcessEnv(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => (
    value !== undefined
    && !/(?:MNEMONIC|SEED|PRIVATE(?:_?KEY)?|PASSWORD|WALLET_SECRET)/iu.test(name)
    && !/^BASE_(?:FORK_RPC|FORK_RPC_URL|SEPOLIA_RPC_URL|ANVIL_RPC_URL)$/u.test(name)
  )));
}

export function parseEnvContents(contents) {
  const parsed = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    parsed[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, '$2');
  }
  return parsed;
}

export function mergeBaseQaEnvironments(worktreeEnvironment = {}, qaEnvironment = {}, runtimeEnvironment = {}) {
  const stripWalletMaterial = (environment) => Object.fromEntries(Object.entries(environment).filter(([name, value]) => (
    value !== undefined
    && !/(?:MNEMONIC|SEED|PRIVATE(?:_?KEY)?|PASSWORD|WALLET_SECRET)/iu.test(name)
  )));
  return {
    ...stripWalletMaterial(worktreeEnvironment),
    ...qaEnvironment,
    ...stripWalletMaterial(runtimeEnvironment),
  };
}

export async function loadBaseQaEnvironment(filePath) {
  try {
    return parseEnvContents(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing ignored .env.base-qa.local; see docs/qa-playwright-metamask-base.md.');
    throw error;
  }
}

export function validateBaseQaSecrets(environment) {
  const mnemonic = environment.BASE_QA_MNEMONIC?.trim().replace(/\s+/gu, ' ');
  if (!mnemonic || !validateMnemonic(mnemonic, wordlist)) throw new Error('BASE_QA_MNEMONIC');
  const password = environment.BASE_QA_PASSWORD?.trim();
  if (!password || password.length < 12) throw new Error('BASE_QA_PASSWORD');
  return { mnemonic, password };
}

export function targetQaConfig(target, environment) {
  if (!BASE_QA_TARGETS.includes(target)) throw new Error('BASE_QA_TARGET');
  if (target === 'anvil') {
    const forkRpc = environment.BASE_FORK_RPC?.trim();
    if (!forkRpc) throw new Error('BASE_QA_FORK_RPC_REQUIRED');
    parseHttpUrl(forkRpc, 'BASE_QA_FORK_RPC');
  }
  const rpcUrl = target === 'sepolia'
    ? environment.BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org'
    : environment.BASE_ANVIL_RPC_URL?.trim() || 'http://127.0.0.1:8545';
  const parsedRpc = parseHttpUrl(rpcUrl, 'BASE_QA_RPC_URL');
  if (target === 'anvil' && !isLoopbackHostname(parsedRpc.hostname)) throw new Error('BASE_QA_ANVIL_LOOPBACK');
  const dappUrl = environment.BASE_QA_DAPP_URL?.trim() || 'http://127.0.0.1:5174';
  parseHttpUrl(dappUrl, 'BASE_QA_DAPP_URL');
  return {
    target,
    chainId: target === 'sepolia' ? 84532 : BASE_MAINNET_CHAIN_ID,
    chainHex: target === 'sepolia' ? '0x14a34' : BASE_MAINNET_CHAIN_HEX,
    networkName: target === 'sepolia' ? 'Base Sepolia' : 'Base Mainnet Fork (local)',
    currencySymbol: 'ETH',
    rpcUrl,
    dappUrl,
    apiUrl: environment.BASE_QA_API_URL?.trim() || 'http://127.0.0.1:4010',
    nativeUsdc: getAddress(target === 'sepolia' ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e' : BASE_MAINNET_NATIVE_USDC),
    ...(target === 'anvil' ? {
      network: 'mainnet',
      forkBlock: BASE_FORK_BLOCK,
      forkBlockHash: BASE_FORK_BLOCK_HASH,
      forkQa: true,
    } : { network: 'sepolia', forkQa: false }),
  };
}

export function findWalletSecretLeaks(text, walletSecrets) {
  const leaks = [];
  const normalized = text.toLowerCase();
  for (const [index, secret] of walletSecrets.entries()) {
    if (secret && normalized.includes(secret.toLowerCase())) leaks.push(`wallet-secret:${index}`);
  }
  const labels = [
    ['password', /\bpassword\b/iu],
    ['secret-recovery-phrase', /secret recovery phrase/iu],
    ['mnemonic', /\bmnemonic\b/iu],
    ['private-key', /private[ _-]?key/iu],
  ];
  for (const [name, pattern] of labels) if (pattern.test(text)) leaks.push(`wallet-label:${name}`);
  return leaks;
}

function parseHttpUrl(value, code) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(code);
    return parsed;
  } catch {
    throw new Error(code);
  }
}

function isLoopbackHostname(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname.toLowerCase());
}
