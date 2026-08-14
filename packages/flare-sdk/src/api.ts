export type ApiReadModelState = 'ready' | 'empty' | 'offline' | 'error';

export interface FlareApiAuth {
  readonly token?: string;
}

export interface AuctionRow {
  readonly id: string;
  readonly pair: string;
  readonly status: 'open' | 'cancelled' | 'finalized' | 'expired';
  readonly bids: number;
  readonly expiry: number;
  readonly commitment?: string;
}

export interface StandingBidRow {
  readonly id: string;
  readonly pair: string;
  readonly capacity: string;
  readonly mode: 'instant' | 'partial' | 'fok';
  readonly expiry: number;
  readonly status: 'active' | 'expired' | 'cancelled';
}

export interface ActivityRow {
  readonly id: string;
  readonly asset: string;
  readonly amount: string;
  readonly state: string;
  readonly transaction: string;
}

export interface FacilityReadModel {
  readonly shares: string;
  readonly nav: string;
  readonly queuedWithdrawals: number;
}

export interface OpportunityRow {
  readonly id: string;
  readonly kind: 'swap' | 'liquidation' | 'fill';
  readonly pair: string;
  readonly status: string;
  readonly amount: string;
  readonly transaction: string;
  readonly venue?: string;
  readonly market?: string;
}

export interface FlareReadModel {
  readonly state: ApiReadModelState;
  readonly updatedAt: number;
  readonly auctions: readonly AuctionRow[];
  readonly standingBids: readonly StandingBidRow[];
  readonly activity: readonly ActivityRow[];
  readonly facility: FacilityReadModel;
  readonly opportunities: readonly OpportunityRow[];
}

export interface CreateAuctionInput {
  readonly wallet: string;
  readonly pair: string;
  readonly duration: '24h' | '1w' | '1m' | '3m';
  readonly minOutput: string;
}

export interface ImmediateQuoteResponse {
  readonly sellAsset: string;
  readonly receiveAsset: string;
  readonly sellAmount: string;
  readonly grossOutput: string;
  readonly protocolFee: string;
  readonly netOutput: string;
  readonly minimumReceive: string;
  readonly protocolFeeBps: number;
  readonly route: 'standing-lp';
  readonly status: 'ready';
}

export interface CreateStandingBidInput {
  readonly wallet: string;
  readonly pair: string;
  readonly capacity: string;
  readonly mode: 'instant' | 'partial' | 'fok';
  readonly expiry: number;
}

export interface CreateWithdrawalInput {
  readonly wallet: string;
  readonly shares: string;
  readonly minAssets: string;
}

export interface AuthChallenge {
  readonly nonce: string;
  readonly message: string;
  readonly address: string;
  readonly domain: string;
  readonly chainId: number;
  readonly expiresAt: number;
}

export interface AuthSession {
  readonly token: string;
  readonly address: string;
  readonly expiresAt: number;
}

export interface LpBotCredential {
  readonly id: string;
  readonly token: string;
  readonly wallet: string;
  readonly institution: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

export interface EncryptedEnvelope {
  readonly version: 1;
  readonly keyId: string;
  readonly commitment: string;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface RelayAuction {
  readonly id: string;
  readonly commitment: string;
  readonly duration: '24h' | '1w' | '1m' | '3m';
  readonly status: 'open' | 'cancelled' | 'finalized' | 'expired';
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly bidCount: number;
  readonly envelope: EncryptedEnvelope;
}

export interface RelayAuctionListRow {
  readonly id: string;
  readonly commitment: string;
  readonly duration: RelayAuction['duration'];
  readonly status: RelayAuction['status'];
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly bidCount: number;
  readonly earlyCloseAllowed: boolean;
}

export interface RelayAuctionListPage {
  readonly auctions: readonly RelayAuctionListRow[];
  readonly nextCursor?: string;
}

export interface RelayEncryptionKey {
  readonly lpId: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly activatedAt?: number;
  readonly expiresAt: number;
}

export interface RelayEventMessage {
  readonly type: 'relay.event';
  readonly cursor: number;
  readonly event: {
    readonly sequence: number;
    readonly auctionId: string;
    readonly kind: string;
    readonly status: string;
    readonly bidCount: number;
  };
}

export async function requestAuthChallenge(baseUrl: string, address: string): Promise<AuthChallenge> {
  return readJson<AuthChallenge>(await fetch(`${trimBaseUrl(baseUrl)}/v1/auth/nonce?address=${encodeURIComponent(address)}`));
}

export async function verifyAuthChallenge(baseUrl: string, message: string, signature: `0x${string}`): Promise<AuthSession> {
  return readJson<AuthSession>(await fetch(`${trimBaseUrl(baseUrl)}/v1/auth/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }),
  }));
}

export async function issueLpBotCredential(baseUrl: string, input: { readonly wallet: string; readonly institution: string; readonly scopes: readonly string[]; readonly expiresAt: number }, adminToken: string): Promise<LpBotCredential> {
  const body = JSON.stringify(input);
  return readJson<LpBotCredential>(await fetch(`${trimBaseUrl(baseUrl)}/v1/lp-credentials`, {
    method: 'POST', headers: await requestHeaders({ token: adminToken }), body,
  }));
}

export async function revokeLpBotCredential(baseUrl: string, credentialId: string, adminToken: string): Promise<{ readonly status: 'revoked' }> {
  return readJson<{ readonly status: 'revoked' }>(await fetch(`${trimBaseUrl(baseUrl)}/v1/lp-credentials/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE', headers: await requestHeaders({ token: adminToken }),
  }));
}

export async function openRelayAuction(baseUrl: string, input: { readonly wallet: string; readonly eligibleLps: readonly string[]; readonly duration: RelayAuction['duration']; readonly earlyCloseAllowed?: boolean; readonly envelope: EncryptedEnvelope }, auth?: FlareApiAuth): Promise<RelayAuction> {
  const body = JSON.stringify(input);
  return readJson<RelayAuction>(await fetch(`${trimBaseUrl(baseUrl)}/v1/relay/auctions`, {
    method: 'POST', headers: await requestHeaders(auth, 'POST', '/v1/relay/auctions', body), body,
  }));
}

export async function listRelayAuctions(baseUrl: string, wallet: string, auth?: FlareApiAuth): Promise<readonly RelayAuctionListRow[]> {
  const auctions: RelayAuctionListRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await listRelayAuctionsPage(baseUrl, wallet, cursor ? { cursor } : {}, auth);
    auctions.push(...page.auctions);
    cursor = page.nextCursor;
  } while (cursor);
  return auctions;
}

export async function listRelayAuctionsPage(baseUrl: string, wallet: string, options: { readonly cursor?: string; readonly limit?: number } = {}, auth?: FlareApiAuth): Promise<RelayAuctionListPage> {
  const params = new URLSearchParams({ wallet });
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  return readJson<RelayAuctionListPage>(await fetch(`${trimBaseUrl(baseUrl)}/v1/relay/auctions?${params}`, { headers: await requestHeaders(auth, 'GET', '/v1/relay/auctions', '') }));
}

export async function submitRelayBid(baseUrl: string, auctionId: string, input: { readonly wallet: string; readonly idempotencyKey: string; readonly envelope: EncryptedEnvelope }, auth?: FlareApiAuth): Promise<RelayAuction> {
  const path = `/v1/relay/auctions/${encodeURIComponent(auctionId)}/bids`;
  const body = JSON.stringify(input);
  return readJson<RelayAuction>(await fetch(`${trimBaseUrl(baseUrl)}${path}`, {
    method: 'POST', headers: await requestHeaders(auth, 'POST', path, body), body,
  }));
}

export async function readRelayAuction(baseUrl: string, auctionId: string, wallet: string, auth?: FlareApiAuth): Promise<RelayAuction> {
  const path = `/v1/relay/auctions/${encodeURIComponent(auctionId)}`;
  return readJson<RelayAuction>(await fetch(`${trimBaseUrl(baseUrl)}${path}?wallet=${encodeURIComponent(wallet)}`, { headers: await requestHeaders(auth, 'GET', path, '') }));
}

export async function finalizeRelayAuction(baseUrl: string, auctionId: string, wallet: string, auth?: FlareApiAuth): Promise<RelayAuction> {
  const path = `/v1/relay/auctions/${encodeURIComponent(auctionId)}/finalize`;
  const body = JSON.stringify({ wallet });
  return readJson<RelayAuction>(await fetch(`${trimBaseUrl(baseUrl)}${path}`, {
    method: 'POST', headers: await requestHeaders(auth, 'POST', path, body), body,
  }));
}

export async function registerRelayEncryptionKey(baseUrl: string, input: Omit<RelayEncryptionKey, 'lpId'> & { readonly wallet: string }, auth?: FlareApiAuth): Promise<RelayEncryptionKey & { readonly status: 'active' }> {
  const body = JSON.stringify(input);
  return readJson(await fetch(`${trimBaseUrl(baseUrl)}/v1/lp-encryption-keys`, {
    method: 'PUT', headers: await requestHeaders(auth, 'PUT', '/v1/lp-encryption-keys', body), body,
  }));
}

export async function revokeRelayEncryptionKey(baseUrl: string, keyId: string, input: { readonly wallet: string; readonly revokedAt?: number }, auth?: FlareApiAuth): Promise<{ readonly lpId: string; readonly keyId: string; readonly status: 'revoked' }> {
  const path = `/v1/lp-encryption-keys/${encodeURIComponent(keyId)}`;
  const body = JSON.stringify(input);
  return readJson(await fetch(`${trimBaseUrl(baseUrl)}/v1/lp-encryption-keys/${encodeURIComponent(keyId)}`, {
    method: 'DELETE', headers: await requestHeaders(auth, 'DELETE', path, body), body,
  }));
}

export async function subscribeRelayEvents(
  baseUrl: string,
  wallet: string,
  afterSequence: number,
  onEvent: (message: RelayEventMessage) => void,
  onError: (error: Error) => void,
  auth?: FlareApiAuth,
): Promise<WebSocket> {
  if (!wallet || !Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('RFQ_SUBSCRIPTION_INVALID');
  const url = new URL(`${trimBaseUrl(baseUrl)}/v1/relay/events`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('wallet', wallet);
  url.searchParams.set('after', String(afterSequence));
  const protocols = auth?.token
    ? auth.token.startsWith('trf_bot_')
      ? await (async () => {
        const token = auth.token as string;
        const timestamp = Math.floor(Date.now() / 1_000);
        const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        return ['trustrfq.v1', `trustrfq-bot-${token}.${timestamp}.${digest}.${await botSignature(token, '/v1/relay/events', timestamp, digest)}`];
      })()
      : ['trustrfq.v1', `trustrfq-auth-${auth.token}`]
    : undefined;
  const socket = new WebSocket(url, protocols);
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data)) as RelayEventMessage;
      if (message.type !== 'relay.event' || !Number.isSafeInteger(message.cursor) || !message.event) throw new Error('RFQ_EVENT_INVALID');
      onEvent(message);
    } catch (error) {
      onError(error instanceof Error ? error : new Error('RFQ_EVENT_INVALID'));
    }
  });
  socket.addEventListener('error', () => onError(new Error('RFQ_WEBSOCKET_ERROR')));
  return socket;
}

export async function fetchFlareReadModel(baseUrl: string, wallet?: string, auth?: FlareApiAuth): Promise<FlareReadModel> {
  const path = '/v1/read-model';
  const response = await fetch(`${trimBaseUrl(baseUrl)}${path}${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''}`, { headers: await requestHeaders(auth, 'GET', path, '') });
  return readJson<FlareReadModel>(response);
}

export async function requestImmediateQuote(baseUrl: string, input: { readonly sellAsset: string; readonly receiveAsset: string; readonly amount: string; readonly minimumReceive: string }): Promise<ImmediateQuoteResponse> {
  return readJson<ImmediateQuoteResponse>(await fetch(`${trimBaseUrl(baseUrl)}/v1/quotes/immediate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }));
}

export async function createAuction(baseUrl: string, input: CreateAuctionInput, auth?: FlareApiAuth): Promise<AuctionRow> {
  const body = JSON.stringify(input);
  return readJson<AuctionRow>(await fetch(`${trimBaseUrl(baseUrl)}/v1/auctions`, {
    method: 'POST', headers: await requestHeaders(auth, 'POST', '/v1/auctions', body), body,
  }));
}

export async function createStandingBid(baseUrl: string, input: CreateStandingBidInput, auth?: FlareApiAuth): Promise<StandingBidRow> {
  const body = JSON.stringify(input);
  return readJson<StandingBidRow>(await fetch(`${trimBaseUrl(baseUrl)}/v1/standing-bids`, {
    method: 'POST', headers: await requestHeaders(auth, 'POST', '/v1/standing-bids', body), body,
  }));
}

export async function requestWithdrawal(baseUrl: string, input: CreateWithdrawalInput, auth?: FlareApiAuth): Promise<FacilityReadModel> {
  const body = JSON.stringify(input);
  return readJson<FacilityReadModel>(await fetch(`${trimBaseUrl(baseUrl)}/v1/facility/withdrawals`, {
    method: 'POST', headers: await requestHeaders(auth, 'POST', '/v1/facility/withdrawals', body), body,
  }));
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

async function requestHeaders(auth: FlareApiAuth | undefined, method?: string, path?: string, body?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth?.token) headers.authorization = `Bearer ${auth.token}`;
  if (!auth?.token?.startsWith('trf_bot_') || !method || !path || body === undefined) return headers;
  const timestamp = Math.floor(Date.now() / 1_000);
  const digestBytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const digest = [...new Uint8Array(digestBytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(auth.token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signatureBytes = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${method.toUpperCase()}\n${path}\n${timestamp}\n${digest}`));
  return { ...headers, 'x-trf-timestamp': String(timestamp), 'x-trf-body-sha256': digest, 'x-trf-signature': [...new Uint8Array(signatureBytes)].map((value) => value.toString(16).padStart(2, '0')).join('') };
}

async function botSignature(token: string, path: string, timestamp: number, digest: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`GET\n${path}\n${timestamp}\n${digest}`));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T | { error?: string };
  if (!response.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : 'API_REQUEST_FAILED');
  return body as T;
}
