export type Issuer = 'xstocks' | 'ondo';
export type TokenProgram = 'spl-token' | 'token-2022';
export type EligibilityStatus = 'eligible' | 'action_required' | 'ineligible' | 'unknown';
export type ReferenceState = 'open' | 'closed' | 'stale' | 'unknown';
export type QuoteSourceKind = 'jupiter' | 'private-maker';
export type QuoteSessionState =
  | 'validating'
  | 'action_required'
  | 'ineligible'
  | 'unknown'
  | 'collecting'
  | 'ready'
  | 'no_quote'
  | 'expired'
  | 'reviewing'
  | 'signing'
  | 'submitting'
  | 'confirmed'
  | 'finalized'
  | 'failed';

export type StructuredRejectionCode =
  | 'failed_simulation'
  | 'expired'
  | 'unsupported_output'
  | 'input_mismatch'
  | 'output_mismatch'
  | 'insufficient_balance'
  | 'insufficient_liquidity'
  | 'policy_failure'
  | 'unsupported_extension'
  | 'changed_extension'
  | 'paused_asset'
  | 'stale_reference'
  | 'price_band'
  | 'malformed_quote'
  | 'source_error'
  | 'transaction_unavailable'
  | 'unknown';

export interface TokenCapabilities {
  readonly transferHook: boolean;
  readonly pausable: boolean;
  readonly scaledUiAmount: boolean;
  readonly transferFee: boolean;
  readonly permanentDelegate: boolean;
  readonly memoTransfer: boolean;
  readonly confidentialTransfer: boolean;
}

export interface AssetRegistryEntry {
  readonly mint: string;
  readonly issuer: Issuer;
  readonly ticker: string;
  readonly underlyingTicker: string;
  readonly tokenProgram: TokenProgram;
  readonly decimals: number;
  readonly extensionFingerprint: string;
  readonly expectedHookProgram?: string;
  readonly capabilities: TokenCapabilities;
  readonly supportedOutputs: readonly string[];
  readonly referenceState: ReferenceState;
  readonly referencePriceAtomic?: string;
  readonly referencePriceDecimals?: number;
  readonly referenceTimestampMs?: number;
  readonly maxDeviationBps: number;
  readonly enabled: boolean;
  readonly registryVersion: number;
}

export interface MintAccountSnapshot {
  readonly mint: string;
  readonly ownerProgram: TokenProgram;
  readonly decimals: number;
  readonly extensionFingerprint: string;
  readonly extensions: readonly string[];
  readonly expectedHookProgram?: string;
  readonly paused: boolean;
  readonly metadataPointer?: string;
  readonly scaledUiAmountEnabled: boolean;
  readonly transferFeeBps?: number;
  readonly permanentDelegate?: string;
  readonly memoTransferRequired: boolean;
}

export interface EligibilityResult {
  readonly status: EligibilityStatus;
  readonly code?: StructuredRejectionCode;
  readonly message: string;
  readonly asset?: AssetRegistryEntry;
  readonly balanceAtomic?: string;
  readonly checkedAtMs: number;
}

export interface SimulationResult {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly unitsConsumed?: number;
  readonly simulatedAtMs: number;
}

export interface QuoteCandidate {
  readonly quoteId: string;
  readonly sourceId: string;
  readonly sourceKind: QuoteSourceKind;
  readonly router: string;
  readonly wallet: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
  readonly grossOutputAtomic: string;
  readonly katonFeeAtomic: string;
  readonly venueFeeAtomic: string;
  readonly netOutputAtomic: string;
  readonly referencePriceAtomic?: string;
  readonly referencePriceDecimals?: number;
  readonly deviationBps?: number;
  readonly priceImpactBps?: number;
  readonly effectivePriceAtomic?: string;
  readonly effectivePriceDecimals?: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly reliabilityBps: number;
  readonly transactionVersion: 'v0';
  readonly transactionBase64?: string;
  readonly transactionHash?: string;
  readonly simulation: SimulationResult;
  readonly rejection?: {
    readonly code: StructuredRejectionCode;
    readonly message: string;
  };
}

export interface VerifiedSourceBalance {
  readonly sourceId: string;
  readonly outputMint: string;
  readonly balanceAtomic: string;
  readonly checkedAtMs: number;
}

export interface SanitizedAuditRow {
  readonly sourceClass: QuoteSourceKind;
  readonly netOutputAtomic?: string;
  readonly receivedAtMs: number;
  readonly rejectionCode?: StructuredRejectionCode;
  readonly status: 'executable' | 'rejected';
}

export interface QuoteSessionRequest {
  readonly wallet: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
}

export interface QuoteSession {
  readonly id: string;
  readonly request: QuoteSessionRequest;
  readonly eligibility: EligibilityResult;
  readonly state: QuoteSessionState;
  readonly createdAtMs: number;
  readonly collectionDeadlineMs: number;
  readonly winner?: QuoteCandidate;
  readonly audit: readonly SanitizedAuditRow[];
  readonly failureMessage?: string;
}

export interface TradeReceipt {
  readonly tradeId: string;
  readonly quoteId: string;
  readonly wallet: string;
  readonly signature: string;
  readonly sourceKind: QuoteSourceKind;
  readonly sourceId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: string;
  readonly grossOutputAtomic: string;
  readonly netOutputAtomic: string;
  readonly katonFeeAtomic: string;
  readonly venueFeeAtomic: string;
  readonly deviationBps?: number;
  readonly priceImpactBps?: number;
  readonly effectivePriceAtomic?: string;
  readonly effectivePriceDecimals?: number;
  readonly createdAtMs: number;
  readonly confirmedAtMs: number;
  readonly finalizedAtMs?: number;
}
