import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Address } from 'viem';
import type { NonceStore, SessionStore, StoredNonce, StoredSession } from './auth';
import type { BaseRepository } from './ports';
import type { BaseFacilitySnapshot, BaseOracleSnapshot, StoredBid, StoredLiquidation, StoredRoute, StoredSwapOrder } from './types';

type MongoRecord = Record<string, unknown> & { _id?: string };

interface MongoSessionRecord {
  readonly _id: string;
  readonly identity: Address;
  readonly domain: string;
  readonly chainId: number;
  readonly expiresAt: Date;
}

interface MongoNonceRecord extends StoredNonce {
  readonly _id: string;
  readonly expiresAt: Date;
}

/** MongoDB adapter for the API ports. Amount-like fields are received and stored as strings. */
export class MongoBaseRepository implements BaseRepository {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private db?: Db;
  private liquidations?: Collection<MongoRecord>;
  private bids?: Collection<MongoRecord>;
  private routes?: Collection<MongoRecord>;
  private standing?: Collection<MongoRecord>;
  private swapOrders?: Collection<MongoRecord>;
  private readModels?: Collection<MongoRecord>;

  constructor(uri: string, dbName: string) {
    this.client = new MongoClient(uri);
    this.dbName = dbName;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.liquidations = this.db.collection('base_liquidations');
    this.bids = this.db.collection('base_bids');
    this.routes = this.db.collection('base_routes');
    this.standing = this.db.collection('base_standing_bids');
    this.swapOrders = this.db.collection('base_swap_orders');
    this.readModels = this.db.collection('base_indexer_read_models');
    await this.ensureIndexes();
  }

  async ensureIndexes(): Promise<void> {
    const liquidations = this.require(this.liquidations, 'MONGO_NOT_CONNECTED');
    const bids = this.require(this.bids, 'MONGO_NOT_CONNECTED');
    const routes = this.require(this.routes, 'MONGO_NOT_CONNECTED');
    const standing = this.require(this.standing, 'MONGO_NOT_CONNECTED');
    const swapOrders = this.require(this.swapOrders, 'MONGO_NOT_CONNECTED');
    const readModels = this.require(this.readModels, 'MONGO_NOT_CONNECTED');
    const db = this.require(this.db, 'MONGO_NOT_CONNECTED');
    await Promise.all([
      liquidations.createIndex({ opportunityKey: 1 }, {
        unique: true,
        partialFilterExpression: { status: 'open' },
        name: 'one_open_liquidation_per_opportunity',
      }),
      bids.createIndex({ orderHash: 1 }, { unique: true, name: 'unique_order_hash' }),
      bids.createIndex({ rfqId: 1, timestamp: 1 }, { name: 'bids_by_rfq_time' }),
      routes.createIndex({ rfqId: 1 }, { unique: true, name: 'one_route_per_rfq' }),
      standing.createIndex({ owner: 1, orderHash: 1 }, { unique: true, name: 'owner_scoped_standing_bid' }),
      standing.createIndex({ orderHash: 1 }, { unique: true, name: 'unique_standing_order_hash' }),
      standing.createIndex({ owner: 1 }, { name: 'standing_bids_by_owner' }),
      swapOrders.createIndex({ orderHash: 1 }, { unique: true, name: 'unique_swap_order_hash' }),
      swapOrders.createIndex({ maker: 1, timestamp: 1 }, { name: 'swap_orders_by_maker_time' }),
      db.collection('base_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiring_sessions' }),
      db.collection('base_nonces').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiring_nonces' }),
      readModels.createIndex({ entityType: 1, entityId: 1 }, { unique: true, name: 'base_read_model_entity' }),
    ]);
  }

  sessionStore(): SessionStore {
    const sessions = this.require(this.db, 'MONGO_NOT_CONNECTED').collection<MongoSessionRecord>('base_sessions');
    return {
      put: async (session: StoredSession) => {
        await sessions.replaceOne(
          { _id: session.tokenHash },
          {
            _id: session.tokenHash,
            identity: session.identity,
            domain: session.domain,
            chainId: session.chainId,
            expiresAt: new Date(Number(session.expiresAt) * 1_000),
          } as MongoSessionRecord,
          { upsert: true },
        );
      },
      get: async (tokenHash: string) => {
        const session = await sessions.findOne({ _id: tokenHash });
        if (!session) return undefined;
        return {
          tokenHash: session._id,
          identity: session.identity,
          domain: session.domain,
          chainId: session.chainId,
          expiresAt: BigInt(Math.floor(session.expiresAt.getTime() / 1_000)),
        };
      },
    };
  }

  nonceStore(): NonceStore {
    const nonces = this.require(this.db, 'MONGO_NOT_CONNECTED').collection<MongoNonceRecord>('base_nonces');
    return {
      put: async (nonce: StoredNonce) => {
        await nonces.replaceOne(
          { _id: nonce.nonce },
          {
            ...nonce,
            _id: nonce.nonce,
            expiresAt: new Date(Date.parse(nonce.expirationTime)),
          } as MongoNonceRecord,
          { upsert: true },
        );
      },
      consume: async (nonce: string, now: bigint) => {
        const result = await nonces.findOneAndUpdate(
          { _id: nonce, consumed: false, expiresAt: { $gt: new Date(Number(now) * 1_000) } },
          { $set: { consumed: true } },
          { returnDocument: 'after' },
        );
        if (!result) return undefined;
        const { _id, expiresAt, ...stored } = result;
        void _id;
        void expiresAt;
        return stored;
      },
    };
  }

  async createLiquidation(input: StoredLiquidation): Promise<StoredLiquidation> {
    const collection = this.require(this.liquidations, 'MONGO_NOT_CONNECTED');
    try {
      await collection.insertOne({ ...input, _id: input.id });
      return input;
    } catch (error) {
      if (isDuplicate(error)) {
        const existing = await collection.findOne({ opportunityKey: input.opportunityKey, status: 'open' });
        if (existing) return withoutId(existing) as unknown as StoredLiquidation;
        throw new Error('OPPORTUNITY_ALREADY_EXISTS');
      }
      throw error;
    }
  }

  async getLiquidation(id: string): Promise<StoredLiquidation | undefined> {
    const value = await this.require(this.liquidations, 'MONGO_NOT_CONNECTED').findOne({ _id: id });
    return value ? withoutId(value) as unknown as StoredLiquidation : undefined;
  }

  async listLiquidations(): Promise<readonly StoredLiquidation[]> {
    const values = await this.require(this.liquidations, 'MONGO_NOT_CONNECTED').find({}).sort({ createdAt: 1 }).toArray();
    return values.map((value) => withoutId(value) as unknown as StoredLiquidation);
  }

  async listOpenLiquidations(): Promise<readonly StoredLiquidation[]> {
    const values = await this.require(this.liquidations, 'MONGO_NOT_CONNECTED').find({ status: 'open' }).sort({ createdAt: 1 }).toArray();
    return values.map((value) => withoutId(value) as unknown as StoredLiquidation);
  }

  async listBids(rfqId: string): Promise<readonly StoredBid[]> {
    const values = await this.require(this.bids, 'MONGO_NOT_CONNECTED').find({ rfqId }).sort({ timestamp: 1 }).toArray();
    return values.map((value) => withoutId(value) as unknown as StoredBid);
  }

  async insertBid(bid: StoredBid): Promise<void> {
    try {
      await this.require(this.bids, 'MONGO_NOT_CONNECTED').insertOne({ ...bid, _id: bid.orderHash });
    } catch (error) {
      if (isDuplicate(error)) throw new Error('ORDER_HASH_EXISTS');
      throw error;
    }
  }

  /** The conditional update is the atomic open -> finalized transition and freezes the route. */
  async finalizeIfOpen(id: string, route: StoredRoute, bidCount: number): Promise<boolean> {
    const result = await this.require(this.liquidations, 'MONGO_NOT_CONNECTED').updateOne(
      { _id: id, status: 'open' },
      {
        $set: {
          status: 'finalized',
          bidCount,
          winner: { identity: route.winner, source: route.source, orderHash: route.orderHash },
          route,
        },
        $unset: { failureCode: '' },
      },
    );
    if (result.matchedCount !== 1) return false;
    await this.require(this.routes, 'MONGO_NOT_CONNECTED').updateOne(
      { _id: route.rfqId },
      { $set: { ...route, rfqId: route.rfqId, _id: route.rfqId } },
      { upsert: true },
    );
    return true;
  }

  async recordFailure(id: string, failureCode: string): Promise<void> {
    await this.require(this.liquidations, 'MONGO_NOT_CONNECTED').updateOne({ _id: id, status: 'open' }, { $set: { failureCode } });
  }

  async expireIfOpen(id: string): Promise<boolean> {
    const result = await this.require(this.liquidations, 'MONGO_NOT_CONNECTED').updateOne(
      { _id: id, status: 'open' },
      { $set: { status: 'expired' }, $unset: { failureCode: '' } },
    );
    return result.matchedCount === 1;
  }

  async registerStandingBid(bid: StoredBid): Promise<void> {
    try {
      await this.require(this.standing, 'MONGO_NOT_CONNECTED').insertOne({
        ...bid,
        _id: `${bid.maker.toLowerCase()}:${bid.orderHash}`,
        owner: bid.maker.toLowerCase(),
      });
    } catch (error) {
      if (isDuplicate(error)) throw new Error('ORDER_HASH_EXISTS');
      throw error;
    }
  }

  async revokeStandingBid(owner: Address, orderHash: string): Promise<boolean> {
    const result = await this.require(this.standing, 'MONGO_NOT_CONNECTED').deleteOne({ owner: owner.toLowerCase(), orderHash });
    return result.deletedCount === 1;
  }

  async listStandingBids(owner: Address): Promise<readonly StoredBid[]> {
    const values = await this.require(this.standing, 'MONGO_NOT_CONNECTED').find({ owner: owner.toLowerCase() }).sort({ timestamp: 1 }).toArray();
    return values.map((value) => withoutId(value) as unknown as StoredBid);
  }

  async listAllStandingBids(): Promise<readonly StoredBid[]> {
    const values = await this.require(this.standing, 'MONGO_NOT_CONNECTED').find({}).sort({ timestamp: 1 }).toArray();
    return values.map((value) => withoutId(value) as unknown as StoredBid);
  }

  async insertSwapOrder(order: StoredSwapOrder): Promise<void> {
    try {
      await this.require(this.swapOrders, 'MONGO_NOT_CONNECTED').insertOne({ ...order, _id: order.orderHash });
    } catch (error) {
      if (isDuplicate(error)) throw new Error('ORDER_HASH_EXISTS');
      throw error;
    }
  }

  async getSwapOrder(orderHash: string): Promise<StoredSwapOrder | undefined> {
    const value = await this.require(this.swapOrders, 'MONGO_NOT_CONNECTED').findOne({ _id: orderHash.toLowerCase() });
    return value ? withoutId(value) as unknown as StoredSwapOrder : undefined;
  }

  async listSwapOrders(maker?: Address): Promise<readonly StoredSwapOrder[]> {
    const query = maker ? { maker: maker.toLowerCase() } : {};
    const values = await this.require(this.swapOrders, 'MONGO_NOT_CONNECTED').find(query).sort({ timestamp: 1 }).toArray();
    return values.map((value) => withoutId(value) as unknown as StoredSwapOrder);
  }

  async revokeSwapOrder(maker: Address, orderHash: string): Promise<boolean> {
    const result = await this.require(this.swapOrders, 'MONGO_NOT_CONNECTED').deleteOne({ _id: orderHash.toLowerCase(), maker: maker.toLowerCase() });
    return result.deletedCount === 1;
  }

  async getFacilitySnapshot(facility: Address): Promise<BaseFacilitySnapshot | undefined> {
    const snapshot = await this.readModelSnapshot();
    return snapshot?.facilities?.[facility.toLowerCase()] as BaseFacilitySnapshot | undefined;
  }

  async getOracleSnapshot(token: Address): Promise<BaseOracleSnapshot | undefined> {
    const snapshot = await this.readModelSnapshot();
    return snapshot?.tokens?.[token.toLowerCase()] as BaseOracleSnapshot | undefined;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private require<T>(value: T | undefined, error: string): T {
    if (!value) throw new Error(error);
    return value;
  }

  private async readModelSnapshot(): Promise<{
    readonly facilities?: Readonly<Record<string, unknown>>;
    readonly tokens?: Readonly<Record<string, unknown>>;
  } | undefined> {
    const record = await this.require(this.readModels, 'MONGO_NOT_CONNECTED').findOne({ entityType: 'base_snapshot', entityId: 'latest' });
    if (!record || !record.snapshot || typeof record.snapshot !== 'object') return undefined;
    return record.snapshot as {
      readonly facilities?: Readonly<Record<string, unknown>>;
      readonly tokens?: Readonly<Record<string, unknown>>;
    };
  }
}

function withoutId(value: MongoRecord): MongoRecord {
  const result = { ...value };
  delete result._id;
  delete result.owner;
  return result;
}

function isDuplicate(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: number }).code === 11000);
}
