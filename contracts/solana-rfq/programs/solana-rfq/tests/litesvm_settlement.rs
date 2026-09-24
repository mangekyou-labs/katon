use anchor_lang::__private::bytemuck::{Pod, Zeroable};
use anchor_lang::prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey};
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::InstructionData;
use anchor_lang::Space;
use anchor_spl::token::spl_token::state::{Account as SplAccount, AccountState, Mint};
use anchor_spl::token_interface::spl_token_2022::extension::memo_transfer::MemoTransfer;
use anchor_spl::token_interface::spl_token_2022::extension::metadata_pointer::MetadataPointer;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_fee::{
    TransferFee, TransferFeeAmount, TransferFeeConfig,
};
use anchor_spl::token_interface::spl_token_2022::extension::transfer_hook::{
    TransferHook, TransferHookAccount,
};
use anchor_spl::token_interface::spl_token_2022::extension::{
    BaseStateWithExtensions, BaseStateWithExtensionsMut, ExtensionType, StateWithExtensions,
    StateWithExtensionsMut,
};
use anchor_spl::token_interface::spl_token_2022::{self, state as spl_2022_state};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_runtime::declare_process_instruction;
use solana_rfq::{AssetRegistry, GovernanceConfig, HookAccountMeta, MakerRegistry};
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_discriminator::SplDiscriminate;
use spl_pod::{list::ListView, primitives::PodBool};
use spl_type_length_value::state::{TlvState, TlvStateBorrowed, TlvStateMut};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const STOCK_AMOUNT: u64 = 100_000;
const GROSS_STABLE_AMOUNT: u64 = 500_000;
const FEE_BPS: u16 = 10;

static TRANSFER_HOOK_EXECUTIONS: AtomicUsize = AtomicUsize::new(0);
static TRANSFER_HOOK_TEST_LOCK: Mutex<()> = Mutex::new(());

declare_process_instruction!(TestTransferHook, 1, |_invoke_context| {
    TRANSFER_HOOK_EXECUTIONS.fetch_add(1, Ordering::SeqCst);
    Ok(())
});

#[derive(SplDiscriminate)]
#[discriminator_hash_input("spl-transfer-hook-interface:execute")]
struct TransferHookExecuteInstruction;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct TransferHookExtraAccountMeta {
    discriminator: u8,
    address_config: [u8; 32],
    is_signer: PodBool,
    is_writable: PodBool,
}

fn address(key: Pubkey) -> Address {
    Address::new_from_array(key.to_bytes())
}

fn program_account<T: AccountSerialize>(state: &T) -> Account {
    let mut data = Vec::new();
    state
        .try_serialize(&mut data)
        .expect("serialize Anchor state");
    Account {
        lamports: 1_000_000_000,
        data,
        owner: address(solana_rfq::ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    token_account_with_state(mint, owner, amount, AccountState::Initialized)
}

fn token_account_with_state(
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    state: AccountState,
) -> Account {
    let mut data = vec![0; SplAccount::LEN];
    SplAccount::pack(
        SplAccount {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        },
        &mut data,
    )
    .expect("pack SPL token account");
    Account {
        lamports: 1_000_000_000,
        data,
        owner: address(anchor_spl::token::ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn mint_account(mint_authority: Pubkey) -> Account {
    let mut data = vec![0; Mint::LEN];
    Mint::pack(
        Mint {
            mint_authority: COption::Some(mint_authority),
            supply: STOCK_AMOUNT,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        },
        &mut data,
    )
    .expect("pack SPL mint");
    Account {
        lamports: 1_000_000_000,
        data,
        owner: address(anchor_spl::token::ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn token_2022_mint_account(
    mint_authority: Pubkey,
    metadata_address: Pubkey,
    older_fee_bps: u16,
    newer_fee_bps: u16,
    hook_program: Option<Pubkey>,
) -> (Account, [u8; 32]) {
    let mut extensions = vec![
        ExtensionType::MetadataPointer,
        ExtensionType::TransferFeeConfig,
    ];
    if hook_program.is_some() {
        extensions.push(ExtensionType::TransferHook);
    }
    let len = ExtensionType::try_calculate_account_len::<spl_2022_state::Mint>(&extensions)
        .expect("calculate Token-2022 mint size");
    let mut data = vec![0; len];
    let mut state = StateWithExtensionsMut::<spl_2022_state::Mint>::unpack_uninitialized(&mut data)
        .expect("unpack uninitialized Token-2022 mint");
    state.base.mint_authority = COption::Some(mint_authority);
    state.base.supply = STOCK_AMOUNT;
    state.base.decimals = 6;
    state.base.is_initialized = true;

    let metadata = state
        .init_extension::<MetadataPointer>(true)
        .expect("initialize metadata pointer");
    metadata.authority = Some(mint_authority)
        .try_into()
        .expect("convert metadata authority");
    metadata.metadata_address = Some(metadata_address)
        .try_into()
        .expect("convert metadata address");

    let transfer_fee = state
        .init_extension::<TransferFeeConfig>(true)
        .expect("initialize transfer fee config");
    transfer_fee.transfer_fee_config_authority = Some(mint_authority)
        .try_into()
        .expect("convert transfer fee authority");
    transfer_fee.withdraw_withheld_authority = Some(mint_authority)
        .try_into()
        .expect("convert withheld fee authority");
    transfer_fee.older_transfer_fee = TransferFee {
        epoch: 0u64.into(),
        maximum_fee: u64::MAX.into(),
        transfer_fee_basis_points: older_fee_bps.into(),
    };
    transfer_fee.newer_transfer_fee = TransferFee {
        epoch: 1u64.into(),
        maximum_fee: u64::MAX.into(),
        transfer_fee_basis_points: newer_fee_bps.into(),
    };
    if let Some(hook_program) = hook_program {
        let transfer_hook = state
            .init_extension::<TransferHook>(true)
            .expect("initialize transfer hook");
        transfer_hook.authority = Some(mint_authority)
            .try_into()
            .expect("convert transfer hook authority");
        transfer_hook.program_id = Some(hook_program)
            .try_into()
            .expect("convert transfer hook program");
    }

    let extension_fingerprint = solana_sha256_hasher::hashv(&[state.get_tlv_data()]).to_bytes();
    state
        .init_account_type()
        .expect("initialize Token-2022 mint account type");
    state.pack_base();

    (
        Account {
            lamports: 1_000_000_000,
            data,
            owner: address(spl_token_2022::ID),
            executable: false,
            rent_epoch: 0,
        },
        extension_fingerprint,
    )
}

fn token_2022_account(
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    with_transfer_hook: bool,
    require_incoming_memo: bool,
) -> Account {
    let mut extensions = vec![ExtensionType::TransferFeeAmount];
    if with_transfer_hook {
        extensions.push(ExtensionType::TransferHookAccount);
    }
    if require_incoming_memo {
        extensions.push(ExtensionType::MemoTransfer);
    }
    let len = ExtensionType::try_calculate_account_len::<spl_2022_state::Account>(&extensions)
        .expect("calculate Token-2022 account size");
    let mut data = vec![0; len];
    let mut state =
        StateWithExtensionsMut::<spl_2022_state::Account>::unpack_uninitialized(&mut data)
            .expect("unpack uninitialized Token-2022 account");
    state.base.mint = mint;
    state.base.owner = owner;
    state.base.amount = amount;
    state.base.state = spl_2022_state::AccountState::Initialized;
    state
        .init_extension::<TransferFeeAmount>(true)
        .expect("initialize transfer fee amount");
    if with_transfer_hook {
        state
            .init_extension::<TransferHookAccount>(true)
            .expect("initialize transfer hook account");
    }
    if require_incoming_memo {
        state
            .init_extension::<MemoTransfer>(true)
            .expect("initialize required memo extension");
        state
            .get_extension_mut::<MemoTransfer>()
            .expect("read required memo extension")
            .require_incoming_transfer_memos = true.into();
    }
    state
        .init_account_type()
        .expect("initialize Token-2022 account type");
    state.pack_base();
    Account {
        lamports: 1_000_000_000,
        data,
        owner: address(spl_token_2022::ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn transfer_hook_validation_data_without_extra_metas() -> Vec<u8> {
    transfer_hook_validation_data(&[])
}

fn transfer_hook_validation_data(metas: &[TransferHookExtraAccountMeta]) -> Vec<u8> {
    let list_size = ListView::<TransferHookExtraAccountMeta>::size_of(metas.len())
        .expect("calculate empty transfer-hook extra-meta list size");
    let mut data = vec![0; TlvStateBorrowed::get_base_len() + list_size];
    {
        let mut state = TlvStateMut::unpack(&mut data).expect("unpack validation TLV");
        let (encoded, _) = state
            .alloc::<TransferHookExecuteInstruction>(list_size, false)
            .expect("allocate transfer-hook execute TLV");
        let mut list = ListView::<TransferHookExtraAccountMeta>::init(encoded)
            .expect("initialize transfer-hook extra-meta list");
        for meta in metas {
            list.push(*meta).expect("append transfer-hook extra meta");
        }
    }
    data
}

fn state_address(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &solana_rfq::ID).0
}

#[derive(Clone, Copy)]
enum StockTokenFixture {
    Classic,
    Token2022TransferFee {
        older_fee_bps: u16,
        newer_fee_bps: u16,
        hook_program: Option<Pubkey>,
        memo_required_destination: bool,
    },
}

struct SettlementFixture {
    svm: LiteSVM,
    seller: Keypair,
    maker: Keypair,
    guardian: Keypair,
    squads_vault: Keypair,
    seller_key: Pubkey,
    maker_key: Pubkey,
    stock_mint: Pubkey,
    stock_token_program: Pubkey,
    stable_mint: Pubkey,
    seller_stock: Pubkey,
    maker_stock: Pubkey,
    maker_stable: Pubkey,
    seller_stable: Pubkey,
    fee_stable: Pubkey,
    fill_receipt: Pubkey,
    extension_fingerprint: [u8; 32],
    hook_validation_account: Option<Pubkey>,
    hook_program: Option<Pubkey>,
}

impl SettlementFixture {
    fn new(seller_stable_state: AccountState) -> Self {
        Self::new_with_stock(seller_stable_state, StockTokenFixture::Classic)
    }

    fn token_2022_fee(
        seller_stable_state: AccountState,
        older_fee_bps: u16,
        newer_fee_bps: u16,
    ) -> Self {
        Self::new_with_stock(
            seller_stable_state,
            StockTokenFixture::Token2022TransferFee {
                older_fee_bps,
                newer_fee_bps,
                hook_program: None,
                memo_required_destination: false,
            },
        )
    }

    fn token_2022_hook(seller_stable_state: AccountState, hook_program: Pubkey) -> Self {
        Self::new_with_stock(
            seller_stable_state,
            StockTokenFixture::Token2022TransferFee {
                older_fee_bps: 0,
                newer_fee_bps: 0,
                hook_program: Some(hook_program),
                memo_required_destination: false,
            },
        )
    }

    fn token_2022_memo(seller_stable_state: AccountState) -> Self {
        Self::new_with_stock(
            seller_stable_state,
            StockTokenFixture::Token2022TransferFee {
                older_fee_bps: 0,
                newer_fee_bps: 0,
                hook_program: None,
                memo_required_destination: true,
            },
        )
    }

    fn new_with_stock(
        seller_stable_state: AccountState,
        stock_token_fixture: StockTokenFixture,
    ) -> Self {
        let mut svm = LiteSVM::new();
        let program_id = address(solana_rfq::ID);
        let program_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/deploy/solana_rfq.so");
        svm.add_program_from_file(program_id, &program_path)
            .expect("load Anchor program built by `anchor build --skip-lint`");

        let seller = Keypair::new();
        let maker = Keypair::new();
        let guardian = Keypair::new();
        let squads_vault = Keypair::new();
        svm.airdrop(&seller.pubkey(), 5_000_000_000)
            .expect("fund seller rent payer");
        svm.airdrop(&maker.pubkey(), 1_000_000_000)
            .expect("fund maker");
        svm.airdrop(&guardian.pubkey(), 1_000_000_000)
            .expect("fund guardian");
        svm.airdrop(&squads_vault.pubkey(), 1_000_000_000)
            .expect("fund local governance vault");

        let seller_key = Pubkey::new_from_array(seller.pubkey().to_bytes());
        let maker_key = Pubkey::new_from_array(maker.pubkey().to_bytes());
        let stock_mint = Pubkey::new_unique();
        let stable_mint = Pubkey::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        let usdt_mint = Pubkey::from_str_const("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
        let mint_authority = Pubkey::new_unique();
        let fee_recipient = Pubkey::new_unique();
        let seller_stock = Pubkey::new_unique();
        let maker_stock = Pubkey::new_unique();
        let maker_stable = Pubkey::new_unique();
        let seller_stable = Pubkey::new_unique();
        let fee_stable = Pubkey::new_unique();
        let metadata_pointer = Pubkey::new_unique();
        let hook_program = match stock_token_fixture {
            StockTokenFixture::Classic => None,
            StockTokenFixture::Token2022TransferFee { hook_program, .. } => hook_program,
        };
        if let Some(hook_program) = hook_program {
            svm.add_builtin(address(hook_program), TestTransferHook::vm);
        }
        let hook_validation_account = hook_program.map(|program| {
            Pubkey::find_program_address(&[b"extra-account-metas", stock_mint.as_ref()], &program).0
        });
        let hook_validation_data =
            hook_program.map(|_| transfer_hook_validation_data_without_extra_metas());
        let hook_validation_data_hash = hook_validation_data.as_ref().map_or([0; 32], |data| {
            solana_sha256_hasher::hashv(&[data]).to_bytes()
        });
        let (stock_token_program, stock_mint_account, extension_fingerprint) =
            match stock_token_fixture {
                StockTokenFixture::Classic => (
                    anchor_spl::token::ID,
                    mint_account(mint_authority),
                    solana_sha256_hasher::hashv(&[&[]]).to_bytes(),
                ),
                StockTokenFixture::Token2022TransferFee {
                    older_fee_bps,
                    newer_fee_bps,
                    hook_program,
                    ..
                } => {
                    let (mint_account, fingerprint) = token_2022_mint_account(
                        mint_authority,
                        metadata_pointer,
                        older_fee_bps,
                        newer_fee_bps,
                        hook_program,
                    );
                    (spl_token_2022::ID, mint_account, fingerprint)
                }
            };
        let (seller_stock_account, maker_stock_account) = match stock_token_fixture {
            StockTokenFixture::Classic => (
                token_account(stock_mint, seller_key, STOCK_AMOUNT),
                token_account(stock_mint, maker_key, 0),
            ),
            StockTokenFixture::Token2022TransferFee {
                hook_program,
                memo_required_destination,
                ..
            } => (
                token_2022_account(
                    stock_mint,
                    seller_key,
                    STOCK_AMOUNT,
                    hook_program.is_some(),
                    false,
                ),
                token_2022_account(
                    stock_mint,
                    maker_key,
                    0,
                    hook_program.is_some(),
                    memo_required_destination,
                ),
            ),
        };

        let governance = state_address(&[b"governance"]);
        let maker_registry = state_address(&[b"makers"]);
        let asset_registry = state_address(&[b"asset", stock_mint.as_ref()]);
        let quote_id = [42; 32];
        let fill_receipt = state_address(&[b"fill", maker_key.as_ref(), &quote_id]);
        let authority_fingerprint =
            solana_sha256_hasher::hashv(&[mint_authority.as_ref()]).to_bytes();
        let governance_state = GovernanceConfig {
            squads_vault: Pubkey::new_from_array(squads_vault.pubkey().to_bytes()),
            guardian: Pubkey::new_from_array(guardian.pubkey().to_bytes()),
            program_paused: false,
            change_delay_seconds: 86_400,
            governance_version: 1,
            fee_bps: FEE_BPS,
            max_fee_bps: 25,
            max_quote_lifetime_seconds: 30,
            max_stock_input_atomic: u64::MAX,
        };
        let maker_state = MakerRegistry {
            allowlisted: vec![maker_key],
            paused: false,
            registry_version: 1,
            last_applied: None,
        };
        let asset_state = AssetRegistry {
            mint: stock_mint,
            token_program: stock_token_program,
            stable_token_program: anchor_spl::token::ID,
            stable_outputs: [stable_mint, usdt_mint],
            issuer: 0,
            metadata_pointer,
            issuer_authority: mint_authority,
            issuer_authority_fingerprint: authority_fingerprint,
            issuer_program: None,
            jit_capability_fingerprint: [0; 32],
            decimals: 6,
            extension_fingerprint,
            hook_program,
            hook_validation_data_hash,
            hook_accounts: hook_validation_account
                .zip(hook_program)
                .map(|(validation_key, hook_program)| {
                    vec![
                        HookAccountMeta {
                            key: validation_key,
                            owner: hook_program,
                            is_signer: false,
                            is_writable: false,
                            executable: false,
                        },
                        HookAccountMeta {
                            key: hook_program,
                            owner: Pubkey::from_str_const(
                                "NativeLoader1111111111111111111111111111111",
                            ),
                            is_signer: false,
                            is_writable: false,
                            executable: true,
                        },
                    ]
                })
                .unwrap_or_default(),
            enabled: true,
            paused: false,
            registry_version: 1,
        };

        let mut maker_registry_account = program_account(&maker_state);
        maker_registry_account
            .data
            .resize(8 + MakerRegistry::INIT_SPACE, 0);
        for (key, state) in [
            (governance, program_account(&governance_state)),
            (maker_registry, maker_registry_account),
            (asset_registry, program_account(&asset_state)),
        ] {
            svm.set_account(address(key), state)
                .expect("seed Anchor-owned registry state");
        }
        for (key, state) in [
            (stock_mint, stock_mint_account),
            (stable_mint, mint_account(mint_authority)),
            (seller_stock, seller_stock_account),
            (maker_stock, maker_stock_account),
            (
                maker_stable,
                token_account(stable_mint, maker_key, GROSS_STABLE_AMOUNT),
            ),
            (
                seller_stable,
                token_account_with_state(stable_mint, seller_key, 0, seller_stable_state),
            ),
            (fee_stable, token_account(stable_mint, fee_recipient, 0)),
        ] {
            svm.set_account(address(key), state)
                .expect("seed SPL token fixture account");
        }
        if let (Some(key), Some(owner), Some(data)) =
            (hook_validation_account, hook_program, hook_validation_data)
        {
            svm.set_account(
                address(key),
                Account {
                    lamports: 1_000_000_000,
                    data,
                    owner: address(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("seed Token-2022 transfer-hook validation data");
        }

        Self {
            svm,
            seller,
            maker,
            guardian,
            squads_vault,
            seller_key,
            maker_key,
            stock_mint,
            stock_token_program,
            stable_mint,
            seller_stock,
            maker_stock,
            maker_stable,
            seller_stable,
            fee_stable,
            fill_receipt,
            extension_fingerprint,
            hook_validation_account,
            hook_program,
        }
    }

    fn send_settlement(&mut self, fee_bps: u16) -> litesvm::types::TransactionResult {
        self.send_settlement_with_remaining_accounts(fee_bps, Vec::new())
    }

    fn send_settlement_with_remaining_accounts(
        &mut self,
        fee_bps: u16,
        remaining_accounts: Vec<AccountMeta>,
    ) -> litesvm::types::TransactionResult {
        self.send_settlement_with_instructions(fee_bps, remaining_accounts, Vec::new())
    }

    fn send_settlement_with_instructions(
        &mut self,
        fee_bps: u16,
        remaining_accounts: Vec<AccountMeta>,
        instructions: Vec<Instruction>,
    ) -> litesvm::types::TransactionResult {
        self.send_settlement_custom(
            fee_bps,
            remaining_accounts,
            instructions,
            [42; 32],
            -1,
            20,
            self.stock_token_program,
            self.fee_stable,
        )
    }

    fn send_settlement_custom(
        &mut self,
        fee_bps: u16,
        remaining_accounts: Vec<AccountMeta>,
        mut instructions: Vec<Instruction>,
        quote_id: [u8; 32],
        issued_at: i64,
        expiry: i64,
        stock_token_program: Pubkey,
        fee_stable: Pubkey,
    ) -> litesvm::types::TransactionResult {
        let instruction = self.settlement_instruction(
            fee_bps,
            remaining_accounts,
            quote_id,
            issued_at,
            expiry,
            stock_token_program,
            fee_stable,
        );
        instructions.push(instruction);
        let seller = &self.seller;
        let maker = &self.maker;
        Self::send_signed_instructions(&mut self.svm, &instructions, seller, &[seller, maker])
    }

    fn settlement_instruction(
        &self,
        fee_bps: u16,
        remaining_accounts: Vec<AccountMeta>,
        quote_id: [u8; 32],
        issued_at: i64,
        expiry: i64,
        stock_token_program: Pubkey,
        fee_stable: Pubkey,
    ) -> Instruction {
        let fee_recipient = SplAccount::unpack(
            &self
                .svm
                .get_account(&address(fee_stable))
                .expect("fee account exists")
                .data,
        )
        .expect("valid fee account")
        .owner;
        let governance = state_address(&[b"governance"]);
        let maker_registry = state_address(&[b"makers"]);
        let asset_registry = state_address(&[b"asset", self.stock_mint.as_ref()]);
        let fill_receipt = state_address(&[b"fill", self.maker_key.as_ref(), &quote_id]);
        let mut accounts = vec![
            AccountMeta::new(address(self.seller_key), true),
            AccountMeta::new(address(self.maker_key), true),
            AccountMeta::new(address(self.seller_stock), false),
            AccountMeta::new(address(self.maker_stock), false),
            AccountMeta::new(address(self.maker_stable), false),
            AccountMeta::new(address(self.seller_stable), false),
            AccountMeta::new(address(fee_stable), false),
            AccountMeta::new_readonly(address(fee_recipient), false),
            AccountMeta::new_readonly(address(self.stock_mint), false),
            AccountMeta::new_readonly(address(self.stable_mint), false),
            AccountMeta::new_readonly(address(stock_token_program), false),
            AccountMeta::new_readonly(address(anchor_spl::token::ID), false),
            AccountMeta::new_readonly(address(asset_registry), false),
            AccountMeta::new_readonly(address(maker_registry), false),
            AccountMeta::new_readonly(address(governance), false),
            AccountMeta::new(address(fill_receipt), false),
            AccountMeta::new_readonly(address(anchor_lang::system_program::ID), false),
        ];
        accounts.extend(remaining_accounts);
        let instruction_data = solana_rfq::instruction::SettlePrivateQuote {
            quote_id,
            issued_at,
            expiry,
            stock_amount: STOCK_AMOUNT,
            maker_min_stock_receipt: STOCK_AMOUNT,
            gross_stable_amount: GROSS_STABLE_AMOUNT,
            seller_min_stable_receipt: 499_500,
            fee_bps,
            extension_fingerprint: self.extension_fingerprint,
        }
        .data();
        Instruction {
            program_id: address(solana_rfq::ID),
            accounts,
            data: instruction_data,
        }
    }

    fn send_signed_instructions(
        svm: &mut LiteSVM,
        instructions: &[Instruction],
        fee_payer: &Keypair,
        signers: &[&Keypair],
    ) -> litesvm::types::TransactionResult {
        let blockhash = svm.latest_blockhash();
        let message =
            Message::new_with_blockhash(instructions, Some(&fee_payer.pubkey()), &blockhash);
        let transaction = Transaction::new(signers, message, blockhash);
        svm.send_transaction(transaction)
    }

    fn set_unix_timestamp(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    fn governance_state(&self) -> GovernanceConfig {
        let account = self
            .svm
            .get_account(&address(state_address(&[b"governance"])))
            .expect("governance account exists");
        let mut data = account.data.as_slice();
        GovernanceConfig::try_deserialize(&mut data).expect("decode governance account")
    }

    fn set_governance_state(&mut self, state: &GovernanceConfig) {
        self.svm
            .set_account(
                address(state_address(&[b"governance"])),
                program_account(state),
            )
            .expect("replace test governance state");
    }

    fn assert_failed_with(&self, failure: &litesvm::types::FailedTransactionMetadata, name: &str) {
        let logs = failure.meta.logs.join("\n");
        assert!(
            logs.contains(name),
            "expected {name} failure, logs:\n{logs}"
        );
    }

    fn amount(&self, key: Pubkey) -> u64 {
        let account = self
            .svm
            .get_account(&address(key))
            .expect("token account exists");
        if account.owner == address(spl_token_2022::ID) {
            StateWithExtensions::<spl_2022_state::Account>::unpack(&account.data)
                .expect("valid Token-2022 account")
                .base
                .amount
        } else {
            SplAccount::unpack(&account.data)
                .expect("valid SPL token account")
                .amount
        }
    }

    fn assert_asset_accounts_unchanged(&self) {
        assert_eq!(self.amount(self.seller_stock), STOCK_AMOUNT);
        assert_eq!(self.amount(self.maker_stock), 0);
        assert_eq!(self.amount(self.maker_stable), GROSS_STABLE_AMOUNT);
        assert_eq!(self.amount(self.seller_stable), 0);
        assert_eq!(self.amount(self.fee_stable), 0);
        assert!(self.svm.get_account(&address(self.fill_receipt)).is_none());
    }
}

#[test]
fn anchor_litesvm_settlement_executes_exact_input_and_fee_deltas() {
    let mut fixture = SettlementFixture::new(AccountState::Initialized);
    fixture
        .send_settlement(FEE_BPS)
        .expect("Anchor settlement transaction succeeds in LiteSVM");

    assert_eq!(fixture.amount(fixture.seller_stock), 0);
    assert_eq!(fixture.amount(fixture.maker_stock), STOCK_AMOUNT);
    assert_eq!(fixture.amount(fixture.maker_stable), 0);
    assert_eq!(fixture.amount(fixture.seller_stable), 499_500);
    assert_eq!(fixture.amount(fixture.fee_stable), 500);
    assert!(fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .is_some());
}

#[test]
fn anchor_litesvm_fee_above_policy_cap_fails_without_changes() {
    let mut fixture = SettlementFixture::new(AccountState::Initialized);
    let failure = fixture
        .send_settlement(26)
        .expect_err("fee above the signed and governance cap must fail");

    assert!(failure.meta.logs.join("\n").contains("FeeCapExceeded"));
    fixture.assert_asset_accounts_unchanged();
}

#[test]
fn anchor_litesvm_live_receipt_blocks_quote_replay() {
    let mut fixture = SettlementFixture::new(AccountState::Initialized);
    fixture
        .send_settlement(FEE_BPS)
        .expect("initial settlement succeeds");
    let balances = [
        fixture.amount(fixture.seller_stock),
        fixture.amount(fixture.maker_stock),
        fixture.amount(fixture.maker_stable),
        fixture.amount(fixture.seller_stable),
        fixture.amount(fixture.fee_stable),
    ];

    // Give the replay a fresh transaction signature so it reaches Anchor's
    // receipt-PDA initialization check rather than duplicate-tx rejection.
    fixture.svm.expire_blockhash();
    let failure = fixture
        .send_settlement(FEE_BPS)
        .expect_err("a live receipt prevents settlement replay");
    let logs = failure.meta.logs.join("\n");
    assert!(
        logs.contains("already in use") || logs.contains("already initialized"),
        "expected the live FillReceipt PDA to reject replay, logs:\n{logs}"
    );
    assert_eq!(
        balances,
        [
            fixture.amount(fixture.seller_stock),
            fixture.amount(fixture.maker_stock),
            fixture.amount(fixture.maker_stable),
            fixture.amount(fixture.seller_stable),
            fixture.amount(fixture.fee_stable),
        ]
    );
    assert!(fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .is_some());
}

#[test]
fn anchor_litesvm_quote_clock_boundaries_and_hard_cap_are_enforced() {
    let mut before_issue = SettlementFixture::new(AccountState::Initialized);
    before_issue.set_unix_timestamp(-2);
    let failure = before_issue
        .send_settlement(FEE_BPS)
        .expect_err("a quote is not live before its issue time");
    before_issue.assert_failed_with(&failure, "ClockOutsideQuoteWindow");
    before_issue.assert_asset_accounts_unchanged();

    let mut after_expiry = SettlementFixture::new(AccountState::Initialized);
    after_expiry.set_unix_timestamp(21);
    let failure = after_expiry
        .send_settlement(FEE_BPS)
        .expect_err("a quote is not live after its expiry");
    after_expiry.assert_failed_with(&failure, "ClockOutsideQuoteWindow");
    after_expiry.assert_asset_accounts_unchanged();

    for (timestamp, quote_id) in [(-1, [51; 32]), (20, [52; 32])] {
        let mut boundary = SettlementFixture::new(AccountState::Initialized);
        boundary.set_unix_timestamp(timestamp);
        boundary
            .send_settlement_custom(
                FEE_BPS,
                Vec::new(),
                Vec::new(),
                quote_id,
                -1,
                20,
                boundary.stock_token_program,
                boundary.fee_stable,
            )
            .expect("quote window endpoints are inclusive");
    }

    let mut over_hard_cap = SettlementFixture::new(AccountState::Initialized);
    let mut governance = over_hard_cap.governance_state();
    governance.max_quote_lifetime_seconds = 31;
    over_hard_cap.set_governance_state(&governance);
    let failure = over_hard_cap
        .send_settlement_custom(
            FEE_BPS,
            Vec::new(),
            Vec::new(),
            [53; 32],
            -1,
            30,
            over_hard_cap.stock_token_program,
            over_hard_cap.fee_stable,
        )
        .expect_err("the hard quote lifetime cap cannot be raised by registry state");
    over_hard_cap.assert_failed_with(&failure, "InvalidExpiry");
    over_hard_cap.assert_asset_accounts_unchanged();
}

#[test]
fn anchor_litesvm_guardian_pause_blocks_an_already_issued_quote() {
    let mut fixture = SettlementFixture::new(AccountState::Initialized);
    let governance = state_address(&[b"governance"]);
    let pause = Instruction {
        program_id: address(solana_rfq::ID),
        accounts: vec![
            AccountMeta::new(address(governance), false),
            AccountMeta::new_readonly(address(fixture.guardian.pubkey()), true),
        ],
        data: solana_rfq::instruction::GuardianPauseProgram {}.data(),
    };
    SettlementFixture::send_signed_instructions(
        &mut fixture.svm,
        &[pause],
        &fixture.guardian,
        &[&fixture.guardian],
    )
    .expect("guardian pause instruction succeeds");

    let failure = fixture
        .send_settlement(FEE_BPS)
        .expect_err("program pause blocks a quote signed before the pause");
    fixture.assert_failed_with(&failure, "ProgramPaused");
    fixture.assert_asset_accounts_unchanged();
}

#[test]
fn anchor_litesvm_anyone_can_close_expired_receipt_and_rent_returns_to_seller() {
    let mut fixture = SettlementFixture::new(AccountState::Initialized);
    fixture
        .send_settlement(FEE_BPS)
        .expect("settlement creates receipt funded by Seller");
    let receipt_lamports = fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .expect("receipt exists")
        .lamports;
    let seller_before_close = fixture
        .svm
        .get_balance(&address(fixture.seller_key))
        .expect("seller balance exists");
    let closer = Keypair::new();
    fixture
        .svm
        .airdrop(&closer.pubkey(), 1_000_000_000)
        .expect("fund permissionless closer");
    let close = Instruction {
        program_id: address(solana_rfq::ID),
        accounts: vec![
            AccountMeta::new(address(fixture.fill_receipt), false),
            AccountMeta::new(address(fixture.seller_key), false),
        ],
        data: solana_rfq::instruction::CloseFillReceipt {}.data(),
    };

    fixture.set_unix_timestamp(3_619);
    let failure = SettlementFixture::send_signed_instructions(
        &mut fixture.svm,
        &[close.clone()],
        &closer,
        &[&closer],
    )
    .expect_err("receipt cannot close one second before the grace boundary");
    fixture.assert_failed_with(&failure, "CloseTooEarly");
    assert!(fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .is_some());

    fixture.set_unix_timestamp(3_620);
    fixture.svm.expire_blockhash();
    SettlementFixture::send_signed_instructions(&mut fixture.svm, &[close], &closer, &[&closer])
        .expect("permissionless close succeeds at expiry plus one hour");
    assert!(fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .is_none());
    let seller_after_close = fixture
        .svm
        .get_balance(&address(fixture.seller_key))
        .expect("seller balance exists");
    assert_eq!(seller_after_close - seller_before_close, receipt_lamports);

    fixture.svm.expire_blockhash();
    let failure = fixture
        .send_settlement(FEE_BPS)
        .expect_err("the old quote cannot replay after receipt cleanup");
    fixture.assert_failed_with(&failure, "ClockOutsideQuoteWindow");
    assert!(fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .is_none());
    assert_eq!(fixture.amount(fixture.maker_stock), STOCK_AMOUNT);
}

#[test]
fn anchor_litesvm_governance_action_waits_for_delay_and_applies_exact_terms() {
    let mut fixture = SettlementFixture::new(AccountState::Initialized);
    let governance = state_address(&[b"governance"]);
    let proposal_id = [77; 32];
    let queued_change = state_address(&[b"governance-action", &proposal_id]);
    let action = solana_rfq::GovernanceAction::SetEconomics {
        fee_bps: 11,
        max_fee_bps: 25,
        max_quote_lifetime_seconds: 30,
        max_stock_input_atomic: u64::MAX,
    };
    let queue = Instruction {
        program_id: address(solana_rfq::ID),
        accounts: vec![
            AccountMeta::new_readonly(address(governance), false),
            AccountMeta::new(address(fixture.squads_vault.pubkey()), true),
            AccountMeta::new_readonly(address(governance), false),
            AccountMeta::new(address(queued_change), false),
            AccountMeta::new_readonly(address(anchor_lang::system_program::ID), false),
        ],
        data: solana_rfq::instruction::QueueGovernanceAction {
            proposal_id,
            action,
            expected_version: 1,
        }
        .data(),
    };
    SettlementFixture::send_signed_instructions(
        &mut fixture.svm,
        &[queue],
        &fixture.squads_vault,
        &[&fixture.squads_vault],
    )
    .expect("vault queues immutable economics action");

    let apply = Instruction {
        program_id: address(solana_rfq::ID),
        accounts: vec![
            AccountMeta::new(address(governance), false),
            AccountMeta::new(address(fixture.squads_vault.pubkey()), true),
            AccountMeta::new(address(governance), false),
            AccountMeta::new(address(queued_change), false),
        ],
        data: solana_rfq::instruction::ApplyGovernanceAction {}.data(),
    };
    let failure = SettlementFixture::send_signed_instructions(
        &mut fixture.svm,
        &[apply.clone()],
        &fixture.squads_vault,
        &[&fixture.squads_vault],
    )
    .expect_err("governance action cannot apply during the configured delay");
    fixture.assert_failed_with(&failure, "GovernanceDelayActive");
    assert!(fixture.svm.get_account(&address(queued_change)).is_some());

    fixture.set_unix_timestamp(86_400);
    fixture.svm.expire_blockhash();
    SettlementFixture::send_signed_instructions(
        &mut fixture.svm,
        &[apply],
        &fixture.squads_vault,
        &[&fixture.squads_vault],
    )
    .expect("vault applies queued action after the configured delay");
    let updated = fixture.governance_state();
    assert_eq!(updated.fee_bps, 11);
    assert_eq!(updated.governance_version, 2);
    assert!(fixture.svm.get_account(&address(queued_change)).is_none());
}

#[test]
fn anchor_litesvm_maker_allowlist_requires_and_records_delayed_governance_application() {
    let mut fixture = SettlementFixture::new(AccountState::Initialized);
    let governance = state_address(&[b"governance"]);
    let maker_registry = state_address(&[b"makers"]);
    let proposal_id = [78; 32];
    let queued_change = state_address(&[b"governance-action", &proposal_id]);
    let bootstrap_account = fixture
        .svm
        .get_account(&address(maker_registry))
        .expect("bootstrap maker registry exists");
    let mut bootstrap_bytes = bootstrap_account.data.as_slice();
    let bootstrap = MakerRegistry::try_deserialize(&mut bootstrap_bytes)
        .expect("decode bootstrap maker registry");
    assert_eq!(bootstrap.allowlisted, vec![fixture.maker_key]);
    assert!(
        bootstrap.last_applied.is_none(),
        "bootstrap state has no governance proof"
    );

    let queue = Instruction {
        program_id: address(solana_rfq::ID),
        accounts: vec![
            AccountMeta::new_readonly(address(governance), false),
            AccountMeta::new(address(fixture.squads_vault.pubkey()), true),
            AccountMeta::new_readonly(address(maker_registry), false),
            AccountMeta::new(address(queued_change), false),
            AccountMeta::new_readonly(address(anchor_lang::system_program::ID), false),
        ],
        data: solana_rfq::instruction::QueueGovernanceAction {
            proposal_id,
            action: solana_rfq::GovernanceAction::SetMakers {
                allowlisted: vec![fixture.maker_key],
                paused: false,
            },
            expected_version: 1,
        }
        .data(),
    };
    SettlementFixture::send_signed_instructions(
        &mut fixture.svm,
        &[queue],
        &fixture.squads_vault,
        &[&fixture.squads_vault],
    )
    .expect("governance vault queues exact maker policy");

    let apply = Instruction {
        program_id: address(solana_rfq::ID),
        accounts: vec![
            AccountMeta::new(address(governance), false),
            AccountMeta::new(address(fixture.squads_vault.pubkey()), true),
            AccountMeta::new(address(maker_registry), false),
            AccountMeta::new(address(queued_change), false),
        ],
        data: solana_rfq::instruction::ApplyGovernanceAction {}.data(),
    };
    let failure = SettlementFixture::send_signed_instructions(
        &mut fixture.svm,
        &[apply.clone()],
        &fixture.squads_vault,
        &[&fixture.squads_vault],
    )
    .expect_err("Maker policy cannot apply before its delay expires");
    fixture.assert_failed_with(&failure, "GovernanceDelayActive");

    fixture.set_unix_timestamp(86_400);
    fixture.svm.expire_blockhash();
    SettlementFixture::send_signed_instructions(
        &mut fixture.svm,
        &[apply],
        &fixture.squads_vault,
        &[&fixture.squads_vault],
    )
    .expect("governance vault applies exact Maker policy after the delay");

    let updated_account = fixture
        .svm
        .get_account(&address(maker_registry))
        .expect("applied maker registry exists");
    let mut updated_bytes = updated_account.data.as_slice();
    let updated =
        MakerRegistry::try_deserialize(&mut updated_bytes).expect("decode applied maker registry");
    let applied = updated
        .last_applied
        .expect("delayed action provenance is persisted");
    assert_eq!(updated.allowlisted, vec![fixture.maker_key]);
    assert!(!updated.paused);
    assert_eq!(updated.registry_version, 2);
    assert_eq!(applied.proposal_id, proposal_id);
    assert_ne!(applied.payload_hash, [0; 32]);
    assert_eq!(applied.target, maker_registry);
    assert_eq!(applied.expected_version, 1);
    assert_eq!(
        applied.proposing_vault,
        Pubkey::new_from_array(fixture.squads_vault.pubkey().to_bytes())
    );
    assert_eq!(applied.created_at, 0);
    assert_eq!(applied.apply_after, 86_400);
    assert_eq!(applied.applied_at, 86_400);
    assert_eq!(applied.allowlisted, vec![fixture.maker_key]);
    assert!(!applied.paused);
    assert_eq!(applied.registry_version, 2);
}

#[test]
fn anchor_litesvm_rejects_wrong_program_unexpected_accounts_and_duplicate_destinations() {
    let mut wrong_program = SettlementFixture::new(AccountState::Initialized);
    let failure = wrong_program
        .send_settlement_custom(
            FEE_BPS,
            Vec::new(),
            Vec::new(),
            [81; 32],
            -1,
            20,
            spl_token_2022::ID,
            wrong_program.fee_stable,
        )
        .expect_err("stock token program must match the registry");
    wrong_program.assert_failed_with(&failure, "TokenProgramMismatch");
    wrong_program.assert_asset_accounts_unchanged();

    let mut unexpected_account = SettlementFixture::new(AccountState::Initialized);
    let failure = unexpected_account
        .send_settlement_with_remaining_accounts(
            FEE_BPS,
            vec![AccountMeta::new_readonly(
                address(anchor_lang::system_program::ID),
                false,
            )],
        )
        .expect_err("non-hook assets reject unexpected CPI accounts");
    unexpected_account.assert_failed_with(&failure, "UnexpectedHookAccounts");
    unexpected_account.assert_asset_accounts_unchanged();

    let mut duplicate_destination = SettlementFixture::new(AccountState::Initialized);
    let failure = duplicate_destination
        .send_settlement_custom(
            FEE_BPS,
            Vec::new(),
            Vec::new(),
            [82; 32],
            -1,
            20,
            duplicate_destination.stock_token_program,
            duplicate_destination.maker_stable,
        )
        .expect_err("mutable economic token accounts must be pairwise distinct");
    duplicate_destination.assert_failed_with(&failure, "DuplicateMutableAccount");
    duplicate_destination.assert_asset_accounts_unchanged();
}

#[test]
fn anchor_litesvm_malformed_hook_validation_data_fails_before_token_cpis() {
    let _guard = TRANSFER_HOOK_TEST_LOCK.lock().expect("hook test lock");
    let hook_program = Pubkey::new_unique();
    let mut fixture = SettlementFixture::token_2022_hook(AccountState::Initialized, hook_program);
    let validation_account = fixture
        .hook_validation_account
        .expect("hook fixture provides validation account");
    let mut account = fixture
        .svm
        .get_account(&address(validation_account))
        .expect("hook validation account exists");
    account.data = vec![1, 2, 3];
    fixture
        .svm
        .set_account(address(validation_account), account)
        .expect("replace validation data with malformed TLV");
    let calls_before = TRANSFER_HOOK_EXECUTIONS.load(Ordering::SeqCst);
    let failure = fixture
        .send_settlement_with_remaining_accounts(
            FEE_BPS,
            vec![
                AccountMeta::new_readonly(address(validation_account), false),
                AccountMeta::new_readonly(address(hook_program), false),
            ],
        )
        .expect_err("malformed hook TLV is rejected before transfer CPI");
    fixture.assert_failed_with(&failure, "InvalidHookValidationData");
    assert_eq!(
        TRANSFER_HOOK_EXECUTIONS.load(Ordering::SeqCst),
        calls_before,
        "malformed hook configuration never executes the hook program"
    );
    fixture.assert_asset_accounts_unchanged();
}

#[test]
fn anchor_litesvm_malformed_hook_seed_data_fails_before_token_cpis() {
    let _guard = TRANSFER_HOOK_TEST_LOCK.lock().expect("hook test lock");
    let hook_program = Pubkey::new_unique();
    let mut fixture = SettlementFixture::token_2022_hook(AccountState::Initialized, hook_program);
    let validation_account = fixture
        .hook_validation_account
        .expect("hook fixture provides validation account");
    let extra_account = Pubkey::new_unique();
    let mut address_config = [0; 32];
    address_config[0] = 1;
    address_config[1] = u8::MAX;
    let validation_data = transfer_hook_validation_data(&[TransferHookExtraAccountMeta {
        discriminator: 1,
        address_config,
        is_signer: PodBool::from(false),
        is_writable: PodBool::from(false),
    }]);

    let mut registry_account = fixture
        .svm
        .get_account(&address(state_address(&[
            b"asset",
            fixture.stock_mint.as_ref(),
        ])))
        .expect("asset registry exists");
    let mut registry_bytes = registry_account.data.as_slice();
    let mut registry =
        AssetRegistry::try_deserialize(&mut registry_bytes).expect("decode asset registry");
    registry.hook_validation_data_hash =
        solana_sha256_hasher::hashv(&[&validation_data]).to_bytes();
    registry.hook_accounts.insert(
        1,
        HookAccountMeta {
            key: extra_account,
            owner: hook_program,
            is_signer: false,
            is_writable: false,
            executable: false,
        },
    );
    registry_account = program_account(&registry);
    fixture
        .svm
        .set_account(
            address(state_address(&[b"asset", fixture.stock_mint.as_ref()])),
            registry_account,
        )
        .expect("update registry with the malformed-seed account meta");

    let mut validation_account_state = fixture
        .svm
        .get_account(&address(validation_account))
        .expect("hook validation account exists");
    validation_account_state.data = validation_data;
    fixture
        .svm
        .set_account(address(validation_account), validation_account_state)
        .expect("update hook TLV with the malformed seed encoding");
    fixture
        .svm
        .set_account(
            address(extra_account),
            Account {
                lamports: 1_000_000,
                data: Vec::new(),
                owner: address(hook_program),
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("install the registered extra account");

    let calls_before = TRANSFER_HOOK_EXECUTIONS.load(Ordering::SeqCst);
    let failure = fixture
        .send_settlement_with_remaining_accounts(
            FEE_BPS,
            vec![
                AccountMeta::new_readonly(address(validation_account), false),
                AccountMeta::new_readonly(address(extra_account), false),
                AccountMeta::new_readonly(address(hook_program), false),
            ],
        )
        .expect_err("invalid hook PDA seed encoding must fail closed");
    fixture.assert_failed_with(&failure, "InvalidHookValidationData");
    assert_eq!(
        TRANSFER_HOOK_EXECUTIONS.load(Ordering::SeqCst),
        calls_before,
        "malformed extra-meta seeds never execute the hook program"
    );
    fixture.assert_asset_accounts_unchanged();
}

#[test]
fn anchor_litesvm_transfer_hook_cannot_reuse_a_reserved_settlement_account() {
    let _guard = TRANSFER_HOOK_TEST_LOCK.lock().expect("hook test lock");
    let hook_program = Pubkey::new_unique();
    let mut fixture = SettlementFixture::token_2022_hook(AccountState::Initialized, hook_program);
    let validation_account = fixture
        .hook_validation_account
        .expect("hook fixture provides validation account");
    let validation_data = transfer_hook_validation_data(&[TransferHookExtraAccountMeta {
        discriminator: 1,
        address_config: [0; 32],
        is_signer: PodBool::from(false),
        is_writable: PodBool::from(false),
    }]);
    let asset_registry = state_address(&[b"asset", fixture.stock_mint.as_ref()]);
    let mut registry_account = fixture
        .svm
        .get_account(&address(asset_registry))
        .expect("asset registry exists");
    let mut registry_bytes = registry_account.data.as_slice();
    let mut registry =
        AssetRegistry::try_deserialize(&mut registry_bytes).expect("decode asset registry");
    registry.hook_validation_data_hash =
        solana_sha256_hasher::hashv(&[&validation_data]).to_bytes();
    registry.hook_accounts.insert(
        1,
        HookAccountMeta {
            key: fixture.seller_stock,
            owner: hook_program,
            is_signer: false,
            is_writable: false,
            executable: false,
        },
    );
    registry_account = program_account(&registry);
    fixture
        .svm
        .set_account(address(asset_registry), registry_account)
        .expect("update test registry with a reserved hook meta");

    let mut validation_account_state = fixture
        .svm
        .get_account(&address(validation_account))
        .expect("hook validation account exists");
    validation_account_state.data = validation_data;
    fixture
        .svm
        .set_account(address(validation_account), validation_account_state)
        .expect("update hook TLV to declare reserved account");

    let calls_before = TRANSFER_HOOK_EXECUTIONS.load(Ordering::SeqCst);
    let failure = fixture
        .send_settlement_with_remaining_accounts(
            FEE_BPS,
            vec![
                AccountMeta::new_readonly(address(validation_account), false),
                AccountMeta::new_readonly(address(fixture.seller_stock), false),
                AccountMeta::new_readonly(address(hook_program), false),
            ],
        )
        .expect_err("hook cannot alias a reserved settlement account");
    fixture.assert_failed_with(&failure, "InvalidHookAccount");
    assert_eq!(
        TRANSFER_HOOK_EXECUTIONS.load(Ordering::SeqCst),
        calls_before,
        "reserved account rejection happens before hook execution"
    );
    fixture.assert_asset_accounts_unchanged();
}

#[test]
fn anchor_litesvm_later_cpi_failure_rolls_back_stock_and_receipt() {
    let mut fixture = SettlementFixture::new(AccountState::Frozen);
    let failure = fixture
        .send_settlement(FEE_BPS)
        .expect_err("frozen stablecoin destination must fail its token CPI");

    let logs = failure.meta.logs.join("\n");
    assert!(
        logs.to_lowercase().contains("frozen"),
        "expected frozen CPI failure, logs:\n{logs}"
    );
    fixture.assert_asset_accounts_unchanged();
}

#[test]
fn anchor_litesvm_token_2022_zero_fee_executes_exact_input_and_fee_deltas() {
    let mut fixture = SettlementFixture::token_2022_fee(AccountState::Initialized, 0, 0);
    fixture
        .send_settlement(FEE_BPS)
        .expect("zero-fee Token-2022 settlement succeeds through transfer_checked_with_fee");

    assert_eq!(fixture.amount(fixture.seller_stock), 0);
    assert_eq!(fixture.amount(fixture.maker_stock), STOCK_AMOUNT);
    assert_eq!(fixture.amount(fixture.maker_stable), 0);
    assert_eq!(fixture.amount(fixture.seller_stable), 499_500);
    assert_eq!(fixture.amount(fixture.fee_stable), 500);
    assert!(fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .is_some());
}

#[test]
fn anchor_litesvm_token_2022_requires_a_preceding_memo_for_maker_stock() {
    let mut fixture = SettlementFixture::token_2022_memo(AccountState::Initialized);
    let failure = fixture
        .send_settlement(FEE_BPS)
        .expect_err("memo-required destination requires the canonical Memo program account");

    let logs = failure.meta.logs.join("\n");
    assert!(
        logs.contains("MemoProgramMissing"),
        "expected missing Memo program account validation, logs:\n{logs}"
    );
    fixture.assert_asset_accounts_unchanged();

    let memo_program = Pubkey::from_str_const("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");
    let failure = fixture
        .send_settlement_with_remaining_accounts(
            FEE_BPS,
            vec![AccountMeta::new_readonly(
                address(anchor_lang::system_program::ID),
                false,
            )],
        )
        .expect_err("only the canonical Memo program can authorize the memo path");
    fixture.assert_failed_with(&failure, "InvalidMemoProgram");
    fixture.assert_asset_accounts_unchanged();

    let settlement = fixture.settlement_instruction(
        FEE_BPS,
        vec![AccountMeta::new_readonly(address(memo_program), false)],
        [42; 32],
        -1,
        20,
        fixture.stock_token_program,
        fixture.fee_stable,
    );
    let blockhash = fixture.svm.latest_blockhash();
    let message =
        Message::new_with_blockhash(&[settlement], Some(&fixture.seller.pubkey()), &blockhash);
    let message_account_keys = message.account_keys.clone();
    let transaction = Transaction::new(&[&fixture.seller, &fixture.maker], message, blockhash);
    let success = fixture
        .svm
        .send_transaction(transaction)
        .expect("settlement invokes the canonical Memo program immediately before Token-2022");
    let logs = success.logs.join("\n");
    let memo_invocation = logs
        .find("Program Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo invoke [2]")
        .expect("settlement issued an inner Memo CPI");
    let token_transfer = logs
        .find("Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]")
        .expect("settlement issued a Token-2022 CPI");
    assert!(
        memo_invocation < token_transfer,
        "memo CPI precedes the transfer CPI"
    );
    assert_eq!(
        logs[memo_invocation..token_transfer]
            .matches("invoke [2]")
            .count(),
        1,
        "the memo CPI is immediately before the Token-2022 transfer CPI"
    );
    let inner = success
        .inner_instructions
        .first()
        .expect("settlement instruction has inner CPI trace");
    let memo_position = inner
        .iter()
        .position(|inner_ix| {
            message_account_keys[usize::from(inner_ix.instruction.program_id_index)]
                == address(memo_program)
        })
        .expect("inner instruction list records the Memo CPI");
    let stock_transfer_position = inner
        .iter()
        .position(|inner_ix| {
            message_account_keys[usize::from(inner_ix.instruction.program_id_index)]
                == address(spl_token_2022::ID)
        })
        .expect("inner instruction list records the Token-2022 transfer CPI");
    assert_eq!(
        stock_transfer_position,
        memo_position + 1,
        "Memo is the immediately preceding CPI"
    );
    assert_eq!(
        inner[memo_position].instruction.data,
        format!("Katon RFQ settlement {}", "2a".repeat(32)).into_bytes(),
        "Memo CPI data binds the transfer to the quote ID"
    );

    assert_eq!(fixture.amount(fixture.seller_stock), 0);
    assert_eq!(fixture.amount(fixture.maker_stock), STOCK_AMOUNT);
    assert_eq!(fixture.amount(fixture.maker_stable), 0);
    assert_eq!(fixture.amount(fixture.seller_stable), 499_500);
    assert_eq!(fixture.amount(fixture.fee_stable), 500);
    assert!(fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .is_some());
}

#[test]
fn anchor_litesvm_token_2022_rejects_current_and_scheduled_transfer_fees() {
    for (older_fee_bps, newer_fee_bps) in [(1, 0), (0, 1)] {
        let mut fixture = SettlementFixture::token_2022_fee(
            AccountState::Initialized,
            older_fee_bps,
            newer_fee_bps,
        );
        let failure = fixture
            .send_settlement(FEE_BPS)
            .expect_err("nonzero current or scheduled transfer fee must fail closed");

        let logs = failure.meta.logs.join("\n");
        assert!(
            logs.contains("NonzeroTransferFee"),
            "expected nonzero fee validation for older={older_fee_bps}, newer={newer_fee_bps}, logs:\n{logs}"
        );
        fixture.assert_asset_accounts_unchanged();
    }
}

#[test]
fn anchor_litesvm_token_2022_executes_registered_transfer_hook() {
    let _guard = TRANSFER_HOOK_TEST_LOCK.lock().expect("hook test lock");
    let hook_program = Pubkey::new_unique();
    let mut fixture = SettlementFixture::token_2022_hook(AccountState::Initialized, hook_program);
    let hook_validation_account = fixture
        .hook_validation_account
        .expect("hook fixture provides validation account");
    let calls_before = TRANSFER_HOOK_EXECUTIONS.load(Ordering::SeqCst);
    fixture
        .send_settlement_with_remaining_accounts(
            FEE_BPS,
            vec![
                AccountMeta::new_readonly(address(hook_validation_account), false),
                AccountMeta::new_readonly(
                    address(fixture.hook_program.expect("hook fixture has a program")),
                    false,
                ),
            ],
        )
        .expect("Token-2022 settlement invokes the registered transfer hook");

    assert_eq!(
        TRANSFER_HOOK_EXECUTIONS.load(Ordering::SeqCst),
        calls_before + 1,
        "the transfer-hook program runs once for the stock CPI"
    );
    assert_eq!(fixture.amount(fixture.seller_stock), 0);
    assert_eq!(fixture.amount(fixture.maker_stock), STOCK_AMOUNT);
    assert_eq!(fixture.amount(fixture.maker_stable), 0);
    assert_eq!(fixture.amount(fixture.seller_stable), 499_500);
    assert_eq!(fixture.amount(fixture.fee_stable), 500);
    assert!(fixture
        .svm
        .get_account(&address(fixture.fill_receipt))
        .is_some());
}
