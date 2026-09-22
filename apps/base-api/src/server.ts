import 'reflect-metadata';
import type { Address } from 'viem';
import { createBaseReadOnlyClient } from '../../../services/indexer/src/base/worker';
import {
  createBaseApi,
  InMemoryBaseRepository,
  InMemoryNotificationPort,
  MongoBaseRepository,
  NonceService,
  ReadOnlySnapshotPort,
  ReadOnlyViemSignaturePort,
  ViemBaseSwapPreflightPort,
  SessionService,
  SystemClock,
  loadBaseApiConfig,
  UnavailableDashboardReadPort,
  ViemDashboardReadPort,
  HttpEligibilityPort,
  HttpSwapQuotePort,
} from './app';
import type {
  BaseClock,
  BaseNotificationPort,
  BaseSignaturePort,
  BaseSnapshotPort,
  BaseSwapPreflightPort,
  BaseSwapQuotePort,
} from './types';
import type { BaseRepository } from './ports';
import type { BaseDashboardReadPort } from './dashboard';
import { B20_ASSETS_BY_ADDRESS } from '../../../packages/base-core/src/assets';
import { BaseForkQaSnapshotPort, assertBaseForkQaSnapshotEnvironment, parseBaseForkQaSnapshotConfig } from './qa';

/** Injectable seams used by deterministic local validation and contract tests.
 * Production callers leave this empty so all ports are built from configuration.
 */
export interface BaseApiServerOverrides {
  readonly repository?: BaseRepository;
  readonly clock?: BaseClock;
  readonly snapshot?: BaseSnapshotPort;
  readonly signatures?: BaseSignaturePort;
  readonly notifications?: BaseNotificationPort;
  readonly dashboard?: BaseDashboardReadPort;
  readonly swapQuotes?: BaseSwapQuotePort;
  readonly swapPreflight?: BaseSwapPreflightPort;
}

export async function startBaseApi(overrides: BaseApiServerOverrides = {}) {
  const config = loadBaseApiConfig();
  const repository = overrides.repository ?? (config.mongoUri
    ? new MongoBaseRepository(config.mongoUri, config.mongoDbName ?? 'katon')
    : new InMemoryBaseRepository());
  if (repository instanceof MongoBaseRepository) await repository.connect();
  const sessionService = repository instanceof MongoBaseRepository
    ? new SessionService(config, repository.sessionStore())
    : new SessionService(config);
  const nonceService = repository instanceof MongoBaseRepository
    ? new NonceService(repository.nonceStore())
    : new NonceService();
  const client = config.rpcUrl ? createBaseReadOnlyClient(config.chainId, config.rpcUrl) : undefined;
  if (!client && process.env.NODE_ENV === 'production') throw new Error('BASE_RPC_URL_REQUIRED');
  const qaSnapshotConfig = process.env.KATON_BASE_QA_FORK_SNAPSHOT
    ? parseBaseForkQaSnapshotConfig(process.env.KATON_BASE_QA_FORK_SNAPSHOT)
    : undefined;
  if (qaSnapshotConfig) {
    if (process.env.NODE_ENV === 'production' || !client || !config.rpcUrl) throw new Error('BASE_QA_SNAPSHOT_DISABLED');
    assertBaseForkQaSnapshotEnvironment(config.chainId, config.rpcUrl);
  }
  const clock = overrides.clock ?? new SystemClock();
  const b20Assets: Record<string, { readonly ticker: string; readonly feed: Address; readonly decimals: number }> =
    Object.fromEntries(Object.entries(B20_ASSETS_BY_ADDRESS).map(([address, asset]) => [address.toLowerCase(), asset]));
  if (qaSnapshotConfig) {
    b20Assets[qaSnapshotConfig.b20.toLowerCase()] = {
      ticker: qaSnapshotConfig.ticker,
      feed: qaSnapshotConfig.feed,
      decimals: qaSnapshotConfig.decimals,
    };
  }
  const dashboard = overrides.dashboard ?? (client && (config.facilityAddresses?.length ?? 0) > 0 && config.oracleGuardAddress && config.b20GuardAddress
    ? new ViemDashboardReadPort(client, {
      facilityAddresses: config.facilityAddresses ?? [],
      oracleGuardAddress: config.oracleGuardAddress,
      b20GuardAddress: config.b20GuardAddress,
      b20Assets,
      history: repository,
    })
    : new UnavailableDashboardReadPort());
  const hasSwapProvider = Boolean(
    config.swapMakerQuoteUrl
    || config.swapFacilityQuoteUrl
    || Object.values(config.swapExternalQuoteUrls ?? {}).some(Boolean),
  );
  const swapQuotes = overrides.swapQuotes ?? (hasSwapProvider
    ? new HttpSwapQuotePort({
      makerUrl: config.swapMakerQuoteUrl,
      facilityUrl: config.swapFacilityQuoteUrl,
      externalUrls: config.swapExternalQuoteUrls,
      apiKeys: config.swapProviderApiKeys,
      timeoutMs: config.swapProviderTimeoutMs,
    })
    : undefined);
  const eligibility = config.eligibilityUrl
    ? new HttpEligibilityPort({ url: config.eligibilityUrl, timeoutMs: config.swapProviderTimeoutMs })
    : undefined;
  const swapPreflight = overrides.swapPreflight ?? (client && config.routerAddress && config.settlementAddress
    ? new ViemBaseSwapPreflightPort(client, config.decisionBlockMaxAge, config.routerAddress, config.settlementAddress)
    : undefined);
  const signatures = overrides.signatures ?? (client
    ? new ReadOnlyViemSignaturePort(client, config.settlementAddress)
    : new ReadOnlyViemSignaturePort(createBaseReadOnlyClient(config.chainId, config.rpcUrl ?? 'http://127.0.0.1:8545'), config.settlementAddress));
  const app = await createBaseApi({
    config,
    repository,
    clock,
    snapshot: overrides.snapshot ?? (qaSnapshotConfig
      ? new BaseForkQaSnapshotPort(client as unknown as ConstructorParameters<typeof BaseForkQaSnapshotPort>[0], qaSnapshotConfig)
      : new ReadOnlySnapshotPort(undefined, repository)),
    signatures,
    notifications: overrides.notifications ?? new InMemoryNotificationPort(),
    dashboard,
    ...(swapQuotes ? { swapQuotes } : {}),
    ...(swapPreflight ? { swapPreflight } : {}),
    ...(eligibility ? { eligibility } : {}),
    nonceService,
    sessionService,
  });
  await app.listen(Number(process.env.KATON_BASE_API_PORT ?? '8788'));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startBaseApi();
}
