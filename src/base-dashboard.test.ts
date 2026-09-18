import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import {
  InMemoryDashboardReadPort,
  UnavailableDashboardReadPort,
  ViemDashboardReadPort,
  type BaseFacilityDashboard,
} from '../apps/base-api/src/app';

const FACILITY = '0x0000000000000000000000000000000000000100' as Address;
const TOKEN = '0x0000000000000000000000000000000000000020' as Address;

const snapshot: BaseFacilityDashboard = {
  address: FACILITY,
  roles: { admin: FACILITY, curator: FACILITY, guardian: FACILITY, executor: FACILITY },
  registered: true,
  paused: false,
  quotePaused: false,
  asset: '0x0000000000000000000000000000000000000010',
  nav: '100000000',
  idleAssets: '50000000',
  shares: '100000000',
  haircutWad: '950000000000000000',
  quoteUsdcCapacity: '47500000',
  queue: { totalAssets: '0', totalShares: '0', requests: [] },
  adapterAllocations: {},
  b20Inventory: {},
  pinnedBlock: '42',
};

describe('M5 public dashboard read port', () => {
  it('provides deterministic in-memory and stable unavailable implementations', async () => {
    const memory = new InMemoryDashboardReadPort({ facilities: [snapshot] });
    expect(await memory.getFacilities()).toEqual([snapshot]);
    expect(await memory.getFacility(FACILITY)).toEqual(snapshot);
    await expect(new UnavailableDashboardReadPort().getFacilities()).rejects.toThrow('DASHBOARD_UNAVAILABLE');
  });

  it('pins all live viem reads to one block and composes indexed queue history', async () => {
    const calls: Array<{ functionName: string; blockNumber?: bigint }> = [];
    const client = {
      getBlockNumber: vi.fn(async () => 42n),
      readContract: vi.fn(async (input: { functionName: string; blockNumber?: bigint }) => {
        calls.push(input);
        const values: Record<string, unknown> = {
          asset: '0x0000000000000000000000000000000000000010',
          admin: FACILITY,
          curator: FACILITY,
          guardian: FACILITY,
          executor: FACILITY,
          registered: true,
          paused: false,
          quotePaused: false,
          totalAssets: 100000000n,
          idleAssets: 50000000n,
          totalSupply: 100000000n,
          haircutWad: 950000000000000000n,
          quoteUsdcCapacity: 47500000n,
        };
        return values[input.functionName];
      }),
    };
    const port = new ViemDashboardReadPort(client as never, {
      facilityAddresses: [FACILITY],
      indexed: {
        facility: {
          facility: FACILITY,
          registered: true,
          paused: false,
          revoked: false,
          deposits: '100000000',
          withdrawals: '0',
          queuedWithdrawals: '0',
          claimedWithdrawals: '0',
          allocatedByAdapter: {},
          inventoryByToken: {},
          withdrawalRequests: {
            '7': { requestId: '7', owner: FACILITY, assets: '10', shares: '10', status: 'queued' },
          },
        },
      },
    });
    const result = await port.getFacility(FACILITY);
    expect(result.queue.requests[0]).toMatchObject({ requestId: '7', status: 'queued' });
    expect(result.pinnedBlock).toBe('42');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.blockNumber === 42n)).toBe(true);
  });

  it('does not surface unrelated private route data in public read models', async () => {
    const memory = new InMemoryDashboardReadPort({ facilities: [snapshot], oracles: [] });
    await expect(memory.getOracle(TOKEN)).rejects.toThrow('ORACLE_UNAVAILABLE');
  });
});
