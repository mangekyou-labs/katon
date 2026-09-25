import { createClient } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { walletSigner } from '@solana/kit-plugin-wallet';
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { getWalletAccountFeature, type UiWalletAccount } from '@wallet-standard/ui';
import { reviewFrozenSettlement, type FrozenSettlementSummary } from '../../../packages/solana-core/src/frozen-settlement';
import { base64FromBytes, bytesFromBase64, serializedMessage } from '../../../packages/solana-sdk/src/index';

export const EXPECTED_CHAIN = 'solana:localnet' as const;
export const LOCAL_RPC_URL = 'http://127.0.0.1:8899';

export const solanaKitClient = createClient()
  .use(walletSigner({ chain: EXPECTED_CHAIN }))
  .use(solanaRpc({ rpcUrl: LOCAL_RPC_URL }));

export type AppSolanaClient = typeof solanaKitClient;

export type LocalnetSettlementSummary = FrozenSettlementSummary;

type SignTransactionApi = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Adapt the Seller Desk quote to the shared frozen-transaction review. */
export function inspectLocalnetSettlementTransaction(
  transactionBase64: string,
  seller: string,
  expected: {
    readonly sourceKind: 'jupiter' | 'private-maker';
    readonly quoteId: string;
    readonly inputMint: string;
    readonly outputMint: string;
    readonly inputAmountAtomic: string;
    readonly grossOutputAtomic: string;
    readonly netOutputAtomic: string;
    readonly feeBps: number;
    readonly expiresAtMs: number;
  },
  nowMs = Date.now(),
): LocalnetSettlementSummary {
  if (expected.sourceKind !== 'private-maker') throw new Error('Jupiter is a non-executable localnet stub and cannot be reviewed for settlement.');
  return reviewFrozenSettlement(transactionBase64, {
    seller,
    quoteId: expected.quoteId,
    inputMint: expected.inputMint,
    outputMint: expected.outputMint,
    inputAmountAtomic: expected.inputAmountAtomic,
    grossOutputAtomic: expected.grossOutputAtomic,
    netOutputAtomic: expected.netOutputAtomic,
    feeBps: expected.feeBps,
    expiresAtMs: expected.expiresAtMs,
  }, nowMs);
}

function asSignTransactionFeature(value: unknown): SignTransactionApi | undefined {
  if (!value || typeof value !== 'object' || !('signTransaction' in value)) return undefined;
  const feature = value as Partial<SignTransactionApi>;
  return typeof feature.signTransaction === 'function' ? feature as SignTransactionApi : undefined;
}

/**
 * RFQ authorize path: Wallet Standard `solana:signTransaction` on the exact
 * issued winner bytes. Never uses sendTransaction / signAndSendTransaction.
 */
export async function signIssuedWinnerTransaction(
  account: UiWalletAccount,
  transactionBase64: string,
  chain: typeof EXPECTED_CHAIN = EXPECTED_CHAIN,
): Promise<string> {
  const feature = asSignTransactionFeature(getWalletAccountFeature(account, SolanaSignTransaction));
  if (!feature) {
    throw new Error('wallet does not expose signTransaction; managed signing is not supported');
  }
  if (!account.chains.includes(chain)) {
    throw new Error(`wallet is on the wrong cluster; expected ${chain}`);
  }

  const issued = bytesFromBase64(transactionBase64);
  const issuedMessage = serializedMessage(issued);
  const [output] = await feature.signTransaction({
    account: account as never,
    chain,
    transaction: issued,
  });
  const signed = new Uint8Array(output.signedTransaction);

  if (!sameBytes(serializedMessage(signed), issuedMessage)) {
    throw new Error('wallet modified the issued transaction message');
  }
  return base64FromBytes(signed);
}

export function explorerTxUrl(signature: string | undefined, chain: string = EXPECTED_CHAIN): string | undefined {
  if (!signature || signature.startsWith('mock-')) return undefined;
  if (chain === 'solana:localnet') {
    return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=custom&customUrl=${encodeURIComponent(LOCAL_RPC_URL)}`;
  }
  if (chain === 'solana:devnet') {
    return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
  }
  if (chain === 'solana:testnet') {
    return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=testnet`;
  }
  return `https://solscan.io/tx/${encodeURIComponent(signature)}`;
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
