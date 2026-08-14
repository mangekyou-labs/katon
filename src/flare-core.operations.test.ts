import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EventProjector, type FlareEvent } from '../services/indexer/src/projector';
import { PersistentEventProjector } from '../services/indexer/src/persistent';
import { DualIndexerCheckpoint, RedisIndexerCheckpoint, RedisPersistentEventProjector, type IndexerSnapshot, type RedisCheckpointClient } from '../services/indexer/src/redis';
import { MongoIndexerProjection, type MongoIndexerDocumentStore } from '../services/indexer/src/mongo';
import { IdempotentKeeper } from '../services/keepers/src/worker';
import { RedisKeeperLease, type KeeperLeaseClient } from '../services/keepers/src/redis';
import { KeeperJobScheduler, keeperReadiness, validateKeeperJobSourceConfig } from '../services/keepers/src/scheduler';
import { HttpKeeperJobSource } from '../services/keepers/src/http-source';
import { indexerFreshness, reorgAction } from '../services/indexer/src/worker';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Flare operations boundaries', () => {
  it('classifies index freshness and fails closed before a successful poll', () => {
    expect(indexerFreshness(undefined, 10_000, 5_000)).toEqual({ status: 'unknown', ageMs: null });
    expect(indexerFreshness(9_000, 10_000, 5_000)).toEqual({ status: 'fresh', ageMs: 1_000 });
    expect(indexerFreshness(4_000, 10_000, 5_000)).toEqual({ status: 'stale', ageMs: 6_000 });
  });

  it('fails closed on finalized reorgs and rolls back only unfinalized cursors', () => {
    expect(reorgAction({ blockNumber: 20, logIndex: 0, blockHash: '0xold' }, 19, '0xold')).toBe('none');
    expect(reorgAction({ blockNumber: 20, logIndex: 0, blockHash: '0xold' }, 19, '0xnew')).toBe('rollback');
    expect(reorgAction({ blockNumber: 20, logIndex: 0, blockHash: '0xold' }, 20, '0xnew')).toBe('fail');
    expect(reorgAction({ blockNumber: 20, logIndex: 0 }, 19, '0xnew')).toBe('none');
  });
  it('projects duplicate/replayed chain events once and exposes a cursor', () => {
    const projector = new EventProjector();
    const event: FlareEvent = {
      txHash: '0xtx',
      logIndex: 2,
      blockNumber: 10,
      kind: 'RouteExecuted',
      commitment: '0xcommitment',
    };
    projector.apply([event, event]);
    projector.apply([{ ...event, logIndex: 3, commitment: '0xother' }]);
    expect(projector.events()).toHaveLength(2);
    expect(projector.cursor()).toEqual({ blockNumber: 10, logIndex: 3 });
  });

  it('tracks monotonic finality and exposes only finalized events on demand', () => {
    const projector = new EventProjector();
    const event: FlareEvent = {
      txHash: '0xtx',
      logIndex: 0,
      blockNumber: 12,
      kind: 'RouteExecuted',
      commitment: '0xcommitment',
    };
    projector.apply([event]);
    expect(projector.events({ finalizedOnly: true })).toEqual([]);
    projector.markFinalized(12);
    expect(projector.finalizedBlock()).toBe(12);
    expect(projector.events({ finalizedOnly: true })).toEqual([event]);
    expect(() => projector.markFinalized(11)).toThrow('FINALITY_REGRESSION');
  });

  it('rebuilds deterministically and detects conflicting duplicate payloads', () => {
    const projector = new EventProjector();
    const event: FlareEvent = {
      txHash: '0xtx',
      logIndex: 0,
      blockNumber: 3,
      kind: 'RouteExecuted',
      commitment: '0xcommitment',
      seller: '0xseller',
      inputAmount: { b: 2, a: 1 },
    };
    projector.apply([event]);
    projector.apply([{ ...event, inputAmount: { a: 1, b: 2 } }]);
    expect(() => projector.apply([{ ...event, commitment: '0xother' }])).toThrow('EVENT_CONFLICT');
    projector.rebuild([event], 3);
    expect(projector.events({ finalizedOnly: true })).toEqual([event]);
    expect(projector.cursor()).toEqual({ blockNumber: 3, logIndex: 0 });
  });

  it('rolls back unfinalized events from a reorg boundary and accepts the replacement chain', () => {
    const projector = new EventProjector();
    const first = { txHash: '0xold', logIndex: 0, blockNumber: 20, kind: 'RouteExecuted', commitment: '0xold-commitment' } satisfies FlareEvent;
    const stable = { txHash: '0xstable', logIndex: 0, blockNumber: 19, kind: 'RouteExecuted', commitment: '0xstable-commitment' } satisfies FlareEvent;
    projector.apply([stable, first]);
    projector.markFinalized(19);
    projector.rollbackFrom(20);
    expect(projector.events()).toEqual([stable]);
    expect(projector.cursor()).toEqual({ blockNumber: 19, logIndex: 0 });
    expect(projector.finalizedBlock()).toBe(19);
    const replacement = { txHash: '0xnew', logIndex: 0, blockNumber: 20, kind: 'RouteExecuted', commitment: '0xnew-commitment' } satisfies FlareEvent;
    projector.apply([replacement]);
    expect(projector.events({ finalizedOnly: true })).toEqual([stable]);
    projector.markFinalized(20);
    expect(projector.events({ finalizedOnly: true })).toEqual([stable, replacement]);
  });

  it('rejects confidential payload fields at the public event projector boundary', () => {
    const projector = new EventProjector();
    expect(() => projector.apply([{
      txHash: '0xtx', logIndex: 0, blockNumber: 1, kind: 'RouteExecuted', commitment: '0xcommitment',
      ciphertext: 'sealed-payload',
    }])).toThrow('EVENT_PRIVATE_FIELD');
  });

  it('coalesces concurrent keeper attempts and permits retry after failure', async () => {
    const keeper = new IdempotentKeeper();
    let calls = 0;
    const first = await Promise.all([
      keeper.run('auction:1', async () => {
        calls += 1;
        await Promise.resolve();
        return 'submitted';
      }),
      keeper.run('auction:1', async () => {
        calls += 1;
        return 'duplicate';
      }),
    ]);
    expect(first).toEqual(['submitted', 'submitted']);
    expect(calls).toBe(1);
    await expect(
      keeper.run('auction:2', async () => {
        throw new Error('RPC_DOWN');
      }),
    ).rejects.toThrow('RPC_DOWN');
    await expect(keeper.run('auction:2', async () => 'retried')).resolves.toBe('retried');
  });

  it('uses a Redis lease boundary for cross-worker keeper exclusion', async () => {
    const locks = new Map<string, string>();
    const fake: KeeperLeaseClient = {
      async connect() {},
      async set(key, value) { if (locks.has(key)) return null; locks.set(key, value); return 'OK'; },
      async eval(_script, options) { return locks.get(options.keys[0]!) === options.arguments[0] && locks.delete(options.keys[0]!) ? 1 : 0; },
      async quit() {},
    };
    const lease = new RedisKeeperLease(fake);
    const keeper = new IdempotentKeeper();
    await expect(keeper.runWithLease('liquidation:1', lease, async () => 'submitted')).resolves.toBe('submitted');
    expect(locks.size).toBe(0);
    expect(await lease.acquire('held')).toBe(true);
    await expect(keeper.runWithLease('held', lease, async () => 'duplicate')).rejects.toThrow('KEEPER_LEASE_BUSY');
    await lease.release('held');
  });

  it('excludes the same due job across independent lease owners', async () => {
    const locks = new Map<string, string>();
    const client = (): KeeperLeaseClient => ({
      async connect() {},
      async set(key, value) { if (locks.has(key)) return null; locks.set(key, value); return 'OK'; },
      async eval(_script, options) { return locks.get(options.keys[0]!) === options.arguments[0] && locks.delete(options.keys[0]!) ? 1 : 0; },
      async quit() {},
    });
    const firstLease = new RedisKeeperLease(client(), 'race:');
    const secondLease = new RedisKeeperLease(client(), 'race:');
    const firstKeeper = new IdempotentKeeper();
    const secondKeeper = new IdempotentKeeper();
    let entered = 0;
    let releaseAction!: () => void;
    const actionBlocked = new Promise<void>((resolve) => { releaseAction = resolve; });
    const first = firstKeeper.runWithLease('auction:race', firstLease, async () => {
      entered += 1;
      await actionBlocked;
      return 'first';
    });
    await Promise.resolve();
    const second = secondKeeper.runWithLease('auction:race', secondLease, async () => {
      entered += 1;
      return 'second';
    });
    await expect(second).rejects.toThrow('KEEPER_LEASE_BUSY');
    releaseAction();
    await expect(first).resolves.toBe('first');
    expect(entered).toBe(1);
    expect(locks.size).toBe(0);
  });

  it('runs typed keeper jobs idempotently, skips future work, and records failures for retry', async () => {
    const held = new Set<string>();
    const lease = {
      async acquire(key: string) { if (held.has(key)) return false; held.add(key); return true; },
      async release(key: string) { held.delete(key); },
    };
    let now = 1_000;
    let calls = 0;
    const scheduler = new KeeperJobScheduler(lease, () => now);
    scheduler.register('fdc-progression', {
      async due() {
        return [
          { kind: 'fdc-progression' as const, key: 'round-1', dueAt: 900, run: async () => { calls += 1; } },
          { kind: 'fdc-progression' as const, key: 'round-2', dueAt: 1_100, run: async () => { calls += 1; } },
        ];
      },
    });
    expect(await scheduler.runDue()).toEqual([
      { kind: 'fdc-progression', key: 'round-1', status: 'succeeded' },
      { kind: 'fdc-progression', key: 'round-2', status: 'skipped' },
    ]);
    expect(calls).toBe(1);
    expect(scheduler.counters()).toEqual({ attempted: 1, succeeded: 1, skipped: 1, failed: 0 });

    scheduler.register('auction-expiry', {
      async due() {
        return [{ kind: 'auction-expiry' as const, key: 'auction-1', dueAt: 0, run: async () => { throw new Error('RPC_DOWN'); } }];
      },
    });
    expect((await scheduler.runDue()).find((result) => result.key === 'auction-1')).toMatchObject({ status: 'failed', error: 'RPC_DOWN' });
    expect(scheduler.counters().failed).toBe(1);
  });

  it('fails closed when production keeper job sources are incomplete', () => {
    expect(() => validateKeeperJobSourceConfig({}, true)).toThrow('KEEPER_JOB_SOURCE_MISSING:auction-expiry');
    const config: Record<string, string> = {};
    for (const kind of ['auction-expiry', 'liquidation-detection', 'fdc-progression', 'redemption-settlement', 'withdrawal-queue']) {
      const prefix = `FLARE_KEEPER_${kind.toUpperCase().replaceAll('-', '_')}`;
      config[`${prefix}_DUE_URL`] = `https://keeper.test/${kind}/due`;
      config[`${prefix}_RUN_URL`] = `https://keeper.test/${kind}/run`;
    }
    expect(validateKeeperJobSourceConfig(config, true)).toHaveLength(5);
  });

  it('separates keeper liveness from production job-source readiness', () => {
    const readiness = keeperReadiness({
      FLARE_KEEPER_AUCTION_EXPIRY_DUE_URL: 'https://keeper.test/due',
      FLARE_KEEPER_AUCTION_EXPIRY_RUN_URL: 'https://keeper.test/run',
    }, true);
    expect(readiness).toEqual({
      ready: false,
      requireAll: true,
      configuredKinds: ['auction-expiry'],
      missingKinds: ['liquidation-detection', 'fdc-progression', 'redemption-settlement', 'withdrawal-queue'],
    });
  });

  it('strictly validates HTTP keeper jobs and sends a stable idempotency key', async () => {
    const requests: { url: string; method?: string; headers?: HeadersInit; body?: string }[] = [];
    const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
      requests.push({ url: input, method: init?.method, headers: init?.headers, body: init?.body as string | undefined });
      if (init?.method === 'POST') return new Response(JSON.stringify({ success: true }), { status: 200 });
      return new Response(JSON.stringify({ jobs: [{ key: 'auction-1', dueAt: 900 }] }), { status: 200 });
    };
    const source = new HttpKeeperJobSource('auction-expiry', 'https://keeper.test/due', 'https://keeper.test/run', fetcher);
    const [job] = await source.due(1_000);
    expect(job).toMatchObject({ kind: 'auction-expiry', key: 'auction-1', dueAt: 900 });
    await job!.run();
    expect(requests[0]?.url).toBe('https://keeper.test/due?now=1000');
    expect(requests[1]?.headers).toMatchObject({ 'idempotency-key': 'auction-expiry:auction-1' });
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({ kind: 'auction-expiry', key: 'auction-1' });
    const invalid = new HttpKeeperJobSource('fdc-progression', 'https://keeper.test/due', 'https://keeper.test/run', async () => new Response(JSON.stringify({ jobs: [{ key: '', dueAt: 1 }] }), { status: 200 }));
    await expect(invalid.due(1)).rejects.toThrow('KEEPER_DUE_SCHEMA:fdc-progression');
  });

  it('persists an idempotent projector checkpoint and restores finality', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trustrfq-indexer-'));
    tempDirectories.push(directory);
    const filePath = join(directory, 'index.json');
    const event: FlareEvent = { txHash: '0xtx', logIndex: 0, blockNumber: 12, kind: 'RouteExecuted', commitment: '0xcommitment' };
    const first = new PersistentEventProjector(filePath);
    first.apply([event, event]);
    first.markFinalized(12);

    const second = new PersistentEventProjector(filePath);
    expect(second.events({ finalizedOnly: true })).toEqual([event]);
    expect(second.cursor()).toEqual({ blockNumber: 12, logIndex: 0 });
    expect(second.finalizedBlock()).toBe(12);
  });

  it('fails closed on a corrupt indexer checkpoint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trustrfq-indexer-'));
    tempDirectories.push(directory);
    const filePath = join(directory, 'index.json');
    writeFileSync(filePath, '{not-json');
    expect(() => new PersistentEventProjector(filePath)).toThrow('INDEXER_STORE_INVALID');
  });

  it('hydrates and persists the production Redis checkpoint boundary without private fields', async () => {
    let stored: string | null = null;
    const fake: RedisCheckpointClient = {
      async connect() {},
      async get() { return stored; },
      async set(_key, value) { stored = value; },
      async quit() {},
    };
    const first = new RedisPersistentEventProjector(new RedisIndexerCheckpoint(fake));
    await first.apply([{ txHash: '0xtx', logIndex: 0, blockNumber: 8, kind: 'RouteExecuted', commitment: '0xc' }]);
    await first.markFinalized(8);
    const second = new RedisPersistentEventProjector(new RedisIndexerCheckpoint(fake));
    await second.hydrate();
    expect(second.events({ finalizedOnly: true })).toHaveLength(1);
    expect(second.cursor()).toEqual({ blockNumber: 8, logIndex: 0 });
    expect(second.finalizedBlock()).toBe(8);
    const invalid = new RedisPersistentEventProjector(new RedisIndexerCheckpoint({
      async connect() {}, async get() { return JSON.stringify({ events: [{ txHash: '0x', logIndex: 0, blockNumber: 1, kind: 'x', commitment: '0xc', plaintext: 'secret' }], finalizedBlock: 1 }); }, async set() {}, async quit() {},
    }));
    await expect(invalid.hydrate()).rejects.toThrow('EVENT_PRIVATE_FIELD');
  });

  it('persists a reorg rollback before replaying replacement events', async () => {
    let stored: string | null = null;
    const fake: RedisCheckpointClient = {
      async connect() {},
      async get() { return stored; },
      async set(_key, value) { stored = value; },
      async quit() {},
    };
    const projector = new RedisPersistentEventProjector(new RedisIndexerCheckpoint(fake));
    await projector.apply([
      { txHash: '0xstable', logIndex: 0, blockNumber: 19, kind: 'RouteExecuted', commitment: '0xstable' },
      { txHash: '0xold', logIndex: 0, blockNumber: 20, kind: 'RouteExecuted', commitment: '0xold' },
    ]);
    await projector.markFinalized(19);
    await projector.rollbackFrom(20);
    await projector.apply([{ txHash: '0xnew', logIndex: 0, blockNumber: 20, kind: 'RouteExecuted', commitment: '0xnew' }]);
    const restored = new RedisPersistentEventProjector(new RedisIndexerCheckpoint(fake));
    await restored.hydrate();
    expect(restored.events()).toEqual([
      { txHash: '0xstable', logIndex: 0, blockNumber: 19, kind: 'RouteExecuted', commitment: '0xstable' },
      { txHash: '0xnew', logIndex: 0, blockNumber: 20, kind: 'RouteExecuted', commitment: '0xnew' },
    ]);
  });

  it('writes indexer projections to Mongo and hydrates from Mongo when Redis is empty', async () => {
    let stored: ({ _id: string } & IndexerSnapshot) | undefined;
    const mongo: MongoIndexerDocumentStore = {
      async findOne() { return stored ?? null; },
      async updateOne(_filter, update) { stored = { _id: 'singleton', ...update.$set }; },
    };
    const durable = new MongoIndexerProjection('mongodb://unused', 'trustrfq', 'indexer_projections', mongo);
    const snapshot: IndexerSnapshot = {
      events: [{ txHash: '0xtx', logIndex: 0, blockNumber: 8, kind: 'RouteExecuted', commitment: '0xc' }],
      finalizedBlock: 8,
      cursor: { blockNumber: 8, logIndex: 0 },
    };
    await durable.save(snapshot);
    expect(await durable.load()).toEqual(snapshot);

    let redisSnapshot: IndexerSnapshot | undefined;
    const primary = {
      async load() { return redisSnapshot; },
      async save(value: IndexerSnapshot) { redisSnapshot = value; },
      async close() {},
    };
    const dual = new DualIndexerCheckpoint(primary, durable);
    expect(await dual.load()).toEqual(snapshot);
    redisSnapshot = { ...snapshot, events: [], finalizedBlock: 1, cursor: { blockNumber: 1, logIndex: 0 } };
    expect(await dual.load()).toEqual(snapshot);
    await dual.save(snapshot);
    expect(redisSnapshot).toEqual(snapshot);
  });
});
