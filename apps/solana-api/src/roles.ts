import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { decodeBase58, parseAtomic } from '@katon/solana-core';

export type DeskRole = 'maker' | 'operator';
export interface ProvisionedRoleIdentity {
  readonly publicKey: string;
  readonly role: DeskRole;
  readonly makerId?: string;
}
export interface RoleSessionClaims extends ProvisionedRoleIdentity {
  readonly expiresAtMs: number;
  readonly sessionId: string;
}
interface Challenge {
  readonly identity: ProvisionedRoleIdentity;
  readonly message: string;
  readonly expiresAtMs: number;
}
interface SessionPayload extends RoleSessionClaims { readonly version: 1 }

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SESSION_TTL_MS = 5 * 60_000;
const CHALLENGE_TTL_MS = 60_000;
const MAX_PENDING_ROLE_CHALLENGES = 10_000;

export function loadProvisionedRoleIdentities(value = process.env.SOLANA_ROLE_IDENTITIES ?? ''): ProvisionedRoleIdentity[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('SOLANA_ROLE_IDENTITIES must be a JSON array');
  return parsed.map((item): ProvisionedRoleIdentity => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('role identity must be an object');
    const record = item as Record<string, unknown>;
    const publicKey = record.publicKey;
    const role = record.role;
    const makerId = record.makerId;
    const keyBytes = typeof publicKey === 'string' ? decodeBase58(publicKey) : undefined;
    if (!keyBytes || keyBytes.length !== 32 || (role !== 'maker' && role !== 'operator')) throw new Error('role identity has an invalid Solana key or role');
    if (role === 'maker' && (typeof makerId !== 'string' || makerId.length === 0)) throw new Error('maker identity requires makerId');
    if (role === 'operator' && makerId !== undefined) throw new Error('operator identity cannot have makerId');
    return { publicKey: publicKey as string, role, ...(typeof makerId === 'string' ? { makerId } : {}) };
  });
}

function keyObject(publicKey: string) {
  const raw = decodeBase58(publicKey);
  if (!raw || raw.length !== 32) throw new Error('identity key is not a Solana ed25519 public key');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
}

export function verifyProvisionedSignature(publicKey: string, message: Uint8Array | string, signatureBase64Url: string): boolean {
  try {
    const signature = Buffer.from(signatureBase64Url, 'base64url');
    return signature.length === 64 && signature.toString('base64url') === signatureBase64Url
      && verify(null, typeof message === 'string' ? Buffer.from(message) : Buffer.from(message), keyObject(publicKey), signature);
  } catch { return false; }
}

function equalMac(left: string, right: string): boolean {
  const a = Buffer.from(left, 'base64url');
  const b = Buffer.from(right, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class RoleSessionService {
  private readonly identities = new Map<string, ProvisionedRoleIdentity>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly revoked = new Set<string>();

  constructor(
    identities: readonly ProvisionedRoleIdentity[],
    private readonly secret: string,
    private readonly sessionTtlMs = SESSION_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new Error('role session signing secret must contain at least 32 characters');
    for (const identity of identities) {
      keyObject(identity.publicKey);
      if (identity.role === 'maker' && !identity.makerId) throw new Error('maker identity requires makerId');
      if (identity.role === 'operator' && identity.makerId !== undefined) throw new Error('operator identity cannot have makerId');
      if (this.identities.has(identity.publicKey)) throw new Error('duplicate provisioned role identity');
      if (identity.makerId && [...this.identities.values()].some((existing) => existing.makerId === identity.makerId)) throw new Error('duplicate provisioned maker ID');
      this.identities.set(identity.publicKey, { ...identity });
    }
  }

  createChallenge(publicKey: string, role: DeskRole): { readonly challengeId: string; readonly message: string; readonly expiresAtMs: number } {
    const identity = this.requireIdentity(publicKey, role);
    this.pruneChallenges();
    const expiresAtMs = this.clock() + CHALLENGE_TTL_MS;
    const challengeId = randomBytes(24).toString('base64url');
    const message = [
      'Katon Solana Desk role session v1',
      `role:${identity.role}`,
      `publicKey:${identity.publicKey}`,
      `makerId:${identity.makerId ?? ''}`,
      `challenge:${challengeId}`,
      `expiresAtMs:${expiresAtMs}`,
    ].join('\n');
    this.challenges.set(challengeId, { identity, message, expiresAtMs });
    return { challengeId, message, expiresAtMs };
  }

  createSession(publicKey: string, role: DeskRole, challengeId: string, signatureBase64Url: string): { readonly token: string; readonly expiresAtMs: number; readonly role: DeskRole; readonly makerId?: string } {
    this.requireIdentity(publicKey, role);
    let signature: Buffer;
    try { signature = Buffer.from(signatureBase64Url, 'base64url'); } catch { throw new Error('challenge signature is invalid'); }
    if (signature.length !== 64 || signature.toString('base64url') !== signatureBase64Url) throw new Error('challenge signature is invalid');
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.identity.publicKey !== publicKey || challenge.identity.role !== role) throw new Error('challenge is missing, expired, or already used');
    this.challenges.delete(challengeId);
    if (this.clock() >= challenge.expiresAtMs) throw new Error('challenge is missing, expired, or already used');
    if (!verify(null, Buffer.from(challenge.message), keyObject(publicKey), signature)) throw new Error('challenge signature is invalid');
    const expiresAtMs = this.clock() + this.sessionTtlMs;
    const payload: SessionPayload = { ...challenge.identity, expiresAtMs, sessionId: randomBytes(16).toString('base64url'), version: 1 };
    return { token: this.signPayload(payload), expiresAtMs, role, ...(payload.makerId ? { makerId: payload.makerId } : {}) };
  }

  authenticate(token: string, requiredRole?: DeskRole): RoleSessionClaims {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('role session is invalid');
    const [, encoded, mac] = parts;
    const expected = this.mac(`v1.${encoded}`);
    if (!equalMac(mac!, expected)) throw new Error('role session is invalid');
    let payload: SessionPayload;
    try { payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as SessionPayload; }
    catch { throw new Error('role session is invalid'); }
    if (payload.version !== 1 || !Number.isSafeInteger(payload.expiresAtMs) || this.clock() >= payload.expiresAtMs) throw new Error('role session is expired');
    const identity = this.requireIdentity(payload.publicKey, payload.role);
    if (payload.sessionId.length === 0 || (identity.makerId ?? '') !== (payload.makerId ?? '')) throw new Error('role session is invalid');
    if (requiredRole && payload.role !== requiredRole) throw new Error('role session has the wrong role');
    return { ...identity, expiresAtMs: payload.expiresAtMs, sessionId: payload.sessionId };
  }

  revokeIdentity(publicKey: string): void {
    this.revoked.add(publicKey);
    this.challenges.forEach((challenge, id) => { if (challenge.identity.publicKey === publicKey) this.challenges.delete(id); });
  }

  private pruneChallenges(): void {
    const now = this.clock();
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAtMs <= now) this.challenges.delete(id);
    }
    while (this.challenges.size >= MAX_PENDING_ROLE_CHALLENGES) {
      const oldestId = this.challenges.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.challenges.delete(oldestId);
    }
  }

  provisionMaker(publicKey: string, makerId: string): ProvisionedRoleIdentity {
    if (!makerId.trim() || makerId.length > 64 || this.identities.has(publicKey)
      || [...this.identities.values()].some((identity) => identity.makerId === makerId)) throw new Error('maker identity is invalid or already provisioned');
    keyObject(publicKey);
    const identity: ProvisionedRoleIdentity = { publicKey, role: 'maker', makerId };
    this.identities.set(publicKey, identity);
    this.revoked.delete(publicKey);
    return identity;
  }

  identity(publicKey: string): ProvisionedRoleIdentity | undefined { return this.identities.get(publicKey); }

  private requireIdentity(publicKey: string, role: DeskRole): ProvisionedRoleIdentity {
    const identity = this.identities.get(publicKey);
    if (!identity || this.revoked.has(publicKey)) throw new Error('identity is not provisioned or has been revoked');
    if (identity.role !== role) throw new Error('identity has the wrong role');
    return identity;
  }

  private mac(value: string): string { return createHmac('sha256', this.secret).update(value).digest('base64url'); }
  private signPayload(payload: SessionPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const unsigned = `v1.${encoded}`;
    return `${unsigned}.${this.mac(unsigned)}`;
  }
}

export interface MakerRuntimeState {
  readonly makerId: string;
  enabled: boolean;
  governanceEnabled: boolean;
  operatorDisabled: boolean;
  selfDisabled: boolean;
  advertisedAvailable: boolean;
  availability: 'available' | 'unavailable';
  capabilities: readonly MakerCapability[];
  lastSeenAtMs?: number;
  quotesReceived: number;
  quotesRejected: number;
}

export interface MakerCapability {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly minInputAtomic: string;
  readonly maxInputAtomic: string;
}

export class DeskOperatorControls {
  private sprintsStopped = false;
  private readonly makers = new Map<string, MakerRuntimeState>();
  constructor(makerIds: readonly string[], private readonly clock: () => number = Date.now) {
    makerIds.forEach((makerId) => this.makers.set(makerId, this.disabledMaker(makerId)));
  }
  provisionMaker(makerId: string): void {
    if (this.makers.has(makerId)) throw new Error('maker is already provisioned');
    this.makers.set(makerId, this.disabledMaker(makerId));
  }
  stopSprints(): void { this.sprintsStopped = true; }
  isSprintStopped(): boolean { return this.sprintsStopped; }
  observeGovernedEnablement(makerId: string, enabled: boolean): void {
    const maker = this.requireMaker(makerId);
    if (maker.governanceEnabled === enabled) return;
    maker.governanceEnabled = enabled;
    maker.enabled = enabled && !maker.operatorDisabled && !maker.selfDisabled;
    // A status observation cannot replay an earlier availability ad. The
    // maker must advertise again after a governance transition.
    maker.advertisedAvailable = false;
    maker.availability = 'unavailable';
  }
  disableMaker(makerId: string): void {
    const maker = this.requireMaker(makerId);
    maker.operatorDisabled = true;
    maker.enabled = false;
    maker.advertisedAvailable = false;
    maker.availability = 'unavailable';
  }
  selfDisable(makerId: string): void {
    const maker = this.requireMaker(makerId);
    maker.selfDisabled = true;
    maker.enabled = false;
    maker.advertisedAvailable = false;
    maker.availability = 'unavailable';
  }
  updateAdvertisement(makerId: string, capabilities: readonly MakerCapability[], availability: 'available' | 'unavailable'): void {
    const maker = this.requireMaker(makerId);
    if (capabilities.length > 32) throw new Error('maker advertises too many capabilities');
    const keys = new Set<string>();
    for (const capability of capabilities) {
      const min = parseAtomic(capability.minInputAtomic, 'maker minimum input');
      const max = parseAtomic(capability.maxInputAtomic, 'maker maximum input');
      if (!capability.inputMint || !capability.outputMint || min === 0n || max < min) throw new Error('maker capability is invalid');
      const key = `${capability.inputMint}:${capability.outputMint}`;
      if (keys.has(key)) throw new Error('maker capability is duplicated');
      keys.add(key);
    }
    maker.capabilities = capabilities.map((capability) => ({ ...capability }));
    maker.advertisedAvailable = availability === 'available';
    maker.availability = maker.governanceEnabled && maker.enabled && !maker.operatorDisabled && !maker.selfDisabled
      && maker.advertisedAvailable && maker.capabilities.length > 0 ? 'available' : 'unavailable';
    maker.lastSeenAtMs = this.clock();
  }
  heartbeat(makerId: string): void {
    this.requireMaker(makerId).lastSeenAtMs = this.clock();
  }
  recordQuote(makerId: string, accepted: boolean): void {
    const maker = this.requireMaker(makerId);
    if (accepted) maker.quotesReceived += 1; else maker.quotesRejected += 1;
    maker.lastSeenAtMs = this.clock();
  }
  makerStatus(makerId: string): Readonly<MakerRuntimeState> {
    const maker = this.requireMaker(makerId);
    return { ...maker, capabilities: maker.capabilities.map((capability) => ({ ...capability })) };
  }
  operatorStatus(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { sprints: this.sprintsStopped ? 'stopped' : 'accepting', makers: [...this.makers.values()].map((maker) => ({ makerId: maker.makerId, enabled: maker.enabled, governanceEnabled: maker.governanceEnabled, operatorDisabled: maker.operatorDisabled, selfDisabled: maker.selfDisabled, availability: maker.availability, lastSeenAtMs: maker.lastSeenAtMs, quotesReceived: maker.quotesReceived, quotesRejected: maker.quotesRejected })), sellerDesk: { mode: 'local_proof', quoteSprintIntake: this.sprintsStopped ? 'stopped' : 'accepting', governanceEnablement: 'read-only per-maker observation', productionReady: false }, liquidationExecution: { mode: 'disabled', enabled: false, evidence: 'not configured', health: 'dormant' }, ...extra };
  }
  private disabledMaker(makerId: string): MakerRuntimeState {
    return { makerId, enabled: false, governanceEnabled: false, operatorDisabled: false, selfDisabled: false, advertisedAvailable: false, availability: 'unavailable', capabilities: [], quotesReceived: 0, quotesRejected: 0 };
  }
  private requireMaker(makerId: string): MakerRuntimeState {
    const maker = this.makers.get(makerId);
    if (!maker) throw new Error('maker is not provisioned');
    return maker;
  }
}
