use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token::state::Mint as ClassicMint;
use anchor_spl::token::ID as SPL_TOKEN_PROGRAM_ID;
use anchor_spl::token_interface;
use anchor_spl::token_interface::spl_token_2022::extension::metadata_pointer::MetadataPointer;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_hook::TransferHook;
use anchor_spl::token_interface::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};

use crate::{
    ErrorCode, GovernanceConfig, ISSUER_ONDO, ISSUER_XSTOCKS, NATIVE_USDC_MINT, NATIVE_USDT_MINT,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct LiveMintConfiguration {
    pub(crate) hook_program: Option<Pubkey>,
    pub(crate) extension_fingerprint: [u8; 32],
    pub(crate) metadata_pointer: Option<Pubkey>,
    pub(crate) issuer_authority: Option<Pubkey>,
    pub(crate) issuer_authority_fingerprint: [u8; 32],
}

pub(crate) fn live_mint_configuration(mint: &AccountInfo<'_>) -> Result<LiveMintConfiguration> {
    if mint.owner == &SPL_TOKEN_PROGRAM_ID {
        let mint_data = mint
            .try_borrow_data()
            .map_err(|_| error!(ErrorCode::InvalidMintTlv))?;
        let classic_mint =
            ClassicMint::unpack(&mint_data).map_err(|_| error!(ErrorCode::InvalidMintTlv))?;
        let issuer_authority = Option::<Pubkey>::from(classic_mint.mint_authority);
        let issuer_authority_fingerprint = issuer_authority
            .map(|authority| solana_sha256_hasher::hashv(&[authority.as_ref()]).to_bytes())
            .unwrap_or([0; 32]);
        return Ok(LiveMintConfiguration {
            hook_program: None,
            extension_fingerprint: solana_sha256_hasher::hashv(&[&[]]).to_bytes(),
            metadata_pointer: None,
            issuer_authority,
            issuer_authority_fingerprint,
        });
    }
    require_keys_eq!(
        *mint.owner,
        token_interface::spl_token_2022::ID,
        ErrorCode::TokenProgramMismatch
    );
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
    let metadata_pointer = if extension_types.contains(&ExtensionType::MetadataPointer) {
        let metadata = mint_with_extensions
            .get_extension::<MetadataPointer>()
            .map_err(|_| error!(ErrorCode::InvalidMintTlv))?;
        Option::<Pubkey>::from(metadata.metadata_address)
    } else {
        None
    };
    let issuer_authority = Option::<Pubkey>::from(mint_with_extensions.base.mint_authority);
    let issuer_authority_fingerprint = issuer_authority
        .map(|authority| solana_sha256_hasher::hashv(&[authority.as_ref()]).to_bytes())
        .unwrap_or([0; 32]);
    Ok(LiveMintConfiguration {
        hook_program,
        extension_fingerprint: solana_sha256_hasher::hashv(&[mint_with_extensions.get_tlv_data()])
            .to_bytes(),
        metadata_pointer,
        issuer_authority,
        issuer_authority_fingerprint,
    })
}

pub(crate) fn validate_live_mint_configuration(
    mint: &AccountInfo<'_>,
    expected_hook_program: Option<Pubkey>,
    expected_extension_fingerprint: [u8; 32],
    expected_metadata_pointer: Pubkey,
    expected_issuer_authority: Pubkey,
    expected_issuer_authority_fingerprint: [u8; 32],
) -> Result<()> {
    let live = live_mint_configuration(mint)?;
    require!(
        expected_metadata_pointer != Pubkey::default()
            && expected_issuer_authority != Pubkey::default()
            && expected_issuer_authority_fingerprint != [0; 32],
        ErrorCode::IssuerConfigurationMismatch
    );
    if mint.owner == &token_interface::spl_token_2022::ID {
        require!(
            live.metadata_pointer == Some(expected_metadata_pointer),
            ErrorCode::MetadataPointerMismatch
        );
        require!(
            live.issuer_authority == Some(expected_issuer_authority)
                && live.issuer_authority_fingerprint == expected_issuer_authority_fingerprint,
            ErrorCode::IssuerAuthorityMismatch
        );
    } else {
        require!(
            live.issuer_authority == Some(expected_issuer_authority)
                && live.issuer_authority_fingerprint == expected_issuer_authority_fingerprint,
            ErrorCode::IssuerAuthorityMismatch
        );
    }
    require!(
        live.hook_program == expected_hook_program
            && live.extension_fingerprint == expected_extension_fingerprint,
        ErrorCode::LiveHookMismatch
    );
    Ok(())
}

pub(crate) fn validate_issuer_configuration(
    issuer: u8,
    metadata_pointer: Pubkey,
    issuer_authority: Pubkey,
    issuer_authority_fingerprint: [u8; 32],
    issuer_program: Option<Pubkey>,
    jit_capability_fingerprint: [u8; 32],
) -> Result<()> {
    require!(
        issuer == ISSUER_XSTOCKS || issuer == ISSUER_ONDO,
        ErrorCode::UnsupportedIssuer
    );
    require!(
        metadata_pointer != Pubkey::default()
            && issuer_authority != Pubkey::default()
            && issuer_authority_fingerprint != [0; 32],
        ErrorCode::IssuerConfigurationMismatch
    );
    match issuer {
        ISSUER_XSTOCKS => {
            require!(
                issuer_program.is_none() && jit_capability_fingerprint == [0; 32],
                ErrorCode::IssuerConfigurationMismatch
            );
        }
        ISSUER_ONDO => {
            require!(
                issuer_program.is_some_and(|program| program != Pubkey::default())
                    && jit_capability_fingerprint != [0; 32],
                ErrorCode::IssuerConfigurationMismatch
            );
        }
        _ => return Err(error!(ErrorCode::UnsupportedIssuer)),
    }
    Ok(())
}

pub(crate) fn validate_generic_settlement_issuer(issuer: u8) -> Result<()> {
    require!(
        issuer == ISSUER_XSTOCKS,
        ErrorCode::ManagedIssuerRouteRequired
    );
    Ok(())
}

pub(crate) fn validate_maker_allowlist(allowlisted: &[Pubkey]) -> Result<()> {
    require!(allowlisted.len() <= 64, ErrorCode::TooManyMakers);
    for (index, maker) in allowlisted.iter().enumerate() {
        require!(*maker != Pubkey::default(), ErrorCode::InvalidMaker);
        for previous in allowlisted.iter().take(index) {
            require!(maker != previous, ErrorCode::DuplicateMaker);
        }
    }
    Ok(())
}

pub(crate) fn validate_registry_scope(
    issuer: u8,
    stable_outputs: &[Pubkey; 2],
    stable_token_program: Pubkey,
) -> Result<()> {
    require!(
        issuer == ISSUER_XSTOCKS || issuer == ISSUER_ONDO,
        ErrorCode::UnsupportedIssuer
    );
    require_keys_eq!(
        stable_token_program,
        SPL_TOKEN_PROGRAM_ID,
        ErrorCode::TokenProgramMismatch
    );
    require!(
        (stable_outputs[0] == NATIVE_USDC_MINT && stable_outputs[1] == NATIVE_USDT_MINT)
            || (stable_outputs[0] == NATIVE_USDT_MINT && stable_outputs[1] == NATIVE_USDC_MINT),
        ErrorCode::UnsupportedOutput
    );
    Ok(())
}

pub(crate) fn validate_governance_initialization(
    squads_vault: Pubkey,
    guardian: Pubkey,
) -> Result<()> {
    require!(
        squads_vault != Pubkey::default(),
        ErrorCode::GovernanceSignerRequired
    );
    require!(guardian != Pubkey::default(), ErrorCode::GuardianRequired);
    Ok(())
}

pub(crate) fn validate_distinct_mutable_keys(keys: &[Pubkey]) -> Result<()> {
    for (index, key) in keys.iter().enumerate() {
        for previous in keys.iter().take(index) {
            require!(key != previous, ErrorCode::DuplicateMutableAccount);
        }
    }
    Ok(())
}

pub(crate) fn require_squads_vault(
    governance: &GovernanceConfig,
    vault: &Signer<'_>,
) -> Result<()> {
    require_keys_eq!(
        vault.key(),
        governance.squads_vault,
        ErrorCode::GovernanceSignerRequired
    );
    Ok(())
}

/// Commit/reveal digest for registry state changes. The queued hash is bound
/// to the exact asset PDA and every state field that `apply_registry_change`
/// can mutate, so a delayed quorum cannot be repurposed for another asset or
/// a different enable/pause/version tuple.
pub(crate) fn registry_change_digest(
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
