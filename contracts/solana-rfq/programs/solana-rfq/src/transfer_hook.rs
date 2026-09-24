use anchor_lang::__private::bytemuck::{Pod, Zeroable};
use anchor_lang::prelude::*;
use spl_discriminator::SplDiscriminate;
use spl_pod::{list::ListView, primitives::PodBool};
use spl_type_length_value::state::{TlvState, TlvStateBorrowed};

use crate::{AssetRegistry, ErrorCode, HookAccountMeta, MAX_HOOK_ACCOUNTS};

#[derive(SplDiscriminate)]
#[discriminator_hash_input("spl-transfer-hook-interface:execute")]
pub(crate) struct TransferHookExecuteInstruction;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub(crate) struct TransferHookExtraAccountMeta {
    pub discriminator: u8,
    pub address_config: [u8; 32],
    pub is_signer: PodBool,
    pub is_writable: PodBool,
}

#[derive(Clone, Copy)]
pub(crate) struct HookAccountObservation {
    pub(crate) key: Pubkey,
    pub(crate) owner: Pubkey,
    pub(crate) is_signer: bool,
    pub(crate) is_writable: bool,
    pub(crate) executable: bool,
}

pub(crate) fn transfer_hook_validation_address(mint: &Pubkey, hook_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], hook_program).0
}

pub(crate) fn validate_hook_account_configuration(
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
            require!(expected.len() >= 2, ErrorCode::HookAccountsMissing);
            require!(
                expected[0].key == transfer_hook_validation_address(mint, &program),
                ErrorCode::HookAccountMismatch
            );
            require!(expected[0].owner == program, ErrorCode::InvalidHookAccount);
            require!(
                !expected[0].is_signer && !expected[0].is_writable && !expected[0].executable,
                ErrorCode::InvalidHookAccount
            );
            let hook_program_account = expected
                .last()
                .ok_or_else(|| error!(ErrorCode::HookAccountsMissing))?;
            require_keys_eq!(
                hook_program_account.key,
                program,
                ErrorCode::HookAccountMismatch
            );
            require!(
                !hook_program_account.is_signer
                    && !hook_program_account.is_writable
                    && hook_program_account.executable,
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

pub(crate) fn validate_hook_account_observations(
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

pub(crate) fn observe_hook_accounts(accounts: &[AccountInfo<'_>]) -> Vec<HookAccountObservation> {
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

pub(crate) fn validate_hook_accounts(
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
        registry.hook_accounts.len().saturating_sub(2),
    )?;
    let observations = observe_hook_accounts(accounts);
    validate_hook_account_observations(&registry.hook_accounts, &observations, reserved)
}

pub(crate) fn parse_transfer_hook_extra_account_metas(
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

pub(crate) fn read_hook_validation_account_at_bootstrap(
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
                accounts.len() == expected_extra_account_count.saturating_add(2),
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
            let hook_program_account = accounts
                .last()
                .ok_or_else(|| error!(ErrorCode::HookAccountsMissing))?;
            validate_hook_program_account(hook_program_account, &program)?;
            Ok(solana_sha256_hasher::hashv(&[data.as_ref()]).to_bytes())
        }
    }
}

pub(crate) fn validate_hook_validation_account(
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
            require!(accounts.len() >= 2, ErrorCode::HookAccountsMissing);
            require!(
                accounts.len() == expected_extra_account_count.saturating_add(2),
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
            let hook_program_account = accounts
                .last()
                .ok_or_else(|| error!(ErrorCode::HookAccountsMissing))?;
            validate_hook_program_account(hook_program_account, &program)?;
            solana_sha256_hasher::hashv(&[data.as_ref()]).to_bytes()
        }
    };
    require!(
        actual_data_hash == expected_data_hash,
        ErrorCode::LiveHookMismatch
    );
    Ok(())
}

fn validate_hook_program_account(account: &AccountInfo<'_>, hook_program: &Pubkey) -> Result<()> {
    require_keys_eq!(account.key(), *hook_program, ErrorCode::HookAccountMismatch);
    require!(
        !account.is_signer && !account.is_writable && account.executable,
        ErrorCode::InvalidHookAccount
    );
    require!(
        *account.owner != Pubkey::default(),
        ErrorCode::InvalidHookAccount
    );
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) struct ResolvedHookAccountMeta {
    key: Pubkey,
    is_signer: bool,
    is_writable: bool,
}

pub(crate) fn validate_transfer_hook_execution(
    accounts: &[AccountInfo<'_>],
    hook_program: Pubkey,
    amount: u64,
) -> Result<()> {
    require!(accounts.len() >= 6, ErrorCode::HookAccountsMissing);
    let hook_program_account = accounts
        .last()
        .ok_or_else(|| error!(ErrorCode::HookAccountsMissing))?;
    validate_hook_program_account(hook_program_account, &hook_program)?;
    let validation_data = accounts[4]
        .try_borrow_data()
        .map_err(|_| error!(ErrorCode::InvalidHookValidationData))?;
    let configured_metas = parse_transfer_hook_extra_account_metas(&validation_data)?;
    require!(
        accounts.len() == 6usize.saturating_add(configured_metas.len()),
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
            &accounts[..accounts.len() - 1],
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

pub(crate) fn resolve_transfer_hook_meta(
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

pub(crate) fn derive_hook_pda(
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

pub(crate) fn unpack_hook_seeds(
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

pub(crate) fn resolve_hook_pubkey_data(
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
