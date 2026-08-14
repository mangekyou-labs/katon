import { assertCanonicalPublicEvent } from '../../../packages/flare-core/src/events';

export interface FlareEvent {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly kind: string;
  readonly commitment: string;
  readonly [field: string]: unknown;
}

export interface IndexCursor {
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly blockHash?: string;
}

export class EventProjector {
  private readonly projected = new Map<string, FlareEvent>();
  private latestCursor: IndexCursor = { blockNumber: 0, logIndex: -1 };
  private latestFinalizedBlock = 0;

  apply(events: readonly FlareEvent[]): void {
    for (const event of events) {
      assertPublicEvent(event);
      const key = `${event.txHash}:${event.logIndex}`;
      const previous = this.projected.get(key);
      if (previous) {
        if (stableJson(previous) !== stableJson(event)) throw new Error('EVENT_CONFLICT');
        continue;
      }
      this.projected.set(key, event);
      if (
        event.blockNumber > this.latestCursor.blockNumber ||
        (event.blockNumber === this.latestCursor.blockNumber && event.logIndex > this.latestCursor.logIndex)
      ) {
        this.latestCursor = { blockNumber: event.blockNumber, logIndex: event.logIndex, ...(typeof event.blockHash === 'string' ? { blockHash: event.blockHash } : {}) };
      }
    }
  }

  markFinalized(blockNumber: number): void {
    if (!Number.isInteger(blockNumber) || blockNumber < this.latestFinalizedBlock) {
      throw new Error('FINALITY_REGRESSION');
    }
    this.latestFinalizedBlock = blockNumber;
  }

  rollbackFrom(blockNumber: number): void {
    if (!Number.isInteger(blockNumber) || blockNumber < 0) throw new Error('REORG_BLOCK_INVALID');
    if (blockNumber <= this.latestFinalizedBlock) throw new Error('REORG_FINALIZED');
    for (const [key, event] of this.projected) {
      if (event.blockNumber >= blockNumber) this.projected.delete(key);
    }
    this.latestCursor = { blockNumber: 0, logIndex: -1 };
    for (const event of this.projected.values()) {
      if (event.blockNumber > this.latestCursor.blockNumber || (event.blockNumber === this.latestCursor.blockNumber && event.logIndex > this.latestCursor.logIndex)) {
        this.latestCursor = { blockNumber: event.blockNumber, logIndex: event.logIndex, ...(typeof event.blockHash === 'string' ? { blockHash: event.blockHash } : {}) };
      }
    }
  }

  finalizedBlock(): number {
    return this.latestFinalizedBlock;
  }

  events(options: { readonly finalizedOnly?: boolean } = {}): FlareEvent[] {
    return [...this.projected.values()]
      .filter((event) => !options.finalizedOnly || event.blockNumber <= this.latestFinalizedBlock)
      .sort(
      (left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex,
      );
  }

  rebuild(events: readonly FlareEvent[], finalizedBlock = 0): void {
    this.projected.clear();
    this.latestCursor = { blockNumber: 0, logIndex: -1 };
    this.latestFinalizedBlock = 0;
    this.apply(events);
    this.markFinalized(finalizedBlock);
  }

  cursor(): IndexCursor {
    return this.latestCursor;
  }
}

const PRIVATE_EVENT_FIELDS = new Set([
  'ciphertext',
  'plaintext',
  'signature',
  'proofBytes',
  'privateKey',
  'bidPayload',
]);

function assertPublicEvent(event: FlareEvent): void {
  assertCanonicalPublicEvent(event as unknown as Record<string, unknown>);
  if (!event.kind || !event.txHash || !event.commitment) throw new Error('EVENT_INVALID');
  for (const field of Object.keys(event)) {
    if (PRIVATE_EVENT_FIELDS.has(field)) throw new Error('EVENT_PRIVATE_FIELD');
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
