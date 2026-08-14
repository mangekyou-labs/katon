import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { ServerOptions } from 'node:https';

export interface ApiTlsEnvironment {
  readonly FLARE_API_TLS_ENABLED?: string;
  readonly FLARE_API_TLS_CERT_FILE?: string;
  readonly FLARE_API_TLS_KEY_FILE?: string;
  readonly FLARE_API_TLS_CA_FILE?: string;
  readonly FLARE_BOT_MTLS_REQUIRED?: string;
}

export interface ApiTlsConfig {
  readonly enabled: boolean;
  readonly mutualTls: boolean;
  readonly certFile?: string;
  readonly keyFile?: string;
  readonly caFile?: string;
}

export function readApiTlsConfig(environment: ApiTlsEnvironment = process.env): ApiTlsConfig {
  const certFile = environment.FLARE_API_TLS_CERT_FILE?.trim() || undefined;
  const keyFile = environment.FLARE_API_TLS_KEY_FILE?.trim() || undefined;
  const caFile = environment.FLARE_API_TLS_CA_FILE?.trim() || undefined;
  const mutualTls = environment.FLARE_BOT_MTLS_REQUIRED === 'true';
  const explicitlyEnabled = environment.FLARE_API_TLS_ENABLED === 'true';
  const anyTlsSetting = explicitlyEnabled || Boolean(certFile || keyFile || caFile || mutualTls);
  if (!anyTlsSetting) return { enabled: false, mutualTls: false };
  if (!certFile || !keyFile) throw new Error('API_TLS_CERT_KEY_REQUIRED');
  if (mutualTls && !caFile) throw new Error('API_MTLS_CA_REQUIRED');
  return { enabled: true, mutualTls, certFile, keyFile, caFile };
}

export function readApiTlsOptions(config: ApiTlsConfig): ServerOptions | undefined {
  if (!config.enabled || !config.certFile || !config.keyFile) return undefined;
  const options: ServerOptions = {
    cert: readFileSync(config.certFile),
    key: readFileSync(config.keyFile),
  };
  if (config.mutualTls) {
    if (!config.caFile) throw new Error('API_MTLS_CA_REQUIRED');
    options.ca = readFileSync(config.caFile);
    options.requestCert = true;
    options.rejectUnauthorized = true;
  }
  return options;
}

export function isTlsRequest(request: IncomingMessage): boolean {
  return 'encrypted' in request.socket && (request.socket as { readonly encrypted?: boolean }).encrypted === true;
}
