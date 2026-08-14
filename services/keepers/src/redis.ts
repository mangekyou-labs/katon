import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

export interface KeeperLeaseClient {
  connect(): Promise<unknown>;
  set(key: string, value: string, options: { readonly NX: true; readonly PX: number }): Promise<string | null>;
  eval(script: string, options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }): Promise<unknown>;
  quit(): Promise<unknown>;
}

export class RedisKeeperLease {
  private connected = false;
  private readonly owner = randomUUID();

  constructor(private readonly client: KeeperLeaseClient, private readonly prefix = 'trustrfq:keeper:lease:') {
    if (!prefix.trim()) throw new Error('KEEPER_LEASE_PREFIX');
  }

  static fromUrl(url: string, prefix?: string): RedisKeeperLease {
    if (!url.trim()) throw new Error('KEEPER_REDIS_URL');
    return new RedisKeeperLease(createClient({ url }) as unknown as KeeperLeaseClient, prefix);
  }

  async acquire(jobKey: string, ttlMs = 30_000): Promise<boolean> {
    if (!jobKey.trim()) throw new Error('KEEPER_JOB_KEY');
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) throw new Error('KEEPER_LEASE_TTL');
    await this.ensureConnected();
    return (await this.client.set(`${this.prefix}${jobKey}`, this.owner, { NX: true, PX: ttlMs })) === 'OK';
  }

  async ready(): Promise<void> { await this.ensureConnected(); }

  async release(jobKey: string): Promise<void> {
    if (!jobKey.trim()) throw new Error('KEEPER_JOB_KEY');
    await this.ensureConnected();
    await this.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", { keys: [`${this.prefix}${jobKey}`], arguments: [this.owner] });
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.quit();
    this.connected = false;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }
}
