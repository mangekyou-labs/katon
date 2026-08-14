#!/usr/bin/env node

// Local FCC rehearsal harness (test-only). Seals a three-recipient RFQ create
// envelope against the live simulated stacks' /info keys, delivers it to all
// three proxies via tools/fcc-provider-delivery.mjs, polls each
// /action/status endpoint, and checks the 2-of-3 identical-result quorum.
// Never prints envelope ciphertext or result bodies — only statuses and a
// short hash digest of each result payload.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import {
  encryptFccEnvelope,
  fetchFccEncryptionRecipients,
} from '../packages/flare-core/src/fccEnvelope.ts';
import { buildFccInstructionAction } from '../packages/flare-core/src/fccInstruction.ts';

const flag = (name, fallback = '') => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

const urls = (flag('--urls', 'http://127.0.0.1:8664,http://127.0.0.1:8764,http://127.0.0.1:8864'))
  .split(',')
  .map((value) => value.trim().replace(/\/$/u, ''))
  .filter(Boolean);
const extensionId = flag('--extension-id', '65537');
const chainId = Number(flag('--chain-id', '114'));

if (urls.length !== 3) throw new Error('FCC_REHEARSAL_URLS');

const now = Math.floor(Date.now() / 1000);
const epoch = String(now);
const instructionId = `0x${randomBytes(32).toString('hex')}`;

const recipients = await fetchFccEncryptionRecipients(
  urls.map((url) => ({ url })) as [{ url: string }, { url: string }, { url: string }],
  extensionId,
  { allowHttpLocalhost: true },
);

const plaintext = new TextEncoder().encode(
  JSON.stringify({ commitment: `0x${randomBytes(32).toString('hex')}` }),
);
const extensionIdHex = `0x${BigInt(extensionId).toString(16).padStart(64, '0')}`;
const envelope = await encryptFccEnvelope(
  plaintext,
  {
    chainId,
    extensionId: extensionIdHex,
    actionId: instructionId,
    opType: 'RFQ',
    command: 'CREATE',
    expiry: now + 600,
  },
  recipients,
);

const action = buildFccInstructionAction({
  instructionId,
  teeId: recipients[0].teeId,
  opType: 'RFQ',
  command: 'CREATE',
  envelopeEncoded: envelope.encoded,
  timestamp: now,
  rewardEpochId: 0,
});

const directory = mkdtempSync(resolve(tmpdir(), 'fcc-rehearsal-'));
const file = resolve(directory, 'instruction.json');
writeFileSync(file, JSON.stringify(action));

const delivery = spawnSync(
  process.execPath,
  [
    resolve(import.meta.dirname, 'fcc-provider-delivery.mjs'),
    '--urls', urls.join(','),
    '--file', file,
    '--epoch', epoch,
    '--id', instructionId,
    '--timeout-ms', '15000',
  ],
  { encoding: 'utf8' },
);
if (delivery.status !== 0) {
  process.stderr.write(delivery.stderr || delivery.stdout || 'FCC_REHEARSAL_DELIVERY\n');
  throw new Error('FCC_REHEARSAL_DELIVERY');
}

const statuses = [];
for (const url of urls) {
  const response = await fetch(`${url}/action/status/${epoch}/${instructionId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`FCC_REHEARSAL_STATUS:${response.status}:${new URL(url).port}`);
  const result = await response.json();
  statuses.push({
    url,
    status: result.status,
    log: result.log,
    digest: createHash('sha256').update(String(result.data ?? '')).digest('hex').slice(0, 16),
  });
}

const accepted = statuses.filter((entry) => entry.status === 1);
const digests = new Map();
for (const entry of accepted) digests.set(entry.digest, (digests.get(entry.digest) ?? 0) + 1);
const best = [...digests.entries()].sort((left, right) => right[1] - left[1])[0];
const quorum = best ? best[1] : 0;

const line = `fcc-rehearsal=${quorum >= 2 ? 'PASS' : 'FAIL'} quorum=${quorum}/3 accepted=${accepted.length}/3 epoch=${epoch} id=${instructionId}`;
console.log(line);
for (const entry of statuses) {
  console.log(`  ${new URL(entry.url).port} status=${entry.status} log=${entry.log} digest=${entry.digest}`);
}
process.exitCode = quorum >= 2 && accepted.length === 3 ? 0 : 1;
