import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAuction,
  createStandingBid,
  finalizeRelayAuction,
  fetchFlareReadModel,
  issueLpBotCredential,
  openRelayAuction,
  listRelayAuctions,
  listRelayAuctionsPage,
  readRelayAuction,
  requestImmediateQuote,
  requestWithdrawal,
  registerRelayEncryptionKey,
  revokeRelayEncryptionKey,
  submitRelayBid,
  revokeLpBotCredential,
  subscribeRelayEvents,
} from '../packages/flare-sdk/src/api';

afterEach(() => vi.restoreAllMocks());

describe('Flare API client boundary', () => {
  it('loads the public read model and submits scoped workflow commands', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/read-model')) return new Response(JSON.stringify({ state: 'empty', updatedAt: 1, auctions: [], standingBids: [], activity: [], facility: { shares: '0', nav: '0', queuedWithdrawals: 0 } }), { status: 200 });
      if (url.endsWith('/quotes/immediate')) return new Response(JSON.stringify({ sellAsset: 'RWA', receiveAsset: 'USDX', sellAmount: '1', grossOutput: '1000', protocolFee: '5', netOutput: '995', minimumReceive: '995', protocolFeeBps: 50, route: 'standing-lp', status: 'ready' }), { status: 200 });
      if (url.endsWith('/auctions')) return new Response(JSON.stringify({ id: 'a', pair: 'RWA / USDX', status: 'open', bids: 0, expiry: 1 }), { status: 201 });
      if (url.endsWith('/standing-bids')) return new Response(JSON.stringify({ id: 'b', pair: 'RWA / USDX', capacity: '1', mode: 'instant', expiry: 1, status: 'active' }), { status: 201 });
      if (url.endsWith('/facility/withdrawals')) return new Response(JSON.stringify({ shares: '0', nav: '0', queuedWithdrawals: 1 }), { status: 201 });
      throw new Error(`UNEXPECTED_URL:${url}`);
    });

    await expect(fetchFlareReadModel('http://api/', '0xabc')).resolves.toMatchObject({ state: 'empty' });
    await expect(requestImmediateQuote('http://api/', { sellAsset: 'RWA', receiveAsset: 'USDX', amount: '1', minimumReceive: '995' })).resolves.toMatchObject({ netOutput: '995' });
    await expect(createAuction('http://api/', { wallet: '0xabc', pair: 'RWA / USDX', duration: '24h', minOutput: '995' }, { token: 'session-token' })).resolves.toMatchObject({ id: 'a' });
    await expect(createStandingBid('http://api/', { wallet: '0xabc', pair: 'RWA / USDX', capacity: '1', mode: 'instant', expiry: 1 }, { token: 'session-token' })).resolves.toMatchObject({ id: 'b' });
    await expect(requestWithdrawal('http://api/', { wallet: '0xabc', shares: '1', minAssets: '995' }, { token: 'session-token' })).resolves.toMatchObject({ queuedWithdrawals: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(initBody(fetchMock.mock.calls[2]?.[1])).toContain('RWA / USDX');
  });

  it('surfaces safe API errors without leaking response details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'PAIR_REQUIRED', detail: 'private input' }), { status: 400 }));
    await expect(createAuction('http://api', { wallet: '0xabc', pair: '', duration: '24h', minOutput: '1' })).rejects.toThrow('PAIR_REQUIRED');
  });

  it('preserves actionable HTTP status codes for API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429 }));
    await expect(createAuction('http://api', { wallet: '0xabc', pair: 'RWA / USDX', duration: '24h', minOutput: '1' })).rejects.toThrow('RATE_LIMITED');
  });

  it('assembles encrypted relay lifecycle requests with bearer authorization', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { wallet?: string };
      const row = { id: 'relay-1', commitment: '0xcommitment', duration: '24h', status: url.endsWith('/finalize') ? 'finalized' : 'open', openedAt: 1, expiresAt: 2, bidCount: url.endsWith('/bids') ? 1 : 0, envelope: { version: 1, keyId: 'key', commitment: '0xcommitment', expiresAt: 2, nonce: 'nonce', ciphertext: 'ciphertext' } };
      if (init?.body) expect(body.wallet ?? url.includes('wallet=0xabc')).toBeTruthy();
      return new Response(JSON.stringify(row), { status: 200 });
    });
    const envelope = { version: 1 as const, keyId: 'key', commitment: '0xcommitment', expiresAt: 2, nonce: 'nonce', ciphertext: 'ciphertext' };
    const auth = { token: 'session-token' };
    await expect(openRelayAuction('http://api/', { wallet: '0xabc', eligibleLps: ['lp-1'], duration: '24h', envelope }, auth)).resolves.toMatchObject({ id: 'relay-1' });
    await expect(submitRelayBid('http://api/', 'relay-1', { wallet: '0xabc', idempotencyKey: 'retry-1', envelope }, auth)).resolves.toMatchObject({ bidCount: 1 });
    await expect(readRelayAuction('http://api/', 'relay-1', '0xabc')).resolves.toMatchObject({ id: 'relay-1' });
    await expect(finalizeRelayAuction('http://api/', 'relay-1', '0xabc', auth)).resolves.toMatchObject({ status: 'finalized' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer session-token' });
  });

  it('assembles LP encryption-key rotation and revocation requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      if (init?.method === 'PUT') expect(body.keyId).toBe('key-b');
      return new Response(JSON.stringify({ lpId: 'lp-1', keyId: body.keyId ?? 'key-b', status: init?.method === 'DELETE' ? 'revoked' : 'active' }), { status: 200 });
    });
    await expect(registerRelayEncryptionKey('http://api/', { wallet: 'lp-1', keyId: 'key-b', publicKey: 'pub-b', expiresAt: 300 }, { token: 'session-token' })).resolves.toMatchObject({ status: 'active' });
    await expect(revokeRelayEncryptionKey('http://api/', 'key-b', { wallet: 'lp-1', revokedAt: 220 }, { token: 'session-token' })).resolves.toMatchObject({ status: 'revoked' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('reads role-scoped relay metadata without requesting envelope contents', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ auctions: [{ id: 'relay-1', commitment: '0xcommitment', duration: '24h', status: 'open', openedAt: 1, expiresAt: 2, bidCount: 0 }] }), { status: 200 }));
    await expect(listRelayAuctions('http://api/', 'lp-1')).resolves.toMatchObject([{ id: 'relay-1', bidCount: 0 }]);
  });

  it('requests bounded relay metadata pages with an opaque cursor', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ auctions: [], nextCursor: 'page-2' }), { status: 200 }));
    await expect(listRelayAuctionsPage('http://api/', 'lp-1', { cursor: 'page-1', limit: 2 }, { token: 'session-token' })).resolves.toEqual({ auctions: [], nextCursor: 'page-2' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('wallet=lp-1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('cursor=page-1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=2');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer session-token' });
  });

  it('signs bot-authenticated relay and read-model GETs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ auctions: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'empty', updatedAt: 1, auctions: [], standingBids: [], activity: [], facility: { shares: '0', nav: '0', queuedWithdrawals: 0 } }), { status: 200 }));
    await listRelayAuctionsPage('http://api/', 'lp-1', { limit: 2 }, { token: 'trf_bot_secret' });
    await fetchFlareReadModel('http://api/', 'lp-1', { token: 'trf_bot_secret' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty('x-trf-signature');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty('x-trf-body-sha256');
  });

  it('uses the admin bearer boundary for LP bot credential lifecycle', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'cred-1', token: 'trf_bot_secret', wallet: '0xabc', institution: 'desk-a', scopes: ['bid:submit'], expiresAt: 100 }), { status: 201 });
      return new Response(JSON.stringify({ status: 'revoked' }), { status: 200 });
    });
    await expect(issueLpBotCredential('http://api/', { wallet: '0xabc', institution: 'desk-a', scopes: ['bid:submit'], expiresAt: 100 }, 'admin-secret')).resolves.toMatchObject({ id: 'cred-1' });
    await expect(revokeLpBotCredential('http://api/', 'cred-1', 'admin-secret')).resolves.toEqual({ status: 'revoked' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer admin-secret' });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer admin-secret' });
  });

  it('adds replay-bound bot headers to mutation requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'relay-1', commitment: '0xcommitment', duration: '24h', status: 'open', openedAt: 1, expiresAt: 2, bidCount: 0, envelope: { version: 1, keyId: 'key', commitment: '0xcommitment', expiresAt: 2, nonce: 'nonce', ciphertext: 'ciphertext' } }), { status: 201 }));
    const envelope = { version: 1 as const, keyId: 'key', commitment: '0xcommitment', expiresAt: 2, nonce: 'nonce', ciphertext: 'ciphertext' };
    await openRelayAuction('http://api/', { wallet: '0xabc', eligibleLps: ['lp-1'], duration: '24h', envelope }, { token: 'trf_bot_secret' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer trf_bot_secret' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty('x-trf-timestamp');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty('x-trf-body-sha256');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty('x-trf-signature');
  });

  it('builds a cursor-resumable relay WebSocket subscription URL', async () => {
    const socket = await subscribeRelayEvents('https://api.example/', 'lp-1', 42, () => undefined, () => undefined);
    expect(socket.url).toBe('wss://api.example/v1/relay/events?wallet=lp-1&after=42');
    socket.close();
  });

  it('builds a signed bot WebSocket subprotocol without putting credentials in the URL', async () => {
    const socket = await subscribeRelayEvents('https://api.example/', 'lp-1', 42, () => undefined, () => undefined, { token: 'trf_bot_secret' });
    expect(socket.url).toBe('wss://api.example/v1/relay/events?wallet=lp-1&after=42');
    expect(socket.protocol).toBe('');
    socket.close();
  });
});

function initBody(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}
