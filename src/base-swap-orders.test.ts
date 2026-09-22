import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { BaseApiService } from '../apps/base-api/src/service';
import {
  defaultTestConfig,
  InMemoryBaseRepository,
  InMemoryChainSnapshotPort,
  InMemoryClock,
  InMemoryNotificationPort,
  InMemorySignatureVerificationPort,
} from '../apps/base-api/src/memory';
import type { BaseAuthContext } from '../apps/base-api/src/types';

const STOCK = '0x0000000000000000000000000000000000000101' as Address;
const USDC = '0x0000000000000000000000000000000000000102' as Address;
const TAKER = '0x0000000000000000000000000000000000000103' as Address;
const MAKER = '0x0000000000000000000000000000000000000105' as Address;
const SIGNER = '0x0000000000000000000000000000000000000106' as Address;
const OTHER = '0x0000000000000000000000000000000000000107' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;
const signature = `0x${'11'.repeat(65)}` as Hex;

const makerAuth: BaseAuthContext = { kind: 'bot', identity: MAKER, scopes: ['lp'] };
const takerAuth: BaseAuthContext = { kind: 'siwe', identity: TAKER, scopes: [] };

function order(overrides: Partial<{
  maker: Address;
  signer: Address;
  rfqId: Hex;
  allowedTaker: Address;
  salt: bigint;
  fillMode: number;
}> = {}) {
  return {
    maker: overrides.maker ?? MAKER,
    signer: overrides.signer ?? MAKER,
    stockToken: STOCK,
    usdcToken: USDC,
    stockAmount: 100n,
    usdcAmount: 10_000n,
    fillMode: overrides.fillMode ?? 1,
    expiry: 2_000n,
    salt: overrides.salt ?? 1n,
    feeCapBps: 50,
    allowedTaker: overrides.allowedTaker ?? ZERO,
    rfqId: overrides.rfqId ?? ZERO_HASH,
  } as const;
}

function wireOrder(overrides: Parameters<typeof order>[0] = {}): Record<string, unknown> {
  const value = order(overrides);
  return {
    ...value,
    stockAmount: value.stockAmount.toString(),
    usdcAmount: value.usdcAmount.toString(),
    expiry: value.expiry.toString(),
    salt: value.salt.toString(),
  };
}

function makeService() {
  const clock = new InMemoryClock(1_000n);
  const repository = new InMemoryBaseRepository();
  const signatures = new InMemorySignatureVerificationPort();
  const service = new BaseApiService(
    defaultTestConfig({ nativeUsdcAddress: USDC, conservativeGasUsdc: 2n }),
    repository,
    new InMemoryChainSnapshotPort(),
    signatures,
    clock,
    new InMemoryNotificationPort(),
    {
      collect: async () => ({ simulationBlock: 7n, simulationBlockHash: `0x${'22'.repeat(32)}` as Hex }),
    },
  );
  return { service, repository, signatures };
}

describe('v2 maker swap order intake', () => {
  it('accepts delegated signers and persists only a seller-private standing order', async () => {
    const { service, repository, signatures } = makeService();
    signatures.delegate(MAKER, SIGNER);
    const result = await service.swapOrder({
      action: 'register',
      order: wireOrder({ signer: SIGNER }),
      signature,
      remainingCapacity: '100',
    }, makerAuth);

    expect(result).toMatchObject({ action: 'register', maker: MAKER, remainingCapacity: '100', standing: true });
    const stored = await repository.listSwapOrders();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.order.usdcAmount).toBe('10000');

    const quote = await service.quoteSwap({
      stockToken: STOCK,
      usdcToken: USDC,
      sellAmount: '100',
      minBuyAmount: '9900',
      taker: TAKER,
      recipient: TAKER,
      deadline: '1900',
    }, takerAuth);
    expect(quote.status).toBe('WINNER');
    expect(quote.alternatives).toHaveLength(0);
    expect(quote.recommended).toMatchObject({ source: 'KATON' });
  });

  it('rejects capacity above the signed order and revokes only for the maker', async () => {
    const { service, repository } = makeService();
    await expect(service.swapOrder({
      action: 'register',
      order: wireOrder(),
      signature,
      remainingCapacity: '101',
    }, makerAuth)).rejects.toThrow('ORDER_CAPACITY');

    const registered = await service.swapOrder({
      action: 'register',
      order: wireOrder(),
      signature,
      remainingCapacity: '100',
    }, makerAuth);
    const orderHash = String(registered.orderHash);
    await expect(service.swapOrder({ action: 'revoke', orderHash }, { kind: 'bot', identity: OTHER, scopes: ['lp'] })).rejects.toThrow('SWAP_ORDER_NOT_FOUND');
    await expect(service.swapOrder({ action: 'revoke', orderHash }, makerAuth)).resolves.toMatchObject({ status: 'revoked' });
    expect(await repository.listSwapOrders()).toHaveLength(0);
  });

  it('rejects a fill-or-kill order whose advertised capacity is not the signed amount', async () => {
    const { service } = makeService();
    await expect(service.swapOrder({
      action: 'register',
      order: wireOrder({ fillMode: 0 }),
      signature,
      remainingCapacity: '99',
    }, makerAuth)).rejects.toThrow('ORDER_CAPACITY');
  });

  it('does not quote a cancelled standing order or allow a non-maker to register it', async () => {
    const { service, signatures } = makeService();
    await expect(service.swapOrder({
      action: 'register',
      order: wireOrder(),
      signature,
      remainingCapacity: '100',
    }, { kind: 'bot', identity: OTHER, scopes: ['lp'] })).rejects.toThrow('UNAUTHORIZED');

    const registered = await service.swapOrder({
      action: 'register',
      order: wireOrder(),
      signature,
      remainingCapacity: '100',
    }, makerAuth);
    signatures.cancelSwap(String(registered.orderHash) as Hex);
    const quote = await service.quoteSwap({
      stockToken: STOCK,
      usdcToken: USDC,
      sellAmount: '100',
      minBuyAmount: '1',
      taker: TAKER,
      recipient: TAKER,
      deadline: '1900',
    }, takerAuth);
    expect(quote.status).toBe('NO_ROUTE');
  });
});
