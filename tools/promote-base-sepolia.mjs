import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertNonstandardQaWallet,
  deriveBaseQaAccounts,
  parseEnvContents,
  validateBaseQaSecrets,
} from './base-qa-lib.mjs';
import {
  parseReleasePathArg,
  promoteReleaseCandidate,
} from './base-release-gate-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  await main();
} catch (error) {
  console.error(`base-promote-sepolia=FAIL reason=${stableReason(error)}`);
  process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const environment = await readEnvironment();
  const secrets = validateBaseQaSecrets(environment);
  const accounts = deriveBaseQaAccounts(secrets.mnemonic);
  assertNonstandardQaWallet(accounts);
  const expectedAccounts = Object.fromEntries(accounts.map((entry) => [entry.role, entry.address]));
  const result = await promoteReleaseCandidate({
    rootDir,
    candidatePath: parseReleasePathArg(argv, '--candidate'),
    smokeProofPath: parseReleasePathArg(argv, '--smoke-proof'),
    depositProofPath: parseReleasePathArg(argv, '--deposit-proof'),
    swapProofPath: parseReleasePathArg(argv, '--swap-proof'),
    expectedAccounts,
  });
  console.log(`base-promote-sepolia=PASS chainId=${result.chainId} candidateSha256=${result.candidateSha256} manifest=${path.relative(rootDir, result.publicManifestPath)}`);
}

async function readEnvironment() {
  let fileEnvironment = {};
  try {
    fileEnvironment = parseEnvContents(await fs.readFile(path.join(rootDir, '.env.base-qa.local'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...fileEnvironment, ...process.env };
}

function stableReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^BASE_[A-Z0-9_:-]+$/u.test(message)) return message;
  if (message.startsWith('BASE_QA_')) return message.split(':', 1)[0];
  return 'BASE_QA_PROMOTION';
}
