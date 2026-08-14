import { createHash, createHmac } from 'node:crypto';

const baseUrl = (process.env.FLARE_AUTH_E2E_URL ?? 'http://127.0.0.1:8878').replace(/\/$/, '');
const adminToken = process.env.FLARE_AUTH_E2E_ADMIN_TOKEN?.trim();
if (!adminToken) throw new Error('FLARE_AUTH_E2E_ADMIN_TOKEN_REQUIRED');
const wallet = process.env.FLARE_AUTH_E2E_WALLET ?? '0x00000000000000000000000000000000000000aa';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

async function request(path, init = {}) {
  return json(await fetch(`${baseUrl}${path}`, init));
}

function botHeaders(token, method, path, body = '') {
  const timestamp = Math.floor(Date.now() / 1_000);
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = createHmac('sha256', token).update(`${method.toUpperCase()}\n${path}\n${timestamp}\n${digest}`, 'utf8').digest('hex');
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-trf-timestamp': String(timestamp),
    'x-trf-body-sha256': digest,
    'x-trf-signature': signature,
  };
}

const credentialInput = JSON.stringify({ wallet, institution: 'auth-e2e-desk', scopes: ['rfq:create', 'read:rfq'], expiresAt: Math.floor(Date.now() / 1_000) + 300 });
const issued = await request('/v1/lp-credentials', { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: credentialInput });
assert(issued.status === 201 && typeof issued.body.token === 'string', `credential issue failed: ${issued.status}`);
const token = issued.body.token;

const envelope = { version: 1, keyId: 'auth-e2e-key', commitment: '0xauth-e2e', expiresAt: Math.floor(Date.now() / 1_000) + 86_400, nonce: 'auth-e2e-nonce', ciphertext: 'auth-e2e-ciphertext' };
const openBody = JSON.stringify({ wallet, eligibleLps: [wallet], duration: '24h', envelope });
const unsigned = await request('/v1/relay/auctions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: openBody });
assert(unsigned.status === 401 && unsigned.body.error === 'BOT_SIGNATURE_TIMESTAMP', `unsigned bot request was not rejected: ${unsigned.status}:${unsigned.body.error}`);

const opened = await request('/v1/relay/auctions', { method: 'POST', headers: botHeaders(token, 'POST', '/v1/relay/auctions', openBody), body: openBody });
assert(opened.status === 201 && opened.body.id, `signed bot mutation failed: ${opened.status}:${opened.body.error}`);
const read = await request(`/v1/relay/auctions?wallet=${encodeURIComponent(wallet)}`, { headers: botHeaders(token, 'GET', '/v1/relay/auctions', '') });
assert(read.status === 200 && Array.isArray(read.body.auctions), `signed bot read failed: ${read.status}:${read.body.error}`);
const unsignedRead = await request(`/v1/relay/auctions?wallet=${encodeURIComponent(wallet)}`, { headers: { authorization: `Bearer ${token}` } });
assert(unsignedRead.status === 401 && unsignedRead.body.error === 'BOT_SIGNATURE_TIMESTAMP', `unsigned bot read was not rejected: ${unsignedRead.status}:${unsignedRead.body.error}`);

const revoked = await request(`/v1/lp-credentials/${encodeURIComponent(issued.body.id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } });
assert(revoked.status === 200, `credential revoke failed: ${revoked.status}`);
const afterRevoke = await request(`/v1/relay/auctions?wallet=${encodeURIComponent(wallet)}`, { headers: botHeaders(token, 'GET', '/v1/relay/auctions', '') });
assert(afterRevoke.status === 401 && afterRevoke.body.error === 'CREDENTIAL_REVOKED', `revoked bot token remained usable: ${afterRevoke.status}:${afterRevoke.body.error}`);
console.log('flare-api-auth-e2e=PASS unsignedRejected=signedMutation=signedRead=revocationEnforced');
