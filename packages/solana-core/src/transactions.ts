/**
 * Strict parser for the wire format of a signed Solana transaction.
 *
 * Keeping this parser in core makes the venue and wallet boundaries agree on
 * exactly what a legacy or v0 transaction contains.  In particular, a byte
 * sequence is not considered a transaction merely because it has a plausible
 * signature count: every length prefix is canonical, every instruction is
 * bounded, and no trailing bytes are accepted.
 */

export type SolanaTransactionVersion = 'legacy' | 'v0';

export interface ParsedSolanaTransaction {
  readonly message: Uint8Array;
  readonly signatures: readonly Uint8Array[];
  readonly signerKeys: readonly Uint8Array[];
  readonly version: SolanaTransactionVersion;
}

interface CursorValue {
  readonly value: number;
  readonly next: number;
}

/** Solana's short-vector encoding, with canonical/minimal representation. */
export function readShortVec(bytes: Uint8Array, offset: number): CursorValue | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) return undefined;
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 3; index += 1) {
    const position = offset + index;
    if (position >= bytes.length) return undefined;
    const byte = bytes[position];
    value += (byte & 0x7f) * multiplier;
    const continuation = (byte & 0x80) !== 0;
    if (!continuation) {
      // 0x80 0x00 and similar encodings are not canonical short vectors.
      if (index > 0 && value < 2 ** (7 * index)) return undefined;
      return { value, next: position + 1 };
    }
    multiplier *= 128;
  }
  return undefined;
}

function take(bytes: Uint8Array, offset: number, length: number): Uint8Array | undefined {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) return undefined;
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > bytes.length) return undefined;
  return bytes.slice(offset, end);
}

function parseCompiledInstructions(
  message: Uint8Array,
  offset: number,
  accountCount: number,
  deferAccountBounds = false,
): { readonly next: number; readonly maxAccountIndex: number } | undefined {
  const instructionCount = readShortVec(message, offset);
  if (!instructionCount || instructionCount.value > 65_535) return undefined;
  offset = instructionCount.next;
  let maxAccountIndex = -1;
  for (let index = 0; index < instructionCount.value; index += 1) {
    const programIdIndex = message[offset];
    if (programIdIndex === undefined || programIdIndex >= accountCount) return undefined;
    maxAccountIndex = Math.max(maxAccountIndex, programIdIndex);
    offset += 1;
    const accountIndexes = readShortVec(message, offset);
    if (!accountIndexes || accountIndexes.value > 65_535) return undefined;
    offset = accountIndexes.next;
    const indexes = take(message, offset, accountIndexes.value);
    if (!indexes) return undefined;
    for (const accountIndex of indexes) {
      if (accountIndex >= accountCount) return undefined;
      maxAccountIndex = Math.max(maxAccountIndex, accountIndex);
    }
    offset += accountIndexes.value;
    const dataLength = readShortVec(message, offset);
    if (!dataLength || dataLength.value > 65_535) return undefined;
    offset = dataLength.next;
    if (!take(message, offset, dataLength.value)) return undefined;
    offset += dataLength.value;
  }
  return { next: offset, maxAccountIndex: deferAccountBounds ? maxAccountIndex : Math.min(maxAccountIndex, accountCount - 1) };
}

function parseAddressTableLookups(message: Uint8Array, offset: number): { readonly next: number; readonly addressCount: number } | undefined {
  const lookupCount = readShortVec(message, offset);
  if (!lookupCount || lookupCount.value > 256) return undefined;
  offset = lookupCount.next;
  let addressCount = 0;
  for (let index = 0; index < lookupCount.value; index += 1) {
    if (!take(message, offset, 32)) return undefined;
    offset += 32;
    const writable = readShortVec(message, offset);
    if (!writable || writable.value > 255) return undefined;
    offset = writable.next;
    if (!take(message, offset, writable.value)) return undefined;
    offset += writable.value;
    addressCount += writable.value;
    const readonly = readShortVec(message, offset);
    if (!readonly || readonly.value > 255) return undefined;
    offset = readonly.next;
    if (!take(message, offset, readonly.value)) return undefined;
    offset += readonly.value;
    addressCount += readonly.value;
  }
  return { next: offset, addressCount };
}

function parseMessage(message: Uint8Array, signatureCount: number): {
  readonly version: SolanaTransactionVersion;
  readonly signerKeys: readonly Uint8Array[];
} | undefined {
  if (message.length < 3) return undefined;
  let offset = 0;
  let version: SolanaTransactionVersion = 'legacy';
  if ((message[0] & 0x80) !== 0) {
    // Only v0 is supported by the desk; accepting a future version would make
    // signature binding and route validation ambiguous.
    if (message[0] !== 0x80) return undefined;
    version = 'v0';
    offset = 1;
  }
  if (message.length < offset + 3) return undefined;
  const requiredSignatures = message[offset];
  const readonlySigned = message[offset + 1];
  const readonlyUnsigned = message[offset + 2];
  if (requiredSignatures === 0 || readonlySigned > requiredSignatures || requiredSignatures + readonlyUnsigned > 255) return undefined;
  const accountCount = readShortVec(message, offset + 3);
  if (
    !accountCount
    || accountCount.value === 0
    || accountCount.value > 256
    || requiredSignatures > accountCount.value
    || requiredSignatures + readonlyUnsigned > accountCount.value
  ) return undefined;
  if (signatureCount !== requiredSignatures) return undefined;
  offset = accountCount.next;
  const accountKeys = take(message, offset, accountCount.value * 32);
  if (!accountKeys) return undefined;
  const signerKeys = Array.from({ length: requiredSignatures }, (_, index) => accountKeys.slice(index * 32, (index + 1) * 32));
  offset += accountKeys.length;
  if (!take(message, offset, 32)) return undefined;
  offset += 32;
  const instructions = parseCompiledInstructions(message, offset, version === 'v0' ? 256 : accountCount.value, version === 'v0');
  if (!instructions) return undefined;
  offset = instructions.next;
  let loadedAddressCount = 0;
  if (version === 'v0') {
    const lookups = parseAddressTableLookups(message, offset);
    if (!lookups) return undefined;
    offset = lookups.next;
    loadedAddressCount = lookups.addressCount;
    if (accountCount.value + loadedAddressCount > 256) return undefined;
  }
  if (instructions.maxAccountIndex >= accountCount.value + loadedAddressCount || offset !== message.length) return undefined;
  return { version, signerKeys };
}

/** Parse and validate a complete signed legacy/v0 transaction. */
export function parseSolanaTransaction(bytes: Uint8Array): ParsedSolanaTransaction | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return undefined;
  const signatureCount = readShortVec(bytes, 0);
  if (!signatureCount || signatureCount.value <= 0 || signatureCount.value > 64) return undefined;
  const signaturesStart = signatureCount.next;
  const signaturesEnd = signaturesStart + signatureCount.value * 64;
  if (!Number.isSafeInteger(signaturesEnd) || signaturesEnd > bytes.length) return undefined;
  const message = bytes.slice(signaturesEnd);
  const parsedMessage = parseMessage(message, signatureCount.value);
  if (!parsedMessage) return undefined;
  const signatures = Array.from({ length: signatureCount.value }, (_, index) => bytes.slice(signaturesStart + index * 64, signaturesStart + (index + 1) * 64));
  return { message, signatures, signerKeys: parsedMessage.signerKeys, version: parsedMessage.version };
}

/** Extract a validated serialized message for hashing. */
export function serializedMessage(bytes: Uint8Array): Uint8Array {
  const parsed = parseSolanaTransaction(bytes);
  if (!parsed) throw new Error('Solana transaction is malformed or uses an unsupported version');
  return parsed.message;
}
