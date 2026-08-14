import { describe, expect, it } from 'vitest';

import { assertCanonicalPublicEvent, PUBLIC_EVENT_ABI, PUBLIC_EVENT_CATALOG } from '../packages/flare-core/src/events';

describe('Flare public event catalog', () => {
  it('covers every public event family emitted by the Flare contracts', () => {
    expect(PUBLIC_EVENT_CATALOG).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'SwapRouteExecuted' }),
      expect.objectContaining({ name: 'LiquidationRouteExecuted' }),
      expect.objectContaining({ name: 'OrderFilled' }),
      expect.objectContaining({ name: 'WithdrawalRequested' }),
      expect.objectContaining({ name: 'RedemptionSettled' }),
      expect.objectContaining({ name: 'InstructionDispatched' }),
      expect.objectContaining({ name: 'OperationExecuted' }),
    ]));
    expect(new Set(PUBLIC_EVENT_CATALOG.map((event) => event.name)).size).toBe(PUBLIC_EVENT_CATALOG.length);
  });

  it('keeps the decoder ABI synchronized with the canonical catalog', () => {
    expect(PUBLIC_EVENT_ABI).toHaveLength(PUBLIC_EVENT_CATALOG.length);
    expect(new Set(PUBLIC_EVENT_ABI.map((event) => event.name))).toEqual(new Set(PUBLIC_EVENT_CATALOG.map((event) => event.name)));
  });

  it('includes inventory lot lifecycle events in the public decoder ABI', () => {
    expect(PUBLIC_EVENT_CATALOG.find((event) => event.name === 'InventoryLotBooked')?.fields)
      .toEqual(['lotId', 'rwa', 'inventoryAmount', 'acquisitionCost', 'verifiedNav']);
    expect(PUBLIC_EVENT_ABI.some((event) => event.type === 'event' && event.name === 'InventoryLotNavUpdated')).toBe(true);
  });

  it('accepts known public fields and rejects unknown or private event data', () => {
    expect(() => assertCanonicalPublicEvent({
      txHash: '0xtx',
      logIndex: 0,
      blockNumber: 10,
      kind: 'SwapRouteExecuted',
      commitment: '0xcommitment',
      seller: '0xseller',
      recipient: '0xrecipient',
      inputAmount: '1',
      grossOutput: '2',
      netOutput: '2',
    })).not.toThrow();
    expect(() => assertCanonicalPublicEvent({
      txHash: '0xtx', logIndex: 0, blockNumber: 10, kind: 'NotAContractEvent', commitment: '0xc',
    })).toThrow('EVENT_KIND_UNKNOWN');
    expect(() => assertCanonicalPublicEvent({
      txHash: '0xtx', logIndex: 0, blockNumber: 10, kind: 'RouteExecuted', commitment: '0xc', ciphertext: 'secret',
    })).toThrow('EVENT_PRIVATE_FIELD');
    expect(() => assertCanonicalPublicEvent({
      txHash: '0xtx', logIndex: 0, blockNumber: 10, kind: 'RouteExecuted', commitment: '0xc', arbitrary: 'not-in-abi',
    })).toThrow('EVENT_FIELD_UNKNOWN');
  });
});
