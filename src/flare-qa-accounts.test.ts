import { mnemonicToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { deriveQaAccounts, preflightQaBalances } from '../packages/flare-sdk/src/qaAccounts';

const mnemonic = 'test test test test test test test test test test test junk';

describe('disposable Coston2 QA accounts', () => {
  it('derives seller, LP-A, and LP-B addresses without returning private material', () => {
    const accounts = deriveQaAccounts(mnemonic);
    expect(accounts).toHaveLength(3);
    expect(accounts.map((account) => account.role)).toEqual(['seller', 'lp-a', 'lp-b']);
    expect(accounts.map((account) => account.address)).toEqual([0, 1, 2].map((index) => mnemonicToAccount(mnemonic, { addressIndex: index }).address));
    expect(JSON.stringify(accounts)).not.toMatch(/private|seed|mnemonic/i);
  });

  it('preflights all three balances and fails closed on a wrong chain', async () => {
    const accounts = deriveQaAccounts(mnemonic);
    const calls: unknown[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.id === 1 ? '0x10' : '0x0' }), { status: 200 });
    };
    await expect(preflightQaBalances('https://coston2.example/rpc', accounts, { chainId: 114, fetcher })).resolves.toEqual({ chainId: 114, accounts: accounts.map((account, index) => ({ ...account, balanceWei: index === 0 ? 16n : 0n })) });
    expect(calls).toHaveLength(3);
    await expect(preflightQaBalances('https://coston2.example/rpc', accounts, { chainId: 14, fetcher })).rejects.toThrow('QA_CHAIN_ID');
  });
});
