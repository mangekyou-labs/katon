export interface EnvelopeMetadata {
  readonly keyId: string;
  readonly commitment: string;
  readonly expiresAt: number;
}

export interface EncryptedEnvelope extends EnvelopeMetadata {
  readonly version: 1;
  readonly nonce: string;
  readonly ciphertext: string;
}

export async function encryptEnvelope(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
  metadata: EnvelopeMetadata,
): Promise<EncryptedEnvelope> {
  const subtle = getSubtle();
  const key = await importKey(subtle, keyBytes, ['encrypt']);
  const nonce = new Uint8Array(12);
  getCrypto().getRandomValues(nonce);
  const aad = associatedData(metadata);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad) },
    key,
    toArrayBuffer(plaintext),
  );
  return {
    version: 1,
    ...metadata,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptEnvelope(
  envelope: EncryptedEnvelope,
  keyBytes: Uint8Array,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Uint8Array> {
  if (envelope.version !== 1) throw new Error('ENVELOPE_VERSION');
  if (envelope.expiresAt < nowSeconds) throw new Error('ENVELOPE_EXPIRED');
  const subtle = getSubtle();
  const key = await importKey(subtle, keyBytes, ['decrypt']);
  try {
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(fromBase64(envelope.nonce)),
        additionalData: toArrayBuffer(associatedData(envelope)),
      },
      key,
      toArrayBuffer(fromBase64(envelope.ciphertext)),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error('ENVELOPE_AUTH_FAILED');
  }
}

function associatedData(metadata: EnvelopeMetadata): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      keyId: metadata.keyId,
      commitment: metadata.commitment,
      expiresAt: metadata.expiresAt,
    }),
  );
}

function getCrypto(): Crypto {
  if (!globalThis.crypto) throw new Error('CRYPTO_UNAVAILABLE');
  return globalThis.crypto;
}

function getSubtle(): SubtleCrypto {
  return getCrypto().subtle;
}

async function importKey(
  subtle: SubtleCrypto,
  keyBytes: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (![16, 24, 32].includes(keyBytes.byteLength)) throw new Error('ENVELOPE_KEY_LENGTH');
  return subtle.importKey('raw', toArrayBuffer(keyBytes), { name: 'AES-GCM' }, false, usages);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
