import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { BaseApiService } from '../apps/base-api/src/service';
import { defaultTestConfig, InMemoryBaseRepository, InMemoryChainSnapshotPort, InMemoryClock, InMemoryNotificationPort, InMemorySignatureVerificationPort } from '../apps/base-api/src/memory';
import type { BaseAuthContext, BaseSwapPreflightPort, BaseSwapQuotePort } from '../apps/base-api/src/types';
import type { SwapOrder } from '../packages/base-core/src/eip712';

const STOCK = '0x0000000000000000000000000000000000000101' as Address;
const USDC = '0x0000000000000000000000000000000000000102' as Address;
const TAKER = '0x0000000000000000000000000000000000000103' as Address;
const RECIPIENT = '0x0000000000000000000000000000000000000104' as Address;
const MAKER = '0x0000000000000000000000000000000000000105' as Address;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

const auth: BaseAuthContext = { kind: 'siwe', identity: TAKER, scopes: [] };

function makeService(source: BaseSwapQuotePort): { service: BaseApiService; clock: InMemoryClock } {
  const clock = new InMemoryClock(1_000n);
  const config = defaultTestConfig({ feeBps: 5n, routerAddress: '0x0000000000000000000000000000000000000201' as Address, settlementAddress: '0x0000000000000000000000000000000000000202' as Address });
  return {
    clock,
    service: new BaseApiService(config, new InMemoryBaseRepository(), new InMemoryChainSnapshotPort(), new InMemorySignatureVerificationPort(), clock, new InMemoryNotificationPort(), source),
  };
}

function makeServiceWithPreflight(source: BaseSwapQuotePort, swapPreflight: BaseSwapPreflightPort): { service: BaseApiService; clock: InMemoryClock } {
  const clock = new InMemoryClock(1_000n);
  const config = defaultTestConfig({ feeBps: 5n, routerAddress: '0x0000000000000000000000000000000000000201' as Address, settlementAddress: '0x0000000000000000000000000000000000000202' as Address });
  return {
    clock,
    service: new BaseApiService(config, new InMemoryBaseRepository(), new InMemoryChainSnapshotPort(), new InMemorySignatureVerificationPort(), clock, new InMemoryNotificationPort(), source, undefined, swapPreflight),
  };
}

describe('stock swap quote API seam', () => {
  it('fans out source quotes and returns a seller-private executable Katon route', async () => {
    const order: SwapOrder = {
      maker: MAKER,
      signer: MAKER,
      stockToken: STOCK,
      usdcToken: USDC,
      stockAmount: 100n,
      usdcAmount: 10_000n,
      fillMode: 1,
      expiry: 2_000n,
      salt: 1n,
      feeCapBps: 5,
      allowedTaker: TAKER,
      rfqId: ZERO_HASH,
    };
    const signature = `0x${'11'.repeat(65)}` as Hex;
    const { service } = makeService({
      collect: async (request) => ({
        makerQuotes: [{ source: 'LP', quoteId: `0x${'22'.repeat(32)}` as Hex, order, signature, receivedAtMs: request.auctionOpenedAtMs + 1, gasEstimateUsdc: 3n }],
        simulationBlock: 7n,
        simulationBlockHash: `0x${'33'.repeat(32)}` as Hex,
      }),
    });
    const result = await service.quoteSwap({ stockToken: STOCK, usdcToken: USDC, sellAmount: '100', minBuyAmount: '9900', taker: TAKER, recipient: RECIPIENT, deadline: '1900' }, auth);
    expect(result.status).toBe('WINNER');
    expect(result.recommended).toMatchObject({ source: 'KATON', allowanceTarget: expect.any(String) });
    expect((result.recommended as { transaction: { data: Hex } }).transaction.data).toMatch(/^0x[0-9a-f]+$/);
    expect(result.simulationBlock).toBe('7');
    expect(result.auctionCutoffAtMs - result.auctionOpenedAtMs).toBe(1000);
  });

  it('fails closed for mainnet retail eligibility and does not leak quotes', async () => {
    const source: BaseSwapQuotePort = { collect: async () => ({ externalQuotes: [] }) };
    const mainnet = new BaseApiService(defaultTestConfig({ chainId: 8453, mainnetEnabled: true }), new InMemoryBaseRepository(), new InMemoryChainSnapshotPort(), new InMemorySignatureVerificationPort(), new InMemoryClock(1_000n), new InMemoryNotificationPort(), source);
    await expect(mainnet.quoteSwap({ stockToken: STOCK, usdcToken: USDC, sellAmount: '1', minBuyAmount: '1', taker: TAKER, recipient: RECIPIENT, deadline: '1900' }, auth)).rejects.toThrow('ELIGIBILITY_REQUIRED');
  });

  it('keeps mainnet disabled when the deployment manifest is incomplete', async () => {
    const source: BaseSwapQuotePort = { collect: async () => ({ externalQuotes: [] }) };
    const mainnet = new BaseApiService(defaultTestConfig({ chainId: 8453, mainnetEnabled: true, deploymentConfigured: false }), new InMemoryBaseRepository(), new InMemoryChainSnapshotPort(), new InMemorySignatureVerificationPort(), new InMemoryClock(1_000n), new InMemoryNotificationPort(), source);
    await expect(mainnet.quoteSwap({ stockToken: STOCK, usdcToken: USDC, sellAmount: '1', minBuyAmount: '1', taker: TAKER, recipient: RECIPIENT, deadline: '1900' }, auth)).rejects.toThrow('MAINNET_DISABLED');
  });

  it('does not wait past the one-second auction cutoff for a hung source', async () => {
    vi.useFakeTimers();
    try {
      const { service } = makeService({ collect: async () => await new Promise<never>(() => undefined) });
      const quote = service.quoteSwap({ stockToken: STOCK, usdcToken: USDC, sellAmount: '100', minBuyAmount: '9900', taker: TAKER, recipient: RECIPIENT, deadline: '1900' }, auth);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(quote).resolves.toMatchObject({ status: 'NO_ROUTE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a failed internal route and recommends the best otherwise-valid external packet', async () => {
    const order: SwapOrder = {
      maker: MAKER,
      signer: MAKER,
      stockToken: STOCK,
      usdcToken: USDC,
      stockAmount: 100n,
      usdcAmount: 10_000n,
      fillMode: 1,
      expiry: 2_000n,
      salt: 1n,
      feeCapBps: 50,
      allowedTaker: TAKER,
      rfqId: ZERO_HASH,
    };
    const snapshot = {
      decisionBlock: 9n,
      decisionBlockHash: `0x${'44'.repeat(32)}` as Hex,
      simulationBlock: 10n,
      simulationBlockHash: `0x${'55'.repeat(32)}` as Hex,
    };
    const source: BaseSwapQuotePort = {
      collect: async (request) => ({
        makerQuotes: [{ source: 'LP', quoteId: `0x${'66'.repeat(32)}` as Hex, order, signature: `0x${'11'.repeat(65)}` as Hex, receivedAtMs: request.auctionOpenedAtMs + 1, gasEstimateUsdc: 0n }],
        externalQuotes: [{
          source: '0x',
          quoteId: `0x${'77'.repeat(32)}` as Hex,
          stockToken: STOCK,
          usdcToken: USDC,
          stockAmount: 100n,
          usdcAmount: 9_900n,
          guaranteedUsdc: 9_900n,
          gasEstimateUsdc: 0n,
          expiry: 2_000n,
          receivedAtMs: request.auctionOpenedAtMs + 1,
          transaction: {
            to: '0x0000000000000000000000000000000000000301' as Address,
            data: '0x1234' as Hex,
            value: 0n,
            allowanceTarget: '0x0000000000000000000000000000000000000302' as Address,
            chainId: 84532,
            recipient: RECIPIENT,
            stockToken: STOCK,
            usdcToken: USDC,
            sellAmount: 100n,
            minBuyAmount: 9_900n,
          },
        }],
      }),
    };
    const { service } = makeServiceWithPreflight(source, {
      captureSnapshot: async () => snapshot,
      simulateInternalRoute: async () => { throw new Error('PREFLIGHT_SIMULATION_FAILED'); },
    });
    const result = await service.quoteSwap({ stockToken: STOCK, usdcToken: USDC, sellAmount: '100', minBuyAmount: '9900', taker: TAKER, recipient: RECIPIENT, deadline: '1900' }, auth);
    expect(result.status).toBe('WINNER');
    expect(result.recommended).toMatchObject({ kind: 'EXTERNAL', source: '0x' });
    expect(result.decisionBlock).toBe('9');
    expect(result.simulationBlock).toBe('10');
    expect(result.alternatives).toHaveLength(0);
  });

  it('keeps the later liquidation route disabled when production config opts out', async () => {
    const clock = new InMemoryClock(1_000n);
    const service = new BaseApiService(
      defaultTestConfig({ liquidationEnabled: false }),
      new InMemoryBaseRepository(),
      new InMemoryChainSnapshotPort(),
      new InMemorySignatureVerificationPort(),
      clock,
      new InMemoryNotificationPort(),
    );
    await expect(service.listLiquidations()).rejects.toThrow('LIQUIDATION_DISABLED');
    await expect(service.tick()).resolves.toBeUndefined();
  });
});
