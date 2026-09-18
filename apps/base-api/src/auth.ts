import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyMessage, type Address, type Hex } from 'viem';
import type { BaseApiConfig, BaseAuthContext, BotCredential, BotScope } from './types';

export interface SiweNonce {
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
  readonly domain: string;
  readonly chainId: number;
}

export interface StoredNonce extends SiweNonce {
  consumed: boolean;
}

export interface NonceStore {
  put(nonce: StoredNonce): Promise<void>;
  consume(nonce: string, now: bigint): Promise<StoredNonce | undefined>;
}

export interface StoredSession {
  readonly tokenHash: string;
  readonly identity: Address;
  readonly domain: string;
  readonly chainId: number;
  readonly expiresAt: bigint;
}

export interface SessionStore {
  put(session: StoredSession): Promise<void>;
  get(tokenHash: string): Promise<StoredSession | undefined>;
}

export class NonceService {
  private readonly nonces = new Map<string, StoredNonce>();

  constructor(private readonly store?: NonceStore) {}

  issue(now: bigint, config: Pick<BaseApiConfig, 'domainName' | 'chainId' | 'sessionTtlSeconds'>): SiweNonce {
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = new Date(Number(now) * 1000).toISOString();
    const expirationTime = new Date((Number(now) + config.sessionTtlSeconds) * 1000).toISOString();
    const result = { nonce, issuedAt, expirationTime, domain: config.domainName, chainId: config.chainId };
    this.nonces.set(nonce, { ...result, consumed: false });
    return result;
  }

  async issuePersistent(now: bigint, config: Pick<BaseApiConfig, 'domainName' | 'chainId' | 'sessionTtlSeconds'>): Promise<SiweNonce> {
    const result = this.issue(now, config);
    if (this.store) await this.store.put(this.nonces.get(result.nonce) as StoredNonce);
    return result;
  }

  async consume(nonce: string, now: bigint): Promise<StoredNonce> {
    if (this.store) {
      const stored = await this.store.consume(nonce, now);
      if (!stored) throw new Error('SIWE_NONCE_REPLAY');
      if (BigInt(Math.floor(Date.parse(stored.expirationTime) / 1000)) <= now) throw new Error('SIWE_NONCE_EXPIRED');
      return stored;
    }
    const stored = this.nonces.get(nonce);
    if (!stored || stored.consumed) throw new Error('SIWE_NONCE_REPLAY');
    if (BigInt(Math.floor(Date.parse(stored.expirationTime) / 1000)) <= now) throw new Error('SIWE_NONCE_EXPIRED');
    stored.consumed = true;
    return stored;
  }
}

export class SessionService {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(
    private readonly config: Pick<BaseApiConfig, 'sessionTtlSeconds' | 'domainName' | 'chainId'>,
    private readonly store?: SessionStore,
  ) {}

  async create(identity: Address, now: bigint): Promise<string> {
    const token = `katon_session_${randomBytes(32).toString('base64url')}`;
    const tokenHash = hashToken(token);
    const session = {
      tokenHash,
      identity,
      domain: this.config.domainName,
      chainId: this.config.chainId,
      expiresAt: now + BigInt(this.config.sessionTtlSeconds),
    } satisfies StoredSession;
    this.sessions.set(tokenHash, session);
    await this.store?.put(session);
    return token;
  }

  async authenticate(token: string, now: bigint): Promise<BaseAuthContext> {
    const tokenHash = hashToken(token);
    const stored = (await this.store?.get(tokenHash)) ?? this.sessions.get(tokenHash);
    if (!stored || stored.expiresAt <= now) throw new Error('SESSION_INVALID');
    if (stored.domain !== this.config.domainName || stored.chainId !== this.config.chainId) throw new Error('SESSION_INVALID');
    return { kind: 'siwe', identity: stored.identity, scopes: ['keeper', 'lp'] };
  }
}

export interface SiweVerificationResult {
  readonly identity: Address;
  readonly sessionToken: string;
}

export class SiweAuthenticator {
  constructor(
    private readonly nonceService: NonceService,
    private readonly sessions: SessionService,
    private readonly config: Pick<BaseApiConfig, 'domainName' | 'chainId'>,
  ) {}

  async verify(input: { readonly message: string; readonly signature: Hex }, now: bigint): Promise<SiweVerificationResult> {
    const parsed = parseSiweMessage(input.message);
    if (parsed.domain !== this.config.domainName) throw new Error('SIWE_DOMAIN_MISMATCH');
    if (parsed.chainId !== this.config.chainId) throw new Error('SIWE_CHAIN_MISMATCH');
    if (parsed.version !== '1') throw new Error('SIWE_VERSION_INVALID');
    const issuedAt = parseTimestamp(parsed.issuedAt, 'SIWE_ISSUED_AT_INVALID');
    const expirationTime = parseTimestamp(parsed.expirationTime, 'SIWE_EXPIRATION_INVALID');
    if (issuedAt > now || expirationTime <= now || expirationTime <= issuedAt) throw new Error('SIWE_EXPIRED');
    const valid = await verifyMessage({ address: parsed.address, message: input.message, signature: input.signature });
    if (!valid) throw new Error('SIWE_SIGNATURE_INVALID');
    const nonce = await this.nonceService.consume(parsed.nonce, now);
    if (nonce.domain !== this.config.domainName) throw new Error('SIWE_DOMAIN_MISMATCH');
    if (nonce.chainId !== this.config.chainId) throw new Error('SIWE_CHAIN_MISMATCH');
    return { identity: parsed.address, sessionToken: await this.sessions.create(parsed.address, now) };
  }
}

export class HmacAuthenticator {
  private readonly credentials: ReadonlyMap<string, BotCredential>;

  constructor(private readonly config: Pick<BaseApiConfig, 'botCredentials' | 'clockToleranceSeconds'>, private readonly now: () => bigint) {
    this.credentials = new Map(config.botCredentials.map((credential) => [credential.id, credential]));
  }

  authenticate(input: {
    readonly authorization?: string;
    readonly keyId?: string;
    readonly timestamp?: string;
    readonly bodySha256?: string;
    readonly signature?: string;
    readonly method: string;
    readonly path: string;
    readonly body: string;
    readonly requiredScope?: BotScope;
  }): BaseAuthContext {
    const legacyMatch = input.authorization?.match(/^Bearer katon_bot_([^\.]+)\.(.+)$/);
    const canonicalMatch = input.authorization?.match(/^Katon-HMAC ([^:]+):(0x[0-9a-fA-F]+)$/);
    const credentialId = canonicalMatch?.[1] ?? input.keyId ?? legacyMatch?.[1];
    if (canonicalMatch && input.keyId && input.keyId !== credentialId) throw new Error('BOT_AUTH_INVALID');
    const credential = credentialId ? this.credentials.get(credentialId) : undefined;
    if (!credential) throw new Error('BOT_AUTH_INVALID');
    if (legacyMatch && (!constantEqual(legacyMatch[1], credential.id) || !constantEqual(legacyMatch[2], credential.secret))) throw new Error('BOT_AUTH_INVALID');
    if (canonicalMatch && !constantEqual(canonicalMatch[1], credential.id)) throw new Error('BOT_AUTH_INVALID');
    if (input.requiredScope && !credential.scopes.includes(input.requiredScope) && !credential.scopes.includes('internal')) throw new Error('BOT_SCOPE_DENIED');
    const timestamp = input.timestamp;
    if (!timestamp || !/^\d+$/.test(timestamp)) throw new Error('BOT_TIMESTAMP_INVALID');
    const timestampNumber = BigInt(timestamp);
    if (timestampNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('BOT_TIMESTAMP_INVALID');
    const now = this.now();
    const tolerance = BigInt(this.config.clockToleranceSeconds);
    if (timestampNumber > now + tolerance || timestampNumber < now - tolerance) throw new Error('BOT_TIMESTAMP_INVALID');
    const canonical = canonicalBotSignature(input.method, input.path, Number(timestampNumber), input.body, credential.secret);
    if (!input.bodySha256 || !constantEqual(input.bodySha256, canonical.bodyHash)) throw new Error('BOT_BODY_DIGEST_INVALID');
    const providedSignature = input.signature ?? canonicalMatch?.[2];
    if (!providedSignature || !constantEqual(providedSignature, canonical.signature)) throw new Error('BOT_SIGNATURE_INVALID');
    return {
      kind: 'bot',
      identity: credential.identity ?? '0x0000000000000000000000000000000000000000',
      scopes: credential.scopes,
      credentialId: credential.id,
    };
  }
}

export function canonicalBotSignature(method: string, path: string, timestamp: number, body: string): {
  readonly canonical: string;
  readonly bodyHash: Hex;
  readonly signature: Hex;
};
export function canonicalBotSignature(method: string, path: string, timestamp: number, body: string, secret: string): {
  readonly canonical: string;
  readonly bodyHash: Hex;
  readonly signature: Hex;
};
export function canonicalBotSignature(method: string, path: string, timestamp: number, body: string, secret?: string): {
  readonly canonical: string;
  readonly bodyHash: Hex;
  readonly signature: Hex;
} {
  const bodyHash = `0x${createHash('sha256').update(body, 'utf8').digest('hex')}` as Hex;
  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash.slice(2)}`;
  const signature = `0x${createHmac('sha256', secret ?? '').update(canonical, 'utf8').digest('hex')}` as Hex;
  return { canonical, bodyHash, signature };
}

export function createHmacHeaders(
  id: string,
  secret: string,
  method: string,
  path: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  const canonical = canonicalBotSignature(method, path, timestamp, body, secret);
  const signature = `0x${createHmac('sha256', secret).update(canonical.canonical, 'utf8').digest('hex')}`;
  return {
    authorization: `Bearer katon_bot_${id}.${secret}`,
    'x-katon-timestamp': String(timestamp),
    'x-katon-body-sha256': canonical.bodyHash,
    'x-katon-signature': signature,
  };
}

export function parseSiweMessage(message: string): {
  readonly domain: string;
  readonly address: Address;
  readonly uri: string;
  readonly version: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
} {
  const lines = message.split('\n').map((line) => line.trimEnd());
  const first = lines[0]?.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  const address = lines[1];
  if (!first || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('SIWE_MESSAGE_INVALID');
  const fields = new Map<string, string>();
  for (const line of lines.slice(2)) {
    const index = line.indexOf(':');
    if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  const uri = fields.get('URI');
  const version = fields.get('Version');
  const chainId = fields.get('Chain ID');
  const nonce = fields.get('Nonce');
  const issuedAt = fields.get('Issued At');
  const expirationTime = fields.get('Expiration Time');
  if (!uri || !version || !chainId || !nonce || !issuedAt || !expirationTime) throw new Error('SIWE_MESSAGE_INVALID');
  if (!/^\d+$/.test(chainId)) throw new Error('SIWE_CHAIN_INVALID');
  return {
    domain: first[1],
    address: address.toLowerCase() as Address,
    uri,
    version,
    chainId: Number(chainId),
    nonce,
    issuedAt,
    expirationTime,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseTimestamp(value: string, error: string): bigint {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(error);
  return BigInt(Math.floor(parsed / 1_000));
}
