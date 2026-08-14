import { performance } from 'node:perf_hooks';

/** Measure only the awaited operation with a monotonic clock. */
export async function measureAsyncOperation(operation, now = () => performance.now()) {
  const startedAt = now();
  const value = await operation();
  const finishedAt = now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    throw new Error('ELAPSED_CLOCK_INVALID');
  }
  return { value, elapsedMs: finishedAt - startedAt };
}
