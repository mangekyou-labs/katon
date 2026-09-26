import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { transactionHash, validateMakerPartialTransaction } from '@katon/solana-sdk';
import { validateMakerSettlement } from './maker-settlement';
import { MemoryAssetProvider, MockQuoteSimulationProvider, QuoteDeskService } from './service';
import { HeadlessPrivateMakerSource, JupiterStubSource, MemorySourceBalanceProvider, StreamedMakerSource, TrustedRpcSender } from './sources';
import { demoAssets } from './registry';
import { loadLocalnetFixtureConfig, loadMakerSecretKey, LocalnetAssetProvider, LocalnetQuoteSimulationProvider, LocalnetRpcClient, LocalnetSourceBalanceProvider } from './localnet-runtime';
import { DeskOperatorControls, loadProvisionedRoleIdentities, RoleSessionService, verifyProvisionedSignature, type DeskRole, type MakerCapability, type RoleSessionClaims } from './roles';
import { createSolanaOperatorEvidenceReaderFromEnv } from './operator-evidence';
import { governedMakerIds } from './governance-observation';
import { SellerSessionService, type SellerCluster } from './seller-auth';
import { createLiveReferencePolicyProviderFromEnv } from './live-reference-policy';
import type { QuoteSessionRequest } from '@katon/solana-core';

const port = Number(process.env.SOLANA_API_PORT ?? 8787);
const localnetFixture = process.env.KATON_LOCALNET === '1' ? loadLocalnetFixtureConfig() : undefined;
const localnetRpc = localnetFixture ? new LocalnetRpcClient(localnetFixture) : undefined;
// The local Surfpool settlement asset is a synthetic test fixture. Keep it
// out of the website unless a dedicated automated test opts in explicitly.
const localnetTestFixtureAssetsEnabled = process.env.KATON_LOCALNET_TEST_FIXTURE_ASSETS === '1';
const assets = localnetFixture && localnetRpc && localnetTestFixtureAssetsEnabled
  ? new LocalnetAssetProvider(localnetFixture, localnetRpc)
  : new MemoryAssetProvider(process.env.NODE_ENV === 'test' ? demoAssets : []);
const localnetAssets = assets instanceof LocalnetAssetProvider ? assets : undefined;

const maker = localnetFixture && localnetRpc
  ? new HeadlessPrivateMakerSource(loadMakerSecretKey(localnetFixture.makerKeypairPath), { fixture: localnetFixture, rpc: localnetRpc })
  : new HeadlessPrivateMakerSource();
const sender = new TrustedRpcSender(process.env.SOLANA_RPC_URL ?? localnetFixture?.rpcUrl ?? 'http://127.0.0.1:8899', { simulateFirst: true }, localnetRpc);
const sourceBalances = localnetRpc ? new LocalnetSourceBalanceProvider(localnetRpc) : new MemorySourceBalanceProvider();
if (!localnetRpc && sourceBalances instanceof MemorySourceBalanceProvider) {
  for (const outputMint of [demoAssets[0].supportedOutputs[0], demoAssets[0].supportedOutputs[1]]) {
    sourceBalances.setBalance('maker-sandbox-01', outputMint, '1000000000000');
  }
}
// The offline localnet harness uses an explicitly labeled deterministic
// reference fixture. Every hosted or remote cluster still requires the live
// licensed primary and independent cross-check providers.
const referencePolicyProvider = localnetTestFixtureAssetsEnabled
  && process.env.KATON_LOCALNET === '1'
  && (process.env.SOLANA_CLUSTER?.trim() || 'localnet') === 'localnet'
  ? undefined
  : createLiveReferencePolicyProviderFromEnv();
export const desk = new QuoteDeskService(
  assets,
  [new JupiterStubSource(), maker],
  sender,
  sender,
  Date.now,
  localnetRpc ? new LocalnetQuoteSimulationProvider(localnetRpc) : new MockQuoteSimulationProvider(),
  sourceBalances,
  undefined,
  referencePolicyProvider,
);
if (localnetFixture && localnetRpc && localnetTestFixtureAssetsEnabled) {
  await localnetRpc.assertGovernedFixture();
  desk.observeGovernedMaker('maker-sandbox-01', localnetFixture.makerPublicKey, true);
}
const roleIdentities = loadProvisionedRoleIdentities();
if (roleIdentities.length > 0 && !process.env.SOLANA_ROLE_SESSION_SECRET) throw new Error('SOLANA_ROLE_SESSION_SECRET is required when role identities are provisioned');
const roleSessions = new RoleSessionService(roleIdentities, process.env.SOLANA_ROLE_SESSION_SECRET ?? randomBytes(32).toString('base64url'));
const sellerCluster = (process.env.SOLANA_CLUSTER || (process.env.KATON_LOCALNET === '1' ? 'localnet' : 'devnet')) as SellerCluster;
const sellerSessions = new SellerSessionService(process.env.SOLANA_SELLER_SESSION_SECRET ?? process.env.SOLANA_ROLE_SESSION_SECRET ?? randomBytes(32).toString('base64url'), sellerCluster);
const operatorControls = new DeskOperatorControls(roleIdentities.filter((identity) => identity.role === 'maker').map((identity) => identity.makerId!));
const operatorEvidence = createSolanaOperatorEvidenceReaderFromEnv();
const makerClients = new Map<string, WebSocket>();
const streamedMakers = new Map<string, StreamedMakerSource>();
function registerStreamedMaker(makerId: string, publicKey: string): StreamedMakerSource {
  const streamed = new StreamedMakerSource(makerId, publicKey, (request, expiresAtMs, requestId) => {
    const client = makerClients.get(makerId);
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'quote_request', request, expiresAtMs, requestId }));
  });
  streamedMakers.set(makerId, streamed);
  desk.registerMakerSource(streamed, publicKey);
  return streamed;
}
function disableMakerSource(makerId: string, by: 'maker' | 'operator'): void {
  if (by === 'maker') operatorControls.selfDisable(makerId);
  else operatorControls.disableMaker(makerId);
  streamedMakers.get(makerId)?.setAvailable(false);
  desk.disableSource(makerId, by);
}
for (const identity of roleIdentities.filter((entry) => entry.role === 'maker')) {
  registerStreamedMaker(identity.makerId!, identity.publicKey);
}

async function observeGovernedMakerEnablement() {
  const evidence = await operatorEvidence.read();
  const enabledMakers = governedMakerIds(evidence, roleIdentities, sellerCluster);
  for (const identity of roleIdentities) {
    if (identity.role !== 'maker' || !identity.makerId) continue;
    const enabled = enabledMakers.has(identity.makerId);
    operatorControls.observeGovernedEnablement(identity.makerId, enabled);
    streamedMakers.get(identity.makerId)?.setGovernanceEnabled(enabled);
    desk.observeGovernedMaker(identity.makerId, identity.publicKey, enabled);
  }
  return evidence;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('access-control-allow-origin', process.env.SOLANA_API_ORIGIN ?? '*');
  response.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-katon-cluster, x-katon-origin');
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

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw new Error('role session is required');
  return header.slice(7);
}
function sellerBearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw new Error('Seller session is required');
  return header.slice(7);
}
function sellerOrigin(request: IncomingMessage): string {
  const origin = request.headers.origin;
  const claimedOrigin = request.headers['x-katon-origin'];
  if (typeof origin === 'string' && origin.length > 0) {
    if (typeof claimedOrigin === 'string' && claimedOrigin !== origin) throw new Error('Seller origin claim does not match the browser Origin header');
    return origin;
  }
  if (typeof claimedOrigin === 'string' && claimedOrigin.length > 0) return claimedOrigin;
  // Browsers may omit Origin on same-origin GET requests. In that case use
  // the deployment's configured application origin; cross-origin requests
  // still carry their actual Origin and are checked against the session.
  const configuredOrigin = process.env.SOLANA_API_ORIGIN;
  if (configuredOrigin) return configuredOrigin;
  throw new Error('Seller origin is required');
}
function sellerRequestCluster(request: IncomingMessage): string {
  const cluster = request.headers['x-katon-cluster'];
  if (typeof cluster !== 'string' || cluster.length === 0) throw new Error('Seller cluster is required');
  return cluster;
}
function authenticateSeller(request: IncomingMessage, expectedWallet: string): void {
  sellerSessions.authenticate(sellerBearer(request), expectedWallet, sellerOrigin(request), sellerRequestCluster(request));
}
function parseRole(value: unknown): DeskRole {
  if (value !== 'maker' && value !== 'operator') throw new Error('role must be maker or operator');
  return value;
}
export function parseMakerCapabilities(value: unknown): MakerCapability[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('maker capabilities must be an array of at most 32 entries');
  return value.map((item): MakerCapability => {
    if (!isRecord(item) || Object.keys(item).length !== 4 || Object.keys(item).some((key) => !['inputMint', 'outputMint', 'minInputAtomic', 'maxInputAtomic'].includes(key))) {
      throw new Error('maker capability contains missing or unknown fields');
    }
    const inputMint = stringField(item, 'inputMint');
    const outputMint = stringField(item, 'outputMint');
    const asset = assets.list().find((entry) => entry.mint === inputMint);
    if (!asset || !asset.enabled || asset.issuer !== 'xstocks' || !asset.supportedOutputs.includes(outputMint)) {
      throw new Error('maker capability is not enabled by the asset registry');
    }
    return { inputMint, outputMint, minInputAtomic: stringField(item, 'minInputAtomic'), maxInputAtomic: stringField(item, 'maxInputAtomic') };
  });
}
function canonicalMakerQuote(quote: Record<string, unknown>): string {
  const allowed = ['type', 'makerId', 'requestId', 'quoteId', 'wallet', 'inputMint', 'outputMint', 'inputAmountAtomic', 'outputAmountAtomic', 'feeBps', 'expiresAtMs', 'transactionHash', 'transactionBase64', 'signature'];
  if (Object.keys(quote).length !== allowed.length || Object.keys(quote).some((key) => !allowed.includes(key))) throw new Error('maker quote contains missing or unknown fields');
  const fields = ['makerId', 'requestId', 'quoteId', 'wallet', 'inputMint', 'outputMint', 'inputAmountAtomic', 'outputAmountAtomic', 'feeBps', 'expiresAtMs', 'transactionHash'];
  const values = fields.map((field) => quote[field]);
  if (values.slice(0, 7).some((value) => typeof value !== 'string' || value.length === 0)
    || !Number.isSafeInteger(quote.feeBps) || (quote.feeBps as number) < 0 || (quote.feeBps as number) > 25
    || !Number.isSafeInteger(quote.expiresAtMs)) throw new Error('maker quote commitment is malformed');
  return JSON.stringify(['Katon Private Maker Quote v0', ...values]);
}

export function route(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  void (async () => {
    try {
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.setHeader('access-control-allow-origin', process.env.SOLANA_API_ORIGIN ?? '*');
        response.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-katon-cluster, x-katon-origin');
        response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        response.end();
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/seller-sessions/challenge') {
        const body = await readJson(request);
        if (!isRecord(body) || Object.keys(body).some((key) => key !== 'publicKey')) throw new Error('Seller challenge body is invalid');
        json(response, 200, sellerSessions.createChallenge(stringField(body, 'publicKey'), sellerOrigin(request), sellerRequestCluster(request)));
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/seller-sessions') {
        const body = await readJson(request);
        if (!isRecord(body) || Object.keys(body).some((key) => !['publicKey', 'challengeId', 'signature'].includes(key))) throw new Error('Seller session body is invalid');
        json(response, 201, sellerSessions.createSession(stringField(body, 'publicKey'), sellerOrigin(request), sellerRequestCluster(request), stringField(body, 'challengeId'), stringField(body, 'signature')));
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/role-sessions/challenge') {
        const body = await readJson(request);
        if (!isRecord(body) || Object.keys(body).some((key) => !['publicKey', 'role'].includes(key))) throw new Error('challenge body is invalid');
        json(response, 200, roleSessions.createChallenge(stringField(body, 'publicKey'), parseRole(body.role)));
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/role-sessions') {
        const body = await readJson(request);
        if (!isRecord(body) || Object.keys(body).some((key) => !['publicKey', 'role', 'challengeId', 'signature'].includes(key))) throw new Error('session body is invalid');
        json(response, 201, roleSessions.createSession(stringField(body, 'publicKey'), parseRole(body.role), stringField(body, 'challengeId'), stringField(body, 'signature')));
        return;
      }
      if (request.method === 'GET' && parts.join('/') === 'v1/makers/me') {
        const identity = roleSessions.authenticate(bearer(request), 'maker');
        await observeGovernedMakerEnablement();
        const makerId = identity.makerId!;
        const receipts = desk.listMakerTrades(makerId).map(({ wallet: _sellerWallet, ...receipt }) => receipt);
        json(response, 200, { maker: operatorControls.makerStatus(makerId), receipts });
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/makers/me/disable') {
        const identity = roleSessions.authenticate(bearer(request), 'maker');
        disableMakerSource(identity.makerId!, 'maker');
        json(response, 200, { maker: operatorControls.makerStatus(identity.makerId!) });
        return;
      }
      if (request.method === 'GET' && parts.join('/') === 'v1/operator') {
        roleSessions.authenticate(bearer(request), 'operator');
        const evidence = await observeGovernedMakerEnablement();
        await desk.refreshReferencePolicy();
        json(response, 200, {
          ...operatorControls.operatorStatus({ sources: desk.operatorSourceStatus(), referencePolicy: desk.referencePolicyStatus() }),
          ...evidence,
        });
        return;
      }
      if (request.method === 'GET' && parts.join('/') === 'v1/reference-policy') {
        await desk.refreshReferencePolicy();
        json(response, 200, desk.referencePolicyStatus());
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/operator/quote-sprints/stop') {
        roleSessions.authenticate(bearer(request), 'operator');
        operatorControls.stopSprints();
        desk.stopNewQuoteSprints();
        json(response, 200, { sprints: 'stopped' });
        return;
      }
      if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'operator' && parts[2] === 'makers' && parts[3] && parts[4] === 'disable') {
        roleSessions.authenticate(bearer(request), 'operator');
        disableMakerSource(parts[3], 'operator');
        json(response, 200, { maker: operatorControls.makerStatus(parts[3]) });
        return;
      }
      if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'operator' && parts[2] === 'sources' && parts[3] && parts[4] === 'disable') {
        roleSessions.authenticate(bearer(request), 'operator');
        const source = desk.operatorSourceStatus().find((entry) => entry.sourceId === parts[3]);
        if (!source) throw new Error('source is not configured');
        if (source.sourceKind === 'private-maker') {
          disableMakerSource(parts[3], 'operator');
        } else desk.disableSource(parts[3]);
        json(response, 200, { sources: desk.operatorSourceStatus() });
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/operator/makers') {
        roleSessions.authenticate(bearer(request), 'operator');
        const body = await readJson(request);
        if (!isRecord(body) || Object.keys(body).some((key) => !['publicKey', 'makerId'].includes(key))) throw new Error('maker provisioning body is invalid');
        const identity = roleSessions.provisionMaker(stringField(body, 'publicKey'), stringField(body, 'makerId'));
        roleIdentities.push(identity);
        operatorControls.provisionMaker(identity.makerId!);
        registerStreamedMaker(identity.makerId!, identity.publicKey);
        json(response, 201, { maker: operatorControls.makerStatus(identity.makerId!) });
        return;
      }
      if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'operator' && parts[2] === 'identities' && parts[3] && parts[4] === 'revoke') {
        roleSessions.authenticate(bearer(request), 'operator');
        const identity = roleSessions.identity(parts[3]);
        if (!identity) throw new Error('identity is not provisioned');
        roleSessions.revokeIdentity(parts[3]);
        if (identity.role === 'maker') {
          disableMakerSource(identity.makerId!, 'operator');
        }
        json(response, 200, { revoked: true, role: identity.role, ...(identity.makerId ? { makerId: identity.makerId } : {}) });
        return;
      }
      if (request.method === 'GET' && parts.join('/') === 'v1/assets') {
        const wallet = url.searchParams.get('wallet') ?? '';
        const outputMint = url.searchParams.get('outputMint') ?? '';
        if (wallet) authenticateSeller(request, wallet);
        if (wallet && localnetFixture && localnetAssets) await localnetAssets.refresh(wallet, localnetFixture.stockMint, outputMint);
        await desk.refreshReferencePolicy();
        json(response, 200, desk.listAssets(wallet, outputMint));
        return;
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/quote-sprints') {
        const quoteRequest = parseRequest(await readJson(request));
        authenticateSeller(request, quoteRequest.wallet);
        if (!desk.quoteSprintsEnabled()) throw new Error('new Quote Sprints are stopped by the operator');
        json(response, 201, await desk.createQuoteSprint(quoteRequest));
        return;
      }
      if (parts[0] === 'v1' && parts[1] === 'quote-sprints' && parts[2]) {
        const id = parts[2];
        if (request.method === 'GET' && parts.length === 3) {
          const sprint = desk.getQuoteSprint(id);
          authenticateSeller(request, sprint.request.wallet);
          json(response, 200, sprint);
          return;
        }
        if (request.method === 'GET' && parts[3] === 'events') {
          // Resolve the sprint before switching protocols so a typo cannot
          // leave a client with an SSE connection that waits forever.
          desk.getQuoteSprint(id);
          response.statusCode = 200;
          response.setHeader('access-control-allow-origin', process.env.SOLANA_API_ORIGIN ?? '*');
          response.setHeader('content-type', 'text/event-stream; charset=utf-8');
          response.setHeader('cache-control', 'no-cache');
          response.setHeader('connection', 'keep-alive');
          // Quote collection has one terminal outcome. winner_ready must close
          // the stream just like no_quote/failed; review, authorize, and
          // execution continue through their regular HTTP endpoints.
          const terminalStates = new Set(['winner_ready', 'no_quote', 'expired', 'failed', 'finalized']);
          let closed = false;
          let unsubscribe = (): void => undefined;
          const onSession = (session: ReturnType<QuoteDeskService['getSession']>): void => {
            if (closed) return;
            // This stream is public. The authoritative GET supplies the review
            // package; events only announce a state change and never disclose
            // seller terms, maker identity, or reusable transaction bytes.
            response.write(`event: ${session.state}\ndata: ${JSON.stringify({ id: session.id, state: session.state })}\n\n`);
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
        if (request.method === 'POST' && parts[3] === 'authorize') {
          const body = await readJson(request);
          if (!isRecord(body)) throw new Error('request body must be an object');
          if (Object.keys(body).some((key) => !['wallet', 'reviewHash', 'signedTransactionBase64'].includes(key))) throw new Error('unknown authorize field');
          const wallet = stringField(body, 'wallet');
          authenticateSeller(request, wallet);
          json(response, 200, await desk.authorize(id, wallet, stringField(body, 'reviewHash'), stringField(body, 'signedTransactionBase64')));
          return;
        }
        if (request.method === 'POST' && parts[3] === 'review') {
          const body = await readJson(request);
          if (!isRecord(body)) throw new Error('request body must be an object');
          if (Object.keys(body).some((key) => key !== 'wallet')) throw new Error('unknown review field');
          const wallet = stringField(body, 'wallet');
          authenticateSeller(request, wallet);
          json(response, 200, await desk.review(id, wallet));
          return;
        }
      }
      if (request.method === 'POST' && parts.join('/') === 'v1/execution-attempts') {
        const body = await readJson(request);
        if (!isRecord(body)) throw new Error('request body must be an object');
        if (Object.keys(body).some((key) => !['quoteSprintId', 'idempotencyKey'].includes(key))) throw new Error('unknown execution-attempt field');
        const quoteSprintId = stringField(body, 'quoteSprintId');
        authenticateSeller(request, desk.getQuoteSprint(quoteSprintId).request.wallet);
        const result = await desk.createExecutionAttempt({
          quoteSprintId,
          idempotencyKey: stringField(body, 'idempotencyKey'),
        });
        const status = result.attempt.state === 'confirmed' || result.attempt.state === 'finalized'
          ? 'final'
          : result.attempt.state === 'submitting'
            ? 'provisional'
            : result.attempt.state === 'reconciling'
              ? 'reconciling'
              : 'failed';
        json(response, 201, {
          attemptId: result.attempt.id,
          quoteSprintId: result.attempt.quoteSprintId,
          status,
          ...(result.attempt.signature === undefined ? {} : { signature: result.attempt.signature }),
          ...(result.attempt.failureMessage === undefined ? {} : { failureMessage: result.attempt.failureMessage }),
          ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
        });
        return;
      }
      if (request.method === 'GET' && parts.join('/') === 'v1/trades') {
        const wallet = url.searchParams.get('wallet') ?? '';
        if (!wallet) throw new Error('Seller wallet is required');
        authenticateSeller(request, wallet);
        json(response, 200, desk.listTrades(wallet));
        return;
      }
      json(response, 404, { message: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      const unauthorized = /^(Seller session|Seller challenge|Seller origin|Seller cluster is required|Seller cluster does not match)/i.test(message);
      const notFound = message === 'quote sprint not found'
        || message === 'quote session not found'
        || message === 'asset is not present in the signed registry';
      json(response, unauthorized ? 401 : notFound ? 404 : 400, { message });
    }
  })();
}

if (process.env.SOLANA_API_AUTOSTART !== 'false') {
  const httpServer = createServer(route);
  const streams = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/v1/makers/stream') { socket.destroy(); return; }
    try {
      const token = bearer(request);
      const identity = roleSessions.authenticate(token, 'maker');
      streams.handleUpgrade(request, socket, head, (client) => attachMakerStream(client, identity, token));
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
  function attachMakerStream(client: WebSocket, identity: RoleSessionClaims, token: string): void {
    const makerId = identity.makerId!;
    const streamedSource = streamedMakers.get(makerId);
    if (!streamedSource) { client.close(1008, 'maker source is not provisioned'); return; }
    const previousClient = makerClients.get(makerId);
    makerClients.set(makerId, client);
    const expiryTimer = setTimeout(() => client.close(1008, 'maker role session expired'), Math.max(0, identity.expiresAtMs - Date.now()));
    if (previousClient && previousClient !== client) {
      streamedSource.setAvailable(false);
      operatorControls.updateAdvertisement(makerId, operatorControls.makerStatus(makerId).capabilities, 'unavailable');
      previousClient.close(1000, 'maker stream replaced');
    }
    client.send(JSON.stringify({ type: 'ready', makerId, expiresAtMs: identity.expiresAtMs }));
    client.on('close', () => {
      clearTimeout(expiryTimer);
      if (makerClients.get(makerId) !== client) return;
      makerClients.delete(makerId);
      streamedSource.setAvailable(false);
      operatorControls.updateAdvertisement(makerId, operatorControls.makerStatus(makerId).capabilities, 'unavailable');
    });
    client.on('message', async (raw: Buffer) => {
      let quoteMessage = false;
      try {
        if (makerClients.get(makerId) !== client) throw new Error('maker stream has been replaced');
        const currentIdentity = roleSessions.authenticate(token, 'maker');
        if (currentIdentity.sessionId !== identity.sessionId || currentIdentity.makerId !== makerId) throw new Error('role session identity changed');
        const message: unknown = JSON.parse(raw.toString());
        if (!isRecord(message) || typeof message.type !== 'string') throw new Error('stream message is invalid');
        if (message.type === 'heartbeat' && Object.keys(message).length === 1) {
          operatorControls.heartbeat(makerId);
          client.send(JSON.stringify({ type: 'heartbeat_ack', atMs: Date.now() }));
          return;
        }
        if (message.type === 'advertise' && Object.keys(message).length === 3 && Object.keys(message).every((key) => ['type', 'capabilities', 'availability'].includes(key))) {
          if (message.availability !== 'available' && message.availability !== 'unavailable') throw new Error('maker advertisement is invalid');
          const capabilities = parseMakerCapabilities(message.capabilities);
          operatorControls.updateAdvertisement(makerId, capabilities, message.availability);
          streamedSource.setCapabilities(capabilities);
          streamedSource.setAvailable(operatorControls.makerStatus(makerId).availability === 'available');
          client.send(JSON.stringify({ type: 'advertisement_ack', maker: operatorControls.makerStatus(makerId) }));
          return;
        }
        if (message.type === 'self_disable' && Object.keys(message).length === 1) {
          disableMakerSource(makerId, 'maker');
          client.send(JSON.stringify({ type: 'disabled' }));
          return;
        }
        if (message.type === 'quote') {
          quoteMessage = true;
          const makerStatus = operatorControls.makerStatus(makerId);
          if (!makerStatus.enabled || makerStatus.operatorDisabled || operatorControls.isSprintStopped()) throw new Error('maker or Quote Sprint intake is disabled');
          const canonical = canonicalMakerQuote(message);
          if (message.makerId !== makerId || typeof message.signature !== 'string' || typeof message.transactionBase64 !== 'string') throw new Error('maker quote is not bound to this identity');
          if (!Number.isSafeInteger(message.expiresAtMs) || (message.expiresAtMs as number) <= Date.now() || (message.expiresAtMs as number) > Date.now() + 30_000) throw new Error('maker quote expiry is invalid');
          if (!verifyProvisionedSignature(identity.publicKey, canonical, message.signature)) throw new Error('maker quote commitment signature is invalid');
          const transactionDigest = await transactionHash(message.transactionBase64);
          if (message.transactionHash !== transactionDigest) throw new Error('maker transaction hash does not match commitment');
          const partial = await validateMakerPartialTransaction(message.transactionBase64, identity.publicKey, transactionDigest, message.expiresAtMs as number);
          if (!partial.ok) throw new Error(partial.message);
          const asset = assets.list().find((entry) => entry.mint === message.inputMint);
          const feeRecipient = localnetFixture?.feeRecipient ?? process.env.SOLANA_RFQ_FEE_RECIPIENT;
          if (!asset || !feeRecipient) throw new Error('maker settlement registry or fee recipient configuration is unavailable');
          const tokenProgram = asset.tokenProgram === 'token-2022'
            ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
            : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
          validateMakerSettlement(message.transactionBase64, {
            quoteId: message.quoteId as string,
            wallet: message.wallet as string,
            makerPublicKey: identity.publicKey,
            inputMint: message.inputMint as string,
            outputMint: message.outputMint as string,
            inputAmountAtomic: message.inputAmountAtomic as string,
            outputAmountAtomic: message.outputAmountAtomic as string,
            feeBps: message.feeBps as number,
            expiresAtMs: message.expiresAtMs as number,
            feeRecipient,
            stockTokenProgram: tokenProgram,
            stableTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            extensionFingerprint: asset.extensionFingerprint,
          });
          if (makerClients.get(makerId) !== client) throw new Error('maker stream has been replaced');
          roleSessions.authenticate(token, 'maker');
          const currentMakerStatus = operatorControls.makerStatus(makerId);
          if (!currentMakerStatus.enabled || currentMakerStatus.operatorDisabled) throw new Error('maker is disabled');
          if (typeof message.outputAmountAtomic !== 'string' || !/^[1-9][0-9]*$/.test(message.outputAmountAtomic)) throw new Error('maker output amount is invalid');
          const quote: import('./sources').StreamedMakerQuote = {
            requestId: message.requestId as string,
            quoteId: message.quoteId as string,
            wallet: message.wallet as string,
            inputMint: message.inputMint as string,
            outputMint: message.outputMint as string,
            inputAmountAtomic: message.inputAmountAtomic as string,
            outputAmountAtomic: message.outputAmountAtomic,
            feeBps: message.feeBps as number,
            expiresAtMs: message.expiresAtMs as number,
            transactionBase64: message.transactionBase64,
          };
          streamedSource.submitQuote(quote);
          operatorControls.recordQuote(makerId, true);
          client.send(JSON.stringify({ type: 'quote_received', quoteId: message.quoteId, messageHash: transactionDigest, expiresAtMs: message.expiresAtMs }));
          return;
        }
        throw new Error('unsupported maker stream message');
      } catch (error) {
        if (quoteMessage) operatorControls.recordQuote(makerId, false);
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'rejected', reason: error instanceof Error ? error.message : 'maker message rejected' }));
      }
    });
  }
  httpServer.listen(port, () => console.log(`Solana desk API listening on http://localhost:${port}`));
}
