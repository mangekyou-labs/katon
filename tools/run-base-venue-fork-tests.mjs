import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  BASE_FORK_BLOCK,
  BASE_FORK_BLOCK_HASH,
  BASE_MAINNET_CHAIN_HEX,
} from './base-qa-lib.mjs';
import { loadWorktreeEnv } from './load-worktree-env.mjs';

const REQUIRED_CASES = Object.freeze([
  'I-FORK-1',
  'I-FORK-2',
  'I-FORK-3',
  'I-FORK-4A',
  'I-FORK-5',
  'I-FORK-6',
  'I-FORK-7',
  'I-FORK-8',
]);

function redact(value) {
  let safe = String(value ?? '');
  const rpc = process.env.BASE_FORK_RPC?.trim();
  if (rpc) safe = safe.replaceAll(rpc, '[REDACTED]');
  return safe.replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gu, 'https://[REDACTED]@');
}

function runForge({ latest, rpcUrl }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      BASE_FORK_RPC: rpcUrl,
      FOUNDRY_OFFLINE: 'true',
      FOUNDRY_PROFILE: 'fork',
    };
    if (latest) env.BASE_FORK_LATEST = 'true';
    else delete env.BASE_FORK_LATEST;

    const child = spawn(
      'forge',
      [
      'test',
      '--root', 'contracts/base',
      '--match-path', 'test/fork/VenueMainnetFork.t.sol',
      '--offline',
      '-vvv',
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, output }));
  });
}

function inspectForgeOutput(output) {
  const summary = output.match(/Suite result:\s+(?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) skipped/iu);
  if (!summary) throw new Error('BASE_VENUE_FORK_SUMMARY_MISSING');
  const [passed, failed, skipped] = summary.slice(1).map((value) => Number(value));
  if (failed !== 0) throw new Error(`BASE_VENUE_FORK_FAILURES:${failed}`);
  if (skipped !== 0) throw new Error(`BASE_VENUE_FORK_SKIPS:${skipped}`);
  if (passed !== REQUIRED_CASES.length) throw new Error(`BASE_VENUE_FORK_CASE_COUNT:${passed}`);
  const missing = REQUIRED_CASES.filter((id) => {
    const forgeName = id.replaceAll('-', '_');
    return !output.includes(id) && !output.includes(forgeName);
  });
  if (missing.length > 0) throw new Error(`BASE_VENUE_FORK_CASES_MISSING:${missing.join(',')}`);
  return { passed };
}

async function rpcRequest(rpcUrl, method, params = []) {
  let response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch {
    throw new Error('BASE_VENUE_FORK_RPC_UNAVAILABLE');
  }
  if (!response.ok) throw new Error(`BASE_VENUE_FORK_RPC_HTTP:${response.status}`);
  const body = await response.json().catch(() => null);
  if (!body || body.error) throw new Error('BASE_VENUE_FORK_RPC_ERROR');
  return body.result;
}

async function observeFork(rpcUrl, latest) {
  const chainHex = await rpcRequest(rpcUrl, 'eth_chainId');
  if (chainHex?.toLowerCase() !== BASE_MAINNET_CHAIN_HEX) {
    throw new Error(`BASE_VENUE_FORK_CHAIN:${chainHex}`);
  }
  const blockTag = latest ? 'latest' : `0x${BASE_FORK_BLOCK.toString(16)}`;
  const block = await rpcRequest(rpcUrl, 'eth_getBlockByNumber', [blockTag, false]);
  if (!block?.number || !block.hash) throw new Error('BASE_VENUE_FORK_BLOCK_UNAVAILABLE');
  const blockNumber = Number.parseInt(block.number, 16);
  if (!latest) {
    if (blockNumber !== BASE_FORK_BLOCK) throw new Error(`BASE_VENUE_FORK_BLOCK:${blockNumber}`);
    if (block.hash.toLowerCase() !== BASE_FORK_BLOCK_HASH.toLowerCase()) {
      throw new Error('BASE_VENUE_FORK_HASH_MISMATCH');
    }
  }
  return { chainId: Number.parseInt(chainHex, 16), blockNumber, blockHash: block.hash };
}

async function main() {
  loadWorktreeEnv();
  const latest = process.argv.includes('--latest');
  const rpcUrl = process.env.BASE_FORK_RPC?.trim();
  if (!rpcUrl) throw new Error('BASE_FORK_RPC_REQUIRED');
  try {
    const execution = await runForge({ latest, rpcUrl });
    if (execution.exitCode !== 0) {
      process.stderr.write(redact(execution.output));
      throw new Error(`BASE_VENUE_FORK_FORGE_FAILED:${execution.exitCode}`);
    }
    inspectForgeOutput(execution.output);
    const observed = await observeFork(rpcUrl, latest);
    console.log(
      `base-venue-fork=PASS mode=${latest ? 'latest' : 'pinned'} `
      + `cases=${REQUIRED_CASES.join(',')} chainId=${observed.chainId} `
      + `block=${observed.blockNumber} hash=${observed.blockHash}`,
    );
  } catch (error) {
    const output = error?.output;
    if (output) process.stderr.write(redact(output));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(redact(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
