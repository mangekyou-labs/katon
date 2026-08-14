import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { measureAsyncOperation } from './elapsed-evidence.mjs';
import { buildSimRelayEnvelopes } from './sim-rfq-payload.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('PORT_ALLOCATE');
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForApi(apiUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/v1/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('FLARE_API_SERVER_TIMEOUT');
}

function startApi(port, extraEnv = {}) {
  const storeDirectory = mkdtempSync(join('/private/tmp', 'trustrfq-local-rfq-'));
  const child = spawn('npm', ['run', 'dev:flare-api'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FLARE_API_PORT: String(port),
      FLARE_API_STORE: join(storeDirectory, 'store.json'),
      ...extraEnv,
    },
  });
  return { child, storeDirectory };
}

async function runSimulatedPath() {
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const wallet = '0x00000000000000000000000000000000000000aa';
  const { child, storeDirectory } = startApi(port, { FLARE_FCC_MODE: 'simulated' });
  try {
    await waitForApi(apiUrl);
    const { auctionEnvelope, bidEnvelope } = buildSimRelayEnvelopes({ wallet });
    const opened = await fetch(`${apiUrl}/v1/relay/auctions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, eligibleLps: [wallet], duration: '24h', earlyCloseAllowed: true, envelope: auctionEnvelope }),
    });
    const openedBody = await opened.json();
    assert(opened.status === 201, `open failed: ${opened.status} ${JSON.stringify(openedBody)}`);
    const auction = openedBody;
    const bid = await fetch(`${apiUrl}/v1/relay/auctions/${auction.id}/bids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, idempotencyKey: 'local-rfq-bid', envelope: bidEnvelope }),
    });
    const bidBody = await bid.json();
    assert(bid.status === 200, `bid failed: ${bid.status} ${JSON.stringify(bidBody)}`);
    const { value: finalized, elapsedMs: matcherElapsedMs } = await measureAsyncOperation(() =>
      fetch(`${apiUrl}/v1/relay/auctions/${auction.id}/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet }),
      }));
    const body = await finalized.json();
    assert(finalized.status === 200, `finalize failed: ${finalized.status} ${JSON.stringify(body)}`);
    assert(body.status === 'finalized' && body.bidCount === 1, 'lifecycle mismatch');
    assert(typeof body.matchResult?.resultHash === 'string' && /^0x[0-9a-f]{64}$/.test(body.matchResult.resultHash), 'missing resultHash');
    console.log(`local-rfq-e2e=PASS mode=simulated auction=${auction.id} resultHash=${body.matchResult.resultHash} winnerLpId=${body.matchResult.winnerLpId ?? wallet} matcherElapsedMs=${matcherElapsedMs.toFixed(3)}`);
    return body.matchResult.resultHash;
  } finally {
    child.kill('SIGTERM');
    rmSync(storeDirectory, { recursive: true, force: true });
  }
}

async function runRealModeFailClosed() {
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const wallet = '0x00000000000000000000000000000000000000aa';
  const { child, storeDirectory } = startApi(port, { FLARE_FCC_MODE: 'real' });
  try {
    await waitForApi(apiUrl);
    const { auctionEnvelope, bidEnvelope } = buildSimRelayEnvelopes({ wallet });
    const opened = await fetch(`${apiUrl}/v1/relay/auctions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, eligibleLps: [wallet], duration: '24h', earlyCloseAllowed: true, envelope: auctionEnvelope }),
    });
    assert(opened.status === 201, `real-mode open failed: ${opened.status}`);
    const auction = await opened.json();
    await fetch(`${apiUrl}/v1/relay/auctions/${auction.id}/bids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, idempotencyKey: 'local-rfq-bid-real', envelope: bidEnvelope }),
    });
    const { value: finalized, elapsedMs: matcherElapsedMs } = await measureAsyncOperation(() =>
      fetch(`${apiUrl}/v1/relay/auctions/${auction.id}/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet }),
      }));
    const body = await finalized.json();
    assert(finalized.status >= 400, `real mode without extension must fail closed, got ${finalized.status}`);
    const error = String(body.error ?? body.message ?? JSON.stringify(body));
    assert(error.includes('DEDICATED_EXTENSION_REQUIRED') || error.includes('RFQ_REQUEST_FAILED'), `unexpected real-mode error: ${error}`);
    console.log(`local-rfq-e2e=FAIL_CLOSED mode=real status=${finalized.status} error=${error} matcherElapsedMs=${matcherElapsedMs.toFixed(3)}`);
  } finally {
    child.kill('SIGTERM');
    rmSync(storeDirectory, { recursive: true, force: true });
  }
}

await runSimulatedPath();
await runRealModeFailClosed();
console.log('local-rfq-e2e=DONE simulatedPath=pass realModeWithoutExtension=fail-closed notProductionFcc=true');
