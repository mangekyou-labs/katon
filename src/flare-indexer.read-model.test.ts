import { describe, expect, it } from 'vitest';

import { EventProjector, type FlareEvent } from '../services/indexer/src/projector';
import { projectEventsToReadModel } from '../services/indexer/src/readModel';

describe('indexed event projector → read model', () => {
  it('maps filled, routed, liquidated, and booked public events into activity, opportunities, and facility', () => {
    const projector = new EventProjector();
    const events: FlareEvent[] = [
      {
        txHash: '0xfill',
        logIndex: 0,
        blockNumber: 10,
        kind: 'OrderFilled',
        commitment: '0xorder-1',
        orderHash: '0xorder-1',
        maker: '0xmaker',
        taker: '0xtaker',
        sellAmount: '4000000000000000000',
        buyAmount: '8000000000000000000000',
      },
      {
        txHash: '0xswap',
        logIndex: 1,
        blockNumber: 11,
        kind: 'SwapRouteExecuted',
        commitment: '0xswap-1',
        seller: '0xseller',
        recipient: '0xrecipient',
        sellToken: '0xrwa',
        buyToken: '0xusdx',
        inputAmount: '100000000000000000000',
        grossOutput: '1000000000000000000000',
        netOutput: '995000000000000000000',
      },
      {
        txHash: '0xliq',
        logIndex: 2,
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
      },
      {
        txHash: '0xlot',
        logIndex: 3,
        blockNumber: 13,
        kind: 'InventoryLotBooked',
        commitment: '0xlot-1',
        lotId: 'lot-1',
        rwa: '0xrwa',
        inventoryAmount: '5',
        acquisitionCost: '4800',
        verifiedNav: '1000',
      },
      {
        txHash: '0xdep',
        logIndex: 4,
        blockNumber: 14,
        kind: 'Deposit',
        commitment: '0xdep-1',
        caller: '0xdepositor',
        receiver: '0xdepositor',
        assets: '1000',
        shares: '10',
      },
      {
        txHash: '0xwd',
        logIndex: 5,
        blockNumber: 15,
        kind: 'WithdrawalRequested',
        commitment: '0xwd-1',
        requestId: 'wd-1',
        owner: '0xdepositor',
        receiver: '0xdepositor',
        shares: '2',
        minAssets: '190',
      },
    ];
    projector.apply(events);

    const model = projectEventsToReadModel(projector.events(), 1_700_000_000_000);

    expect(model.state).toBe('ready');
    expect(model.activity).toEqual([
      {
        id: '0xorder-1',
        asset: 'filled',
        amount: '4000000000000000000',
        state: 'Order filled',
        transaction: '0xfill',
      },
      {
        id: '0xswap-1',
        asset: '0xrwa',
        amount: '100000000000000000000',
        state: 'Swap routed',
        transaction: '0xswap',
      },
      {
        id: '0xliq-1',
        asset: '0xmarket',
        amount: '149',
        state: 'Liquidation routed',
        transaction: '0xliq',
      },
    ]);
    expect(model.opportunities).toEqual([
      {
        id: '0xswap-1',
        kind: 'swap',
        pair: '0xrwa / 0xusdx',
        status: 'executed',
        amount: '995000000000000000000',
        transaction: '0xswap',
      },
      {
        id: '0xliq-1',
        kind: 'liquidation',
        pair: '0xvenue / 0xmarket',
        status: 'executed',
        amount: '149',
        transaction: '0xliq',
        venue: '0xvenue',
        market: '0xmarket',
      },
    ]);
    expect(model.facility).toEqual({
      shares: '10',
      nav: '1000',
      queuedWithdrawals: 1,
    });
  });
});
