use super::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token::state::Mint as ClassicMint;
use anchor_spl::token::ID as SPL_TOKEN_PROGRAM_ID;
use anchor_spl::token_interface::spl_token_2022::extension::metadata_pointer::MetadataPointer;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_fee::TransferFeeConfig;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_hook::TransferHook;
use anchor_spl::token_interface::spl_token_2022::extension::{
    BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
};
use spl_pod::list::ListView;
use spl_type_length_value::state::{TlvState, TlvStateBorrowed, TlvStateMut};

use crate::governance::governance_action_digest;
use crate::settlement::{
    split_stable_fee, stock_requires_transfer_checked_with_fee, validate_fee_bps,
    validate_quote_window,
};

/// Builds a Token-2022 mint account buffer with an optional TransferFeeConfig
/// extension whose current and scheduled fee bps are both `fee_bps`.
fn token_2022_mint_data(fee_bps: Option<u16>) -> Vec<u8> {
    let extensions: Vec<ExtensionType> = match fee_bps {
        Some(_) => vec![ExtensionType::TransferFeeConfig],
        None => vec![],
    };
    let mint_len = ExtensionType::try_calculate_account_len::<
        token_interface::spl_token_2022::state::Mint,
    >(&extensions)
    .unwrap();
    let mut mint_data = vec![0; mint_len];
    {
        let mut state =
            StateWithExtensionsMut::<token_interface::spl_token_2022::state::Mint>::unpack_uninitialized(
                &mut mint_data,
            )
            .unwrap();
        state.base.decimals = 6;
        state.base.is_initialized = true;
        state.init_account_type().unwrap();
        if let Some(bps) = fee_bps {
            let fee_config = state.init_extension::<TransferFeeConfig>(true).unwrap();
            fee_config.older_transfer_fee.transfer_fee_basis_points = bps.into();
            fee_config.newer_transfer_fee.transfer_fee_basis_points = bps.into();
        }
        state.pack_base();
    }
    mint_data
}

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
        HookAccountMeta {
            key: hook_program,
            owner: Pubkey::from_str_const("NativeLoader1111111111111111111111111111111"),
            is_signer: false,
            is_writable: false,
            executable: true,
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
        HookAccountObservation {
            key: hook_program,
            owner: Pubkey::from_str_const("NativeLoader1111111111111111111111111111111"),
            is_signer: false,
            is_writable: false,
            executable: true,
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
    let mut hook_program_lamports = 0;
    let mut hook_program_data = vec![];
    let hook_program_owner = Pubkey::from_str_const("NativeLoader1111111111111111111111111111111");
    let hook_program_account = AccountInfo::new(
        &hook_program,
        false,
        false,
        &mut hook_program_lamports,
        &mut hook_program_data,
        &hook_program_owner,
        true,
    );
    let accounts = vec![
        source,
        mint_account,
        destination,
        authority,
        validation,
        extra,
        hook_program_account,
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
fn governance_bootstrap_requires_a_vault_and_guardian() {
    let vault = Pubkey::new_from_array([1; 32]);
    let guardian = Pubkey::new_from_array([4; 32]);

    assert!(validate_governance_initialization(vault, guardian).is_ok());
    assert!(validate_governance_initialization(Pubkey::default(), guardian).is_err());
    assert!(validate_governance_initialization(vault, Pubkey::default()).is_err());
}

#[test]
fn governance_action_hash_binds_payload_target_version_vault_and_delay() {
    let action = GovernanceAction::SetAsset {
        mint: Pubkey::new_from_array([11; 32]),
        enabled: true,
        paused: false,
    };
    let target = Pubkey::new_from_array([12; 32]);
    let vault = Pubkey::new_from_array([13; 32]);
    let proposal_id = [14; 32];
    let digest =
        governance_action_digest(&action, proposal_id, target, 7, vault, 100, 86_500).unwrap();

    assert_ne!(
        digest,
        governance_action_digest(&action, [15; 32], target, 7, vault, 100, 86_500).unwrap()
    );
    assert_ne!(
        digest,
        governance_action_digest(
            &action,
            proposal_id,
            Pubkey::new_from_array([16; 32]),
            7,
            vault,
            100,
            86_500
        )
        .unwrap()
    );
    assert_ne!(
        digest,
        governance_action_digest(&action, proposal_id, target, 8, vault, 100, 86_500).unwrap()
    );
    assert_ne!(
        digest,
        governance_action_digest(
            &action,
            proposal_id,
            target,
            7,
            Pubkey::new_from_array([17; 32]),
            100,
            86_500
        )
        .unwrap()
    );
    assert_ne!(
        digest,
        governance_action_digest(&action, proposal_id, target, 7, vault, 101, 86_500).unwrap()
    );
    assert_ne!(
        digest,
        governance_action_digest(&action, proposal_id, target, 7, vault, 100, 86_501).unwrap()
    );
    assert_ne!(
        digest,
        governance_action_digest(
            &GovernanceAction::SetAsset {
                mint: Pubkey::new_from_array([11; 32]),
                enabled: false,
                paused: false,
            },
            proposal_id,
            target,
            7,
            vault,
            100,
            86_500
        )
        .unwrap()
    );
}

#[test]
fn registry_scope_is_locked_to_native_stables_and_known_issuers() {
    assert!(validate_registry_scope(
        ISSUER_XSTOCKS,
        &[NATIVE_USDC_MINT, NATIVE_USDT_MINT],
        SPL_TOKEN_PROGRAM_ID,
    )
    .is_ok());
    assert!(validate_registry_scope(
        ISSUER_ONDO,
        &[NATIVE_USDT_MINT, NATIVE_USDC_MINT],
        SPL_TOKEN_PROGRAM_ID,
    )
    .is_ok());
    assert!(validate_registry_scope(
        2,
        &[NATIVE_USDC_MINT, NATIVE_USDT_MINT],
        SPL_TOKEN_PROGRAM_ID,
    )
    .is_err());
    assert!(validate_registry_scope(
        ISSUER_XSTOCKS,
        &[Pubkey::new_from_array([9; 32]), NATIVE_USDT_MINT],
        SPL_TOKEN_PROGRAM_ID,
    )
    .is_err());
    assert!(validate_registry_scope(
        ISSUER_XSTOCKS,
        &[NATIVE_USDC_MINT, NATIVE_USDT_MINT],
        token_interface::spl_token_2022::ID,
    )
    .is_err());
}

#[test]
fn issuer_registry_state_requires_exact_metadata_and_route_fields() {
    let metadata_pointer = Pubkey::new_from_array([5; 32]);
    let issuer_authority = Pubkey::new_from_array([6; 32]);
    let issuer_program = Pubkey::new_from_array([7; 32]);

    assert!(validate_issuer_configuration(
        ISSUER_XSTOCKS,
        metadata_pointer,
        issuer_authority,
        [8; 32],
        None,
        [0; 32],
    )
    .is_ok());
    assert!(validate_issuer_configuration(
        ISSUER_XSTOCKS,
        Pubkey::default(),
        issuer_authority,
        [8; 32],
        None,
        [0; 32],
    )
    .is_err());
    assert!(validate_issuer_configuration(
        ISSUER_ONDO,
        metadata_pointer,
        issuer_authority,
        [8; 32],
        None,
        [9; 32],
    )
    .is_err());
    assert!(validate_issuer_configuration(
        ISSUER_ONDO,
        metadata_pointer,
        issuer_authority,
        [8; 32],
        Some(issuer_program),
        [9; 32],
    )
    .is_ok());
    assert!(validate_generic_settlement_issuer(ISSUER_XSTOCKS).is_ok());
    assert!(validate_generic_settlement_issuer(ISSUER_ONDO).is_err());
}

#[test]
fn live_mint_configuration_binds_the_complete_token_2022_tlv_buffer() {
    let mint_key = Pubkey::new_from_array([7; 32]);
    let hook_program = Pubkey::new_from_array([8; 32]);
    let issuer_authority = Pubkey::new_from_array([12; 32]);
    let metadata_pointer = Pubkey::new_from_array([13; 32]);
    let mint_len = ExtensionType::try_calculate_account_len::<
        token_interface::spl_token_2022::state::Mint,
    >(&[ExtensionType::TransferHook, ExtensionType::MetadataPointer])
    .unwrap();
    let mut mint_data = vec![0; mint_len];
    {
        let mut state = StateWithExtensionsMut::<
                token_interface::spl_token_2022::state::Mint,
            >::unpack_uninitialized(&mut mint_data)
            .unwrap();
        state.base.decimals = 6;
        state.base.is_initialized = true;
        state.base.mint_authority = Some(issuer_authority).into();
        state.init_account_type().unwrap();
        let transfer_hook = state.init_extension::<TransferHook>(true).unwrap();
        transfer_hook.program_id = Some(hook_program).try_into().unwrap();
        let metadata = state.init_extension::<MetadataPointer>(true).unwrap();
        metadata.metadata_address = Some(metadata_pointer).try_into().unwrap();
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
    assert_eq!(live.metadata_pointer, Some(metadata_pointer));
    assert_eq!(live.issuer_authority, Some(issuer_authority));
    assert_eq!(
        live.issuer_authority_fingerprint,
        solana_sha256_hasher::hashv(&[issuer_authority.as_ref()]).to_bytes()
    );
    assert!(live.extension_fingerprint != [0; 32]);
    assert!(validate_live_mint_configuration(
        &account,
        Some(hook_program),
        live.extension_fingerprint,
        metadata_pointer,
        issuer_authority,
        live.issuer_authority_fingerprint,
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
        metadata_pointer,
        issuer_authority,
        live.issuer_authority_fingerprint,
    )
    .is_err());
}

#[test]
fn classic_mint_configuration_binds_live_authority() {
    let mint_key = Pubkey::new_from_array([21; 32]);
    let issuer_authority = Pubkey::new_from_array([22; 32]);
    let metadata_pointer = Pubkey::new_from_array([23; 32]);
    let mut mint_data = vec![0; ClassicMint::LEN];
    ClassicMint::pack(
        ClassicMint {
            mint_authority: Some(issuer_authority).into(),
            supply: 0,
            decimals: 6,
            is_initialized: true,
            freeze_authority: None.into(),
        },
        &mut mint_data,
    )
    .unwrap();
    let mint_owner = SPL_TOKEN_PROGRAM_ID;
    let mut mint_lamports = 0;
    let mint_account = AccountInfo::new(
        &mint_key,
        false,
        false,
        &mut mint_lamports,
        &mut mint_data,
        &mint_owner,
        false,
    );
    let extension_fingerprint = solana_sha256_hasher::hashv(&[&[]]).to_bytes();
    let authority_fingerprint =
        solana_sha256_hasher::hashv(&[issuer_authority.as_ref()]).to_bytes();

    let live = live_mint_configuration(&mint_account).unwrap();
    assert_eq!(live.issuer_authority, Some(issuer_authority));
    assert!(validate_live_mint_configuration(
        &mint_account,
        None,
        extension_fingerprint,
        metadata_pointer,
        issuer_authority,
        authority_fingerprint,
    )
    .is_ok());
    assert!(validate_live_mint_configuration(
        &mint_account,
        None,
        extension_fingerprint,
        metadata_pointer,
        Pubkey::new_from_array([24; 32]),
        authority_fingerprint,
    )
    .is_err());
}

#[test]
fn exact_input_binds_zero_fee_cpi_and_fails_closed_on_fee_drift() {
    let mint_key = Pubkey::new_from_array([31; 32]);

    // A classic SPL mint has no Token-2022 fee machinery: plain transfer_checked.
    let mut classic_data = vec![0; ClassicMint::LEN];
    ClassicMint::pack(
        ClassicMint {
            mint_authority: Some(Pubkey::new_from_array([32; 32])).into(),
            supply: 0,
            decimals: 6,
            is_initialized: true,
            freeze_authority: None.into(),
        },
        &mut classic_data,
    )
    .unwrap();
    let mut classic_lamports = 0;
    let classic = AccountInfo::new(
        &mint_key,
        false,
        false,
        &mut classic_lamports,
        &mut classic_data,
        &SPL_TOKEN_PROGRAM_ID,
        false,
    );
    assert!(!stock_requires_transfer_checked_with_fee(&classic).unwrap());

    // A zero-fee Token-2022 mint binds the CPI to an expected fee of exactly zero.
    let token_2022 = token_interface::spl_token_2022::ID;
    let mut zero_fee_data = token_2022_mint_data(Some(0));
    let mut zero_fee_lamports = 0;
    let zero_fee = AccountInfo::new(
        &mint_key,
        false,
        false,
        &mut zero_fee_lamports,
        &mut zero_fee_data,
        &token_2022,
        false,
    );
    assert!(stock_requires_transfer_checked_with_fee(&zero_fee).unwrap());

    // A Token-2022 mint with no fee extension is fee-free by construction.
    let mut plain_data = token_2022_mint_data(None);
    let mut plain_lamports = 0;
    let plain = AccountInfo::new(
        &mint_key,
        false,
        false,
        &mut plain_lamports,
        &mut plain_data,
        &token_2022,
        false,
    );
    assert!(!stock_requires_transfer_checked_with_fee(&plain).unwrap());

    // Any drift to a nonzero fee fails closed instead of under-delivering stock.
    let mut drift_data = token_2022_mint_data(Some(MAX_FEE_BPS));
    let mut drift_lamports = 0;
    let drift = AccountInfo::new(
        &mint_key,
        false,
        false,
        &mut drift_lamports,
        &mut drift_data,
        &token_2022,
        false,
    );
    assert_eq!(
        stock_requires_transfer_checked_with_fee(&drift).unwrap_err(),
        anchor_lang::error!(ErrorCode::NonzeroTransferFee)
    );

    // An owner that is neither SPL Token program fails closed before any CPI.
    let mut foreign_data = token_2022_mint_data(Some(0));
    let mut foreign_lamports = 0;
    let foreign_owner = Pubkey::new_from_array([33; 32]);
    let foreign = AccountInfo::new(
        &mint_key,
        false,
        false,
        &mut foreign_lamports,
        &mut foreign_data,
        &foreign_owner,
        false,
    );
    assert_eq!(
        stock_requires_transfer_checked_with_fee(&foreign).unwrap_err(),
        anchor_lang::error!(ErrorCode::TokenProgramMismatch)
    );
}

#[test]
fn exact_input_fee_split_receives_exact_gross_and_caps_policy_bps() {
    assert!(validate_fee_bps(0).is_ok());
    assert!(validate_fee_bps(MAX_FEE_BPS).is_ok());
    assert_eq!(
        validate_fee_bps(MAX_FEE_BPS + 1).unwrap_err(),
        anchor_lang::error!(ErrorCode::FeeCapExceeded)
    );

    // 10 bps default on 1_000_000 atomic units: fee 1_000, seller net 999_000.
    assert_eq!(split_stable_fee(1_000_000, 10).unwrap(), (1_000, 999_000));
    // The fee floors, so dust pays nothing and the seller keeps the whole gross.
    assert_eq!(split_stable_fee(999, 10).unwrap(), (0, 999));
    // Fee plus seller net always reconstructs the exact gross the maker debited.
    let gross = u64::MAX / 2;
    let (fee, seller_net) = split_stable_fee(gross, MAX_FEE_BPS).unwrap();
    assert_eq!(fee + seller_net, gross);
}

#[test]
fn exact_input_clock_window_rejects_outside_and_over_lifetime_quotes() {
    // Both boundaries are live instants: issued_at <= now <= expiry.
    assert!(validate_quote_window(1_000, 1_030, 1_000).is_ok());
    assert!(validate_quote_window(1_000, 1_030, 1_030).is_ok());

    assert_eq!(
        validate_quote_window(1_000, 1_030, 999).unwrap_err(),
        anchor_lang::error!(ErrorCode::ClockOutsideQuoteWindow)
    );
    assert_eq!(
        validate_quote_window(1_000, 1_030, 1_031).unwrap_err(),
        anchor_lang::error!(ErrorCode::ClockOutsideQuoteWindow)
    );
    // One second past the thirty-second hard cap is rejected even when live.
    assert_eq!(
        validate_quote_window(1_000, 1_031, 1_010).unwrap_err(),
        anchor_lang::error!(ErrorCode::InvalidExpiry)
    );
}
