import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MemoryAssetProvider, MockQuoteSimulationProvider, QuoteDeskService } from './service';
import { MemorySourceBalanceProvider, MockJupiterSource, MockOndoManagedSource, MockPrivateMakerSource, MockSender } from './sources';
import { demoAssets } from './registry';
import type { QuoteSessionRequest } from '@katon/solana-core';

const port = Number(process.env.SOLANA_API_PORT ?? 8787);
const assets = new MemoryAssetProvider(demoAssets);
assets.setBalance('demo-wallet', demoAssets[0].mint, '2500000');
assets.setBalance('demo-wallet', demoAssets[1].mint, '2500000');
const sender = new MockSender();
const sourceBalances = new MemorySourceBalanceProvider();
for (const outputMint of [demoAssets[0].supportedOutputs[0], demoAssets[0].supportedOutputs[1]]) {
  sourceBalances.setBalance('maker-sandbox-01', outputMint, '1000000000000');
  sourceBalances.setBalance('ondo-managed-sandbox-01', outputMint, '1000000000000000');
}
export const desk = new QuoteDeskService(assets, [new MockJupiterSource(), new MockPrivateMakerSource(), new MockOndoManagedSource()], sender, sender, Date.now, new MockQuoteSimulationProvider(), sourceBalances);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('access-control-allow-origin', process.env.SOLANA_API_ORIGIN ?? '*');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${key} must be a non-empty string`);
  return field;
}
function parseRequest(value: unknown): QuoteSessionRequest {
  if (!isRecord(value)) throw new Error('request body must be an object');
  const request = { wallet: stringField(value, 'wallet'), inputMint: stringField(value, 'inputMint'), outputMint: stringField(value, 'outputMint'), inputAmountAtomic: stringField(value, 'inputAmountAtomic') };
  if (Object.keys(value).some((key) => !['wallet', 'inputMint', 'outputMint', 'inputAmountAtomic'].includes(key))) throw new Error('unknown request field');
  return request;
}

function route(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  void (async () => {
    try {
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.setHeader('access-control-allow-origin', process.env.SOLANA_API_ORIGIN ?? '*');
        response.setHeader('access-control-allow-headers', 'content-type');
        response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        response.end();
        return;
      }
      if (request.method === 'GET' && parts.join('/') === 'v1/assets') {
        const wallet = url.searchParams.get('wallet') ?? '';
        const outputMint = url.searchParams.get('outputMint') ?? '';
        json(response, 200, desk.listAssets(wallet, outputMint));
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/quote-sessions') {
        json(response, 201, await desk.createSession(parseRequest(await readJson(request))));
        return;
      }
      if (parts[0] === 'v1' && parts[1] === 'quote-sessions' && parts[2]) {
        const id = parts[2];
        if (request.method === 'GET' && parts.length === 3) { json(response, 200, desk.getSession(id)); return; }
        if (request.method === 'GET' && parts[3] === 'events') {
          // Resolve the session before switching protocols so a typo cannot
          // leave a client with an SSE connection that waits forever.
          desk.getSession(id);
          response.statusCode = 200;
          response.setHeader('access-control-allow-origin', process.env.SOLANA_API_ORIGIN ?? '*');
          response.setHeader('content-type', 'text/event-stream; charset=utf-8');
          response.setHeader('cache-control', 'no-cache');
          response.setHeader('connection', 'keep-alive');
          const terminalStates = new Set(['no_quote', 'expired', 'failed', 'finalized']);
          let closed = false;
          let unsubscribe = (): void => undefined;
          const onSession = (session: ReturnType<QuoteDeskService['getSession']>): void => {
            if (closed) return;
            response.write(`event: ${session.state}\ndata: ${JSON.stringify(session)}\n\n`);
            if (terminalStates.has(session.state)) {
              closed = true;
              unsubscribe();
              response.end();
            }
          };
          unsubscribe = desk.subscribe(id, onSession);
          // subscribe() may synchronously deliver a terminal snapshot. In
          // that case the callback ran before the unsubscribe handle existed.
          if (closed) unsubscribe();
          request.on('close', () => {
            closed = true;
            unsubscribe();
          });
          return;
        }
        if (request.method === 'POST' && parts[3] === 'execute') {
          const body = await readJson(request);
          if (!isRecord(body)) throw new Error('request body must be an object');
          if (Object.keys(body).some((key) => !['wallet', 'signedTransactionBase64'].includes(key))) throw new Error('unknown execute field');
          const wallet = stringField(body, 'wallet');
          const signedTransactionBase64 = stringField(body, 'signedTransactionBase64');
          json(response, 200, await desk.execute(id, wallet, signedTransactionBase64));
          return;
        }
        if (request.method === 'POST' && parts[3] === 'review') {
          const body = await readJson(request);
          if (!isRecord(body)) throw new Error('request body must be an object');
          if (Object.keys(body).some((key) => key !== 'wallet')) throw new Error('unknown review field');
          json(response, 200, await desk.review(id, stringField(body, 'wallet')));
          return;
        }
      }
      if (request.method === 'GET' && parts.join('/') === 'v1/trades') {
        json(response, 200, desk.listTrades(url.searchParams.get('wallet') ?? ''));
        return;
      }
      json(response, 404, { message: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      json(response, message === 'quote session not found' || message === 'asset is not present in the signed registry' ? 404 : 400, { message });
    }
  })();
}

if (process.env.SOLANA_API_AUTOSTART !== 'false') {
  createServer(route).listen(port, () => console.log(`Solana desk API listening on http://localhost:${port}`));
}
