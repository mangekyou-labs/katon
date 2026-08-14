import { IdempotentKeeper } from './worker';

export type KeeperJobKind =
  | 'auction-expiry'
  | 'liquidation-detection'
  | 'fdc-progression'
  | 'redemption-settlement'
  | 'withdrawal-queue';

export interface KeeperJob {
  readonly kind: KeeperJobKind;
  readonly key: string;
  readonly dueAt: number;
  readonly run: () => Promise<unknown>;
}

export interface KeeperLease {
  acquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface KeeperJobSource {
  due(now: number): Promise<readonly KeeperJob[]>;
}

export interface KeeperJobCounters {
  readonly attempted: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface KeeperReadiness {
  readonly ready: boolean;
  readonly requireAll: boolean;
  readonly configuredKinds: readonly KeeperJobKind[];
  readonly missingKinds: readonly KeeperJobKind[];
}

export function validateKeeperJobSourceConfig(
  config: Readonly<Record<string, string | undefined>>,
  requireAll: boolean,
): readonly KeeperJobKind[] {
  const configured: KeeperJobKind[] = [];
  for (const kind of ['auction-expiry', 'liquidation-detection', 'fdc-progression', 'redemption-settlement', 'withdrawal-queue'] as KeeperJobKind[]) {
    const prefix = `FLARE_KEEPER_${kind.toUpperCase().replaceAll('-', '_')}`;
    const dueUrl = config[`${prefix}_DUE_URL`]?.trim();
    const runUrl = config[`${prefix}_RUN_URL`]?.trim();
    if (dueUrl && runUrl) configured.push(kind);
    else if (requireAll) throw new Error(`KEEPER_JOB_SOURCE_MISSING:${kind}`);
  }
  return configured;
}

export function keeperReadiness(
  config: Readonly<Record<string, string | undefined>>,
  requireAll: boolean,
): KeeperReadiness {
  const kinds = ['auction-expiry', 'liquidation-detection', 'fdc-progression', 'redemption-settlement', 'withdrawal-queue'] as KeeperJobKind[];
  const configuredKinds = validateKeeperJobSourceConfig(config, false);
  const configured = new Set(configuredKinds);
  const missingKinds = kinds.filter((kind) => !configured.has(kind));
  return { ready: !requireAll || missingKinds.length === 0, requireAll, configuredKinds, missingKinds };
}

export class KeeperJobScheduler {
  private readonly keeper = new IdempotentKeeper();
  private readonly sources = new Map<KeeperJobKind, KeeperJobSource>();
  private attempted = 0;
  private succeeded = 0;
  private skipped = 0;
  private failed = 0;

  constructor(private readonly lease: KeeperLease, private readonly now: () => number = Date.now) {}

  register(kind: KeeperJobKind, source: KeeperJobSource): void {
    if (this.sources.has(kind)) throw new Error(`KEEPER_SOURCE_DUPLICATE:${kind}`);
    this.sources.set(kind, source);
  }

  async runDue(): Promise<readonly { readonly kind: KeeperJobKind; readonly key: string; readonly status: 'succeeded' | 'skipped' | 'failed'; readonly error?: string }[]> {
    const now = this.now();
    const jobs = (await Promise.all([...this.sources.entries()].map(async ([kind, source]) =>
      (await source.due(now)).map((job) => ({ ...job, kind }))))).flat();
    return Promise.all(jobs.map((job) => this.runOne(job)));
  }

  counters(): KeeperJobCounters {
    return { attempted: this.attempted, succeeded: this.succeeded, skipped: this.skipped, failed: this.failed };
  }

  private async runOne(job: KeeperJob): Promise<{ readonly kind: KeeperJobKind; readonly key: string; readonly status: 'succeeded' | 'skipped' | 'failed'; readonly error?: string }> {
    if (!job.key.trim() || !Number.isFinite(job.dueAt)) throw new Error('KEEPER_JOB_INVALID');
    if (job.dueAt > this.now()) {
      this.skipped += 1;
      return { kind: job.kind, key: job.key, status: 'skipped' };
    }
    this.attempted += 1;
    try {
      await this.keeper.runWithLease(`${job.kind}:${job.key}`, this.lease, job.run);
      this.succeeded += 1;
      return { kind: job.kind, key: job.key, status: 'succeeded' };
    } catch (error) {
      this.failed += 1;
      return { kind: job.kind, key: job.key, status: 'failed', error: error instanceof Error ? error.message : 'KEEPER_JOB_FAILED' };
    }
  }
}
