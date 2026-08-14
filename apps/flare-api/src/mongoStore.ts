import { MongoClient, type Collection, type Db } from 'mongodb';

import type { ApiStorePersistence, ApiStoreSnapshot } from './store';

interface SnapshotDocument extends ApiStoreSnapshot {
  readonly _id: string;
}

export class MongoApiStore implements ApiStorePersistence {
  private readonly client: MongoClient;
  private db?: Db;
  private collection?: Collection<SnapshotDocument>;
  private connecting?: Promise<void>;

  constructor(
    uri: string,
    private readonly databaseName = 'trustrfq',
    private readonly collectionName = 'api_snapshots',
  ) {
    if (!uri.trim()) throw new Error('MONGO_URL_REQUIRED');
    this.client = new MongoClient(uri, {
      appName: 'trustrfq-flare-api',
      retryWrites: true,
      maxPoolSize: 10,
    });
  }

  async load(): Promise<ApiStoreSnapshot | undefined> {
    const document = await (await this.collectionRef()).findOne({ _id: 'singleton' });
    if (!document) return undefined;
    const { _id: unused, ...snapshot } = document;
    void unused;
    return snapshot;
  }

  async save(snapshot: ApiStoreSnapshot): Promise<void> {
    await (await this.collectionRef()).updateOne(
      { _id: 'singleton' },
      { $set: snapshot },
      { upsert: true },
    );
  }

  async close(): Promise<void> {
    await this.client.close();
    this.db = undefined;
    this.collection = undefined;
    this.connecting = undefined;
  }

  private async collectionRef(): Promise<Collection<SnapshotDocument>> {
    if (this.collection) return this.collection;
    this.connecting ??= this.client.connect().then(() => undefined);
    await this.connecting;
    this.db = this.client.db(this.databaseName);
    this.collection = this.db.collection<SnapshotDocument>(this.collectionName);
    return this.collection;
  }
}
