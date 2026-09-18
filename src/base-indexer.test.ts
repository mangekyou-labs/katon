import { describe, expect, it } from 'vitest';
import {
  BASE_B20_ABI_COMMIT,
  BASE_INDEXER_EVENT_ABI,
} from '../packages/base-contracts/src/index';
import {
  BaseIndexerWorker,
  BaseProjector,
  InMemoryBaseCursorStore,
  type BaseChainEvent,
} from '../services/indexer/src/base';

const TOKEN = '0x0000000000000000000000000000000000000020';
const ROUTER = '0x0000000000000000000000000000000000000030';
const RFQ = `0x${'11'.repeat(32)}`;
const TX = `0x${'aa'.repeat(32)}`;

function event(overrides: Partial<BaseChainEvent> = {}): BaseChainEvent {
  return {
    chainId: 84532,
    txHash: TX,
    logIndex: 0,
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    address: ROUTER,
    eventName: 'RouteFilled',
    args: {
      rfqId: RFQ,
      winner: '0x0000000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000001',
      adapter: '0x0000000000000000000000000000000000000050',
      repayAssets: 100n,
      collateralSeized: 110n,
      fee: 0n,
    },
    ...overrides,
  };
}

describe('T3.6 isolated Base indexer', () => {
  it('exports the pinned official B20 ABI and the settlement/router/facility ABIs', () => {
    expect(BASE_B20_ABI_COMMIT).toBe('be6d0450890e20fc4a739aeaff5e839f234d12a6');
    const names = BASE_INDEXER_EVENT_ABI.flatMap((item) => 'name' in item && item.name ? [item.name] : []);
    expect(names).toEqual(expect.arrayContaining([
      'RouteFilled', 'Fill', 'Cancel', 'SignerUpdated', 'FacilityRegistered', 'Paused',
      'Unpaused', 'Announcement', 'EndAnnouncement', 'UIMultiplierUpdated', 'MultiplierUpdated',
    ]));
  });

  it('projects route, facility, and canonical B20 status idempotently by chain/log identity', () => {
    const projector = new BaseProjector();
    projector.apply([
      event(),
      event({
        txHash: `0x${'cc'.repeat(32)}`,
        logIndex: 1,
        address: TOKEN,
        eventName: 'Announcement',
        args: { caller: '0x0000000000000000000000000000000000000001', id: 'q1', description: 'pause', uri: 'ipfs://q1' },
      }),
      event({
        txHash: `0x${'dd'.repeat(32)}`,
        logIndex: 2,
        address: TOKEN,
        eventName: 'Paused',
        args: { updater: '0x0000000000000000000000000000000000000001', features: [0, 3] },
      }),
      event({
        txHash: `0x${'ee'.repeat(32)}`,
        logIndex: 3,
        address: TOKEN,
        eventName: 'MultiplierUpdated',
        args: { multiplier: 1_100_000_000_000_000_000n },
      }),
      event({
        txHash: `0x${'ee'.repeat(32)}`,
        logIndex: 4,
        address: TOKEN,
        eventName: 'UIMultiplierUpdated',
        args: { oldMultiplier: 1_000_000_000_000_000_000n, newMultiplier: 1_100_000_000_000_000_000n, effectiveAt: 200n },
      }),
    ]);
    projector.apply([event(), event()]);

    const snapshot = projector.snapshot();
    expect(snapshot.routeExecutions).toHaveLength(1);
    expect(snapshot.liquidations[RFQ]?.routeTxHash).toBe(TX);
    expect(snapshot.tokens[TOKEN]?.announcement?.id).toBe('q1');
    expect(snapshot.tokens[TOKEN]?.pausedFeatures).toEqual([0, 3]);
    expect(snapshot.tokens[TOKEN]?.multiplier?.source).toBe('canonical');
    expect(projector.events()).toHaveLength(5);
  });

  it('applies SignerUpdated authorization to matching order projections', () => {
    const projector = new BaseProjector();
    const orderHash = `0x${'12'.repeat(32)}`;
    const maker = '0x0000000000000000000000000000000000000041';
    const signer = '0x0000000000000000000000000000000000000042';
    projector.apply([
      event({
        address: '0x0000000000000000000000000000000000000040',
        eventName: 'Fill',
        args: { orderHash, maker, repayAssets: 100n },
      }),
      event({
        txHash: `0x${'13'.repeat(32)}`,
        logIndex: 1,
        address: '0x0000000000000000000000000000000000000040',
        eventName: 'SignerUpdated',
        args: { maker, signer, authorized: true },
      }),
    ]);

    expect(projector.snapshot().orders[orderHash]?.signerAuthorization[signer]).toBe(true);
  });

  it('projects queued withdrawals by request id and preserves FIFO claim status', () => {
    const projector = new BaseProjector();
    const facility = '0x0000000000000000000000000000000000000090';
    const owner = '0x0000000000000000000000000000000000000007';
    projector.apply([
      event({
        address: facility,
        eventName: 'WithdrawQueued',
        args: { owner, requestId: 7n, assets: 10n, shares: 10n },
      }),
      event({
        txHash: `0x${'14'.repeat(32)}`,
        logIndex: 1,
        address: facility,
        eventName: 'WithdrawQueued',
        args: { owner, requestId: 8n, assets: 20n, shares: 20n },
      }),
      event({
        txHash: `0x${'15'.repeat(32)}`,
        logIndex: 2,
        address: facility,
        eventName: 'WithdrawClaimed',
        args: { owner, requestId: 7n, assets: 10n },
      }),
    ]);
    const requests = projector.snapshot().facilities[facility].withdrawalRequests;
    expect(requests['7']).toMatchObject({ requestId: '7', status: 'claimed', assets: '10', claimedAssets: '10' });
    expect(requests['8']).toMatchObject({ requestId: '8', status: 'queued', assets: '20' });
  });

  it('advances each contract cursor only after a successful projection and restarts from it', async () => {
    const cursorStore = new InMemoryBaseCursorStore();
    const projector = new BaseProjector();
    let fail = true;
    const client = {
      async getBlockNumber() { return 105n; },
      async getLogs() {
        return [event({ address: ROUTER, blockNumber: 100n })];
      },
    };
    const worker = new BaseIndexerWorker({
      chainId: 84532,
      confirmations: 5n,
      contracts: [{ name: 'router', address: ROUTER, startBlock: 100n }],
      client,
      projector: {
        apply(events: readonly BaseChainEvent[]) {
          if (fail) { fail = false; throw new Error('projection failure'); }
          projector.apply(events);
        },
      },
      cursors: cursorStore,
    });
    await expect(worker.pollOnce()).rejects.toThrow('projection failure');
    expect(await cursorStore.get(84532, ROUTER)).toBeUndefined();
    await worker.pollOnce();
    expect(await cursorStore.get(84532, ROUTER)).toMatchObject({ blockNumber: 100n });
  });

  it('hydrates persisted events before applying a restarted poll batch', async () => {
    const cursorStore = new InMemoryBaseCursorStore();
    let hydrated = false;
    const client = {
      async getBlockNumber() { return 105n; },
      async getLogs() { return [event({ address: ROUTER, blockNumber: 100n })]; },
    };
    const worker = new BaseIndexerWorker({
      chainId: 84532,
      confirmations: 5n,
      contracts: [{ name: 'router', address: ROUTER, startBlock: 100n }],
      client,
      projector: {
        apply() {
          if (!hydrated) throw new Error('PROJECTOR_NOT_HYDRATED');
        },
      },
      cursors: cursorStore,
      projectionStore: {
        async hydrate() { hydrated = true; },
        async persist() {},
      },
    });

    await expect(worker.pollOnce()).resolves.toBeUndefined();
    expect(hydrated).toBe(true);
  });
});
