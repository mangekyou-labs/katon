import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { createPublicClient, http, type Hex } from 'viem';
import { flareTestnet } from 'viem/chains';

import { auctionDeadline, type AuctionDuration } from '../../../packages/flare-core/src/auction';
import type {
  AuctionRow,
  CreateAuctionInput,
  CreateStandingBidInput,
  CreateWithdrawalInput,
  FacilityReadModel,
  StandingBidRow,
} from '../../../packages/flare-sdk/src/api';
import { ApiStore } from './store';
import { MongoApiStore } from './mongoStore';
import { ApiBotCredentialStore, ApiSessionStore } from './session';
import { BlindRelay, RelayKeyRegistry } from './blindRelay';
import { plaintextWorkflowError } from './plaintextWorkflow';
import { createSimFinalizeMatch } from './simFinalizeMatch';
import type { EncryptedEnvelope } from '../../../packages/flare-sdk/src/api';
import { FdcVerifierClient, readLiveFtsoFeed } from '../../../packages/flare-sdk/src/data';
import { getNetworkConfig, type FlareNetwork } from '../../../packages/flare-core/src/network';
import { attachRelayRealtime } from './realtime';
import { botBodyDigest, botRequestSignature, signaturesEqual } from './botAuth';
import { MutationRateLimiter } from './limits';
import { buildRoleScopedReadModel } from './readModel';
import { PersistentEventProjector } from '../../../services/indexer/src/persistent';
import { projectEventsToReadModel } from '../../../services/indexer/src/readModel';
import { readAccessDecision } from './access';
import { authorizeMtlsPeer, type MtlsPeer } from './mtls';
import { readApiTlsConfig, readApiTlsOptions } from './tls';

const port = Number(process.env.FLARE_API_PORT ?? 8787);
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const apiChainId = Number(process.env.FLARE_API_CHAIN_ID ?? 114);
const apiNetwork = (process.env.FLARE_NETWORK ?? (apiChainId === 14 ? 'flare' : apiChainId === 31337 ? 'local' : 'coston2')) as FlareNetwork;
getNetworkConfig(apiNetwork, apiChainId);
const contractRegistryAddress = process.env.FLARE_CONTRACT_REGISTRY_ADDRESS;
const fdcVerifierUrl = process.env.FLARE_FDC_VERIFIER_URL;
const fdcDaUrl = process.env.FLARE_FDC_DA_URL;
const fdcClient = fdcVerifierUrl ? new FdcVerifierClient({
  baseUrl: fdcVerifierUrl,
  apiKey: process.env.FLARE_FDC_API_KEY,
}) : undefined;
const publicClient = createPublicClient({ chain: { ...flareTestnet, id: apiChainId, rpcUrls: { default: { http: [rpcUrl] } } }, transport: http(rpcUrl) });
const mongoPersistence = process.env.FLARE_MONGO_URL ? new MongoApiStore(
  process.env.FLARE_MONGO_URL,
  process.env.FLARE_MONGO_DATABASE ?? 'trustrfq',
  process.env.FLARE_MONGO_COLLECTION ?? 'api_snapshots',
) : undefined;
const store = new ApiStore(process.env.FLARE_API_STORE, mongoPersistence);
const indexerStorePath = process.env.FLARE_INDEXER_STORE;
const indexedProjector = indexerStorePath ? loadIndexedProjector(indexerStorePath) : undefined;
try {
  await store.hydrate();
} catch (error) {
  console.error(`Flare API persistence unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
}
const sessions = new ApiSessionStore();
const botCredentials = new ApiBotCredentialStore();
const persistedBotCredentials = store.botCredentialSnapshot();
if (persistedBotCredentials) botCredentials.restore(persistedBotCredentials);
const relay = new BlindRelay({
  matchOnFinalize: createSimFinalizeMatch({ fccMode: process.env.FLARE_FCC_MODE ?? 'simulated' }),
});
const persistedRelay = store.relaySnapshot();
if (persistedRelay) relay.restore(persistedRelay);
const relayKeys = new RelayKeyRegistry();
const persistedRelayKeys = store.relayKeySnapshot();
if (persistedRelayKeys) relayKeys.restore(persistedRelayKeys);
const requireRegisteredBidKeys = process.env.FLARE_RELAY_REQUIRE_REGISTERED_KEYS === 'true';
const authRequired = process.env.FLARE_API_AUTH_REQUIRED === 'true';
const apiDomain = process.env.FLARE_API_DOMAIN ?? '127.0.0.1:8787';
const maxBodyBytes = Number(process.env.FLARE_API_MAX_BODY_BYTES ?? 1_048_576);
const botSignatureWindowSeconds = Number(process.env.FLARE_BOT_SIGNATURE_WINDOW_SECONDS ?? 300);
const botMtlsRequired = process.env.FLARE_BOT_MTLS_REQUIRED === 'true';
const tlsConfig = readApiTlsConfig();
if (botMtlsRequired && !tlsConfig.mutualTls) throw new Error('API_MTLS_REQUIRES_TLS');
const tlsOptions = readApiTlsOptions(tlsConfig);
const rawBody = Symbol('flareRawBody');
const mutationRateLimiter = new MutationRateLimiter({
  windowMs: Number(process.env.FLARE_API_MUTATION_WINDOW_MS ?? 1_000),
  maxRequests: Number(process.env.FLARE_API_MUTATION_MAX ?? 30),
});

function loadIndexedProjector(filePath: string): PersistentEventProjector | undefined {
  try {
    return new PersistentEventProjector(filePath);
  } catch (error) {
    console.error(`Flare indexer snapshot unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
    return undefined;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization,x-trf-timestamp,x-trf-body-sha256,x-trf-signature',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

function errorStatus(code: string): number {
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_EXPIRED' || code === 'AUTH_WALLET_MISMATCH' || code === 'CREDENTIAL_ADMIN_REQUIRED' || code === 'CREDENTIAL_UNKNOWN' || code === 'CREDENTIAL_REVOKED' || code === 'CREDENTIAL_EXPIRED' || code.startsWith('BOT_MTLS_') || code === 'BOT_SIGNATURE_INVALID' || code === 'BOT_SIGNATURE_TIMESTAMP' || code === 'BOT_BODY_DIGEST') return 401;
  if (code === 'CREDENTIAL_SCOPE' || code === 'CREDENTIAL_WALLET') return 403;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'REQUEST_BODY_TOO_LARGE') return 413;
  if (code.endsWith('_NOT_ELIGIBLE') || code.endsWith('_AUTH') || code === 'RFQ_KEY_SCOPE') return 403;
  if (code === 'RFQ_NOT_FOUND') return 404;
  return 400;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > maxBodyBytes) throw new Error('REQUEST_BODY_TOO_LARGE');
  let raw = '';
  for await (const chunk of request) {
    raw += String(chunk);
    if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes) throw new Error('REQUEST_BODY_TOO_LARGE');
  }
  if (!raw) return {};
  Object.defineProperty(request, rawBody, { value: raw, configurable: true });
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('REQUEST_BODY');
  return parsed as Record<string, unknown>;
}

function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}

function duration(value: unknown): AuctionDuration {
  if (value === '24h' || value === '1w' || value === '1m' || value === '3m') return value;
  throw new Error('AUCTION_DURATION');
}

function isExactDemoAmount(value: unknown, expectedWhole: bigint): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return false;
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > 18) return false;
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0') || '0') === expectedWhole * 10n ** 18n;
}

function readFacility(wallet: string): FacilityReadModel {
  return store.facility(wallet);
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
}

function authorizeMutation(request: IncomingMessage, wallet: string, scope = 'workflow:mutate'): void {
  if (!mutationRateLimiter.allow(wallet.toLowerCase(), Date.now())) throw new Error('RATE_LIMITED');
  const token = bearer(request);
  if (!authRequired && !token?.startsWith('trf_bot_')) return;
  try {
    sessions.authorize(token, wallet);
  } catch (error) {
    if (error instanceof Error && ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_WALLET_MISMATCH'].includes(error.message)) {
      botCredentials.authorize(token ?? '', wallet, scope);
      authorizeBotSignature(request, token ?? '');
      authorizeBotTransport(request, token ?? '', wallet, scope);
      return;
    }
    throw error;
  }
}

function authorizeBotSignature(request: IncomingMessage, token: string): void {
  const timestamp = Number(request.headers['x-trf-timestamp']);
  const digest = request.headers['x-trf-body-sha256'];
  const signature = request.headers['x-trf-signature'];
  const raw = (request as IncomingMessage & { [rawBody]?: string })[rawBody] ?? '';
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > botSignatureWindowSeconds) throw new Error('BOT_SIGNATURE_TIMESTAMP');
  if (typeof digest !== 'string' || digest !== botBodyDigest(raw)) throw new Error('BOT_BODY_DIGEST');
  if (typeof signature !== 'string' || !signaturesEqual(signature, botRequestSignature(token, request.method ?? 'GET', new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`).pathname, timestamp, digest))) throw new Error('BOT_SIGNATURE_INVALID');
}

function authorizeBotTransport(request: IncomingMessage, token: string, wallet: string, scope: string): void {
  if (!botMtlsRequired) return;
  const institution = botCredentials.institution(token, wallet, scope);
  authorizeMtlsPeer(request.socket as unknown as MtlsPeer, institution);
}

function authorizeCredentialAdmin(request: IncomingMessage): void {
  const expected = process.env.FLARE_BOT_CREDENTIAL_ADMIN_TOKEN?.trim();
  if (!expected || bearer(request) !== expected) throw new Error('CREDENTIAL_ADMIN_REQUIRED');
}

function authorizeRead(request: IncomingMessage, wallet: string, scope = 'read:portfolio'): void {
  const token = bearer(request);
  if (readAccessDecision(wallet, authRequired, Boolean(token)) === 'public') return;
  try {
    sessions.authorize(token, wallet);
  } catch (error) {
    if (error instanceof Error && ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_WALLET_MISMATCH'].includes(error.message)) {
      botCredentials.authorize(token ?? '', wallet, scope);
      authorizeBotSignature(request, token ?? '');
      authorizeBotTransport(request, token ?? '', wallet, scope);
      return;
    }
    throw error;
  }
}

async function persistRelay(): Promise<void> {
  store.setRelaySnapshot(relay.snapshot());
  store.setRelayKeySnapshot(relayKeys.snapshot());
  store.setBotCredentialSnapshot(botCredentials.snapshot());
  await store.flush();
}

function encryptedEnvelope(value: unknown): EncryptedEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('RFQ_INPUT');
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1
    || typeof candidate.keyId !== 'string'
    || typeof candidate.commitment !== 'string'
    || typeof candidate.expiresAt !== 'number'
    || !Number.isInteger(candidate.expiresAt)
    || typeof candidate.nonce !== 'string'
    || typeof candidate.ciphertext !== 'string'
  ) throw new Error('RFQ_INPUT');
  return candidate as unknown as EncryptedEnvelope;
}

async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'OPTIONS') return send(response, 204, {});
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      const persistence = store.persistenceStatus();
      return send(response, 200, { ok: true, service: 'flare-api', chainId: apiChainId, authRequired, tls: tlsConfig.enabled, mutualTls: tlsConfig.mutualTls, persistence });
    }
    if (request.method === 'GET' && url.pathname === '/v1/readyz') {
      const persistence = store.persistenceStatus();
      return send(response, persistence.ready ? 200 : 503, { ok: persistence.ready, service: 'flare-api', chainId: apiChainId, authRequired, tls: tlsConfig.enabled, mutualTls: tlsConfig.mutualTls, persistence });
    }
    if (request.method === 'GET' && url.pathname === '/v1/auth/nonce') {
      const address = url.searchParams.get('address');
      if (!address) throw new Error('WALLET_REQUIRED');
      return send(response, 200, sessions.issueChallenge(address, apiDomain, apiChainId));
    }
    if (request.method === 'POST' && url.pathname === '/v1/auth/verify') {
      const input = await body(request);
      if (typeof input.message !== 'string' || typeof input.signature !== 'string') throw new Error('AUTH_INPUT');
      return send(response, 200, await sessions.verify(input.message, input.signature as `0x${string}`, apiDomain, apiChainId));
    }
    if (request.method === 'POST' && url.pathname === '/v1/lp-credentials') {
      authorizeCredentialAdmin(request);
      const input = await body(request);
      const issued = botCredentials.issue({
        wallet: text(input.wallet, 'WALLET_REQUIRED'),
        institution: text(input.institution, 'CREDENTIAL_INSTITUTION'),
        scopes: Array.isArray(input.scopes) ? input.scopes.map((scope) => text(scope, 'CREDENTIAL_SCOPE')) : [],
        expiresAt: input.expiresAt as number,
      });
      await persistRelay();
      return send(response, 201, issued);
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/lp-credentials/')) {
      authorizeCredentialAdmin(request);
      botCredentials.revoke(text(decodeURIComponent(url.pathname.slice('/v1/lp-credentials/'.length)), 'CREDENTIAL_ID'));
      await persistRelay();
      return send(response, 200, { status: 'revoked' });
    }
    if (request.method === 'PUT' && url.pathname === '/v1/lp-encryption-keys') {
      const input = await body(request);
      const wallet = text(input.wallet, 'WALLET_REQUIRED');
      authorizeMutation(request, wallet, 'key:manage');
      const keyId = text(input.keyId, 'RFQ_KEY_INPUT');
      const publicKey = text(input.publicKey, 'RFQ_KEY_INPUT');
      const activatedAt = input.activatedAt === undefined ? Math.floor(Date.now() / 1_000) : input.activatedAt;
      const expiresAt = input.expiresAt;
      if (typeof activatedAt !== 'number' || !Number.isInteger(activatedAt) || typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) {
        throw new Error('RFQ_KEY_TIME');
      }
      const key = { lpId: wallet, keyId, publicKey, activatedAt, expiresAt };
      if (relayKeys.snapshot().activeByLp[wallet]) relayKeys.rotate(key);
      else relayKeys.register(key);
      await persistRelay();
      return send(response, 200, { lpId: wallet, keyId, publicKey, activatedAt, expiresAt, status: 'active' });
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/lp-encryption-keys/')) {
      const keyId = text(decodeURIComponent(url.pathname.slice('/v1/lp-encryption-keys/'.length)), 'RFQ_KEY_INPUT');
      const input = await body(request);
      const wallet = text(input.wallet, 'WALLET_REQUIRED');
      authorizeMutation(request, wallet, 'key:manage');
      relayKeys.revoke(wallet, keyId, typeof input.revokedAt === 'number' ? input.revokedAt : Math.floor(Date.now() / 1_000));
      await persistRelay();
      return send(response, 200, { lpId: wallet, keyId, status: 'revoked' });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/transactions/')) {
      const hash = url.pathname.slice('/v1/transactions/'.length);
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return send(response, 400, { error: 'TX_HASH_INVALID' });
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: hash as Hex });
        return send(response, 200, { indexed: receipt.status === 'success', blockNumber: receipt.blockNumber.toString(), transaction: hash });
      } catch {
        return send(response, 200, { indexed: false, transaction: hash });
      }
    }
    if (request.method === 'GET' && url.pathname === '/v1/oracles/ftso') {
      if (!contractRegistryAddress) return send(response, 503, { error: 'FTSO_NOT_CONFIGURED' });
      const feedId = url.searchParams.get('feedId');
      if (!feedId) throw new Error('FTSO_FEED_ID');
      const feed = await readLiveFtsoFeed(publicClient, {
        network: apiNetwork,
        registryAddress: contractRegistryAddress as `0x${string}`,
        feedId: feedId as `0x${string}`,
      });
      return send(response, 200, {
        feedId: feed.feedId,
        value: feed.value.toString(),
        decimals: feed.decimals,
        timestamp: feed.timestamp,
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/oracles/fdc/prepare') {
      if (!fdcClient) return send(response, 503, { error: 'FDC_NOT_CONFIGURED' });
      const input = await body(request);
      const attestationType = text(input.attestationType, 'FDC_ATTESTATION_TYPE');
      const sourceId = text(input.sourceId, 'FDC_SOURCE_ID');
      const requestBody = input.requestBody;
      if (requestBody === null || typeof requestBody !== 'object' || Array.isArray(requestBody)) throw new Error('FDC_REQUEST_BODY');
      return send(response, 200, await fdcClient.prepareRequest(attestationType, { attestationType, sourceId, requestBody }));
    }
    if (request.method === 'POST' && url.pathname === '/v1/oracles/fdc/proof') {
      if (!fdcClient || !fdcDaUrl) return send(response, 503, { error: 'FDC_NOT_CONFIGURED' });
      const input = await body(request);
      if (typeof input.votingRoundId !== 'number' || typeof input.requestBytes !== 'string') throw new Error('FDC_PROOF_INPUT');
      return send(response, 200, await fdcClient.getProof(fdcDaUrl, input.votingRoundId, input.requestBytes as `0x${string}`));
    }
    if (request.method === 'GET' && url.pathname === '/v1/read-model') {
      const wallet = url.searchParams.get('wallet') ?? '';
      authorizeRead(request, wallet, 'read:portfolio');
      const facility = readFacility(wallet);
      const relayAuctions = wallet ? relay.listAuctions(wallet) : [];
      const indexed = indexedProjector
        ? projectEventsToReadModel(indexedProjector.events({ finalizedOnly: true }))
        : undefined;
      return send(response, 200, buildRoleScopedReadModel(wallet, relayAuctions, { auctions: store.auctions, standingBids: store.standingBids, activity: store.activity, facility, indexed }));
    }
    if (request.method === 'GET' && url.pathname === '/v1/relay/auctions') {
      const wallet = text(url.searchParams.get('wallet'), 'WALLET_REQUIRED');
      authorizeRead(request, wallet, 'read:rfq');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      return send(response, 200, relay.listAuctionPage(wallet, cursor, limit));
    }
    const relayMatch = /^\/v1\/relay\/auctions\/([^/]+)(?:\/(bids|cancel|finalize))?$/.exec(url.pathname);
    if (request.method === 'POST' && url.pathname === '/v1/relay/auctions') {
      const input = await body(request);
      const wallet = text(input.wallet, 'WALLET_REQUIRED');
      authorizeMutation(request, wallet, 'rfq:create');
      if (!Array.isArray(input.eligibleLps) || input.eligibleLps.some((lp) => typeof lp !== 'string')) throw new Error('RFQ_ELIGIBILITY');
      const auctionId = randomUUID();
      const openedAt = Math.floor(Date.now() / 1_000);
      relay.openAuction({
        id: auctionId,
        seller: wallet,
        envelope: encryptedEnvelope(input.envelope),
        eligibleLps: input.eligibleLps,
        duration: duration(input.duration),
        openedAt,
        earlyCloseAllowed: input.earlyCloseAllowed === true,
      });
      store.appendActivity({
        id: `${wallet.slice(0, 8)}-${auctionId}`,
        asset: 'Encrypted RFQ',
        amount: '—',
        state: 'Auction opened',
        transaction: '—',
      });
      await persistRelay();
      return send(response, 201, relay.readAuction(auctionId, wallet, openedAt));
    }
    if (relayMatch && request.method === 'GET' && !relayMatch[2]) {
      const wallet = text(url.searchParams.get('wallet'), 'WALLET_REQUIRED');
      authorizeRead(request, wallet, 'read:rfq');
      return send(response, 200, relay.readAuction(relayMatch[1], wallet));
    }
    if (relayMatch && request.method === 'POST') {
      const input = await body(request);
      const wallet = text(input.wallet, 'WALLET_REQUIRED');
      authorizeMutation(request, wallet, relayMatch[2] === 'bids' ? 'bid:submit' : relayMatch[2] === 'finalize' ? 'rfq:finalize' : 'rfq:cancel');
      if (relayMatch[2] === 'bids') {
        if (requireRegisteredBidKeys) relayKeys.resolve(wallet, text((input.envelope as Record<string, unknown>)?.keyId, 'RFQ_KEY_INPUT'), Math.floor(Date.now() / 1_000));
        relay.submitBid({ auctionId: relayMatch[1], lpId: wallet, idempotencyKey: text(input.idempotencyKey, 'RFQ_INPUT'), envelope: encryptedEnvelope(input.envelope) });
      } else if (relayMatch[2] === 'cancel') {
        relay.cancelAuction(relayMatch[1], wallet);
      } else if (relayMatch[2] === 'finalize') {
        relay.finalizeAuction(relayMatch[1], wallet);
      } else {
        throw new Error('NOT_FOUND');
      }
      await persistRelay();
      return send(response, 200, relay.readAuction(relayMatch[1], wallet));
    }
    if (request.method === 'POST' && url.pathname === '/v1/quotes/immediate') {
      const input = await body(request);
      if (input.sellAsset !== 'RWA' || input.receiveAsset !== 'USDX') throw new Error('ASSET_NOT_ELIGIBLE');
      if (!isExactDemoAmount(input.amount, 1n) || !isExactDemoAmount(input.minimumReceive, 995n)) throw new Error('DEMO_ROUTE_EXACT_AMOUNT');
      return send(response, 200, {
        sellAsset: 'RWA', receiveAsset: 'USDX', sellAmount: '1000000000000000000',
        grossOutput: '1000000000000000000000', protocolFee: '5000000000000000000',
        netOutput: '995000000000000000000', minimumReceive: '995000000000000000000',
        protocolFeeBps: 50, route: 'standing-lp', status: 'ready',
      });
    }
    const plaintextError = plaintextWorkflowError(request.method ?? 'GET', url.pathname);
    if (plaintextError) throw new Error(plaintextError);
    if (request.method === 'POST' && url.pathname === '/v1/auctions') {
      const input = await body(request) as unknown as CreateAuctionInput;
      const wallet = text(input.wallet, 'WALLET_REQUIRED');
      authorizeMutation(request, wallet, 'rfq:create');
      const pair = text(input.pair, 'PAIR_REQUIRED');
      const auctionDuration = duration(input.duration);
      const minOutput = text(input.minOutput, 'MIN_OUTPUT_REQUIRED');
      const openedAt = Math.floor(Date.now() / 1000);
      const row: AuctionRow = { id: `${wallet.slice(0, 8)}-${randomUUID()}`, pair, status: 'open', bids: 0, expiry: auctionDeadline(auctionDuration, openedAt) };
      store.appendAuction(row);
      store.appendActivity({ id: row.id, asset: pair, amount: minOutput, state: 'Auction opened', transaction: '—' });
      await store.flush();
      return send(response, 201, row);
    }
    if (request.method === 'POST' && url.pathname === '/v1/standing-bids') {
      const input = await body(request) as unknown as CreateStandingBidInput;
      const wallet = text(input.wallet, 'WALLET_REQUIRED');
      authorizeMutation(request, wallet, 'bid:standing');
      const pair = text(input.pair, 'PAIR_REQUIRED');
      const capacity = text(input.capacity, 'CAPACITY_REQUIRED');
      if (input.mode !== 'instant' && input.mode !== 'partial' && input.mode !== 'fok') throw new Error('BID_MODE');
      if (!Number.isInteger(input.expiry) || input.expiry <= Math.floor(Date.now() / 1000)) throw new Error('BID_EXPIRY');
      const row: StandingBidRow = { id: `${wallet.slice(0, 8)}-${randomUUID()}`, pair, capacity, mode: input.mode, expiry: input.expiry, status: 'active' };
      store.appendStandingBid(row);
      store.appendActivity({ id: row.id, asset: pair, amount: capacity, state: 'Standing bid ready', transaction: '—' });
      await store.flush();
      return send(response, 201, row);
    }
    if (request.method === 'POST' && url.pathname === '/v1/facility/withdrawals') {
      const input = await body(request) as unknown as CreateWithdrawalInput;
      const wallet = text(input.wallet, 'WALLET_REQUIRED');
      authorizeMutation(request, wallet, 'facility:withdraw');
      const shares = text(input.shares, 'SHARES_REQUIRED');
      const minAssets = text(input.minAssets, 'MIN_ASSETS_REQUIRED');
      const current = readFacility(wallet);
      const next = { ...current, queuedWithdrawals: current.queuedWithdrawals + 1 };
      store.setFacility(wallet, next);
      store.appendActivity({ id: `${wallet.slice(0, 8)}-${randomUUID()}`, asset: 'USDX', amount: `${shares} shares / ${minAssets} min`, state: 'Redemption queued', transaction: '—' });
      await store.flush();
      return send(response, 201, next);
    }
    return send(response, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'REQUEST_FAILED';
    return send(response, errorStatus(message), { error: message });
  }
}

const requestHandler = (request: IncomingMessage, response: ServerResponse) => { void handler(request, response); };
const server = tlsOptions ? createHttpsServer(tlsOptions, requestHandler) : createHttpServer(requestHandler);
const relayRealtime = attachRelayRealtime(server, relay, {
  requireAuth: authRequired,
  authorize: (actor, token) => {
    try {
      sessions.authorize(token, actor);
      return true;
    } catch {
      try {
        botCredentials.authorize(token, actor, 'read:rfq');
        return true;
      } catch {
        return false;
      }
    }
  },
  authorizeBot: (actor, token, timestamp, digest, signature, request) => {
    try {
      const now = Math.floor(Date.now() / 1_000);
      if (Math.abs(now - timestamp) > botSignatureWindowSeconds || digest !== botBodyDigest('')
        || !signaturesEqual(signature, botRequestSignature(token, 'GET', new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`).pathname, timestamp, digest))) return false;
      botCredentials.authorize(token, actor, 'read:rfq');
      authorizeBotTransport(request, token, actor, 'read:rfq');
      return true;
    } catch {
      return false;
    }
  },
});
server.listen(port, '0.0.0.0', () => {
  console.log(`Flare API listening on ${tlsConfig.enabled ? 'https' : 'http'}://0.0.0.0:${port}${tlsConfig.mutualTls ? ' (mTLS)' : ''}`);
});

async function shutdown(): Promise<void> {
  relayRealtime.close();
  await store.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
