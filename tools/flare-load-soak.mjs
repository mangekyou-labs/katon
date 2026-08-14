import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('PORT_ALLOCATE');
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const port = await freePort();
const storeDirectory = mkdtempSync(join(tmpdir(), 'trustrfq-load-'));
const server = spawn('npm', ['run', 'dev:flare-api'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, FLARE_API_PORT: String(port), FLARE_API_STORE: join(storeDirectory, 'store.json') },
});
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('FLARE_API_SERVER_TIMEOUT');
}

async function runBatch(path, init, batches = 100, concurrency = 50) {
  const samples = [];
  let failures = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const results = await Promise.all(Array.from({ length: concurrency }, async () => {
      const started = performance.now();
      try {
        const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
        if (!response.ok) failures += 1;
      } catch {
        failures += 1;
      }
      samples.push(performance.now() - started);
    }));
    void results;
  }
  samples.sort((left, right) => left - right);
  return { requests: samples.length, failures, p50: samples[Math.floor(samples.length * 0.5)] ?? 0, p95: samples[Math.floor(samples.length * 0.95)] ?? 0, max: samples.at(-1) ?? 0 };
}

try {
  await waitForApi();
  const readModel = await runBatch('/v1/read-model?wallet=', { method: 'GET' });
  const quote = await runBatch('/v1/quotes/immediate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sellAsset: 'RWA', receiveAsset: 'USDX', amount: '1', minimumReceive: '995' }),
  });
  if (readModel.failures || quote.failures) throw new Error(`LOAD_FAILURES:${readModel.failures + quote.failures}`);
  console.log(`flare-load=PASS readModel=${JSON.stringify(readModel)} quote=${JSON.stringify(quote)}`);
} finally {
  server.kill('SIGTERM');
  rmSync(storeDirectory, { recursive: true, force: true });
}
