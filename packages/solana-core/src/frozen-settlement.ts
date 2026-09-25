import { encodeBase58 } from './base58';

const RFQ_PROGRAM_ID = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const SETTLE_PRIVATE_QUOTE_DISCRIMINATOR = 'd177c33bf6958696';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

export interface FrozenSettlementTerms {
  readonly seller: string;
  readonly quoteId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
  readonly grossOutputAtomic: string;
  readonly netOutputAtomic: string;
  readonly feeBps: number;
  readonly expiresAtMs: number;
}

export interface FrozenSettlementSummary {
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
  readonly extensionFingerprint: string;
  readonly signerCount: 2;
  readonly executableInstructions: readonly string[];
}

interface CompiledInstruction {
  readonly program: string;
  readonly accounts: readonly number[];
  readonly data: Uint8Array;
}

function fail(message: string): never {
  throw new Error(`${message}. Frozen settlement review failed.`);
}

function decodeBase64(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('Transaction is not valid base64');
  let decoded: Uint8Array;
  try {
    if (typeof atob === 'function') {
      const binary = atob(value);
      decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } else {
      const buffer = (globalThis as typeof globalThis & { Buffer?: { from(input: string, encoding: string): Uint8Array } }).Buffer;
      if (!buffer) fail('Base64 decoding is unavailable');
      decoded = new Uint8Array(buffer.from(value, 'base64'));
    }
  } catch {
    return fail('Transaction is not valid base64');
  }
  let canonical: string;
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of decoded) binary += String.fromCharCode(byte);
    canonical = btoa(binary);
  } else {
    const buffer = (globalThis as typeof globalThis & { Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer;
    if (!buffer) fail('Base64 encoding is unavailable');
    canonical = buffer.from(decoded).toString('base64');
  }
  if (canonical !== value) fail('Transaction base64 is not canonical');
  return decoded;
}

function readShortVec(bytes: Uint8Array, offset: number): { readonly value: number; readonly next: number } {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 3; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) fail('Transaction short vector is truncated');
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
    multiplier *= 128;
  }
  return fail('Transaction short vector is malformed');
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  if (offset + 8 > bytes.length) fail('RFQ settlement instruction is truncated');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function accountWritable(index: number, keyCount: number, requiredSignatures: number, readonlySigned: number, readonlyUnsigned: number): boolean {
  return index < requiredSignatures
    ? index < requiredSignatures - readonlySigned
    : index < keyCount - readonlyUnsigned;
}

function parseTransaction(bytes: Uint8Array): {
  readonly signatures: readonly Uint8Array[];
  readonly message: Uint8Array;
  readonly keys: readonly string[];
  readonly requiredSignatures: number;
  readonly readonlySigned: number;
  readonly readonlyUnsigned: number;
  readonly instructions: readonly CompiledInstruction[];
} {
  const signatureCount = readShortVec(bytes, 0);
  if (signatureCount.value !== 2 || signatureCount.next + 128 > bytes.length) fail('Settlement must have exactly two signer slots');
  const messageStart = signatureCount.next + signatureCount.value * 64;
  const message = bytes.subarray(messageStart);
  if (message[0] !== 0x80 || message.length < 4 || message[1] !== 2) fail('Settlement must be a v0 message with two required signers');
  const signatures = [
    bytes.slice(signatureCount.next, signatureCount.next + 64),
    bytes.slice(signatureCount.next + 64, signatureCount.next + 128),
  ];
  if (signatures[1]!.every((byte) => byte === 0)) fail('Maker signature slot is empty');
  const accountCount = readShortVec(message, 4);
  if (accountCount.value < 18) fail('Settlement account list is malformed');
  const keysStart = accountCount.next;
  const accountKeys = Array.from({ length: accountCount.value }, (_, index) => message.slice(keysStart + index * 32, keysStart + (index + 1) * 32));
  if (accountKeys.some((key) => key.length !== 32)) fail('Settlement account list is truncated');
  const keys = accountKeys.map(encodeBase58);
  const requiredSignatures = message[1]!;
  const readonlySigned = message[2]!;
  const readonlyUnsigned = message[3]!;
  if (requiredSignatures !== 2 || readonlySigned > 1 || readonlyUnsigned > accountKeys.length - requiredSignatures) fail('Settlement signer privileges are malformed');

  let offset = keysStart + accountCount.value * 32 + 32;
  const instructionCount = readShortVec(message, offset);
  offset = instructionCount.next;
  const instructions: CompiledInstruction[] = [];
  for (let index = 0; index < instructionCount.value; index += 1) {
    const programIndex = message[offset++];
    if (programIndex === undefined || programIndex >= keys.length) fail('Settlement instruction program is unresolved');
    const accountIndexes = readShortVec(message, offset);
    offset = accountIndexes.next;
    const accounts = Array.from(message.subarray(offset, offset + accountIndexes.value));
    if (accounts.length !== accountIndexes.value) fail('Settlement instruction account index is invalid');
    offset += accountIndexes.value;
    const dataLength = readShortVec(message, offset);
    offset = dataLength.next;
    if (offset + dataLength.value > message.length) fail('Settlement instruction data is truncated');
    const data = message.slice(offset, offset + dataLength.value);
    offset += dataLength.value;
    instructions.push({ program: keys[programIndex]!, accounts, data });
  }
  const lookups = readShortVec(message, offset);
  if (lookups.value !== 0 || lookups.next !== message.length) fail('Settlement must not use address lookup tables or trailing message data');
  if (instructions.some((instruction) => instruction.accounts.some((accountIndex) => accountIndex >= keys.length))) fail('Settlement instruction account index is invalid');
  return { signatures, message, keys, requiredSignatures, readonlySigned, readonlyUnsigned, instructions };
}

/** Parse and validate the frozen Seller Desk transaction through one browser-safe interface. */
export function reviewFrozenSettlement(
  transactionBase64: string,
  expected: FrozenSettlementTerms,
  nowMs = Date.now(),
): FrozenSettlementSummary {
  const transaction = parseTransaction(decodeBase64(transactionBase64));
  const { keys, instructions, requiredSignatures, readonlySigned, readonlyUnsigned } = transaction;
  const feePayer = keys[0]!;
  if (feePayer !== expected.seller) fail('Settlement fee payer does not match the Seller');
  if (!/^[0-9a-fA-F]{64}$/.test(expected.quoteId)) fail('Expected quote ID is invalid');
  if (![expected.inputAmountAtomic, expected.grossOutputAtomic, expected.netOutputAtomic].every((amount) => /^[1-9][0-9]*$/.test(amount))) fail('Expected settlement amounts are invalid');
  if (!Number.isSafeInteger(expected.feeBps) || expected.feeBps < 0 || expected.feeBps > 25) fail('Expected settlement fee is invalid');

  const settlements = instructions.filter((instruction) => instruction.program === RFQ_PROGRAM_ID);
  const computeLimits = instructions.filter((instruction) => instruction.program === COMPUTE_BUDGET_PROGRAM_ID);
  if (instructions.length !== 2 || settlements.length !== 1 || computeLimits.length !== 1
    || instructions[0] !== computeLimits[0] || instructions[1] !== settlements[0]) {
    fail('Settlement must contain one compute limit followed by one RFQ settlement instruction and no other instructions');
  }
  const compute = computeLimits[0]!;
  if (compute.accounts.length !== 0 || compute.data.length !== 5 || compute.data[0] !== 2) fail('Settlement compute instruction must set a unit limit');
  const computeUnits = new DataView(compute.data.buffer, compute.data.byteOffset, compute.data.byteLength).getUint32(1, true);
  if (computeUnits < 1 || computeUnits > 1_400_000) fail('Settlement compute limit is outside the permitted range');

  const instruction = settlements[0]!;
  if (instruction.accounts.length !== 17) fail('RFQ settlement account list does not match the settlement ABI');
  const expectedPrivileges = [
    [true, true], [true, true], [false, true], [false, true], [false, true], [false, true], [false, true],
    [false, false], [false, false], [false, false], [false, false], [false, false], [false, false],
    [false, false], [false, false], [false, true], [false, false],
  ] as const;
  instruction.accounts.forEach((accountIndex, index) => {
    const [signer, writable] = expectedPrivileges[index]!;
    if ((accountIndex < requiredSignatures) !== signer
      || accountWritable(accountIndex, keys.length, requiredSignatures, readonlySigned, readonlyUnsigned) !== writable) {
      fail(`RFQ settlement account ${index} privileges do not match the ABI`);
    }
  });
  const roles = instruction.accounts.map((accountIndex) => keys[accountIndex]!);
  const data = instruction.data;
  if (data.length !== 122 || hex(data.subarray(0, 8)) !== SETTLE_PRIVATE_QUOTE_DISCRIMINATOR) fail('RFQ instruction does not match settle_private_quote');
  const quoteId = hex(data.subarray(8, 40));
  const issuedAtSeconds = Number(readU64(data, 40));
  const expiresAtSeconds = Number(readU64(data, 48));
  const stockDebitAtomic = readU64(data, 56).toString();
  const makerStockMinimum = readU64(data, 64).toString();
  const grossStableAtomic = readU64(data, 72).toString();
  const netStableMinimumAtomic = readU64(data, 80).toString();
  const feeBps = data[88]! | (data[89]! << 8);
  const feeAtomic = (BigInt(grossStableAtomic) * BigInt(feeBps) / 10_000n).toString();
  if (roles[0] !== expected.seller || roles[1] === expected.seller || roles[7] === expected.seller
    || roles[16] !== SYSTEM_PROGRAM_ID || quoteId !== expected.quoteId.toLowerCase()
    || roles[8] !== expected.inputMint || roles[9] !== expected.outputMint
    || stockDebitAtomic !== expected.inputAmountAtomic || makerStockMinimum !== stockDebitAtomic
    || grossStableAtomic !== expected.grossOutputAtomic || netStableMinimumAtomic !== expected.netOutputAtomic
    || feeBps !== expected.feeBps || BigInt(grossStableAtomic) - BigInt(feeAtomic) !== BigInt(netStableMinimumAtomic)
    || !Number.isSafeInteger(expected.expiresAtMs) || expiresAtSeconds !== Math.floor(expected.expiresAtMs / 1_000)
    || issuedAtSeconds > Math.floor(nowMs / 1_000) || expiresAtSeconds <= Math.floor(nowMs / 1_000)
    || expiresAtSeconds - issuedAtSeconds > 30) {
    fail('Settlement accounts, quote terms, fee, or expiry do not match review');
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
    extensionFingerprint: hex(data.subarray(90, 122)),
    signerCount: 2,
    executableInstructions: [
      `Compute Budget · set limit ${computeUnits.toLocaleString()} CU`,
      'solana_rfq · settle_private_quote',
    ],
  };
}
