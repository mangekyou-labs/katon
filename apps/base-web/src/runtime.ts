import type { Address } from 'viem';
import { B20_ASSETS_BY_ADDRESS } from '../../../packages/base-core/src/assets';
import { getBaseNetworkConfig, type BaseNetwork } from '../../../packages/base-core/src/network';

export type BaseRuntimeStatus = 'ready' | 'unavailable';

export interface BaseRuntimeB20Asset {
  readonly ticker: string;
  readonly feed: Address;
  readonly decimals: number;
}

export interface BaseDeploymentAddresses {
  readonly router?: Address;
  readonly settlement?: Address;
  readonly facility?: Address;
  readonly oracleGuard?: Address;
  readonly b20Guard?: Address;
}

export interface BaseRuntimeConfig {
  readonly network: BaseNetwork;
  readonly chainId: number;
  readonly networkName: string;
  readonly rpcUrl: string;
  readonly apiUrl: string;
  readonly explorerUrl: string;
  readonly usdc: Address;
  readonly deployment: BaseDeploymentAddresses;
  readonly adapters: readonly Address[];
  readonly b20Assets: Readonly<Record<string, BaseRuntimeB20Asset>>;
  readonly status: BaseRuntimeStatus;
  readonly writesEnabled: boolean;
  readonly productionEligible: false;
  readonly forkQa: boolean;
  readonly liquidationEnabled: boolean;
  /** Maximum allowed age for a server-pinned route decision block. */
  readonly decisionBlockMaxAge?: bigint;
  readonly reason?: 'DASHBOARD_UNAVAILABLE' | 'CONFIG_UNAVAILABLE' | 'MAINNET_DISABLED';
}

export type BaseLiquidationAvailability =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: 'PRODUCT_DISABLED' | 'VENUE_MANIFEST_UNAVAILABLE' };

export interface RawBaseRuntimeConfig {
  readonly network?: string;
  readonly chainId?: number | string;
  readonly rpcUrl?: string;
  readonly apiUrl?: string;
  readonly networkName?: string;
  readonly forkQa?: boolean;
  readonly productionEligible?: boolean;
  readonly liquidationEnabled?: boolean;
  readonly decisionBlockMaxAge?: number | string;
  readonly deployment?: Readonly<Record<string, unknown>>;
  readonly routerAddress?: string;
  readonly settlementAddress?: string;
  readonly facilityAddress?: string;
  readonly oracleGuardAddress?: string;
  readonly b20GuardAddress?: string;
  readonly adapterAddresses?: readonly string[];
  readonly b20Assets?: Readonly<Record<string, { readonly ticker?: string; readonly feed?: string; readonly decimals?: number }>>;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Runtime config is intentionally data-only. The browser never receives a
 * private key, and an incomplete deployment becomes a read-only unavailable
 * surface instead of a partially enabled transaction UI.
 */
export function loadRuntimeConfig(input?: RawBaseRuntimeConfig | string | null): BaseRuntimeConfig {
  let raw: RawBaseRuntimeConfig = {};
  try {
    raw = parseInput(input === undefined ? readBrowserConfig() : input);
    const network = parseNetwork(raw.network);
    const networkConfig = getBaseNetworkConfig(network);
    const chainId = raw.chainId === undefined ? networkConfig.chainId : integer(raw.chainId);
    if (chainId !== networkConfig.chainId) throw new Error('CHAIN_ID_MISMATCH');
    const deploymentSource = raw.deployment ?? {};
    const deployment: BaseDeploymentAddresses = {
      ...(address(raw.routerAddress ?? deploymentSource.routerAddress ?? deploymentSource.router) ? { router: address(raw.routerAddress ?? deploymentSource.routerAddress ?? deploymentSource.router) } : {}),
      ...(address(raw.settlementAddress ?? deploymentSource.settlementAddress ?? deploymentSource.settlement) ? { settlement: address(raw.settlementAddress ?? deploymentSource.settlementAddress ?? deploymentSource.settlement) } : {}),
      ...(address(raw.facilityAddress ?? deploymentSource.facilityAddress ?? deploymentSource.facility) ? { facility: address(raw.facilityAddress ?? deploymentSource.facilityAddress ?? deploymentSource.facility) } : {}),
      ...(address(raw.oracleGuardAddress ?? deploymentSource.oracleGuardAddress ?? deploymentSource.oracleGuard) ? { oracleGuard: address(raw.oracleGuardAddress ?? deploymentSource.oracleGuardAddress ?? deploymentSource.oracleGuard) } : {}),
      ...(address(raw.b20GuardAddress ?? deploymentSource.b20GuardAddress ?? deploymentSource.b20Guard) ? { b20Guard: address(raw.b20GuardAddress ?? deploymentSource.b20GuardAddress ?? deploymentSource.b20Guard) } : {}),
    };
    const adapters = (raw.adapterAddresses ?? asStringArray(deploymentSource.adapterAddresses ?? deploymentSource.adapters)).map((value) => requiredAddress(value));
    const b20Assets = mergeAssets(raw.b20Assets);
    const complete = Boolean(deployment.router && deployment.settlement && deployment.facility && deployment.oracleGuard && deployment.b20Guard);
    const mainnet = network === 'mainnet';
    const forkQa = raw.forkQa === true && mainnet;
    if (forkQa && !isLoopbackRpc(raw.rpcUrl ?? '')) throw new Error('FORK_QA_RPC_NOT_LOOPBACK');
    const unavailable = (mainnet && !forkQa) || !complete;
    return {
      network,
      chainId,
      networkName: raw.networkName?.trim() || (forkQa ? 'Base Mainnet Fork (local)' : networkConfig.name),
      rpcUrl: raw.rpcUrl?.trim() || networkConfig.rpcUrl,
      apiUrl: raw.apiUrl?.trim() || '/',
      explorerUrl: networkConfig.explorerUrl,
      usdc: networkConfig.nativeUsdc,
      deployment,
      adapters,
      b20Assets,
      status: unavailable ? 'unavailable' : 'ready',
      writesEnabled: !unavailable,
      productionEligible: false,
      forkQa,
      liquidationEnabled: raw.liquidationEnabled === true,
      decisionBlockMaxAge: raw.decisionBlockMaxAge === undefined ? 3n : BigInt(integer(raw.decisionBlockMaxAge)),
      ...(mainnet ? { reason: 'MAINNET_DISABLED' as const } : !complete ? { reason: 'DASHBOARD_UNAVAILABLE' as const } : {}),
    };
  } catch {
    return unavailableConfig(raw);
  }
}

/**
 * Selects public browser configuration without merging sources. A page-level
 * injection is authoritative; the build-time Vite value is only a fallback.
 */
export function selectBrowserRuntimeConfig(
  globalConfig: RawBaseRuntimeConfig | string | undefined,
  viteConfig: string | undefined,
): RawBaseRuntimeConfig | string | null {
  return globalConfig ?? viteConfig ?? null;
}

/** Facility writes remain independent from venue readiness. */
export function liquidationAvailability(config: BaseRuntimeConfig): BaseLiquidationAvailability {
  if (!config.liquidationEnabled) return { enabled: false, reason: 'PRODUCT_DISABLED' };
  return config.adapters.length === 0
    ? { enabled: false, reason: 'VENUE_MANIFEST_UNAVAILABLE' }
    : { enabled: true };
}

export function configuredB20Decimals(config: BaseRuntimeConfig, token: string): number {
  const asset = config.b20Assets[token.toLowerCase()];
  if (!asset) throw new Error('B20_METADATA_UNAVAILABLE');
  return asset.decimals;
}

function readBrowserConfig(): RawBaseRuntimeConfig | string | null {
  const globalConfig = typeof window === 'undefined'
    ? undefined
    : (window as Window & { __KATON_BASE_CONFIG__?: RawBaseRuntimeConfig | string }).__KATON_BASE_CONFIG__;
  const viteConfig = (import.meta as ImportMeta & { readonly env?: Readonly<Record<string, string | undefined>> }).env?.VITE_KATON_BASE_CONFIG;
  return selectBrowserRuntimeConfig(globalConfig, viteConfig);
}

function parseInput(input: RawBaseRuntimeConfig | string | null): RawBaseRuntimeConfig {
  if (!input) return {};
  if (typeof input !== 'string') return input;
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CONFIG_UNAVAILABLE');
  return parsed as RawBaseRuntimeConfig;
}

function parseNetwork(value: string | undefined): BaseNetwork {
  if (value === undefined || value === 'sepolia') return 'sepolia';
  if (value === 'mainnet') return 'mainnet';
  throw new Error('UNSUPPORTED_NETWORK');
}

function integer(value: number | string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error('INTEGER_INVALID');
}

function address(value: unknown): Address | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('ADDRESS_INVALID');
  const normalized = value.toLowerCase();
  if (normalized === ZERO_ADDRESS) return undefined;
  return normalized as Address;
}

function requiredAddress(value: string): Address {
  const parsed = address(value);
  if (!parsed) throw new Error('ADDRESS_INVALID');
  return parsed;
}

function asStringArray(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('ADDRESS_LIST_INVALID');
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('ADDRESS_LIST_INVALID');
    return entry;
  });
}

function mergeAssets(overrides: RawBaseRuntimeConfig['b20Assets']): Readonly<Record<string, BaseRuntimeB20Asset>> {
  const base = Object.fromEntries(Object.entries(B20_ASSETS_BY_ADDRESS).map(([token, asset]) => [token.toLowerCase(), asset])) as Record<string, BaseRuntimeB20Asset>;
  for (const [token, value] of Object.entries(overrides ?? {})) {
    const normalized = requiredAddress(token);
    if (!value || typeof value !== 'object') throw new Error('B20_METADATA_INVALID');
    const prior = base[normalized];
    const decimals = value.decimals ?? prior?.decimals;
    const feed = value.feed ?? prior?.feed;
    const ticker = value.ticker ?? prior?.ticker;
    if (!ticker || !feed || decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('B20_METADATA_INVALID');
    base[normalized] = { ticker, feed: requiredAddress(feed), decimals };
  }
  return base;
}

function unavailableConfig(input: RawBaseRuntimeConfig): BaseRuntimeConfig {
  let network: BaseNetwork = 'sepolia';
  try { network = parseNetwork(input.network); } catch { /* stable fallback */ }
  const networkConfig = getBaseNetworkConfig(network);
  return {
    network,
    chainId: networkConfig.chainId,
    networkName: networkConfig.name,
    rpcUrl: networkConfig.rpcUrl,
    apiUrl: '/',
    explorerUrl: networkConfig.explorerUrl,
    usdc: networkConfig.nativeUsdc,
    deployment: {},
    adapters: [],
    b20Assets: {},
    status: 'unavailable',
    writesEnabled: false,
    productionEligible: false,
    forkQa: false,
    liquidationEnabled: false,
    decisionBlockMaxAge: 3n,
    reason: 'CONFIG_UNAVAILABLE',
  };
}

function isLoopbackRpc(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
