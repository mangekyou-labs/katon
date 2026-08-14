import { getAddress, type Address, type Hex } from 'viem';

import { getNetworkConfig, type FlareNetwork } from '../../flare-core/src/network';

export interface Eip1193Provider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
  on?(event: 'accountsChanged' | 'chainChanged', listener: (...args: readonly unknown[]) => void): unknown;
  removeListener?(event: 'accountsChanged' | 'chainChanged', listener: (...args: readonly unknown[]) => void): unknown;
}

export interface FlareWalletConnection {
  readonly address: Address;
  readonly chainId: number;
  readonly network: FlareNetwork;
}

export interface UnsignedWalletTransaction {
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly chainId: number;
}

export type WalletTransactionState = 'awaiting-signature' | 'submitted' | 'confirmed' | 'reverted' | 'indexed';

export interface WalletReceipt {
  readonly status: 'success' | 'reverted';
}

export interface WalletSubmissionOptions {
  readonly waitForReceipt: (hash: Hex) => Promise<WalletReceipt>;
  readonly waitForIndexed: (hash: Hex) => Promise<void>;
  readonly onState?: (state: WalletTransactionState) => void;
}

export interface WalletSubmissionResult {
  readonly hash: Hex;
  readonly indexed: true;
}

export interface IndexedConfirmationOptions {
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
}

export async function connectFlareWallet(
  provider: Eip1193Provider,
  network: FlareNetwork = 'coston2',
): Promise<FlareWalletConnection> {
  const expected = getNetworkConfig(network);
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') {
    throw new Error('WALLET_ACCOUNT_REQUIRED');
  }
  const chainId = await readChainId(provider);
  if (chainId !== expected.chainId) {
    throw new Error(`WRONG_NETWORK: expected ${expected.chainId}, received ${chainId}`);
  }
  return { address: getAddress(accounts[0]), chainId, network };
}

export function watchFlareWallet(
  provider: Eip1193Provider,
  network: FlareNetwork,
  onChange: (connection: FlareWalletConnection | null) => void,
  onError?: (error: unknown) => void,
): () => void {
  if (typeof provider.on !== 'function') return () => undefined;
  const refresh = async (): Promise<void> => {
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      const chainId = await readChainId(provider);
      const expected = getNetworkConfig(network);
      if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') {
        onChange(null);
        return;
      }
      if (chainId !== expected.chainId) {
        throw new Error(`WRONG_NETWORK: expected ${expected.chainId}, received ${chainId}`);
      }
      onChange({ address: getAddress(accounts[0]), chainId, network });
    } catch (error) {
      onChange(null);
      onError?.(error);
    }
  };
  const handleAccounts = (): void => { void refresh(); };
  const handleChain = (): void => { void refresh(); };
  provider.on('accountsChanged', handleAccounts);
  provider.on('chainChanged', handleChain);
  void refresh();
  return () => {
    provider.removeListener?.('accountsChanged', handleAccounts);
    provider.removeListener?.('chainChanged', handleChain);
  };
}

export async function submitWalletTransaction(
  provider: Eip1193Provider,
  transaction: UnsignedWalletTransaction,
  options: WalletSubmissionOptions,
): Promise<WalletSubmissionResult> {
  const chainId = await readChainId(provider);
  if (chainId !== transaction.chainId) {
    throw new Error(`WRONG_NETWORK: expected ${transaction.chainId}, received ${chainId}`);
  }
  if (getAddress(transaction.from) === '0x0000000000000000000000000000000000000000') {
    throw new Error('WALLET_ACCOUNT_REQUIRED');
  }
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (!Array.isArray(accounts) || !accounts.some((candidate) => (
    typeof candidate === 'string' && getAddress(candidate) === getAddress(transaction.from)
  ))) {
    throw new Error('WALLET_ACCOUNT_MISMATCH');
  }
  options.onState?.('awaiting-signature');
  let hash: Hex;
  try {
    const response = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from: getAddress(transaction.from),
        to: getAddress(transaction.to),
        data: transaction.data,
        value: `0x${transaction.value.toString(16)}`,
      }],
    });
    if (typeof response !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(response)) throw new Error('TX_HASH_INVALID');
    hash = response as Hex;
  } catch (error) {
    if (isUserRejection(error)) options.onState?.('reverted');
    throw error;
  }
  options.onState?.('submitted');
  const receipt = await options.waitForReceipt(hash);
  if (receipt.status !== 'success') {
    options.onState?.('reverted');
    throw new Error(`TRANSACTION_REVERTED:${hash}`);
  }
  options.onState?.('confirmed');
  await options.waitForIndexed(hash);
  options.onState?.('indexed');
  return { hash, indexed: true };
}

export async function waitForIndexedConfirmation(
  reader: (hash: Hex) => Promise<boolean>,
  hash: Hex,
  options: IndexedConfirmationOptions = {},
): Promise<true> {
  const intervalMs = options.intervalMs ?? 1_000;
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
  if (intervalMs < 0 || maxAttempts <= 0) throw new Error('INDEX_OPTIONS');
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await reader(hash)) return true;
    if (attempt + 1 < maxAttempts && intervalMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`INDEX_TIMEOUT:${hash}`);
}

async function readChainId(provider: Eip1193Provider): Promise<number> {
  const value = await provider.request({ method: 'eth_chainId' });
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error('CHAIN_ID_INVALID');
  return Number(BigInt(value));
}

function isUserRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 4001;
}
