import type { AssetRegistryEntry } from '@katon/solana-core';
import { verifyDiscoveredMarkets, type LenderAdapter } from './adapters';
import type { ManifestCheck } from './manifest';
import type { LiquidationStartupGate, ManifestGate } from './solver';

/**
 * Runs the process-start checks that make lender adapters executable. The
 * returned gate is immutable: a solver must receive this result rather than
 * querying a manifest and market list independently during an opportunity.
 */
export async function initializeLiquidationStartup(
  manifestGate: ManifestGate,
  lenders: readonly LenderAdapter[],
  assets: readonly AssetRegistryEntry[],
  nowMs: number,
): Promise<LiquidationStartupGate> {
  let manifestCheck: ManifestCheck;
  try {
    manifestCheck = manifestGate.check();
  } catch {
    return new StaticManifestGate({ ok: false, reason: 'manifest_unsigned', message: 'deployment manifest startup check failed' });
  }
  if (!manifestCheck.ok) return new StaticManifestGate(manifestCheck);

  try {
    const discoveredMarkets = (await Promise.all(lenders.map((lender) => lender.discoverMarkets()))).flat();
    const discoveryCheck = verifyDiscoveredMarkets(discoveredMarkets, assets, nowMs);
    if (!discoveryCheck.ok) {
      return new StaticManifestGate({
        ok: false,
        reason: 'market_discovery_invalid',
        message: `authoritative lender market discovery failed: ${discoveryCheck.reason ?? 'invalid market set'}`,
      });
    }
    return new StaticManifestGate({ ok: true, message: 'runtime and reviewed lender markets match deployment manifest' });
  } catch {
    return new StaticManifestGate({ ok: false, reason: 'market_discovery_unavailable', message: 'authoritative lender market discovery is unavailable' });
  }
}

class StaticManifestGate implements LiquidationStartupGate {
  readonly kind = 'liquidation-startup' as const;

  constructor(private readonly result: ManifestCheck) {}

  check(): ManifestCheck {
    return this.result;
  }
}
