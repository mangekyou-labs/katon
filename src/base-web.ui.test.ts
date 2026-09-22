import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveStockSale, submitStockSaleRoute } from '../apps/base-web/src/transactions';
import type { BaseRuntimeConfig } from '../apps/base-web/src/runtime';
import type { BaseWallet } from '../apps/base-web/src/wallet';
import type { StockSaleRouteDto } from '../apps/base-web/src/api';

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
});
