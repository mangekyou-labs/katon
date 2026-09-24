/**
 * Local/devnet helpers for building and partially signing Solana v0 wire bytes.
 * Production settlement still depends on venue-issued bytes; these builders exist
 * so Quote Sprint sources can emit honest 0x80 messages without a deployed program.
 */

import { createPrivateKey, createPublicKey, sign as signEd25519, verify as verifyEd25519Signature } from 'node:crypto';
import { readShortVec } from './transactions';
export { encodeBase58 } from './base58';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Documented local-only maker seed. Never use outside KATON_LOCALNET / test. */
export const LOCAL_MAKER_SEED = Buffer.alloc(32, 8);
/** Documented local-only seller seed used by demo fixtures. */
export const LOCAL_SELLER_SEED = Buffer.alloc(32, 7);

export function encodeShortVec(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('short vector value is invalid');
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

export function decodeBase58(value: string): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    number = number * 58n + BigInt(digit);
  }
  const decoded: number[] = [];
  while (number > 0n) {
    decoded.push(Number(number & 0xffn));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    decoded.push(0);
  }
  decoded.reverse();
  return Uint8Array.from(decoded);
}

export function decodeBase58Pubkey(value: string): Uint8Array {
  const bytes = decodeBase58(value);
  if (!bytes || bytes.length !== 32) throw new Error('wallet is not a valid base58 ed25519 public key');
  return bytes;
}

function pkcs8FromSeed(seed: Uint8Array) {
  if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  return Uint8Array.from(createPublicKey(pkcs8FromSeed(seed)).export({ format: 'der', type: 'spki' }).subarray(-32));
}

export function publicKeyFromSecretKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length === 64) return secretKey.slice(32);
  if (secretKey.length === 32) return publicKeyFromSeed(secretKey);
  throw new Error('ed25519 secret key must be 32 or 64 bytes');
}

export function seedFromSecretKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length === 64) return secretKey.slice(0, 32);
  if (secretKey.length === 32) return secretKey;
  throw new Error('ed25519 secret key must be 32 or 64 bytes');
}

export interface WireInstruction {
  readonly programIdIndex: number;
  readonly accountIndexes: readonly number[];
  readonly data: Uint8Array;
}

export interface BuildV0MessageInput {
  readonly feePayer: Uint8Array;
  readonly additionalSigners?: readonly Uint8Array[];
  /** Writable non-signers (placed before readonly unsigned accounts). */
  readonly writableUnsigned?: readonly Uint8Array[];
  readonly readonlyUnsigned?: readonly Uint8Array[];
  readonly recentBlockhash: Uint8Array;
  readonly instructions: readonly WireInstruction[];
}

/** Build a versioned (v0) message with prefix 0x80 and no address-table lookups. */
export function buildV0Message(input: BuildV0MessageInput): Uint8Array {
  const additionalSigners = input.additionalSigners ?? [];
  const writableUnsigned = input.writableUnsigned ?? [];
  const readonlyUnsigned = input.readonlyUnsigned ?? [];
  if (input.feePayer.length !== 32 || input.recentBlockhash.length !== 32) throw new Error('v0 message keys must be 32 bytes');
  if (
    additionalSigners.some((key) => key.length !== 32)
    || writableUnsigned.some((key) => key.length !== 32)
    || readonlyUnsigned.some((key) => key.length !== 32)
  ) {
    throw new Error('v0 message keys must be 32 bytes');
  }
  const requiredSignatures = 1 + additionalSigners.length;
  const accountKeys = [input.feePayer, ...additionalSigners, ...writableUnsigned, ...readonlyUnsigned];
  if (accountKeys.length > 256) throw new Error('v0 message account limit exceeded');
  const instructionBytes: Uint8Array[] = [];
  for (const instruction of input.instructions) {
    if (instruction.programIdIndex >= accountKeys.length) throw new Error('instruction program id is out of range');
    if (instruction.accountIndexes.some((index) => index >= accountKeys.length)) throw new Error('instruction account index is out of range');
    instructionBytes.push(Uint8Array.from([
      instruction.programIdIndex,
      ...encodeShortVec(instruction.accountIndexes.length),
      ...instruction.accountIndexes,
      ...encodeShortVec(instruction.data.length),
      ...instruction.data,
    ]));
  }
  return Uint8Array.from([
    0x80,
    requiredSignatures,
    0,
    readonlyUnsigned.length,
    ...encodeShortVec(accountKeys.length),
    ...accountKeys.flatMap((key) => [...key]),
    ...input.recentBlockhash,
    ...encodeShortVec(input.instructions.length),
    ...instructionBytes.flatMap((bytes) => [...bytes]),
    ...encodeShortVec(0),
  ]);
}

export function assembleSignedTransaction(message: Uint8Array, signatures: readonly Uint8Array[]): Uint8Array {
  if ((message[0] & 0x80) === 0) throw new Error('assembleSignedTransaction expects a v0 message');
  const requiredSignatures = message[1];
  if (signatures.length !== requiredSignatures) throw new Error('signature count does not match v0 message header');
  if (signatures.some((signature) => signature.length !== 64)) throw new Error('signatures must be 64 bytes');
  return Uint8Array.from([
    ...encodeShortVec(signatures.length),
    ...signatures.flatMap((signature) => [...signature]),
    ...message,
  ]);
}

export function partiallySignV0Transaction(input: {
  readonly message: Uint8Array;
  readonly signatures: readonly Uint8Array[];
  readonly signerIndex: number;
  readonly privateKey: Uint8Array;
}): { readonly message: Uint8Array; readonly signatures: Uint8Array[]; readonly transaction: Uint8Array } {
  if (input.message[0] !== 0x80) throw new Error('partiallySignV0Transaction requires a v0 message');
  const requiredSignatures = input.message[1];
  if (input.signerIndex < 0 || input.signerIndex >= requiredSignatures) throw new Error('signer index is out of range');
  if (input.signatures.length !== requiredSignatures) throw new Error('signature slots do not match message header');
  const seed = seedFromSecretKey(input.privateKey);
  const signature = Uint8Array.from(signEd25519(null, Buffer.from(input.message), pkcs8FromSeed(seed)));
  const signatures = input.signatures.map((slot, index) => (index === input.signerIndex ? signature : Uint8Array.from(slot)));
  return { message: input.message, signatures, transaction: assembleSignedTransaction(input.message, signatures) };
}

export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey)]),
      format: 'der',
      type: 'spki',
    });
    return verifyEd25519Signature(null, Buffer.from(message), Buffer.from(signature), key as never);
  } catch {
    return false;
  }
}

export interface QuoteBoundV0Input {
  readonly sellerPubkey: Uint8Array;
  readonly makerPubkey?: Uint8Array;
  readonly quoteId: string;
  readonly inputAmountAtomic: string;
  readonly outputAtomic: string;
  readonly recentBlockhash?: Uint8Array;
}

function systemProgramId(): Uint8Array {
  // System Program is Pubkey::default() — 32 zero bytes → base58 111…111.
  return new Uint8Array(32);
}

/** System Program Transfer (index 2) — lands on a real cluster. */
function systemTransferData(lamports: number | bigint): Uint8Array {
  const amount = BigInt(lamports);
  if (amount < 0n || amount > 0xffff_ffff_ffff_ffffn) throw new Error('lamports out of range');
  const data = new Uint8Array(4 + 8);
  data[0] = 2;
  const view = new DataView(data.buffer);
  view.setBigUint64(4, amount, true);
  return data;
}

/**
 * Minimal v0 settlement stand-in: System Program instruction whose data binds
 * quote terms. Private-maker quotes require seller (fee payer) + maker.
 * Prefer {@link buildLocalnetLandingV0Transaction} when the payload must land
 * on Surfpool / a validator (custom System Program data is rejected on-chain).
 */
export function buildQuoteBoundV0Transaction(input: QuoteBoundV0Input): {
  readonly message: Uint8Array;
  readonly signatures: Uint8Array[];
  readonly transaction: Uint8Array;
  readonly transactionBase64: string;
} {
  const systemProgram = systemProgramId();
  const recentBlockhash = input.recentBlockhash ?? new Uint8Array(32).fill(3);
  const instructionData = new TextEncoder().encode(`${input.quoteId}|${input.inputAmountAtomic}|${input.outputAtomic}`);
  const additionalSigners = input.makerPubkey ? [input.makerPubkey] : [];
  const message = buildV0Message({
    feePayer: input.sellerPubkey,
    additionalSigners,
    readonlyUnsigned: [systemProgram],
    recentBlockhash,
    instructions: [{
      programIdIndex: 1 + additionalSigners.length,
      accountIndexes: [0],
      data: instructionData,
    }],
  });
  const signatures = Array.from({ length: 1 + additionalSigners.length }, () => new Uint8Array(64));
  const transaction = assembleSignedTransaction(message, signatures);
  return {
    message,
    signatures,
    transaction,
    transactionBase64: Buffer.from(transaction).toString('base64'),
  };
}

export interface LocalnetLandingV0Input {
  readonly sellerPubkey: Uint8Array;
  /** When set, maker is a required co-signer and the transfer destination. */
  readonly makerPubkey?: Uint8Array;
  readonly recentBlockhash: Uint8Array;
  /** Lamports moved so the co-signed v0 lands. Default 1. */
  readonly lamports?: number | bigint;
}

/**
 * Honest localnet payload: 1-lamport System transfer that lands on Surfpool.
 * Private-maker quotes pass makerPubkey (co-signer + destination). Jupiter stub
 * omits it and self-transfers. Quote terms stay API hash-bound.
 */
export function buildLocalnetLandingV0Transaction(input: LocalnetLandingV0Input): {
  readonly message: Uint8Array;
  readonly signatures: Uint8Array[];
  readonly transaction: Uint8Array;
  readonly transactionBase64: string;
} {
  const systemProgram = systemProgramId();
  if (input.makerPubkey) {
    const message = buildV0Message({
      feePayer: input.sellerPubkey,
      additionalSigners: [input.makerPubkey],
      readonlyUnsigned: [systemProgram],
      recentBlockhash: input.recentBlockhash,
      instructions: [{
        // accounts: [seller=0, maker=1], program = system at index 2
        programIdIndex: 2,
        accountIndexes: [0, 1],
        data: systemTransferData(input.lamports ?? 1),
      }],
    });
    const signatures = [new Uint8Array(64), new Uint8Array(64)];
    const transaction = assembleSignedTransaction(message, signatures);
    return {
      message,
      signatures,
      transaction,
      transactionBase64: Buffer.from(transaction).toString('base64'),
    };
  }
  const message = buildV0Message({
    feePayer: input.sellerPubkey,
    readonlyUnsigned: [systemProgram],
    recentBlockhash: input.recentBlockhash,
    instructions: [{
      // seller self-transfer; program = system at index 1
      programIdIndex: 1,
      accountIndexes: [0, 0],
      data: systemTransferData(input.lamports ?? 1),
    }],
  });
  const signatures = [new Uint8Array(64)];
  const transaction = assembleSignedTransaction(message, signatures);
  return {
    message,
    signatures,
    transaction,
    transactionBase64: Buffer.from(transaction).toString('base64'),
  };
}

/** Decode a base58 blockhash from `getLatestBlockhash` into 32 bytes. */
export function blockhashBytesFromBase58(blockhash: string): Uint8Array {
  const bytes = decodeBase58(blockhash);
  if (!bytes || bytes.length !== 32) throw new Error('blockhash must be a 32-byte base58 value');
  return bytes;
}

export function isLocalnetMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KATON_LOCALNET === '1';
}

function parseSecretKeyEnv(value: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'number')) throw new Error('KATON_MAKER_SECRET_KEY JSON must be a byte array');
    return Uint8Array.from(parsed);
  }
  const decoded = decodeBase58(trimmed);
  if (!decoded || (decoded.length !== 32 && decoded.length !== 64)) throw new Error('KATON_MAKER_SECRET_KEY must be base58 32/64-byte secret or JSON byte array');
  return decoded;
}

/** Resolve the Private Maker signing key for local Quote Sprint issuance. */
export function resolveMakerSecretKey(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  if (env.KATON_MAKER_SECRET_KEY) return seedFromSecretKey(parseSecretKeyEnv(env.KATON_MAKER_SECRET_KEY));
  if (env.KATON_LOCALNET === '1' || env.VITEST || env.NODE_ENV === 'test') return Uint8Array.from(LOCAL_MAKER_SEED);
  throw new Error('KATON_MAKER_SECRET_KEY or KATON_LOCALNET=1 is required to issue private-maker quotes');
}

export function localSellerPublicKey(): Uint8Array {
  return publicKeyFromSeed(Uint8Array.from(LOCAL_SELLER_SEED));
}

export function localMakerPublicKey(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  return publicKeyFromSeed(resolveMakerSecretKey(env));
}

/** Extract required-signature account keys from a serialized v0 message. */
export function requiredSignerKeysFromMessage(message: Uint8Array): Uint8Array[] {
  if (message[0] !== 0x80) throw new Error('message is not v0');
  const requiredSignatures = message[1];
  const accountCount = readShortVec(message, 4);
  if (!accountCount || requiredSignatures > accountCount.value) throw new Error('v0 message header is malformed');
  const keysStart = accountCount.next;
  return Array.from({ length: requiredSignatures }, (_, index) => message.slice(keysStart + index * 32, keysStart + (index + 1) * 32));
}
