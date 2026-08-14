import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import type WebSocketType from 'ws';
import type { WebSocketServer as WebSocketServerType } from 'ws';

import type { BlindRelay, RelayEvent } from './blindRelay';
import { ConnectionLimiter } from './limits';
import { botBodyDigest, botRequestSignature, signaturesEqual } from './botAuth';

const path = '/v1/relay/events';
const AUTH_PROTOCOL_PREFIX = 'trustrfq-auth-';
const BOT_AUTH_PROTOCOL_PREFIX = 'trustrfq-bot-';
const NEGOTIATED_PROTOCOL = 'trustrfq.v1';
const require = createRequire(import.meta.url);
const WebSocket = require('ws') as typeof WebSocketType;
const WebSocketServer = (require('ws') as typeof import('ws')).WebSocketServer as typeof WebSocketServerType;

export interface RelayRealtimeOptions {
  readonly authorize?: (actor: string, token: string) => boolean;
  readonly authorizeBot?: (actor: string, token: string, timestamp: number, digest: string, signature: string, request: IncomingMessage) => boolean;
  readonly requireAuth?: boolean;
}

export function attachRelayRealtime(server: HttpServer, relay: BlindRelay, options: RelayRealtimeOptions = {}): InstanceType<typeof WebSocketServer> {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024,
    handleProtocols: (protocols: Set<string>) => protocols.has(NEGOTIATED_PROTOCOL) ? NEGOTIATED_PROTOCOL : false,
  });
  const connectionLimiter = new ConnectionLimiter(Number(process.env.FLARE_RELAY_MAX_CONNECTIONS_PER_ACTOR ?? 4));
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    const actor = url.searchParams.get('wallet')?.trim();
    const after = Number(url.searchParams.get('after') ?? '0');
    if (!actor || !Number.isSafeInteger(after) || after < 0) {
      sockets.handleUpgrade(request, socket as Socket, head, (client: WebSocketType) => client.close(1008, 'SUBSCRIPTION_INVALID'));
      return;
    }
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim()) ?? [];
    const protocol = protocols.find((value) => value.startsWith(AUTH_PROTOCOL_PREFIX));
    const botProtocol = protocols.find((value) => value.startsWith(BOT_AUTH_PROTOCOL_PREFIX));
    const botAuth = botProtocol ? parseBotProtocol(botProtocol, request.url ?? '/') : undefined;
    const authorizedHuman = protocol ? options.authorize?.(actor, protocol.slice(AUTH_PROTOCOL_PREFIX.length)) === true : false;
    const authorizedBot = botAuth && options.authorizeBot
      ? options.authorizeBot(actor, botAuth.token, botAuth.timestamp, botAuth.digest, botAuth.signature, request)
      : false;
    const authConfigured = Boolean(options.authorize || options.authorizeBot);
    if (authConfigured && (options.requireAuth !== false || protocol || botProtocol) && !authorizedHuman && !authorizedBot) {
      sockets.handleUpgrade(request, socket as Socket, head, (client: WebSocketType) => client.close(1008, 'AUTH_REQUIRED'));
      return;
    }
    sockets.handleUpgrade(request, socket as Socket, head, (client: WebSocketType) => {
      if (!connectionLimiter.acquire(actor)) {
        client.close(1008, 'CONNECTION_LIMIT');
        return;
      }
      sockets.emit('connection', client, request, actor, after);
    });
  });
  sockets.on('connection', (client: WebSocketType, _request: IncomingMessage, actor: string, after: number) => {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = relay.subscribe(actor, after, (event: RelayEvent) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'relay.event', cursor: event.sequence, event }));
      });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unsubscribe?.();
        connectionLimiter.release(actor);
      };
      client.on('close', release);
      client.on('error', release);
    } catch {
      connectionLimiter.release(actor);
      client.close(1008, 'SUBSCRIPTION_INVALID');
    }
  });
  return sockets;
}

function parseBotProtocol(protocol: string, requestUrl: string): { readonly token: string; readonly timestamp: number; readonly digest: string; readonly signature: string } | undefined {
  const parts = protocol.slice(BOT_AUTH_PROTOCOL_PREFIX.length).split('.');
  if (parts.length !== 4) return undefined;
  const [token, timestampText, digest, signature] = parts;
  const timestamp = Number(timestampText);
  if (!token || !Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/i.test(digest) || !/^[0-9a-f]{64}$/i.test(signature)) return undefined;
  const expected = botRequestSignature(token, 'GET', new URL(requestUrl, 'http://127.0.0.1').pathname, timestamp, digest);
  if (!signaturesEqual(signature, expected) || digest !== botBodyDigest('')) return undefined;
  return { token, timestamp, digest, signature };
}
