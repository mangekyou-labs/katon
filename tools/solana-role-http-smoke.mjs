import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { encodeBase58 } from '../packages/solana-core/src/base58.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const roleSessionSecret = 'local-loopback-smoke-secret-with-sufficient-entropy';

function identity(role, makerId) {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyBytes = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const publicKey = encodeBase58(publicKeyBytes);
  return {
    publicKey,
    privateKey: pair.privateKey,
    config: { publicKey, role, ...(makerId ? { makerId } : {}) },
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function jsonRequest(baseUrl, path, { method = 'GET', body, token, origin, cluster } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { 'x-katon-origin': origin } : {}),
      ...(cluster ? { 'x-katon-cluster': cluster } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  return { status: response.status, body: data };
}

async function createRoleSession(baseUrl, subject, role) {
  const challengeResult = await jsonRequest(baseUrl, '/v1/role-sessions/challenge', {
    method: 'POST', body: { publicKey: subject.publicKey, role },
  });
  assert.equal(challengeResult.status, 200);
  const { challengeId, message } = challengeResult.body;
  const signature = sign(null, Buffer.from(message), subject.privateKey).toString('base64url');
  const session = await jsonRequest(baseUrl, '/v1/role-sessions', {
    method: 'POST',
    body: { publicKey: subject.publicKey, role, challengeId, signature },
  });
  assert.equal(session.status, 201);
  return session.body.token;
}

async function openMakerStream(baseUrl, token) {
  const client = new WebSocket(baseUrl.replace('http:', 'ws:') + '/v1/makers/stream', {
    headers: { authorization: `Bearer ${token}` },
  });
  client.evidence = { queue: [], waiters: [] };
  client.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const index = client.evidence.waiters.findIndex(waiter => waiter.type === message.type);
    if (index >= 0) {
      const [waiter] = client.evidence.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      client.evidence.queue.push(message);
    }
  });
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  return client;
}

async function waitForMessage(client, type) {
  const queued = client.evidence.queue.findIndex(message => message.type === type);
  if (queued >= 0) return client.evidence.queue.splice(queued, 1)[0];
  return new Promise((resolve, reject) => {
    const waiter = { type, resolve, timer: undefined };
    waiter.timer = setTimeout(() => {
      client.evidence.waiters = client.evidence.waiters.filter(candidate => candidate !== waiter);
      reject(new Error(`missing ${type} maker stream message`));
    }, 2_000);
    client.evidence.waiters.push(waiter);
  });
}

const maker = identity('maker', 'loopback-maker');
const operator = identity('operator');
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const origin = 'http://127.0.0.1:5173';
const child = spawn(process.execPath, ['--import', 'tsx', 'apps/solana-api/src/server.ts'], {
  cwd: repo,
  env: {
    ...process.env,
    SOLANA_API_PORT: String(port),
    SOLANA_API_AUTOSTART: 'true',
    SOLANA_API_ORIGIN: origin,
    SOLANA_CLUSTER: 'localnet',
    KATON_LOCALNET: '1',
    SOLANA_ROLE_IDENTITIES: JSON.stringify([maker.config, operator.config]),
    SOLANA_ROLE_SESSION_SECRET: roleSessionSecret,
    SOLANA_SELLER_SESSION_SECRET: 'local-loopback-seller-session-secret-with-entropy',
    SOLANA_RPC_URL: '',
    SOLANA_DEPLOYMENT_MANIFEST: '',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
const httpEvidence = [];
const websocketEvidence = [];

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API exited ${child.exitCode}: ${stderr}`);
    try {
      const response = await jsonRequest(baseUrl, '/v1/role-sessions/challenge', {
        method: 'POST', body: { publicKey: maker.publicKey, role: 'maker' },
      });
      if (response.status === 200) { ready = true; break; }
    } catch { await delay(100); }
  }
  assert.ok(ready, `API did not become ready: ${stderr}`);

  const makerToken = await createRoleSession(baseUrl, maker, 'maker');
  const operatorToken = await createRoleSession(baseUrl, operator, 'operator');

  const unauthenticatedSellerReads = await Promise.all([
    jsonRequest(baseUrl, `/v1/assets?wallet=${encodeURIComponent(maker.publicKey)}`, { origin, cluster: 'localnet' }),
    jsonRequest(baseUrl, `/v1/trades?wallet=${encodeURIComponent(maker.publicKey)}`, { origin, cluster: 'localnet' }),
  ]);
  assert.deepEqual(unauthenticatedSellerReads.map(({ status }) => status), [401, 401]);
  httpEvidence.push('wallet-scoped assets and trades reads both reject missing Seller proof (401)');

  assert.equal((await jsonRequest(baseUrl, '/v1/makers/me')).status, 400);
  assert.equal((await jsonRequest(baseUrl, '/v1/operator', { token: makerToken })).status, 400);
  assert.equal((await jsonRequest(baseUrl, '/v1/makers/me', { token: operatorToken })).status, 400);
  httpEvidence.push('Maker and operator roles cannot call each other’s private status endpoints');

  const operatorView = await jsonRequest(baseUrl, '/v1/operator', { token: operatorToken });
  assert.equal(operatorView.status, 200);
  assert.deepEqual(operatorView.body.onChain, {
    status: 'unavailable',
    registry: { status: 'unavailable', reason: 'Solana RPC reader is not configured' },
    pauses: { status: 'unavailable', reason: 'Solana RPC reader is not configured' },
    governanceChanges: { status: 'unavailable', reason: 'Solana RPC reader is not configured' },
  });
  assert.equal(operatorView.body.programEvidence.status, 'unavailable');
  httpEvidence.push('operator HTTP view preserves unavailable on-chain and program evidence');

  const makerView = await jsonRequest(baseUrl, '/v1/makers/me', { token: makerToken });
  assert.equal(makerView.status, 200);
  assert.deepEqual(makerView.body.maker, {
    makerId: 'loopback-maker', enabled: false, governanceEnabled: false,
    operatorDisabled: false, selfDisabled: false, advertisedAvailable: false,
    availability: 'unavailable', capabilities: [], quotesReceived: 0, quotesRejected: 0,
  });

  const { demoAssets } = await import('../apps/solana-api/src/registry.ts');
  const capability = {
    inputMint: demoAssets[0].mint,
    outputMint: demoAssets[0].supportedOutputs[0],
    minInputAtomic: '1',
    maxInputAtomic: '1000000',
  };
  const firstStream = await openMakerStream(baseUrl, makerToken);
  const readyMessage = await waitForMessage(firstStream, 'ready');
  assert.equal(readyMessage.makerId, 'loopback-maker');
  websocketEvidence.push('Maker role session opens authenticated stream');

  const advertisementAck = waitForMessage(firstStream, 'advertisement_ack');
  firstStream.send(JSON.stringify({ type: 'advertise', capabilities: [capability], availability: 'available' }));
  const advertised = await advertisementAck;
  assert.equal(advertised.maker.availability, 'unavailable');
  assert.equal(advertised.maker.governanceEnabled, false);
  assert.equal(advertised.maker.enabled, false);
  websocketEvidence.push('available advertisement is acknowledged but remains unavailable before observed governance enablement');

  const statusAfterAd = await jsonRequest(baseUrl, '/v1/makers/me', { token: makerToken });
  assert.equal(statusAfterAd.body.maker.advertisedAvailable, true);
  assert.equal(statusAfterAd.body.maker.availability, 'unavailable');
  const heartbeatAck = waitForMessage(firstStream, 'heartbeat_ack');
  firstStream.send(JSON.stringify({ type: 'heartbeat' }));
  await heartbeatAck;
  const invalidAck = waitForMessage(firstStream, 'rejected');
  firstStream.send(JSON.stringify({ type: 'heartbeat', unexpected: true }));
  await invalidAck;
  websocketEvidence.push('heartbeat accepted and malformed heartbeat rejected');

  const firstClosed = new Promise(resolve => firstStream.once('close', resolve));
  const secondStream = await openMakerStream(baseUrl, makerToken);
  await firstClosed;
  await waitForMessage(secondStream, 'ready');
  const replacementAck = waitForMessage(secondStream, 'advertisement_ack');
  secondStream.send(JSON.stringify({ type: 'advertise', capabilities: [capability], availability: 'available' }));
  const replacementAd = await replacementAck;
  assert.equal(replacementAd.maker.availability, 'unavailable');
  websocketEvidence.push('replacement stream starts unavailable and cannot bypass the governance gate');

  const rejectedQuote = waitForMessage(secondStream, 'rejected');
  secondStream.send(JSON.stringify({
    type: 'quote', makerId: 'loopback-maker', requestId: 'no-active-request', quoteId: '01'.repeat(32),
    wallet: maker.publicKey, inputMint: capability.inputMint, outputMint: capability.outputMint,
    inputAmountAtomic: '100', outputAmountAtomic: '95', feeBps: 10, expiresAtMs: Date.now() + 5_000,
    transactionHash: '0'.repeat(64), transactionBase64: '', signature: '',
  }));
  await rejectedQuote;
  assert.equal((await jsonRequest(baseUrl, '/v1/makers/me', { token: makerToken })).body.maker.quotesReceived, 0);
  websocketEvidence.push('quote message denied while Maker governance is disabled');
  secondStream.close();

  const stop = await jsonRequest(baseUrl, '/v1/operator/quote-sprints/stop', { method: 'POST', token: operatorToken });
  assert.equal(stop.status, 200);
  assert.equal((await jsonRequest(baseUrl, '/v1/operator/makers/loopback-maker/disable', { method: 'POST', token: makerToken })).status, 400);
  const disabled = await jsonRequest(baseUrl, '/v1/operator/makers/loopback-maker/disable', { method: 'POST', token: operatorToken });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.maker.enabled, false);
  assert.equal(disabled.body.maker.operatorDisabled, true);
  assert.equal(disabled.body.maker.availability, 'unavailable');
  assert.equal((await jsonRequest(baseUrl, '/v1/operator/governance/apply', { method: 'POST', body: {}, token: operatorToken })).status, 404);
  const finalOperator = await jsonRequest(baseUrl, '/v1/operator', { token: operatorToken });
  assert.equal(finalOperator.body.sprints, 'stopped');
  assert.equal(finalOperator.body.makers[0].operatorDisabled, true);
  httpEvidence.push('operator can stop Sprint intake and immediately disable Maker; no governance write endpoint exists');

  console.log(`HTTP evidence: ${httpEvidence.join('; ')}.`);
  console.log(`WebSocket evidence: ${websocketEvidence.join('; ')}.`);
} catch (error) {
  console.error(`HTTP evidence at failure: ${httpEvidence.join('; ')}\nWebSocket evidence at failure: ${websocketEvidence.join('; ')}\nAPI stderr: ${stderr}`);
  throw error;
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5_000)]);
}
