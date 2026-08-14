import { describe, expect, it } from 'vitest';

import { authorizeMtlsPeer } from '../apps/flare-api/src/mtls';

describe('Flare API mTLS transport boundary', () => {
  it('requires an authorized client certificate bound to the bot institution', () => {
    const peer = {
      authorized: true,
      getPeerCertificate: () => ({
        subject: { CN: 'desk-a' },
        subjectaltname: 'DNS:desk-a, DNS:other',
        fingerprint256: 'AA:BB',
      }),
    };
    expect(authorizeMtlsPeer(peer, 'desk-a')).toEqual({ institution: 'desk-a', fingerprint256: 'AA:BB' });
    expect(() => authorizeMtlsPeer({ ...peer, authorized: false }, 'desk-a')).toThrow('BOT_MTLS_REQUIRED');
    expect(() => authorizeMtlsPeer(peer, 'desk-b')).toThrow('BOT_MTLS_INSTITUTION_MISMATCH');
  });

  it('accepts an institution SAN and rejects missing certificates', () => {
    expect(authorizeMtlsPeer({ authorized: true, getPeerCertificate: () => ({ subjectaltname: 'DNS:desk-a' }) }, 'desk-a').institution).toBe('desk-a');
    expect(() => authorizeMtlsPeer({ authorized: true, getPeerCertificate: () => undefined }, 'desk-a')).toThrow('BOT_MTLS_CERTIFICATE');
  });
});
