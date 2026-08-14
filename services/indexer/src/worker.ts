import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, type Address } from 'viem';
import { PUBLIC_EVENT_ABI } from '@trustrfq/flare-core';

import { DualIndexerCheckpoint, RedisIndexerCheckpoint, RedisPersistentEventProjector } from './redis';
import { MongoIndexerProjection } from './mongo';
import type { FlareEvent } from './projector';

export function reorgAction(cursor: { readonly blockNumber: number; readonly logIndex: number; readonly blockHash?: string }, finalizedBlock: number, observedBlockHash: string): 'none' | 'rollback' | 'fail' {
  if (!cursor.blockHash || cursor.blockHash === observedBlockHash) return 'none';
  return cursor.blockNumber <= finalizedBlock ? 'fail' : 'rollback';
}

const EVENT_ABI = PUBLIC_EVENT_ABI;

export type IndexerFreshnessStatus = 'fresh' | 'stale' | 'unknown';

export function indexerFreshness(lastSuccessfulPollAt: number | undefined, nowMs: number, maxAgeMs: number): { readonly status: IndexerFreshnessStatus; readonly ageMs: number | null } {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('INDEXER_FRESHNESS_CONFIG');
  if (lastSuccessfulPollAt === undefined) return { status: 'unknown', ageMs: null };
  if (!Number.isFinite(lastSuccessfulPollAt) || lastSuccessfulPollAt > nowMs) return { status: 'unknown', ageMs: null };
  const ageMs = nowMs - lastSuccessfulPollAt;
  return { status: ageMs <= maxAgeMs ? 'fresh' : 'stale', ageMs };
}

interface DeploymentManifest {
  readonly chainId: number;
  readonly contracts: Readonly<Record<string, string>>;
}

export class FlareIndexerRuntime {
  private readonly client;
  private readonly projector: RedisPersistentEventProjector;
  private readonly addresses: readonly Address[];
  private polling?: ReturnType<typeof setInterval>;
  private lastError?: string;
  private actualChainId?: number;
  private pollCount = 0;
  private eventCount = 0;
  private lastPollAt?: number;
  private lastSuccessfulPollAt?: number;
  private readonly staleAfterMs = Math.max(1_000, Number(process.env.FLARE_INDEXER_STALE_MS ?? 120_000));

  constructor(
    rpcUrl: string,
    checkpoint: RedisIndexerCheckpoint | DualIndexerCheckpoint,
    addresses: readonly Address[],
    private readonly confirmations = 3,
    private readonly batchSize = 30n,
    startBlock = 0,
    private readonly expectedChainId = 0,
  ) {
    if (!rpcUrl.trim()) throw new Error('INDEXER_RPC_URL');
    if (!Number.isInteger(confirmations) || confirmations < 0) throw new Error('INDEXER_CONFIRMATIONS');
    this.client = createPublicClient({ transport: http(rpcUrl) });
    if (!Number.isInteger(startBlock) || startBlock < 0) throw new Error('INDEXER_START_BLOCK');
    this.projector = new RedisPersistentEventProjector(checkpoint, { blockNumber: startBlock, logIndex: -1 });
    this.addresses = addresses;
  }

  async start(): Promise<void> {
    this.actualChainId = await this.client.getChainId();
    if (this.expectedChainId > 0 && this.actualChainId !== this.expectedChainId) {
      throw new Error(`INDEXER_RPC_CHAIN_ID_MISMATCH: expected ${this.expectedChainId}, received ${this.actualChainId}`);
    }
    await this.projector.hydrate();
    await this.pollOnce();
    const interval = Math.max(1_000, Number(process.env.FLARE_INDEXER_POLL_MS ?? 5_000));
    this.polling = setInterval(() => { void this.pollOnce(); }, interval);
  }

  async stop(): Promise<void> {
    if (this.polling) clearInterval(this.polling);
    await this.projector.close();
  }

  async pollOnce(): Promise<void> {
    this.pollCount += 1;
    this.lastPollAt = Date.now();
    try {
      const latest = await this.client.getBlockNumber();
      const finalized = latest > BigInt(this.confirmations) ? latest - BigInt(this.confirmations) : 0n;
      const cursor = this.projector.cursor();
      if (cursor.blockHash && cursor.blockNumber > 0) {
        const cursorBlock = await this.client.getBlock({ blockNumber: BigInt(cursor.blockNumber) });
        const action = reorgAction(cursor, this.projector.finalizedBlock(), cursorBlock.hash);
        if (action === 'fail') throw new Error('INDEXER_FINALIZED_REORG');
        if (action === 'rollback') await this.projector.rollbackFrom(cursor.blockNumber);
      }
      if (this.addresses.length > 0 && finalized > BigInt(this.projector.cursor().blockNumber)) {
        let from = BigInt(this.projector.cursor().blockNumber + 1);
        while (from <= finalized) {
          const to = from + this.batchSize - 1n < finalized ? from + this.batchSize - 1n : finalized;
          const logs = await this.client.getLogs({ address: [...this.addresses], events: EVENT_ABI, fromBlock: from, toBlock: to });
          const events = logs.flatMap((log) => {
            if (!log.transactionHash || log.logIndex === undefined || log.blockNumber === undefined || !log.eventName) return [];
            const args = log.args as Record<string, unknown> | undefined;
            const commitment = args?.commitment ?? args?.orderHash ?? args?.payloadCommitment ?? log.transactionHash;
            return [{ txHash: log.transactionHash, logIndex: Number(log.logIndex), blockNumber: Number(log.blockNumber), ...(typeof log.blockHash === 'string' ? { blockHash: log.blockHash } : {}), kind: log.eventName, commitment: String(commitment), ...args } satisfies FlareEvent];
          });
          this.eventCount += events.length;
          await this.projector.apply(events);
          from = to + 1n;
        }
      }
      await this.projector.markFinalized(Number(finalized));
      this.lastError = undefined;
      this.lastSuccessfulPollAt = Date.now();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'INDEXER_POLL_FAILED';
    }
  }

  health(): Record<string, unknown> {
    const freshness = indexerFreshness(this.lastSuccessfulPollAt, Date.now(), this.staleAfterMs);
    return {
      ok: !this.lastError,
      service: 'flare-indexer',
      cursor: this.projector.cursor(),
      finalizedBlock: this.projector.finalizedBlock(),
      eventCount: this.projector.events().length,
      polls: this.pollCount,
      ingestedEvents: this.eventCount,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : undefined,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt ? new Date(this.lastSuccessfulPollAt).toISOString() : undefined,
      freshness: freshness.status,
      freshnessAgeMs: freshness.ageMs,
      freshnessMaxAgeMs: this.staleAfterMs,
      chainId: this.actualChainId,
      error: this.lastError,
    };
  }
}

export function loadDeploymentAddresses(manifestPath: string): { chainId: number; addresses: Address[] } {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as DeploymentManifest;
  if (!Number.isInteger(manifest.chainId) || !manifest.contracts) throw new Error('INDEXER_MANIFEST_INVALID');
  const addresses = Object.values(manifest.contracts).filter((address): address is Address => /^0x[0-9a-fA-F]{40}$/.test(address));
  return { chainId: manifest.chainId, addresses };
}

export async function startIndexerFromEnvironment(): Promise<FlareIndexerRuntime> {
  const redisUrl = process.env.FLARE_INDEXER_REDIS_URL;
  if (!redisUrl) throw new Error('INDEXER_REDIS_URL_REQUIRED');
  const checkpoint = RedisIndexerCheckpoint.fromUrl(redisUrl, process.env.FLARE_INDEXER_CHECKPOINT_KEY);
  const mongoCheckpoint = process.env.FLARE_INDEXER_MONGO_URL
    ? new MongoIndexerProjection(
      process.env.FLARE_INDEXER_MONGO_URL,
      process.env.FLARE_INDEXER_MONGO_DATABASE ?? 'trustrfq',
      process.env.FLARE_INDEXER_MONGO_COLLECTION ?? 'indexer_projections',
    )
    : undefined;
  const configuredAddresses = process.env.FLARE_INDEXER_CONTRACTS;
  const defaultManifest = existsSync(resolve('contracts/flare/deployments/coston2-proxy-candidate.json'))
    ? resolve('contracts/flare/deployments/coston2-proxy-candidate.json')
    : resolve('contracts/flare/deployments/coston2.json');
  const deployment = configuredAddresses === undefined
    ? loadDeploymentAddresses(process.env.FLARE_INDEXER_MANIFEST ?? defaultManifest)
    : { chainId: Number(process.env.FLARE_INDEXER_CHAIN_ID ?? 0), addresses: configuredAddresses.split(',').map((address) => address.trim()).filter(Boolean) as Address[] };
  const expectedChainId = Number(process.env.FLARE_INDEXER_CHAIN_ID ?? deployment.chainId);
  const rpcUrl = process.env.FLARE_INDEXER_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
  if (expectedChainId !== deployment.chainId && deployment.addresses.length > 0) throw new Error('INDEXER_CHAIN_ID_MANIFEST_MISMATCH');
  const runtime = new FlareIndexerRuntime(rpcUrl, mongoCheckpoint ? new DualIndexerCheckpoint(checkpoint, mongoCheckpoint) : checkpoint, deployment.addresses, Number(process.env.FLARE_INDEXER_CONFIRMATIONS ?? 3), BigInt(process.env.FLARE_INDEXER_BATCH_SIZE ?? 30), Number(process.env.FLARE_INDEXER_START_BLOCK ?? 0), expectedChainId);
  await runtime.start();
  return runtime;
}

async function main(): Promise<void> {
  const runtime = await startIndexerFromEnvironment();
  const port = Number(process.env.FLARE_INDEXER_PORT ?? 8790);
  const server = createServer((request, response) => {
    if (request.method === 'GET' && (request.url === '/healthz' || request.url === '/readyz')) {
      const health = runtime.health();
      const ready = health.ok === true && health.freshness === 'fresh';
      response.writeHead(request.url === '/readyz' ? (ready ? 200 : 503) : (health.ok ? 200 : 503), { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...health, ready }));
      return;
    }
    if (request.method === 'GET' && request.url === '/metrics') {
      const health = runtime.health();
      const metric = (name: string, value: unknown) => `${name} ${typeof value === 'number' ? value : 0}`;
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      response.end([
        '# HELP trustrfq_indexer_polls_total Indexer polling attempts.',
        '# TYPE trustrfq_indexer_polls_total counter',
        metric('trustrfq_indexer_polls_total', health.polls),
        '# HELP trustrfq_indexer_events_ingested_total Public chain events observed by the indexer.',
        '# TYPE trustrfq_indexer_events_ingested_total counter',
        metric('trustrfq_indexer_events_ingested_total', health.ingestedEvents),
        '# HELP trustrfq_indexer_finalized_block Latest finalized block.',
        '# TYPE trustrfq_indexer_finalized_block gauge',
        metric('trustrfq_indexer_finalized_block', health.finalizedBlock),
        '# HELP trustrfq_indexer_healthy Whether the indexer has a polling error.',
        '# TYPE trustrfq_indexer_healthy gauge',
        metric('trustrfq_indexer_healthy', health.ok ? 1 : 0),
        '# HELP trustrfq_indexer_fresh Whether the indexer has completed a recent successful poll.',
        '# TYPE trustrfq_indexer_fresh gauge',
        metric('trustrfq_indexer_fresh', health.freshness === 'fresh' ? 1 : 0),
        '',
      ].join('\n'));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(port, '0.0.0.0');
  const shutdown = async () => { server.close(); await runtime.stop(); process.exit(0); };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

if (process.argv[1]?.endsWith('/services/indexer/src/worker.ts')) void main();
