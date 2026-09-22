import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';

import {
  loadBaseQaEnvironment,
  mergeBaseQaEnvironments,
  parseBaseQaTarget,
  parseEnvContents,
  qaPaths,
  targetQaConfig,
} from './base-qa-lib.mjs';
import { buildBaseQaSeed, createBaseQaSeedHeaders } from './base-qa-seed-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = parseBaseQaTarget(process.argv.slice(2));
if (target !== 'anvil') throw new Error('BASE_QA_SEED_ANVIL_ONLY');
let worktreeEnvironment = {};
try {
  worktreeEnvironment = parseEnvContents(await fs.readFile(path.join(rootDir, '.env'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const environment = mergeBaseQaEnvironments(
  worktreeEnvironment,
  await loadBaseQaEnvironment(path.join(rootDir, '.env.base-qa.local')),
  process.env,
);
const keeperSecret = environment.BASE_QA_KEEPER_SECRET?.trim();
if (!keeperSecret) throw new Error('BASE_QA_KEEPER_SECRET');
const config = targetQaConfig(target, environment);
const paths = qaPaths(rootDir, target);
const manifest = JSON.parse(await fs.readFile(paths.manifestPath, 'utf8'));
const client = createPublicClient({ transport: http(config.rpcUrl) });
const block = await client.getBlock();
const seed = buildBaseQaSeed(manifest, block.timestamp);
const body = JSON.stringify(seed);
const timestamp = Math.floor(Date.now() / 1_000);
const response = await fetch(new URL('/v1/liquidations', config.apiUrl), {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
    ...createBaseQaSeedHeaders(keeperSecret, timestamp, body),
  },
  body,
});
const text = await response.text();
let result;
try { result = JSON.parse(text); } catch { throw new Error(`BASE_QA_SEED_RESPONSE:${response.status}`); }
if (!response.ok) throw new Error(`BASE_QA_SEED_API:${response.status}:${result?.code ?? 'UNKNOWN'}`);
if (result?.rfqId?.toLowerCase() !== seed.rfqId.toLowerCase() || result.status !== 'open') throw new Error('BASE_QA_SEED_RESULT');
await fs.mkdir(paths.artifactDir, { recursive: true });
await fs.writeFile(path.join(paths.artifactDir, 'seed.json'), `${JSON.stringify({
  artifactLabel: 'ANVIL_MOCK',
  classification: 'BASE_MAINNET_FORK_QA',
  venueEvidence: false,
  forkBlock: manifest.forkBlock,
  forkBlockHash: manifest.forkBlockHash,
  blockNumber: block.number.toString(10),
  request: seed,
  response: result,
}, null, 2)}\n`, { mode: 0o600 });
console.log(`base-qa-seed=PASS target=anvil rfqId=${seed.rfqId} block=${block.number} classification=BASE_MAINNET_FORK_QA venueEvidence=false`);
