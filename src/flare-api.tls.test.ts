import { describe, expect, it } from 'vitest';

import { readApiTlsConfig } from '../apps/flare-api/src/tls';

describe('Flare API TLS configuration', () => {
  it('keeps local development on HTTP when no TLS settings are supplied', () => {
    expect(readApiTlsConfig({})).toEqual({ enabled: false, mutualTls: false });
  });

  it('requires a complete server TLS identity and CA for mTLS', () => {
    expect(() => readApiTlsConfig({ FLARE_API_TLS_ENABLED: 'true' })).toThrow('API_TLS_CERT_KEY_REQUIRED');
    expect(() => readApiTlsConfig({ FLARE_BOT_MTLS_REQUIRED: 'true', FLARE_API_TLS_CERT_FILE: 'server.crt', FLARE_API_TLS_KEY_FILE: 'server.key' })).toThrow('API_MTLS_CA_REQUIRED');
    expect(readApiTlsConfig({ FLARE_API_TLS_CERT_FILE: 'server.crt', FLARE_API_TLS_KEY_FILE: 'server.key', FLARE_API_TLS_CA_FILE: 'client-ca.crt', FLARE_BOT_MTLS_REQUIRED: 'true' })).toMatchObject({ enabled: true, mutualTls: true });
  });

  it('rejects partial TLS paths instead of downgrading to HTTP', () => {
    expect(() => readApiTlsConfig({ FLARE_API_TLS_CERT_FILE: 'server.crt' })).toThrow('API_TLS_CERT_KEY_REQUIRED');
    expect(() => readApiTlsConfig({ FLARE_API_TLS_KEY_FILE: 'server.key' })).toThrow('API_TLS_CERT_KEY_REQUIRED');
    expect(() => readApiTlsConfig({ FLARE_API_TLS_CA_FILE: 'client-ca.crt' })).toThrow('API_TLS_CERT_KEY_REQUIRED');
  });
});
