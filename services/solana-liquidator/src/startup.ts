import type { AssetRegistryEntry } from '@katon/solana-core';
import { verifyDiscoveredMarkets, type DiscoveredMarket, type LenderAdapter } from './adapters';
import type { DeploymentManifestGate, ManifestCheck } from './manifest';
import { LiquidationCircuitBreaker, LiquidationSolver, type SolverConfig } from './solver';

const STARTUP_GATE_TOKEN = Symbol('liquidation startup gate');
const STARTUP_GATE_BRAND: unique symbol = Symbol('validated liquidation startup gate');

/** Opaque, immutable result of process startup validation. */
export interface LiquidationStartupGate {
  readonly [STARTUP_GATE_BRAND]: true;
  check(): ManifestCheck;
  matchesMarket(market: DiscoveredMarket | undefined): boolean;
}

class ValidatedLiquidationStartupGate implements LiquidationStartupGate {
  readonly [STARTUP_GATE_BRAND] = true as const;

  static create(
    result: ManifestCheck,
    markets: readonly DiscoveredMarket[],
  ): LiquidationStartupGate {
    return new ValidatedLiquidationStartupGate(result, markets, STARTUP_GATE_TOKEN);
  }

  private constructor(
    private readonly result: ManifestCheck,
    private readonly markets: readonly DiscoveredMarket[],
    token: typeof STARTUP_GATE_TOKEN,
  ) {
    if (token !== STARTUP_GATE_TOKEN) throw new Error('liquidation startup gate must come from startup validation');
  }

  check(): ManifestCheck {
    return this.result;
  }

  matchesMarket(market: DiscoveredMarket | undefined): boolean {
    if (!this.result.ok || !market) return false;
    return this.markets.some((candidate) => (
      candidate.lender === market.lender
      && candidate.programId === market.programId
      && candidate.marketAddress === market.marketAddress
      && candidate.reserveAddress === market.reserveAddress
      && candidate.vaultAddress === market.vaultAddress
      && candidate.collateralMint === market.collateralMint
      && candidate.debtMint === market.debtMint
      && candidate.oracleAddress === market.oracleAddress
      && candidate.idlSha256 === market.idlSha256
      && candidate.bytecodeSha256 === market.bytecodeSha256
      && candidate.upgradeAuthority === market.upgradeAuthority
    ));
  }
}

function createLiquidationStartupGate(result: ManifestCheck, markets: readonly DiscoveredMarket[] = []): LiquidationStartupGate {
  return ValidatedLiquidationStartupGate.create(result, [...markets]);
}

/**
 * Runs the process-start checks that make lender adapters executable. The
 * returned gate is immutable: a solver must receive this result rather than
 * querying a manifest and market list independently during an opportunity.
 */
export async function initializeLiquidationStartup(
  manifestGate: DeploymentManifestGate,
  lenders: readonly LenderAdapter[],
  assets: readonly AssetRegistryEntry[],
  nowMs: number,
): Promise<LiquidationStartupGate> {
  let manifestCheck: ManifestCheck;
  try {
    manifestCheck = manifestGate.check();
  } catch {
    return createLiquidationStartupGate({ ok: false, reason: 'manifest_unsigned', message: 'deployment manifest startup check failed' });
  }
  if (!manifestCheck.ok) return createLiquidationStartupGate(manifestCheck);

  try {
    const discoveredMarkets = (await Promise.all(lenders.map((lender) => lender.discoverMarkets()))).flat();
    const discoveryCheck = verifyDiscoveredMarkets(discoveredMarkets, assets, nowMs, 30_000, (market) => manifestGate.verifyMarket(market));
    if (!discoveryCheck.ok) {
      return createLiquidationStartupGate({
        ok: false,
        reason: 'market_discovery_invalid',
        message: `authoritative lender market discovery failed: ${discoveryCheck.reason ?? 'invalid market set'}`,
      });
    }
    return createLiquidationStartupGate({ ok: true, message: 'runtime and reviewed lender markets match deployment manifest' }, discoveredMarkets);
  } catch {
    return createLiquidationStartupGate({ ok: false, reason: 'market_discovery_unavailable', message: 'authoritative lender market discovery is unavailable' });
  }
}

/**
 * Production construction seam: startup validation completes before a solver
 * exists. Callers receive no executable solver when manifest or market checks
 * fail, so an unvalidated process cannot accidentally enter liquidation.
 */
export async function startLiquidationSolver(
  manifestGate: DeploymentManifestGate,
  lenders: readonly LenderAdapter[],
  assets: readonly AssetRegistryEntry[],
  nowMs: number,
  config: SolverConfig,
  breaker = new LiquidationCircuitBreaker(),
): Promise<{ readonly startupGate: LiquidationStartupGate; readonly solver?: LiquidationSolver }> {
  const startupGate = await initializeLiquidationStartup(manifestGate, lenders, assets, nowMs);
  if (!startupGate.check().ok) return { startupGate };
  return { startupGate, solver: new LiquidationSolver(breaker, config, startupGate) };
}
