import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

import {
  calculateHeapMetrics,
  createSoakMetrics,
  formatSoakReport,
  parseSoakConfig,
  percentile,
  qualifySoak,
  recordProbe,
  redactUrl,
  stopManagedChild,
} from './base-api-soak-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childPath = path.join(rootDir, 'tools/base-api-soak-child.mjs');
const config = parseSoakConfig();
const DEFAULT_SOAK_PRIVATE_KEY = '0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a2e1f6f7a4e9f4f8b2d';
const DEFAULT_SOAK_MAKER_PRIVATE_KEY = `0x${'8'.repeat(64)}`;
const SOAK_BOT_ID = 'soak-lp';
const SOAK_BOT_SECRET = 'soak-lp-secret';
const SOAK_ROUTER = '0x0000000000000000000000000000000000000a01';
const SOAK_SETTLEMENT = '0x0000000000000000000000000000000000000a02';
const SOAK_FACILITY = '0x0000000000000000000000000000000000000a03';
const SOAK_ORACLE_GUARD = '0x0000000000000000000000000000000000000a04';
const SOAK_B20_GUARD = '0x0000000000000000000000000000000000000a05';
const SOAK_STOCK = '0x0000000000000000000000000000000000000020';
const SOAK_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const SWAP_ORDER_TYPES = {
  SwapOrder: [
    { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
    { name: 'stockToken', type: 'address' }, { name: 'usdcToken', type: 'address' },
    { name: 'stockAmount', type: 'uint256' }, { name: 'usdcAmount', type: 'uint256' },
    { name: 'fillMode', type: 'uint8' }, { name: 'expiry', type: 'uint256' },
    { name: 'salt', type: 'uint256' }, { name: 'feeCapBps', type: 'uint16' },
    { name: 'allowedTaker', type: 'address' }, { name: 'rfqId', type: 'bytes32' },
  ],
};
let child;

try {
  let managedChild = false;
  let requestUrl = config.fetchUrl;
  let reportUrl = config.requestUrl;
  if (!config.external) {
    const port = await freePort();
    child = spawn(process.execPath, ['--expose-gc', '--import', 'tsx', childPath], {
      cwd: rootDir,
      env: {
        PATH: process.env.PATH ?? '',
        TSX_TSCONFIG_PATH: 'tsconfig.base-api.json',
        NODE_ENV: 'test',
        KATON_BASE_NETWORK: 'sepolia',
        KATON_BASE_CHAIN_ID: '84532',
        KATON_BASE_RPC_URL: '',
        KATON_BASE_ROUTER_ADDRESS: SOAK_ROUTER,
        KATON_BASE_SETTLEMENT_ADDRESS: SOAK_SETTLEMENT,
        KATON_BASE_FACILITY_ADDRESSES: SOAK_FACILITY,
        KATON_BASE_ORACLE_GUARD_ADDRESS: SOAK_ORACLE_GUARD,
        KATON_BASE_B20_GUARD_ADDRESS: SOAK_B20_GUARD,
        KATON_BASE_NATIVE_USDC_ADDRESS: SOAK_USDC,
        KATON_BOT_CREDENTIALS: JSON.stringify([{
          id: SOAK_BOT_ID,
          secret: SOAK_BOT_SECRET,
          scopes: ['lp'],
          identity: privateKeyToAccount(config.makerPrivateKey ?? DEFAULT_SOAK_MAKER_PRIVATE_KEY).address,
        }]),
        KATON_BASE_SOAK_FIXTURE: 'true',
        KATON_BASE_BROWSER_ORIGINS: `http://127.0.0.1:${port}`,
        KATON_BASE_API_PORT: String(port),
        KATON_INSECURE_LOCAL: 'true',
        KATON_TRUST_PROXY_HOPS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', (chunk) => {
      if (process.env.BASE_API_SOAK_FORWARD_CHILD_LOGS === 'true') process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (process.env.BASE_API_SOAK_FORWARD_CHILD_LOGS === 'true') process.stderr.write(chunk);
    });
    await waitForReady(child);
    managedChild = true;
    requestUrl = `http://127.0.0.1:${port}${config.path}`;
    reportUrl = redactUrl(requestUrl);
    await registerDeterministicOrder(new URL(requestUrl).origin, config);
  }

  const sessionToken = config.sessionToken ?? await establishSiweSession(new URL(requestUrl).origin, config);
  const quoteBody = buildQuoteBody(config.quoteBody, sessionToken);

  const metrics = createSoakMetrics();
  const startedAt = performance.now();
  let sampleInFlight = Promise.resolve();
  const sampleDuringRun = () => {
    sampleInFlight = sampleInFlight.then(() => sampleHeap(child, metrics, startedAt));
    return sampleInFlight;
  };
  let sampleTimer;
  if (managedChild) {
    await sampleDuringRun();
    const intervalMs = Math.max(250, Math.min(30_000, config.durationSeconds * 1_000 / 4));
    sampleTimer = setInterval(() => { void sampleDuringRun().catch(() => {}); }, intervalMs);
  }
  const deadline = startedAt + config.durationSeconds * 1_000;
  await Promise.all(Array.from({ length: config.concurrency }, () => worker(requestUrl, config, metrics, deadline, sessionToken, quoteBody)));
  if (sampleTimer) clearInterval(sampleTimer);
  if (managedChild) {
    await sampleDuringRun();
    await sampleInFlight;
  }
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const heap = calculateHeapMetrics(metrics.heapSamples);
  const quoteP95Ms = percentile(metrics.quoteLatenciesMs, 95);
  const qualification = qualifySoak({
    durationSeconds: config.durationSeconds,
    concurrency: config.concurrency,
    requestIntervalMs: config.requestIntervalMs,
    elapsedSeconds,
    requests: metrics.requests,
    requestFailures: metrics.requestFailures,
    schemaFailures: metrics.schemaFailures,
    quoteMode: true,
    quoteP95Ms,
    retainedGrowthBytes: heap.retainedGrowthBytes,
    heapSlopeBytesPerMinute: heap.heapSlopeBytesPerMinute,
    managedChild,
    heapSamples: metrics.heapSamples.length,
  });
  console.log(formatSoakReport({
    durationSeconds: config.durationSeconds,
    concurrency: config.concurrency,
    requests: metrics.requests,
    requestFailures: metrics.requestFailures,
    schemaFailures: metrics.schemaFailures,
    quoteP95Ms,
    failures: metrics.failures,
    firstFailure: metrics.firstFailure,
    elapsedSeconds,
    retainedGrowthBytes: heap.retainedGrowthBytes,
    heapSlopeBytesPerMinute: heap.heapSlopeBytesPerMinute,
    managedChild,
    heapSamples: metrics.heapSamples.length,
    url: reportUrl,
    ...qualification,
  }));
  const defaultQualificationRun = !config.external
    && config.durationSeconds === 600
    && config.concurrency === 4;
  if (defaultQualificationRun && !qualification.qualified) process.exitCode = 1;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`base-api-soak=FAIL reason=${reason}`);
  process.exitCode = 1;
} finally {
  if (child) await stopManagedChild(child);
}

async function worker(requestUrl, soakConfig, metrics, deadline, sessionToken, quoteBody) {
  while (performance.now() < deadline) {
    const result = await probe(requestUrl, soakConfig.requestTimeoutMs, sessionToken, quoteBody);
    recordProbe(metrics, result);
    const delayMs = metrics.failures > 0
      ? Math.max(50, soakConfig.requestIntervalMs)
      : soakConfig.requestIntervalMs;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function probe(requestUrl, timeoutMs, sessionToken, quoteBody) {
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(quoteBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, schemaValid: false, error: error instanceof Error ? error.name : 'REQUEST_FAILED' };
  }
  const latencyMs = performance.now() - startedAt;
  if (!response.ok) {
    let error = `HTTP_${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.code === 'string' && /^[A-Z0-9_:-]+$/u.test(body.code)) {
        error = `${error}_${body.code}`;
      }
    } catch {
      // Preserve the HTTP status when the server does not return JSON.
    }
    return { ok: false, schemaValid: false, latencyMs, error };
  }
  try {
    const body = await response.json();
    const valid = body
      && typeof body === 'object'
      && (body.status === 'WINNER' || body.status === 'NO_ROUTE')
      && typeof body.simulationBlock === 'string'
      && /^(0|[1-9]\d*)$/u.test(body.simulationBlock)
      && typeof body.simulationBlockHash === 'string'
      && /^0x[0-9a-fA-F]{64}$/u.test(body.simulationBlockHash)
      && Array.isArray(body.alternatives)
      && Array.isArray(body.external);
    return valid
      ? { ok: true, schemaValid: true, latencyMs }
      : { ok: true, schemaValid: false, latencyMs, error: 'INVALID_SWAP_QUOTE_RESPONSE' };
  } catch {
    return { ok: true, schemaValid: false, latencyMs, error: 'INVALID_JSON' };
  }
}

async function establishSiweSession(origin, soakConfig) {
  const privateKey = soakConfig.privateKey ?? DEFAULT_SOAK_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(String(privateKey))) throw new Error('BASE_API_SOAK_CONFIG:BASE_API_SOAK_PRIVATE_KEY');
  const account = privateKeyToAccount(privateKey);
  const nonceResponse = await fetch(`${origin}/v1/auth/nonce`, { signal: AbortSignal.timeout(soakConfig.requestTimeoutMs) });
  if (!nonceResponse.ok) throw new Error(`BASE_API_SOAK_NONCE_HTTP_${nonceResponse.status}`);
  const nonce = await nonceResponse.json();
  if (!nonce || typeof nonce.nonce !== 'string' || typeof nonce.domain !== 'string' || typeof nonce.chainId !== 'number') throw new Error('BASE_API_SOAK_NONCE_INVALID');
  const message = `${nonce.domain} wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Katon Base.\n\nURI: ${origin}/\nVersion: 1\nChain ID: ${nonce.chainId}\nNonce: ${nonce.nonce}\nIssued At: ${nonce.issuedAt}\nExpiration Time: ${nonce.expirationTime}`;
  const signature = await account.signMessage({ message });
  const response = await fetch(`${origin}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
    signal: AbortSignal.timeout(soakConfig.requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`BASE_API_SOAK_VERIFY_HTTP_${response.status}`);
  const result = await response.json();
  if (!result || typeof result.sessionToken !== 'string' || !result.sessionToken.startsWith('katon_session_')) throw new Error('BASE_API_SOAK_SESSION_INVALID');
  return result.sessionToken;
}

function buildQuoteBody(configured, sessionToken) {
  const now = Math.floor(Date.now() / 1_000);
  const account = privateKeyToAccount(config.privateKey ?? DEFAULT_SOAK_PRIVATE_KEY);
  // Keep the deterministic quote executable for the complete qualification
  // window plus setup/teardown headroom. The signed maker order has its own
  // shorter expiry and remains the limiting route freshness bound.
  const defaultDeadline = String(now + Math.max(900, config.durationSeconds + 300));
  const body = configured && typeof configured === 'object' ? { ...configured } : {
    stockToken: SOAK_STOCK,
    usdcToken: SOAK_USDC,
    sellAmount: '1000000000000000000',
    minBuyAmount: '1',
    taker: account.address,
    recipient: account.address,
    deadline: defaultDeadline,
  };
  if (typeof body.taker !== 'string') body.taker = account.address;
  if (typeof body.recipient !== 'string') body.recipient = body.taker;
  if (typeof body.deadline !== 'string') body.deadline = defaultDeadline;
  // The token is deliberately deterministic for the local child and can be
  // overridden with BASE_API_SOAK_QUOTE_BODY for a live candidate.
  void sessionToken;
  return body;
}

async function registerDeterministicOrder(origin, soakConfig) {
  const maker = privateKeyToAccount(soakConfig.makerPrivateKey ?? DEFAULT_SOAK_MAKER_PRIVATE_KEY);
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const order = {
    maker: maker.address,
    signer: maker.address,
    stockToken: SOAK_STOCK,
    usdcToken: SOAK_USDC,
    stockAmount: 1_000_000_000_000_000_000n,
    usdcAmount: 1n,
    fillMode: 0,
    expiry: now + 3_600n,
    salt: BigInt(Date.now()),
    feeCapBps: 0,
    allowedTaker: ZERO_ADDRESS,
    rfqId: ZERO_HASH,
  };
  const domain = {
    name: 'KatonRFQSettlement',
    version: '2',
    chainId: 84_532,
    verifyingContract: SOAK_SETTLEMENT,
  };
  const signature = await maker.signTypedData({ domain, types: SWAP_ORDER_TYPES, primaryType: 'SwapOrder', message: order });
  const body = JSON.stringify({
    action: 'register',
    order: stringifyOrder(order),
    signature,
    remainingCapacity: order.stockAmount.toString(10),
  });
  const timestamp = Math.floor(Date.now() / 1_000);
  const bodyHash = `0x${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  const canonical = `POST\n/v1/swap-orders\n${timestamp}\n${bodyHash.slice(2)}`;
  const hmac = `0x${createHmac('sha256', SOAK_BOT_SECRET).update(canonical, 'utf8').digest('hex')}`;
  const response = await fetch(`${origin}/v1/swap-orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer katon_bot_${SOAK_BOT_ID}.${SOAK_BOT_SECRET}`,
      'x-katon-timestamp': String(timestamp),
      'x-katon-body-sha256': bodyHash,
      'x-katon-signature': hmac,
      'content-type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(soakConfig.requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`BASE_API_SOAK_ORDER_HTTP_${response.status}`);
  const result = await response.json();
  if (result?.status !== 'registered') throw new Error('BASE_API_SOAK_ORDER_INVALID');
}

function stringifyOrder(order) {
  return Object.fromEntries(Object.entries(order).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString(10) : value]));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('BASE_API_SOAK_PORT');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitForReady(processChild) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      processChild.off('message', onMessage);
      processChild.off('error', onError);
      processChild.off('exit', onExit);
    };
    const onMessage = (message) => {
      if (message?.type === 'ready') {
        cleanup();
        resolve();
      } else if (message?.type === 'error') {
        cleanup();
        reject(new Error(`BASE_API_SOAK_CHILD:${message.reason}`));
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`BASE_API_SOAK_CHILD_EXIT:${code}`));
    };
    processChild.on('message', onMessage);
    processChild.once('error', onError);
    processChild.once('exit', onExit);
  });
}

function sampleHeap(processChild, metrics, startedAt) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random()}`;
    const cleanup = () => {
      processChild.off('message', onMessage);
      processChild.off('exit', onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== 'heap' || message.id !== id) return;
      cleanup();
      metrics.heapSamples.push({
        elapsedMs: performance.now() - startedAt,
        heapUsedBytes: Number(message.heapUsedBytes),
      });
      resolve();
    };
    const onExit = () => { cleanup(); reject(new Error('BASE_API_SOAK_CHILD_EXIT')); };
    processChild.on('message', onMessage);
    processChild.once('exit', onExit);
    processChild.send({ type: 'heap', id }, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}
