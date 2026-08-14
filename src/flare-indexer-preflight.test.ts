import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  classifyMysqlResponse,
  formatIndexerPreflight,
  mysqlNativePasswordToken,
  parseMysqlGreeting,
  probeMysqlAuth,
  readIndexerConfig,
} from '../tools/fcc-indexer-preflight.mjs';
import { fetchProxyInfo, summarizeProxyInfo } from '../tools/fcc-proxy-preflight.mjs';

describe('FCC indexer preflight', () => {
  it('requires the support-provided MySQL credentials', () => {
    expect(() => readIndexerConfig({
      FCC_INDEXER_MYSQL_HOST: '34.38.42.208',
      FCC_INDEXER_MYSQL_DATABASE: 'indexer',
    })).toThrow('FCC_INDEXER_CREDENTIALS_REQUIRED');
  });

  it('accepts the documented Coston2 endpoint and never formats secrets', () => {
    const config = readIndexerConfig({
      FCC_INDEXER_MYSQL_HOST: '34.38.42.208',
      FCC_INDEXER_MYSQL_PORT: '3306',
      FCC_INDEXER_MYSQL_DATABASE: 'indexer',
      FCC_INDEXER_MYSQL_USER: 'support-user',
      FCC_INDEXER_MYSQL_PASSWORD: 'support-password',
    });

    const output = formatIndexerPreflight(config, { reachable: true });

    expect(output).toBe('fcc-indexer=PASS host=34.38.42.208 port=3306 database=indexer credentialsConfigured=true');
    expect(output).not.toContain('support-user');
    expect(output).not.toContain('support-password');
  });

  it('supports the FLARE_* aliases used by the official proxy configuration', () => {
    const config = readIndexerConfig({
      FLARE_INDEXER_MYSQL_HOST: '34.38.42.208',
      FLARE_INDEXER_MYSQL_PORT: '3306',
      FLARE_INDEXER_MYSQL_DATABASE: 'indexer',
      FLARE_INDEXER_MYSQL_USER: 'support-user',
      FLARE_INDEXER_MYSQL_PASSWORD: 'support-password',
    });

    expect(config).toMatchObject({ host: '34.38.42.208', port: 3306, database: 'indexer' });
  });

  it('parses a MySQL greeting without exposing the server banner', () => {
    const payload = Buffer.concat([
      Buffer.from([0x0a]),
      Buffer.from('8.0.36\0'),
      Buffer.from([1, 0, 0, 0]),
      Buffer.alloc(8, 7),
      Buffer.from([0]),
      Buffer.from([0xff, 0xf7]),
      Buffer.from([33]),
      Buffer.from([2, 0]),
      Buffer.from([0, 0]),
      Buffer.from([0x15]),
      Buffer.alloc(10),
      Buffer.alloc(13, 9),
      Buffer.from('mysql_native_password\0'),
    ]);
    const packet = Buffer.concat([Buffer.from([payload.length, 0, 0, 0]), payload]);
    expect(parseMysqlGreeting(packet)).toMatchObject({
      protocol: 10,
      plugin: 'mysql_native_password',
      capabilities: expect.any(Number),
      supportsTls: false,
    });
  });

  it('derives the mysql_native_password response without retaining the password', () => {
    const token = mysqlNativePasswordToken('password', Buffer.from('01234567890123456789'));
    expect(token).toHaveLength(20);
    expect(token.toString('hex')).toBe('352fa47dce3067a3629e64048732064561dccb28');
  });

  it('classifies authentication errors as a distinct preflight failure', () => {
    expect(classifyMysqlResponse(Buffer.from([0xff, 0x15, 0x04]))).toBe('FCC_INDEXER_AUTH_FAILED');
    expect(classifyMysqlResponse(Buffer.from([0x00, 0x00]))).toBe('FCC_INDEXER_AUTHENTICATED');
    expect(classifyMysqlResponse(Buffer.from([0x01, 0x04]))).toBe('FCC_INDEXER_TLS_REQUIRED');
  });

  it('extracts only safe signing-policy freshness fields from proxy info', () => {
    expect(summarizeProxyInfo({ teeInfo: { teeId: 'tee-a', extensionId: '65537', lastSigningPolicyId: 42 } })).toEqual({
      teeId: 'tee-a',
      extensionId: '65537',
      lastSigningPolicyId: 42,
    });
  });

  it('requires HTTPS for proxy freshness checks and normalizes transport errors', async () => {
    await expect(fetchProxyInfo('http://127.0.0.1/info')).rejects.toThrow('FCC_PROXY_HTTPS_REQUIRED');
    await expect(fetchProxyInfo('https://proxy.invalid/info', { fetchImpl: async () => { throw new Error('dns'); } })).rejects.toThrow('FCC_PROXY_UNREACHABLE');
  });

  it('authenticates against a MySQL greeting before reporting the indexer ready', async () => {
    const payload = Buffer.concat([
      Buffer.from([0x0a]), Buffer.from('8.0.36\0'), Buffer.from([1, 0, 0, 0]), Buffer.alloc(8, 7),
      Buffer.from([0]), Buffer.from([0xff, 0xf7]), Buffer.from([33]), Buffer.from([2, 0]), Buffer.from([0, 0]),
      Buffer.from([0x15]), Buffer.alloc(10), Buffer.alloc(13, 9), Buffer.from('mysql_native_password\0'),
    ]);
    const greeting = Buffer.concat([Buffer.from([payload.length, 0, 0, 0]), payload]);
    class FakeSocket extends EventEmitter {
      setTimeout() {}
      destroy() {}
      write() { queueMicrotask(() => this.emit('data', Buffer.from([2, 0, 0, 2, 0, 0]))); }
    }
    const socket = new FakeSocket();
    const result = probeMysqlAuth({ host: 'indexer', port: 3306, database: 'indexer', username: 'u', password: 'p' }, { connect: () => socket });
    queueMicrotask(() => socket.emit('data', greeting));
    await expect(result).resolves.toBe(true);
  });

  it('distinguishes a post-connect handshake timeout from a connect timeout', async () => {
    class FakeSocket extends EventEmitter {
      setTimeout(_timeoutMs, callback) { this.timeout = callback; }
      destroy() {}
      connect() { queueMicrotask(() => this.emit('connect')); }
    }
    const socket = new FakeSocket();
    const result = probeMysqlAuth(
      { host: 'indexer', port: 3306, database: 'indexer', username: 'u', password: 'p' },
      { connect: () => { socket.connect(); return socket; } },
    );
    await Promise.resolve();
    socket.timeout();
    await expect(result).rejects.toThrow('FCC_INDEXER_HANDSHAKE_TIMEOUT');
  });

  it('continues authentication after a server auth-switch request', async () => {
    const payload = Buffer.concat([
      Buffer.from([0x0a]), Buffer.from('8.0.36\0'), Buffer.from([1, 0, 0, 0]), Buffer.alloc(8, 7),
      Buffer.from([0]), Buffer.from([0xff, 0xf7]), Buffer.from([33]), Buffer.from([2, 0]), Buffer.from([0, 0]),
      Buffer.from([0x15]), Buffer.alloc(10), Buffer.alloc(13, 9), Buffer.from('mysql_native_password\0'),
    ]);
    const greeting = Buffer.concat([Buffer.from([payload.length, 0, 0, 0]), payload]);
    class FakeSocket extends EventEmitter {
      writes = [];
      setTimeout() {}
      destroy() {}
      write(value) {
        this.writes.push(value);
        if (this.writes.length === 1) {
          const payload = Buffer.concat([Buffer.from([0xfe]), Buffer.from('mysql_native_password\0'), Buffer.alloc(20, 3)]);
          const header = Buffer.alloc(4);
          header.writeUIntLE(payload.length, 0, 3);
          header[3] = 2;
          queueMicrotask(() => this.emit('data', Buffer.concat([header, payload])));
        } else {
          queueMicrotask(() => this.emit('data', Buffer.from([2, 0, 0, 3, 0, 0])));
        }
      }
    }
    const socket = new FakeSocket();
    const result = probeMysqlAuth({ host: 'indexer', port: 3306, database: 'indexer', username: 'u', password: 'p' }, { connect: () => socket });
    queueMicrotask(() => socket.emit('data', greeting));
    await expect(result).resolves.toBe(true);
    expect(socket.writes).toHaveLength(2);
  });
});
