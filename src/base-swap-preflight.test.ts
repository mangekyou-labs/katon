import { describe, expect, it } from 'vitest';
import type { Address, Hex, PublicClient } from 'viem';
import { ViemBaseSwapPreflightPort } from '../apps/base-api/src/adapters';
import type { BaseSwapInternalSimulationRequest } from '../apps/base-api/src/types';

const STOCK = '0x0000000000000000000000000000000000000101' as Address;
const TAKER = '0x0000000000000000000000000000000000000103' as Address;
const SETTLEMENT = '0x0000000000000000000000000000000000000202' as Address;
const ROUTER = '0x0000000000000000000000000000000000000201' as Address;
const DECISION_HASH = `0x${'11'.repeat(32)}` as Hex;
const SIMULATION_HASH = `0x${'22'.repeat(32)}` as Hex;
const DATA = '0x1234' as Hex;

function block(number: bigint, hash: Hex) {
  return { number, hash };
}

function request() {
  return {
    requestId: `0x${'aa'.repeat(32)}` as Hex,
    stockToken: STOCK,
    usdcToken: '0x0000000000000000000000000000000000000102' as Address,
    sellAmount: 100n,
    minBuyAmount: 1n,
    taker: TAKER,
    recipient: TAKER,
    deadline: 2_000n,
    now: 1_000n,
    auctionOpenedAtMs: 1_000,
    auctionCutoffAtMs: 2_000,
    feeBps: 5n,
    chainId: 84532,
    decisionBlock: 9n,
    decisionBlockHash: DECISION_HASH,
  };
}

function route() {
  return {
    kind: 'INTERNAL' as const,
    source: 'KATON' as const,
    routeId: `0x${'33'.repeat(32)}` as Hex,
    stockAmount: 100n,
    grossUsdc: 100n,
    guaranteedUsdc: 100n,
    fee: 0n,
    gasEstimateUsdc: 0n,
    effectiveUsdc: 100n,
    expiry: 2_000n,
    legs: [],
    decisionBlock: 9n,
    decisionBlockHash: DECISION_HASH,
  };
}

function input(overrides: Partial<BaseSwapInternalSimulationRequest> = {}): BaseSwapInternalSimulationRequest {
  return {
    request: request(),
    route: route(),
    snapshot: {
      decisionBlock: 9n,
      decisionBlockHash: DECISION_HASH,
      simulationBlock: 10n,
      simulationBlockHash: SIMULATION_HASH,
    },
    allowanceTarget: SETTLEMENT,
    transaction: { to: ROUTER, data: DATA, value: 0n },
    ...overrides,
  };
}

function fakeClient(options: {
  readonly allowance?: bigint;
  readonly callError?: Error;
  readonly latestAfter?: { readonly number: bigint; readonly hash: Hex };
  readonly missingLatestHash?: boolean;
}) {
  const blocks = [
    block(10n, SIMULATION_HASH),
    block(9n, DECISION_HASH),
    block(10n, SIMULATION_HASH),
  ];
  let blockIndex = 0;
  const calls: string[] = [];
  const client = {
    async getBlock(args: { readonly blockTag?: 'latest'; readonly blockNumber?: bigint }) {
      calls.push(args.blockTag === 'latest' ? 'latest' : `block:${args.blockNumber?.toString()}`);
      if (args.blockTag === 'latest' && blockIndex >= blocks.length) {
        return options.latestAfter ?? blocks[0];
      }
      const result = blocks[blockIndex] ?? blocks[0];
      blockIndex += 1;
      if (args.blockTag === 'latest' && options.missingLatestHash) return { ...result, hash: null };
      return result;
    },
    async readContract() {
      calls.push('allowance');
      return options.allowance ?? 100n;
    },
    async call() {
      calls.push('call');
      if (options.callError) throw options.callError;
      return { data: '0x' };
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe('authoritative Base swap preflight adapter', () => {
  it('captures N-1 and N with canonical hashes', async () => {
    const { client, calls } = fakeClient({});
    const port = new ViemBaseSwapPreflightPort(client, 3n);
    await expect(port.captureSnapshot()).resolves.toEqual({
      decisionBlock: 9n,
      decisionBlockHash: DECISION_HASH,
      simulationBlock: 10n,
      simulationBlockHash: SIMULATION_HASH,
    });
    expect(calls.slice(0, 3)).toEqual(['latest', 'block:9', 'block:10']);
  });

  it('rejects a missing canonical block hash', async () => {
    const { client } = fakeClient({ missingLatestHash: true });
    await expect(new ViemBaseSwapPreflightPort(client, 3n).captureSnapshot()).rejects.toThrow('PREFLIGHT_BLOCK_UNAVAILABLE');
  });

  it('simulates the serialized router call at N and requires exact allowance', async () => {
    const { client, calls } = fakeClient({ allowance: 100n });
    const port = new ViemBaseSwapPreflightPort(client, 3n, ROUTER, SETTLEMENT);
    await expect(port.simulateInternalRoute(input())).resolves.toMatchObject({
      decisionBlock: 9n,
      simulationBlock: 10n,
      allowanceTarget: SETTLEMENT,
    });
    expect(calls).toContain('allowance');
    expect(calls).toContain('call');
  });

  it('rejects both insufficient and excess stock allowance', async () => {
    const insufficient = fakeClient({ allowance: 99n });
    await expect(new ViemBaseSwapPreflightPort(insufficient.client, 3n, ROUTER, SETTLEMENT).simulateInternalRoute(input())).rejects.toThrow('PREFLIGHT_ALLOWANCE_FAILURE');
    const excess = fakeClient({ allowance: 101n });
    await expect(new ViemBaseSwapPreflightPort(excess.client, 3n, ROUTER, SETTLEMENT).simulateInternalRoute(input())).rejects.toThrow('PREFLIGHT_ALLOWANCE_FAILURE');
  });

  it('fails closed when the serialized router call reverts', async () => {
    const { client } = fakeClient({ callError: new Error('reverted') });
    await expect(new ViemBaseSwapPreflightPort(client, 3n, ROUTER, SETTLEMENT).simulateInternalRoute(input())).rejects.toThrow('PREFLIGHT_SIMULATION_FAILED');
  });
});
