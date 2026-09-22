import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  BASE_FORK_BLOCK,
  BASE_FORK_BLOCK_HASH,
  BASE_MAINNET_CHAIN_HEX,
  BASE_MAINNET_NATIVE_USDC,
  parseBaseQaTarget,
  parseEnvContents,
  qaPaths,
  sanitizePublicProcessEnv,
  deriveBaseQaAccounts,
  targetQaConfig,
} from './base-qa-lib.mjs';
import { buildStackEnvironment } from './base-qa-stack-lib.mjs';
import { readCandidateManifest } from './base-release-gate-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = parseBaseQaTarget(process.argv.slice(2));
const environment = await readQaEnvironment();
const config = targetQaConfig(target, environment);
const paths = qaPaths(rootDir, target, environment.BASE_QA_CANDIDATE_MANIFEST);
const children = [];

try {
  if (target === 'anvil') {
    const upstreamRpc = environment.BASE_FORK_RPC.trim();
    await validateUpstreamFork(upstreamRpc);
    const port = new URL(config.rpcUrl).port || '8545';
    children.push(spawnLogged('anvil', [
      '--silent',
      '--fork-url', upstreamRpc,
      '--fork-block-number', String(BASE_FORK_BLOCK),
      '--chain-id', '8453',
      '--host', '127.0.0.1',
      '--port', port,
    ], process.env));
    const observed = await waitForRpc(config.rpcUrl);
    if (observed.chainId !== BASE_MAINNET_CHAIN_HEX || observed.blockNumber !== BASE_FORK_BLOCK || observed.blockHash.toLowerCase() !== BASE_FORK_BLOCK_HASH.toLowerCase()) {
      throw new Error('BASE_QA_FORK_PIN_MISMATCH');
    }
    await fundAnvilQaAccounts(config.rpcUrl, environment.BASE_QA_MNEMONIC);
    const deploymentEnv = sanitizePublicProcessEnv({ ...process.env, ...environment });
    delete deploymentEnv.BASE_QA_KEEPER_SECRET;
    const deployment = spawnSync('npm', ['run', 'deploy:base:anvil'], { cwd: rootDir, env: deploymentEnv, encoding: 'utf8', stdio: 'inherit' });
    if (deployment.status !== 0) throw new Error(`BASE_QA_DEPLOY_FAILED:${deployment.status}`);
  }

  const manifest = target === 'sepolia'
    ? (await readCandidateManifest(rootDir, paths.manifestPath)).manifest
    : JSON.parse(await fs.readFile(paths.manifestPath, 'utf8'));
  const childEnv = buildStackEnvironment({ ...process.env, ...environment }, config, manifest);
  if (target === 'anvil') childEnv.BASE_ANVIL_RPC_URL = config.rpcUrl;
  if (target === 'anvil') {
    const keeperSecret = environment.BASE_QA_KEEPER_SECRET?.trim();
    if (!keeperSecret) throw new Error('BASE_QA_KEEPER_SECRET is required for the authenticated Anvil keeper fixture.');
    childEnv.KATON_BOT_CREDENTIALS = JSON.stringify([{ id: 'base-qa-keeper', secret: keeperSecret, scopes: ['keeper'] }]);
  }
  const dapp = new URL(config.dappUrl);
  children.push(spawnLogged('npm', ['run', 'dev:base', '--', '--port', dapp.port || '5174'], childEnv));
  children.push(spawnLogged('npm', ['run', 'dev:base-api'], childEnv));
  await Promise.all([
    waitForHttp(config.dappUrl),
    // Sepolia deliberately keeps liquidation controls disabled for the
    // LP-only M5 scope, so GET /v1/liquidations returns 403 even when the API
    // is healthy. Use the public nonce endpoint as the readiness probe.
    waitForHttp(new URL('/v1/auth/nonce', config.apiUrl).toString()),
  ]);
  console.log(`base-qa-stack=READY target=${target} dapp=${config.dappUrl} api=${config.apiUrl}`);
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    for (const child of children) child.once('exit', (code) => { if (code && code !== 0) resolve(); });
  });
} finally {
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
}

async function fundAnvilQaAccounts(rpcUrl, mnemonic) {
  const balance = '0x3635C9ADC5DEA00000';
  for (const account of deriveBaseQaAccounts(mnemonic)) {
    await rpcRequest(rpcUrl, 'anvil_setBalance', [account.address, balance]);
  }
}

async function readQaEnvironment() {
  const file = path.join(rootDir, '.env.base-qa.local');
  let worktreeEnvironment = {};
  try { worktreeEnvironment = parseEnvContents(await fs.readFile(path.join(rootDir, '.env'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let qaEnvironment = {};
  try { qaEnvironment = parseEnvContents(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing ignored .env.base-qa.local; see docs/qa-playwright-metamask-base.md.');
    throw error;
  }
  return { ...worktreeEnvironment, ...qaEnvironment, ...process.env };
}

function spawnLogged(command, args, env) {
  const child = spawn(command, args, { cwd: rootDir, env, stdio: 'inherit' });
  child.once('error', (error) => console.error(`base-qa-stack child=${command} error=${error.message}`));
  return child;
}

async function waitForRpc(rpcUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const chainId = await rpcRequest(rpcUrl, 'eth_chainId');
      const blockNumber = Number.parseInt(await rpcRequest(rpcUrl, 'eth_blockNumber'), 16);
      const block = await rpcRequest(rpcUrl, 'eth_getBlockByNumber', [`0x${BASE_FORK_BLOCK.toString(16)}`, false]);
      const clientVersion = await rpcRequest(rpcUrl, 'web3_clientVersion');
      const snapshot = await rpcRequest(rpcUrl, 'evm_snapshot');
      await rpcRequest(rpcUrl, 'anvil_setBalance', ['0x000000000000000000000000000000000000dEaD', '0x1']);
      await rpcRequest(rpcUrl, 'anvil_setCode', ['0x000000000000000000000000000000000000dEaD', '0x00']);
      const reverted = await rpcRequest(rpcUrl, 'evm_revert', [snapshot]);
      if (
        chainId === BASE_MAINNET_CHAIN_HEX
        && Number.isInteger(blockNumber)
        && blockNumber >= BASE_FORK_BLOCK
        && block?.hash
        && clientVersion.toLowerCase().includes('anvil')
        && reverted === true
      ) {
        return {
          chainId,
          blockNumber: Number.parseInt(block.number, 16),
          blockHash: block.hash,
        };
      }
    } catch {
      // Anvil is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('BASE_QA_ANVIL_TIMEOUT');
}

async function validateUpstreamFork(rpcUrl) {
  const chainId = await rpcRequest(rpcUrl, 'eth_chainId').catch(() => { throw new Error('BASE_QA_FORK_RPC_UNAVAILABLE'); });
  if (chainId !== BASE_MAINNET_CHAIN_HEX) throw new Error('BASE_QA_FORK_UPSTREAM_CHAIN');
  const block = await rpcRequest(rpcUrl, 'eth_getBlockByNumber', [`0x${BASE_FORK_BLOCK.toString(16)}`, false]).catch(() => null);
  if (!block || block.number !== `0x${BASE_FORK_BLOCK.toString(16)}` || block.hash?.toLowerCase() !== BASE_FORK_BLOCK_HASH.toLowerCase()) {
    throw new Error('BASE_QA_FORK_UPSTREAM_PIN');
  }
  const code = await rpcRequest(rpcUrl, 'eth_getCode', [BASE_MAINNET_NATIVE_USDC, `0x${BASE_FORK_BLOCK.toString(16)}`]).catch(() => '0x');
  if (!code || code === '0x') throw new Error('BASE_QA_FORK_NATIVE_USDC_CODE');
  const decimals = await rpcRequest(rpcUrl, 'eth_call', [{ to: BASE_MAINNET_NATIVE_USDC, data: '0x313ce567' }, `0x${BASE_FORK_BLOCK.toString(16)}`]).catch(() => '0x');
  if (Number.parseInt(decimals, 16) !== 6) throw new Error('BASE_QA_FORK_NATIVE_USDC_DECIMALS');
}

async function rpcRequest(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`BASE_QA_RPC_HTTP:${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`BASE_QA_RPC:${body.error.code ?? 'ERROR'}`);
  return body.result;
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`BASE_QA_HTTP_TIMEOUT:${url}`);
}
