import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { validateVenueConformanceManifest } from './release-evidence.mjs';

const EXACT_PASS = /Suite result: ok\. 1 passed; 0 failed; 0 skipped/;
const SOLIDITY_TEST_NAME = /^test[A-Za-z0-9_]+$/;

/** Retain enough RPC provenance for evidence without persisting credentials or API paths. */
export function rpcEvidenceOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('FLARE_RPC_HTTPS_REQUIRED');
  return parsed.origin;
}

/** Validate the evidence plan before any fork execution can be mislabeled. */
export function validateForkPlan(plan) {
  if (!plan || !Array.isArray(plan.cases) || plan.cases.length === 0) {
    throw new Error('FORK_PLAN_INVALID');
  }
  if (!plan.venue || !plan.authoritativeReference) throw new Error('FORK_PLAN_INVALID');
  if (plan.chainId !== 14) throw new Error('FORK_PLAN_CHAIN_ID');
  if (!Number.isSafeInteger(plan.forkBlock) || plan.forkBlock <= 0) {
    throw new Error('FORK_PLAN_BLOCK');
  }
  let authoritativeReference;
  try {
    authoritativeReference = new URL(plan.authoritativeReference);
  } catch {
    throw new Error('FORK_PLAN_REFERENCE_HTTPS');
  }
  if (
    authoritativeReference.protocol !== 'https:'
    || authoritativeReference.username
    || authoritativeReference.password
  ) {
    throw new Error('FORK_PLAN_REFERENCE_HTTPS');
  }

  const caseNames = new Set();
  const testNames = new Set();
  for (const entry of plan.cases) {
    if (!entry?.name || !entry?.testName) throw new Error('FORK_PLAN_CASE_INVALID');
    if (!SOLIDITY_TEST_NAME.test(entry.testName)) throw new Error('FORK_PLAN_TEST_NAME_INVALID');
    if (caseNames.has(entry.name)) throw new Error(`FORK_PLAN_CASE_DUPLICATE:${entry.name}`);
    if (testNames.has(entry.testName)) throw new Error(`FORK_PLAN_TEST_DUPLICATE:${entry.testName}`);
    caseNames.add(entry.name);
    testNames.add(entry.testName);
  }
  const conformanceErrors = validateVenueConformanceManifest({
    venue: plan.venue,
    chainId: plan.chainId,
    forkBlock: plan.forkBlock,
    execution: 'fork',
    rpcUrl: 'https://plan-validation.invalid',
    authoritativeReference: plan.authoritativeReference,
    executedAt: new Date(0).toISOString(),
    testCommand: 'plan-validation',
    cases: plan.cases.map(({ name }) => ({ name, result: 'pass', elapsedMs: 0 })),
  });
  if (conformanceErrors.length > 0) {
    throw new Error(`FORK_PLAN_CONFORMANCE_INVALID:${conformanceErrors.join(',')}`);
  }
  return plan;
}

/** Prevent an operator-provided environment from silently changing plan provenance. */
export function assertForkPlanExecution(plan, execution) {
  if (execution.chainId !== plan.chainId) {
    throw new Error(`FORK_PLAN_CHAIN_MISMATCH:${plan.chainId}:${execution.chainId}`);
  }
  if (execution.forkBlock !== plan.forkBlock) {
    throw new Error(`FORK_PLAN_BLOCK_MISMATCH:${plan.forkBlock}:${execution.forkBlock}`);
  }
}

export function forgeCaseArgs(testName) {
  return [
    'test',
    '--offline',
    '--root', 'contracts/flare',
    '--match-contract', 'VenueMainnetForkTest',
    '--match-test', testName,
    '-vv',
  ];
}

function executeForge(testName) {
  return new Promise((resolve, reject) => {
    const child = spawn('forge', forgeCaseArgs(testName), {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, output }));
  });
}

/** Run one isolated Foundry test and accept only one pass with no fail or skip. */
export async function runTimedForgeCase({ name, testName, execute = executeForge, now = () => performance.now() }) {
  const startedAt = now();
  const execution = await execute(testName);
  const elapsedMs = Math.max(0, now() - startedAt);
  if (execution.exitCode !== 0 || !EXACT_PASS.test(execution.output)) {
    const error = new Error(`FORK_TEST_NOT_EXACTLY_ONE_PASS:${name}`);
    error.output = execution.output;
    throw error;
  }
  return { name, result: 'pass', elapsedMs };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`ENV_REQUIRED:${name}`);
  return value;
}

async function main() {
  const planPath = requiredEnvironment('FLARE_VENUE_FORK_PLAN');
  const outputPath = requiredEnvironment('FLARE_VENUE_CONFORMANCE_OUTPUT');
  const rpcUrl = requiredEnvironment('FLARE_MAINNET_RPC_URL');
  const forkBlock = Number(requiredEnvironment('FLARE_MAINNET_FORK_BLOCK'));
  if (!Number.isSafeInteger(forkBlock) || forkBlock <= 0) throw new Error('FLARE_FORK_BLOCK_REQUIRED');

  const plan = validateForkPlan(JSON.parse(readFileSync(planPath, 'utf8')));
  assertForkPlanExecution(plan, { chainId: 14, forkBlock });
  const cases = [];
  for (const entry of plan.cases) {
    cases.push(await runTimedForgeCase(entry));
  }
  const manifest = {
    venue: plan.venue,
    chainId: plan.chainId,
    forkBlock,
    execution: 'fork',
    rpcUrl: rpcEvidenceOrigin(rpcUrl),
    authoritativeReference: plan.authoritativeReference,
    executedAt: new Date().toISOString(),
    testCommand: 'npm run test:flare:venues:fork',
    cases,
  };
  const errors = validateVenueConformanceManifest(manifest);
  if (errors.length > 0) throw new Error(`VENUE_CONFORMANCE_INVALID:${errors.join(',')}`);
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(`venue-fork=PASS venue=${manifest.venue} block=${forkBlock} cases=${cases.length} output=${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error?.output) process.stderr.write(error.output);
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
