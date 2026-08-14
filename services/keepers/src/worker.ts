export class IdempotentKeeper {
  private readonly jobs = new Map<string, Promise<unknown>>();

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) return existing as Promise<T>;
    const pending = Promise.resolve().then(action);
    const shared = pending.then(
      (value) => {
        this.jobs.set(key, Promise.resolve(value));
        return value;
      },
      (error: unknown) => {
        this.jobs.delete(key);
        throw error;
      },
    );
    this.jobs.set(key, shared);
    return shared;
  }

  runWithLease<T>(key: string, lease: { acquire(key: string): Promise<boolean>; release(key: string): Promise<void> }, action: () => Promise<T>): Promise<T> {
    return this.run(key, async () => {
      if (!(await lease.acquire(key))) throw new Error('KEEPER_LEASE_BUSY');
      try {
        return await action();
      } finally {
        await lease.release(key);
      }
    });
  }
}
