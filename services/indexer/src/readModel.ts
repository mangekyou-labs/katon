import type { ActivityRow, FacilityReadModel, FlareReadModel, OpportunityRow } from '../../../packages/flare-sdk/src/api';

import type { FlareEvent } from './projector';

export function projectEventsToReadModel(events: readonly FlareEvent[], now = Date.now()): FlareReadModel {
  const activity: ActivityRow[] = [];
  const opportunities: OpportunityRow[] = [];
  let shares = '0';
  let nav = '0';
  let queuedWithdrawals = 0;

  for (const event of events) {
    if (event.kind === 'OrderFilled') {
      activity.push({
        id: field(event, 'orderHash', event.commitment),
        asset: 'filled',
        amount: field(event, 'sellAmount', '0'),
        state: 'Order filled',
        transaction: event.txHash,
      });
    } else if (event.kind === 'SwapRouteExecuted') {
      const sellToken = field(event, 'sellToken', 'unknown');
      const buyToken = field(event, 'buyToken', 'unknown');
      activity.push({
        id: event.commitment,
        asset: sellToken,
        amount: field(event, 'inputAmount', '0'),
        state: 'Swap routed',
        transaction: event.txHash,
      });
      opportunities.push({
        id: event.commitment,
        kind: 'swap',
        pair: `${sellToken} / ${buyToken}`,
        status: 'executed',
        amount: field(event, 'netOutput', '0'),
        transaction: event.txHash,
      });
    } else if (event.kind === 'LiquidationRouteExecuted') {
      const venue = field(event, 'venue');
      const market = field(event, 'market');
      activity.push({
        id: event.commitment,
        asset: market || 'market',
        amount: field(event, 'netCollateral', '0'),
        state: 'Liquidation routed',
        transaction: event.txHash,
      });
      opportunities.push({
        id: event.commitment,
        kind: 'liquidation',
        pair: `${venue || 'venue'} / ${market || 'market'}`,
        status: 'executed',
        amount: field(event, 'netCollateral', '0'),
        transaction: event.txHash,
        ...(venue ? { venue } : {}),
        ...(market ? { market } : {}),
      });
    } else if (event.kind === 'InventoryLotBooked') {
      nav = field(event, 'verifiedNav', nav);
    } else if (event.kind === 'Deposit') {
      shares = field(event, 'shares', shares);
    } else if (event.kind === 'WithdrawalRequested') {
      queuedWithdrawals += 1;
    } else if (event.kind === 'WithdrawalSettled' || event.kind === 'WithdrawalCancelled') {
      if (queuedWithdrawals > 0) queuedWithdrawals -= 1;
    }
  }

  const hasData = activity.length > 0 || opportunities.length > 0 || shares !== '0' || nav !== '0' || queuedWithdrawals > 0;
  return {
    state: hasData ? 'ready' : 'empty',
    updatedAt: now,
    auctions: [],
    standingBids: [],
    activity,
    facility: { shares, nav, queuedWithdrawals } satisfies FacilityReadModel,
    opportunities,
  };
}

export function emptyReadModel(now = Date.now()): FlareReadModel {
  return {
    state: 'empty',
    updatedAt: now,
    auctions: [],
    standingBids: [],
    activity: [],
    facility: { shares: '0', nav: '0', queuedWithdrawals: 0 },
    opportunities: [],
  };
}

function field(event: FlareEvent, name: string, fallback = ''): string {
  const value = event[name];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}
