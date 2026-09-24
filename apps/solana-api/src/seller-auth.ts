import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { decodeBase58 } from '@katon/solana-core';

export type SellerCluster = 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta';

export interface SellerSessionClaims {
  readonly wallet: string;
  readonly origin: string;
  readonly cluster: SellerCluster;
  readonly expiresAtMs: number;
  readonly sessionId: string;
}

interface SellerChallenge {
  readonly wallet: string;
  readonly origin: string;
  readonly cluster: SellerCluster;
  readonly message: string;
  readonly expiresAtMs: number;
}

interface SellerSessionPayload extends SellerSessionClaims {
  readonly version: 1;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_MS = 5 * 60_000;
const SUPPORTED_CLUSTERS = new Set<SellerCluster>(['localnet', 'devnet', 'testnet', 'mainnet-beta']);

function publicKeyObject(wallet: string) {
  const raw = decodeBase58(wallet);
  if (!raw || raw.length !== 32) throw new Error('Seller wallet must be a canonical Solana public key');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
}

export function canonicalSellerOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value || url.username || url.password) {
      throw new Error('invalid origin');
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('non-local Seller origins must use HTTPS');
    }
    return url.origin;
  } catch {
    throw new Error('Seller origin is invalid or non-canonical');
  }
}

function parseCluster(value: string): SellerCluster {
  if (!SUPPORTED_CLUSTERS.has(value as SellerCluster)) throw new Error('Seller cluster is unsupported');
  return value as SellerCluster;
}

function equalMac(left: string, right: string): boolean {
  const a = Buffer.from(left, 'base64url');
  const b = Buffer.from(right, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateSignature(signatureBase64Url: string): Buffer {
  const signature = Buffer.from(signatureBase64Url, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== signatureBase64Url) throw new Error('Seller challenge signature is invalid');
  return signature;
}

/** One-use proof of wallet control with an in-memory, origin and cluster bound session. */
export class SellerSessionService {
  private readonly challenges = new Map<string, SellerChallenge>();

  constructor(
    private readonly secret: string,
    private readonly configuredCluster: SellerCluster,
    private readonly sessionTtlMs = SESSION_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new Error('Seller session signing secret must contain at least 32 characters');
    parseCluster(configuredCluster);
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0 || sessionTtlMs > SESSION_TTL_MS) {
      throw new Error('Seller session lifetime must be positive and no longer than five minutes');
    }
  }

  createChallenge(wallet: string, originValue: string, clusterValue: string): { readonly challengeId: string; readonly message: string; readonly expiresAtMs: number } {
    publicKeyObject(wallet);
    const origin = canonicalSellerOrigin(originValue);
    const cluster = parseCluster(clusterValue);
    this.requireConfiguredCluster(cluster);
    const expiresAtMs = this.clock() + CHALLENGE_TTL_MS;
    const challengeId = randomBytes(24).toString('base64url');
    const message = [
      'Katon Solana Seller session v1',
      `wallet:${wallet}`,
      `origin:${origin}`,
      `cluster:${cluster}`,
      `challenge:${challengeId}`,
      `expiresAtMs:${expiresAtMs}`,
      'This one-use proof grants a short-lived read and write session for this Seller wallet.',
    ].join('\n');
    this.pruneChallenges();
    this.challenges.set(challengeId, { wallet, origin, cluster, message, expiresAtMs });
    return { challengeId, message, expiresAtMs };
  }

  createSession(
    wallet: string,
    originValue: string,
    clusterValue: string,
    challengeId: string,
    signatureBase64Url: string,
  ): { readonly token: string; readonly expiresAtMs: number; readonly wallet: string; readonly cluster: SellerCluster } {
    const challenge = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!challenge || this.clock() >= challenge.expiresAtMs) throw new Error('Seller challenge is missing, expired, or already used');

    const origin = canonicalSellerOrigin(originValue);
    const cluster = parseCluster(clusterValue);
    this.requireConfiguredCluster(cluster);
    if (wallet !== challenge.wallet || origin !== challenge.origin || cluster !== challenge.cluster) {
      throw new Error('Seller challenge does not match wallet, origin, or cluster');
    }

    const signature = validateSignature(signatureBase64Url);
    if (!verify(null, Buffer.from(challenge.message), publicKeyObject(wallet), signature)) throw new Error('Seller challenge signature is invalid');

    const expiresAtMs = this.clock() + this.sessionTtlMs;
    const payload: SellerSessionPayload = {
      wallet,
      origin,
      cluster,
      expiresAtMs,
      sessionId: randomBytes(16).toString('base64url'),
      version: 1,
    };
    return { token: this.signPayload(payload), expiresAtMs, wallet, cluster };
  }

  authenticate(token: string, wallet: string, originValue: string, clusterValue: string): SellerSessionClaims {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'seller-v1') throw new Error('Seller session is invalid');
    const [, encoded, mac] = parts;
    const unsigned = `seller-v1.${encoded}`;
    if (!equalMac(mac!, this.mac(unsigned))) throw new Error('Seller session is invalid');

    let payload: SellerSessionPayload;
    try { payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as SellerSessionPayload; }
    catch { throw new Error('Seller session is invalid'); }
    if (payload.version !== 1 || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0
      || !Number.isSafeInteger(payload.expiresAtMs) || this.clock() >= payload.expiresAtMs) {
      throw new Error('Seller session is expired or invalid');
    }

    const origin = canonicalSellerOrigin(originValue);
    const cluster = parseCluster(clusterValue);
    this.requireConfiguredCluster(cluster);
    if (payload.wallet !== wallet || payload.origin !== origin || payload.cluster !== cluster) {
      throw new Error('Seller session does not match wallet, origin, or cluster');
    }
    publicKeyObject(payload.wallet);
    return { wallet: payload.wallet, origin: payload.origin, cluster: payload.cluster, expiresAtMs: payload.expiresAtMs, sessionId: payload.sessionId };
  }

  private requireConfiguredCluster(cluster: SellerCluster): void {
    if (cluster !== this.configuredCluster) throw new Error('Seller cluster does not match this API deployment');
  }

  private pruneChallenges(): void {
    const now = this.clock();
    for (const [id, challenge] of this.challenges) if (challenge.expiresAtMs <= now) this.challenges.delete(id);
    if (this.challenges.size > 10_000) {
      const oldestId = this.challenges.keys().next().value as string | undefined;
      if (oldestId) this.challenges.delete(oldestId);
    }
  }

  private mac(value: string): string { return createHmac('sha256', this.secret).update(value).digest('base64url'); }
  private signPayload(payload: SellerSessionPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const unsigned = `seller-v1.${encoded}`;
    return `${unsigned}.${this.mac(unsigned)}`;
  }
}
