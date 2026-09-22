import { MongoClient, type Collection, type Db } from 'mongodb';
import type { BaseChainEvent, BaseCursor, BaseCursorStore, BaseEventProjector, BaseFacilityProjection, BaseProjectionReadModelPort, BaseProjectionSnapshot, BaseTokenProjection } from './types';
import { eventKey } from './projector';
import type { BaseProjectionStore } from './worker';

interface MongoCursorRecord {
  readonly _id: string;
  readonly chainId: number;
  readonly address: string;
  readonly blockNumber: string;
  readonly logIndex: number;
  readonly blockHash?: string;
}

interface MongoEventRecord {
  readonly _id: string;
  readonly chainId: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash?: string;
  readonly address: string;
  readonly eventName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export class MongoBaseCursorStore implements BaseCursorStore {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private collection?: Collection<MongoCursorRecord>;

  constructor(uri: string, dbName: string) {
    this.client = new MongoClient(uri);
    this.dbName = dbName;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    const collection = this.client.db(this.dbName).collection<MongoCursorRecord>('base_indexer_cursors');
    await collection.createIndex({ chainId: 1, address: 1 }, { unique: true });
    this.collection = collection;
  }

  async get(chainId: number, address: string): Promise<BaseCursor | undefined> {
    const cursor = this.collection ?? this.requireCollection();
    const value = await cursor.findOne({ _id: `${chainId}:${address.toLowerCase()}` });
    if (!value) return undefined;
    return {
      chainId: value.chainId,
      address: value.address,
      blockNumber: toBigInt(value.blockNumber),
      logIndex: value.logIndex,
      ...(value.blockHash ? { blockHash: value.blockHash } : {}),
    };
  }

  async set(value: BaseCursor): Promise<void> {
    const collection = this.collection ?? this.requireCollection();
    await collection.replaceOne(
      { _id: `${value.chainId}:${value.address.toLowerCase()}` },
      {
        chainId: value.chainId,
        address: value.address.toLowerCase(),
        blockNumber: value.blockNumber.toString(10),
        logIndex: value.logIndex,
        ...(value.blockHash ? { blockHash: value.blockHash } : {}),
      },
      { upsert: true },
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private requireCollection(): Collection<MongoCursorRecord> {
    if (!this.collection) throw new Error('MONGO_NOT_CONNECTED');
    return this.collection;
  }
}

export class MongoBaseProjectionStore implements BaseProjectionStore, BaseProjectionReadModelPort {
  private readonly db: Db;
  private events?: Collection<MongoEventRecord>;
  private readModels?: Collection<Record<string, unknown>>;

  constructor(db: Db) {
    this.db = db;
  }

  async connect(): Promise<void> {
    this.events = this.db.collection<MongoEventRecord>('base_indexer_events');
    this.readModels = this.db.collection<Record<string, unknown>>('base_indexer_read_models');
    await this.events.createIndex({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true });
    await this.readModels.createIndex({ entityType: 1, entityId: 1 }, { unique: true });
  }

  async hydrate(projector: BaseEventProjector): Promise<void> {
    const eventCollection = this.events;
    if (!eventCollection) throw new Error('MONGO_NOT_CONNECTED');
    const records = await eventCollection.find({}).toArray();
    records.sort((left, right) => {
      const leftBlock = toBigInt(left.blockNumber);
      const rightBlock = toBigInt(right.blockNumber);
      return leftBlock < rightBlock ? -1 : leftBlock > rightBlock ? 1 : left.logIndex - right.logIndex;
    });
    if (records.length > 0) await projector.apply(records.map(toBaseEvent));
  }

  async persist(events: readonly BaseChainEvent[], projector: BaseEventProjector): Promise<void> {
    const eventCollection = this.events;
    const readModels = this.readModels;
    if (!eventCollection || !readModels) throw new Error('MONGO_NOT_CONNECTED');
    for (const event of events) {
      await eventCollection.updateOne({ _id: eventKey(event) }, { $setOnInsert: toMongoEvent(event) }, { upsert: true });
    }
    if (!projector.snapshot) return;
    const snapshot = projector.snapshot();
    await readModels.replaceOne({ entityType: 'base_snapshot', entityId: 'latest' }, {
      entityType: 'base_snapshot', entityId: 'latest', snapshot,
    }, { upsert: true });
  }

  async getSnapshot(): Promise<BaseProjectionSnapshot | undefined> {
    const readModels = this.readModels;
    if (!readModels) throw new Error('MONGO_NOT_CONNECTED');
    const record = await readModels.findOne({ entityType: 'base_snapshot', entityId: 'latest' });
    if (!record || !record.snapshot || typeof record.snapshot !== 'object') return undefined;
    return record.snapshot as BaseProjectionSnapshot;
  }

  async getFacilitySnapshot(facility: string): Promise<BaseFacilityProjection | undefined> {
    return (await this.getSnapshot())?.facilities[facility.toLowerCase()];
  }

  async getOracleSnapshot(token: string): Promise<BaseTokenProjection | undefined> {
    return (await this.getSnapshot())?.tokens[token.toLowerCase()];
  }
}

function toMongoEvent(event: BaseChainEvent): MongoEventRecord {
  return {
    _id: eventKey(event),
    chainId: event.chainId,
    txHash: String(event.txHash),
    logIndex: event.logIndex,
    blockNumber: event.blockNumber.toString(10),
    ...(event.blockHash ? { blockHash: String(event.blockHash) } : {}),
    address: String(event.address),
    eventName: event.eventName,
    args: serializeValue(event.args) as Readonly<Record<string, unknown>>,
  };
}

function toBaseEvent(record: MongoEventRecord): BaseChainEvent {
  return {
    chainId: record.chainId,
    txHash: record.txHash,
    logIndex: record.logIndex,
    blockNumber: toBigInt(record.blockNumber),
    ...(record.blockHash ? { blockHash: record.blockHash } : {}),
    address: record.address,
    eventName: record.eventName,
    args: record.args,
  };
}

function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serializeValue(entry)]));
  }
  return value;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (value && typeof value === 'object') {
    const text = String(value);
    if (/^\d+$/.test(text)) return BigInt(text);
  }
  throw new Error('MONGO_INTEGER_INVALID');
}
