import { MongoClient, type Collection, type Db } from 'mongodb';

import type { IndexerSnapshot, IndexerSnapshotStore } from './redis';

interface SnapshotDocument extends IndexerSnapshot {
  readonly _id: string;
}

export interface MongoIndexerDocumentStore {
  findOne(filter: { readonly _id: string }): Promise<SnapshotDocument | null>;
  updateOne(
    filter: { readonly _id: string },
    update: { readonly $set: IndexerSnapshot },
    options: { readonly upsert: true },
  ): Promise<unknown>;
}

export class MongoIndexerProjection implements IndexerSnapshotStore {
  private readonly client?: MongoClient;
  private readonly configuredStore?: MongoIndexerDocumentStore;
  private db?: Db;
  private collection?: Collection<SnapshotDocument>;
  private connecting?: Promise<void>;

  constructor(
    uri: string,
    private readonly databaseName = 'trustrfq',
    private readonly collectionName = 'indexer_projections',
    documentStore?: MongoIndexerDocumentStore,
  ) {
    if (!uri.trim()) throw new Error('INDEXER_MONGO_URL');
    this.configuredStore = documentStore;
    if (!documentStore) {
      this.client = new MongoClient(uri, { appName: 'trustrfq-flare-indexer', retryWrites: true, maxPoolSize: 10 });
    }
  }

  async load(): Promise<IndexerSnapshot | undefined> {
    const document = await (await this.store()).findOne({ _id: 'singleton' });
    if (!document) return undefined;
    const { _id: unused, ...snapshot } = document;
    void unused;
    return snapshot;
  }

  async save(snapshot: IndexerSnapshot): Promise<void> {
    await (await this.store()).updateOne(
      { _id: 'singleton' },
      { $set: snapshot },
      { upsert: true },
    );
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.db = undefined;
    this.collection = undefined;
    this.connecting = undefined;
  }

  private async store(): Promise<MongoIndexerDocumentStore> {
    if (this.configuredStore) return this.configuredStore;
    if (!this.client) throw new Error('INDEXER_MONGO_STORE');
    if (!this.collection) {
      this.connecting ??= this.client.connect().then(() => undefined);
      await this.connecting;
      this.db = this.client.db(this.databaseName);
      this.collection = this.db.collection<SnapshotDocument>(this.collectionName);
    }
    return this.collection;
  }
}
