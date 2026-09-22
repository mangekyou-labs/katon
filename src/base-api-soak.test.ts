import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  SOAK_LIMITS,
  calculateHeapMetrics,
  createSoakMetrics,
  formatSoakReport,
  parseSoakConfig,
  qualifySoak,
  recordProbe,
  redactUrl,
  stopManagedChild,
} from '../tools/base-api-soak-lib.mjs';

const MIB = 1024 * 1024;

describe('qualified Base API soak library', () => {
  it('parses duration, concurrency, endpoint, and redacted URL configuration', () => {
    const config = parseSoakConfig({
      BASE_API_URL: 'https://user:secret@example.test:8443/api?token=secret',
      BASE_API_PATH: '/v1/liquidations',
      BASE_API_SOAK_DURATION_SECONDS: '600',
      BASE_API_SOAK_CONCURRENCY: '4',
    });

    expect(config.durationSeconds).toBe(600);
    expect(config.concurrency).toBe(4);
    expect(config.requestIntervalMs).toBe(10);
    expect(config.url).toBe(
      'https://[REDACTED]:[REDACTED]@example.test:8443/api?token=secret',
    );
    expect(config.requestUrl).toBe(
      'https://[REDACTED]:[REDACTED]@example.test:8443/v1/liquidations',
    );
  });

  it('rejects malformed positive integer configuration', () => {
    expect(() =>
      parseSoakConfig({ BASE_API_SOAK_CONCURRENCY: '0' }),
    ).toThrow('BASE_API_SOAK_CONFIG');
    expect(() =>
      parseSoakConfig({ BASE_API_SOAK_DURATION_SECONDS: 'nope' }),
    ).toThrow('BASE_API_SOAK_CONFIG');
  });

  it('redacts URL credentials while preserving the endpoint', () => {
    expect(redactUrl('https://alice:s3cr3t@example.test/v1')).toBe(
      'https://[REDACTED]:[REDACTED]@example.test/v1',
    );
    expect(redactUrl('not a url')).toBe('[REDACTED_URL]');
  });

  it('counts request and schema failures separately', () => {
    const metrics = createSoakMetrics();

    recordProbe(metrics, { ok: true, schemaValid: true });
    recordProbe(metrics, { ok: false, schemaValid: false });
    recordProbe(metrics, { ok: true, schemaValid: false });

    expect(metrics.requests).toBe(3);
    expect(metrics.requestFailures).toBe(1);
    expect(metrics.schemaFailures).toBe(1);
    expect(metrics.failures).toBe(2);
  });

  it('calculates retained heap growth and ordinary-least-squares slope', () => {
    const result = calculateHeapMetrics([
      { elapsedMs: 0, heapUsedBytes: 10 * MIB },
      { elapsedMs: 30_000, heapUsedBytes: 10.5 * MIB },
      { elapsedMs: 60_000, heapUsedBytes: 11 * MIB },
    ]);

    expect(result.retainedGrowthBytes).toBe(1 * MIB);
    expect(result.heapSlopeBytesPerMinute).toBeCloseTo(1 * MIB, 5);
  });

  it('fails qualification for duration, concurrency, request/schema, and heap limits', () => {
    const base = {
      durationSeconds: 600,
      concurrency: 4,
      elapsedSeconds: 600,
      requests: 100,
      requestFailures: 0,
      schemaFailures: 0,
      retainedGrowthBytes: 0,
      heapSlopeBytesPerMinute: 0,
      managedChild: true,
      heapSamples: 2,
    };

    expect(qualifySoak(base).qualified).toBe(true);
    expect(
      qualifySoak({ ...base, durationSeconds: 30 }).qualified,
    ).toBe(false);
    expect(
      qualifySoak({ ...base, concurrency: 1 }).qualified,
    ).toBe(false);
    expect(
      qualifySoak({ ...base, requestFailures: 1 }).qualified,
    ).toBe(false);
    expect(
      qualifySoak({ ...base, schemaFailures: 1 }).qualified,
    ).toBe(false);
    expect(
      qualifySoak({
        ...base,
        retainedGrowthBytes: SOAK_LIMITS.maxRetainedGrowthBytes + 1,
      }).qualified,
    ).toBe(false);
    expect(
      qualifySoak({
        ...base,
        heapSlopeBytesPerMinute: SOAK_LIMITS.maxHeapSlopeBytesPerMinute + 1,
      }).qualified,
    ).toBe(false);
    expect(
      qualifySoak({ ...base, managedChild: false }).reasons,
    ).toContain('MANAGED_CHILD_REQUIRED');
  });

  it('marks externally hosted runs as diagnostics rather than qualified runs', () => {
    const config = parseSoakConfig({
      BASE_API_SOAK_EXTERNAL: 'true',
      BASE_API_URL: 'https://api.example.test',
    });

    expect(config.external).toBe(true);
    expect(
      qualifySoak({
        durationSeconds: 600,
        concurrency: 4,
        elapsedSeconds: 600,
        requests: 10,
        requestFailures: 0,
        schemaFailures: 0,
        retainedGrowthBytes: 0,
        heapSlopeBytesPerMinute: 0,
        managedChild: false,
        heapSamples: 0,
      }).qualified,
    ).toBe(false);
  });

  it('keeps a short smoke run diagnostic but never qualified', () => {
    const report = formatSoakReport({
      ...qualifySoak({
        durationSeconds: 2,
        concurrency: 4,
        elapsedSeconds: 2,
        requests: 8,
        requestFailures: 0,
        schemaFailures: 0,
        retainedGrowthBytes: 0,
        heapSlopeBytesPerMinute: 0,
      }),
      durationSeconds: 2,
      concurrency: 4,
      requests: 8,
      requestFailures: 0,
      schemaFailures: 0,
      elapsedSeconds: 2,
      retainedGrowthBytes: 0,
      heapSlopeBytesPerMinute: 0,
      url: 'https://[REDACTED]:[REDACTED]@example.test/v1/liquidations',
    });

    expect(report).toContain('base-api-soak=PASS');
    expect(report).toContain('qualified=false');
    expect(report).toContain('durationSeconds=2');
  });

  it('cleans up a managed child process', async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: (signal: NodeJS.Signals) => boolean;
    };
    child.exitCode = null;
    child.kill = (signal) => {
      expect(signal).toBe('SIGTERM');
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, signal));
      return true;
    };

    await stopManagedChild(child, { graceMs: 100 });

    expect(child.exitCode).toBe(0);
  });
});
