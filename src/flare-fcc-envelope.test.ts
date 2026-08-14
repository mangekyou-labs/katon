import { secp256k1 } from '@noble/curves/secp256k1';
import { describe, expect, it } from 'vitest';

import {
  canonicalFccEnvelope,
  decryptFccRecipient,
  encryptFccEnvelope,
  fetchFccEncryptionRecipients,
  parseFccEnvelope,
  type FccEnvelopeMetadata,
} from '../packages/flare-core/src/fccEnvelope';

const metadata: FccEnvelopeMetadata = {
  chainId: 114,
  extensionId: `0x${'11'.repeat(32)}`,
  actionId: `0x${'22'.repeat(32)}`,
  opType: 'RFQ',
  command: 'CREATE',
  expiry: 1_800_000_000,
};

const privateKeys = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)] as const;
const recipients = [
  { teeId: 'tee-a', keyId: 'key-a', publicKey: secp256k1.getPublicKey(privateKeys[0], true) },
  { teeId: 'tee-b', keyId: 'key-b', publicKey: secp256k1.getPublicKey(privateKeys[1], true) },
  { teeId: 'tee-c', keyId: 'key-c', publicKey: secp256k1.getPublicKey(privateKeys[2], true) },
] as const;

describe('FCC recipient envelope v1', () => {
  it('builds three ECIES ciphertexts over one canonical plaintext', async () => {
    const plaintext = new TextEncoder().encode('{"route":"secret"}');
    const envelope = await encryptFccEnvelope(plaintext, metadata, recipients, {
      ephemeralPrivateKeys: [new Uint8Array(32).fill(11), new Uint8Array(32).fill(12), new Uint8Array(32).fill(13)],
      nonces: [new Uint8Array(12).fill(10), new Uint8Array(12).fill(11), new Uint8Array(12).fill(12)],
    });

    expect(envelope.recipients).toHaveLength(3);
    expect(new TextDecoder().decode(canonicalFccEnvelope(envelope))).not.toContain('secret');
    expect(parseFccEnvelope(envelope.encoded)).toMatchObject({ version: 1, chainId: 114, opType: 'RFQ', command: 'CREATE' });
    await expect(decryptFccRecipient(envelope, 'tee-b', privateKeys[1], 1_700_000_000)).resolves.toEqual(plaintext);
  });

  it('rejects malformed, duplicate, stale, and commitment-tampered envelopes', async () => {
    const envelope = await encryptFccEnvelope(new Uint8Array([1, 2, 3]), metadata, recipients, {
      ephemeralPrivateKeys: [new Uint8Array(32).fill(21), new Uint8Array(32).fill(22), new Uint8Array(32).fill(23)],
      nonces: [new Uint8Array(12).fill(20), new Uint8Array(12).fill(21), new Uint8Array(12).fill(22)],
    });

    expect(() => parseFccEnvelope('{"version":1}')).toThrow('FCC_ENVELOPE_ABI');
    expect(() => parseFccEnvelope(`${envelope.encoded}00`)).toThrow('FCC_ENVELOPE_CANONICAL');
    const duplicate = { ...envelope, recipients: [envelope.recipients[0], envelope.recipients[0], envelope.recipients[2]] as typeof envelope.recipients };
    await expect(decryptFccRecipient(duplicate, 'tee-a', privateKeys[0], 1_700_000_000)).rejects.toThrow('FCC_ENVELOPE_DUPLICATE');
    await expect(decryptFccRecipient({ ...envelope, expiry: 1_000 }, 'tee-a', privateKeys[0], 1_001)).rejects.toThrow('FCC_ENVELOPE_EXPIRED');
    await expect(decryptFccRecipient({ ...envelope, plaintextCommitment: `0x${'ff'.repeat(32)}` }, 'tee-a', privateKeys[0], 1_700_000_000)).rejects.toThrow('FCC_ENVELOPE_AUTH_FAILED');
  });

  it('authenticates the complete outer action metadata as ciphertext AAD', async () => {
    const envelope = await encryptFccEnvelope(new TextEncoder().encode('{"side":"sell"}'), metadata, recipients, {
      ephemeralPrivateKeys: [new Uint8Array(32).fill(31), new Uint8Array(32).fill(32), new Uint8Array(32).fill(33)],
      nonces: [new Uint8Array(12).fill(30), new Uint8Array(12).fill(31), new Uint8Array(12).fill(32)],
    });

    await expect(decryptFccRecipient({ ...envelope, actionId: `0x${'33'.repeat(32)}` }, 'tee-a', privateKeys[0], 1_700_000_000)).rejects.toThrow('FCC_ENVELOPE_AUTH_FAILED');
    await expect(decryptFccRecipient({ ...envelope, command: 'FINALIZE' }, 'tee-a', privateKeys[0], 1_700_000_000)).rejects.toThrow('FCC_ENVELOPE_AUTH_FAILED');
  });

  it('accepts only three distinct HTTPS proxy /info keys', async () => {
    const publicKeys = privateKeys.map((key) => `0x${Array.from(secp256k1.getPublicKey(key, true), (value) => value.toString(16).padStart(2, '0')).join('')}`);
    const fetcher = async (input: RequestInfo | URL) => { const url = String(input); return new Response(JSON.stringify({ extensionId: '65537', version: '1.0.0', teeId: url.slice(-1), encryptionPublicKey: publicKeys[Number(url.slice(-1)) - 1] }), { status: 200 }); };
    const sources = [{ url: 'https://tee.example/1' }, { url: 'https://tee.example/2' }, { url: 'https://tee.example/3' }] as const;
    await expect(fetchFccEncryptionRecipients(sources, '65537', { fetcher })).resolves.toHaveLength(3);
    await expect(fetchFccEncryptionRecipients([{ url: 'https://tee.example/1' }, { url: 'https://tee.example/1' }, { url: 'https://tee.example/3' }], '65537', { fetcher })).rejects.toThrow('FCC_PROXY_DUPLICATE');
  });
});
