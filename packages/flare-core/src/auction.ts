export const AUCTION_DURATIONS = ['24h', '1w', '1m', '3m'] as const;
export type AuctionDuration = (typeof AUCTION_DURATIONS)[number];

const DURATION_SECONDS: Record<AuctionDuration, number> = {
  '24h': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '1m': 30 * 24 * 60 * 60,
  '3m': 90 * 24 * 60 * 60,
};

export function auctionDeadline(duration: AuctionDuration | string, openedAt: number): number {
  if (!(duration in DURATION_SECONDS) || !Number.isInteger(openedAt) || openedAt < 0) {
    throw new Error('AUCTION_DURATION');
  }
  return openedAt + DURATION_SECONDS[duration as AuctionDuration];
}
