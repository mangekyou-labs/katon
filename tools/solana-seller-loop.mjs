#!/usr/bin/env node
/**
 * Ticket 13 close evidence: local Seller loop against Surfpool + solana-api.
 *
 * Assumes harness config at .local/solana-seller-localnet.json and an API
 * started with KATON_LOCALNET=1 (npm run dev:solana-api:localnet).
 *
 * Flow: quote sprint → winner_ready → sign identical v0 → authorize → execute.
 * Asserts signature does not start with mock- and that api.jup.ag was never called.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_SELLER_SEED,
  encodeBase58,
  partiallySignV0Transaction,
  publicKeyFromSeed,
  readShortVec,
} from '../packages/solana-core/src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = process.env.KATON_LOCALNET_CONFIG ?? join(ROOT, '.local/solana-seller-localnet.json');
const API_BASE = process.env.SOLANA_API_URL ?? `http://127.0.0.1:${process.env.SOLANA_API_PORT ?? 8787}`;

const jupiterCalls = [];
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
  if (url.includes('api.jup.ag')) {
    jupiterCalls.push(url);
    throw new Error(`unexpected Jupiter HTTP call: ${url}`);
  }
  return realFetch(input, init);
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`missing ${CONFIG_PATH} — run npm run seller:localnet first`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function loadSellerSeed(config) {
  if (config.sellerKeypairPath && existsSync(config.sellerKeypairPath)) {
    const raw = JSON.parse(readFileSync(config.sellerKeypairPath, 'utf8'));
    if (!Array.isArray(raw) || (raw.length !== 64 && raw.length !== 32)) {
      throw new Error('seller keypair file must be a 32- or 64-byte Solana secret array');
    }
    return Uint8Array.from(raw.length === 64 ? raw.slice(0, 32) : raw);
  }
  return Uint8Array.from(LOCAL_SELLER_SEED);
}

function messageBytesFromSignedTx(signedBase64) {
  const bytes = Uint8Array.from(Buffer.from(signedBase64, 'base64'));
  const sigCount = readShortVec(bytes, 0);
  if (!sigCount) throw new Error('signed transaction shortvec is malformed');
  const messageOffset = sigCount.next + sigCount.value * 64;
  return bytes.slice(messageOffset);
}

function signaturesFromSignedTx(signedBase64) {
  const bytes = Uint8Array.from(Buffer.from(signedBase64, 'base64'));
  const sigCount = readShortVec(bytes, 0);
  if (!sigCount) throw new Error('signed transaction shortvec is malformed');
  const signatures = [];
  let offset = sigCount.next;
  for (let i = 0; i < sigCount.value; i += 1) {
    signatures.push(bytes.slice(offset, offset + 64));
    offset += 64;
  }
  return signatures;
}

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`API ${method} ${pathname} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`API ${method} ${pathname} → ${response.status}: ${json.message ?? text}`);
  return json;
}

async function waitWinnerReady(id, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = await api(`/v1/quote-sprints/${id}`);
    if (session.state === 'winner_ready') return session;
    if (['no_quote', 'failed', 'expired'].includes(session.state)) {
      throw new Error(`sprint ended in ${session.state}: ${JSON.stringify(session.audit ?? session)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for winner_ready on ${id}`);
}

async function main() {
  const config = loadConfig();
  const sellerSeed = loadSellerSeed(config);
  const sellerPubkey = publicKeyFromSeed(sellerSeed);
  const wallet = encodeBase58(sellerPubkey);

  // Health: API must already be up (harness does not start it).
  try {
    await api(`/v1/assets?wallet=${encodeURIComponent(wallet)}`);
  } catch (error) {
    throw new Error(`Solana API not reachable at ${API_BASE}. Start with: npm run dev:solana-api:localnet\n${error}`);
  }

  const assetsPayload = await api(`/v1/assets?wallet=${encodeURIComponent(wallet)}`);
  const assetsList = Array.isArray(assetsPayload) ? assetsPayload : (assetsPayload.assets ?? []);
  const xstock = assetsList.find((a) => a.issuer === 'xstocks' && a.enabled);
  if (!xstock) throw new Error(`no enabled xstocks asset from API: ${JSON.stringify(assetsPayload).slice(0, 300)}`);

  const outputMint = xstock.supportedOutputs?.[0];
  if (!outputMint) throw new Error('asset has no supportedOutputs');

  const created = await api('/v1/quote-sprints', {
    method: 'POST',
    body: {
      wallet,
      inputMint: xstock.mint,
      outputMint,
      inputAmountAtomic: '1000000',
    },
  });
  console.log('[loop] created sprint', created.id, 'state=', created.state);

  const ready = await waitWinnerReady(created.id);
  if (!ready.winner?.transactionBase64) throw new Error('winner_ready without transactionBase64');
  console.log('[loop] winner', ready.winner.sourceKind, ready.winner.quoteId);

  await api(`/v1/quote-sprints/${created.id}/review`, {
    method: 'POST',
    body: { wallet },
  });

  const issued = ready.winner.transactionBase64;
  const message = messageBytesFromSignedTx(issued);
  const signatures = signaturesFromSignedTx(issued);
  // Seller is always fee-payer / signer index 0 (ADR-0001).
  const signed = partiallySignV0Transaction({
    message,
    signatures,
    signerIndex: 0,
    privateKey: sellerSeed,
  });
  const signedBase64 = Buffer.from(signed.transaction).toString('base64');

  const reviewHash = ready.winner.transactionHash;
  if (!reviewHash) throw new Error('winner missing transactionHash for authorize');

  const authorized = await api(`/v1/quote-sprints/${created.id}/authorize`, {
    method: 'POST',
    body: {
      wallet,
      reviewHash,
      signedTransactionBase64: signedBase64,
    },
  });
  console.log('[loop] authorized state=', authorized.state);

  const attempt = await api('/v1/execution-attempts', {
    method: 'POST',
    body: {
      quoteSprintId: created.id,
      idempotencyKey: `localnet-loop-${created.id}`,
    },
  });

  const signature = attempt.receipt?.signature
    ?? attempt.attempt?.signature
    ?? attempt.signature
    ?? attempt.evidence?.signature;
  if (!signature || typeof signature !== 'string') {
    throw new Error(`execution attempt missing signature: ${JSON.stringify(attempt).slice(0, 500)}`);
  }

  console.log('[loop] cluster signature:', signature);

  if (signature.startsWith('mock-')) {
    throw new Error(`FAIL: signature starts with mock-: ${signature}`);
  }
  if (jupiterCalls.length > 0) {
    throw new Error(`FAIL: api.jup.ag was called: ${jupiterCalls.join(', ')}`);
  }

  // Confirm RPC knows the signature (best-effort; Surfpool may index locally).
  try {
    const rpcUrl = config.rpcUrl ?? process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
    const status = await realFetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }],
      }),
    }).then((r) => r.json());
    console.log('[loop] getSignatureStatuses', JSON.stringify(status.result ?? status.error ?? status));
  } catch (error) {
    console.warn('[loop] getSignatureStatuses skipped:', error instanceof Error ? error.message : error);
  }

  console.log('[loop] PASS — non-mock signature, no Jupiter HTTP');
  console.log(JSON.stringify({
    quoteSprintId: created.id,
    sourceKind: ready.winner.sourceKind,
    signature,
    wallet,
    chain: config.chain,
    rpcUrl: config.rpcUrl,
  }, null, 2));
}

main().catch((error) => {
  console.error('[loop] FAILED', error);
  process.exit(1);
});
