import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encodeBase58 } from '@katon/solana-core';
import type { IncomingMessage, ServerResponse } from 'node:http';

function makeIdentity(role: 'maker' | 'operator', makerId?: string) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = encodeBase58(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  return { publicKey, privateKey: pair.privateKey, config: { publicKey, role, ...(makerId ? { makerId } : {}) } };
}

async function importRoutes(identities: ReturnType<typeof makeIdentity>[]) {
  vi.resetModules();
  process.env.SOLANA_API_AUTOSTART = 'false';
  process.env.SOLANA_ROLE_IDENTITIES = JSON.stringify(identities.map((identity) => identity.config));
  process.env.SOLANA_ROLE_SESSION_SECRET = 'test-role-session-secret-with-enough-length';
  process.env.SOLANA_RPC_URL = '';
  process.env.SOLANA_CLUSTER = '';
  delete process.env.SOLANA_DEPLOYMENT_MANIFEST;
  return import('../apps/solana-api/src/server');
}

function request(method: string, url: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = {
    method, url, headers,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
  };
  let resolve!: (value: { status: number; body: unknown }) => void;
  const done = new Promise<{ status: number; body: unknown }>((accept) => { resolve = accept; });
  const headersOut: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) { headersOut[name] = value; },
    end(value?: string) { resolve({ status: this.statusCode, body: value ? JSON.parse(value) : undefined }); },
  };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, done };
}

async function invoke(server: { route: typeof import('../apps/solana-api/src/server')['route'] }, method: string, path: string, body?: unknown, token?: string) {
  const call = request(method, path, body, token);
  server.route(call.req, call.res);
  return call.done;
}

async function session(server: { route: typeof import('../apps/solana-api/src/server')['route'] }, identity: ReturnType<typeof makeIdentity>, role: 'maker' | 'operator') {
  const challengeResult = await invoke(server, 'POST', '/v1/role-sessions/challenge', { publicKey: identity.publicKey, role });
  expect(challengeResult.status).toBe(200);
  const challenge = challengeResult.body as { challengeId: string; message: string };
  const signature = sign(null, Buffer.from(challenge.message), identity.privateKey).toString('base64url');
  const created = await invoke(server, 'POST', '/v1/role-sessions', { publicKey: identity.publicKey, role, challengeId: challenge.challengeId, signature });
  expect(created.status).toBe(201);
  return (created.body as { token: string }).token;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SOLANA_API_AUTOSTART;
  delete process.env.SOLANA_ROLE_IDENTITIES;
  delete process.env.SOLANA_ROLE_SESSION_SECRET;
  delete process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_CLUSTER;
  delete process.env.SOLANA_DEPLOYMENT_MANIFEST;
  vi.resetModules();
});

describe('maker and operator HTTP authorization through the in-process route', () => {
  it('rejects maker advertisements that claim disabled assets or unsupported outputs', async () => {
    const server = await importRoutes([]);
    const { demoAssets } = await import('../apps/solana-api/src/registry');
    const approved = { inputMint: demoAssets[0]!.mint, outputMint: demoAssets[0]!.supportedOutputs[0]!, minInputAtomic: '1', maxInputAtomic: '1000000' };
    expect(server.parseMakerCapabilities([approved])).toEqual([approved]);
    expect(() => server.parseMakerCapabilities([{ ...approved, inputMint: demoAssets[1]!.mint }])).toThrow('not enabled');
    expect(() => server.parseMakerCapabilities([{ ...approved, outputMint: 'lookalike-usdc' }])).toThrow('not enabled');
    expect(() => server.parseMakerCapabilities([{ ...approved, extra: 'enable' }])).toThrow('unknown fields');
  });

  it('keeps maker and operator endpoints role-scoped and returns unavailable reader states', async () => {
    const maker = makeIdentity('maker', 'maker-private-1');
    const operator = makeIdentity('operator');
    const server = await importRoutes([maker, operator]);
    const makerToken = await session(server, maker, 'maker');
    const operatorToken = await session(server, operator, 'operator');

    expect((await invoke(server, 'GET', '/v1/makers/me')).status).toBe(400);
    expect((await invoke(server, 'GET', '/v1/operator', undefined, makerToken)).status).toBe(400);
    expect((await invoke(server, 'GET', '/v1/makers/me', undefined, operatorToken)).status).toBe(400);
    const makerResponse = await invoke(server, 'GET', '/v1/makers/me', undefined, makerToken);
    expect(makerResponse.status).toBe(200);
    expect(makerResponse.body).toMatchObject({ maker: { makerId: 'maker-private-1' }, receipts: [] });

    const operatorResponse = await invoke(server, 'GET', '/v1/operator', undefined, operatorToken);
    expect(operatorResponse.status).toBe(200);
    expect(operatorResponse.body).toMatchObject({
      onChain: { registry: { status: 'unavailable' }, pauses: { status: 'unavailable' }, governanceChanges: { status: 'unavailable' } },
      programEvidence: { status: 'unavailable', reason: 'deployment manifest path is not configured' },
    });
    expect(JSON.stringify(operatorResponse.body)).not.toContain('governance action');
  });

  it('returns only the authenticated maker’s private receipts without seller wallets or transaction bytes', async () => {
    const makerOne = makeIdentity('maker', 'maker-one');
    const makerTwo = makeIdentity('maker', 'maker-two');
    const server = await importRoutes([makerOne, makerTwo]);
    const tokenOne = await session(server, makerOne, 'maker');
    const tokenTwo = await session(server, makerTwo, 'maker');
    const receiptOne = {
      tradeId: 'fill-one', quoteId: 'quote-one', wallet: 'seller-wallet-one', signature: 'signature-one',
      sourceKind: 'private-maker', sourceId: 'maker-one', inputMint: 'stock', outputMint: 'stable',
      inputAmountAtomic: '100', grossOutputAtomic: '200', netOutputAtomic: '198', katonFeeAtomic: '0',
      venueFeeAtomic: '2', createdAtMs: 1, submittedAtMs: 2, confirmedAtMs: 3, commitment: 'confirmed',
    };
    const receiptTwo = { ...receiptOne, tradeId: 'fill-two', quoteId: 'quote-two', wallet: 'seller-wallet-two', sourceId: 'maker-two' };
    vi.spyOn(server.desk, 'listMakerTrades').mockImplementation((makerId) => (makerId === 'maker-one' ? [receiptOne] : [receiptTwo]) as never);

    const one = await invoke(server, 'GET', '/v1/makers/me', undefined, tokenOne);
    const two = await invoke(server, 'GET', '/v1/makers/me', undefined, tokenTwo);
    expect(one.body).toMatchObject({ maker: { makerId: 'maker-one' }, receipts: [{ tradeId: 'fill-one', quoteId: 'quote-one' }] });
    expect(two.body).toMatchObject({ maker: { makerId: 'maker-two' }, receipts: [{ tradeId: 'fill-two', quoteId: 'quote-two' }] });
    expect(JSON.stringify(one.body)).not.toContain('seller-wallet');
    expect(JSON.stringify(two.body)).not.toContain('seller-wallet');
    expect(JSON.stringify([one.body, two.body])).not.toContain('transactionBase64');
  });

  it('lets an authenticated operator stop intake without exposing a governance write route', async () => {
    const maker = makeIdentity('maker', 'maker-to-disable');
    const operator = makeIdentity('operator');
    const server = await importRoutes([maker, operator]);
    const token = await session(server, operator, 'operator');
    const makerToken = await session(server, maker, 'maker');
    expect((await invoke(server, 'POST', '/v1/operator/quote-sprints/stop', undefined, token)).status).toBe(200);
    expect((await invoke(server, 'POST', '/v1/operator/makers/maker-to-disable/disable', undefined, makerToken)).status).toBe(400);
    expect((await invoke(server, 'POST', '/v1/operator/makers/maker-to-disable/disable', undefined, token)).status).toBe(200);
    expect((await invoke(server, 'POST', '/v1/operator/sources/jupiter-meta-aggregator/disable', undefined, token)).status).toBe(200);
    expect((await invoke(server, 'GET', '/v1/operator', undefined, token)).body).toMatchObject({
      sources: expect.arrayContaining([expect.objectContaining({ sourceId: 'jupiter-meta-aggregator', sourceKind: 'jupiter', enabled: false })]),
    });
    expect((await invoke(server, 'GET', '/v1/makers/me', undefined, makerToken)).body).toMatchObject({ maker: { enabled: false } });
    expect((await invoke(server, 'POST', '/v1/operator/governance/apply', {}, token)).status).toBe(404);
    expect((await invoke(server, 'POST', '/v1/operator/governance/queue', {}, token)).status).toBe(404);
    expect((await invoke(server, 'POST', '/v1/operator/squads/execute', {}, token)).status).toBe(404);
    expect((await invoke(server, 'POST', '/v1/operator/sources/jupiter-meta-aggregator/enable', {}, token)).status).toBe(404);
    expect((await invoke(server, 'POST', '/v1/operator/liquidation/enable', {}, token)).status).toBe(404);
    expect((await invoke(server, 'GET', '/v1/operator', undefined, token)).body).toMatchObject({ sprints: 'stopped' });
  });

  it('reports Maker self-disable separately from Operator source disable', async () => {
    const maker = makeIdentity('maker', 'maker-self-disable');
    const operator = makeIdentity('operator');
    const server = await importRoutes([maker, operator]);
    const makerToken = await session(server, maker, 'maker');
    const operatorToken = await session(server, operator, 'operator');

    expect((await invoke(server, 'POST', '/v1/makers/me/disable', undefined, makerToken)).status).toBe(200);
    const afterSelfDisable = await invoke(server, 'GET', '/v1/operator', undefined, operatorToken);
    expect(afterSelfDisable.body).toMatchObject({
      makers: [expect.objectContaining({ makerId: 'maker-self-disable', selfDisabled: true, operatorDisabled: false })],
      sources: expect.arrayContaining([expect.objectContaining({
        sourceId: 'maker-self-disable', sourceKind: 'private-maker', enabled: false, operatorDisabled: false,
      })]),
    });

    expect((await invoke(server, 'POST', '/v1/operator/makers/maker-self-disable/disable', undefined, operatorToken)).status).toBe(200);
    const afterOperatorDisable = await invoke(server, 'GET', '/v1/operator', undefined, operatorToken);
    expect(afterOperatorDisable.body).toMatchObject({
      makers: [expect.objectContaining({ makerId: 'maker-self-disable', selfDisabled: true, operatorDisabled: true })],
      sources: expect.arrayContaining([expect.objectContaining({
        sourceId: 'maker-self-disable', sourceKind: 'private-maker', enabled: false, operatorDisabled: true,
      })]),
    });
  });

  it('keeps private maker bytes and identities out of public Quote Sprint events', async () => {
    const server = await importRoutes([]);
    const snapshot = {
      id: 'sprint-private', state: 'winner_ready',
      request: { wallet: 'seller-private', inputMint: 'stock', outputMint: 'stable', inputAmountAtomic: '100' },
      winner: { sourceId: 'maker-private', transactionBase64: 'signed-private-bytes', quoteId: 'maker-private-quote' },
      audit: [{ sourceId: 'losing-maker-private' }],
    };
    vi.spyOn(server.desk, 'getQuoteSprint').mockReturnValue(snapshot as never);
    vi.spyOn(server.desk, 'subscribe').mockImplementation((_id, listener) => {
      listener(snapshot as never);
      return () => undefined;
    });

    const chunks: string[] = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const req = { method: 'GET', url: '/v1/quote-sprints/sprint-private/events', headers: {}, on: () => undefined } as unknown as IncomingMessage;
    const res = {
      statusCode: 200,
      setHeader: () => undefined,
      write: (chunk: string) => { chunks.push(chunk); },
      end: () => { finish(); },
    } as unknown as ServerResponse;
    server.route(req, res);
    await done;

    const event = chunks.join('');
    expect(event).toContain('event: winner_ready');
    expect(event).toContain('"id":"sprint-private"');
    expect(event).not.toMatch(/seller-private|maker-private|signed-private-bytes|losing-maker-private/);
  });
});
