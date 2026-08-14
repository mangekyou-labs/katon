import net from 'node:net';
import crypto from 'node:crypto';
import { resolve } from 'node:path';

const DOCUMENTED_HOST = '34.38.42.208';
const DOCUMENTED_PORT = 3306;
const DOCUMENTED_DATABASE = 'indexer';

const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000;
const CLIENT_SSL = 0x00000800;

function value(env, ...names) {
  for (const name of names) {
    const candidate = env?.[name];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

export function readIndexerConfig(env = process.env) {
  const host = value(env, 'FCC_INDEXER_MYSQL_HOST', 'FLARE_INDEXER_MYSQL_HOST') || DOCUMENTED_HOST;
  const portText = value(env, 'FCC_INDEXER_MYSQL_PORT', 'FLARE_INDEXER_MYSQL_PORT') || String(DOCUMENTED_PORT);
  const database = value(env, 'FCC_INDEXER_MYSQL_DATABASE', 'FLARE_INDEXER_MYSQL_DATABASE') || DOCUMENTED_DATABASE;
  const username = value(env, 'FCC_INDEXER_MYSQL_USER', 'FCC_INDEXER_MYSQL_USERNAME', 'FLARE_INDEXER_MYSQL_USER', 'FLARE_INDEXER_MYSQL_USERNAME');
  const password = value(env, 'FCC_INDEXER_MYSQL_PASSWORD', 'FLARE_INDEXER_MYSQL_PASSWORD');
  const port = Number(portText);

  if (!username || !password) throw new Error('FCC_INDEXER_CREDENTIALS_REQUIRED');
  if (host !== DOCUMENTED_HOST || port !== DOCUMENTED_PORT || database !== DOCUMENTED_DATABASE) {
    throw new Error('FCC_INDEXER_ENDPOINT_UNEXPECTED');
  }

  return Object.freeze({ host, port, database, username, password });
}

export function formatIndexerPreflight(config, { reachable, authenticated = false }) {
  const status = reachable ? 'PASS' : 'BLOCKED';
  const auth = authenticated ? ' mysqlAuthenticated=true' : '';
  return `fcc-indexer=${status} host=${config.host} port=${config.port} database=${config.database} credentialsConfigured=true${auth}`;
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest();
}

export function mysqlNativePasswordToken(password, scramble) {
  const stage1 = sha1(Buffer.from(password, 'utf8'));
  const stage2 = sha1(stage1);
  const digest = sha1(Buffer.concat([scramble, stage2]));
  return Buffer.from(stage1.map((byte, index) => byte ^ digest[index]));
}

export function parseMysqlGreeting(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 5) throw new Error('FCC_INDEXER_PROTOCOL');
  const payloadLength = packet.readUIntLE(0, 3);
  if (packet.length < payloadLength + 4) throw new Error('FCC_INDEXER_PROTOCOL');
  const payload = packet.subarray(4, payloadLength + 4);
  const protocol = payload[0];
  if (protocol !== 10) throw new Error('FCC_INDEXER_PROTOCOL');
  let offset = 1;
  const versionEnd = payload.indexOf(0, offset);
  if (versionEnd < 0) throw new Error('FCC_INDEXER_PROTOCOL');
  offset = versionEnd + 1 + 4;
  const scramblePart1 = payload.subarray(offset, offset + 8);
  offset += 9;
  if (offset + 2 > payload.length) throw new Error('FCC_INDEXER_PROTOCOL');
  const capabilityLow = payload.readUInt16LE(offset);
  offset += 2;
  if (offset === payload.length) {
    return {
      protocol,
      capabilities: capabilityLow,
      supportsTls: Boolean(capabilityLow & CLIENT_SSL),
      plugin: 'mysql_native_password',
      scramble: scramblePart1,
    };
  }
  offset += 1 + 2;
  const capabilityHigh = payload.readUInt16LE(offset);
  offset += 2;
  const capabilities = capabilityLow | (capabilityHigh << 16);
  const authLength = payload[offset] ?? 0;
  offset += 1 + 10;
  const scrambleLength = Math.max(13, authLength - 8);
  const scramblePart2 = payload.subarray(offset, offset + scrambleLength).subarray(0, Math.max(0, scrambleLength - 1));
  offset += scrambleLength;
  while (offset < payload.length && payload[offset] === 0) offset += 1;
  const pluginEnd = payload.indexOf(0, offset);
  const plugin = (pluginEnd < 0 ? payload.subarray(offset) : payload.subarray(offset, pluginEnd)).toString('utf8') || 'mysql_native_password';
  return {
    protocol,
    capabilities,
    supportsTls: Boolean(capabilities & CLIENT_SSL),
    plugin,
    scramble: Buffer.concat([scramblePart1, scramblePart2]),
  };
}

export function classifyMysqlResponse(payload) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) return 'FCC_INDEXER_PROTOCOL';
  if (payload[0] === 0x00) return 'FCC_INDEXER_AUTHENTICATED';
  // caching_sha2_password's full-auth request requires a secure channel.
  if (payload[0] === 0x01 && payload[1] === 0x04) return 'FCC_INDEXER_TLS_REQUIRED';
  if (payload[0] === 0xff && mysqlErrorCode(payload) === 3159) return 'FCC_INDEXER_TLS_REQUIRED';
  if (payload[0] === 0xff) return 'FCC_INDEXER_AUTH_FAILED';
  return 'FCC_INDEXER_PROTOCOL';
}

function mysqlCachingSha2PasswordToken(password, scramble) {
  const stage1 = crypto.createHash('sha256').update(password, 'utf8').digest();
  const stage2 = crypto.createHash('sha256').update(stage1).digest();
  const digest = crypto.createHash('sha256').update(Buffer.concat([stage2, scramble])).digest();
  return Buffer.from(stage1.map((byte, index) => byte ^ digest[index]));
}

function mysqlAuthToken(password, scramble, plugin) {
  if (plugin === 'mysql_native_password') return mysqlNativePasswordToken(password, scramble);
  if (plugin === 'caching_sha2_password') return mysqlCachingSha2PasswordToken(password, scramble);
  throw new Error('FCC_INDEXER_AUTH_PLUGIN_UNSUPPORTED');
}

function packet(payload, sequence) {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}

function mysqlClientResponse(config, greeting) {
  const desiredFlags = CLIENT_LONG_PASSWORD
    | CLIENT_CONNECT_WITH_DB
    | CLIENT_PROTOCOL_41
    | CLIENT_TRANSACTIONS
    | CLIENT_SECURE_CONNECTION
    | CLIENT_PLUGIN_AUTH
    | CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA;
  const serverFlags = greeting.capabilities ?? desiredFlags;
  const clientFlags = desiredFlags & serverFlags;
  const plugin = greeting.plugin || 'mysql_native_password';
  const token = mysqlAuthToken(config.password, greeting.scramble, plugin);
  const fixed = Buffer.alloc(4 + 4 + 1 + 23);
  fixed.writeUInt32LE(clientFlags, 0);
  fixed.writeUInt32LE(0xffffff, 4);
  fixed[8] = 33;
  const username = Buffer.from(`${config.username}\0`, 'utf8');
  const authLength = clientFlags & CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA
    ? Buffer.from([token.length])
    : Buffer.from([token.length]);
  const database = clientFlags & CLIENT_CONNECT_WITH_DB ? Buffer.from(`${config.database}\0`, 'utf8') : Buffer.alloc(0);
  const pluginName = clientFlags & CLIENT_PLUGIN_AUTH ? Buffer.from(`${plugin}\0`, 'utf8') : Buffer.alloc(0);
  return Buffer.concat([fixed, username, authLength, token, database, pluginName]);
}

function mysqlAuthSwitchResponse(config, payload) {
  const rest = payload.subarray(1);
  const pluginEnd = rest.indexOf(0);
  if (pluginEnd < 0) throw new Error('FCC_INDEXER_PROTOCOL');
  const plugin = rest.subarray(0, pluginEnd).toString('utf8');
  const scramble = rest.subarray(pluginEnd + 1).subarray(0, 20);
  if (scramble.length < 20) throw new Error('FCC_INDEXER_PROTOCOL');
  return mysqlAuthToken(config.password, scramble, plugin);
}

export function mysqlErrorCode(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 3 || payload[0] !== 0xff) return null;
  return payload.readUInt16LE(1);
}

export function probeMysqlAuth(config, { timeoutMs = 5000, connect = net.createConnection } = {}) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    let buffer = Buffer.alloc(0);
    let sequence = 0;
    let connected = false;
    let greeted = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    const fail = (code) => finish(reject, new Error(code));
    socket.setTimeout(timeoutMs, () => fail(connected ? 'FCC_INDEXER_HANDSHAKE_TIMEOUT' : 'FCC_INDEXER_CONNECT_TIMEOUT'));
    socket.once('connect', () => { connected = true; });
    socket.once('error', () => fail('FCC_INDEXER_UNREACHABLE'));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUIntLE(0, 3);
        if (buffer.length < length + 4) return;
        sequence = buffer[3] + 1;
        const payload = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        if (!greeted) {
          greeted = true;
          let greeting;
          try {
            greeting = parseMysqlGreeting(Buffer.concat([packet(payload, sequence - 1), Buffer.alloc(0)]));
          } catch {
            fail('FCC_INDEXER_PROTOCOL');
            return;
          }
          if (!greeting.scramble || greeting.scramble.length < 20) {
            fail('FCC_INDEXER_PROTOCOL');
            return;
          }
          try {
            socket.write(packet(mysqlClientResponse(config, greeting), sequence));
          } catch {
            fail('FCC_INDEXER_AUTH_PLUGIN_UNSUPPORTED');
          }
        } else {
          if (payload[0] === 0xfe && payload.length > 1) {
            try {
              socket.write(packet(mysqlAuthSwitchResponse(config, payload), sequence));
            } catch (error) {
              fail(error instanceof Error ? error.message : 'FCC_INDEXER_PROTOCOL');
            }
            continue;
          }
          // caching_sha2_password sends 0x01/0x03 for fast-auth progress before OK.
          if (payload[0] === 0x01) continue;
          const result = classifyMysqlResponse(payload);
          if (result === 'FCC_INDEXER_AUTHENTICATED') finish(resolvePromise, true);
          else if (result === 'FCC_INDEXER_AUTH_FAILED') fail(result);
          else fail(result);
        }
      }
    });
  });
}

export function probeIndexer(config, { timeoutMs = 5000, connect = net.createConnection } = {}) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    socket.setTimeout(timeoutMs, () => finish(reject, new Error('FCC_INDEXER_CONNECT_TIMEOUT')));
    socket.once('connect', () => finish(resolvePromise, true));
    socket.once('error', () => finish(reject, new Error('FCC_INDEXER_UNREACHABLE')));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { applyEnvFile, findWorktreeRoot } = await import('./load-worktree-env.mjs');
  const root = findWorktreeRoot();
  applyEnvFile(resolve(root, '.env'));
  applyEnvFile(resolve(root, '.env.fcc.local'));

  let config;
  try {
    config = readIndexerConfig();
    await probeMysqlAuth(config);
    console.log(formatIndexerPreflight(config, { reachable: true, authenticated: true }));
  } catch (error) {
    if (!config) {
      console.error(`fcc-indexer=BLOCKED reason=${error instanceof Error ? error.message : 'FCC_INDEXER_PREFLIGHT_FAILED'}`);
    } else {
      console.error(formatIndexerPreflight(config, { reachable: false }));
      console.error(`fcc-indexer-reason=${error instanceof Error ? error.message : 'FCC_INDEXER_PREFLIGHT_FAILED'}`);
    }
    process.exitCode = 1;
  }
}
