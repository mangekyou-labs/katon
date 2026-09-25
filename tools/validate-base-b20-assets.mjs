// Fail-closed canonical B20 metadata validator.
//
// Reads live Base mainnet state at a pinned block and asserts that every
// registered tokenized stock still reports the pinned symbol, 8 decimals,
// runtime bytecode, and Chainlink reference feed. `--write` materializes the
// tracked fixture; without it the run compares against the fixture and exits
// non-zero on any mismatch.
//
// Usage: node --import tsx tools/validate-base-b20-assets.mjs [--write] [--block=<number>]
import fs from 'node:fs/promises';
import path from 'node:path';

import { createHash } from 'node:crypto';
import { createPublicClient, http, keccak256 } from 'viem';

import {
  B20_ASSETS_BY_ADDRESS,
  B20_CANONICAL_PIN,
  B20_STOCK_DECIMALS,
  assertCanonicalAssetMetadata,
} from '../packages/base-core/src/assets.ts';
import { getBaseNetworkConfig } from '../packages/base-core/src/network.ts';
import { findWorktreeRoot, loadWorktreeEnv } from './load-worktree-env.mjs';

const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
];

const AGGREGATOR_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
];

const BACKTEST_TOLERANCE_SECONDS = 86_400;

function parseArgs(argv) {
  const write = argv.includes('--write');
  const blockArg = argv.find((value) => value.startsWith('--block='));
  const block = blockArg ? BigInt(blockArg.slice('--block='.length)) : B20_CANONICAL_PIN.block;
  if (block <= 0n) throw new Error('B20_VALIDATE_BLOCK');
  return { write, block };
}

function fixturePath(root) {
  return path.join(root, 'fixtures/base/b20-assets-mainnet.json');
}

function evidencePath(root) {
  return path.join(root, 'output/base-qa/evidence/b20-canonical.json');
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function describeFingerprint(fixture) {
  return fingerprint(fixture.assets);
}

async function observe(client, address, block) {
  const [code, symbol, decimals] = await Promise.all([
    client.getBytecode({ address, blockNumber: block }),
    client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol', blockNumber: block }),
    client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals', blockNumber: block }),
  ]);
  if (!code || code === '0x') throw new Error(`B20_CODE_MISSING:${address}`);
  if (symbol !== assetTicker(address)) throw new Error(`B20_SYMBOL_MISMATCH:${address}`);
  if (Number(decimals) !== B20_STOCK_DECIMALS) throw new Error(`B20_DECIMALS_MISMATCH:${address}`);
  return { code, symbol: String(symbol), decimals: Number(decimals) };
}

function assetTicker(address) {
  const asset = B20_ASSETS_BY_ADDRESS[address];
  if (!asset) throw new Error(`UNKNOWN_B20_ADDRESS:${address}`);
  return asset.ticker;
}

async function observeFeed(client, feed, block) {
  const [code, decimals, round] = await Promise.all([
    client.getBytecode({ address: feed, blockNumber: block }),
    client.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: 'decimals', blockNumber: block }),
    client.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: 'latestRoundData', blockNumber: block }),
  ]);
  if (!code || code === '0x') throw new Error(`B20_FEED_CODE_MISSING:${feed}`);
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  if (Number(decimals) !== 8) throw new Error(`B20_FEED_DECIMALS:${feed}`);
  if (answer <= 0n || roundId === 0n || answeredInRound === 0n) throw new Error(`B20_FEED_ANSWER:${feed}`);
  return {
    answer: answer.toString(10),
    updatedAt: Number(updatedAt),
    roundId: roundId.toString(10),
    decimals: Number(decimals),
  };
}

async function main() {
  const { write, block } = parseArgs(process.argv.slice(2));
  loadWorktreeEnv();
  const root = findWorktreeRoot();
  const rpcUrl = (process.env.BASE_FORK_RPC ?? process.env.KATON_BASE_RPC_URL ?? '').trim();
  if (!rpcUrl) throw new Error('BASE_FORK_RPC_REQUIRED');
  const networkConfig = getBaseNetworkConfig('mainnet');
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 30_000 }) });

  const pinBlock = await client.getBlock({ blockNumber: block });
  const assets = [];
  for (const [address, asset] of Object.entries(B20_ASSETS_BY_ADDRESS)) {
    const [observed, feed] = await Promise.all([observe(client, address, block), observeFeed(client, asset.feed, block)]);
    assertCanonicalAssetMetadata({
      address,
      symbol: observed.symbol,
      decimals: observed.decimals,
      feed: asset.feed,
      hasCode: true,
      feedHasCode: true,
    });
    if (observed.symbol !== asset.ticker) throw new Error(`B20_SYMBOL_MISMATCH:${address}`);
    assets.push({
      address,
      ticker: asset.ticker,
      decimals: observed.decimals,
      feed: asset.feed,
      feedDecimals: feed.decimals,
      runtimeBytecodeHash: keccak256(observed.code),
      latestAnswer: feed.answer,
      latestAnswerUpdatedAt: feed.updatedAt,
    });
  }
  assets.sort((left, right) => left.ticker.localeCompare(right.ticker));

  const fixture = {
    schema: 'katon.base.b20-canonical/v1',
    network: 'mainnet',
    chainId: networkConfig.chainId,
    block: Number(block),
    blockHash: pinBlock.hash,
    pinnedAt: B20_CANONICAL_PIN.verifiedAt,
    stockDecimals: B20_STOCK_DECIMALS,
    assetCount: assets.length,
    assets,
  };
  fixture.digest = describeFingerprint(fixture);

  const target = fixturePath(root);
  if (write) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`);
  } else {
    const recorded = JSON.parse(await fs.readFile(target, 'utf8'));
    if (recorded.blockHash !== fixture.blockHash || recorded.block !== fixture.block) {
      throw new Error(`B20_PIN_UNAVAILABLE:${fixture.block} expected block ${recorded.block}`);
    }
    if (describeFingerprint(recorded) !== fixture.digest) {
      throw new Error('B20_FIXTURE_DRIFT');
    }
  }

  const evidence = {
    schema: 'katon.base.b20-canonical-evidence/v1',
    verifiedAt: new Date().toISOString(),
    network: fixture.network,
    chainId: fixture.chainId,
    block: fixture.block,
    blockHash: fixture.blockHash,
    digest: fixture.digest,
    assetCount: fixture.assetCount,
    assets: fixture.assets,
    responseHash: fingerprint(fixture.assets),
  };
  const evidenceTarget = evidencePath(root);
  await fs.mkdir(path.dirname(evidenceTarget), { recursive: true });
  await fs.writeFile(evidenceTarget, `${JSON.stringify(evidence, null, 2)}\n`);

  const stale = assets.filter((asset) => pinBlock.timestamp - BigInt(asset.latestAnswerUpdatedAt) > BigInt(BACKTEST_TOLERANCE_SECONDS));
  process.stdout.write(
    `base-b20-canonical=${write ? 'WRITTEN' : 'PASS'} assets=${assets.length} block=${fixture.block} hash=${fixture.blockHash} digest=${fixture.digest}\n`,
  );
  process.stdout.write(`base-b20-stale-feeds=${stale.length} evidence=${path.relative(root, evidenceTarget)}\n`);
}

main().catch((error) => {
  process.stderr.write(`base-b20-canonical=FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
