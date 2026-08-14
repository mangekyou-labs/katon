import type { EncryptedEnvelope } from '../../../packages/flare-core/src/envelope';
import { auctionDeadline, type AuctionDuration } from '../../../packages/flare-core/src/auction';

export type AuctionStatus = 'open' | 'cancelled' | 'finalized' | 'expired';

export interface PublicRelayError {
  readonly code: string;
  readonly message: string;
}

export type RelayEventKind = 'auction.opened' | 'bid.accepted' | 'auction.cancelled' | 'auction.finalized';

export interface RelayEvent {
  readonly sequence: number;
  readonly auctionId: string;
  readonly kind: RelayEventKind;
  readonly status: AuctionStatus;
  readonly bidCount: number;
}

export interface RelayEventBatch {
  readonly cursor: number;
  readonly events: readonly RelayEvent[];
}

export type RelayEventListener = (event: RelayEvent) => void;

export interface BlindRelayLimits {
  readonly maxEnvelopeBytes: number;
  readonly maxEligibleLps: number;
  readonly maxBidsPerAuction: number;
}

export function toPublicRelayError(error: unknown): PublicRelayError {
  const code = error instanceof Error ? error.message : 'RFQ_REQUEST_FAILED';
  const safeCodes = new Set([
    'RFQ_EXISTS', 'RFQ_NOT_FOUND', 'RFQ_NOT_ELIGIBLE', 'ENVELOPE_COMMITMENT',
    'ENVELOPE_EXPIRY', 'AUCTION_CLOSED', 'AUCTION_FINALIZE_AUTH', 'AUCTION_CANCEL_AUTH',
    'AUCTION_DURATION', 'CURSOR_INVALID', 'RFQ_INPUT', 'RFQ_PAYLOAD_TOO_LARGE',
    'RFQ_ELIGIBILITY', 'RFQ_RATE_LIMIT', 'PAGE_LIMIT_INVALID', 'RFQ_KEY_SCOPE', 'RFQ_KEY_EXISTS',
    'RFQ_KEY_ROTATION_REQUIRED', 'RFQ_KEY_UNKNOWN', 'RFQ_KEY_ROTATION_TIME',
    'RFQ_KEY_REVOKED', 'RFQ_KEY_NOT_ACTIVE', 'RFQ_KEY_TIME', 'RFQ_KEY_EXPIRED',
  ]);
  return safeCodes.has(code) ? { code, message: code } : { code: 'RFQ_REQUEST_FAILED', message: 'RFQ_REQUEST_FAILED' };
}

export interface RelayKeyRecord {
  readonly lpId: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly activatedAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
}

export interface RelayKeyRegistrySnapshot {
  readonly keys: readonly RelayKeyRecord[];
  readonly activeByLp: Readonly<Record<string, string>>;
}

interface StoredRelayKey extends RelayKeyRecord {
  revokedAt?: number;
}

/**
 * Keeps LP encryption keys scoped to their owner and makes key transitions
 * explicit. The relay can use this boundary before delivering an envelope;
 * it never needs to persist or inspect the corresponding private key.
 */
export class RelayKeyRegistry {
  private readonly keys = new Map<string, StoredRelayKey>();
  private readonly activeByLp = new Map<string, string>();

  snapshot(): RelayKeyRegistrySnapshot {
    return {
      keys: [...this.keys.values()].map((key) => ({ ...key })),
      activeByLp: Object.fromEntries(this.activeByLp),
    };
  }

  restore(snapshot: RelayKeyRegistrySnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.keys) || snapshot.activeByLp === null
      || typeof snapshot.activeByLp !== 'object' || Array.isArray(snapshot.activeByLp)) {
      throw new Error('RFQ_KEY_STORE_INVALID');
    }
    const keys = new Map<string, StoredRelayKey>();
    for (const key of snapshot.keys) {
      if (!key || keys.has(key.keyId)) throw new Error('RFQ_KEY_STORE_INVALID');
      this.assertInput(key);
      if (key.revokedAt !== undefined && (!Number.isInteger(key.revokedAt) || key.revokedAt < key.activatedAt)) {
        throw new Error('RFQ_KEY_STORE_INVALID');
      }
      keys.set(key.keyId, { ...key });
    }
    const activeByLp = new Map<string, string>();
    for (const [lpId, keyId] of Object.entries(snapshot.activeByLp)) {
      const key = keys.get(keyId);
      if (!lpId || !key || key.lpId !== lpId || key.revokedAt !== undefined) throw new Error('RFQ_KEY_STORE_INVALID');
      activeByLp.set(lpId, keyId);
    }
    this.keys.clear();
    for (const [keyId, key] of keys) this.keys.set(keyId, key);
    this.activeByLp.clear();
    for (const [lpId, keyId] of activeByLp) this.activeByLp.set(lpId, keyId);
  }

  register(input: Omit<RelayKeyRecord, 'revokedAt'>): void {
    this.assertInput(input);
    if (this.keys.has(input.keyId)) throw new Error('RFQ_KEY_EXISTS');
    if (this.activeByLp.has(input.lpId)) throw new Error('RFQ_KEY_ROTATION_REQUIRED');
    this.keys.set(input.keyId, { ...input });
    this.activeByLp.set(input.lpId, input.keyId);
  }

  rotate(input: Omit<RelayKeyRecord, 'revokedAt'>): void {
    this.assertInput(input);
    if (this.keys.has(input.keyId)) throw new Error('RFQ_KEY_EXISTS');
    const currentKeyId = this.activeByLp.get(input.lpId);
    if (!currentKeyId) throw new Error('RFQ_KEY_UNKNOWN');
    const current = this.keys.get(currentKeyId);
    if (!current) throw new Error('RFQ_KEY_UNKNOWN');
    if (input.activatedAt <= current.activatedAt) throw new Error('RFQ_KEY_ROTATION_TIME');
    current.revokedAt = input.activatedAt;
    this.keys.set(input.keyId, { ...input });
    this.activeByLp.set(input.lpId, input.keyId);
  }

  revoke(lpId: string, keyId: string, revokedAt: number): void {
    if (!lpId || !keyId) throw new Error('RFQ_INPUT');
    if (!Number.isInteger(revokedAt) || revokedAt < 0) throw new Error('RFQ_KEY_TIME');
    const key = this.keys.get(keyId);
    if (!key) throw new Error('RFQ_KEY_UNKNOWN');
    if (key.lpId !== lpId) throw new Error('RFQ_KEY_SCOPE');
    if (key.revokedAt !== undefined) throw new Error('RFQ_KEY_REVOKED');
    if (this.activeByLp.get(lpId) !== keyId) throw new Error('RFQ_KEY_NOT_ACTIVE');
    if (revokedAt < key.activatedAt) throw new Error('RFQ_KEY_TIME');
    key.revokedAt = revokedAt;
    this.activeByLp.delete(lpId);
  }

  resolve(lpId: string, keyId: string, now: number): string {
    const key = this.keys.get(keyId);
    if (!key) throw new Error('RFQ_KEY_UNKNOWN');
    if (key.lpId !== lpId) throw new Error('RFQ_KEY_SCOPE');
    if (!Number.isInteger(now) || now < 0) throw new Error('RFQ_KEY_TIME');
    if (now < key.activatedAt) throw new Error('RFQ_KEY_NOT_ACTIVE');
    if (key.revokedAt !== undefined && now >= key.revokedAt) throw new Error('RFQ_KEY_REVOKED');
    if (now >= key.expiresAt) throw new Error('RFQ_KEY_EXPIRED');
    return key.publicKey;
  }

  private assertInput(input: Omit<RelayKeyRecord, 'revokedAt'>): void {
    if (!input.lpId || !input.keyId || !input.publicKey) throw new Error('RFQ_INPUT');
    if (!Number.isInteger(input.activatedAt) || input.activatedAt < 0) throw new Error('RFQ_KEY_TIME');
    if (!Number.isInteger(input.expiresAt) || input.expiresAt <= input.activatedAt) {
      throw new Error('RFQ_KEY_TIME');
    }
  }
}

interface AuctionRecord {
  readonly id: string;
  readonly seller: string;
  readonly envelope: EncryptedEnvelope;
  readonly eligibleLps: ReadonlySet<string>;
  readonly idempotencyKeys: Set<string>;
  readonly duration: AuctionDuration;
  readonly openedAt: number;
  readonly expiresAt: number;
  status: AuctionStatus;
  bidCount: number;
  earlyCloseAllowed: boolean;
  readonly bids: StoredBid[];
  matchResult?: RelayMatchResult;
}

interface RelayEventRecord extends RelayEvent {
  readonly audience: ReadonlySet<string>;
}

export interface StoredBid {
  readonly lpId: string;
  readonly idempotencyKey: string;
  readonly envelope: EncryptedEnvelope;
}

export interface RelayMatchResult {
  readonly resultHash: string;
  readonly winnerLpId?: string;
}

export type MatchOnFinalize = (input: {
  readonly auctionId: string;
  readonly seller: string;
  readonly auctionEnvelope: EncryptedEnvelope;
  readonly bids: readonly StoredBid[];
  readonly now: number;
}) => { readonly resultHash: string; readonly winner?: { readonly bidder: string } };

export interface AuctionReadModel {
  readonly id: string;
  readonly commitment: string;
  readonly duration: AuctionDuration;
  readonly status: AuctionStatus;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly bidCount: number;
  readonly earlyCloseAllowed: boolean;
  readonly envelope: EncryptedEnvelope;
  readonly matchResult?: RelayMatchResult;
}

export interface AuctionListRow {
  readonly id: string;
  readonly commitment: string;
  readonly duration: AuctionDuration;
  readonly status: AuctionStatus;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly bidCount: number;
  readonly earlyCloseAllowed: boolean;
}

export interface AuctionListPage {
  readonly auctions: readonly AuctionListRow[];
  readonly nextCursor?: string;
}

export interface BlindRelaySnapshot {
  readonly auctions: readonly {
    readonly id: string;
    readonly seller: string;
    readonly envelope: EncryptedEnvelope;
    readonly eligibleLps: readonly string[];
    readonly idempotencyKeys: readonly string[];
    readonly duration: AuctionDuration;
    readonly openedAt: number;
    readonly expiresAt: number;
    readonly status: AuctionStatus;
    readonly bidCount: number;
    readonly earlyCloseAllowed: boolean;
    readonly bids?: readonly StoredBid[];
    readonly matchResult?: RelayMatchResult;
  }[];
  readonly events: readonly {
    readonly sequence: number;
    readonly auctionId: string;
    readonly kind: RelayEventKind;
    readonly status: AuctionStatus;
    readonly bidCount: number;
    readonly audience: readonly string[];
  }[];
  readonly nextSequence: number;
}

export class BlindRelay {
  private readonly auctions = new Map<string, AuctionRecord>();
  private readonly eventLog: RelayEventRecord[] = [];
  private readonly limits: BlindRelayLimits;
  private readonly matchOnFinalize?: MatchOnFinalize;
  private readonly subscribers = new Map<number, { readonly actor: string; readonly listener: RelayEventListener }>();
  private nextSequence = 1;
  private nextSubscriber = 1;

  constructor(options: Partial<BlindRelayLimits> & { readonly matchOnFinalize?: MatchOnFinalize } = {}) {
    const { matchOnFinalize, ...limits } = options;
    this.matchOnFinalize = matchOnFinalize;
    this.limits = {
      maxEnvelopeBytes: limits.maxEnvelopeBytes ?? 256 * 1024,
      maxEligibleLps: limits.maxEligibleLps ?? 256,
      maxBidsPerAuction: limits.maxBidsPerAuction ?? 1_000,
    };
    if (Object.values(this.limits).some((value) => !Number.isInteger(value) || value <= 0)) {
      throw new Error('RFQ_LIMITS');
    }
  }

  /** Serialize opaque envelopes and routing metadata for durable restart recovery. */
  snapshot(): BlindRelaySnapshot {
    return {
      auctions: [...this.auctions.values()].map((auction) => ({
        id: auction.id,
        seller: auction.seller,
        envelope: auction.envelope,
        eligibleLps: [...auction.eligibleLps],
        idempotencyKeys: [...auction.idempotencyKeys],
        duration: auction.duration,
        openedAt: auction.openedAt,
        expiresAt: auction.expiresAt,
        status: auction.status,
        bidCount: auction.bidCount,
        earlyCloseAllowed: auction.earlyCloseAllowed,
        bids: auction.bids.map((bid) => ({ ...bid })),
        ...(auction.matchResult ? { matchResult: auction.matchResult } : {}),
      })),
      events: this.eventLog.map((event) => ({
        sequence: event.sequence,
        auctionId: event.auctionId,
        kind: event.kind,
        status: event.status,
        bidCount: event.bidCount,
        audience: [...event.audience],
      })),
      nextSequence: this.nextSequence,
    };
  }

  restore(snapshot: BlindRelaySnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.auctions) || !Array.isArray(snapshot.events)
      || !Number.isInteger(snapshot.nextSequence) || snapshot.nextSequence < 1) {
      throw new Error('RFQ_STORE_INVALID');
    }
    const auctions = new Map<string, AuctionRecord>();
    for (const input of snapshot.auctions) {
      if (!input || !input.id || !input.seller || auctions.has(input.id)
        || !Array.isArray(input.eligibleLps) || !Array.isArray(input.idempotencyKeys)
        || !Number.isInteger(input.openedAt) || input.openedAt < 0
        || !Number.isInteger(input.expiresAt) || input.expiresAt < input.openedAt
        || !Number.isInteger(input.bidCount) || input.bidCount < 0
        || (input.earlyCloseAllowed !== undefined && typeof input.earlyCloseAllowed !== 'boolean')
        || !['24h', '1w', '1m', '3m'].includes(input.duration)
        || !['open', 'cancelled', 'finalized', 'expired'].includes(input.status)) {
        throw new Error('RFQ_STORE_INVALID');
      }
      this.assertEnvelope(input.envelope);
      if (input.eligibleLps.length === 0 || input.eligibleLps.length > this.limits.maxEligibleLps
        || new Set(input.eligibleLps).size !== input.eligibleLps.length
        || input.eligibleLps.some((lp: string) => typeof lp !== 'string' || !lp)
        || new Set(input.idempotencyKeys).size !== input.idempotencyKeys.length
        || input.idempotencyKeys.some((key: string) => typeof key !== 'string' || !key)
        || input.idempotencyKeys.length !== input.bidCount
        || input.bidCount > this.limits.maxBidsPerAuction
        || (input.bids !== undefined && (!Array.isArray(input.bids) || input.bids.length !== input.bidCount
          || input.bids.some((bid: StoredBid) => !bid || bid.lpId === undefined || !bid.idempotencyKey || !bid.envelope)))) {
        throw new Error('RFQ_STORE_INVALID');
      }
      if (input.bids) {
        for (const bid of input.bids) this.assertEnvelope(bid.envelope);
      }
      auctions.set(input.id, {
        id: input.id,
        seller: input.seller,
        envelope: input.envelope,
        eligibleLps: new Set(input.eligibleLps),
        idempotencyKeys: new Set(input.idempotencyKeys),
        duration: input.duration,
        openedAt: input.openedAt,
        expiresAt: input.expiresAt,
        status: input.status,
        bidCount: input.bidCount,
        earlyCloseAllowed: input.earlyCloseAllowed ?? false,
        bids: input.bids ? input.bids.map((bid: StoredBid) => ({ ...bid })) : [],
        matchResult: input.matchResult,
      });
    }
    const events: RelayEventRecord[] = [];
    let previousSequence = 0;
    for (const input of snapshot.events) {
      if (!input || !Number.isInteger(input.sequence) || input.sequence <= previousSequence
        || !auctions.has(input.auctionId) || !['auction.opened', 'bid.accepted', 'auction.cancelled', 'auction.finalized'].includes(input.kind)
        || !['open', 'cancelled', 'finalized', 'expired'].includes(input.status)
        || !Number.isInteger(input.bidCount) || input.bidCount < 0
        || !Array.isArray(input.audience) || input.audience.length === 0
        || new Set(input.audience).size !== input.audience.length
        || input.audience.some((actor: string) => typeof actor !== 'string' || !actor)) {
        throw new Error('RFQ_STORE_INVALID');
      }
      events.push({ ...input, audience: new Set(input.audience) });
      previousSequence = input.sequence;
    }
    if (snapshot.nextSequence <= previousSequence) throw new Error('RFQ_STORE_INVALID');
    this.auctions.clear();
    for (const [id, auction] of auctions) this.auctions.set(id, auction);
    this.eventLog.splice(0, this.eventLog.length, ...events);
    this.nextSequence = snapshot.nextSequence;
  }

  subscribe(actor: string, afterSequence: number, listener: RelayEventListener): () => void {
    if (!actor || !Number.isInteger(afterSequence) || afterSequence < 0 || typeof listener !== 'function') {
      throw new Error('RFQ_SUBSCRIPTION_INVALID');
    }
    const replay = this.readEvents(actor, afterSequence).events;
    const subscriptionId = this.nextSubscriber++;
    this.subscribers.set(subscriptionId, { actor, listener });
    for (const event of replay) listener(event);
    return () => { this.subscribers.delete(subscriptionId); };
  }

  openAuction(input: {
    id: string;
    seller: string;
    envelope: EncryptedEnvelope;
    eligibleLps: readonly string[];
    duration: AuctionDuration;
    openedAt: number;
    earlyCloseAllowed?: boolean;
  }): void {
    if (!input.id || !input.seller) throw new Error('RFQ_INPUT');
    this.assertEnvelope(input.envelope);
    if (input.eligibleLps.length === 0 || input.eligibleLps.length > this.limits.maxEligibleLps) {
      throw new Error('RFQ_ELIGIBILITY');
    }
    if (new Set(input.eligibleLps).size !== input.eligibleLps.length || input.eligibleLps.some((lp) => !lp)) {
      throw new Error('RFQ_ELIGIBILITY');
    }
    if (this.auctions.has(input.id)) throw new Error('RFQ_EXISTS');
    const expiresAt = auctionDeadline(input.duration, input.openedAt);
    if (input.envelope.expiresAt < expiresAt) throw new Error('ENVELOPE_EXPIRY');
    this.auctions.set(input.id, {
      id: input.id,
      seller: input.seller,
      envelope: input.envelope,
      eligibleLps: new Set(input.eligibleLps),
      idempotencyKeys: new Set(),
      duration: input.duration,
      openedAt: input.openedAt,
      expiresAt,
      status: 'open',
      bidCount: 0,
      earlyCloseAllowed: input.earlyCloseAllowed ?? false,
      bids: [],
    });
    this.appendEvent(input.id, 'auction.opened', 'open', 0, input.seller, input.eligibleLps);
  }

  submitBid(input: {
    auctionId: string;
    lpId: string;
    idempotencyKey: string;
    envelope: EncryptedEnvelope;
    now?: number;
  }): { accepted: true } {
    const auction = this.auctions.get(input.auctionId);
    if (!auction) throw new Error('RFQ_NOT_FOUND');
    if (!input.idempotencyKey) throw new Error('RFQ_INPUT');
    this.assertEnvelope(input.envelope);
    const now = input.now ?? auction.openedAt;
    if (auction.status !== 'open' || now >= auction.expiresAt || input.envelope.expiresAt < now) throw new Error('AUCTION_CLOSED');
    if (!auction.eligibleLps.has(input.lpId)) throw new Error('RFQ_NOT_ELIGIBLE');
    if (input.envelope.commitment !== auction.envelope.commitment) throw new Error('ENVELOPE_COMMITMENT');
    if (auction.idempotencyKeys.has(input.idempotencyKey)) return { accepted: true };
    if (auction.bidCount >= this.limits.maxBidsPerAuction) throw new Error('RFQ_RATE_LIMIT');
    auction.idempotencyKeys.add(input.idempotencyKey);
    auction.bids.push({ lpId: input.lpId, idempotencyKey: input.idempotencyKey, envelope: input.envelope });
    auction.bidCount += 1;
    this.appendEvent(input.auctionId, 'bid.accepted', 'open', auction.bidCount, auction.seller, auction.eligibleLps);
    return { accepted: true };
  }

  readAuction(id: string, actor: string, now = Math.floor(Date.now() / 1000)): AuctionReadModel {
    const auction = this.auctions.get(id);
    if (!auction) throw new Error('RFQ_NOT_FOUND');
    if (actor !== auction.seller && !auction.eligibleLps.has(actor)) throw new Error('RFQ_NOT_ELIGIBLE');
    const status = auction.status === 'open' && now >= auction.expiresAt ? 'expired' : auction.status;
    return {
      id: auction.id,
      commitment: auction.envelope.commitment,
      duration: auction.duration,
      status,
      openedAt: auction.openedAt,
      expiresAt: auction.expiresAt,
      bidCount: auction.bidCount,
      earlyCloseAllowed: auction.earlyCloseAllowed,
      envelope: auction.envelope,
      ...(auction.matchResult ? { matchResult: auction.matchResult } : {}),
    };
  }

  readBids(id: string, actor: string): readonly StoredBid[] {
    const auction = this.auctions.get(id);
    if (!auction) throw new Error('RFQ_NOT_FOUND');
    if (actor !== auction.seller && !auction.eligibleLps.has(actor)) throw new Error('RFQ_NOT_ELIGIBLE');
    return auction.bids.map((bid) => ({ ...bid }));
  }

  listAuctions(actor: string, now = Math.floor(Date.now() / 1000)): readonly AuctionListRow[] {
    const auctions: AuctionListRow[] = [];
    let cursor: string | undefined;
    do {
      const page = this.listAuctionPage(actor, cursor, 100, now);
      auctions.push(...page.auctions);
      cursor = page.nextCursor;
    } while (cursor);
    return auctions;
  }

  listAuctionPage(actor: string, afterId?: string, limit = 50, now = Math.floor(Date.now() / 1000)): AuctionListPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('PAGE_LIMIT_INVALID');
    const rows = [...this.auctions.values()]
      .filter((auction) => auction.seller === actor || auction.eligibleLps.has(actor))
      .map((auction) => ({
        id: auction.id,
        commitment: auction.envelope.commitment,
        duration: auction.duration,
        status: auction.status === 'open' && now >= auction.expiresAt ? 'expired' : auction.status,
        openedAt: auction.openedAt,
        expiresAt: auction.expiresAt,
        bidCount: auction.bidCount,
        earlyCloseAllowed: auction.earlyCloseAllowed,
      }));
    const start = afterId === undefined ? 0 : rows.findIndex((auction) => auction.id === afterId) + 1;
    if (afterId !== undefined && start === 0) throw new Error('CURSOR_INVALID');
    const auctions = rows.slice(start, start + limit);
    return {
      auctions,
      ...(start + auctions.length < rows.length ? { nextCursor: auctions[auctions.length - 1]?.id } : {}),
    };
  }

  cancelAuction(id: string, actor: string, now = Math.floor(Date.now() / 1000)): AuctionReadModel {
    const auction = this.auctions.get(id);
    if (!auction) throw new Error('RFQ_NOT_FOUND');
    if (actor !== auction.seller) throw new Error('AUCTION_CANCEL_AUTH');
    if (auction.status !== 'open' || now >= auction.expiresAt) throw new Error('AUCTION_CLOSED');
    auction.status = 'cancelled';
    this.appendEvent(id, 'auction.cancelled', auction.status, auction.bidCount, auction.seller, auction.eligibleLps);
    return this.readAuction(id, actor, now);
  }

  finalizeAuction(id: string, actor: string, now = Math.floor(Date.now() / 1000)): AuctionReadModel {
    const auction = this.auctions.get(id);
    if (!auction) throw new Error('RFQ_NOT_FOUND');
    if (auction.status !== 'open') throw new Error('AUCTION_CLOSED');
    if (actor !== auction.seller && now < auction.expiresAt) throw new Error('AUCTION_FINALIZE_AUTH');
    if (actor === auction.seller && now < auction.expiresAt && !auction.earlyCloseAllowed) throw new Error('AUCTION_EARLY_CLOSE_DISABLED');
    if (this.matchOnFinalize) {
      const matched = this.matchOnFinalize({
        auctionId: auction.id,
        seller: auction.seller,
        auctionEnvelope: auction.envelope,
        bids: auction.bids,
        now,
      });
      auction.matchResult = {
        resultHash: matched.resultHash,
        ...(matched.winner?.bidder ? { winnerLpId: matched.winner.bidder } : {}),
      };
    }
    auction.status = now >= auction.expiresAt ? 'expired' : 'finalized';
    this.appendEvent(id, 'auction.finalized', auction.status, auction.bidCount, auction.seller, auction.eligibleLps);
    return this.readAuction(id, auction.seller, now);
  }

  readEvents(actor: string, afterSequence = 0): RelayEventBatch {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error('CURSOR_INVALID');
    const events = this.eventLog
      .filter((event) => event.sequence > afterSequence && event.audience.has(actor))
      .map(({ audience: _audience, ...event }) => event);
    const cursor = events.length > 0 ? events[events.length - 1].sequence : afterSequence;
    return { cursor, events };
  }

  private appendEvent(
    auctionId: string,
    kind: RelayEventKind,
    status: AuctionStatus,
    bidCount: number,
    seller: string,
    eligibleLps: ReadonlySet<string> | readonly string[],
  ): void {
    const event = {
      sequence: this.nextSequence++,
      auctionId,
      kind,
      status,
      bidCount,
      audience: new Set([seller, ...eligibleLps]),
    } satisfies RelayEventRecord;
    this.eventLog.push(event);
    const publicEvent = (({ audience: _audience, ...value }) => value)(event);
    for (const { actor, listener } of this.subscribers.values()) {
      if (event.audience.has(actor)) listener(publicEvent);
    }
  }

  private assertEnvelope(envelope: EncryptedEnvelope): void {
    if (envelope.version !== 1 || !envelope.keyId || !envelope.commitment || !envelope.nonce || !envelope.ciphertext) {
      throw new Error('RFQ_INPUT');
    }
    if (JSON.stringify(envelope).length > this.limits.maxEnvelopeBytes) {
      throw new Error('RFQ_PAYLOAD_TOO_LARGE');
    }
  }
}
