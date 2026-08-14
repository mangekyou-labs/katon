import { createServer } from 'node:http';

import { RedisKeeperLease } from './redis';
import { keeperReadiness, KeeperJobScheduler, validateKeeperJobSourceConfig, type KeeperJobKind } from './scheduler';
import { HttpKeeperJobSource } from './http-source';

const port = Number(process.env.FLARE_KEEPER_PORT ?? 8791);
const lease = RedisKeeperLease.fromUrl(process.env.FLARE_KEEPER_REDIS_URL ?? 'redis://127.0.0.1:6379', process.env.FLARE_KEEPER_LEASE_PREFIX);
await lease.ready();
let healthChecks = 0;
let runs = 0;
let succeeded = 0;
let failed = 0;
let skipped = 0;
const scheduler = new KeeperJobScheduler(lease);
const requireJobSources = process.env.FLARE_KEEPER_REQUIRE_JOB_SOURCES === 'true';
const configuredKinds = validateKeeperJobSourceConfig(process.env, requireJobSources);
const readiness = keeperReadiness(process.env, requireJobSources);
for (const kind of ['auction-expiry', 'liquidation-detection', 'fdc-progression', 'redemption-settlement', 'withdrawal-queue'] as KeeperJobKind[]) {
  const envPrefix = `FLARE_KEEPER_${kind.toUpperCase().replaceAll('-', '_')}`;
  const dueUrl = process.env[`${envPrefix}_DUE_URL`];
  const runUrl = process.env[`${envPrefix}_RUN_URL`];
  if (dueUrl && runUrl) {
    scheduler.register(kind, new HttpKeeperJobSource(kind, dueUrl, runUrl));
  } else {
    scheduler.register(kind, { async due() { return []; } });
  }
}
const pollMs = Math.max(1_000, Number(process.env.FLARE_KEEPER_POLL_MS ?? 5_000));
const poll = async () => {
  const results = await scheduler.runDue();
  runs += 1;
  for (const result of results) {
    if (result.status === 'succeeded') succeeded += 1;
    if (result.status === 'failed') failed += 1;
    if (result.status === 'skipped') skipped += 1;
  }
};
await poll();
const interval = setInterval(() => { void poll(); }, pollMs);

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    healthChecks += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: failed === 0, service: 'flare-keepers', leaseBackend: 'redis', custody: false, requireJobSources, configuredKinds, readiness, healthChecks, runs, succeeded, failed, skipped }));
    return;
  }
  if (request.method === 'GET' && request.url === '/readyz') {
    healthChecks += 1;
    const ok = failed === 0 && readiness.ready;
    response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok, service: 'flare-keepers', leaseBackend: 'redis', custody: false, requireJobSources, configuredKinds, readiness, healthChecks, runs, succeeded, failed, skipped }));
    return;
  }
  if (request.method === 'GET' && request.url === '/metrics') {
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    response.end([
      '# HELP trustrfq_keeper_healthy Whether the keeper lease backend is ready.',
      '# TYPE trustrfq_keeper_healthy gauge',
      'trustrfq_keeper_healthy 1',
      '# HELP trustrfq_keeper_health_checks_total Keeper health checks served.',
      '# TYPE trustrfq_keeper_health_checks_total counter',
      `trustrfq_keeper_health_checks_total ${healthChecks}`,
      '# HELP trustrfq_keeper_runs_total Scheduler polling cycles.',
      '# TYPE trustrfq_keeper_runs_total counter',
      `trustrfq_keeper_runs_total ${runs}`,
      '# HELP trustrfq_keeper_jobs_total Keeper job outcomes by status.',
      '# TYPE trustrfq_keeper_jobs_total counter',
      `trustrfq_keeper_jobs_total{status="succeeded"} ${succeeded}`,
      `trustrfq_keeper_jobs_total{status="failed"} ${failed}`,
      `trustrfq_keeper_jobs_total{status="skipped"} ${skipped}`,
      '',
    ].join('\n'));
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, '0.0.0.0');

const shutdown = async () => { clearInterval(interval); server.close(); await lease.close(); process.exit(0); };
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
