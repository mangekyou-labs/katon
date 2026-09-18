import { createPublicClient, http, parseEventLogs, type Address, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { BASE_INDEXER_EVENT_ABI } from '../../../../packages/base-contracts/src/index';
import { BaseProjector } from './projector';
import { eventKey } from './projector';
import type { BaseChainEvent, BaseCursor, BaseCursorStore, BaseEventProjector } from './types';

export interface BaseIndexerContract {
  readonly name: string;
  readonly address: Address | string;
  readonly startBlock: bigint;
}

export interface BaseReadonlyChainClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args?: { readonly address: Address; readonly fromBlock: bigint; readonly toBlock: bigint }): Promise<readonly BaseChainEvent[] | readonly Record<string, unknown>[]>;
}

export interface BaseProjectionStore {
  hydrate?(projector: BaseEventProjector): Promise<void>;
  persist(events: readonly BaseChainEvent[], projector: BaseEventProjector): Promise<void>;
}

export interface BaseIndexerWorkerOptions {
  readonly chainId: number;
  readonly confirmations: bigint;
  readonly contracts: readonly BaseIndexerContract[];
  readonly client: BaseReadonlyChainClient;
  readonly projector: BaseEventProjector;
  readonly cursors: BaseCursorStore;
  readonly projectionStore?: BaseProjectionStore;
}

export class BaseIndexerWorker {
  private readonly options: BaseIndexerWorkerOptions;

  constructor(options: BaseIndexerWorkerOptions) {
    if (options.confirmations < 0n) throw new Error('FINALITY_INVALID');
    this.options = options;
  }

  async pollOnce(): Promise<void> {
    if (this.options.projectionStore?.hydrate) {
      await this.options.projectionStore.hydrate(this.options.projector);
    }
    const latestBlock = await this.options.client.getBlockNumber();
    const finalizedBlock = latestBlock > this.options.confirmations ? latestBlock - this.options.confirmations : 0n;
    for (const contract of this.options.contracts) {
      const address = contract.address.toLowerCase();
      const previous = await this.options.cursors.get(this.options.chainId, address);
      const fromBlock = previous ? previous.blockNumber : contract.startBlock;
      if (fromBlock > finalizedBlock) continue;
      const rawLogs = await this.options.client.getLogs({
        address: contract.address as Address,
        fromBlock,
        toBlock: finalizedBlock,
      });
      const events = normalizeLogs(rawLogs, this.options.chainId, contract.address);
      if (events.length > 0) await this.options.projector.apply(events);
      if (this.options.projectionStore) await this.options.projectionStore.persist(events, this.options.projector);
      const cursor = cursorAfter(events, this.options.chainId, address, finalizedBlock);
      await this.options.cursors.set(cursor);
    }
  }
}

export function createBaseReadOnlyClient(chainId: number, rpcUrl: string): PublicClient {
  const chain = chainId === 8453 ? base : baseSepolia;
  return createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as PublicClient;
}

function normalizeLogs(
  logs: readonly BaseChainEvent[] | readonly Record<string, unknown>[],
  chainId: number,
  address: string,
): BaseChainEvent[] {
  return logs.flatMap((log) => {
    const record = log as Record<string, unknown>;
    if (typeof record.eventName === 'string' && record.args && typeof record.args === 'object' && typeof record.blockNumber === 'bigint') {
      return [{
        chainId,
        txHash: String(record.transactionHash ?? record.txHash),
        logIndex: Number(record.logIndex),
        blockNumber: record.blockNumber,
        ...(typeof record.blockHash === 'string' ? { blockHash: record.blockHash } : {}),
        address: String(record.address ?? address),
        eventName: record.eventName,
        args: record.args as Record<string, unknown>,
      }];
    }
    try {
      const parsed = parseEventLogs({ abi: BASE_INDEXER_EVENT_ABI, logs: [log] as never[] });
      return parsed.map((entry) => ({
        chainId,
        txHash: String((log as Record<string, unknown>).transactionHash),
        logIndex: Number((log as Record<string, unknown>).logIndex),
        blockNumber: BigInt(String((log as Record<string, unknown>).blockNumber ?? 0)),
        ...(typeof (log as Record<string, unknown>).blockHash === 'string' ? { blockHash: String((log as Record<string, unknown>).blockHash) } : {}),
        address: String((log as Record<string, unknown>).address ?? address),
        eventName: entry.eventName,
        args: entry.args as Record<string, unknown>,
      }));
    } catch {
      return [];
    }
  });
}

function cursorAfter(
  events: readonly BaseChainEvent[],
  chainId: number,
  address: string,
  finalizedBlock: bigint,
): BaseCursor {
  const relevant = events.filter((event) => event.address.toLowerCase() === address).sort((left, right) => Number(left.blockNumber - right.blockNumber) || left.logIndex - right.logIndex);
  const last = relevant[relevant.length - 1];
  if (!last) return { chainId, address, blockNumber: finalizedBlock, logIndex: -1 };
  return {
    chainId,
    address,
    blockNumber: last.blockNumber,
    logIndex: last.logIndex,
    ...(last.blockHash ? { blockHash: String(last.blockHash) } : {}),
  };
}

export class InMemoryBaseCursorStore implements BaseCursorStore {
  private readonly values = new Map<string, BaseCursor>();

  get(chainId: number, address: string): Promise<BaseCursor | undefined> {
    return Promise.resolve(this.values.get(`${chainId}:${address.toLowerCase()}`));
  }

  set(cursor: BaseCursor): Promise<void> {
    this.values.set(`${cursor.chainId}:${cursor.address.toLowerCase()}`, cursor);
    return Promise.resolve();
  }
}

export { BaseProjector, eventKey };
