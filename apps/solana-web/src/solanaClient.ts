import { createClient } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { walletSigner } from '@solana/kit-plugin-wallet';
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { getWalletAccountFeature, type UiWalletAccount } from '@wallet-standard/ui';
import { encodeBase58 } from '../../../packages/solana-core/src/base58';
import { base64FromBytes, bytesFromBase64, serializedMessage } from '../../../packages/solana-sdk/src/index';

export const EXPECTED_CHAIN = 'solana:localnet' as const;
export const LOCAL_RPC_URL = 'http://127.0.0.1:8899';

export const solanaKitClient = createClient()
  .use(walletSigner({ chain: EXPECTED_CHAIN }))
  .use(solanaRpc({ rpcUrl: LOCAL_RPC_URL }));

export type AppSolanaClient = typeof solanaKitClient;

export interface LocalnetProofSummary {
  readonly feePayer: string;
  readonly recipient: string;
  readonly lamports: 1;
  readonly systemProgram: '11111111111111111111111111111111';
  readonly signerCount: 1 | 2;
}

type SignTransactionApi = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readShortVec(bytes: Uint8Array, offset: number): { readonly value: number; readonly next: number } | undefined {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 3; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) return undefined;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
    multiplier *= 128;
  }
  return undefined;
}

/** Decode and constrain the localnet landing transaction before showing review. */
export function inspectLocalnetProofTransaction(
  transactionBase64: string,
  seller: string,
  sourceKind: 'jupiter' | 'private-maker',
): LocalnetProofSummary {
  const bytes = bytesFromBase64(transactionBase64);
  const signatureCount = readShortVec(bytes, 0);
  if (!signatureCount || signatureCount.value !== (sourceKind === 'private-maker' ? 2 : 1)) {
    throw new Error('The localnet proof transaction has an unexpected signer count. Signing is blocked.');
  }
  const messageStart = signatureCount.next + signatureCount.value * 64;
  const message = bytes.subarray(messageStart);
  if (message[0] !== 0x80 || message.length < 4 || message[1] !== signatureCount.value) {
    throw new Error('The localnet proof transaction is not the expected v0 message. Signing is blocked.');
  }
  const accountCount = readShortVec(message, 4);
  const systemProgramIndex = sourceKind === 'private-maker' ? 2 : 1;
  const expectedAccountCount = systemProgramIndex + 1;
  if (!accountCount || accountCount.value !== expectedAccountCount) {
    throw new Error('The localnet proof transaction has unexpected accounts. Signing is blocked.');
  }
  const keysStart = accountCount.next;
  const accountKeys = Array.from({ length: accountCount.value }, (_, index) => message.slice(keysStart + index * 32, keysStart + (index + 1) * 32));
  if (accountKeys.some((key) => key.length !== 32)) throw new Error('The localnet proof transaction account list is malformed. Signing is blocked.');
  const feePayer = encodeBase58(accountKeys[0]);
  const recipientIndex = sourceKind === 'private-maker' ? 1 : 0;
  const recipient = encodeBase58(accountKeys[recipientIndex]);
  const systemProgram = encodeBase58(accountKeys[systemProgramIndex]);
  if (feePayer !== seller || systemProgram !== '11111111111111111111111111111111') {
    throw new Error('The localnet proof transaction fee payer or program does not match review. Signing is blocked.');
  }
  if (sourceKind === 'private-maker' && recipient === seller) {
    throw new Error('The private-maker proof transfer must name the maker as recipient. Signing is blocked.');
  }
  if (sourceKind === 'jupiter' && recipient !== seller) {
    throw new Error('The Jupiter demo proof transfer must return to the seller. Signing is blocked.');
  }

  let offset = keysStart + accountCount.value * 32 + 32; // account keys + recent blockhash
  const instructionCount = readShortVec(message, offset);
  if (!instructionCount || instructionCount.value !== 1) throw new Error('The localnet proof transaction must contain one instruction. Signing is blocked.');
  offset = instructionCount.next;
  const programIndex = message[offset++];
  const instructionAccounts = readShortVec(message, offset);
  if (!instructionAccounts || instructionAccounts.value !== 2) throw new Error('The localnet proof transfer accounts are unexpected. Signing is blocked.');
  offset = instructionAccounts.next;
  const accountIndexes = message.subarray(offset, offset + instructionAccounts.value);
  offset += instructionAccounts.value;
  const dataLength = readShortVec(message, offset);
  if (!dataLength || dataLength.value !== 12) throw new Error('The localnet proof transfer data is malformed. Signing is blocked.');
  offset = dataLength.next;
  const data = message.subarray(offset, offset + dataLength.value);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const addressTableLookups = readShortVec(message, offset + dataLength.value);
  if (
    !addressTableLookups
    || addressTableLookups.value !== 0
    || addressTableLookups.next !== message.length
    || programIndex !== systemProgramIndex
    || accountIndexes[0] !== 0
    || accountIndexes[1] !== recipientIndex
    || view.getUint32(0, true) !== 2
    || view.getBigUint64(4, true) !== 1n
  ) {
    throw new Error('The localnet transaction is not the expected 1 lamport System Program transfer. Signing is blocked.');
  }
  return { feePayer, recipient, lamports: 1, systemProgram, signerCount: signatureCount.value as 1 | 2 };
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
