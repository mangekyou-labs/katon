import { describe, expect, it } from 'vitest';

import { BaseWallet, type Eip1193Provider } from '../apps/base-web/src/wallet';
import { ERC8021_MARKER, hasBuilderCodeSuffix } from '../packages/base-core/src/builder-code';

const seller = '0x1111111111111111111111111111111111111111' as const;
const facility = '0x3333333333333333333333333333333333333333' as const;
const txHash = `0x${'c'.repeat(64)}` as const;
const ONE_CODE_SUFFIX = '0x62635f616263313233090080218021802180218021802180218021';

const DEPOSIT_ABI = [{
  type: 'function',
  name: 'deposit',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'assets', type: 'uint256' }],
  outputs: [{ name: 'shares', type: 'uint256' }],
}] as const;

interface Capture {
  readonly sends: { readonly to?: string; readonly data?: string; readonly value?: string }[];
  readonly calls: { readonly to?: string; readonly data?: string }[];
}

function providerFor(capture: Capture): Eip1193Provider {
  return {
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [seller];
      if (method === 'eth_chainId') return '0x14a34';
      if (method === 'eth_call') {
        capture.calls.push((params?.[0] ?? {}) as { to?: string; data?: string });
        return '0x';
      }
      if (method === 'eth_sendTransaction') {
        capture.sends.push((params?.[0] ?? {}) as { to?: string; data?: string; value?: string });
        return txHash;
      }
      throw new Error(`UNEXPECTED_RPC:${method}`);
    },
  };
}

async function walletWith(builderCode?: string, capture: Capture = { sends: [], calls: [] }): Promise<BaseWallet> {
  const wallet = new BaseWallet(providerFor(capture), 84_532, 'http://127.0.0.1:8545', builderCode);
  await wallet.connect();
  return wallet;
}

describe('ERC-8021 attribution at the wallet boundary', () => {
  it('attributes facility, venue, and approval calldata with one suffix', async () => {
    const capture: Capture = { sends: [], calls: [] };
    const wallet = await walletWith('bc_abc123', capture);
    expect(wallet.getAttributionSuffix()).toBe(ONE_CODE_SUFFIX);

    await wallet.writeContract({ address: facility, abi: DEPOSIT_ABI, functionName: 'deposit', args: [1n] });
    await wallet.writeContract({
      address: facility,
      abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }] as const,
      functionName: 'approve',
      args: [facility, 5n],
    });

    expect(capture.sends).toHaveLength(2);
    for (const send of capture.sends) {
      expect(send.data?.endsWith(ONE_CODE_SUFFIX.slice(2))).toBe(true);
      expect(hasBuilderCodeSuffix(send.data as `0x${string}`)).toBe(true);
    }
    // The simulation the wallet runs must carry the same attributed calldata.
    expect(capture.calls[0]?.data).toBe(capture.sends[0]?.data);
    expect(capture.sends[0]?.data).not.toBe(capture.sends[1]?.data);
  });

  it('keeps value-only transfers plain so an ETH send never becomes a contract call', async () => {
    const capture: Capture = { sends: [], calls: [] };
    const wallet = await walletWith('bc_abc123', capture);
    await wallet.sendTransaction({ to: facility, data: '0x', value: 1n });
    expect(capture.sends[0]?.data).toBe('0x');
    expect(capture.sends[0]?.value).toBe('0x1');
  });

  it('leaves calldata untouched when no builder code is configured', async () => {
    const capture: Capture = { sends: [], calls: [] };
    const wallet = await walletWith(undefined, capture);
    expect(wallet.getAttributionSuffix()).toBeUndefined();
    await wallet.writeContract({ address: facility, abi: DEPOSIT_ABI, functionName: 'deposit', args: [1n] });
    expect(hasBuilderCodeSuffix(capture.sends[0]?.data as `0x${string}`)).toBe(false);
  });

  it('fails closed rather than stacking a duplicate attribution suffix', async () => {
    const capture: Capture = { sends: [], calls: [] };
    const wallet = await walletWith('bc_abc123', capture);
    const alreadyAttributed = `0xdeadbeef${ERC8021_MARKER.slice(2)}` as const;
    await expect(wallet.sendTransaction({ to: facility, data: alreadyAttributed })).rejects.toThrow('BUILDER_CODE_DUPLICATE_SUFFIX');
    expect(capture.sends).toHaveLength(0);
  });

  it('rejects a malformed builder code at construction', () => {
    const provider = providerFor({ sends: [], calls: [] });
    expect(() => new BaseWallet(provider, 84_532, 'http://127.0.0.1:8545', 'bc_bad,code')).toThrow('BUILDER_CODE_SEPARATOR');
    expect(() => new BaseWallet(provider, 84_532, 'http://127.0.0.1:8545', '')).not.toThrow();
  });
});
