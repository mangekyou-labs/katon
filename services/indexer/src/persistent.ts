import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { EventProjector, type FlareEvent, type IndexCursor } from './projector';

interface IndexerSnapshot {
  readonly events: readonly FlareEvent[];
  readonly finalizedBlock: number;
}

/** File-backed checkpoint boundary for local/dev deployments.
 * Production can replace this store with Mongo/Redis without changing the
 * projector's replay, finality, or privacy rules.
 */
export class PersistentEventProjector {
  private readonly projector = new EventProjector();

  constructor(private readonly filePath: string) {
    if (!filePath) throw new Error('INDEXER_STORE_PATH');
    if (!existsSync(filePath)) return;
    try {
      const snapshot = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<IndexerSnapshot>;
      const finalizedBlock = snapshot.finalizedBlock;
      if (!Array.isArray(snapshot.events) || typeof finalizedBlock !== 'number' || !Number.isInteger(finalizedBlock) || finalizedBlock < 0) {
        throw new Error('INDEXER_STORE_INVALID');
      }
      this.projector.rebuild(snapshot.events, finalizedBlock);
    } catch (error) {
      if (error instanceof Error && error.message === 'INDEXER_STORE_INVALID') throw error;
      throw new Error('INDEXER_STORE_INVALID');
    }
  }

  apply(events: readonly FlareEvent[]): void {
    this.projector.apply(events);
    this.persist();
  }

  markFinalized(blockNumber: number): void {
    this.projector.markFinalized(blockNumber);
    this.persist();
  }

  rollbackFrom(blockNumber: number): void {
    this.projector.rollbackFrom(blockNumber);
    this.persist();
  }

  rebuild(events: readonly FlareEvent[], finalizedBlock = 0): void {
    this.projector.rebuild(events, finalizedBlock);
    this.persist();
  }

  events(options: { readonly finalizedOnly?: boolean } = {}): FlareEvent[] {
    return this.projector.events(options);
  }

  cursor(): IndexCursor {
    return this.projector.cursor();
  }

  finalizedBlock(): number {
    return this.projector.finalizedBlock();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ events: this.projector.events(), finalizedBlock: this.projector.finalizedBlock() }, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
