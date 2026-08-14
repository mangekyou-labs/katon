import { describe, expect, it } from 'vitest';

import {
  connectFlareWallet,
  watchFlareWallet,
  submitWalletTransaction,
  waitForIndexedConfirmation,
  type Eip1193Provider,
} from '../packages/flare-sdk/src/wallet';

const address = '0x00000000000000000000000000000000000000AA' as const;
const txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

function provider(overrides: Record<string, unknown> = {}): Eip1193Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request({ method }) {
      calls.push(method);
      if (method in overrides) return overrides[method];
      if (method === 'eth_requestAccounts') return [address];
      if (method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return '0x72';
      if (method === 'eth_sendTransaction') return txHash;
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    },
  };
}

describe('Flare browser wallet boundary', () => {
  it('connects only an account on the selected Coston2 chain', async () => {
    await expect(connectFlareWallet(provider(), 'coston2')).resolves.toMatchObject({
      address,
      chainId: 114,
    });
    await expect(connectFlareWallet(provider({ eth_chainId: '0xe' }), 'coston2')).rejects.toThrow(
      'WRONG_NETWORK: expected 114, received 14',
    );
  });

  it('reports signature, submission, receipt, and indexed states separately', async () => {
    const states: string[] = [];
    const wallet = provider();
    await expect(submitWalletTransaction(wallet, {
      from: address,
      to: '0x00000000000000000000000000000000000000bb',
      data: '0x1234',
      value: 0n,
      chainId: 114,
    }, {
      waitForReceipt: async () => ({ status: 'success' as const }),
      waitForIndexed: async () => undefined,
      onState: (state) => states.push(state),
    })).resolves.toEqual({ hash: txHash, indexed: true });
    expect(states).toEqual(['awaiting-signature', 'submitted', 'confirmed', 'indexed']);
    expect(wallet.calls).toEqual(['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
  });

  it('stops before indexed when the chain receipt reverts', async () => {
    const states: string[] = [];
    await expect(submitWalletTransaction(provider(), {
      from: address,
      to: '0x00000000000000000000000000000000000000bb',
      data: '0x1234',
      value: 0n,
      chainId: 114,
    }, {
      waitForReceipt: async () => ({ status: 'reverted' as const }),
      waitForIndexed: async () => undefined,
      onState: (state) => states.push(state),
    })).rejects.toThrow('TRANSACTION_REVERTED');
    expect(states).toEqual(['awaiting-signature', 'submitted', 'reverted']);
  });

  it('rejects submission from an account not authorized by the wallet', async () => {
    await expect(submitWalletTransaction(provider({ eth_accounts: ['0x00000000000000000000000000000000000000bb'] }), {
      from: address,
      to: '0x00000000000000000000000000000000000000cc',
      data: '0x1234',
      value: 0n,
      chainId: 114,
    }, {
      waitForReceipt: async () => ({ status: 'success' as const }),
      waitForIndexed: async () => undefined,
    })).rejects.toThrow('WALLET_ACCOUNT_MISMATCH');
  });

  it('polls the public indexer boundary after chain confirmation', async () => {
    let attempts = 0;
    await expect(waitForIndexedConfirmation(async () => {
      attempts += 1;
      return attempts === 2;
    }, txHash, { intervalMs: 0, maxAttempts: 3 })).resolves.toBe(true);
    expect(attempts).toBe(2);
    await expect(waitForIndexedConfirmation(async () => false, txHash, {
      intervalMs: 0,
      maxAttempts: 2,
    })).rejects.toThrow('INDEX_TIMEOUT');
  });

  it('tracks extension account and network changes without requesting a new signature', async () => {
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const wallet = provider() as Eip1193Provider & { calls: string[]; account: string; chain: string; on: Eip1193Provider['on']; removeListener: Eip1193Provider['removeListener'] };
    wallet.account = address;
    wallet.chain = '0x72';
    wallet.request = async ({ method }) => {
      wallet.calls.push(method);
      if (method === 'eth_accounts') return [wallet.account];
      if (method === 'eth_chainId') return wallet.chain;
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    };
    wallet.on = (event, listener) => { listeners.set(event, listener); };
    wallet.removeListener = (event) => { listeners.delete(event); };
    const changes: Array<string | null> = [];
    const errors: string[] = [];
    const stop = watchFlareWallet(wallet, 'coston2', (next) => changes.push(next?.address ?? null), (error) => errors.push(String(error)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes.at(-1)).toBe(address);
    wallet.account = '0x00000000000000000000000000000000000000BB';
    listeners.get('accountsChanged')?.([wallet.account]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes.at(-1)).toBe('0x00000000000000000000000000000000000000bb');
    wallet.chain = '0xe';
    listeners.get('chainChanged')?.('0xe');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes.at(-1)).toBeNull();
    expect(errors.at(-1)).toBe('Error: WRONG_NETWORK: expected 114, received 14');
    stop();
    expect(listeners.size).toBe(0);
  });
});
