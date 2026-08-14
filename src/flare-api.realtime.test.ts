import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { BlindRelay } from '../apps/flare-api/src/blindRelay';
import { attachRelayRealtime } from '../apps/flare-api/src/realtime';

const envelope = {
  version: 1 as const,
  keyId: 'tee-key',
  commitment: '0xauction',
  expiresAt: 20_000_000,
  nonce: 'opaque-nonce',
  ciphertext: 'opaque-ciphertext',
};

describe('relay realtime transport', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('replays from a cursor and streams only authorized relay events', async () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'auction-ws', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    const first = relay.readEvents('lp-1');
    const server = createServer();
    servers.push(server);
    attachRelayRealtime(server, relay);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/relay/events?wallet=lp-1&after=${first.cursor - 1}`);
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    await once(socket, 'open');
    relay.submitBid({ auctionId: 'auction-ws', lpId: 'lp-1', idempotencyKey: 'bid-ws', envelope });
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.close();
    expect(messages.map((message) => (message.event as { kind: string }).kind)).toEqual(['auction.opened', 'bid.accepted']);
  });

  it('rejects a realtime connection without a role wallet', async () => {
    const server = createServer();
    servers.push(server);
    attachRelayRealtime(server, new BlindRelay());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/relay/events`);
    const [code] = await once(socket, 'close');
    expect(code).toBe(1008);
  });

  it('rejects excess realtime connections for one role actor', async () => {
    const previous = process.env.FLARE_RELAY_MAX_CONNECTIONS_PER_ACTOR;
    process.env.FLARE_RELAY_MAX_CONNECTIONS_PER_ACTOR = '1';
    try {
      const relay = new BlindRelay();
      const server = createServer();
      servers.push(server);
      attachRelayRealtime(server, relay);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
    const url = `ws://127.0.0.1:${address.port}/v1/relay/events?wallet=lp-1`;
    const first = new WebSocket(url, ['trustrfq.v1', 'trustrfq-auth-session-ok']);
    await once(first, 'open');
    expect(first.protocol).toBe('trustrfq.v1');
      const second = new WebSocket(url);
      const [code] = await once(second, 'close');
      expect(code).toBe(1008);
      first.close();
    } finally {
      if (previous === undefined) delete process.env.FLARE_RELAY_MAX_CONNECTIONS_PER_ACTOR;
      else process.env.FLARE_RELAY_MAX_CONNECTIONS_PER_ACTOR = previous;
    }
  });

  it('authenticates role subscriptions through the WebSocket subprotocol', async () => {
    const relay = new BlindRelay();
    const server = createServer();
    servers.push(server);
    attachRelayRealtime(server, relay, { authorize: (actor, token) => actor === 'lp-1' && token === 'session-ok' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
    const good = new WebSocket(`ws://127.0.0.1:${address.port}/v1/relay/events?wallet=lp-1`, ['trustrfq.v1', 'trustrfq-auth-session-ok']);
    await once(good, 'open');
    good.close();
    const bad = new WebSocket(`ws://127.0.0.1:${address.port}/v1/relay/events?wallet=lp-1`, ['trustrfq.v1', 'trustrfq-auth-wrong']);
    const [code] = await once(bad, 'close');
    expect(code).toBe(1008);
  });

  it('supports a validated bot WebSocket auth protocol', async () => {
    const relay = new BlindRelay();
    const server = createServer();
    servers.push(server);
    const now = Math.floor(Date.now() / 1_000);
    attachRelayRealtime(server, relay, {
      authorize: () => false,
      authorizeBot: (actor, token, timestamp, digest, signature) => actor === 'lp-1' && token === 'bot-token' && timestamp === now && digest.length === 64 && signature.length === 64,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
    const good = new WebSocket(`ws://127.0.0.1:${address.port}/v1/relay/events?wallet=lp-1`, ['trustrfq.v1', `trustrfq-bot-bot-token.${now}.${'a'.repeat(64)}.${'b'.repeat(64)}`]);
    await once(good, 'open');
    good.close();
  });
});
