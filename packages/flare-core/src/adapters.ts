export interface FacilityAdapter {
  asset(): string;
  deposit(caller: string, assets: bigint): bigint;
  withdraw(caller: string, assets: bigint, receiver: string): bigint;
  totalAssets(): bigint;
  maxWithdraw(): bigint;
  balanceOf(receiver: string): bigint;
}

export interface LiquidationPositionConfig {
  readonly facility: string;
  readonly venue: string;
  readonly market: string;
  readonly position: string;
  readonly debtAsset: string;
  readonly collateralAsset: string;
  readonly debtOutstanding: bigint;
  readonly collateralAvailable: bigint;
  readonly healthFactorBps: bigint;
  readonly closeFactorBps: bigint;
}

export interface LiquidationRequest {
  readonly caller: string;
  readonly venue: string;
  readonly market: string;
  readonly position: string;
  readonly debtAsset: string;
  readonly collateralAsset: string;
  readonly maxRepay: bigint;
  readonly recipient: string;
}

export interface LiquidationResult {
  readonly repaid: bigint;
  readonly collateral: bigint;
}

export interface AtomicLiquidationAdapter {
  liquidate(request: LiquidationRequest): LiquidationResult;
  pause(): void;
  unpause(): void;
}

export class InMemoryFacilityAdapter implements FacilityAdapter {
  private deployedAssets = 0n;
  private paused = false;
  private readonly receivers = new Map<string, bigint>();

  constructor(private readonly baseAsset: string, private readonly facility: string) {}

  asset(): string {
    return this.baseAsset;
  }

  deposit(caller: string, assets: bigint): bigint {
    this.assertFacility(caller);
    this.assertActive();
    if (assets <= 0n) throw new Error('ADAPTER_AMOUNT');
    this.deployedAssets += assets;
    return assets;
  }

  withdraw(caller: string, assets: bigint, receiver: string): bigint {
    this.assertFacility(caller);
    this.assertActive();
    if (!receiver) throw new Error('ADAPTER_RECEIVER');
    if (assets <= 0n || assets > this.maxWithdraw()) throw new Error('ADAPTER_LIQUIDITY');
    this.deployedAssets -= assets;
    this.receivers.set(receiver, (this.receivers.get(receiver) ?? 0n) + assets);
    return assets;
  }

  totalAssets(): bigint {
    return this.deployedAssets;
  }

  maxWithdraw(): bigint {
    return this.deployedAssets;
  }

  balanceOf(receiver: string): bigint {
    return this.receivers.get(receiver) ?? 0n;
  }

  pause(): void {
    this.paused = true;
  }

  unpause(): void {
    this.paused = false;
  }

  protected assertFacility(caller: string): void {
    if (caller !== this.facility) throw new Error('ADAPTER_CALLER');
  }

  protected assertActive(): void {
    if (this.paused) throw new Error('ADAPTER_PAUSED');
  }
}

export class MorphoAdapter extends InMemoryFacilityAdapter {
  constructor(asset: string, facility: string) {
    super(asset, facility);
  }
}

export class KineticAdapter extends InMemoryFacilityAdapter {
  constructor(asset: string, facility: string) {
    super(asset, facility);
  }
}

export class ClearpoolAdapter extends InMemoryFacilityAdapter {
  constructor(asset: string, facility: string) {
    if (asset !== 'USDX') throw new Error('CLEARPOOL_USDX_ONLY');
    super(asset, facility);
  }
}

abstract class TypedLiquidationAdapter implements AtomicLiquidationAdapter {
  private paused = false;

  protected constructor(protected readonly config: LiquidationPositionConfig) {
    if (!config.facility || !config.venue || !config.market || !config.position) throw new Error('LIQUIDATION_CONFIG');
    if (!config.debtAsset || !config.collateralAsset || config.debtAsset === config.collateralAsset) {
      throw new Error('LIQUIDATION_ASSETS');
    }
    if (config.debtOutstanding <= 0n || config.collateralAvailable <= 0n) throw new Error('LIQUIDATION_BALANCE');
    if (config.healthFactorBps < 0n || config.closeFactorBps <= 0n || config.closeFactorBps > 10_000n) {
      throw new Error('LIQUIDATION_POLICY');
    }
  }

  liquidate(request: LiquidationRequest): LiquidationResult {
    if (this.paused) throw new Error('LIQUIDATION_PAUSED');
    if (request.caller !== this.config.facility) throw new Error('LIQUIDATION_CALLER');
    if (!request.recipient) throw new Error('LIQUIDATION_RECIPIENT');
    if (
      request.venue !== this.config.venue
      || request.market !== this.config.market
      || request.position !== this.config.position
      || request.debtAsset !== this.config.debtAsset
      || request.collateralAsset !== this.config.collateralAsset
    ) throw new Error('LIQUIDATION_BINDING');
    if (this.config.healthFactorBps >= 10_000n) throw new Error('LIQUIDATION_HEALTH');
    if (request.maxRepay <= 0n) throw new Error('LIQUIDATION_AMOUNT');
    const maxClose = (this.config.debtOutstanding * this.config.closeFactorBps) / 10_000n;
    if (request.maxRepay > maxClose) throw new Error('LIQUIDATION_CLOSE_FACTOR');
    const collateral = (this.config.collateralAvailable * request.maxRepay) / this.config.debtOutstanding;
    if (collateral <= 0n || collateral > this.config.collateralAvailable) throw new Error('LIQUIDATION_COLLATERAL');
    return { repaid: request.maxRepay, collateral };
  }

  pause(): void {
    this.paused = true;
  }

  unpause(): void {
    this.paused = false;
  }
}

export class MorphoLiquidationAdapter extends TypedLiquidationAdapter {
  constructor(config: LiquidationPositionConfig) {
    super(config);
  }
}

export class KineticLiquidationAdapter extends TypedLiquidationAdapter {
  constructor(config: LiquidationPositionConfig) {
    super(config);
  }
}

export function assertAdapterConformance(adapter: FacilityAdapter): { asset: string; ok: true } {
  const asset = adapter.asset();
  if (!asset || adapter.totalAssets() < 0n || adapter.maxWithdraw() < 0n) {
    throw new Error('ADAPTER_CONFORMANCE');
  }
  return { asset, ok: true };
}
