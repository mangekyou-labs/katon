import { describe, expect, it } from 'vitest';
import { BaseWallet, type Eip1193Provider } from '../apps/base-web/src/wallet';

const seller = '0x1111111111111111111111111111111111111111' as const;
const router = '0x2222222222222222222222222222222222222222' as const;
const decisionHash = `0x${'a'.repeat(64)}` as const;
const latestHash = `0x${'b'.repeat(64)}` as const;
const txHash = `0x${'c'.repeat(64)}` as const;

function providerFor(input: {
  readonly latest: bigint;
  readonly latestHash?: string;
  readonly decisionHash?: string;
  readonly sendResult?: string;
  readonly calls?: string[];
}): Eip1193Provider {
  const calls = input.calls ?? [];
  return {
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [seller];
      if (method === 'eth_chainId') return '0x14a34';
      if (method === 'eth_blockNumber') return `0x${input.latest.toString(16)}`;
      if (method === 'eth_getBlockByNumber') {
        const number = params?.[0];
        const block = BigInt(typeof number === 'string' ? number : '0x0');
        return { hash: block === input.latest ? (input.latestHash ?? latestHash) : (input.decisionHash ?? decisionHash) };
      }
      if (method === 'eth_call') return '0x';
      if (method === 'eth_sendTransaction') return input.sendResult ?? txHash;
      throw new Error(`UNEXPECTED_RPC:${method}`);
    },
  };
}

async function connectedWallet(provider: Eip1193Provider): Promise<BaseWallet> {
  const wallet = new BaseWallet(provider, 84_532, 'http://127.0.0.1:8545');
  await wallet.connect();
  return wallet;
}

describe('BaseWallet stock-sale freshness', () => {
  it('checks the decision block hash and age before sending unchanged calldata', async () => {
    const calls: string[] = [];
    const wallet = await connectedWallet(providerFor({ latest: 101n, calls }));

    await expect(wallet.sendRouteOnly({ to: router, data: '0x1234', value: 0n }, {
      decisionBlock: 100n,
      decisionBlockHash: decisionHash,
      maxAge: 2n,
    })).resolves.toBe(txHash);

    expect(calls.slice(-5)).toEqual([
      'eth_blockNumber',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
      'eth_call',
      'eth_sendTransaction',
    ]);
  });

  it('rejects a route when the latest block is older than the decision policy', async () => {
    const calls: string[] = [];
    const wallet = await connectedWallet(providerFor({ latest: 104n, calls }));

    await expect(wallet.sendRouteOnly({ to: router, data: '0x1234', value: 0n }, {
      decisionBlock: 100n,
      decisionBlockHash: decisionHash,
      maxAge: 3n,
    })).rejects.toThrow('SWAP_QUOTE_STALE');
    expect(calls).not.toContain('eth_sendTransaction');
  });

  it('rejects a route when the decision block hash has changed', async () => {
    const calls: string[] = [];
    const wallet = await connectedWallet(providerFor({ latest: 101n, decisionHash: `0x${'d'.repeat(64)}`, calls }));

    await expect(wallet.sendRouteOnly({ to: router, data: '0x1234' }, {
      decisionBlock: 100n,
      decisionBlockHash: decisionHash,
      maxAge: 2n,
    })).rejects.toThrow('SWAP_QUOTE_STALE');
    expect(calls).not.toContain('eth_sendTransaction');
  });
});
