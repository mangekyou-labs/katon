import type { KeeperJob, KeeperJobKind, KeeperJobSource } from './scheduler';

export interface KeeperFetcher {
  (input: string, init?: RequestInit): Promise<Response>;
}

export class HttpKeeperJobSource implements KeeperJobSource {
  private readonly fetcher: KeeperFetcher;

  constructor(
    private readonly kind: KeeperJobKind,
    private readonly dueUrl: string,
    private readonly runUrl: string,
    fetcher?: KeeperFetcher,
  ) {
    if (!dueUrl.trim() || !runUrl.trim()) throw new Error(`KEEPER_ENDPOINT:${kind}`);
    this.fetcher = fetcher ?? fetch;
  }

  async due(now: number): Promise<readonly KeeperJob[]> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('KEEPER_NOW');
    const response = await this.fetcher(`${this.dueUrl}${this.dueUrl.includes('?') ? '&' : '?'}now=${now}`, { method: 'GET' });
    const payload = await readJson(response, `KEEPER_DUE_HTTP:${this.kind}`);
    if (!isRecord(payload) || !Array.isArray(payload.jobs)) throw new Error(`KEEPER_DUE_SCHEMA:${this.kind}`);
    return payload.jobs.map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.key !== 'string' || !candidate.key.trim() || typeof candidate.dueAt !== 'number' || !Number.isFinite(candidate.dueAt)) {
        throw new Error(`KEEPER_DUE_SCHEMA:${this.kind}`);
      }
      return {
        kind: this.kind,
        key: candidate.key,
        dueAt: candidate.dueAt,
        run: async () => {
          const result = await this.fetcher(this.runUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': `${this.kind}:${candidate.key}` },
            body: JSON.stringify({ kind: this.kind, key: candidate.key }),
          });
          const resultPayload = await readJson(result, `KEEPER_RUN_HTTP:${this.kind}`);
          if (!isRecord(resultPayload) || resultPayload.success !== true) throw new Error(`KEEPER_RUN_REJECTED:${this.kind}`);
        },
      } satisfies KeeperJob;
    });
  }
}

async function readJson(response: Response, code: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${code}:${response.status}`);
  try { return await response.json(); } catch { throw new Error(`${code}:JSON`); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
