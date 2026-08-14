import { describe, expect, it } from 'vitest';

import { auctionDeadline, AUCTION_DURATIONS } from '../packages/flare-core/src/auction';

describe('scheduled auction durations', () => {
  it('only exposes the four approved deterministic durations', () => {
    expect(AUCTION_DURATIONS).toEqual(['24h', '1w', '1m', '3m']);
    expect(auctionDeadline('24h', 1_000)).toBe(1_000 + 24 * 60 * 60);
    expect(auctionDeadline('1w', 1_000)).toBe(1_000 + 7 * 24 * 60 * 60);
    expect(auctionDeadline('1m', 1_000)).toBe(1_000 + 30 * 24 * 60 * 60);
    expect(auctionDeadline('3m', 1_000)).toBe(1_000 + 90 * 24 * 60 * 60);
  });

  it('does not accept an instant-auction duration', () => {
    expect(() => auctionDeadline('30s', 1_000)).toThrow('AUCTION_DURATION');
  });
});
