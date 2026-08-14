import type { ActivityRow, AuctionRow, FacilityReadModel, FlareReadModel, OpportunityRow, RelayAuctionListRow, StandingBidRow } from '../../../packages/flare-sdk/src/api';

interface ReadModelSources {
  readonly auctions: readonly AuctionRow[];
  readonly standingBids: readonly StandingBidRow[];
  readonly activity: readonly ActivityRow[];
  readonly facility: FacilityReadModel;
  readonly indexed?: Pick<FlareReadModel, 'activity' | 'facility' | 'opportunities'>;
}

export function buildRoleScopedReadModel(wallet: string, relayAuctions: readonly RelayAuctionListRow[], sources: ReadModelSources): FlareReadModel {
  if (!wallet.trim()) return {
    state: 'empty', updatedAt: Date.now(), auctions: [], standingBids: [], activity: [],
    facility: { shares: '0', nav: '0', queuedWithdrawals: 0 },
    opportunities: [],
  };
  const prefix = wallet.slice(0, 8).toLowerCase();
  const auctions: readonly AuctionRow[] = [
    ...relayAuctions.map((row) => ({ id: row.id, pair: 'Encrypted RFQ' as const, status: row.status, bids: row.bidCount, expiry: row.expiresAt, commitment: row.commitment })),
    ...sources.auctions.filter((row) => row.id.slice(0, 8).toLowerCase() === prefix),
  ];
  const standingBids = sources.standingBids.filter((row) => row.id.slice(0, 8).toLowerCase() === prefix);
  const activity = [
    ...sources.activity.filter((row) => row.id.slice(0, 8).toLowerCase() === prefix),
    ...(sources.indexed?.activity ?? []),
  ];
  const opportunities: readonly OpportunityRow[] = sources.indexed?.opportunities ?? [];
  const facility = sources.indexed
    ? mergeFacility(sources.facility, sources.indexed.facility)
    : sources.facility;
  const hasData = auctions.length > 0 || standingBids.length > 0 || activity.length > 0 || opportunities.length > 0;
  return { state: hasData ? 'ready' : 'empty', updatedAt: Date.now(), auctions, standingBids, activity, facility, opportunities };
}

function mergeFacility(store: FacilityReadModel, indexed: FacilityReadModel): FacilityReadModel {
  return {
    shares: indexed.shares !== '0' ? indexed.shares : store.shares,
    nav: indexed.nav !== '0' ? indexed.nav : store.nav,
    queuedWithdrawals: indexed.queuedWithdrawals > 0 ? indexed.queuedWithdrawals : store.queuedWithdrawals,
  };
}
