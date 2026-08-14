import { describe, expect, it } from 'vitest';

import { buildRoleScopedReadModel } from '../apps/flare-api/src/readModel';
import { EventProjector } from '../services/indexer/src/projector';
import { projectEventsToReadModel } from '../services/indexer/src/readModel';

describe('Flare role-scoped read model', () => {
  const sources = {
    auctions: [{ id: '0xabc123-private', pair: 'RWA / USDX', status: 'open' as const, bids: 0, expiry: 2_000 }],
    standingBids: [{ id: '0xabc123-bid', pair: 'RWA / USDX', capacity: '1', mode: 'instant' as const, expiry: 2_000, status: 'active' as const }],
    activity: [{ id: '0xabc123-activity', asset: 'RWA', amount: '1', state: 'Auction opened', transaction: '—' }],
    facility: { shares: '1', nav: '1000', queuedWithdrawals: 0 },
  };

  it('does not expose wallet-scoped rows before a wallet is connected', () => {
    expect(buildRoleScopedReadModel('', [], sources)).toMatchObject({
      state: 'empty', auctions: [], standingBids: [], activity: [],
      facility: { shares: '0', nav: '0', queuedWithdrawals: 0 },
    });
  });

  it('maps relay auctions to encrypted metadata and filters legacy rows by wallet prefix', () => {
    const model = buildRoleScopedReadModel('0xAbC123456789', [{ id: 'relay-1', commitment: '0xc', duration: '24h', status: 'open', openedAt: 1_000, expiresAt: 2_000, bidCount: 1, earlyCloseAllowed: false }], sources);
    expect(model.auctions).toEqual([
      { id: 'relay-1', pair: 'Encrypted RFQ', status: 'open', bids: 1, expiry: 2_000, commitment: '0xc' },
      sources.auctions[0],
    ]);
    expect(model.standingBids).toEqual(sources.standingBids);
    expect(model.activity).toEqual(sources.activity);
    expect(model.facility).toEqual(sources.facility);
    expect(model.opportunities).toEqual([]);
  });

  it('threads the relay auction commitment through the read model so bids can correlate without plaintext', () => {
    const model = buildRoleScopedReadModel('0xAbC123456789', [{ id: 'relay-1', commitment: '0xcommit-a', duration: '24h', status: 'open', openedAt: 1_000, expiresAt: 2_000, bidCount: 0, earlyCloseAllowed: false }], sources);
    expect(model.auctions[0]).toMatchObject({ id: 'relay-1', commitment: '0xcommit-a' });
    expect(sources.auctions[0]).not.toHaveProperty('commitment');
  });

  it('merges finalized indexer events into activity, opportunities, and facility', () => {
    const projector = new EventProjector();
    projector.apply([{
      txHash: '0xliq',
      logIndex: 0,
      blockNumber: 12,
      kind: 'LiquidationRouteExecuted',
      commitment: '0xliq-1',
      winner: '0xkeeper',
      recipient: '0xrecipient',
      venue: '0xvenue',
      market: '0xmarket',
      position: '0xposition',
      repaid: '100',
      netCollateral: '149',
    }, {
      txHash: '0xlot',
      logIndex: 1,
      blockNumber: 13,
      kind: 'InventoryLotBooked',
      commitment: '0xlot-1',
      lotId: 'lot-1',
      rwa: '0xrwa',
      inventoryAmount: '5',
      acquisitionCost: '4800',
      verifiedNav: '1000',
    }]);
    const indexed = projectEventsToReadModel(projector.events());
    const model = buildRoleScopedReadModel('0xAbC123456789', [], { ...sources, indexed });
    expect(model.opportunities).toEqual(indexed.opportunities);
    expect(model.activity).toEqual([...sources.activity, ...indexed.activity]);
    expect(model.facility).toMatchObject({ nav: '1000' });
    expect(model.state).toBe('ready');
  });
});
