import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encodeBase58 } from '@katon/solana-core';
import type { IncomingMessage, ServerResponse } from 'node:http';

const origin = 'http://localhost:5173';
const cluster = 'localnet';

function identity() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = encodeBase58(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  return { publicKey, privateKey: pair.privateKey };
}

async function importRoutes() {
  vi.resetModules();
  process.env.SOLANA_API_AUTOSTART = 'false';
  process.env.SOLANA_CLUSTER = cluster;
  process.env.SOLANA_API_ORIGIN = origin;
  process.env.SOLANA_SELLER_SESSION_SECRET = 'test-seller-session-secret-with-enough-entropy';
  process.env.SOLANA_RPC_URL = '';
  delete process.env.SOLANA_ROLE_IDENTITIES;
  delete process.env.SOLANA_DEPLOYMENT_MANIFEST;
  return import('../apps/solana-api/src/server');
}

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const requestHeaders = { host: 'localhost:8787', ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  const req = {
    method,
    url,
    headers: requestHeaders,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
  };
  let resolve!: (value: { status: number; body: unknown }) => void;
  const done = new Promise<{ status: number; body: unknown }>((accept) => { resolve = accept; });
  const res = {
    statusCode: 200,
    setHeader() {},
    end(value?: string) { resolve({ status: this.statusCode, body: value ? JSON.parse(value) : undefined }); },
  };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, done };
}

async function invoke(
  server: { route: typeof import('../apps/solana-api/src/server')['route'] },
  method: string,
  path: string,
  body?: unknown,
  options: { readonly token?: string; readonly wallet?: string; readonly origin?: string; readonly sellerOrigin?: string; readonly cluster?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.sellerOrigin !== undefined) headers['x-katon-origin'] = options.sellerOrigin;
  if (options.cluster !== undefined) headers['x-katon-cluster'] = options.cluster;
  const call = request(method, path, body, headers);
  server.route(call.req, call.res);
  return call.done;
}

async function authenticate(server: { route: typeof import('../apps/solana-api/src/server')['route'] }, seller: ReturnType<typeof identity>) {
  const challengeResult = await invoke(server, 'POST', '/v1/seller-sessions/challenge', { publicKey: seller.publicKey }, { origin, cluster });
  expect(challengeResult.status).toBe(200);
  const challenge = challengeResult.body as { readonly challengeId: string; readonly message: string };
  const signature = sign(null, Buffer.from(challenge.message), seller.privateKey).toString('base64url');
  const created = await invoke(server, 'POST', '/v1/seller-sessions', {
    publicKey: seller.publicKey,
    challengeId: challenge.challengeId,
    signature,
  }, { origin, cluster });
  expect(created.status).toBe(201);
  return (created.body as { readonly token: string }).token;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ['SOLANA_API_AUTOSTART', 'SOLANA_CLUSTER', 'SOLANA_API_ORIGIN', 'SOLANA_SELLER_SESSION_SECRET', 'SOLANA_RPC_URL', 'SOLANA_ROLE_IDENTITIES', 'SOLANA_DEPLOYMENT_MANIFEST']) delete process.env[key];
  vi.resetModules();
});

describe('Seller proof on HTTP routes', () => {
  it('requires a Seller session for every wallet-scoped read and Quote Sprint read/write', async () => {
    const server = await importRoutes();
    const seller = identity();
    const wallet = seller.publicKey;
    const { demoAssets } = await import('../apps/solana-api/src/registry');
    const quoteRequest = {
      wallet,
      inputMint: demoAssets[0]!.mint,
      outputMint: demoAssets[0]!.supportedOutputs[0]!,
      inputAmountAtomic: '100000',
    };
    const sprint = {
      id: 'private-sprint',
      request: quoteRequest,
      state: 'winner_ready',
      winner: { sourceId: 'private-maker-1', transactionBase64: 'signed-winner-bytes-must-require-proof' },
      audit: [],
    };
    const create = vi.spyOn(server.desk, 'createQuoteSprint').mockResolvedValue(sprint as never);
    vi.spyOn(server.desk, 'getQuoteSprint').mockReturnValue(sprint as never);
    const review = vi.spyOn(server.desk, 'review').mockResolvedValue(sprint as never);
    const authorize = vi.spyOn(server.desk, 'authorize').mockResolvedValue(sprint as never);
    const execute = vi.spyOn(server.desk, 'createExecutionAttempt').mockResolvedValue({ attempt: { id: 'attempt-1', quoteSprintId: 'private-sprint', state: 'confirmed' } } as never);

    const requests = [
      invoke(server, 'GET', `/v1/assets?wallet=${encodeURIComponent(wallet)}`),
      invoke(server, 'GET', `/v1/trades?wallet=${encodeURIComponent(wallet)}`),
      invoke(server, 'POST', '/v1/quote-sprints', quoteRequest),
      invoke(server, 'GET', '/v1/quote-sprints/private-sprint'),
      invoke(server, 'POST', '/v1/quote-sprints/private-sprint/review', { wallet }),
      invoke(server, 'POST', '/v1/quote-sprints/private-sprint/authorize', { wallet, reviewHash: 'review-hash', signedTransactionBase64: 'signed-bytes' }),
      invoke(server, 'POST', '/v1/execution-attempts', { quoteSprintId: 'private-sprint', idempotencyKey: 'attempt-1' }),
    ];
    const results = await Promise.all(requests);
    expect(results.map(({ status }) => status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
    expect(create).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts matching proof on Seller routes and rejects cross-wallet, cross-origin, and cross-cluster reuse', async () => {
    const server = await importRoutes();
    const seller = identity();
    const otherSeller = identity();
    const wallet = seller.publicKey;
    const { demoAssets } = await import('../apps/solana-api/src/registry');
    const quoteRequest = {
      wallet,
      inputMint: demoAssets[0]!.mint,
      outputMint: demoAssets[0]!.supportedOutputs[0]!,
      inputAmountAtomic: '100000',
    };
    const sprint = {
      id: 'private-sprint', request: quoteRequest, state: 'winner_ready',
      winner: { sourceId: 'private-maker-1', transactionBase64: 'full-signed-winner-bytes' }, audit: [],
    };
    vi.spyOn(server.desk, 'createQuoteSprint').mockResolvedValue(sprint as never);
    vi.spyOn(server.desk, 'getQuoteSprint').mockReturnValue(sprint as never);
    vi.spyOn(server.desk, 'review').mockResolvedValue(sprint as never);
    vi.spyOn(server.desk, 'authorize').mockResolvedValue(sprint as never);
    const execute = vi.spyOn(server.desk, 'createExecutionAttempt')
      .mockResolvedValueOnce({
        attempt: { id: 'attempt-1', quoteSprintId: 'private-sprint', state: 'confirmed', signature: 'settlement-signature' },
        receipt: {
          tradeId: 'trade-1', quoteId: 'quote-1', wallet, signature: 'settlement-signature', sourceKind: 'private-maker', sourceId: 'maker-sandbox-01',
          inputMint: 'stock-mint', outputMint: 'stable-mint', inputAmountAtomic: '100', grossOutputAtomic: '200', netOutputAtomic: '199',
          katonFeeAtomic: '1', venueFeeAtomic: '1', createdAtMs: 1, submittedAtMs: 2, confirmedAtMs: 3, commitment: 'confirmed',
          cluster: 'solana:localnet', slot: 12, stockMint: 'stock-mint', stableMint: 'stable-mint', stockTokenProgram: 'spl-token',
          stableTokenProgram: 'spl-token', sellerStockDeltaAtomic: '-100', makerStockDeltaAtomic: '100', makerStableDeltaAtomic: '-200',
          sellerStableDeltaAtomic: '199', feeStableDeltaAtomic: '1', fillReceipt: 'fill-receipt',
        },
      } as never)
      .mockResolvedValueOnce({
        attempt: { id: 'attempt-2', quoteSprintId: 'private-sprint', state: 'reconciling', signature: 'uncertain-signature', failureMessage: 'submission outcome unknown' },
      } as never);
    const token = await authenticate(server, seller);
    const proof = { token, origin, cluster };

    expect((await invoke(server, 'GET', `/v1/assets?wallet=${encodeURIComponent(wallet)}`, undefined, proof)).status).toBe(200);
    // Same-origin browser GET requests can omit Origin; the deployment pin
    // supplies the bound application origin in that case.
    expect((await invoke(server, 'GET', `/v1/trades?wallet=${encodeURIComponent(wallet)}`, undefined, { token, cluster })).status).toBe(200);
    expect((await invoke(server, 'GET', `/v1/trades?wallet=${encodeURIComponent(wallet)}`, undefined, { token, cluster, sellerOrigin: origin })).status).toBe(200);
    expect((await invoke(server, 'GET', `/v1/trades?wallet=${encodeURIComponent(wallet)}`, undefined, proof)).status).toBe(200);
    expect((await invoke(server, 'POST', '/v1/quote-sprints', quoteRequest, proof)).status).toBe(201);

    const fullSprint = await invoke(server, 'GET', '/v1/quote-sprints/private-sprint', undefined, proof);
    expect(fullSprint.status).toBe(200);
    expect(fullSprint.body).toMatchObject({ winner: { transactionBase64: 'full-signed-winner-bytes' } });

    expect((await invoke(server, 'POST', '/v1/quote-sprints/private-sprint/review', { wallet }, proof)).status).toBe(200);
    expect((await invoke(server, 'POST', '/v1/quote-sprints/private-sprint/authorize', { wallet, reviewHash: 'review-hash', signedTransactionBase64: 'signed-bytes' }, proof)).status).toBe(200);
    const settled = await invoke(server, 'POST', '/v1/execution-attempts', { quoteSprintId: 'private-sprint', idempotencyKey: 'attempt-1' }, proof);
    expect(settled.status).toBe(201);
    expect(settled.body).toMatchObject({ attemptId: 'attempt-1', quoteSprintId: 'private-sprint', status: 'final', signature: 'settlement-signature', receipt: { slot: 12, sellerStockDeltaAtomic: '-100', fillReceipt: 'fill-receipt' } });
    const reconciling = await invoke(server, 'POST', '/v1/execution-attempts', { quoteSprintId: 'private-sprint', idempotencyKey: 'attempt-2' }, proof);
    expect(reconciling.status).toBe(201);
    expect(reconciling.body).toMatchObject({ attemptId: 'attempt-2', status: 'reconciling', signature: 'uncertain-signature', failureMessage: 'submission outcome unknown' });
    expect(reconciling.body).not.toHaveProperty('receipt');
    expect(execute).toHaveBeenCalledTimes(2);

    expect((await invoke(server, 'GET', `/v1/assets?wallet=${encodeURIComponent(otherSeller.publicKey)}`, undefined, proof)).status).toBe(401);
    expect((await invoke(server, 'GET', '/v1/quote-sprints/private-sprint', undefined, { ...proof, origin: 'http://localhost:5174' })).status).toBe(401);
    expect((await invoke(server, 'GET', '/v1/quote-sprints/private-sprint', undefined, { ...proof, origin: 'http://localhost:5174', sellerOrigin: origin })).status).toBe(401);
    expect((await invoke(server, 'GET', '/v1/quote-sprints/private-sprint', undefined, { ...proof, origin, sellerOrigin: 'http://localhost:5174' })).status).toBe(401);
    expect((await invoke(server, 'GET', '/v1/quote-sprints/private-sprint', undefined, { ...proof, sellerOrigin: 'http://localhost:5174' })).status).toBe(401);
    expect((await invoke(server, 'GET', '/v1/quote-sprints/private-sprint', undefined, { ...proof, cluster: 'devnet' })).status).toBe(401);
  });
});
