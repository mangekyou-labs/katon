import { sanitizePublicProcessEnv } from './base-qa-lib.mjs';
import {
  BASE_FORK_BLOCK,
  BASE_FORK_BLOCK_HASH,
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_NATIVE_USDC,
} from './base-deployment-lib.mjs';

export function buildPublicRuntimeConfig(manifest, apiUrl) {
  assertManifest(manifest);
  const forkQa = manifest.environment === 'anvil';
  return {
    network: forkQa ? 'mainnet' : 'sepolia',
    networkName: forkQa ? 'Base Mainnet Fork (local)' : 'Base Sepolia',
    chainId: manifest.chainId,
    rpcUrl: manifest.rpcUrl,
    apiUrl,
    nativeUsdc: manifest.nativeUsdc,
    routerAddress: manifest.addresses.router,
    settlementAddress: manifest.addresses.settlement,
    facilityAddress: manifest.addresses.facility,
    oracleGuardAddress: manifest.addresses.oracleGuard,
    b20GuardAddress: manifest.addresses.b20Guard,
    adapterAddresses: manifest.adapters.map((adapter) => typeof adapter === 'string' ? adapter : adapter.address),
    b20Assets: manifest.b20Assets ?? {},
    productionEligible: false,
    forkQa,
    ...(forkQa ? { forkBlock: manifest.forkBlock, forkBlockHash: manifest.forkBlockHash } : {}),
  };
}

export function buildStackEnvironment(environment, target, manifest) {
  const clean = sanitizePublicProcessEnv(environment);
  const runtime = buildPublicRuntimeConfig({ ...manifest, rpcUrl: target.rpcUrl }, target.apiUrl);
  const forkQa = manifest.environment === 'anvil' || target.chainId === BASE_MAINNET_CHAIN_ID;
  const apiOrigin = new URL(target.apiUrl);
  const dappOrigin = environment.BASE_QA_DAPP_URL ? new URL(environment.BASE_QA_DAPP_URL).origin : 'http://127.0.0.1:5174';
  const result = {
    ...clean,
    NODE_ENV: 'development',
    KATON_BASE_NETWORK: forkQa ? 'mainnet' : 'sepolia',
    KATON_BASE_CHAIN_ID: String(forkQa ? BASE_MAINNET_CHAIN_ID : 84532),
    KATON_BASE_RPC_URL: target.rpcUrl,
    KATON_BASE_FORK_QA: String(forkQa),
    KATON_BASE_PRODUCTION_ELIGIBLE: 'false',
    KATON_BASE_ROUTER_ADDRESS: manifest.addresses.router.toLowerCase(),
    KATON_BASE_SETTLEMENT_ADDRESS: manifest.addresses.settlement.toLowerCase(),
    KATON_BASE_FACILITY_ADDRESSES: manifest.addresses.facility.toLowerCase(),
    KATON_BASE_ADAPTER_ADDRESSES: runtime.adapterAddresses.map((address) => address.toLowerCase()).join(','),
    KATON_BASE_ORACLE_GUARD_ADDRESS: manifest.addresses.oracleGuard.toLowerCase(),
    KATON_BASE_B20_GUARD_ADDRESS: manifest.addresses.b20Guard.toLowerCase(),
    KATON_BASE_BROWSER_ORIGINS: dappOrigin,
    KATON_BASE_API_PORT: apiOrigin.port || '4010',
    KATON_DECISION_BLOCK_MAX_AGE: '3',
    KATON_FEE_BPS: '0',
    KATON_INSECURE_LOCAL: 'true',
    VITE_KATON_BASE_CONFIG: JSON.stringify(runtime),
  };
  if (forkQa) {
    const adapter = manifest.adapters[0];
    const assetEntry = Object.entries(manifest.b20Assets ?? {})[0];
    if (!adapter || typeof adapter === 'string' || !assetEntry || !manifest.roles?.lp) throw new Error('BASE_QA_FORK_SNAPSHOT_MANIFEST');
    const [b20, asset] = assetEntry;
    result.KATON_BASE_QA_FORK_SNAPSHOT = JSON.stringify({
      chainId: BASE_MAINNET_CHAIN_ID,
      nativeUsdc: manifest.nativeUsdc,
      b20,
      adapter: adapter.address,
      marketId: adapter.marketId,
      oracleGuard: manifest.addresses.oracleGuard,
      b20Guard: manifest.addresses.b20Guard,
      router: manifest.addresses.router,
      settlement: manifest.addresses.settlement,
      lp: manifest.roles.lp,
      feed: asset.feed,
      ticker: asset.ticker,
      decimals: asset.decimals,
      classification: 'BASE_MAINNET_FORK_QA',
      venueEvidence: false,
      forkBlock: manifest.forkBlock ?? BASE_FORK_BLOCK,
      forkBlockHash: manifest.forkBlockHash ?? BASE_FORK_BLOCK_HASH,
    });
  }
  return result;
}

function assertManifest(manifest) {
  const forkQa = manifest?.environment === 'anvil';
  const expectedChainId = forkQa ? BASE_MAINNET_CHAIN_ID : 84532;
  const expectedUsdc = forkQa ? BASE_MAINNET_NATIVE_USDC : undefined;
  if (!manifest || manifest.chainId !== expectedChainId || !manifest.nativeUsdc || !manifest.addresses) throw new Error('BASE_QA_MANIFEST');
  if (expectedUsdc && manifest.nativeUsdc.toLowerCase() !== expectedUsdc.toLowerCase()) throw new Error('BASE_QA_MANIFEST:NATIVE_USDC');
  if (forkQa && (manifest.forkQa !== true || manifest.forkBlock !== BASE_FORK_BLOCK || manifest.forkBlockHash?.toLowerCase() !== BASE_FORK_BLOCK_HASH.toLowerCase())) {
    throw new Error('BASE_QA_MANIFEST:FORK');
  }
  for (const name of ['router', 'settlement', 'facility', 'oracleGuard', 'b20Guard']) {
    if (!/^0x[0-9a-fA-F]{40}$/u.test(manifest.addresses[name] ?? '')) throw new Error(`BASE_QA_MANIFEST:${name}`);
  }
  if (!Array.isArray(manifest.adapters)) throw new Error('BASE_QA_MANIFEST:adapters');
}
