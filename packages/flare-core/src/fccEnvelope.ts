import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { decodeAbiParameters, encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';

export type { Hex };

const MAX_ENVELOPE_BYTES = 256 * 1024;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const RECIPIENT_COUNT = 3 as const;

/** FCC operation identifiers are right-padded ASCII bytes32 values. */
export function bytes32Identifier(value: string): Hex {
  if (!value || value.length > 32) throw new Error('FCC_IDENTIFIER');
  const result = new Uint8Array(32); result.set(new TextEncoder().encode(value));
  return bytesToHex(result);
}

export interface FccEnvelopeMetadata {
  readonly chainId: number | bigint;
  readonly extensionId: Hex;
  readonly actionId: Hex;
  readonly opType: string | Hex;
  readonly command: string | Hex;
  readonly expiry: number | bigint;
}
export interface FccRecipient { readonly teeId: Hex; readonly keyId: Hex; readonly ciphertext: Hex; }
export interface FccRecipientEnvelopeV1 extends FccEnvelopeMetadata {
  readonly version: 1;
  readonly plaintextCommitment: Hex;
  readonly recipients: readonly [FccRecipient, FccRecipient, FccRecipient];
  readonly encoded: Hex;
}
export interface FccEncryptionRecipient { readonly teeId: Hex | string; readonly keyId: Hex | string; readonly publicKey: Uint8Array | Hex; }
export interface FccEncryptionOptions { readonly ephemeralPrivateKeys?: readonly [Uint8Array, Uint8Array, Uint8Array]; readonly nonces?: readonly [Uint8Array, Uint8Array, Uint8Array]; }
export interface FccProxyInfo { readonly extensionId: string | number; readonly version: string; readonly teeId: string; readonly encryptionPublicKey: Hex; readonly encryptionKeyId?: string; }
export interface FccProxySource { readonly url: string; readonly teeId?: string; }
export interface FccProxyFetchOptions { readonly fetcher?: typeof fetch; readonly allowHttpLocalhost?: boolean; }

const ENVELOPE_TYPES = [
  { type: 'uint8' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
  { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' },
  { type: 'bytes32[3]' }, { type: 'bytes32[3]' }, { type: 'bytes[3]' },
] as const;

/** ABI encoding used by both the browser client and the Go handler. */
export function encodeFccRecipientEnvelope(envelope: Omit<FccRecipientEnvelopeV1, 'encoded'>): Hex {
  const checked = validateEnvelope(envelope);
  return encodeAbiParameters(ENVELOPE_TYPES, [checked.version, BigInt(checked.chainId), checked.extensionId, checked.actionId, bytes32Identifier(checked.opType), bytes32Identifier(checked.command), BigInt(checked.expiry), checked.plaintextCommitment, checked.recipients.map((entry) => entry.teeId) as [Hex, Hex, Hex], checked.recipients.map((entry) => entry.keyId) as [Hex, Hex, Hex], checked.recipients.map((entry) => entry.ciphertext) as [Hex, Hex, Hex]]);
}

export function parseFccRecipientEnvelope(encoded: Hex | Uint8Array): FccRecipientEnvelopeV1 {
  const bytes = typeof encoded === 'string' ? toBytes(encoded) : encoded;
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error('FCC_ENVELOPE_SIZE');
  let fields: readonly unknown[];
  try { fields = decodeAbiParameters(ENVELOPE_TYPES, bytes) as readonly unknown[]; } catch { throw new Error('FCC_ENVELOPE_ABI'); }
  if (fields.length !== 11) throw new Error('FCC_ENVELOPE_ABI');
  const [version, chainId, extensionId, actionId, opType, command, expiry, commitment, teeIds, keyIds, ciphertexts] = fields;
  if (version !== 1 || !Array.isArray(teeIds) || !Array.isArray(keyIds) || !Array.isArray(ciphertexts) || teeIds.length !== 3 || keyIds.length !== 3 || ciphertexts.length !== 3) throw new Error('FCC_ENVELOPE_RECIPIENT_COUNT');
  const recipients = teeIds.map((teeId, index) => ({ teeId: hex32(teeId, 'FCC_ENVELOPE_TEE_ID'), keyId: hex32((keyIds as unknown[])[index], 'FCC_ENVELOPE_KEY_ID'), ciphertext: hexValue((ciphertexts as unknown[])[index], 'FCC_ENVELOPE_CIPHERTEXT') })) as [FccRecipient, FccRecipient, FccRecipient];
  const envelope = validateEnvelope({ version: 1, chainId: numberFromBigInt(chainId, 'FCC_ENVELOPE_CHAIN_ID'), extensionId: hex32(extensionId, 'FCC_ENVELOPE_EXTENSION_ID'), actionId: hex32(actionId, 'FCC_ENVELOPE_ACTION_ID'), opType: decodeBytes32(opType), command: decodeBytes32(command), expiry: numberFromBigInt(expiry, 'FCC_ENVELOPE_EXPIRY'), plaintextCommitment: hex32(commitment, 'FCC_ENVELOPE_COMMITMENT'), recipients });
  if (encodeFccRecipientEnvelope(envelope).toLowerCase() !== bytesToHex(bytes).toLowerCase()) throw new Error('FCC_ENVELOPE_CANONICAL');
  return { ...envelope, encoded: bytesToHex(bytes) };
}

export async function encryptFccEnvelope(plaintext: Uint8Array, metadata: FccEnvelopeMetadata, recipients: readonly [FccEncryptionRecipient, FccEncryptionRecipient, FccEncryptionRecipient], options: FccEncryptionOptions = {}): Promise<FccRecipientEnvelopeV1> {
  validateMetadata(metadata);
  if (plaintext.byteLength > MAX_ENVELOPE_BYTES) throw new Error('FCC_ENVELOPE_SIZE');
  if (recipients.length !== RECIPIENT_COUNT) throw new Error('FCC_ENVELOPE_RECIPIENT_COUNT');
  const commitment = keccak256(plaintext); const encrypted: FccRecipient[] = [];
  const aad = envelopeAssociatedData({ ...metadata, plaintextCommitment: commitment });
  const seenTee = new Set<string>(); const seenKey = new Set<string>();
  for (const [index, recipient] of recipients.entries()) {
    const teeId = identityBytes32(recipient.teeId, 'FCC_ENVELOPE_TEE_ID'); const keyId = identityBytes32(recipient.keyId, 'FCC_ENVELOPE_KEY_ID');
    if (seenTee.has(teeId) || seenKey.has(keyId)) throw new Error('FCC_ENVELOPE_DUPLICATE');
    seenTee.add(teeId); seenKey.add(keyId);
    const ephemeral = options.ephemeralPrivateKeys?.[index] ?? randomBytes(32); const nonce = options.nonces?.[index] ?? randomBytes(12);
    if (nonce.byteLength !== 12 || ephemeral.byteLength !== 32) throw new Error('FCC_ENVELOPE_NONCE');
    const publicKey = typeof recipient.publicKey === 'string' ? toBytes(recipient.publicKey) : recipient.publicKey;
    let shared: Uint8Array; try { shared = secp256k1.getSharedSecret(ephemeral, publicKey, true).slice(1); } catch { throw new Error('FCC_ENVELOPE_KEY'); }
    const key = hkdf(sha256, shared, undefined, new TextEncoder().encode('FCC-ECIES-v1'), 32);
    const sealed = await aesGcm('encrypt', plaintext, key, nonce, aad);
    encrypted.push({ teeId, keyId, ciphertext: bytesToHex(concatBytes(secp256k1.getPublicKey(ephemeral, true), concatBytes(nonce, sealed))) });
  }
  const base = validateEnvelope({ version: 1, ...metadata, chainId: Number(metadata.chainId), expiry: Number(metadata.expiry), opType: decodeIdentifier(metadata.opType), command: decodeIdentifier(metadata.command), plaintextCommitment: commitment, recipients: encrypted as [FccRecipient, FccRecipient, FccRecipient] });
  return { ...base, encoded: encodeFccRecipientEnvelope(base) };
}

/** Fetch and validate the three Weather `/info` key records. Private keys are
 * never accepted by this boundary; only public metadata leaves the proxy. */
export async function fetchFccEncryptionRecipients(sources: readonly [FccProxySource, FccProxySource, FccProxySource], expectedExtensionId: string | number, options: FccProxyFetchOptions = {}): Promise<[FccEncryptionRecipient, FccEncryptionRecipient, FccEncryptionRecipient]> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (!fetcher) throw new Error('FCC_PROXY_FETCH_UNAVAILABLE');
  const results: FccEncryptionRecipient[] = [];
  for (const source of sources) {
    let parsed: URL;
    try { parsed = new URL(source.url); } catch { throw new Error('FCC_PROXY_URL'); }
    if (parsed.protocol !== 'https:' && !(options.allowHttpLocalhost && parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'))) throw new Error('FCC_PROXY_URL');
    let response: Response;
    try { response = await fetcher(source.url, { method: 'GET', headers: { accept: 'application/json' } }); } catch { throw new Error('FCC_PROXY_FETCH'); }
    if (!response.ok) throw new Error('FCC_PROXY_STATUS');
    let info: FccProxyInfo;
    try { info = await response.json() as FccProxyInfo; } catch { throw new Error('FCC_PROXY_JSON'); }
    if (String(info.extensionId) !== String(expectedExtensionId) || !info.version || typeof info.teeId !== 'string' || (source.teeId !== undefined && source.teeId !== info.teeId)) throw new Error('FCC_PROXY_IDENTITY');
    const publicKey = info.encryptionPublicKey;
    if (typeof publicKey !== 'string' || !/^0x(?:0[2-3])[0-9a-fA-F]{64}$/.test(publicKey)) throw new Error('FCC_PROXY_KEY');
    const keyId = info.encryptionKeyId ?? keccak256(toBytes(publicKey));
    results.push({ teeId: info.teeId, keyId, publicKey });
  }
  if (new Set(results.map((entry) => String(entry.teeId))).size !== 3 || new Set(results.map((entry) => String(entry.keyId).toLowerCase())).size !== 3 || new Set(results.map((entry) => String(entry.publicKey).toLowerCase())).size !== 3) throw new Error('FCC_PROXY_DUPLICATE');
  return results as [FccEncryptionRecipient, FccEncryptionRecipient, FccEncryptionRecipient];
}

export function canonicalFccEnvelope(envelope: FccRecipientEnvelopeV1): Uint8Array { return toBytes(envelope.encoded || encodeFccRecipientEnvelope(envelope)); }
export function parseFccEnvelope(input: string | Uint8Array): FccRecipientEnvelopeV1 { return parseFccRecipientEnvelope(typeof input === 'string' ? toBytes(input as Hex) : input); }

export async function decryptFccRecipient(envelopeInput: FccRecipientEnvelopeV1 | string | Uint8Array, teeId: Hex | string, privateKey: Uint8Array | Hex, nowSeconds: number): Promise<Uint8Array> {
  const envelope = typeof envelopeInput === 'string' || envelopeInput instanceof Uint8Array ? parseFccEnvelope(envelopeInput) : validateEnvelope(envelopeInput);
  if (Number(envelope.expiry) < nowSeconds) throw new Error('FCC_ENVELOPE_EXPIRED');
  const normalizedTee = identityBytes32(teeId, 'FCC_ENVELOPE_TEE_ID'); const recipient = envelope.recipients.find((entry) => entry.teeId.toLowerCase() === normalizedTee.toLowerCase());
  if (!recipient) throw new Error('FCC_ENVELOPE_RECIPIENT');
  const packed = toBytes(recipient.ciphertext); if (packed.length < 33 + 12 + 16) throw new Error('FCC_ENVELOPE_CIPHERTEXT');
  const keyBytes = typeof privateKey === 'string' ? toBytes(privateKey) : privateKey;
  let shared: Uint8Array; try { shared = secp256k1.getSharedSecret(keyBytes, packed.slice(0, 33), true).slice(1); } catch { throw new Error('FCC_ENVELOPE_AUTH_FAILED'); }
  const key = hkdf(sha256, shared, undefined, new TextEncoder().encode('FCC-ECIES-v1'), 32);
  const aad = envelopeAssociatedData(envelope);
  let plaintext: Uint8Array; try { plaintext = await aesGcm('decrypt', packed.slice(45), key, packed.slice(33, 45), aad); } catch { throw new Error('FCC_ENVELOPE_AUTH_FAILED'); }
  if (keccak256(plaintext).toLowerCase() !== envelope.plaintextCommitment.toLowerCase()) throw new Error('FCC_ENVELOPE_COMMITMENT');
  return plaintext;
}

function validateEnvelope(value: unknown): Omit<FccRecipientEnvelopeV1, 'encoded'> {
  if (!value || typeof value !== 'object') throw new Error('FCC_ENVELOPE_ABI'); const envelope = value as FccRecipientEnvelopeV1;
  if (envelope.version !== 1) throw new Error('FCC_ENVELOPE_VERSION'); validateMetadata(envelope);
  const commitment = hex32(envelope.plaintextCommitment, 'FCC_ENVELOPE_COMMITMENT'); if (!Array.isArray(envelope.recipients) || envelope.recipients.length !== 3) throw new Error('FCC_ENVELOPE_RECIPIENT_COUNT');
  const normalized = envelope.recipients.map((entry) => ({ teeId: hex32(entry.teeId, 'FCC_ENVELOPE_TEE_ID'), keyId: hex32(entry.keyId, 'FCC_ENVELOPE_KEY_ID'), ciphertext: hexValue(entry.ciphertext, 'FCC_ENVELOPE_CIPHERTEXT') })) as [FccRecipient, FccRecipient, FccRecipient];
  if (new Set(normalized.map((entry) => entry.teeId.toLowerCase())).size !== 3 || new Set(normalized.map((entry) => entry.keyId.toLowerCase())).size !== 3) throw new Error('FCC_ENVELOPE_DUPLICATE');
  return { version: 1, chainId: Number(envelope.chainId), extensionId: hex32(envelope.extensionId, 'FCC_ENVELOPE_EXTENSION_ID'), actionId: hex32(envelope.actionId, 'FCC_ENVELOPE_ACTION_ID'), opType: decodeIdentifier(envelope.opType), command: decodeIdentifier(envelope.command), expiry: Number(envelope.expiry), plaintextCommitment: commitment, recipients: normalized };
}
function validateMetadata(metadata: FccEnvelopeMetadata): void { if (!Number.isSafeInteger(Number(metadata.chainId)) || Number(metadata.chainId) < 0) throw new Error('FCC_ENVELOPE_CHAIN_ID'); if (!Number.isSafeInteger(Number(metadata.expiry)) || Number(metadata.expiry) <= 0) throw new Error('FCC_ENVELOPE_EXPIRY'); hex32(metadata.extensionId, 'FCC_ENVELOPE_EXTENSION_ID'); hex32(metadata.actionId, 'FCC_ENVELOPE_ACTION_ID'); if (!decodeIdentifier(metadata.opType) || decodeIdentifier(metadata.opType).length > 32) throw new Error('FCC_ENVELOPE_OP_TYPE'); if (!decodeIdentifier(metadata.command) || decodeIdentifier(metadata.command).length > 32) throw new Error('FCC_ENVELOPE_COMMAND'); }
function decodeIdentifier(value: string | Hex): string { if (typeof value === 'string' && !HEX32.test(value)) return value; return decodeBytes32(value); }
function decodeBytes32(value: unknown): string { const bytes = toBytes(hex32(value, 'FCC_IDENTIFIER')); return new TextDecoder().decode(bytes).replace(/\0+$/, ''); }
function identityBytes32(value: string | Hex, error: string): Hex { if (HEX32.test(value)) return value as Hex; try { return bytes32Identifier(value); } catch { throw new Error(error); } }
function hex32(value: unknown, error: string): Hex { if (typeof value !== 'string' || !HEX32.test(value)) throw new Error(error); return value as Hex; }
function hexValue(value: unknown, error: string): Hex { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) throw new Error(error); return value as Hex; }
function numberFromBigInt(value: unknown, error: string): number { if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(error); return Number(value); }
function bytesToHex(value: Uint8Array): Hex { return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`; }
function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array { const out = new Uint8Array(left.length + right.length); out.set(left); out.set(right, left.length); return out; }
function randomBytes(length: number): Uint8Array { const result = new Uint8Array(length); if (!globalThis.crypto?.getRandomValues) throw new Error('CRYPTO_UNAVAILABLE'); globalThis.crypto.getRandomValues(result); return result; }
function envelopeAssociatedData(value: FccEnvelopeMetadata & { readonly plaintextCommitment: Hex }): Uint8Array {
  return toBytes(encodeAbiParameters(ENVELOPE_TYPES.slice(0, 8), [1, BigInt(value.chainId), hex32(value.extensionId, 'FCC_ENVELOPE_EXTENSION_ID'), hex32(value.actionId, 'FCC_ENVELOPE_ACTION_ID'), bytes32Identifier(decodeIdentifier(value.opType)), bytes32Identifier(decodeIdentifier(value.command)), BigInt(value.expiry), hex32(value.plaintextCommitment, 'FCC_ENVELOPE_COMMITMENT')]));
}
async function aesGcm(direction: 'encrypt' | 'decrypt', data: Uint8Array, keyBytes: Uint8Array, nonce: Uint8Array, aad: Uint8Array): Promise<Uint8Array> { const subtle = globalThis.crypto?.subtle; if (!subtle) throw new Error('CRYPTO_UNAVAILABLE'); const key = await subtle.importKey('raw', keyBytes.slice().buffer as ArrayBuffer, 'AES-GCM', false, [direction]); const result = await subtle[direction]({ name: 'AES-GCM', iv: nonce.slice().buffer as ArrayBuffer, additionalData: aad.slice().buffer as ArrayBuffer }, key, data.slice().buffer as ArrayBuffer); return new Uint8Array(result); }
