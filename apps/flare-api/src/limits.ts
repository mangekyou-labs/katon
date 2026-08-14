export interface MutationRateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
}

export class MutationRateLimiter {
  private readonly windows = new Map<string, { readonly startedAt: number; count: number }>();

  constructor(private readonly config: MutationRateLimitConfig) {
    if (!Number.isInteger(config.windowMs) || config.windowMs <= 0 || !Number.isInteger(config.maxRequests) || config.maxRequests <= 0) throw new Error('RATE_LIMIT_CONFIG');
  }

  allow(actor: string, now: number): boolean {
    if (!actor || !Number.isFinite(now)) return false;
    const current = this.windows.get(actor);
    if (!current || now - current.startedAt >= this.config.windowMs) {
      this.windows.set(actor, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= this.config.maxRequests) return false;
    current.count += 1;
    return true;
  }
}

export class ConnectionLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxPerActor: number) {
    if (!Number.isInteger(maxPerActor) || maxPerActor <= 0) throw new Error('CONNECTION_LIMIT_CONFIG');
  }

  acquire(actor: string): boolean {
    if (!actor) return false;
    const count = this.counts.get(actor) ?? 0;
    if (count >= this.maxPerActor) return false;
    this.counts.set(actor, count + 1);
    return true;
  }

  release(actor: string): void {
    const count = this.counts.get(actor) ?? 0;
    if (count <= 1) this.counts.delete(actor);
    else this.counts.set(actor, count - 1);
  }

  active(actor: string): number {
    return this.counts.get(actor) ?? 0;
  }
}
