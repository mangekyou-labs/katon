import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function botBodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function botRequestSignature(token: string, method: string, path: string, timestamp: number, digest: string): string {
  return createHmac('sha256', token).update(`${method.toUpperCase()}\n${path}\n${timestamp}\n${digest}`, 'utf8').digest('hex');
}

export function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
