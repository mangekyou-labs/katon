use anchor_lang::__private::bytemuck::{Pod, Zeroable};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_hook::TransferHook;
use anchor_spl::token_interface::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
#[cfg(test)]
use anchor_spl::token_interface::spl_token_2022::extension::{
    BaseStateWithExtensionsMut, StateWithExtensionsMut,
};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use spl_discriminator::SplDiscriminate;
use spl_pod::{list::ListView, primitives::PodBool};
#[cfg(test)]
use spl_type_length_value::state::TlvStateMut;
use spl_type_length_value::state::{TlvState, TlvStateBorrowed};

// Deterministic local scaffold address. A deployment key and audited program
// build must replace this address before any devnet or mainnet deployment.
declare_id!("59MVYbUATHzCgYtD7uio4RvCkZhdwrRh6c38ZefycwMX");

const MAX_QUOTE_LIFETIME_SECONDS: i64 = 30;
const CLOSE_GRACE_SECONDS: i64 = 60 * 60;
const GOVERNANCE_DELAY_SECONDS: i64 = 24 * 60 * 60;
const MAX_FEE_BPS: u16 = 25;
const BPS_DENOMINATOR: u128 = 10_000;
const MAX_HOOK_ACCOUNTS: usize = 16;

// The production build must replace this audited, compile-time authority with
// the address controlled by the deployment ceremony. Keeping it outside the
// instruction data prevents an arbitrary payer from becoming first governance.
const BOOTSTRAP_AUTHORITY: Pubkey = Pubkey::new_from_array([0x42; 32]);

#[derive(SplDiscriminate)]
#[discriminator_hash_input("spl-transfer-hook-interface:execute")]
struct TransferHookExecuteInstruction;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
struct TransferHookExtraAccountMeta {
    discriminator: u8,
    address_config: [u8; 32],
    is_signer: PodBool,
    is_writable: PodBool,
}

#[program]
pub mod solana_rfq {
    use super::*;

    /// Settle the exact terms a seller and an allowlisted maker signed off-chain.
    /// The program never holds inventory: each leg is a direct token-interface CPI.
    pub fn settle_private_quote<'info>(
        ctx: Context<'info, SettlePrivateQuote<'info>>,
        quote_id: [u8; 32],
        expiry: i64,
        stock_amount: u64,
        maker_min_stock_receipt: u64,
        gross_stable_amount: u64,
        seller_min_stable_receipt: u64,
        fee_bps: u16,
        extension_fingerprint: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            stock_amount > 0 && gross_stable_amount > 0,
            ErrorCode::InvalidAmount
        );
        require!(
            expiry >= now && expiry <= now.saturating_add(MAX_QUOTE_LIFETIME_SECONDS),
            ErrorCode::InvalidExpiry
        );
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeCapExceeded);

        let registry = &ctx.accounts.asset_registry;
        require!(
            registry.enabled && !registry.paused,
            ErrorCode::AssetNotEnabled
        );
        require_keys_eq!(
            registry.mint,
            ctx.accounts.stock_mint.key(),
            ErrorCode::MintMismatch
        );
        require_eq!(
            registry.decimals,
            ctx.accounts.stock_mint.decimals,
            ErrorCode::DecimalsMismatch
        );
        require!(
            registry
                .stable_outputs
                .contains(&ctx.accounts.stable_mint.key()),
            ErrorCode::UnsupportedOutput
        );
        require_keys_eq!(
            registry.token_program,
            ctx.accounts.stock_token_program.key(),
            ErrorCode::TokenProgramMismatch
        );
        require_keys_eq!(
            registry.stable_token_program,
            ctx.accounts.stable_token_program.key(),
            ErrorCode::TokenProgramMismatch
        );
        require_keys_eq!(
            *ctx.accounts.stock_mint.to_account_info().owner,
            ctx.accounts.stock_token_program.key(),
            ErrorCode::TokenProgramMismatch
        );
        require_keys_eq!(
            *ctx.accounts.stable_mint.to_account_info().owner,
            ctx.accounts.stable_token_program.key(),
            ErrorCode::TokenProgramMismatch
        );
        require!(
            registry.extension_fingerprint == extension_fingerprint,
            ErrorCode::ExtensionMismatch
        );
        validate_live_mint_configuration(
            &ctx.accounts.stock_mint.to_account_info(),
            registry.hook_program,
            registry.extension_fingerprint,
        )?;
        validate_hook_accounts(
            ctx.remaining_accounts,
            registry,
            &[
                ctx.accounts.seller_stock_account.key(),
                ctx.accounts.maker_stock_account.key(),
                ctx.accounts.maker_stable_account.key(),
                ctx.accounts.seller_stable_account.key(),
                ctx.accounts.fee_recipient_stable_account.key(),
                ctx.accounts.seller.key(),
                ctx.accounts.maker.key(),
                ctx.accounts.stock_mint.key(),
                ctx.accounts.stable_mint.key(),
                ctx.accounts.fee_recipient.key(),
            ],
        )?;
        if let Some(hook_program) = registry.hook_program {
            let mut hook_execution_accounts = vec![
                ctx.accounts.seller_stock_account.to_account_info(),
                ctx.accounts.stock_mint.to_account_info(),
                ctx.accounts.maker_stock_account.to_account_info(),
                ctx.accounts.seller.to_account_info(),
            ];
            hook_execution_accounts.extend_from_slice(ctx.remaining_accounts);
            validate_transfer_hook_execution(&hook_execution_accounts, hook_program, stock_amount)?;
        }
        require!(
            ctx.accounts
                .maker_registry
                .allowlisted
                .contains(&ctx.accounts.maker.key()),
            ErrorCode::MakerNotAllowlisted
        );
        require!(
            ctx.accounts.seller.key() != ctx.accounts.maker.key(),
            ErrorCode::DistinctSignersRequired
        );
        require_keys_eq!(
            ctx.accounts.seller_stock_account.mint,
            ctx.accounts.stock_mint.key(),
            ErrorCode::TokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.maker_stock_account.mint,
            ctx.accounts.stock_mint.key(),
            ErrorCode::TokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.maker_stable_account.mint,
            ctx.accounts.stable_mint.key(),
            ErrorCode::TokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.seller_stable_account.mint,
            ctx.accounts.stable_mint.key(),
            ErrorCode::TokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.fee_recipient_stable_account.mint,
            ctx.accounts.stable_mint.key(),
            ErrorCode::TokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.seller_stock_account.owner,
            ctx.accounts.seller.key(),
            ErrorCode::TokenAccountAuthorityMismatch
        );
        require_keys_eq!(
            ctx.accounts.maker_stock_account.owner,
            ctx.accounts.maker.key(),
            ErrorCode::TokenAccountAuthorityMismatch
        );
        require_keys_eq!(
            ctx.accounts.maker_stable_account.owner,
            ctx.accounts.maker.key(),
            ErrorCode::TokenAccountAuthorityMismatch
        );
        require_keys_eq!(
            ctx.accounts.seller_stable_account.owner,
            ctx.accounts.seller.key(),
            ErrorCode::TokenAccountAuthorityMismatch
        );
        require_keys_eq!(
            ctx.accounts.fee_recipient_stable_account.owner,
            ctx.accounts.fee_recipient.key(),
            ErrorCode::TokenAccountAuthorityMismatch
        );
        validate_distinct_mutable_keys(&[
            ctx.accounts.seller_stock_account.key(),
            ctx.accounts.maker_stock_account.key(),
            ctx.accounts.maker_stable_account.key(),
            ctx.accounts.seller_stable_account.key(),
            ctx.accounts.fee_recipient_stable_account.key(),
        ])?;

        let fee = u128::from(gross_stable_amount)
            .checked_mul(u128::from(fee_bps))
            .ok_or(ErrorCode::MathOverflow)?
            / BPS_DENOMINATOR;
        let fee = u64::try_from(fee).map_err(|_| error!(ErrorCode::MathOverflow))?;
        let seller_stable_amount = gross_stable_amount
            .checked_sub(fee)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(
            seller_stable_amount >= seller_min_stable_receipt,
            ErrorCode::MinimumNotMet
        );

        let seller_stock_before = ctx.accounts.seller_stock_account.amount;
        let maker_stock_before = ctx.accounts.maker_stock_account.amount;
        let maker_stable_before = ctx.accounts.maker_stable_account.amount;
        let seller_stable_before = ctx.accounts.seller_stable_account.amount;
        let fee_recipient_before = ctx.accounts.fee_recipient_stable_account.amount;
        require!(
            seller_stock_before >= stock_amount,
            ErrorCode::InsufficientBalance
        );
        require!(
            maker_stable_before >= gross_stable_amount,
            ErrorCode::InsufficientBalance
        );

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.stock_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.seller_stock_account.to_account_info(),
                    mint: ctx.accounts.stock_mint.to_account_info(),
                    to: ctx.accounts.maker_stock_account.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            stock_amount,
            ctx.accounts.stock_mint.decimals,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.stable_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.maker_stable_account.to_account_info(),
                    mint: ctx.accounts.stable_mint.to_account_info(),
                    to: ctx.accounts.seller_stable_account.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            seller_stable_amount,
            ctx.accounts.stable_mint.decimals,
        )?;
        if fee > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.stable_token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.maker_stable_account.to_account_info(),
                        mint: ctx.accounts.stable_mint.to_account_info(),
                        to: ctx.accounts.fee_recipient_stable_account.to_account_info(),
                        authority: ctx.accounts.maker.to_account_info(),
                    },
                ),
                fee,
                ctx.accounts.stable_mint.decimals,
            )?;
        }

        ctx.accounts.seller_stock_account.reload()?;
        ctx.accounts.maker_stock_account.reload()?;
        ctx.accounts.maker_stable_account.reload()?;
        ctx.accounts.seller_stable_account.reload()?;
        ctx.accounts.fee_recipient_stable_account.reload()?;
        require!(
            seller_stock_before.checked_sub(ctx.accounts.seller_stock_account.amount)
                == Some(stock_amount),
            ErrorCode::UnexpectedDelta
        );
        require!(
            ctx.accounts
                .maker_stock_account
                .amount
                .checked_sub(maker_stock_before)
                .unwrap_or(0)
                >= maker_min_stock_receipt,
            ErrorCode::MinimumNotMet
        );
        require!(
            maker_stable_before
                .checked_sub(ctx.accounts.maker_stable_account.amount)
                .unwrap_or(0)
                == gross_stable_amount,
            ErrorCode::UnexpectedDelta
        );
        require!(
            ctx.accounts
                .seller_stable_account
                .amount
                .checked_sub(seller_stable_before)
                .unwrap_or(0)
                >= seller_min_stable_receipt,
            ErrorCode::MinimumNotMet
        );
        require!(
            ctx.accounts
                .fee_recipient_stable_account
                .amount
                .checked_sub(fee_recipient_before)
                .unwrap_or(0)
                == fee,
            ErrorCode::UnexpectedDelta
        );

        let receipt = &mut ctx.accounts.fill_receipt;
        receipt.quote_id = quote_id;
        receipt.maker = ctx.accounts.maker.key();
        receipt.seller = ctx.accounts.seller.key();
        receipt.payer = ctx.accounts.seller.key();
        receipt.expires_at = expiry;
        receipt.gross_stable_amount = gross_stable_amount;
        receipt.fee_amount = fee;
        receipt.bump = ctx.bumps.fill_receipt;
        emit!(PrivateQuoteFilled {
            quote_id,
            seller: receipt.seller,
            maker: receipt.maker,
            stock_mint: registry.mint,
            stable_mint: ctx.accounts.stable_mint.key(),
            stock_amount,
            gross_stable_amount,
            fee_amount: fee,
            expiry,
        });
        Ok(())
    }

    /// Anyone may close a receipt after the one-hour grace period. Anchor sends
    /// rent to the original payer, never to the permissionless closer.
    pub fn close_fill_receipt(ctx: Context<CloseFillReceipt>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx
                .accounts
                .fill_receipt
                .expires_at
                .saturating_add(CLOSE_GRACE_SECONDS),
            ErrorCode::CloseTooEarly
        );
        require_keys_eq!(
            ctx.accounts.fill_receipt.payer,
            ctx.accounts.payer.key(),
            ErrorCode::RentPayerMismatch
        );
        Ok(())
    }

    /// Initialize the on-chain quorum used by registry governance. The
    /// production deployment maps these keys to a Squads 2-of-3 vault.
    pub fn initialize_governance(
        ctx: Context<InitializeGovernance>,
        squad_signers: [Pubkey; 3],
        guardian: Pubkey,
    ) -> Result<()> {
        validate_governance_initialization(ctx.accounts.payer.key(), &squad_signers, guardian)?;
        let governance = &mut ctx.accounts.governance;
        governance.squad_signers = squad_signers;
        governance.guardian = guardian;
        governance.bootstrap_authority = BOOTSTRAP_AUTHORITY;
        governance.change_delay_seconds = GOVERNANCE_DELAY_SECONDS;
        governance.pending_change_hash = None;
        governance.pending_change_at = 0;
        Ok(())
    }

    /// Create the asset registry only after the configured governance quorum
    /// has verified the live mint, its Token-2022 hook, and every hook meta.
    /// The PDA is initialized here, so no permissionless caller can pre-seize
    /// the registry account or choose its first configuration.
    pub fn initialize_asset_registry(
        ctx: Context<InitializeAssetRegistry>,
        issuer: u8,
        stable_outputs: [Pubkey; 2],
        extension_fingerprint: [u8; 32],
        hook_program: Option<Pubkey>,
        hook_accounts: Vec<HookAccountMeta>,
    ) -> Result<()> {
        require_squad_quorum(
            &ctx.accounts.governance,
            &ctx.accounts.squad_signer_one,
            &ctx.accounts.squad_signer_two,
        )?;
        require!(
            stable_outputs[0] != Pubkey::default()
                && stable_outputs[1] != Pubkey::default()
                && stable_outputs[0] != stable_outputs[1],
            ErrorCode::UnsupportedOutput
        );
        require_keys_eq!(
            *ctx.accounts.stock_mint.to_account_info().owner,
            ctx.accounts.stock_token_program.key(),
            ErrorCode::TokenProgramMismatch
        );
        validate_live_mint_configuration(
            &ctx.accounts.stock_mint.to_account_info(),
            hook_program,
            extension_fingerprint,
        )?;
        validate_hook_account_configuration(
            &ctx.accounts.stock_mint.key(),
            hook_program,
            &hook_accounts,
        )?;
        let hook_validation_data_hash = read_hook_validation_account_at_bootstrap(
            ctx.remaining_accounts,
            &ctx.accounts.stock_mint.key(),
            hook_program,
            hook_accounts.len().saturating_sub(1),
        )?;
        let observations = observe_hook_accounts(ctx.remaining_accounts);
        validate_hook_account_observations(&hook_accounts, &observations, &[])?;

        let registry = &mut ctx.accounts.asset_registry;
        registry.mint = ctx.accounts.stock_mint.key();
        registry.token_program = ctx.accounts.stock_token_program.key();
        registry.stable_token_program = ctx.accounts.stable_token_program.key();
        registry.stable_outputs = stable_outputs;
        registry.issuer = issuer;
        registry.decimals = ctx.accounts.stock_mint.decimals;
        registry.extension_fingerprint = extension_fingerprint;
        registry.hook_program = hook_program;
        registry.hook_validation_data_hash = hook_validation_data_hash;
        registry.hook_accounts = hook_accounts;
        registry.enabled = true;
        registry.paused = false;
        registry.registry_version = 1;
        Ok(())
    }

    /// Create the maker registry through the same quorum as asset bootstrap.
    /// The account is initialized once and cannot be replaced by a caller who
    /// merely knows the PDA seeds.
    pub fn initialize_maker_registry(
        ctx: Context<InitializeMakerRegistry>,
        allowlisted: Vec<Pubkey>,
    ) -> Result<()> {
        require_squad_quorum(
            &ctx.accounts.governance,
            &ctx.accounts.squad_signer_one,
            &ctx.accounts.squad_signer_two,
        )?;
        validate_maker_allowlist(&allowlisted)?;
        ctx.accounts.maker_registry.allowlisted = allowlisted;
        Ok(())
    }

    /// Queue a registry/fee/unpause change. A second quorum signer is
    /// required and the hash commits to every field that will be applied.
    pub fn queue_registry_change(
        ctx: Context<QueueRegistryChange>,
        change_hash: [u8; 32],
    ) -> Result<()> {
        require!(change_hash != [0u8; 32], ErrorCode::InvalidChangeHash);
        require_squad_quorum(
            &ctx.accounts.governance,
            &ctx.accounts.squad_signer_one,
            &ctx.accounts.squad_signer_two,
        )?;
        let now = Clock::get()?.unix_timestamp;
        let governance = &mut ctx.accounts.governance;
        governance.pending_change_hash = Some(change_hash);
        governance.pending_change_at = now.saturating_add(governance.change_delay_seconds);
        Ok(())
    }

    /// Apply a previously queued registry change after the mandatory delay.
    /// The quorum is checked again so a queued change cannot be applied by a
    /// different signer set.
    pub fn apply_registry_change(
        ctx: Context<ApplyRegistryChange>,
        change_hash: [u8; 32],
        enabled: bool,
        paused: bool,
        registry_version: u64,
    ) -> Result<()> {
        require_squad_quorum(
            &ctx.accounts.governance,
            &ctx.accounts.squad_signer_one,
            &ctx.accounts.squad_signer_two,
        )?;
        let now = Clock::get()?.unix_timestamp;
        let governance = &mut ctx.accounts.governance;
        require!(
            governance.pending_change_hash == Some(change_hash),
            ErrorCode::ChangeNotQueued
        );
        require!(
            registry_change_digest(
                &ctx.accounts.asset_registry.key(),
                enabled,
                paused,
                registry_version,
            ) == change_hash,
            ErrorCode::InvalidChangeHash
        );
        require!(
            now >= governance.pending_change_at,
            ErrorCode::GovernanceDelayActive
        );
        require!(
            registry_version > ctx.accounts.asset_registry.registry_version,
            ErrorCode::RegistryVersionNotIncreasing
        );
        ctx.accounts.asset_registry.enabled = enabled;
        ctx.accounts.asset_registry.paused = paused;
        ctx.accounts.asset_registry.registry_version = registry_version;
        governance.pending_change_hash = None;
        governance.pending_change_at = 0;
        Ok(())
    }

    /// The guardian can only pause an asset. It has no authority to unpause,
    /// edit fees, or move funds.
    pub fn guardian_pause_asset(ctx: Context<GuardianPauseAsset>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.guardian.key(),
            ctx.accounts.governance.guardian,
            ErrorCode::GuardianRequired
        );
        ctx.accounts.asset_registry.paused = true;
        Ok(())
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
    pub seller_stock_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub maker_stock_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub maker_stable_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub seller_stable_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub fee_recipient_stable_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: The fee recipient is bound to the destination token account;
    /// governance chooses this account when constructing the signed quote.
    pub fee_recipient: UncheckedAccount<'info>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    pub stable_mint: InterfaceAccount<'info, Mint>,
    pub stock_token_program: Interface<'info, TokenInterface>,
    pub stable_token_program: Interface<'info, TokenInterface>,
    #[account(seeds = [b"asset", asset_registry.mint.as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
    #[account(seeds = [b"makers"], bump)]
    pub maker_registry: Account<'info, MakerRegistry>,
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
    #[account(init, payer = payer, space = 8 + GovernanceConfig::INIT_SPACE, seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut, address = BOOTSTRAP_AUTHORITY)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeAssetRegistry<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut)]
    pub squad_signer_one: Signer<'info>,
    pub squad_signer_two: Signer<'info>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    pub stock_token_program: Interface<'info, TokenInterface>,
    pub stable_token_program: Interface<'info, TokenInterface>,
    #[account(init, payer = squad_signer_one, space = 8 + AssetRegistry::INIT_SPACE, seeds = [b"asset", stock_mint.key().as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeMakerRegistry<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    #[account(mut)]
    pub squad_signer_one: Signer<'info>,
    pub squad_signer_two: Signer<'info>,
    #[account(init, payer = squad_signer_one, space = 8 + MakerRegistry::INIT_SPACE, seeds = [b"makers"], bump)]
    pub maker_registry: Account<'info, MakerRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct QueueRegistryChange<'info> {
    #[account(mut, seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    pub squad_signer_one: Signer<'info>,
    pub squad_signer_two: Signer<'info>,
    #[account(seeds = [b"asset", asset_registry.mint.as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
}

#[derive(Accounts)]
pub struct ApplyRegistryChange<'info> {
    #[account(mut, seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    pub squad_signer_one: Signer<'info>,
    pub squad_signer_two: Signer<'info>,
    #[account(mut, seeds = [b"asset", asset_registry.mint.as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
}

#[derive(Accounts)]
pub struct GuardianPauseAsset<'info> {
    #[account(seeds = [b"governance"], bump)]
    pub governance: Account<'info, GovernanceConfig>,
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"asset", asset_registry.mint.as_ref()], bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
}

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

#[account]
#[derive(InitSpace)]
pub struct AssetRegistry {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub stable_token_program: Pubkey,
    pub stable_outputs: [Pubkey; 2],
    pub issuer: u8,
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
}

#[account]
#[derive(InitSpace)]
pub struct GovernanceConfig {
    pub squad_signers: [Pubkey; 3],
    pub guardian: Pubkey,
    pub bootstrap_authority: Pubkey,
    pub change_delay_seconds: i64,
    pub pending_change_hash: Option<[u8; 32]>,
    pub pending_change_at: i64,
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

#[derive(Clone, Copy)]
struct HookAccountObservation {
    key: Pubkey,
    owner: Pubkey,
    is_signer: bool,
    is_writable: bool,
    executable: bool,
}

fn transfer_hook_validation_address(mint: &Pubkey, hook_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], hook_program).0
}

fn validate_hook_account_configuration(
    mint: &Pubkey,
    hook_program: Option<Pubkey>,
    expected: &[HookAccountMeta],
) -> Result<()> {
    require!(
        expected.len() <= MAX_HOOK_ACCOUNTS,
        ErrorCode::TooManyHookAccounts
    );
    match hook_program {
        None => require!(expected.is_empty(), ErrorCode::UnexpectedHookAccounts),
        Some(program) => {
            require!(program != Pubkey::default(), ErrorCode::InvalidHookAccount);
            require!(!expected.is_empty(), ErrorCode::HookAccountsMissing);
            require!(
                expected[0].key == transfer_hook_validation_address(mint, &program),
                ErrorCode::HookAccountMismatch
            );
            require!(expected[0].owner == program, ErrorCode::InvalidHookAccount);
            require!(
                !expected[0].is_signer && !expected[0].is_writable && !expected[0].executable,
                ErrorCode::InvalidHookAccount
            );
            for (index, account) in expected.iter().enumerate() {
                require!(
                    account.key != Pubkey::default() && account.owner != Pubkey::default(),
                    ErrorCode::InvalidHookAccount
                );
                for previous in expected.iter().take(index) {
                    require!(account.key != previous.key, ErrorCode::DuplicateHookAccount);
                }
            }
        }
    }
    Ok(())
}

fn validate_hook_account_observations(
    expected: &[HookAccountMeta],
    actual: &[HookAccountObservation],
    reserved: &[Pubkey],
) -> Result<()> {
    require!(
        actual.len() == expected.len(),
        ErrorCode::HookAccountMismatch
    );
    for (index, observation) in actual.iter().enumerate() {
        require!(
            observation.key != Pubkey::default()
                && !reserved.iter().any(|reserved| reserved == &observation.key),
            ErrorCode::InvalidHookAccount
        );
        for previous in actual.iter().take(index) {
            require!(
                observation.key != previous.key,
                ErrorCode::DuplicateHookAccount
            );
        }
        let expected_meta = &expected[index];
        require!(
            expected_meta.key == observation.key
                && expected_meta.owner == observation.owner
                && expected_meta.is_signer == observation.is_signer
                && expected_meta.is_writable == observation.is_writable
                && expected_meta.executable == observation.executable,
            ErrorCode::HookAccountMismatch
        );
    }
    Ok(())
}

fn observe_hook_accounts(accounts: &[AccountInfo<'_>]) -> Vec<HookAccountObservation> {
    accounts
        .iter()
        .map(|account| HookAccountObservation {
            key: account.key(),
            owner: *account.owner,
            is_signer: account.is_signer,
            is_writable: account.is_writable,
            executable: account.executable,
        })
        .collect()
}

fn validate_hook_accounts(
    accounts: &[AccountInfo<'_>],
    registry: &AssetRegistry,
    reserved: &[Pubkey],
) -> Result<()> {
    validate_hook_account_configuration(
        &registry.mint,
        registry.hook_program,
        &registry.hook_accounts,
    )?;
    require!(
        accounts.len() <= MAX_HOOK_ACCOUNTS,
        ErrorCode::TooManyHookAccounts
    );
    validate_hook_validation_account(
        accounts,
        &registry.mint,
        registry.hook_program,
        registry.hook_validation_data_hash,
        registry.hook_accounts.len().saturating_sub(1),
    )?;
    let observations = observe_hook_accounts(accounts);
    validate_hook_account_observations(&registry.hook_accounts, &observations, reserved)
}

fn parse_transfer_hook_extra_account_metas(
    validation_data: &[u8],
) -> Result<Vec<TransferHookExtraAccountMeta>> {
    let state = TlvStateBorrowed::unpack(validation_data)
        .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
    let discriminators = state
        .get_discriminators()
        .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
    require!(
        discriminators.len() == 1
            && discriminators[0] == TransferHookExecuteInstruction::SPL_DISCRIMINATOR,
        ErrorCode::InvalidHookValidationData
    );
    let encoded_metas = state
        .get_first_bytes::<TransferHookExecuteInstruction>()
        .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
    let metas = ListView::<TransferHookExtraAccountMeta>::unpack(encoded_metas)
        .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
    Ok(metas.iter().copied().collect())
}

fn read_hook_validation_account_at_bootstrap(
    accounts: &[AccountInfo<'_>],
    mint: &Pubkey,
    hook_program: Option<Pubkey>,
    expected_extra_account_count: usize,
) -> Result<[u8; 32]> {
    match hook_program {
        None => {
            require!(
                accounts.is_empty() && expected_extra_account_count == 0,
                ErrorCode::UnexpectedHookAccounts
            );
            Ok([0; 32])
        }
        Some(program) => {
            require!(
                accounts.len() == expected_extra_account_count.saturating_add(1),
                ErrorCode::HookAccountMismatch
            );
            let account = &accounts[0];
            require_keys_eq!(
                account.key(),
                transfer_hook_validation_address(mint, &program),
                ErrorCode::HookAccountMismatch
            );
            require_keys_eq!(*account.owner, program, ErrorCode::InvalidHookAccount);
            require!(
                !account.is_signer && !account.is_writable && !account.executable,
                ErrorCode::InvalidHookAccount
            );
            let data = account
                .try_borrow_data()
                .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
            let metas = parse_transfer_hook_extra_account_metas(&data)?;
            require!(
                metas.len() == expected_extra_account_count,
                ErrorCode::HookAccountMismatch
            );
            Ok(solana_sha256_hasher::hashv(&[data.as_ref()]).to_bytes())
        }
    }
}

fn validate_hook_validation_account(
    accounts: &[AccountInfo<'_>],
    mint: &Pubkey,
    hook_program: Option<Pubkey>,
    expected_data_hash: [u8; 32],
    expected_extra_account_count: usize,
) -> Result<()> {
    let actual_data_hash = match hook_program {
        None => {
            require!(
                accounts.is_empty() && expected_extra_account_count == 0,
                ErrorCode::UnexpectedHookAccounts
            );
            [0; 32]
        }
        Some(program) => {
            require!(!accounts.is_empty(), ErrorCode::HookAccountsMissing);
            let account = &accounts[0];
            require_keys_eq!(
                account.key(),
                transfer_hook_validation_address(mint, &program),
                ErrorCode::HookAccountMismatch
            );
            require_keys_eq!(*account.owner, program, ErrorCode::InvalidHookAccount);
            require!(
                !account.is_signer && !account.is_writable && !account.executable,
                ErrorCode::InvalidHookAccount
            );
            let data = account
                .try_borrow_data()
                .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
            let metas = parse_transfer_hook_extra_account_metas(&data)?;
            require!(
                metas.len() == expected_extra_account_count,
                ErrorCode::HookAccountMismatch
            );
            solana_sha256_hasher::hashv(&[data.as_ref()]).to_bytes()
        }
    };
    require!(
        actual_data_hash == expected_data_hash,
        ErrorCode::LiveHookMismatch
    );
    Ok(())
}

#[derive(Clone, Copy)]
struct ResolvedHookAccountMeta {
    key: Pubkey,
    is_signer: bool,
    is_writable: bool,
}

fn validate_transfer_hook_execution(
    accounts: &[AccountInfo<'_>],
    hook_program: Pubkey,
    amount: u64,
) -> Result<()> {
    require!(accounts.len() >= 5, ErrorCode::HookAccountsMissing);
    let validation_data = accounts[4]
        .try_borrow_data()
        .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
    let configured_metas = parse_transfer_hook_extra_account_metas(&validation_data)?;
    require!(
        accounts.len() == 5usize.saturating_add(configured_metas.len()),
        ErrorCode::HookAccountMismatch
    );

    let mut instruction_data = [0u8; 16];
    instruction_data[..8].copy_from_slice(TransferHookExecuteInstruction::SPL_DISCRIMINATOR_SLICE);
    instruction_data[8..].copy_from_slice(&amount.to_le_bytes());
    for (index, configured_meta) in configured_metas.iter().enumerate() {
        let resolved = resolve_transfer_hook_meta(
            configured_meta,
            &instruction_data,
            &hook_program,
            accounts,
        )?;
        let actual = &accounts[5 + index];
        require!(
            resolved.key == actual.key()
                && resolved.is_signer == actual.is_signer
                && resolved.is_writable == actual.is_writable,
            ErrorCode::HookAccountMismatch
        );
    }
    Ok(())
}

fn resolve_transfer_hook_meta(
    configured_meta: &TransferHookExtraAccountMeta,
    instruction_data: &[u8],
    hook_program: &Pubkey,
    accounts: &[AccountInfo<'_>],
) -> Result<ResolvedHookAccountMeta> {
    let key = match configured_meta.discriminator {
        0 => Pubkey::new_from_array(configured_meta.address_config),
        1 => derive_hook_pda(
            &configured_meta.address_config,
            instruction_data,
            hook_program,
            accounts,
        )?,
        2 => resolve_hook_pubkey_data(&configured_meta.address_config, instruction_data, accounts)?,
        discriminator if discriminator >= 128 => {
            let program_index = usize::from(discriminator - 128);
            let external_program = accounts
                .get(program_index)
                .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
            derive_hook_pda(
                &configured_meta.address_config,
                instruction_data,
                external_program.key,
                accounts,
            )?
        }
        _ => return Err(error!(ErrorCode::InvalidHookValidationData)),
    };
    Ok(ResolvedHookAccountMeta {
        key,
        is_signer: configured_meta.is_signer.into(),
        is_writable: configured_meta.is_writable.into(),
    })
}

fn derive_hook_pda(
    address_config: &[u8; 32],
    instruction_data: &[u8],
    program_id: &Pubkey,
    accounts: &[AccountInfo<'_>],
) -> Result<Pubkey> {
    let seeds = unpack_hook_seeds(address_config, instruction_data, accounts)?;
    let seed_refs: Vec<&[u8]> = seeds.iter().map(Vec::as_slice).collect();
    Pubkey::try_find_program_address(&seed_refs, program_id)
        .map(|(address, _)| address)
        .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))
}

fn unpack_hook_seeds(
    address_config: &[u8; 32],
    instruction_data: &[u8],
    accounts: &[AccountInfo<'_>],
) -> Result<Vec<Vec<u8>>> {
    let mut seeds = Vec::new();
    let mut offset = 0usize;
    while offset < address_config.len() {
        match address_config[offset] {
            0 => {
                require!(
                    address_config[offset + 1..].iter().all(|byte| *byte == 0),
                    ErrorCode::InvalidHookValidationData
                );
                break;
            }
            1 => {
                require!(
                    offset.saturating_add(2) <= address_config.len(),
                    ErrorCode::InvalidHookValidationData
                );
                let literal_len = usize::from(address_config[offset + 1]);
                let end = offset
                    .checked_add(2)
                    .and_then(|start| start.checked_add(literal_len))
                    .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
                require!(
                    end <= address_config.len(),
                    ErrorCode::InvalidHookValidationData
                );
                seeds.push(address_config[offset + 2..end].to_vec());
                offset = end;
            }
            2 => {
                let end = offset
                    .checked_add(3)
                    .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
                require!(
                    end <= address_config.len(),
                    ErrorCode::InvalidHookValidationData
                );
                let start = usize::from(address_config[offset + 1]);
                let length = usize::from(address_config[offset + 2]);
                let data_end = start
                    .checked_add(length)
                    .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
                require!(
                    data_end <= instruction_data.len(),
                    ErrorCode::InvalidHookValidationData
                );
                seeds.push(instruction_data[start..data_end].to_vec());
                offset = end;
            }
            3 => {
                let end = offset
                    .checked_add(2)
                    .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
                require!(
                    end <= address_config.len(),
                    ErrorCode::InvalidHookValidationData
                );
                let account_index = usize::from(address_config[offset + 1]);
                let account = accounts
                    .get(account_index)
                    .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
                seeds.push(account.key.to_bytes().to_vec());
                offset = end;
            }
            4 => {
                let end = offset
                    .checked_add(4)
                    .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
                require!(
                    end <= address_config.len(),
                    ErrorCode::InvalidHookValidationData
                );
                let account_index = usize::from(address_config[offset + 1]);
                let data_start = usize::from(address_config[offset + 2]);
                let data_length = usize::from(address_config[offset + 3]);
                let account = accounts
                    .get(account_index)
                    .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
                let data = account
                    .try_borrow_data()
                    .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
                let data_end = data_start
                    .checked_add(data_length)
                    .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
                require!(data_end <= data.len(), ErrorCode::InvalidHookValidationData);
                seeds.push(data[data_start..data_end].to_vec());
                offset = end;
            }
            _ => return Err(error!(ErrorCode::InvalidHookValidationData)),
        }
    }
    Ok(seeds)
}

fn resolve_hook_pubkey_data(
    address_config: &[u8; 32],
    instruction_data: &[u8],
    accounts: &[AccountInfo<'_>],
) -> Result<Pubkey> {
    let key_bytes: [u8; 32] = match address_config[0] {
        1 => {
            let start = usize::from(address_config[1]);
            let end = start
                .checked_add(32)
                .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
            instruction_data
                .get(start..end)
                .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?
                .try_into()
                .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?
        }
        2 => {
            let account_index = usize::from(address_config[1]);
            let data_start = usize::from(address_config[2]);
            let account = accounts
                .get(account_index)
                .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
            let data = account
                .try_borrow_data()
                .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
            let end = data_start
                .checked_add(32)
                .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?;
            data.get(data_start..end)
                .ok_or_else(|| error!(ErrorCode::InvalidHookValidationData))?
                .try_into()
                .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?
        }
        _ => return Err(error!(ErrorCode::InvalidHookValidationData)),
    };
    Ok(Pubkey::new_from_array(key_bytes))
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct LiveMintConfiguration {
    hook_program: Option<Pubkey>,
    extension_fingerprint: [u8; 32],
}

fn live_mint_configuration(mint: &AccountInfo<'_>) -> Result<LiveMintConfiguration> {
    if mint.owner != &token_interface::spl_token_2022::ID {
        return Ok(LiveMintConfiguration {
            hook_program: None,
            extension_fingerprint: solana_sha256_hasher::hashv(&[&[]]).to_bytes(),
        });
    }
    let mint_data = mint
        .try_borrow_data()
        .map_err(|_| error!(ErrorCode::InvalidMintTlv))?;
    let mint_with_extensions =
        StateWithExtensions::<token_interface::spl_token_2022::state::Mint>::unpack(&mint_data)
            .map_err(|_| error!(ErrorCode::InvalidMintTlv))?;
    let extension_types = mint_with_extensions
        .get_extension_types()
        .map_err(|_| error!(ErrorCode::InvalidMintTlv))?;
    let hook_program = if extension_types.contains(&ExtensionType::TransferHook) {
        let transfer_hook = mint_with_extensions
            .get_extension::<TransferHook>()
            .map_err(|_| error!(ErrorCode::InvalidMintTlv))?;
        Option::<Pubkey>::from(transfer_hook.program_id)
    } else {
        None
    };
    Ok(LiveMintConfiguration {
        hook_program,
        extension_fingerprint: solana_sha256_hasher::hashv(&[mint_with_extensions.get_tlv_data()])
            .to_bytes(),
    })
}

fn validate_live_mint_configuration(
    mint: &AccountInfo<'_>,
    expected_hook_program: Option<Pubkey>,
    expected_extension_fingerprint: [u8; 32],
) -> Result<()> {
    let live = live_mint_configuration(mint)?;
    require!(
        live.hook_program == expected_hook_program
            && live.extension_fingerprint == expected_extension_fingerprint,
        ErrorCode::LiveHookMismatch
    );
    Ok(())
}

fn validate_maker_allowlist(allowlisted: &[Pubkey]) -> Result<()> {
    require!(allowlisted.len() <= 64, ErrorCode::TooManyMakers);
    for (index, maker) in allowlisted.iter().enumerate() {
        require!(*maker != Pubkey::default(), ErrorCode::InvalidMaker);
        for previous in allowlisted.iter().take(index) {
            require!(maker != previous, ErrorCode::DuplicateMaker);
        }
    }
    Ok(())
}

fn validate_governance_initialization(
    payer: Pubkey,
    squad_signers: &[Pubkey; 3],
    guardian: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        payer,
        BOOTSTRAP_AUTHORITY,
        ErrorCode::BootstrapAuthorityRequired
    );
    require!(
        squad_signers
            .iter()
            .all(|signer| *signer != Pubkey::default()),
        ErrorCode::GovernanceSignerRequired
    );
    require!(
        squad_signers[0] != squad_signers[1]
            && squad_signers[0] != squad_signers[2]
            && squad_signers[1] != squad_signers[2],
        ErrorCode::DistinctSignersRequired
    );
    require!(guardian != Pubkey::default(), ErrorCode::GuardianRequired);
    Ok(())
}

fn validate_distinct_mutable_keys(keys: &[Pubkey]) -> Result<()> {
    for (index, key) in keys.iter().enumerate() {
        for previous in keys.iter().take(index) {
            require!(key != previous, ErrorCode::DuplicateMutableAccount);
        }
    }
    Ok(())
}

fn require_squad_quorum(
    governance: &GovernanceConfig,
    first: &Signer<'_>,
    second: &Signer<'_>,
) -> Result<()> {
    require!(
        first.key() != second.key(),
        ErrorCode::DistinctSignersRequired
    );
    require!(
        governance.squad_signers.contains(&first.key())
            && governance.squad_signers.contains(&second.key()),
        ErrorCode::GovernanceSignerRequired
    );
    Ok(())
}

/// Commit/reveal digest for registry state changes. The queued hash is bound
/// to the exact asset PDA and every state field that `apply_registry_change`
/// can mutate, so a delayed quorum cannot be repurposed for another asset or
/// a different enable/pause/version tuple.
fn registry_change_digest(
    asset: &Pubkey,
    enabled: bool,
    paused: bool,
    registry_version: u64,
) -> [u8; 32] {
    let enabled_byte = [enabled as u8];
    let paused_byte = [paused as u8];
    let version_bytes = registry_version.to_le_bytes();
    solana_sha256_hasher::hashv(&[asset.as_ref(), &enabled_byte, &paused_byte, &version_bytes])
        .to_bytes()
}

#[error_code]
pub enum ErrorCode {
    #[msg("amount must be non-zero")]
    InvalidAmount,
    #[msg("quote expiry is outside the 30 second program limit")]
    InvalidExpiry,
    #[msg("fee exceeds the 25 bps protocol cap")]
    FeeCapExceeded,
    #[msg("asset is disabled or paused")]
    AssetNotEnabled,
    #[msg("stock mint does not match registry")]
    MintMismatch,
    #[msg("stock mint decimals do not match registry")]
    DecimalsMismatch,
    #[msg("stable output is not registry-approved")]
    UnsupportedOutput,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_validation_data(metas: &[TransferHookExtraAccountMeta]) -> Vec<u8> {
        let list_size = ListView::<TransferHookExtraAccountMeta>::size_of(metas.len()).unwrap();
        let mut data = vec![0; TlvStateBorrowed::get_base_len() + list_size];
        let mut state = TlvStateMut::unpack(&mut data).unwrap();
        let (encoded, _) = state
            .alloc::<TransferHookExecuteInstruction>(list_size, false)
            .unwrap();
        let mut list = ListView::<TransferHookExtraAccountMeta>::init(encoded).unwrap();
        for meta in metas {
            list.push(*meta).unwrap();
        }
        data
    }

    #[test]
    fn hook_account_validation_requires_exact_order_and_account_metas() {
        let mint = Pubkey::new_from_array([7; 32]);
        let hook_program = Pubkey::new_from_array([8; 32]);
        let validation_account = transfer_hook_validation_address(&mint, &hook_program);
        let extra_account = Pubkey::new_from_array([9; 32]);
        let expected = vec![
            HookAccountMeta {
                key: validation_account,
                owner: hook_program,
                is_signer: false,
                is_writable: false,
                executable: false,
            },
            HookAccountMeta {
                key: extra_account,
                owner: Pubkey::new_from_array([10; 32]),
                is_signer: false,
                is_writable: true,
                executable: false,
            },
        ];
        let actual = vec![
            HookAccountObservation {
                key: validation_account,
                owner: hook_program,
                is_signer: false,
                is_writable: false,
                executable: false,
            },
            HookAccountObservation {
                key: extra_account,
                owner: Pubkey::new_from_array([10; 32]),
                is_signer: false,
                is_writable: true,
                executable: false,
            },
        ];

        assert!(validate_hook_account_configuration(&mint, Some(hook_program), &expected).is_ok());
        assert!(validate_hook_account_observations(&expected, &actual, &[]).is_ok());

        let mut wrong_order = actual.clone();
        wrong_order.swap(0, 1);
        assert!(validate_hook_account_observations(&expected, &wrong_order, &[]).is_err());

        let mut wrong_flags = actual.clone();
        wrong_flags[1].is_writable = false;
        assert!(validate_hook_account_observations(&expected, &wrong_flags, &[]).is_err());

        let mut reserved = actual.clone();
        reserved[1].key = mint;
        assert!(validate_hook_account_observations(&expected, &reserved, &[mint]).is_err());
    }

    #[test]
    fn hookless_registry_rejects_any_remaining_account_specification() {
        let mint = Pubkey::new_from_array([7; 32]);
        let extra = HookAccountMeta {
            key: Pubkey::new_from_array([9; 32]),
            owner: Pubkey::new_from_array([10; 32]),
            is_signer: false,
            is_writable: false,
            executable: false,
        };

        assert!(validate_hook_account_configuration(&mint, None, &[]).is_ok());
        assert!(validate_hook_account_configuration(&mint, None, &[extra]).is_err());
    }

    #[test]
    fn transfer_hook_validation_resolves_execute_context_and_exact_extra_metas() {
        let mint = Pubkey::new_from_array([7; 32]);
        let hook_program = Pubkey::new_from_array([8; 32]);
        let amount = 42u64;
        let extra_key = Pubkey::find_program_address(&[&amount.to_le_bytes()], &hook_program).0;
        let mut address_config = [0u8; 32];
        address_config[..3].copy_from_slice(&[2, 8, 8]);
        let extra_meta = TransferHookExtraAccountMeta {
            discriminator: 1,
            address_config,
            is_signer: false.into(),
            is_writable: false.into(),
        };
        let validation_data = test_validation_data(&[extra_meta]);
        let validation_key = transfer_hook_validation_address(&mint, &hook_program);
        let owner = Pubkey::new_from_array([9; 32]);
        let mut source_lamports = 0;
        let mut source_data = vec![];
        let source_key = Pubkey::new_from_array([10; 32]);
        let source = AccountInfo::new(
            &source_key,
            false,
            true,
            &mut source_lamports,
            &mut source_data,
            &owner,
            false,
        );
        let mut mint_lamports = 0;
        let mut mint_data = vec![];
        let mint_account = AccountInfo::new(
            &mint,
            false,
            false,
            &mut mint_lamports,
            &mut mint_data,
            &owner,
            false,
        );
        let mut destination_lamports = 0;
        let mut destination_data = vec![];
        let destination_key = Pubkey::new_from_array([11; 32]);
        let destination = AccountInfo::new(
            &destination_key,
            false,
            true,
            &mut destination_lamports,
            &mut destination_data,
            &owner,
            false,
        );
        let mut authority_lamports = 0;
        let mut authority_data = vec![];
        let authority_key = Pubkey::new_from_array([12; 32]);
        let authority = AccountInfo::new(
            &authority_key,
            true,
            false,
            &mut authority_lamports,
            &mut authority_data,
            &owner,
            false,
        );
        let mut validation_lamports = 0;
        let validation_owner = hook_program;
        let mut validation_bytes = validation_data;
        let validation = AccountInfo::new(
            &validation_key,
            false,
            false,
            &mut validation_lamports,
            &mut validation_bytes,
            &validation_owner,
            false,
        );
        let mut extra_lamports = 0;
        let mut extra_data = vec![];
        let extra = AccountInfo::new(
            &extra_key,
            false,
            false,
            &mut extra_lamports,
            &mut extra_data,
            &owner,
            false,
        );
        let accounts = vec![
            source,
            mint_account,
            destination,
            authority,
            validation,
            extra,
        ];

        assert!(validate_transfer_hook_execution(&accounts, hook_program, amount).is_ok());
        assert!(validate_transfer_hook_execution(&accounts, hook_program, amount + 1).is_err());

        let mut wrong_order = accounts.clone();
        wrong_order.swap(4, 5);
        assert!(validate_transfer_hook_execution(&wrong_order, hook_program, amount).is_err());

        let validation_hash =
            read_hook_validation_account_at_bootstrap(&accounts[4..], &mint, Some(hook_program), 1)
                .unwrap();
        assert!(validate_hook_validation_account(
            &accounts[4..],
            &mint,
            Some(hook_program),
            validation_hash,
            1,
        )
        .is_ok());
        accounts[4].try_borrow_mut_data().unwrap()[17] ^= 1;
        assert!(validate_hook_validation_account(
            &accounts[4..],
            &mint,
            Some(hook_program),
            validation_hash,
            1,
        )
        .is_err());
    }

    #[test]
    fn malformed_hook_pda_seed_fails_closed_without_panicking() {
        let hook_program = Pubkey::new_from_array([8; 32]);
        let mut address_config = [0u8; 32];
        address_config[..4].copy_from_slice(&[4, 0, 0, 33]);
        let account_key = Pubkey::new_from_array([9; 32]);
        let owner = Pubkey::new_from_array([10; 32]);
        let mut lamports = 0;
        let mut account_data = vec![0u8; 33];
        let account = AccountInfo::new(
            &account_key,
            false,
            false,
            &mut lamports,
            &mut account_data,
            &owner,
            false,
        );

        assert!(derive_hook_pda(&address_config, &[], &hook_program, &[account]).is_err());
    }

    #[test]
    fn governance_bootstrap_requires_the_audited_authority_and_unique_quorum() {
        let signers = [
            Pubkey::new_from_array([1; 32]),
            Pubkey::new_from_array([2; 32]),
            Pubkey::new_from_array([3; 32]),
        ];
        let guardian = Pubkey::new_from_array([4; 32]);

        assert!(
            validate_governance_initialization(BOOTSTRAP_AUTHORITY, &signers, guardian).is_ok()
        );
        assert!(validate_governance_initialization(
            Pubkey::new_from_array([5; 32]),
            &signers,
            guardian
        )
        .is_err());
        assert!(validate_governance_initialization(
            BOOTSTRAP_AUTHORITY,
            &[signers[0], signers[0], signers[2]],
            guardian,
        )
        .is_err());
        assert!(validate_governance_initialization(
            BOOTSTRAP_AUTHORITY,
            &[signers[0], Pubkey::default(), signers[2]],
            guardian,
        )
        .is_err());
        assert!(validate_governance_initialization(
            BOOTSTRAP_AUTHORITY,
            &signers,
            Pubkey::default()
        )
        .is_err());
    }

    #[test]
    fn live_mint_configuration_binds_the_complete_token_2022_tlv_buffer() {
        let mint_key = Pubkey::new_from_array([7; 32]);
        let hook_program = Pubkey::new_from_array([8; 32]);
        let mint_len = ExtensionType::try_calculate_account_len::<
            token_interface::spl_token_2022::state::Mint,
        >(&[ExtensionType::TransferHook])
        .unwrap();
        let mut mint_data = vec![0; mint_len];
        {
            let mut state = StateWithExtensionsMut::<
                token_interface::spl_token_2022::state::Mint,
            >::unpack_uninitialized(&mut mint_data)
            .unwrap();
            state.base.decimals = 6;
            state.base.is_initialized = true;
            state.init_account_type().unwrap();
            let transfer_hook = state.init_extension::<TransferHook>(true).unwrap();
            transfer_hook.program_id = Some(hook_program).try_into().unwrap();
            state.pack_base();
        }

        let owner = token_interface::spl_token_2022::ID;
        let mut lamports = 0;
        let account = AccountInfo::new(
            &mint_key,
            false,
            false,
            &mut lamports,
            &mut mint_data,
            &owner,
            false,
        );
        let live = live_mint_configuration(&account).unwrap();
        assert_eq!(live.hook_program, Some(hook_program));
        assert!(live.extension_fingerprint != [0; 32]);
        assert!(validate_live_mint_configuration(
            &account,
            Some(hook_program),
            live.extension_fingerprint,
        )
        .is_ok());

        drop(account);
        let mut changed_data = mint_data.clone();
        changed_data[166 + 4] ^= 1;
        let mut changed_lamports = 0;
        let changed_account = AccountInfo::new(
            &mint_key,
            false,
            false,
            &mut changed_lamports,
            &mut changed_data,
            &owner,
            false,
        );
        assert!(validate_live_mint_configuration(
            &changed_account,
            Some(hook_program),
            live.extension_fingerprint,
        )
        .is_err());
    }
}
