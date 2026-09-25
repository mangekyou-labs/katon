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

export interface LocalnetSettlementSummary {
  readonly feePayer: string;
  readonly maker: string;
  readonly programId: string;
  readonly stockMint: string;
  readonly stableMint: string;
  readonly stockTokenProgram: string;
  readonly stableTokenProgram: string;
  readonly sellerStockAccount: string;
  readonly makerStockAccount: string;
  readonly makerStableAccount: string;
  readonly sellerStableAccount: string;
  readonly feeStableAccount: string;
  readonly feeRecipient: string;
  readonly assetRegistry: string;
  readonly makerRegistry: string;
  readonly governance: string;
  readonly fillReceipt: string;
  readonly stockDebitAtomic: string;
  readonly grossStableAtomic: string;
  readonly netStableMinimumAtomic: string;
  readonly feeAtomic: string;
  readonly feeBps: number;
  readonly quoteId: string;
  readonly expiresAtSeconds: number;
  readonly signerCount: 2;
  readonly executableInstructions: readonly string[];
}

const RFQ_PROGRAM_ID = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const SETTLE_PRIVATE_QUOTE_DISCRIMINATOR = 'd177c33bf6958696';

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

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  if (offset + 8 > bytes.length) throw new Error('The RFQ settlement instruction is truncated. Signing is blocked.');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function accountWritable(index: number, keyCount: number, requiredSignatures: number, readonlySigned: number, readonlyUnsigned: number): boolean {
  return index < requiredSignatures
    ? index < requiredSignatures - readonlySigned
    : index < keyCount - readonlyUnsigned;
}

/** Decode and constrain the exact RFQ v0 transaction before showing Seller review. */
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
    readonly expiresAtMs: number;
  },
  nowMs = Date.now(),
): LocalnetSettlementSummary {
  if (expected.sourceKind !== 'private-maker') {
    throw new Error('Jupiter is a non-executable localnet stub and cannot be reviewed for settlement.');
  }
  const bytes = bytesFromBase64(transactionBase64);
  const signatureCount = readShortVec(bytes, 0);
  if (!signatureCount || signatureCount.value !== 2 || signatureCount.next + 128 > bytes.length) {
    throw new Error('The RFQ settlement has an unexpected signer count. Signing is blocked.');
  }
  const messageStart = signatureCount.next + signatureCount.value * 64;
  const message = bytes.subarray(messageStart);
  if (message[0] !== 0x80 || message.length < 4 || message[1] !== signatureCount.value
    || bytes.subarray(signatureCount.next + 64, signatureCount.next + 128).every((byte) => byte === 0)) {
    throw new Error('The RFQ settlement is not a Maker-signed v0 message. Signing is blocked.');
  }
  const accountCount = readShortVec(message, 4);
  if (!accountCount || accountCount.value < 18) {
    throw new Error('The RFQ settlement account list is malformed. Signing is blocked.');
  }
  const keysStart = accountCount.next;
  const accountKeys = Array.from({ length: accountCount.value }, (_, index) => message.slice(keysStart + index * 32, keysStart + (index + 1) * 32));
  if (accountKeys.some((key) => key.length !== 32)) throw new Error('The RFQ settlement account list is malformed. Signing is blocked.');
  const keys = accountKeys.map((key) => encodeBase58(key));
  const feePayer = keys[0]!;
  if (feePayer !== seller) throw new Error('The RFQ settlement fee payer does not match the connected Seller. Signing is blocked.');
  const requiredSignatures = message[1]!;
  const readonlySigned = message[2]!;
  const readonlyUnsigned = message[3]!;
  if (requiredSignatures !== 2 || readonlySigned > 1 || readonlyUnsigned > accountKeys.length - requiredSignatures) {
    throw new Error('The RFQ settlement signer privileges are malformed. Signing is blocked.');
  }
  let offset = keysStart + accountCount.value * 32 + 32;
  const instructionCount = readShortVec(message, offset);
  if (!instructionCount || instructionCount.value < 2) throw new Error('The RFQ settlement must include compute budget and settlement instructions. Signing is blocked.');
  offset = instructionCount.next;
  const instructions: { program: string; accounts: number[]; data: Uint8Array }[] = [];
  for (let index = 0; index < instructionCount.value; index += 1) {
    const programIndex = message[offset++];
    if (programIndex === undefined || programIndex >= keys.length) throw new Error('The RFQ settlement has an unresolved instruction program. Signing is blocked.');
    const instructionAccounts = readShortVec(message, offset);
    if (!instructionAccounts) throw new Error('The RFQ settlement instruction accounts are malformed. Signing is blocked.');
    offset = instructionAccounts.next;
    const accountIndexes = Array.from(message.subarray(offset, offset + instructionAccounts.value));
    if (accountIndexes.length !== instructionAccounts.value || accountIndexes.some((accountIndex) => accountIndex >= keys.length)) {
      throw new Error('The RFQ settlement instruction account index is invalid. Signing is blocked.');
    }
    offset += instructionAccounts.value;
    const dataLength = readShortVec(message, offset);
    if (!dataLength || offset + (dataLength.next - offset) + dataLength.value > message.length) throw new Error('The RFQ settlement instruction data is malformed. Signing is blocked.');
    offset = dataLength.next;
    const data = message.slice(offset, offset + dataLength.value);
    offset += dataLength.value;
    instructions.push({ program: keys[programIndex]!, accounts: accountIndexes, data });
  }
  const lookups = readShortVec(message, offset);
  if (!lookups || lookups.value !== 0 || lookups.next !== message.length) {
    throw new Error('The RFQ settlement must use static v0 account keys without lookup tables. Signing is blocked.');
  }

  const settlement = instructions.filter((instruction) => instruction.program === RFQ_PROGRAM_ID);
  if (settlement.length !== 1 || settlement[0]!.accounts.length !== 17) {
    throw new Error('The RFQ settlement must contain exactly one settle_private_quote instruction. Signing is blocked.');
  }
  const computeInstructions = instructions.filter((instruction) => instruction.program === COMPUTE_BUDGET_PROGRAM_ID);
  if (instructions.length !== computeInstructions.length + settlement.length || computeInstructions.length !== 1
    || computeInstructions[0]!.accounts.length !== 0 || computeInstructions[0]!.data.length !== 5
    || computeInstructions[0]!.data[0] !== 2) {
    throw new Error('The RFQ settlement contains an unsupported executable instruction. Signing is blocked.');
  }
  const computeUnits = new DataView(computeInstructions[0]!.data.buffer, computeInstructions[0]!.data.byteOffset, 5).getUint32(1, true);
  if (computeUnits < 1 || computeUnits > 1_400_000) throw new Error('The RFQ settlement compute budget is invalid. Signing is blocked.');

  const ix = settlement[0]!;
  const roles = ix.accounts.map((accountIndex) => keys[accountIndex]!);
  const expectedProgramPrivileges = [
    [true, true], [true, true], [false, true], [false, true], [false, true], [false, true], [false, true],
    [false, false], [false, false], [false, false], [false, false], [false, false], [false, false],
    [false, false], [false, false], [false, true], [false, false],
  ] as const;
  ix.accounts.forEach((accountIndex, index) => {
    const [isSigner, isWritable] = expectedProgramPrivileges[index]!;
    if ((accountIndex < requiredSignatures) !== isSigner
      || accountWritable(accountIndex, keys.length, requiredSignatures, readonlySigned, readonlyUnsigned) !== isWritable) {
      throw new Error(`The RFQ settlement account ${index} privileges do not match the settlement ABI. Signing is blocked.`);
    }
  });
  const data = ix.data;
  if (data.length !== 122 || hex(data.subarray(0, 8)) !== SETTLE_PRIVATE_QUOTE_DISCRIMINATOR) {
    throw new Error('The RFQ settlement instruction does not match settle_private_quote. Signing is blocked.');
  }
  const quoteId = hex(data.subarray(8, 40));
  const issuedAtSeconds = Number(readU64(data, 40));
  const expiresAtSeconds = Number(readU64(data, 48));
  const stockDebitAtomic = readU64(data, 56).toString();
  const makerStockMinimum = readU64(data, 64).toString();
  const grossStableAtomic = readU64(data, 72).toString();
  const netStableMinimumAtomic = readU64(data, 80).toString();
  const feeBps = data[88]! | (data[89]! << 8);
  const feeAtomic = (BigInt(grossStableAtomic) * BigInt(feeBps) / 10_000n).toString();
  if (roles[0] !== seller || roles[1] === seller || roles[7] === seller || roles[16] !== '11111111111111111111111111111111'
    || quoteId !== expected.quoteId.toLowerCase() || roles[8] !== expected.inputMint || roles[9] !== expected.outputMint
    || stockDebitAtomic !== expected.inputAmountAtomic || makerStockMinimum !== stockDebitAtomic
    || grossStableAtomic !== expected.grossOutputAtomic || netStableMinimumAtomic !== expected.netOutputAtomic
    || BigInt(grossStableAtomic) - BigInt(feeAtomic) !== BigInt(netStableMinimumAtomic)
    || !Number.isSafeInteger(expected.expiresAtMs) || expiresAtSeconds !== Math.floor(expected.expiresAtMs / 1_000)
    || issuedAtSeconds > Math.floor(nowMs / 1_000) || expiresAtSeconds <= Math.floor(nowMs / 1_000)
    || expiresAtSeconds - issuedAtSeconds > 30 || feeBps > 25) {
    throw new Error('The RFQ settlement accounts, quote, net minimum, fee, or expiry do not match review. Signing is blocked.');
  }
  return {
    feePayer,
    maker: roles[1]!,
    programId: RFQ_PROGRAM_ID,
    stockMint: roles[8]!,
    stableMint: roles[9]!,
    stockTokenProgram: roles[10]!,
    stableTokenProgram: roles[11]!,
    sellerStockAccount: roles[2]!,
    makerStockAccount: roles[3]!,
    makerStableAccount: roles[4]!,
    sellerStableAccount: roles[5]!,
    feeStableAccount: roles[6]!,
    feeRecipient: roles[7]!,
    assetRegistry: roles[12]!,
    makerRegistry: roles[13]!,
    governance: roles[14]!,
    fillReceipt: roles[15]!,
    stockDebitAtomic,
    grossStableAtomic,
    netStableMinimumAtomic,
    feeAtomic,
    feeBps,
    quoteId,
    expiresAtSeconds,
    signerCount: 2,
    executableInstructions: [
      `Compute Budget · set limit ${computeUnits.toLocaleString()} CU`,
      'solana_rfq · settle_private_quote',
    ],
  };
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
