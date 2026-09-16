import type { QuoteCandidate } from '@katon/solana-core';

const encoder = new TextEncoder();

export function bytesFromBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('value is not valid base64');
  }
  if (typeof atob === 'function') {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
  const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
  if (!nodeBuffer) throw new Error('base64 decoder unavailable');
  return nodeBuffer.from(value, 'base64');
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

function readShortVec(bytes: Uint8Array, offset: number): { readonly value: number; readonly next: number } | undefined {
  let value = 0;
  let size = 0;
  for (let index = offset; index < bytes.length && size < 3; index += 1) {
    const byte = bytes[index];
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if ((byte & 0x80) === 0) return { value, next: index + 1 };
  }
  return undefined;
}

/**
 * Solana signatures are a short-vector count followed by 64-byte signatures;
 * the remaining bytes are the legacy or versioned message. This small parser
 * lets a wallet replace signatures without changing the issued message.
 */
export function serializedMessage(bytes: Uint8Array): Uint8Array {
  const signatureCount = readShortVec(bytes, 0);
  if (!signatureCount) return bytes;
  const messageOffset = signatureCount.next + signatureCount.value * 64;
  return messageOffset <= bytes.length ? bytes.slice(messageOffset) : bytes;
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
}

export async function validateSignedTransaction(
  signedTransactionBase64: string,
  binding: SignedTransactionBinding,
  nowMs = Date.now(),
): Promise<{ readonly ok: true; readonly signedTransactionHash: string } | { readonly ok: false; readonly code: 'expired' | 'hash_mismatch' | 'malformed'; readonly message: string }> {
  if (nowMs >= binding.expiresAtMs) return { ok: false, code: 'expired', message: 'quote expired; request a fresh quote' };
  if (!signedTransactionBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signedTransactionBase64)) {
    return { ok: false, code: 'malformed', message: 'signed transaction is not valid base64' };
  }
  try {
    const signedTransactionHash = await transactionHash(signedTransactionBase64);
    if (signedTransactionHash !== binding.issuedTransactionHash) {
      return { ok: false, code: 'hash_mismatch', message: `signed transaction does not match issued quote ${binding.issuedQuoteId}` };
    }
    return { ok: true, signedTransactionHash };
  } catch {
    return { ok: false, code: 'malformed', message: 'signed transaction could not be decoded' };
  }
}

export function preserveJupiterTransaction(candidate: QuoteCandidate): string {
  if (candidate.sourceKind !== 'jupiter' || !candidate.transactionBase64) throw new Error('Jupiter candidate has no issued transaction');
  return candidate.transactionBase64;
}
