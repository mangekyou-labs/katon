import type { QuoteCandidate, QuoteSessionRequest } from './types';

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
  execute(candidate: QuoteCandidate, signedTransactionBase64: string): Promise<{ readonly signature: string }>;
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
  if (typeof atob === 'function') {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
  const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
  if (!nodeBuffer) throw new Error('base64 decoder unavailable');
  return nodeBuffer.from(value, 'base64');
}

function serializedMessage(bytes: Uint8Array): Uint8Array {
  let count = 0;
  let shift = 0;
  let offset = 0;
  for (; offset < bytes.length && offset < 3; offset += 1) {
    const byte = bytes[offset];
    count |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (offset >= bytes.length || (bytes[offset] & 0x80) !== 0) return bytes;
  const messageOffset = offset + 1 + count * 64;
  return messageOffset <= bytes.length ? bytes.slice(messageOffset) : bytes;
}

export function assertJupiterPayloadUnchanged(issuedTransactionBase64: string, signedTransactionBase64: string): void {
  if (!issuedTransactionBase64 || !signedTransactionBase64) throw new Error('Jupiter transaction bytes are required');
  const issuedMessage = serializedMessage(decodeBase64(issuedTransactionBase64));
  const signedMessage = serializedMessage(decodeBase64(signedTransactionBase64));
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
