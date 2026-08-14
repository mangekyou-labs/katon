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

const durationMs = Number(process.env.FLARE_SOAK_MS ?? 30_000);
const port = await freePort();
const storeDirectory = mkdtempSync(join(tmpdir(), 'trustrfq-soak-'));
const server = spawn('npm', ['run', 'dev:flare-api'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...process.env, FLARE_API_PORT: String(port), FLARE_API_STORE: join(storeDirectory, 'store.json') },
});
const baseUrl = `http://127.0.0.1:${port}`;
if (!Number.isInteger(durationMs) || durationMs < 1_000) throw new Error('SOAK_DURATION');
for (let attempt = 0; attempt < 120; attempt += 1) {
  try { if ((await fetch(`${baseUrl}/v1/health`)).ok) break; } catch {}
  if (attempt === 119) throw new Error('FLARE_API_SERVER_TIMEOUT');
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const deadline = Date.now() + durationMs;
let requests = 0;
let failures = 0;
while (Date.now() < deadline) {
  await Promise.all(Array.from({ length: 10 }, async () => {
    try {
      const response = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(5_000) });
      requests += 1;
      if (!response.ok) failures += 1;
    } catch {
      requests += 1;
      failures += 1;
    }
  }));
}
server.kill('SIGTERM');
rmSync(storeDirectory, { recursive: true, force: true });
if (failures) throw new Error(`SOAK_FAILURES:${failures}`);
console.log(`flare-soak=PASS durationMs=${durationMs} requests=${requests}`);
