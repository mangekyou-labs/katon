#!/usr/bin/env node

// Test-only provider delivery harness. It exercises the FCC proxy boundary:
// POST /instruction, then GET /action/status/<epoch>/<instructionId>. It
// never prints request or response bodies because those may contain ciphertext
// and signed result material.

import { readFile } from 'node:fs/promises';

const flag = (name, fallback = '') => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

const urls = (flag('--urls', process.env.FCC_PROVIDER_URLS ?? '') || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/u, ''))
  .filter(Boolean);
const file = flag('--file', process.env.FCC_INSTRUCTION_FILE ?? '');
const epoch = flag('--epoch', process.env.FCC_ACTION_EPOCH ?? '');
const instructionId = flag('--id', process.env.FCC_INSTRUCTION_ID ?? '');
const timeoutMs = Number(flag('--timeout-ms', process.env.FCC_DELIVERY_TIMEOUT_MS ?? '30000'));
const pollMs = Number(flag('--poll-ms', process.env.FCC_DELIVERY_POLL_MS ?? '500'));

if (urls.length !== 3 || !file || !/^\d+$/.test(epoch) || !/^0x[0-9a-f]{64}$/iu.test(instructionId)) {
  throw new Error('FCC_DELIVERY_USAGE');
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) {
  throw new Error('FCC_DELIVERY_TIMEOUT');
}

const origins = urls.map((value) => {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('FCC_DELIVERY_URL_UNSAFE');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('FCC_DELIVERY_URL_SCHEME');
  return parsed.origin;
});
const body = await readFile(file);
const started = Date.now();
const delivered = [];

for (const origin of origins) {
  const response = await fetch(`${origin}/instruction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`FCC_DELIVERY_REJECTED:${response.status}`);
  delivered.push(origin);
}

const pending = new Set(origins);
while (pending.size > 0) {
  if (Date.now() - started > timeoutMs) throw new Error(`FCC_DELIVERY_TIMEOUT:${pending.size}`);
  for (const origin of [...pending]) {
    const response = await fetch(`${origin}/action/status/${encodeURIComponent(epoch)}/${instructionId}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      pending.delete(origin);
    } else if (response.status !== 404 && response.status !== 503) {
      throw new Error(`FCC_DELIVERY_STATUS_REJECTED:${response.status}`);
    }
  }
  if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
}

console.log(JSON.stringify({ ok: true, delivered: delivered.length, status: origins.length, instructionId, elapsedMs: Date.now() - started }));
