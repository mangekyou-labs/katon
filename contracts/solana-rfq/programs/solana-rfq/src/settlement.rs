use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};
use anchor_spl::token::ID as SPL_TOKEN_PROGRAM_ID;
use anchor_spl::token_interface::spl_token_2022::extension::memo_transfer::MemoTransfer;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_fee::instruction::transfer_checked_with_fee;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_fee::TransferFeeConfig;
use anchor_spl::token_interface::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_interface::{self, TransferChecked};

use crate::{
    validate_distinct_mutable_keys, validate_generic_settlement_issuer, validate_hook_accounts,
    validate_issuer_configuration, validate_live_mint_configuration, validate_registry_scope,
    validate_transfer_hook_execution, ErrorCode, PrivateQuoteFilled, SettlePrivateQuote,
    BPS_DENOMINATOR, MAX_FEE_BPS, MAX_QUOTE_LIFETIME_SECONDS,
};

const MEMO_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");

fn destination_requires_memo(
    destination: &AccountInfo<'_>,
    token_program: &Pubkey,
) -> Result<bool> {
    if token_program == &SPL_TOKEN_PROGRAM_ID {
        return Ok(false);
    }
    require_keys_eq!(
        *token_program,
        token_interface::spl_token_2022::ID,
        ErrorCode::TokenProgramMismatch
    );
    let data = destination
        .try_borrow_data()
        .map_err(|_| error!(ErrorCode::InvalidTokenAccountData))?;
    let account =
        StateWithExtensions::<token_interface::spl_token_2022::state::Account>::unpack(&data)
            .map_err(|_| error!(ErrorCode::InvalidTokenAccountData))?;
    let extension_types = account
        .get_extension_types()
        .map_err(|_| error!(ErrorCode::InvalidTokenAccountData))?;
    if !extension_types.contains(&ExtensionType::MemoTransfer) {
        return Ok(false);
    }
    let memo_extension = account
        .get_extension::<MemoTransfer>()
        .map_err(|_| error!(ErrorCode::InvalidTokenAccountData))?;
    Ok(memo_extension.require_incoming_transfer_memos.into())
}

fn validate_memo_program_account(account: &AccountInfo<'_>) -> Result<()> {
    require_keys_eq!(
        account.key(),
        MEMO_PROGRAM_ID,
        ErrorCode::InvalidMemoProgram
    );
    require!(
        account.executable && !account.is_signer && !account.is_writable,
        ErrorCode::InvalidMemoProgram
    );
    require!(
        *account.owner != Pubkey::default(),
        ErrorCode::InvalidMemoProgram
    );
    Ok(())
}

/// Returns true when the stock mint carries a TransferFeeConfig that is eligible
/// for Exact Input (current and scheduled fee bps are both zero).
pub(crate) fn stock_requires_transfer_checked_with_fee(mint: &AccountInfo<'_>) -> Result<bool> {
    if mint.owner == &SPL_TOKEN_PROGRAM_ID {
        return Ok(false);
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
    if !extension_types.contains(&ExtensionType::TransferFeeConfig) {
        return Ok(false);
    }
    let fee_config = mint_with_extensions
        .get_extension::<TransferFeeConfig>()
        .map_err(|_| error!(ErrorCode::InvalidMintTlv))?;
    let older_bps = u16::from(fee_config.older_transfer_fee.transfer_fee_basis_points);
    let newer_bps = u16::from(fee_config.newer_transfer_fee.transfer_fee_basis_points);
    require!(
        older_bps == 0 && newer_bps == 0,
        ErrorCode::NonzeroTransferFee
    );
    Ok(true)
}

/// AC-029: a signed quote is live only inside `[issued_at, expiry]` and never
/// outlives the thirty-second hard cap.
pub(crate) fn validate_quote_window(issued_at: i64, expiry: i64, now: i64) -> Result<()> {
    require!(
        issued_at <= now && now <= expiry,
        ErrorCode::ClockOutsideQuoteWindow
    );
    require!(
        expiry.saturating_sub(issued_at) <= MAX_QUOTE_LIFETIME_SECONDS,
        ErrorCode::InvalidExpiry
    );
    Ok(())
}

/// AC-027: the private fee never exceeds the 25 bps policy cap.
pub(crate) fn validate_fee_bps(fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeCapExceeded);
    Ok(())
}

/// AC-026: Exact Input split. The fee recipient receives exactly the fee and
/// the seller receives gross minus that fee; the fee is floored, so no
/// rounding can reduce the seller's receipt below the floor.
pub(crate) fn split_stable_fee(gross_stable_amount: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let fee = u128::from(gross_stable_amount)
        .checked_mul(u128::from(fee_bps))
        .ok_or(ErrorCode::MathOverflow)?
        / BPS_DENOMINATOR;
    let fee = u64::try_from(fee).map_err(|_| error!(ErrorCode::MathOverflow))?;
    let seller_stable_amount = gross_stable_amount
        .checked_sub(fee)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok((fee, seller_stable_amount))
}

fn transfer_stock_exact<'info>(
    token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    use_fee_ix: bool,
    memo_program: Option<AccountInfo<'info>>,
    quote_id: [u8; 32],
) -> Result<()> {
    if let Some(memo_program) = memo_program {
        let mut memo_data = b"Katon RFQ settlement ".to_vec();
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for byte in quote_id {
            memo_data.push(HEX[usize::from(byte >> 4)]);
            memo_data.push(HEX[usize::from(byte & 0x0f)]);
        }
        let memo_instruction = Instruction {
            program_id: MEMO_PROGRAM_ID,
            accounts: Vec::new(),
            data: memo_data,
        };
        invoke(&memo_instruction, &[memo_program])?;
    }
    if use_fee_ix {
        // Expected fee is bound to zero; Token-2022 rejects fee drift fail-closed.
        let mut ix = transfer_checked_with_fee(
            token_program.key,
            from.key,
            mint.key,
            to.key,
            authority.key,
            &[],
            amount,
            decimals,
            0,
        )?;
        let mut account_infos = vec![
            token_program.clone(),
            from.clone(),
            mint.clone(),
            to.clone(),
            authority.clone(),
        ];
        for account in remaining_accounts {
            ix.accounts.push(if account.is_writable {
                anchor_lang::solana_program::instruction::AccountMeta::new(
                    *account.key,
                    account.is_signer,
                )
            } else {
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    *account.key,
                    account.is_signer,
                )
            });
            account_infos.push(account.clone());
        }
        invoke(&ix, &account_infos)?;
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from,
                mint,
                to,
                authority,
            },
        )
        .with_remaining_accounts(remaining_accounts.to_vec()),
        amount,
        decimals,
    )
}

/// Settle the exact terms a seller and an allowlisted maker signed off-chain.
/// The program never holds inventory: each leg is a direct token-interface CPI.
pub(crate) fn settle_private_quote<'info>(
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
    require!(quote_id != [0; 32], ErrorCode::InvalidQuoteId);
    let now = Clock::get()?.unix_timestamp;
    require!(
        stock_amount > 0 && gross_stable_amount > 0,
        ErrorCode::InvalidAmount
    );
    require!(
        stock_amount <= ctx.accounts.governance.max_stock_input_atomic,
        ErrorCode::InvalidAmount
    );
    require!(
        expiry.saturating_sub(issued_at) <= ctx.accounts.governance.max_quote_lifetime_seconds,
        ErrorCode::InvalidQuoteWindow
    );
    validate_quote_window(issued_at, expiry, now)?;
    require!(
        fee_bps == ctx.accounts.governance.fee_bps,
        ErrorCode::FeeCapExceeded
    );
    require!(
        fee_bps <= ctx.accounts.governance.max_fee_bps,
        ErrorCode::FeeCapExceeded
    );
    validate_fee_bps(fee_bps)?;
    require!(
        stock_amount >= maker_min_stock_receipt,
        ErrorCode::MinimumNotMet
    );

    let registry = &ctx.accounts.asset_registry;
    require!(
        !ctx.accounts.governance.program_paused,
        ErrorCode::ProgramPaused
    );
    require!(
        !ctx.accounts.maker_registry.paused,
        ErrorCode::AssetNotEnabled
    );
    validate_registry_scope(
        registry.issuer,
        &registry.stable_outputs,
        registry.stable_token_program,
    )?;
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
    validate_issuer_configuration(
        registry.issuer,
        registry.metadata_pointer,
        registry.issuer_authority,
        registry.issuer_authority_fingerprint,
        registry.issuer_program,
        registry.jit_capability_fingerprint,
    )?;
    validate_generic_settlement_issuer(registry.issuer)?;
    validate_live_mint_configuration(
        &ctx.accounts.stock_mint.to_account_info(),
        registry.hook_program,
        registry.extension_fingerprint,
        registry.metadata_pointer,
        registry.issuer_authority,
        registry.issuer_authority_fingerprint,
    )?;
    let stock_uses_fee_ix =
        stock_requires_transfer_checked_with_fee(&ctx.accounts.stock_mint.to_account_info())?;
    let stock_destination_info = ctx.accounts.maker_stock_account.to_account_info();
    let memo_required = destination_requires_memo(
        &stock_destination_info,
        ctx.accounts.stock_token_program.key,
    )?;
    let (memo_program, hook_accounts) = if memo_required {
        let (memo_account, hook_accounts) = ctx
            .remaining_accounts
            .split_first()
            .ok_or_else(|| error!(ErrorCode::MemoProgramMissing))?;
        validate_memo_program_account(memo_account)?;
        (Some(memo_account.clone()), hook_accounts)
    } else {
        (None, ctx.remaining_accounts)
    };
    validate_hook_accounts(
        hook_accounts,
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
        hook_execution_accounts.extend_from_slice(hook_accounts);
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

    let (fee, seller_stable_amount) = split_stable_fee(gross_stable_amount, fee_bps)?;
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

    transfer_stock_exact(
        ctx.accounts.stock_token_program.to_account_info(),
        ctx.accounts.seller_stock_account.to_account_info(),
        ctx.accounts.stock_mint.to_account_info(),
        ctx.accounts.maker_stock_account.to_account_info(),
        ctx.accounts.seller.to_account_info(),
        hook_accounts,
        stock_amount,
        ctx.accounts.stock_mint.decimals,
        stock_uses_fee_ix,
        memo_program,
        quote_id,
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
    // Exact Input: seller debit == maker credit == stock_amount (INV-002 / AC-026).
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
            == Some(stock_amount),
        ErrorCode::UnexpectedDelta
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
pub(crate) fn close_fill_receipt(ctx: Context<crate::CloseFillReceipt>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx
            .accounts
            .fill_receipt
            .expires_at
            .saturating_add(crate::CLOSE_GRACE_SECONDS),
        ErrorCode::CloseTooEarly
    );
    require_keys_eq!(
        ctx.accounts.fill_receipt.payer,
        ctx.accounts.payer.key(),
        ErrorCode::RentPayerMismatch
    );
    Ok(())
}
