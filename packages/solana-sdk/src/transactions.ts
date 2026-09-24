import { parseSolanaTransaction, serializedMessage as extractSerializedMessage } from '../../solana-core/src/transactions';
import type { QuoteCandidate } from '@katon/solana-core';

const encoder = new TextEncoder();

export function bytesFromBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('value is not valid base64');
  }
  let decoded: Uint8Array;
  if (typeof atob === 'function') {
    const binary = atob(value);
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } else {
    const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
    if (!nodeBuffer) throw new Error('base64 decoder unavailable');
    decoded = nodeBuffer.from(value, 'base64');
  }
  // RFC 4648 permits non-zero pad bits, but accepting those aliases would
  // give the same transaction bytes multiple textual identities. A signed
  // transaction binding must use one canonical representation everywhere.
  if (base64FromBytes(decoded) !== value) throw new Error('value is not canonical base64');
  return decoded;
}

export function base64FromBytes(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (!nodeBuffer) throw new Error('base64 encoder unavailable');
  return nodeBuffer.from(bytes).toString('base64');
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bytesFromBase58(value: string): Uint8Array | undefined {
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
  const bytes = Uint8Array.from(decoded);
  return bytes.length === 32 ? bytes : undefined;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function verifiesEd25519Signature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return false;
    const key = await subtle.importKey('raw', asArrayBuffer(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, key, asArrayBuffer(signature), asArrayBuffer(message));
  } catch {
    return false;
  }
}

/**
 * Solana signatures are a short-vector count followed by 64-byte signatures;
 * the remaining bytes are the legacy or versioned message. This small parser
 * lets a wallet replace signatures without changing the issued message.
 */
export function serializedMessage(bytes: Uint8Array): Uint8Array {
  return extractSerializedMessage(bytes);
}

export function serializedMessageFromBase64(value: string): Uint8Array {
  return serializedMessage(bytesFromBase64(value));
}

export async function sha256Base64(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer as ArrayBuffer);
  return base64FromBytes(new Uint8Array(digest));
}

export async function transactionHash(transactionBase64: string): Promise<string> {
  return sha256Base64(serializedMessageFromBase64(transactionBase64));
}

export interface SignedTransactionBinding {
  readonly wallet: string;
  readonly issuedTransactionHash: string;
  readonly issuedQuoteId: string;
  readonly expiresAtMs: number;
  /** When set, the matching signer slot must carry a valid maker Ed25519 signature. */
  readonly makerPublicKey?: string;
}

export async function validateSignedTransaction(
  signedTransactionBase64: string,
  binding: SignedTransactionBinding,
  nowMs = Date.now(),
): Promise<{ readonly ok: true; readonly signedTransactionHash: string } | { readonly ok: false; readonly code: 'expired' | 'hash_mismatch' | 'wallet_mismatch' | 'signature_invalid' | 'malformed'; readonly message: string }> {
  if (nowMs >= binding.expiresAtMs) return { ok: false, code: 'expired', message: 'quote expired; request a fresh quote' };
  if (!signedTransactionBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signedTransactionBase64)) {
    return { ok: false, code: 'malformed', message: 'signed transaction is not valid base64' };
  }
  try {
    const bytes = bytesFromBase64(signedTransactionBase64);
    if (base64FromBytes(bytes) !== signedTransactionBase64) return { ok: false, code: 'malformed', message: 'signed transaction is not canonical base64' };
    const signedTransactionHash = await transactionHash(signedTransactionBase64);
    if (signedTransactionHash !== binding.issuedTransactionHash) {
      return { ok: false, code: 'hash_mismatch', message: `signed transaction does not match issued quote ${binding.issuedQuoteId}` };
    }
    const parsed = parseSolanaTransaction(bytes);
    const walletKey = bytesFromBase58(binding.wallet);
    if (!parsed) return { ok: false, code: 'malformed', message: 'signed transaction message is malformed' };
    if (parsed.version !== 'v0') return { ok: false, code: 'malformed', message: 'signed transaction must be Solana v0' };
    if (!walletKey) return { ok: false, code: 'wallet_mismatch', message: 'signed transaction does not contain the requested wallet as a signer' };
    const signerIndex = parsed.signerKeys.findIndex((key) => key.every((byte, index) => byte === walletKey[index]));
    if (signerIndex < 0) return { ok: false, code: 'wallet_mismatch', message: 'signed transaction does not contain the requested wallet as a signer' };
    const signature = parsed.signatures[signerIndex];
    if (!signature || signature.every((byte) => byte === 0) || !(await verifiesEd25519Signature(walletKey, signature, parsed.message))) {
      return { ok: false, code: 'signature_invalid', message: 'wallet signature is invalid for the issued Solana message' };
    }
    if (binding.makerPublicKey) {
      const makerKey = bytesFromBase58(binding.makerPublicKey);
      if (!makerKey) return { ok: false, code: 'signature_invalid', message: 'maker public key is malformed' };
      const makerIndex = parsed.signerKeys.findIndex((key) => key.every((byte, index) => byte === makerKey[index]));
      if (makerIndex < 0) return { ok: false, code: 'signature_invalid', message: 'signed transaction does not contain the configured maker as a signer' };
      const makerSignature = parsed.signatures[makerIndex];
      if (!makerSignature || makerSignature.every((byte) => byte === 0) || !(await verifiesEd25519Signature(makerKey, makerSignature, parsed.message))) {
        return { ok: false, code: 'signature_invalid', message: 'maker signature is invalid for the issued Solana message' };
      }
    }
    return { ok: true, signedTransactionHash };
  } catch {
    return { ok: false, code: 'malformed', message: 'signed transaction could not be decoded' };
  }
}

/** Verifies a maker's v0 partial signature before the seller adds their signature. */
export async function validateMakerPartialTransaction(
  transactionBase64: string,
  makerPublicKey: string,
  expectedMessageHash: string,
  expiresAtMs: number,
  nowMs = Date.now(),
): Promise<{ readonly ok: true; readonly messageHash: string } | { readonly ok: false; readonly message: string }> {
  if (!Number.isSafeInteger(expiresAtMs) || nowMs >= expiresAtMs) return { ok: false, message: 'maker quote is expired' };
  try {
    const bytes = bytesFromBase64(transactionBase64);
    const messageHash = await transactionHash(transactionBase64);
    if (messageHash !== expectedMessageHash) return { ok: false, message: 'maker transaction hash does not match commitment' };
    const parsed = parseSolanaTransaction(bytes);
    if (!parsed || parsed.version !== 'v0') return { ok: false, message: 'maker transaction must be a valid v0 message' };
    const expectedKey = bytesFromBase58(makerPublicKey);
    if (!expectedKey) return { ok: false, message: 'maker public key is malformed' };
    const signerIndex = parsed.signerKeys.findIndex((key) => key.every((byte, index) => byte === expectedKey[index]));
    const signature = signerIndex < 0 ? undefined : parsed.signatures[signerIndex];
    if (!signature || signature.every((byte) => byte === 0) || !(await verifiesEd25519Signature(expectedKey, signature, parsed.message))) {
      return { ok: false, message: 'maker partial signature is invalid for the frozen v0 message' };
    }
    return { ok: true, messageHash };
  } catch { return { ok: false, message: 'maker transaction could not be decoded' }; }
}

export function preserveJupiterTransaction(candidate: QuoteCandidate): string {
  if (candidate.sourceKind !== 'jupiter' || !candidate.transactionBase64) throw new Error('Jupiter candidate has no issued transaction');
  return candidate.transactionBase64;
}
