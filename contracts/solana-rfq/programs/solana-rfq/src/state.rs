use anchor_lang::prelude::*;

/// Persistent settlement receipt. It stores terms and the original payer so
/// permissionless close can return rent without changing the public ABI.
#[account]
#[derive(InitSpace)]
pub struct FillReceipt {
    pub quote_id: [u8; 32],
    pub maker: Pubkey,
    pub seller: Pubkey,
    pub payer: Pubkey,
    pub expires_at: i64,
    pub gross_stable_amount: u64,
    pub fee_amount: u64,
    pub bump: u8,
}

/// Governance-pinned issuer and Token-2022 configuration for a stock mint.
#[account]
#[derive(InitSpace)]
pub struct AssetRegistry {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub stable_token_program: Pubkey,
    pub stable_outputs: [Pubkey; 2],
    pub issuer: u8,
    /// Governance-recorded issuer metadata account/pointer. This is required
    /// for both classic SPL metadata sources and Token-2022 pointers.
    pub metadata_pointer: Pubkey,
    /// The live mint authority at bootstrap, plus its signed fingerprint.
    pub issuer_authority: Pubkey,
    pub issuer_authority_fingerprint: [u8; 32],
    /// Ondo's issuer program and JIT capability are explicit registry state;
    /// generic settlement rejects this route even when these fields are valid.
    pub issuer_program: Option<Pubkey>,
    pub jit_capability_fingerprint: [u8; 32],
    pub decimals: u8,
    pub extension_fingerprint: [u8; 32],
    pub hook_program: Option<Pubkey>,
    pub hook_validation_data_hash: [u8; 32],
    #[max_len(16)]
    pub hook_accounts: Vec<HookAccountMeta>,
    pub enabled: bool,
    pub paused: bool,
    pub registry_version: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub struct HookAccountMeta {
    pub key: Pubkey,
    pub owner: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
    pub executable: bool,
}

#[account]
#[derive(InitSpace)]
pub struct MakerRegistry {
    #[max_len(64)]
    pub allowlisted: Vec<Pubkey>,
    pub paused: bool,
    pub registry_version: u64,
    /// Latest delayed SetMakers action that produced the effective registry.
    /// Bootstrap allowlists deliberately have no applied-action provenance.
    pub last_applied: Option<AppliedMakerGovernanceAction>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, PartialEq, Eq)]
pub struct AppliedMakerGovernanceAction {
    pub proposal_id: [u8; 32],
    pub payload_hash: [u8; 32],
    pub target: Pubkey,
    pub expected_version: u64,
    pub proposing_vault: Pubkey,
    pub created_at: i64,
    pub apply_after: i64,
    pub applied_at: i64,
    #[max_len(64)]
    pub allowlisted: Vec<Pubkey>,
    pub paused: bool,
    pub registry_version: u64,
}

#[account]
#[derive(InitSpace)]
pub struct GovernanceConfig {
    pub squads_vault: Pubkey,
    pub guardian: Pubkey,
    pub program_paused: bool,
    pub change_delay_seconds: i64,
    pub governance_version: u64,
    pub fee_bps: u16,
    pub max_fee_bps: u16,
    pub max_quote_lifetime_seconds: i64,
    pub max_stock_input_atomic: u64,
}

#[account]
#[derive(InitSpace)]
pub struct QueuedGovernanceChange {
    pub payload_hash: [u8; 32],
    pub target: Pubkey,
    pub expected_version: u64,
    pub enabled: bool,
    pub paused: bool,
    pub apply_after: i64,
}

/// Versioned actions accepted by the explicit 24-hour governance queue.
/// The serialized enum bytes are hashed at proposal time and retained in the
/// queue account, so the apply instruction cannot substitute different terms.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, PartialEq, Eq)]
pub enum GovernanceAction {
    SetAsset {
        mint: Pubkey,
        enabled: bool,
        paused: bool,
    },
    SetMakers {
        #[max_len(64)]
        allowlisted: Vec<Pubkey>,
        paused: bool,
    },
    SetEconomics {
        fee_bps: u16,
        max_fee_bps: u16,
        max_quote_lifetime_seconds: i64,
        max_stock_input_atomic: u64,
    },
    RotateAuthorities {
        next_vault: Pubkey,
        next_guardian: Pubkey,
    },
    UnpauseProgram,
}

#[account]
#[derive(InitSpace)]
pub struct QueuedGovernanceAction {
    pub proposal_id: [u8; 32],
    pub payload_hash: [u8; 32],
    pub target: Pubkey,
    pub expected_version: u64,
    pub proposing_vault: Pubkey,
    pub created_at: i64,
    pub apply_after: i64,
    pub action: GovernanceAction,
}

#[event]
pub struct PrivateQuoteFilled {
    pub quote_id: [u8; 32],
    pub seller: Pubkey,
    pub maker: Pubkey,
    pub stock_mint: Pubkey,
    pub stable_mint: Pubkey,
    pub stock_amount: u64,
    pub gross_stable_amount: u64,
    pub fee_amount: u64,
    pub expiry: i64,
}
