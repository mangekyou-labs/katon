export interface FAssetsConfig {
  readonly enabled: boolean;
  readonly resolveRegistryName: (name: string) => string;
  readonly readFAsset?: (assetManager: string) => string;
}

export interface FxrpAddresses {
  readonly assetManager: string;
  readonly fAsset: string;
}

export interface MintPreparation {
  readonly state: 'awaiting-user-payment';
  readonly destinationTag: number;
  readonly amountUBA: bigint;
  readonly spendable: false;
}

export interface RedeemPreparation {
  readonly state: 'awaiting-user-confirmation';
  readonly amountUBA: bigint;
  readonly underlyingAddress: string;
  readonly spendable: false;
}

export class FAssetsRail {
  constructor(private readonly config: FAssetsConfig) {}

  status(): 'disabled' | 'enabled' {
    return this.config.enabled ? 'enabled' : 'disabled';
  }

  resolveFxrp(): FxrpAddresses {
    if (!this.config.enabled) throw new Error('FASSETS_DISABLED');
    const assetManager = this.config.resolveRegistryName('AssetManagerFXRP');
    if (!assetManager || !this.config.readFAsset) throw new Error('FASSETS_REGISTRY');
    const fAsset = this.config.readFAsset(assetManager);
    if (!fAsset) throw new Error('FASSETS_TOKEN');
    return { assetManager, fAsset };
  }

  prepareMint(input: { destinationTag: number; amountUBA: bigint }): MintPreparation {
    if (!this.config.enabled) throw new Error('FASSETS_DISABLED');
    if (!Number.isInteger(input.destinationTag) || input.destinationTag < 0 || input.destinationTag > 0xffffffff) {
      throw new Error('FASSETS_DESTINATION_TAG');
    }
    if (input.amountUBA <= 0n) throw new Error('FASSETS_AMOUNT');
    return { state: 'awaiting-user-payment', destinationTag: input.destinationTag, amountUBA: input.amountUBA, spendable: false };
  }

  /**
   * Prepare an FXRP redemption that still requires human wallet confirmation.
   * Never signs or submits a transaction.
   */
  prepareRedeem(input: { amountUBA: bigint; underlyingAddress: string }): RedeemPreparation {
    if (!this.config.enabled) throw new Error('FASSETS_DISABLED');
    if (input.amountUBA <= 0n) throw new Error('FASSETS_AMOUNT');
    const underlyingAddress = input.underlyingAddress.trim();
    if (!underlyingAddress || underlyingAddress.length < 8) throw new Error('FASSETS_UNDERLYING');
    return {
      state: 'awaiting-user-confirmation',
      amountUBA: input.amountUBA,
      underlyingAddress,
      spendable: false,
    };
  }
}
