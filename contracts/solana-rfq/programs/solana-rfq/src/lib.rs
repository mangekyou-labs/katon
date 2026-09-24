use anchor_lang::prelude::*;
#[cfg(test)]
use anchor_spl::token_interface;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

mod errors;
mod governance;
mod registry;
mod settlement;
mod state;
mod transfer_hook;

pub use errors::ErrorCode;
pub(crate) use registry::*;
pub use state::*;
pub(crate) use transfer_hook::*;
#[cfg(test)]
mod tests;

// The ignored local deploy keypair supplies this Devnet QA program address.
// Mainnet requires a separately reviewed program identity and audited build.
declare_id!("J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib");

const MAX_QUOTE_LIFETIME_SECONDS: i64 = 30;
const CLOSE_GRACE_SECONDS: i64 = 60 * 60;
const GOVERNANCE_DELAY_SECONDS: i64 = 24 * 60 * 60;
// Local fixture by default; deployment builds must inject the reviewed vault.
include!(concat!(env!("OUT_DIR"), "/squads_vault.rs"));
const MAX_FEE_BPS: u16 = 25;
const BPS_DENOMINATOR: u128 = 10_000;
const MAX_HOOK_ACCOUNTS: usize = 16;
const ISSUER_XSTOCKS: u8 = 0;
const ISSUER_ONDO: u8 = 1;
const NATIVE_USDC_MINT: Pubkey = Pubkey::new_from_array([
    198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49, 177, 187, 228,
    194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
]);
const NATIVE_USDT_MINT: Pubkey = Pubkey::new_from_array([
    206, 1, 14, 96, 175, 237, 178, 39, 23, 189, 99, 25, 47, 84, 20, 90, 63, 150, 90, 51, 187, 130,
    210, 199, 2, 158, 178, 206, 30, 32, 130, 100,
]);

#[program]
pub mod solana_rfq {
    use super::*;

    /// Settle the exact terms a seller and an allowlisted maker signed off-chain.
    /// The program never holds inventory: each leg is a direct token-interface CPI.
    pub fn settle_private_quote<'info>(
        ctx: Context<'info, SettlePrivateQuote<'info>>,
        quote_id: [u8; 32],
        issued_at: i64,
        expiry: i64,
        stock_amount: u64,
        maker_min_stock_receipt: u64,
        gross_stable_amount: u64,
        seller_min_stable_receipt: u64,
        fee_bps: u16,
        extension_fingerprint: [u8; 32],
    ) -> Result<()> {
        settlement::settle_private_quote(
            ctx,
            quote_id,
            issued_at,
            expiry,
            stock_amount,
            maker_min_stock_receipt,
            gross_stable_amount,
            seller_min_stable_receipt,
            fee_bps,
            extension_fingerprint,
        )
    }

    /// Anyone may close a receipt after the one-hour grace period. Anchor sends
    /// rent to the original payer, never to the permissionless closer.
    pub fn close_fill_receipt(ctx: Context<CloseFillReceipt>) -> Result<()> {
        settlement::close_fill_receipt(ctx)
    }

    /// Bootstrap governance in a Squads vault transaction. No copied member
    /// list is stored in this program.
    pub fn initialize_governance(
        ctx: Context<InitializeGovernance>,
        guardian: Pubkey,
    ) -> Result<()> {
        governance::initialize_governance(ctx, guardian)
    }

    /// Create the asset registry only after a Squads vault action
    /// has verified the issuer metadata/authority, live mint configuration,
    /// Token-2022 hook, and every hook meta.
    /// The PDA is initialized here, so no permissionless caller can pre-seize
    /// the registry account or choose its first configuration.
    pub fn initialize_asset_registry(
        ctx: Context<InitializeAssetRegistry>,
        issuer: u8,
        stable_outputs: [Pubkey; 2],
        extension_fingerprint: [u8; 32],
        hook_program: Option<Pubkey>,
        hook_accounts: Vec<HookAccountMeta>,
        metadata_pointer: Pubkey,
        issuer_authority: Pubkey,
        issuer_authority_fingerprint: [u8; 32],
        issuer_program: Option<Pubkey>,
        jit_capability_fingerprint: [u8; 32],
    ) -> Result<()> {
        governance::initialize_asset_registry(
            ctx,
            issuer,
            stable_outputs,
            extension_fingerprint,
            hook_program,
            hook_accounts,
            metadata_pointer,
            issuer_authority,
            issuer_authority_fingerprint,
            issuer_program,
            jit_capability_fingerprint,
        )
    }

    /// Create the maker registry through the same vault as asset bootstrap.
    /// The account is initialized once and cannot be replaced by a caller who
    /// merely knows the PDA seeds.
    pub fn initialize_maker_registry(
        ctx: Context<InitializeMakerRegistry>,
        allowlisted: Vec<Pubkey>,
    ) -> Result<()> {
        governance::initialize_maker_registry(ctx, allowlisted)
    }

    /// Queue a versioned immutable asset change; its hash commits to all fields.
    pub fn queue_registry_change(
        ctx: Context<QueueRegistryChange>,
        enabled: bool,
        paused: bool,
        expected_version: u64,
        change_hash: [u8; 32],
    ) -> Result<()> {
        governance::queue_registry_change(ctx, enabled, paused, expected_version, change_hash)
    }

    /// Apply a previously queued registry change after the mandatory delay.
    /// The queued change's target version is checked again to reject stale
    /// proposals.
    pub fn apply_registry_change(ctx: Context<ApplyRegistryChange>) -> Result<()> {
        governance::apply_registry_change(ctx)
    }

    pub fn cancel_registry_change(ctx: Context<CancelRegistryChange>) -> Result<()> {
        governance::cancel_registry_change(ctx)
    }

    /// Queue maker-policy, economics, authority, or program-unpause changes.
    /// The action is immutable in the queue account and cannot apply before
    /// the configured governance delay.
    pub fn queue_governance_action(
        ctx: Context<QueueGovernanceAction>,
        proposal_id: [u8; 32],
        action: GovernanceAction,
        expected_version: u64,
    ) -> Result<()> {
        governance::queue_governance_action(ctx, proposal_id, action, expected_version)
    }

    pub fn apply_governance_action(ctx: Context<ApplyGovernanceAction>) -> Result<()> {
        governance::apply_governance_action(ctx)
    }

    pub fn cancel_governance_action(ctx: Context<CancelGovernanceAction>) -> Result<()> {
        governance::cancel_governance_action(ctx)
    }

    /// The guardian can only pause an asset. It has no authority to unpause,
    /// edit fees, or move funds.
    pub fn guardian_pause_asset(ctx: Context<GuardianPauseAsset>) -> Result<()> {
        governance::guardian_pause_asset(ctx)
    }

    pub fn guardian_pause_program(ctx: Context<GuardianPauseProgram>) -> Result<()> {
        governance::guardian_pause_program(ctx)
    }

    pub fn guardian_pause_makers(ctx: Context<GuardianPauseMakers>) -> Result<()> {
        governance::guardian_pause_makers(ctx)
    }
}

#[derive(Accounts)]
#[instruction(quote_id: [u8; 32])]
pub struct SettlePrivateQuote<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut)]
    pub seller_stock_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub maker_stock_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub maker_stable_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub seller_stable_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub fee_recipient_stable_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The fee recipient is bound to the destination token account;
    /// governance chooses this account when constructing the signed quote.
    pub fee_recipient: UncheckedAccount<'info>,
    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,
    pub stable_mint: Box<InterfaceAccount<'info, Mint>>,
    pub stock_token_program: Interface<'info, TokenInterface>,
    pub stable_token_program: Interface<'info, TokenInterface>,
    #[account(seeds = [b"asset", asset_registry.mint.as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
    #[account(seeds = [b"makers"], bump)]
    pub maker_registry: Account<'info, MakerRegistry>,
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(init, payer = seller, space = 8 + FillReceipt::INIT_SPACE, seeds = [b"fill", maker.key().as_ref(), quote_id.as_ref()], bump)]
    pub fill_receipt: Account<'info, FillReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseFillReceipt<'info> {
    #[account(mut, close = payer, seeds = [b"fill", fill_receipt.maker.as_ref(), fill_receipt.quote_id.as_ref()], bump = fill_receipt.bump)]
    pub fill_receipt: Account<'info, FillReceipt>,
    /// CHECK: The receipt stores and checks this key as its original rent payer.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeGovernance<'info> {
    #[account(init, payer = squads_vault, space = 8 + GovernanceConfig::INIT_SPACE, seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = SQUADS_VAULT_AUTHORITY)]
    pub squads_vault: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeAssetRegistry<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = governance.squads_vault)]
    pub squads_vault: Signer<'info>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    pub stock_token_program: Interface<'info, TokenInterface>,
    pub stable_token_program: Interface<'info, TokenInterface>,
    #[account(init, payer = squads_vault, space = 8 + AssetRegistry::INIT_SPACE, seeds = [b"asset", stock_mint.key().as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeMakerRegistry<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = governance.squads_vault)]
    pub squads_vault: Signer<'info>,
    #[account(init, payer = squads_vault, space = 8 + MakerRegistry::INIT_SPACE, seeds = [b"makers"], bump)]
    pub maker_registry: Account<'info, MakerRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(enabled: bool, paused: bool, expected_version: u64, change_hash: [u8; 32])]
pub struct QueueRegistryChange<'info> {
    #[account(mut, seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = governance.squads_vault)]
    pub squads_vault: Signer<'info>,
    #[account(seeds = [b"asset", asset_registry.mint.as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
    #[account(init, payer = squads_vault, space = 8 + QueuedGovernanceChange::INIT_SPACE, seeds = [b"change", change_hash.as_ref()], bump)]
    pub queued_change: Account<'info, QueuedGovernanceChange>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyRegistryChange<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = governance.squads_vault)]
    pub squads_vault: Signer<'info>,
    #[account(mut, seeds = [b"asset", asset_registry.mint.as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
    #[account(mut, close = squads_vault, seeds = [b"change", queued_change.payload_hash.as_ref()], bump)]
    pub queued_change: Account<'info, QueuedGovernanceChange>,
}

#[derive(Accounts)]
pub struct CancelRegistryChange<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = governance.squads_vault)]
    pub squads_vault: Signer<'info>,
    #[account(mut, close = squads_vault, seeds = [b"change", queued_change.payload_hash.as_ref()], bump)]
    pub queued_change: Account<'info, QueuedGovernanceChange>,
}

#[derive(Accounts)]
#[instruction(proposal_id: [u8; 32])]
pub struct QueueGovernanceAction<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = governance.squads_vault)]
    pub squads_vault: Signer<'info>,
    /// CHECK: Action-specific PDA and ownership are checked by the handler.
    pub target: UncheckedAccount<'info>,
    #[account(init, payer = squads_vault, space = 8 + QueuedGovernanceAction::INIT_SPACE, seeds = [b"governance-action", proposal_id.as_ref()], bump)]
    pub queued_change: Account<'info, QueuedGovernanceAction>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyGovernanceAction<'info> {
    #[account(mut, seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = governance.squads_vault)]
    pub squads_vault: Signer<'info>,
    /// CHECK: Action-specific PDA and ownership are checked by the handler.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
    #[account(mut, close = squads_vault, seeds = [b"governance-action", queued_change.proposal_id.as_ref()], bump)]
    pub queued_change: Account<'info, QueuedGovernanceAction>,
}

#[derive(Accounts)]
pub struct CancelGovernanceAction<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = governance.squads_vault)]
    pub squads_vault: Signer<'info>,
    #[account(mut, close = squads_vault, seeds = [b"governance-action", queued_change.proposal_id.as_ref()], bump)]
    pub queued_change: Account<'info, QueuedGovernanceAction>,
}

#[derive(Accounts)]
pub struct GuardianPauseAsset<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"asset", asset_registry.mint.as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
}

#[derive(Accounts)]
pub struct GuardianPauseProgram<'info> {
    #[account(mut, seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    pub guardian: Signer<'info>,
}

#[derive(Accounts)]
pub struct GuardianPauseMakers<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"makers"], bump)]
    pub maker_registry: Account<'info, MakerRegistry>,
}
