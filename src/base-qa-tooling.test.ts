import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { createCanonicalHmacHeaders } from '../packages/base-sdk/src/index';

import {
  BASE_QA_TARGETS,
  assertNonstandardQaWallet,
  buildFundingReport,
  deriveBaseQaAccounts,
  findWalletSecretLeaks,
  mergeBaseQaEnvironments,
  loadBaseQaEnvironment,
  parseEnvContents,
  parseBaseQaTarget,
  qaPaths,
  sanitizePublicProcessEnv,
  targetQaConfig,
  validateBaseQaSecrets,
} from '../tools/base-qa-lib.mjs';
import { buildPublicRuntimeConfig, buildStackEnvironment } from '../tools/base-qa-stack-lib.mjs';
import { buildBaseQaSeed, createBaseQaSeedHeaders } from '../tools/base-qa-seed-lib.mjs';
import { BASE_FORK_BLOCK, BASE_FORK_BLOCK_HASH, BASE_MAINNET_CHAIN_ID, BASE_MAINNET_NATIVE_USDC } from '../tools/base-deployment-lib.mjs';
import { candidatePaths } from '../tools/base-release-gate-lib.mjs';

const root = process.cwd();
const mnemonic = 'test test test test test test test test test test test junk';

describe('Base MetaMask operator tooling', () => {
  it('accepts only the isolated Sepolia and Anvil targets', () => {
    expect(BASE_QA_TARGETS).toEqual(['sepolia', 'anvil']);
    expect(parseBaseQaTarget(['--target=sepolia'])).toBe('sepolia');
    expect(parseBaseQaTarget(['--target', 'anvil'])).toBe('anvil');
    expect(() => parseBaseQaTarget(['--target=mainnet'])).toThrow('BASE_QA_TARGET');
    expect(() => parseBaseQaTarget([])).toThrow('BASE_QA_TARGET');
  });

  it('derives only public operator, depositor, and LP data', () => {
    const accounts = deriveBaseQaAccounts(mnemonic);
    expect(accounts.map((account) => account.role)).toEqual(['operator', 'depositor', 'lp']);
    expect(accounts.map((account) => account.address)).toEqual(
      [0, 1, 2].map((addressIndex) => mnemonicToAccount(mnemonic, { addressIndex }).address),
    );
    expect(JSON.stringify(accounts)).not.toMatch(/mnemonic|private|password|secret/i);
  });

  it('rejects the standard Anvil mnemonic addresses for every live QA target', () => {
    expect(() => assertNonstandardQaWallet(deriveBaseQaAccounts(mnemonic))).toThrow(
      'BASE_QA_STANDARD_WALLET_FORBIDDEN',
    );
    expect(() => assertNonstandardQaWallet([
      { role: 'operator', address: '0x0000000000000000000000000000000000000001' },
      { role: 'depositor', address: '0x0000000000000000000000000000000000000002' },
      { role: 'lp', address: '0x0000000000000000000000000000000000000003' },
    ])).not.toThrow();
  });

  it('keeps target profiles and evidence in Base-only ignored roots', () => {
    expect(qaPaths(root, 'sepolia')).toMatchObject({
      profileDir: join(root, '.playwright/base-sepolia-profile'),
      extensionDir: join(root, '.playwright/base-sepolia-extension'),
      cliConfigPath: join(root, '.playwright/base-sepolia-cli.config.json'),
      publicAccountsPath: join(root, '.playwright/base-sepolia-accounts.json'),
      artifactDir: join(root, 'output/playwright/base-sepolia'),
      manifestPath: candidatePaths(root, 'sepolia').manifestPath,
    });
    expect(qaPaths(root, 'anvil').profileDir).toBe(join(root, '.playwright/base-anvil-profile'));
  });

  it('reports exact ETH and six-decimal USDC funding deficits', () => {
    const report = buildFundingReport({
      role: 'depositor',
      address: '0x0000000000000000000000000000000000000001',
      ethWei: 2n,
      usdcUnits: 3n,
    }, { ethWei: 5n, usdcUnits: 11n });
    expect(report).toMatchObject({ ethDeficitWei: 3n, usdcDeficitUnits: 8n });
    expect(buildFundingReport({
      role: 'lp',
      address: '0x0000000000000000000000000000000000000002',
      ethWei: 20n,
      usdcUnits: 30n,
    }, { ethWei: 5n, usdcUnits: 11n })).toMatchObject({ ethDeficitWei: 0n, usdcDeficitUnits: 0n });
  });

  it('removes every wallet credential before launching public processes', () => {
    const clean = sanitizePublicProcessEnv({
      PATH: '/bin',
      BASE_QA_MNEMONIC: mnemonic,
      BASE_QA_PASSWORD: 'not-public',
      DEPLOYER_PRIVATE_KEY: '0x1234',
      API_URL: 'http://127.0.0.1:4010',
    });
    expect(clean).toEqual({ PATH: '/bin', API_URL: 'http://127.0.0.1:4010' });
  });

  it('parses and validates the dedicated ignored secret file shape', () => {
    const parsed = parseEnvContents(`\n# disposable only\nBASE_QA_MNEMONIC="${mnemonic}"\nBASE_QA_PASSWORD='correct horse battery'\nBASE_SEPOLIA_RPC_URL=https://rpc.example\n`);
    expect(parsed).toEqual({
      BASE_QA_MNEMONIC: mnemonic,
      BASE_QA_PASSWORD: 'correct horse battery',
      BASE_SEPOLIA_RPC_URL: 'https://rpc.example',
    });
    expect(validateBaseQaSecrets(parsed)).toMatchObject({ mnemonic, password: 'correct horse battery' });
    expect(() => validateBaseQaSecrets({ BASE_QA_MNEMONIC: mnemonic, BASE_QA_PASSWORD: 'short' })).toThrow('BASE_QA_PASSWORD');
  });

  it('merges the non-wallet worktree environment without duplicating fork credentials', () => {
    expect(mergeBaseQaEnvironments(
      { BASE_FORK_RPC: 'https://pinned.example', BASE_QA_API_URL: 'http://127.0.0.1:4010' },
      { BASE_QA_MNEMONIC: mnemonic, BASE_QA_API_URL: 'http://127.0.0.1:4020' },
      { BASE_QA_API_URL: 'http://127.0.0.1:4030' },
    )).toEqual({
      BASE_FORK_RPC: 'https://pinned.example',
      BASE_QA_MNEMONIC: mnemonic,
      BASE_QA_API_URL: 'http://127.0.0.1:4030',
    });
  });

  it('pins Sepolia and loopback Anvil target configuration', () => {
    expect(targetQaConfig('sepolia', { BASE_SEPOLIA_RPC_URL: 'https://rpc.example' })).toMatchObject({
      chainId: 84532,
      chainHex: '0x14a34',
      rpcUrl: 'https://rpc.example',
      nativeUsdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    });
    expect(() => targetQaConfig('anvil', {})).toThrow('BASE_QA_FORK_RPC_REQUIRED');
    expect(targetQaConfig('anvil', { BASE_FORK_RPC: 'https://rpc.example' })).toMatchObject({
      chainId: BASE_MAINNET_CHAIN_ID,
      chainHex: '0x2105',
      rpcUrl: 'http://127.0.0.1:8545',
      nativeUsdc: BASE_MAINNET_NATIVE_USDC,
      forkBlock: BASE_FORK_BLOCK,
      forkBlockHash: BASE_FORK_BLOCK_HASH,
      network: 'mainnet',
      forkQa: true,
    });
    expect(() => targetQaConfig('anvil', { BASE_FORK_RPC: 'ftp://rpc.example' })).toThrow('BASE_QA_FORK_RPC');
  });

  it('finds exact wallet material and post-onboarding secret labels in textual artifacts', () => {
    expect(findWalletSecretLeaks('safe snapshot with 0x1234', [mnemonic, 'correct horse battery'])).toEqual([]);
    expect(findWalletSecretLeaks(`Password\n${mnemonic}`, [mnemonic, 'correct horse battery'])).toEqual(
      expect.arrayContaining(['wallet-label:password', 'wallet-secret:0']),
    );
  });

  it('registers Base-specific commands without changing the existing wallet commands', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts).toMatchObject({
      'qa:base:setup': 'node tools/base-qa.mjs setup',
      'qa:base:validate': 'node tools/base-qa.mjs validate',
      'qa:base:cleanup': 'node tools/base-qa.mjs cleanup',
      'qa:base:stack': 'node tools/base-qa-stack.mjs',
      'qa:base:deposit': 'node tools/verify-base-sepolia-deposit.mjs',
      'promote:base:sepolia': 'node tools/promote-base-sepolia.mjs',
      'qa:wallet:setup': 'node scripts/setup-metamask.mjs',
      'qa:wallet:cleanup': 'node scripts/cleanup-metamask.mjs',
    });
    expect(existsSync(join(root, 'tools/base-qa-stack.mjs'))).toBe(true);
  });

  it('documents the complete isolated workflow and ignores every Base wallet profile', () => {
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    const guide = readFileSync(join(root, 'docs/qa-playwright-metamask-base.md'), 'utf8');

    expect(gitignore).toContain('.playwright/base-*-profile/');
    expect(gitignore).toContain('.playwright/base-*-extension/');
    for (const requiredText of [
      '.env.base-qa.local',
      'qa:base:validate -- --target=sepolia',
      'deploy:base:sepolia',
      'output/base-qa/sepolia/candidate-manifest.json',
      'smoke:base:sepolia',
      'qa:base:deposit',
      'promote:base:sepolia',
      'qa:base:setup -- --target=sepolia',
      'qa:base:stack -- --target=sepolia',
      'base-sepolia-depositor',
      'base-anvil-lp',
      'VENUE_MANIFEST_UNAVAILABLE',
      'qa:base:cleanup -- --target=sepolia',
      'qa:base:cleanup -- --target=anvil',
      'artifact',
      'recovery',
    ]) {
      expect(guide).toContain(requiredText);
    }
  });

  it('fails closed on the fixed missing Base QA secret file', async () => {
    await expect(loadBaseQaEnvironment(join(root, '.does-not-exist', '.env.base-qa.local')))
      .rejects.toThrow('.env.base-qa.local');
  });

  it('builds API and browser stack configuration exclusively from public manifest data', () => {
    const manifest = {
      chainId: BASE_MAINNET_CHAIN_ID,
      environment: 'anvil',
      nativeUsdc: BASE_MAINNET_NATIVE_USDC,
      forkQa: true,
      forkBlock: BASE_FORK_BLOCK,
      forkBlockHash: BASE_FORK_BLOCK_HASH,
      forkRpcValidated: true,
      addresses: {
        router: '0x0000000000000000000000000000000000000020',
        settlement: '0x0000000000000000000000000000000000000030',
        facility: '0x0000000000000000000000000000000000000040',
        oracleGuard: '0x0000000000000000000000000000000000000050',
        b20Guard: '0x0000000000000000000000000000000000000060',
        mockB20: '0x0000000000000000000000000000000000000080',
      },
      roles: { lp: '0x00000000000000000000000000000000000000a0' },
      adapters: [{
        address: '0x0000000000000000000000000000000000000070',
        marketId: `0x${'b'.repeat(64)}`,
      }],
      b20Assets: {
        '0x0000000000000000000000000000000000000080': { ticker: 'MOCKB20', feed: '0x0000000000000000000000000000000000000090', decimals: 18 },
      },
    };
    expect(buildPublicRuntimeConfig(manifest, 'http://127.0.0.1:4010')).toMatchObject({
      network: 'mainnet',
      chainId: BASE_MAINNET_CHAIN_ID,
      apiUrl: 'http://127.0.0.1:4010',
      routerAddress: manifest.addresses.router,
      adapterAddresses: [manifest.adapters[0].address],
    });
    const child = buildStackEnvironment({
      PATH: '/bin',
      BASE_QA_MNEMONIC: mnemonic,
      BASE_QA_PASSWORD: 'never-forward',
    }, { rpcUrl: 'http://127.0.0.1:8545', apiUrl: 'http://127.0.0.1:4010', chainId: BASE_MAINNET_CHAIN_ID }, manifest);
    expect(child.BASE_QA_MNEMONIC).toBeUndefined();
    expect(child.BASE_QA_PASSWORD).toBeUndefined();
    expect(child.KATON_BASE_ROUTER_ADDRESS).toBe(manifest.addresses.router.toLowerCase());
    expect(JSON.parse(child.VITE_KATON_BASE_CONFIG)).toMatchObject({ nativeUsdc: manifest.nativeUsdc });
    expect(JSON.parse(child.KATON_BASE_QA_FORK_SNAPSHOT)).toMatchObject({
      classification: 'BASE_MAINNET_FORK_QA',
      venueEvidence: false,
      adapter: manifest.adapters[0].address,
      b20: manifest.addresses.mockB20,
    });
  });

  it('builds one deterministic mock-market RFQ and canonical keeper authentication', () => {
    const manifest = {
      environment: 'anvil', chainId: BASE_MAINNET_CHAIN_ID, forkQa: true,
      nativeUsdc: BASE_MAINNET_NATIVE_USDC,
      roles: { operator: '0x0000000000000000000000000000000000000020' },
      addresses: { mockB20: '0x0000000000000000000000000000000000000030' },
      adapters: [{ marketId: `0x${'4'.repeat(64)}` }],
    };
    const seed = buildBaseQaSeed(manifest, 2_000n);
    expect(seed).toMatchObject({
      debtAsset: manifest.nativeUsdc,
      collateralAsset: manifest.addresses.mockB20,
      marketId: manifest.adapters[0].marketId,
      repayAssets: '10000000',
      minCollateralOut: '10000000',
      deadline: '5600',
    });
    expect(buildBaseQaSeed(manifest, 2_001n).rfqId).toBe(seed.rfqId);
    const body = JSON.stringify(seed);
    expect(createBaseQaSeedHeaders('secret', 123, body)).toEqual(
      createCanonicalHmacHeaders('base-qa-keeper', 'secret', 'POST', '/v1/liquidations', 123, body),
    );
  });
});
