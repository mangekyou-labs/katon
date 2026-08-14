import { getAddress, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

export type QaAccountRole = 'seller' | 'lp-a' | 'lp-b';
export interface QaAccount { readonly role: QaAccountRole; readonly index: number; readonly address: Address; }
export interface QaBalance extends QaAccount { readonly balanceWei: bigint; }

const ROLES: readonly QaAccountRole[] = ['seller', 'lp-a', 'lp-b'];

export function deriveQaAccounts(mnemonic: string): readonly QaAccount[] {
  const normalized = mnemonic.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.split(' ').length < 12) throw new Error('QA_MNEMONIC');
  return ROLES.map((role, index) => ({ role, index, address: getAddress(mnemonicToAccount(normalized, { addressIndex: index }).address) }));
}

export async function preflightQaBalances(rpcUrl: string, accounts: readonly QaAccount[], options: { readonly chainId: number; readonly fetcher?: typeof fetch }): Promise<{ readonly chainId: 114; readonly accounts: readonly QaBalance[] }> {
  if (options.chainId !== 114) throw new Error('QA_CHAIN_ID');
  if (accounts.length !== 3 || new Set(accounts.map((account) => account.address.toLowerCase())).size !== 3) throw new Error('QA_ACCOUNT_COUNT');
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (!fetcher) throw new Error('QA_RPC');
  const balances: QaBalance[] = [];
  for (const [id, account] of accounts.entries()) {
    let response: Response;
    try { response = await fetcher(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id + 1, method: 'eth_getBalance', params: [account.address, 'latest'] }) }); } catch { throw new Error('QA_RPC'); }
    if (!response.ok) throw new Error('QA_RPC_STATUS');
    const body = await response.json() as { readonly result?: unknown; readonly error?: unknown };
    if (body.error || typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error('QA_BALANCE');
    balances.push({ ...account, balanceWei: BigInt(body.result) });
  }
  return { chainId: 114, accounts: balances };
}
