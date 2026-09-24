use anchor_lang::prelude::*;

/// Stable error surface for the public settlement and governance ABI.
#[error_code]
pub enum ErrorCode {
    #[msg("amount must be non-zero")]
    InvalidAmount,
    #[msg("quote expiry is outside the 30 second program limit")]
    InvalidExpiry,
    #[msg("quote window exceeds the active governance limit")]
    InvalidQuoteWindow,
    #[msg("clock is outside the quote [issued_at, expiry] window")]
    ClockOutsideQuoteWindow,
    #[msg("nonzero Token-2022 transfer fee is not eligible for Exact Input")]
    NonzeroTransferFee,
    #[msg("fee exceeds the 25 bps protocol cap")]
    FeeCapExceeded,
    #[msg("asset is disabled or paused")]
    AssetNotEnabled,
    #[msg("program is paused")]
    ProgramPaused,
    #[msg("stock mint does not match registry")]
    MintMismatch,
    #[msg("stock mint decimals do not match registry")]
    DecimalsMismatch,
    #[msg("stable output is not registry-approved")]
    UnsupportedOutput,
    #[msg("issuer is not supported by this settlement program")]
    UnsupportedIssuer,
    #[msg("token program does not match registry")]
    TokenProgramMismatch,
    #[msg("Token-2022 extension fingerprint changed")]
    ExtensionMismatch,
    #[msg("transfer-hook accounts are missing")]
    HookAccountsMissing,
    #[msg("transfer-hook account is invalid")]
    InvalidHookAccount,
    #[msg("transfer-hook account meta does not match governance configuration")]
    HookAccountMismatch,
    #[msg("duplicate transfer-hook account")]
    DuplicateHookAccount,
    #[msg("too many transfer-hook accounts")]
    TooManyHookAccounts,
    #[msg("live mint transfer-hook TLV does not match the asset registry")]
    LiveHookMismatch,
    #[msg("transfer-hook validation account data is invalid")]
    InvalidHookValidationData,
    #[msg("live mint Token-2022 TLV data is invalid")]
    InvalidMintTlv,
    #[msg("issuer metadata pointer is missing or changed")]
    MetadataPointerMismatch,
    #[msg("issuer authority is missing or changed")]
    IssuerAuthorityMismatch,
    #[msg("issuer-specific registry configuration is invalid")]
    IssuerConfigurationMismatch,
    #[msg("issuer requires its managed settlement route")]
    ManagedIssuerRouteRequired,
    #[msg("unexpected transfer-hook accounts")]
    UnexpectedHookAccounts,
    #[msg("duplicate writable account")]
    DuplicateMutableAccount,
    #[msg("maker is not allowlisted")]
    MakerNotAllowlisted,
    #[msg("minimum receipt was not met")]
    MinimumNotMet,
    #[msg("insufficient token balance")]
    InsufficientBalance,
    #[msg("post-transfer balance delta was unexpected")]
    UnexpectedDelta,
    #[msg("checked arithmetic overflow")]
    MathOverflow,
    #[msg("checked arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("receipt cannot be closed before expiry plus one hour")]
    CloseTooEarly,
    #[msg("rent must return to the original payer")]
    RentPayerMismatch,
    #[msg("seller and maker must be distinct signers")]
    DistinctSignersRequired,
    #[msg("token account mint does not match the instruction mint")]
    TokenAccountMismatch,
    #[msg("token account authority does not match the signer")]
    TokenAccountAuthorityMismatch,
    #[msg("signers are not members of the governance quorum")]
    GovernanceSignerRequired,
    #[msg("governance change is not queued")]
    ChangeNotQueued,
    #[msg("governance change hash does not commit to the applied fields")]
    InvalidChangeHash,
    #[msg("governance delay has not elapsed")]
    GovernanceDelayActive,
    #[msg("registry version must increase")]
    RegistryVersionNotIncreasing,
    #[msg("guardian signer is required")]
    GuardianRequired,
    #[msg("maker registry contains an invalid maker")]
    InvalidMaker,
    #[msg("maker registry contains a duplicate maker")]
    DuplicateMaker,
    #[msg("maker registry exceeds the maximum size")]
    TooManyMakers,
    #[msg("only the audited bootstrap authority may initialize governance")]
    BootstrapAuthorityRequired,
    #[msg("quote ID must be nonzero")]
    InvalidQuoteId,
    #[msg("memo-required destination needs the canonical Memo program account")]
    MemoProgramMissing,
    #[msg("Memo program account is invalid")]
    InvalidMemoProgram,
    #[msg("Token-2022 destination account data is invalid")]
    InvalidTokenAccountData,
}
