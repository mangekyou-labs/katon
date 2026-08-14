import { describe, expect, it } from 'vitest';

import { ConnectionLimiter, MutationRateLimiter } from '../apps/flare-api/src/limits';

describe('Flare API operational limits', () => {
  it('allows a bounded mutation burst and rejects the next request until the window rolls', () => {
    const limiter = new MutationRateLimiter({ windowMs: 1_000, maxRequests: 2 });
    expect(limiter.allow('wallet-a', 10_000)).toBe(true);
    expect(limiter.allow('wallet-a', 10_500)).toBe(true);
    expect(limiter.allow('wallet-a', 10_750)).toBe(false);
    expect(limiter.allow('wallet-a', 11_001)).toBe(true);
    expect(limiter.allow('wallet-b', 10_750)).toBe(true);
  });

  it('bounds active realtime connections per actor and releases them on close', () => {
    const limiter = new ConnectionLimiter(1);
    expect(limiter.acquire('lp-1')).toBe(true);
    expect(limiter.acquire('lp-1')).toBe(false);
    expect(limiter.acquire('lp-2')).toBe(true);
    limiter.release('lp-1');
    expect(limiter.acquire('lp-1')).toBe(true);
    expect(limiter.active('lp-1')).toBe(1);
  });

  it('does not underflow when a connection cleanup path runs twice', () => {
    const limiter = new ConnectionLimiter(1);
    expect(limiter.acquire('lp-1')).toBe(true);
    limiter.release('lp-1');
    limiter.release('lp-1');
    expect(limiter.active('lp-1')).toBe(0);
    expect(limiter.acquire('lp-1')).toBe(true);
  });
});
