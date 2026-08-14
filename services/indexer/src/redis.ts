import { createClient, type RedisClientType } from 'redis';

import type { FlareEvent, IndexCursor } from './projector';
import { assertCanonicalPublicEvent } from '../../../packages/flare-core/src/events';

export interface IndexerSnapshot {
  readonly events: readonly FlareEvent[];
  readonly finalizedBlock: number;
  readonly cursor?: IndexCursor;
}

export interface RedisCheckpointClient {
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface IndexerSnapshotStore {
  load(): Promise<IndexerSnapshot | undefined>;
  save(snapshot: IndexerSnapshot): Promise<void>;
  close(): Promise<unknown>;
}

export class RedisIndexerCheckpoint implements IndexerSnapshotStore {
  private connected = false;

  constructor(
    private readonly client: RedisCheckpointClient,
    private readonly key = 'trustrfq:indexer:checkpoint',
  ) {
    if (!key.trim()) throw new Error('INDEXER_REDIS_KEY');
  }

  static fromUrl(url: string, key?: string): RedisIndexerCheckpoint {
    if (!url.trim()) throw new Error('INDEXER_REDIS_URL');
    const client = createClient({ url }) as unknown as RedisClientType;
    return new RedisIndexerCheckpoint(client, key);
  }

  async load(): Promise<IndexerSnapshot | undefined> {
    await this.ensureConnected();
    const raw = await this.client.get(this.key);
    if (raw === null) return undefined;
    return parseSnapshot(raw);
  }

  async save(snapshot: IndexerSnapshot): Promise<void> {
    await this.ensureConnected();
    await this.client.set(this.key, JSON.stringify(snapshot));
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.quit();
    this.connected = false;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }
}

export class DualIndexerCheckpoint implements IndexerSnapshotStore {
  constructor(
    private readonly primary: IndexerSnapshotStore,
    private readonly durable: IndexerSnapshotStore,
  ) {}

  async load(): Promise<IndexerSnapshot | undefined> {
    const [primary, durable] = await Promise.all([this.primary.load(), this.durable.load()]);
    if (!primary) return durable;
    if (!durable) return primary;
    return snapshotPosition(durable) > snapshotPosition(primary) ? durable : primary;
  }

  async save(snapshot: IndexerSnapshot): Promise<void> {
    await Promise.all([this.primary.save(snapshot), this.durable.save(snapshot)]);
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.durable.close()]);
  }
}

function snapshotPosition(snapshot: IndexerSnapshot): number {
  const cursor = snapshot.cursor ?? { blockNumber: 0, logIndex: -1 };
  return cursor.blockNumber * 1_000_000 + cursor.logIndex + snapshot.finalizedBlock / 1_000_000;
}

export class RedisPersistentEventProjector {
  private readonly eventsByKey = new Map<string, FlareEvent>();
  private finalized = 0;

  private cursorValue: IndexCursor;

  constructor(
    private readonly checkpoint: IndexerSnapshotStore,
    private readonly initialCursor: IndexCursor = { blockNumber: 0, logIndex: -1 },
  ) {
    this.cursorValue = { ...initialCursor };
  }

  async hydrate(): Promise<void> {
    const snapshot = await this.checkpoint.load();
    if (!snapshot) return;
    this.rebuildInMemory(snapshot.events, snapshot.finalizedBlock, snapshot.cursor);
  }

  async apply(events: readonly FlareEvent[]): Promise<void> {
    for (const event of events) {
      assertPublicEvent(event);
      const key = `${event.txHash}:${event.logIndex}`;
      const previous = this.eventsByKey.get(key);
      if (previous) {
        if (stableJson(previous) !== stableJson(event)) throw new Error('EVENT_CONFLICT');
        continue;
      }
      this.eventsByKey.set(key, event);
      if (event.blockNumber > this.cursorValue.blockNumber || (event.blockNumber === this.cursorValue.blockNumber && event.logIndex > this.cursorValue.logIndex)) {
        this.cursorValue = { blockNumber: event.blockNumber, logIndex: event.logIndex, ...(typeof event.blockHash === 'string' ? { blockHash: event.blockHash } : {}) };
      }
    }
    await this.persist();
  }

  async markFinalized(blockNumber: number): Promise<void> {
    if (!Number.isInteger(blockNumber) || blockNumber < this.finalized) throw new Error('FINALITY_REGRESSION');
    this.finalized = blockNumber;
    await this.persist();
  }

  async rollbackFrom(blockNumber: number): Promise<void> {
    if (!Number.isInteger(blockNumber) || blockNumber < 0) throw new Error('REORG_BLOCK_INVALID');
    if (blockNumber <= this.finalized) throw new Error('REORG_FINALIZED');
    for (const [key, event] of this.eventsByKey) {
      if (event.blockNumber >= blockNumber) this.eventsByKey.delete(key);
    }
    this.cursorValue = { blockNumber: 0, logIndex: -1 };
    for (const event of this.eventsByKey.values()) {
      if (event.blockNumber > this.cursorValue.blockNumber || (event.blockNumber === this.cursorValue.blockNumber && event.logIndex > this.cursorValue.logIndex)) {
        this.cursorValue = { blockNumber: event.blockNumber, logIndex: event.logIndex, ...(typeof event.blockHash === 'string' ? { blockHash: event.blockHash } : {}) };
      }
    }
    await this.persist();
  }

  events(options: { readonly finalizedOnly?: boolean } = {}): FlareEvent[] {
    return [...this.eventsByKey.values()]
      .filter((event) => !options.finalizedOnly || event.blockNumber <= this.finalized)
      .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  }

  cursor(): IndexCursor { return this.cursorValue; }
  finalizedBlock(): number { return this.finalized; }

  async close(): Promise<void> { await this.checkpoint.close(); }

  private rebuildInMemory(events: readonly FlareEvent[], finalizedBlock: number, snapshotCursor?: IndexCursor): void {
    this.eventsByKey.clear();
    this.cursorValue = snapshotCursor ? validateCursor(snapshotCursor) : { ...this.initialCursor };
    this.finalized = 0;
    for (const event of events) {
      assertPublicEvent(event);
      const key = `${event.txHash}:${event.logIndex}`;
      if (this.eventsByKey.has(key)) throw new Error('EVENT_CONFLICT');
      this.eventsByKey.set(key, event);
      if (event.blockNumber > this.cursorValue.blockNumber || (event.blockNumber === this.cursorValue.blockNumber && event.logIndex > this.cursorValue.logIndex)) {
        this.cursorValue = { blockNumber: event.blockNumber, logIndex: event.logIndex, ...(typeof event.blockHash === 'string' ? { blockHash: event.blockHash } : {}) };
      }
    }
    if (!Number.isInteger(finalizedBlock) || finalizedBlock < 0) throw new Error('INDEXER_STORE_INVALID');
    this.finalized = finalizedBlock;
  }

  private async persist(): Promise<void> {
    await this.checkpoint.save({ events: this.events(), finalizedBlock: this.finalized, cursor: this.cursorValue });
  }
}

function parseSnapshot(raw: string): IndexerSnapshot {
  try {
    const parsed = JSON.parse(raw) as Partial<IndexerSnapshot>;
    if (!Array.isArray(parsed.events) || typeof parsed.finalizedBlock !== 'number' || !Number.isInteger(parsed.finalizedBlock) || parsed.finalizedBlock < 0) throw new Error('INDEXER_STORE_INVALID');
    for (const event of parsed.events) assertPublicEvent(event as FlareEvent);
    return { events: parsed.events as FlareEvent[], finalizedBlock: parsed.finalizedBlock, cursor: parsed.cursor ? validateCursor(parsed.cursor) : undefined };
  } catch (error) {
    if (error instanceof Error && error.message === 'EVENT_PRIVATE_FIELD') throw error;
    throw new Error('INDEXER_STORE_INVALID');
  }
}

function validateCursor(cursor: IndexCursor): IndexCursor {
  if (!Number.isInteger(cursor.blockNumber) || cursor.blockNumber < 0 || !Number.isInteger(cursor.logIndex) || cursor.logIndex < -1) throw new Error('INDEXER_STORE_INVALID');
  if (cursor.blockHash !== undefined && (typeof cursor.blockHash !== 'string' || !cursor.blockHash.trim())) throw new Error('INDEXER_STORE_INVALID');
  return { blockNumber: cursor.blockNumber, logIndex: cursor.logIndex, ...(cursor.blockHash ? { blockHash: cursor.blockHash } : {}) };
}

const PRIVATE_EVENT_FIELDS = new Set(['ciphertext', 'plaintext', 'signature', 'proofBytes', 'privateKey', 'bidPayload']);

function assertPublicEvent(event: FlareEvent): void {
  assertCanonicalPublicEvent(event as unknown as Record<string, unknown>);
  if (!event || !event.kind || !event.txHash || !event.commitment) throw new Error('EVENT_INVALID');
  for (const field of Object.keys(event)) if (PRIVATE_EVENT_FIELDS.has(field)) throw new Error('EVENT_PRIVATE_FIELD');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
