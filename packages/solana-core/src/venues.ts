import type { ExecutionEvidence, QuoteCandidate, QuoteSessionRequest } from './types';
import { parseSolanaTransaction } from './transactions';

export interface VenueOrderRequest extends QuoteSessionRequest {
  readonly quoteId: string;
}

export interface VenueOrderResult {
  readonly candidate: QuoteCandidate;
  readonly managedSigning: boolean;
}

export interface VenueAdapter {
  readonly name: string;
  order(request: VenueOrderRequest): Promise<VenueOrderResult>;
  execute(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<ExecutionEvidence>;
}

/** Compatibility seam: production maps this to Jupiter /order and /execute. */
export interface JupiterOrderPayload {
  readonly router: string;
  readonly transaction: string;
  readonly requestId: string;
  readonly outAmount: string;
  readonly platformFee?: string;
  readonly expiresAt?: number;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('transaction is not valid base64');
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
  if (encodeBase64(decoded) !== value) throw new Error('transaction is not canonical base64');
  return decoded;
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (!nodeBuffer) throw new Error('base64 encoder unavailable');
  return nodeBuffer.from(bytes).toString('base64');
}

export function assertJupiterPayloadUnchanged(issuedTransactionBase64: string, signedTransactionBase64: string): void {
  if (!issuedTransactionBase64 || !signedTransactionBase64) throw new Error('Jupiter transaction bytes are required');
  const issued = parseSolanaTransaction(decodeBase64(issuedTransactionBase64));
  const signed = parseSolanaTransaction(decodeBase64(signedTransactionBase64));
  if (!issued || !signed) {
    throw new Error('Jupiter transaction is malformed or uses an unsupported version');
  }
  const issuedMessage = issued.message;
  const signedMessage = signed.message;
  if (issuedMessage.length !== signedMessage.length || issuedMessage.some((byte, index) => byte !== signedMessage[index])) {
    throw new Error('Jupiter managed transaction message was mutated');
  }
}

export function routeIsInstructionBuildable(candidate: QuoteCandidate): boolean {
  const router = candidate.router.toLowerCase();
  const managedRoute = router.includes('jupiterz')
    || (router.includes('ondo') && (router.includes('managed') || router.includes('jit')))
    || (router.includes('jit') && router.includes('managed'));
  return !managedRoute;
}
