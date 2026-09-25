import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveStockSale, submitExternalStockSaleRoute, submitStockSaleRoute } from '../apps/base-web/src/transactions';
import type { BaseRuntimeConfig } from '../apps/base-web/src/runtime';
import type { BaseWallet } from '../apps/base-web/src/wallet';
import type { StockSaleQuoteDto, StockSaleRouteDto } from '../apps/base-web/src/api';

const address = (digit: string): `0x${string}` => `0x${digit.repeat(40)}`;

const root = process.cwd();

describe('Base web v2 surface', () => {
  it('uses an explicit stock-sale route table alongside the operational routes', () => {
    const routes = readFileSync(join(root, 'apps/base-web/src/routes.ts'), 'utf8');
    expect(routes).toContain("'/'");
    expect(routes).toContain("'/sell'");
    expect(routes).toContain("'/facility'");
    expect(routes).toContain("'/curator'");
    expect(routes).toContain("'/liquidations'");
  });

  it('includes a wallet-bound stock sale UI entry point', () => {
    const app = readFileSync(join(root, 'apps/base-web/src/App.tsx'), 'utf8');
    expect(app).toContain("'/sell'");
    expect(app).toContain('SellPage');
    expect(app).toContain('eth_requestAccounts');
    expect(app).toContain('eth_signTypedData_v4');
    expect(app).toContain('quoteUsdcCapacity');
    expect(app).toContain('DASHBOARD_UNAVAILABLE');
    expect(app).toContain('wrong-chain');
    const pages = readFileSync(join(root, 'apps/base-web/src/pages.tsx'), 'utf8');
    expect(pages).toContain('B20 RETAIL EXIT');
    expect(pages).toContain('Collect best price');
    expect(pages).toContain('Submit reviewed route');
    expect(pages).toContain('settlementAllowanceTarget');
    expect(pages).toContain('VENUE_MANIFEST_UNAVAILABLE');
    expect(pages).toContain('liquidation-unavailable');
    expect(pages).toContain('Facility deposits remain available.');
  });

  it('approves exact stock to settlement before quote and submits only the reviewed route', async () => {
    const stock = address('6');
    const router = address('7');
    const settlement = address('8');
    const calls: string[] = [];
    const approvalCalls: Array<{ readonly token: string; readonly spender: string; readonly amount: bigint }> = [];
    const routeCalls: Array<{ readonly to: string; readonly data: string; readonly value: bigint; readonly freshness?: { readonly decisionBlock: string | bigint; readonly decisionBlockHash: string; readonly maxAge?: bigint } }> = [];
    const wallet = {
      approveExactAllowance: async (token: string, spender: string, amount: bigint) => {
        calls.push('approve');
        approvalCalls.push({ token, spender, amount });
        return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      },
      sendRouteOnly: async (transaction: { readonly to: string; readonly data: string; readonly value: bigint }, freshness: { readonly decisionBlock: string | bigint; readonly decisionBlockHash: string; readonly maxAge?: bigint }) => {
        calls.push('route');
        routeCalls.push({ ...transaction, freshness });
        return '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      },
      waitForReceipt: async () => {
        calls.push('receipt');
        return { status: 'success' as const };
      },
    } as unknown as BaseWallet;
    const config = {
      network: 'sepolia',
      chainId: 84_532,
      networkName: 'Base Sepolia',
      rpcUrl: 'https://sepolia.base.org',
      apiUrl: '/',
      explorerUrl: 'https://sepolia.basescan.org',
      usdc: address('9'),
      deployment: { router, settlement },
      adapters: [],
      b20Assets: { [stock.toLowerCase()]: { ticker: 'CB20', feed: address('a'), decimals: 18 } },
      status: 'ready',
      writesEnabled: true,
      productionEligible: false,
      forkQa: false,
      decisionBlockMaxAge: 2n,
    } as BaseRuntimeConfig;
    const route: StockSaleRouteDto = {
      kind: 'INTERNAL',
      source: 'KATON',
      routeId: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      stockAmount: '100',
      grossUsdc: '100',
      guaranteedUsdc: '100',
      fee: '0',
      gasEstimateUsdc: '0',
      effectiveUsdc: '100',
      expiry: '9999999999',
      decisionBlock: '100',
      decisionBlockHash: `0x${'c'.repeat(64)}`,
      allowanceTarget: router,
      settlementAllowanceTarget: settlement,
      transaction: { to: router, data: '0x1234', value: '0' },
    };

    await approveStockSale(wallet, config, stock, 100n);
    await submitStockSaleRoute(wallet, config, { route, stockToken: stock, stockAmount: 100n });

    expect(calls).toEqual(['approve', 'receipt', 'route', 'receipt']);
    expect(approvalCalls).toEqual([{ token: stock, spender: settlement, amount: 100n }]);
    expect(routeCalls).toEqual([{
      to: router,
      data: '0x1234',
      value: 0n,
      freshness: { decisionBlock: '100', decisionBlockHash: `0x${'c'.repeat(64)}`, maxAge: 2n },
    }]);
  });

  it('does not submit a route after an approval receipt failure', async () => {
    const stock = address('6');
    const settlement = address('8');
    let routeSubmitted = false;
    const wallet = {
      approveExactAllowance: async () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sendRouteOnly: async () => { routeSubmitted = true; return '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; },
      waitForReceipt: async () => ({ status: 'reverted' as const }),
    } as unknown as BaseWallet;
    const config = {
      network: 'sepolia', chainId: 84_532, networkName: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org', apiUrl: '/', explorerUrl: 'https://sepolia.basescan.org',
      usdc: address('9'), deployment: { router: address('7'), settlement }, adapters: [],
      b20Assets: { [stock.toLowerCase()]: { ticker: 'CB20', feed: address('a'), decimals: 18 } }, status: 'ready', writesEnabled: true,
      productionEligible: false, forkQa: false,
    } as BaseRuntimeConfig;

    await expect(approveStockSale(wallet, config, stock, 100n)).rejects.toThrow('TRANSACTION_REVERTED:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(routeSubmitted).toBe(false);
  });

  it('clears the route submission at the stale-quote seam', async () => {
    const stock = address('6');
    const router = address('7');
    const wallet = {
      sendRouteOnly: async () => { throw new Error('SWAP_QUOTE_STALE'); },
      waitForReceipt: async () => ({ status: 'success' as const }),
    } as unknown as BaseWallet;
    const config = {
      network: 'sepolia', chainId: 84_532, networkName: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org', apiUrl: '/', explorerUrl: 'https://sepolia.basescan.org',
      usdc: address('9'), deployment: { router, settlement: address('8') }, adapters: [],
      b20Assets: { [stock.toLowerCase()]: { ticker: 'CB20', feed: address('a'), decimals: 18 } }, status: 'ready', writesEnabled: true,
      productionEligible: false, forkQa: false,
    } as BaseRuntimeConfig;
    const route: StockSaleRouteDto = {
      kind: 'INTERNAL', source: 'KATON', routeId: `0x${'c'.repeat(64)}`, stockAmount: '100', grossUsdc: '100', guaranteedUsdc: '100', fee: '0', gasEstimateUsdc: '0', effectiveUsdc: '100', expiry: '9999999999',
      decisionBlock: '100', decisionBlockHash: `0x${'d'.repeat(64)}`, transaction: { to: router, data: '0x1234', value: '0' },
    };
    await expect(submitStockSaleRoute(wallet, config, { route, stockToken: stock, stockAmount: 100n })).rejects.toThrow('SWAP_QUOTE_STALE');
  });

  it('executes a bound external route only after exact approval, freshness, simulation, and balance checks', async () => {
    const stock = address('6');
    const usdc = address('9');
    const owner = address('1');
    const allowanceTarget = address('2');
    const executionTarget = address('3');
    const calls: string[] = [];
    const balances = [100n, 500n, 0n, 800n];
    const approvalCalls: Array<{ token: string; spender: string; amount: bigint }> = [];
    const wallet = {
      assertWritable: () => owner,
      approveExactAllowance: async (token: string, spender: string, amount: bigint) => {
        calls.push('approve');
        approvalCalls.push({ token, spender, amount });
        return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      },
      waitForReceipt: async () => {
        calls.push('receipt');
        return { status: 'success' as const };
      },
      assertRouteFresh: async () => { calls.push('freshness'); },
      readTokenBalance: async () => balances.shift()!,
      simulate: async () => { calls.push('simulate'); },
      sendTransaction: async () => {
        calls.push('send');
        return '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      },
    } as unknown as BaseWallet;
    const config = {
      network: 'mainnet', chainId: 8453, networkName: 'Base', rpcUrl: 'https://mainnet.base.org', apiUrl: '/', explorerUrl: 'https://basescan.org',
      usdc, deployment: {}, adapters: [], b20Assets: {}, status: 'ready', writesEnabled: false,
      productionEligible: false, forkQa: false, decisionBlockMaxAge: 2n,
    } as BaseRuntimeConfig;
    const quote: StockSaleQuoteDto = {
      requestId: `0x${'c'.repeat(64)}`, chainId: '8453', stockToken: stock, usdcToken: usdc,
      sellAmount: '100', minBuyAmount: '300', taker: owner, recipient: owner, feeBps: '0',
      auctionOpenedAtMs: Date.now(), auctionCutoffAtMs: Date.now() + 1_000, simulationBlock: '10',
      simulationBlockHash: `0x${'d'.repeat(64)}`, status: 'WINNER', alternatives: [], external: [],
    };
    const route: StockSaleRouteDto = {
      kind: 'EXTERNAL', source: '0x', routeId: `0x${'e'.repeat(64)}`, stockAmount: '100',
      grossUsdc: '310', guaranteedUsdc: '300', fee: '0', gasEstimateUsdc: '0', effectiveUsdc: '300',
      expiry: String(Math.floor(Date.now() / 1_000) + 60), decisionBlock: '100', decisionBlockHash: `0x${'f'.repeat(64)}`,
      transaction: {
        to: executionTarget, data: '0x1234', value: '0', allowanceTarget, chainId: 8453,
        recipient: owner, stockToken: stock, usdcToken: usdc, sellAmount: '100', minBuyAmount: '300',
      },
    };

    await expect(submitExternalStockSaleRoute(wallet, config, quote, route)).resolves.toEqual({
      hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', receiptStatus: 'success',
    });
    expect(approvalCalls).toEqual([{ token: stock, spender: allowanceTarget, amount: 100n }]);
    expect(calls).toEqual(['approve', 'receipt', 'freshness', 'simulate', 'send', 'receipt']);
    expect(balances).toEqual([]);
  });

  it('rejects an external route bound to a different wallet before requesting approval', async () => {
    const owner = address('1');
    let approvalRequested = false;
    const wallet = {
      assertWritable: () => owner,
      approveExactAllowance: async () => { approvalRequested = true; return undefined; },
    } as unknown as BaseWallet;
    const usdc = address('9');
    const stock = address('6');
    const config = {
      network: 'mainnet', chainId: 8453, networkName: 'Base', rpcUrl: 'https://mainnet.base.org', apiUrl: '/', explorerUrl: 'https://basescan.org',
      usdc, deployment: {}, adapters: [], b20Assets: {}, status: 'ready', writesEnabled: false,
      productionEligible: false, forkQa: false,
    } as BaseRuntimeConfig;
    const quote: StockSaleQuoteDto = {
      requestId: `0x${'c'.repeat(64)}`, chainId: '8453', stockToken: stock, usdcToken: usdc,
      sellAmount: '100', minBuyAmount: '300', taker: address('2'), recipient: address('2'), feeBps: '0',
      auctionOpenedAtMs: Date.now(), auctionCutoffAtMs: Date.now() + 1_000, simulationBlock: '10',
      simulationBlockHash: `0x${'d'.repeat(64)}`, status: 'WINNER', alternatives: [], external: [],
    };
    const route: StockSaleRouteDto = {
      kind: 'EXTERNAL', source: '0x', routeId: `0x${'e'.repeat(64)}`, stockAmount: '100',
      grossUsdc: '310', guaranteedUsdc: '300', fee: '0', gasEstimateUsdc: '0', effectiveUsdc: '300',
      expiry: String(Math.floor(Date.now() / 1_000) + 60), decisionBlock: '100', decisionBlockHash: `0x${'f'.repeat(64)}`,
      transaction: {
        to: address('3'), data: '0x1234', value: '0', allowanceTarget: address('4'), chainId: 8453,
        recipient: owner, stockToken: stock, usdcToken: usdc, sellAmount: '100', minBuyAmount: '300',
      },
    };

    await expect(submitExternalStockSaleRoute(wallet, config, quote, route)).rejects.toThrow('EXTERNAL_QUOTE_BINDING');
    expect(approvalRequested).toBe(false);
  });
});
