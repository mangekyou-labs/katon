use anchor_lang::prelude::*;

use crate::{
    observe_hook_accounts, read_hook_validation_account_at_bootstrap, registry_change_digest,
    require_squads_vault, validate_governance_initialization, validate_hook_account_configuration,
    validate_hook_account_observations, validate_issuer_configuration,
    validate_live_mint_configuration, validate_maker_allowlist, validate_registry_scope,
    AppliedMakerGovernanceAction, ApplyGovernanceAction, ApplyRegistryChange, AssetRegistry,
    CancelGovernanceAction, CancelRegistryChange, ErrorCode, GovernanceAction, GovernanceConfig,
    GuardianPauseAsset, GuardianPauseMakers, GuardianPauseProgram, HookAccountMeta,
    InitializeAssetRegistry, InitializeGovernance, InitializeMakerRegistry, MakerRegistry,
    QueueGovernanceAction, QueueRegistryChange, QueuedGovernanceAction, GOVERNANCE_DELAY_SECONDS,
};

pub(crate) fn initialize_governance(
    ctx: Context<InitializeGovernance>,
    guardian: Pubkey,
) -> Result<()> {
    validate_governance_initialization(ctx.accounts.squads_vault.key(), guardian)?;
    let governance = &mut ctx.accounts.governance;
    governance.squads_vault = ctx.accounts.squads_vault.key();
    governance.guardian = guardian;
    governance.program_paused = false;
    governance.change_delay_seconds = GOVERNANCE_DELAY_SECONDS;
    governance.governance_version = 1;
    governance.fee_bps = 10;
    governance.max_fee_bps = 25;
    governance.max_quote_lifetime_seconds = 30;
    governance.max_stock_input_atomic = u64::MAX;
    Ok(())
}

pub(crate) fn initialize_asset_registry(
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
    require_squads_vault(&ctx.accounts.governance, &ctx.accounts.squads_vault)?;
    validate_registry_scope(
        issuer,
        &stable_outputs,
        ctx.accounts.stable_token_program.key(),
    )?;
    validate_issuer_configuration(
        issuer,
        metadata_pointer,
        issuer_authority,
        issuer_authority_fingerprint,
        issuer_program,
        jit_capability_fingerprint,
    )?;
    require_keys_eq!(
        *ctx.accounts.stock_mint.to_account_info().owner,
        ctx.accounts.stock_token_program.key(),
        ErrorCode::TokenProgramMismatch
    );
    validate_live_mint_configuration(
        &ctx.accounts.stock_mint.to_account_info(),
        hook_program,
        extension_fingerprint,
        metadata_pointer,
        issuer_authority,
        issuer_authority_fingerprint,
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
        hook_accounts.len().saturating_sub(2),
    )?;
    let observations = observe_hook_accounts(ctx.remaining_accounts);
    validate_hook_account_observations(&hook_accounts, &observations, &[])?;

    let registry = &mut ctx.accounts.asset_registry;
    registry.mint = ctx.accounts.stock_mint.key();
    registry.token_program = ctx.accounts.stock_token_program.key();
    registry.stable_token_program = ctx.accounts.stable_token_program.key();
    registry.stable_outputs = stable_outputs;
    registry.issuer = issuer;
    registry.metadata_pointer = metadata_pointer;
    registry.issuer_authority = issuer_authority;
    registry.issuer_authority_fingerprint = issuer_authority_fingerprint;
    registry.issuer_program = issuer_program;
    registry.jit_capability_fingerprint = jit_capability_fingerprint;
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

pub(crate) fn initialize_maker_registry(
    ctx: Context<InitializeMakerRegistry>,
    allowlisted: Vec<Pubkey>,
) -> Result<()> {
    require_squads_vault(&ctx.accounts.governance, &ctx.accounts.squads_vault)?;
    validate_maker_allowlist(&allowlisted)?;
    ctx.accounts.maker_registry.allowlisted = allowlisted;
    ctx.accounts.maker_registry.paused = false;
    ctx.accounts.maker_registry.registry_version = 1;
    ctx.accounts.maker_registry.last_applied = None;
    Ok(())
}

pub(crate) fn queue_governance_action(
    ctx: Context<QueueGovernanceAction>,
    proposal_id: [u8; 32],
    action: GovernanceAction,
    expected_version: u64,
) -> Result<()> {
    require!(proposal_id != [0; 32], ErrorCode::InvalidChangeHash);
    require_squads_vault(&ctx.accounts.governance, &ctx.accounts.squads_vault)?;
    let version =
        governance_target_version(&action, &ctx.accounts.target, &ctx.accounts.governance)?;
    require!(
        expected_version == version,
        ErrorCode::RegistryVersionNotIncreasing
    );
    let now = Clock::get()?.unix_timestamp;
    let target = governance_action_target(&action, &ctx.accounts.target)?;
    let expected_hash = governance_action_digest(
        &action,
        proposal_id,
        target,
        expected_version,
        ctx.accounts.squads_vault.key(),
        now,
        now.saturating_add(ctx.accounts.governance.change_delay_seconds),
    )?;
    require!(expected_hash != [0; 32], ErrorCode::InvalidChangeHash);
    let change = &mut ctx.accounts.queued_change;
    change.proposal_id = proposal_id;
    change.payload_hash = expected_hash;
    change.target = target;
    change.expected_version = expected_version;
    change.proposing_vault = ctx.accounts.squads_vault.key();
    change.created_at = now;
    change.apply_after = now.saturating_add(ctx.accounts.governance.change_delay_seconds);
    change.action = action;
    Ok(())
}

pub(crate) fn apply_governance_action(ctx: Context<ApplyGovernanceAction>) -> Result<()> {
    let change = &ctx.accounts.queued_change;
    require_squads_vault(&ctx.accounts.governance, &ctx.accounts.squads_vault)?;
    require_keys_eq!(
        change.proposing_vault,
        ctx.accounts.squads_vault.key(),
        ErrorCode::GovernanceSignerRequired
    );
    require_keys_eq!(
        change.target,
        ctx.accounts.target.key(),
        ErrorCode::InvalidChangeHash
    );
    require!(
        governance_action_digest(
            &change.action,
            change.proposal_id,
            change.target,
            change.expected_version,
            change.proposing_vault,
            change.created_at,
            change.apply_after,
        )? == change.payload_hash,
        ErrorCode::InvalidChangeHash
    );
    let applied_at = Clock::get()?.unix_timestamp;
    require!(
        applied_at >= change.apply_after,
        ErrorCode::GovernanceDelayActive
    );
    let version = governance_target_version(
        &change.action,
        &ctx.accounts.target,
        &ctx.accounts.governance,
    )?;
    require!(
        version == change.expected_version,
        ErrorCode::RegistryVersionNotIncreasing
    );
    match &change.action {
        GovernanceAction::SetEconomics { .. }
        | GovernanceAction::RotateAuthorities { .. }
        | GovernanceAction::UnpauseProgram => {
            require_keys_eq!(
                ctx.accounts.target.key(),
                ctx.accounts.governance.key(),
                ErrorCode::InvalidChangeHash
            );
            apply_governance_action_to_target(
                change,
                &ctx.accounts.target,
                &mut ctx.accounts.governance,
                applied_at,
            )?;
        }
        _ => apply_governance_action_to_target(
            change,
            &ctx.accounts.target,
            &mut ctx.accounts.governance,
            applied_at,
        )?,
    }
    Ok(())
}

pub(crate) fn cancel_governance_action(ctx: Context<CancelGovernanceAction>) -> Result<()> {
    require_squads_vault(&ctx.accounts.governance, &ctx.accounts.squads_vault)?;
    require_keys_eq!(
        ctx.accounts.queued_change.proposing_vault,
        ctx.accounts.squads_vault.key(),
        ErrorCode::GovernanceSignerRequired
    );
    Ok(())
}

fn governance_action_target(action: &GovernanceAction, target: &AccountInfo<'_>) -> Result<Pubkey> {
    match action {
        GovernanceAction::SetAsset { mint, .. } => {
            let expected = Pubkey::find_program_address(&[b"asset", mint.as_ref()], &crate::ID).0;
            require_keys_eq!(target.key(), expected, ErrorCode::InvalidChangeHash);
            Ok(expected)
        }
        GovernanceAction::SetMakers { .. } => {
            let expected = Pubkey::find_program_address(&[b"makers"], &crate::ID).0;
            require_keys_eq!(target.key(), expected, ErrorCode::InvalidChangeHash);
            Ok(expected)
        }
        GovernanceAction::SetEconomics { .. }
        | GovernanceAction::RotateAuthorities { .. }
        | GovernanceAction::UnpauseProgram => {
            let governance_key = Pubkey::find_program_address(&[b"governance"], &crate::ID).0;
            require_keys_eq!(target.key(), governance_key, ErrorCode::InvalidChangeHash);
            Ok(governance_key)
        }
    }
}

fn governance_target_version(
    action: &GovernanceAction,
    target: &AccountInfo<'_>,
    governance: &GovernanceConfig,
) -> Result<u64> {
    match action {
        GovernanceAction::SetAsset { .. } => {
            Ok(read_anchor_account::<AssetRegistry>(target)?.registry_version)
        }
        GovernanceAction::SetMakers { .. } => {
            Ok(read_anchor_account::<MakerRegistry>(target)?.registry_version)
        }
        GovernanceAction::SetEconomics { .. }
        | GovernanceAction::RotateAuthorities { .. }
        | GovernanceAction::UnpauseProgram => Ok(governance.governance_version),
    }
}

fn apply_governance_action_to_target(
    change: &QueuedGovernanceAction,
    target: &AccountInfo<'_>,
    governance: &mut GovernanceConfig,
    applied_at: i64,
) -> Result<()> {
    match &change.action {
        GovernanceAction::SetAsset {
            enabled, paused, ..
        } => {
            let mut registry = read_anchor_account::<AssetRegistry>(target)?;
            registry.enabled = *enabled;
            registry.paused = *paused;
            registry.registry_version = registry
                .registry_version
                .checked_add(1)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            write_anchor_account(target, &registry)?;
        }
        GovernanceAction::SetMakers {
            allowlisted,
            paused,
        } => {
            validate_maker_allowlist(allowlisted)?;
            let mut makers = read_anchor_account::<MakerRegistry>(target)?;
            makers.allowlisted = allowlisted.clone();
            makers.paused = *paused;
            makers.registry_version = makers
                .registry_version
                .checked_add(1)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            makers.last_applied = Some(AppliedMakerGovernanceAction {
                proposal_id: change.proposal_id,
                payload_hash: change.payload_hash,
                target: change.target,
                expected_version: change.expected_version,
                proposing_vault: change.proposing_vault,
                created_at: change.created_at,
                apply_after: change.apply_after,
                applied_at,
                allowlisted: allowlisted.clone(),
                paused: *paused,
                registry_version: makers.registry_version,
            });
            write_anchor_account(target, &makers)?;
        }
        GovernanceAction::SetEconomics {
            fee_bps,
            max_fee_bps,
            max_quote_lifetime_seconds,
            max_stock_input_atomic,
        } => {
            require!(
                *max_fee_bps <= crate::MAX_FEE_BPS && *fee_bps <= *max_fee_bps,
                ErrorCode::FeeCapExceeded
            );
            require!(
                *max_quote_lifetime_seconds > 0
                    && *max_quote_lifetime_seconds <= crate::MAX_QUOTE_LIFETIME_SECONDS,
                ErrorCode::InvalidQuoteWindow
            );
            require!(*max_stock_input_atomic > 0, ErrorCode::InvalidAmount);
            governance.fee_bps = *fee_bps;
            governance.max_fee_bps = *max_fee_bps;
            governance.max_quote_lifetime_seconds = *max_quote_lifetime_seconds;
            governance.max_stock_input_atomic = *max_stock_input_atomic;
            governance.governance_version = governance
                .governance_version
                .checked_add(1)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
        }
        GovernanceAction::RotateAuthorities {
            next_vault,
            next_guardian,
        } => {
            require!(
                *next_vault != Pubkey::default() && *next_guardian != Pubkey::default(),
                ErrorCode::GovernanceSignerRequired
            );
            governance.squads_vault = *next_vault;
            governance.guardian = *next_guardian;
            governance.governance_version = governance
                .governance_version
                .checked_add(1)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
        }
        GovernanceAction::UnpauseProgram => {
            governance.program_paused = false;
            governance.governance_version = governance
                .governance_version
                .checked_add(1)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
        }
    }
    Ok(())
}

fn read_anchor_account<T: AccountDeserialize>(account: &AccountInfo<'_>) -> Result<T> {
    require_keys_eq!(*account.owner, crate::ID, ErrorCode::InvalidChangeHash);
    let data = account
        .try_borrow_data()
        .map_err(|_| error!(ErrorCode::InvalidChangeHash))?;
    let mut bytes: &[u8] = &data;
    T::try_deserialize(&mut bytes)
}

fn write_anchor_account<T: AccountSerialize>(account: &AccountInfo<'_>, value: &T) -> Result<()> {
    let mut data = account
        .try_borrow_mut_data()
        .map_err(|_| error!(ErrorCode::InvalidChangeHash))?;
    let mut bytes: &mut [u8] = &mut data;
    value.try_serialize(&mut bytes)
}

pub(crate) fn governance_action_digest(
    action: &GovernanceAction,
    proposal_id: [u8; 32],
    target: Pubkey,
    expected_version: u64,
    vault: Pubkey,
    created_at: i64,
    apply_after: i64,
) -> Result<[u8; 32]> {
    let mut payload = Vec::new();
    action
        .serialize(&mut payload)
        .map_err(|_| error!(ErrorCode::InvalidChangeHash))?;
    Ok(solana_sha256_hasher::hashv(&[
        b"Katon governance action v1",
        &payload,
        &proposal_id,
        target.as_ref(),
        &expected_version.to_le_bytes(),
        vault.as_ref(),
        &created_at.to_le_bytes(),
        &apply_after.to_le_bytes(),
    ])
    .to_bytes())
}

pub(crate) fn queue_registry_change(
    ctx: Context<QueueRegistryChange>,
    enabled: bool,
    paused: bool,
    expected_version: u64,
    change_hash: [u8; 32],
) -> Result<()> {
    require!(change_hash != [0u8; 32], ErrorCode::InvalidChangeHash);
    require_squads_vault(&ctx.accounts.governance, &ctx.accounts.squads_vault)?;
    require!(
        expected_version == ctx.accounts.asset_registry.registry_version,
        ErrorCode::RegistryVersionNotIncreasing
    );
    require!(
        registry_change_digest(
            &ctx.accounts.asset_registry.key(),
            enabled,
            paused,
            expected_version.saturating_add(1)
        ) == change_hash,
        ErrorCode::InvalidChangeHash
    );
    let now = Clock::get()?.unix_timestamp;
    let change = &mut ctx.accounts.queued_change;
    change.payload_hash = change_hash;
    change.target = ctx.accounts.asset_registry.key();
    change.expected_version = expected_version;
    change.enabled = enabled;
    change.paused = paused;
    change.apply_after = now.saturating_add(ctx.accounts.governance.change_delay_seconds);
    Ok(())
}

pub(crate) fn apply_registry_change(ctx: Context<ApplyRegistryChange>) -> Result<()> {
    require_squads_vault(&ctx.accounts.governance, &ctx.accounts.squads_vault)?;
    let now = Clock::get()?.unix_timestamp;
    let change = &ctx.accounts.queued_change;
    require_keys_eq!(
        change.target,
        ctx.accounts.asset_registry.key(),
        ErrorCode::InvalidChangeHash
    );
    require!(
        registry_change_digest(
            &ctx.accounts.asset_registry.key(),
            change.enabled,
            change.paused,
            change.expected_version.saturating_add(1),
        ) == change.payload_hash,
        ErrorCode::InvalidChangeHash
    );
    require!(now >= change.apply_after, ErrorCode::GovernanceDelayActive);
    require!(
        change.expected_version == ctx.accounts.asset_registry.registry_version,
        ErrorCode::RegistryVersionNotIncreasing
    );
    ctx.accounts.asset_registry.enabled = change.enabled;
    ctx.accounts.asset_registry.paused = change.paused;
    ctx.accounts.asset_registry.registry_version = change.expected_version.saturating_add(1);
    Ok(())
}

pub(crate) fn cancel_registry_change(ctx: Context<CancelRegistryChange>) -> Result<()> {
    require_squads_vault(&ctx.accounts.governance, &ctx.accounts.squads_vault)
}

pub(crate) fn guardian_pause_asset(ctx: Context<GuardianPauseAsset>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.guardian.key(),
        ctx.accounts.governance.guardian,
        ErrorCode::GuardianRequired
    );
    ctx.accounts.asset_registry.paused = true;
    Ok(())
}

pub(crate) fn guardian_pause_program(ctx: Context<GuardianPauseProgram>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.guardian.key(),
        ctx.accounts.governance.guardian,
        ErrorCode::GuardianRequired
    );
    ctx.accounts.governance.program_paused = true;
    Ok(())
}

pub(crate) fn guardian_pause_makers(ctx: Context<GuardianPauseMakers>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.guardian.key(),
        ctx.accounts.governance.guardian,
        ErrorCode::GuardianRequired
    );
    ctx.accounts.maker_registry.paused = true;
    Ok(())
}
