import type { Address } from 'viem';
import { getBaseNetworkConfig, type BaseNetwork } from '../../../packages/base-core/src/network';
import type { BaseApiConfig, BotCredential, BotScope } from './types';

const KEYED_SECRET_NAMES = [
  'KATON_SETTLEMENT_PRIVATE_KEY',
  'KATON_BASE_SETTLEMENT_PRIVATE_KEY',
  'SETTLEMENT_PRIVATE_KEY',
  'RFQ_SETTLEMENT_PRIVATE_KEY',
  'KATON_ROUTER_PRIVATE_KEY',
  'KATON_BASE_ROUTER_PRIVATE_KEY',
  'RFQ_ROUTER_PRIVATE_KEY',
  'FACILITY_EXECUTOR_PRIVATE_KEY',
  'KATON_FACILITY_EXECUTOR_PRIVATE_KEY',
  'KATON_BASE_FACILITY_EXECUTOR_PRIVATE_KEY',
  'FACILITY_PRIVATE_KEY',
  'KATON_FACILITY_EXECUTOR_KEY',
  'KATON_SETTLEMENT_KEY',
  'KATON_ROUTER_KEY',
  'PRIVATE_KEY',
  'WALLET_PRIVATE_KEY',
  'KATON_WALLET_PRIVATE_KEY',
  'KATON_PRIVATE_KEY',
  'DEPLOYER_PRIVATE_KEY',
  'WALLET_MNEMONIC',
  'KATON_WALLET_MNEMONIC',
  'MNEMONIC',
  'KATON_BASE_WALLET_MNEMONIC',
  'BASE_WALLET_MNEMONIC',
] as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export function assertKeylessConfiguration(env: Readonly<Record<string, string | undefined>>): void {
  const configured = KEYED_SECRET_NAMES.find((name) => typeof env[name] === 'string' && env[name] !== '');
  if (configured) throw new Error(`KEYLESS_CONFIGURATION:${configured}`);
}

export function loadBaseApiConfig(env: Readonly<Record<string, string | undefined>> = process.env): BaseApiConfig {
  assertKeylessConfiguration(env);
  const network = (env.KATON_BASE_NETWORK ?? 'sepolia') as BaseNetwork;
  const networkConfig = getBaseNetworkConfig(network);
  const chainId = parseInteger(env.KATON_BASE_CHAIN_ID ?? String(networkConfig.chainId), 'KATON_BASE_CHAIN_ID');
  if (chainId !== networkConfig.chainId) throw new Error('CHAIN_ID_MISMATCH');
  const routerAddress = optionalAddress(env.KATON_BASE_ROUTER_ADDRESS, 'KATON_BASE_ROUTER_ADDRESS') ?? ZERO_ADDRESS;
  const settlementAddress = optionalAddress(env.KATON_BASE_SETTLEMENT_ADDRESS, 'KATON_BASE_SETTLEMENT_ADDRESS') ?? ZERO_ADDRESS;
  const facilityAddresses = parseAddressList(env.KATON_BASE_FACILITY_ADDRESSES, 'KATON_BASE_FACILITY_ADDRESSES');
  const adapterAddresses = parseAddressList(env.KATON_BASE_ADAPTER_ADDRESSES, 'KATON_BASE_ADAPTER_ADDRESSES');
  const oracleGuardAddress = optionalAddress(env.KATON_BASE_ORACLE_GUARD_ADDRESS, 'KATON_BASE_ORACLE_GUARD_ADDRESS');
  const b20GuardAddress = optionalAddress(env.KATON_BASE_B20_GUARD_ADDRESS, 'KATON_BASE_B20_GUARD_ADDRESS');
  const nativeUsdcAddress = optionalAddress(env.KATON_BASE_NATIVE_USDC_ADDRESS, 'KATON_BASE_NATIVE_USDC_ADDRESS') ?? networkConfig.nativeUsdc;
  const browserOrigins = parseBrowserOrigins(env.KATON_BASE_BROWSER_ORIGINS);
  const botCredentials = parseBotCredentials(env.KATON_BOT_CREDENTIALS);
  const nodeEnv = env.NODE_ENV ?? 'development';
  const forkQa = network === 'mainnet' && env.KATON_BASE_FORK_QA === 'true' && nodeEnv !== 'production';
  const allowInsecureLocal = env.KATON_INSECURE_LOCAL === 'true' && nodeEnv !== 'production';
  const trustProxyHops = parseInteger(env.KATON_TRUST_PROXY_HOPS ?? '0', 'KATON_TRUST_PROXY_HOPS');
  if (trustProxyHops < 0) throw new Error('TRUST_PROXY_INVALID');
  return {
    network,
    chainId,
    domainName: env.KATON_SIWE_DOMAIN ?? 'Katon RFQ Desk',
    domainVersion: env.KATON_SIWE_VERSION ?? '1',
    routerAddress,
    settlementAddress,
    facilityAddresses,
    ...(oracleGuardAddress ? { oracleGuardAddress } : {}),
    ...(b20GuardAddress ? { b20GuardAddress } : {}),
    ...(nativeUsdcAddress ? { nativeUsdcAddress } : {}),
    adapterAddresses,
    browserOrigins,
    deploymentConfigured: routerAddress !== ZERO_ADDRESS && settlementAddress !== ZERO_ADDRESS && facilityAddresses.length > 0 && Boolean(oracleGuardAddress && b20GuardAddress) && (network === 'sepolia' || forkQa),
    // Mainnet is an explicit operational gate; a production eligibility flag
    // and the env switch are both required before retail quotes can run.
    mainnetEnabled: env.KATON_BASE_MAINNET_ENABLED === 'true' && env.KATON_BASE_PRODUCTION_ELIGIBLE === 'true',
    // Liquidations are a later product route. Operators must explicitly enable
    // them after pinning and reviewing an official B20 lending market adapter.
    liquidationEnabled: env.KATON_BASE_LIQUIDATIONS_ENABLED === 'true' && adapterAddresses.length > 0,
    forkQa,
    productionEligible: env.KATON_BASE_PRODUCTION_ELIGIBLE === 'true',
    feeBps: BigInt(env.KATON_FEE_BPS ?? '0'),
    decisionBlockMaxAge: BigInt(env.KATON_DECISION_BLOCK_MAX_AGE ?? '3'),
    sessionTtlSeconds: parseInteger(env.KATON_SESSION_TTL_SECONDS ?? '900', 'KATON_SESSION_TTL_SECONDS'),
    clockToleranceSeconds: parseInteger(env.KATON_CLOCK_TOLERANCE_SECONDS ?? '300', 'KATON_CLOCK_TOLERANCE_SECONDS'),
    trustProxyHops,
    allowInsecureLocal,
    botCredentials,
    rpcUrl: env.KATON_BASE_RPC_URL ?? networkConfig.rpcUrl,
    mongoUri: env.KATON_MONGO_URI,
    mongoDbName: env.KATON_MONGO_DB ?? 'katon',
    ...(env.KATON_BASE_SWAP_MAKER_URL ? { swapMakerQuoteUrl: env.KATON_BASE_SWAP_MAKER_URL } : {}),
    ...(env.KATON_BASE_SWAP_FACILITY_URL ? { swapFacilityQuoteUrl: env.KATON_BASE_SWAP_FACILITY_URL } : {}),
    ...(env.KATON_BASE_SWAP_0X_URL || env.KATON_BASE_SWAP_1INCH_URL || env.KATON_BASE_SWAP_AERODROME_URL ? {
      swapExternalQuoteUrls: {
        ...(env.KATON_BASE_SWAP_0X_URL ? { '0x': env.KATON_BASE_SWAP_0X_URL } : {}),
        ...(env.KATON_BASE_SWAP_1INCH_URL ? { '1inch': env.KATON_BASE_SWAP_1INCH_URL } : {}),
        ...(env.KATON_BASE_SWAP_AERODROME_URL ? { AERODROME: env.KATON_BASE_SWAP_AERODROME_URL } : {}),
      },
    } : {}),
    ...(env.KATON_BASE_SWAP_PROVIDER_TIMEOUT_MS ? { swapProviderTimeoutMs: parseInteger(env.KATON_BASE_SWAP_PROVIDER_TIMEOUT_MS, 'KATON_BASE_SWAP_PROVIDER_TIMEOUT_MS') } : {}),
    ...(env.KATON_BASE_ELIGIBILITY_URL ? { eligibilityUrl: env.KATON_BASE_ELIGIBILITY_URL } : {}),
    ...(env.KATON_BASE_SWAP_0X_API_KEY || env.KATON_BASE_SWAP_1INCH_API_KEY || env.KATON_BASE_SWAP_AERODROME_API_KEY ? {
      swapProviderApiKeys: {
        ...(env.KATON_BASE_SWAP_0X_API_KEY ? { '0x': env.KATON_BASE_SWAP_0X_API_KEY } : {}),
        ...(env.KATON_BASE_SWAP_1INCH_API_KEY ? { '1inch': env.KATON_BASE_SWAP_1INCH_API_KEY } : {}),
        ...(env.KATON_BASE_SWAP_AERODROME_API_KEY ? { AERODROME: env.KATON_BASE_SWAP_AERODROME_API_KEY } : {}),
      },
    } : {}),
  };
}

export function isSecureRequest(input: {
  readonly encrypted?: boolean;
  readonly protocol?: string;
  readonly forwardedProto?: string;
  readonly trustProxyHops: number;
  readonly allowInsecureLocal: boolean;
  readonly production?: boolean;
  readonly hostname?: string;
}): boolean {
  if (input.production && input.allowInsecureLocal) return false;
  if (input.encrypted || input.protocol === 'https') return true;
  if (input.trustProxyHops > 0 && input.forwardedProto?.split(',')[0]?.trim().toLowerCase() === 'https') return true;
  return input.allowInsecureLocal && !input.production && isLoopbackHostname(input.hostname);
}

function parseAddressList(value: string | undefined, name: string): readonly Address[] {
  if (!value) return [];
  let values: unknown = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (value.trim().startsWith('[')) {
    try { values = JSON.parse(value); } catch { throw new Error(`ADDRESS_LIST_INVALID:${name}`); }
  }
  if (!Array.isArray(values)) throw new Error(`ADDRESS_LIST_INVALID:${name}`);
  return [...new Set(values.map((entry) => requiredAddress(String(entry), name)))];
}

function parseBrowserOrigins(value: string | undefined): readonly string[] {
  if (!value) return [];
  let values: unknown = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (value.trim().startsWith('[')) {
    try { values = JSON.parse(value); } catch { throw new Error('CORS_ORIGINS_INVALID'); }
  }
  if (!Array.isArray(values) || values.length === 0) throw new Error('CORS_ORIGINS_INVALID');
  return [...new Set(values.map((entry) => {
    if (typeof entry !== 'string' || entry === '*' || entry.includes('*')) throw new Error('CORS_ORIGIN_INVALID');
    let origin: URL;
    try { origin = new URL(entry); } catch { throw new Error('CORS_ORIGIN_INVALID'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== entry.replace(/\/$/, '')) throw new Error('CORS_ORIGIN_INVALID');
    return origin.origin;
  }))];
}

function parseBotCredentials(value: string | undefined): readonly BotCredential[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('BOT_CREDENTIALS_INVALID'); }
  if (!Array.isArray(parsed)) throw new Error('BOT_CREDENTIALS_INVALID');
  const ids = new Set<string>();
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('BOT_CREDENTIALS_INVALID');
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== 'string'
      || record.id.length === 0
      || record.id.includes('.')
      || typeof record.secret !== 'string'
      || record.secret.length === 0
      || ids.has(record.id)
      || !Array.isArray(record.scopes)
      || record.scopes.length === 0
      || record.scopes.some((scope) => !['keeper', 'lp', 'internal'].includes(String(scope)))
    ) throw new Error('BOT_CREDENTIALS_INVALID');
    ids.add(record.id);
    const identity = record.identity === undefined ? undefined : requiredAddress(String(record.identity), 'bot.identity');
    return { id: record.id, secret: record.secret, scopes: record.scopes as BotScope[], ...(identity ? { identity } : {}) };
  });
}

function requiredAddress(value: string | undefined, name: string): Address {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`ADDRESS_INVALID:${name}`);
  return value.toLowerCase() as Address;
}

function optionalAddress(value: string | undefined, name: string): Address | undefined {
  if (value === undefined || value === '') return undefined;
  return requiredAddress(value, name);
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`INTEGER_INVALID:${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`INTEGER_INVALID:${name}`);
  return parsed;
}
