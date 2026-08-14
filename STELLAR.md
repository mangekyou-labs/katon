# STELLAR.md: Stellar / Soroban Development Reference

Curated engineering reference for building on **Stellar** (classic) and **Soroban** (smart
contracts). Distilled from the official docs at `developers.stellar.org/docs/build` (Introduction →
Securing web-based projects, read in full). **Auto-loaded every session** via an `@STELLAR.md`
import in [CLAUDE.md](CLAUDE.md). Read this before doing Stellar work; it exists so we don't
rediscover the primitives, signatures, and traps each time.

> Scope note: this is the *general* Stellar/Soroban reference. Repo-specific status, file map, and
> hard-won local gotchas live in [CLAUDE.md](CLAUDE.md). When they disagree, CLAUDE.md wins for
> this project. Versions here track soroban-sdk 26 / Stellar CLI 27 / stellar-sdk 16 (this repo's
> pins). The deep-dive skills (`soroban`, `dapp`, `data`, `standards`, `stellar-dev:*`) are the
> on-demand companions to this file.

---

## 0. Read-first invariants (Trust OTC security boundary)

These are the rules that break signatures or funds if violated. Everything in §3 exists to justify
them.

1. **Both maker and taker sign `Address`-credential auth entries** (never `SourceAccount`) over
   **identical, deterministic** `fill` args. The submit is permissionless, so neither party is the
   tx source; their auth must be a real signature, not source-account-implied.
2. **`fillCanonicalArgs` must be deterministic**: derive `expiration` from `order.expiration`,
   never `Date.now()`; never reorder args or change numeric encodings. The exact args are hashed
   into both signatures (§3.6); any drift invalidates them and `fill` reverts.
3. **Real submit uses an enforcing-mode simulation with both signed entries pre-attached**: never
   mock-auth for a real submission. Pre-attached auth → correct footprint, and the host validates
   the signatures during simulation (tamper surfaces as a simulation error).
4. **`require_auth()` over the full args** (not `require_auth_for_args` with a subset) is the
   tamper-proofing: a `fill` with altered amounts has no valid signature.
5. **Replay/staleness are layered:** host nonce (per-signature) + `Filled(order_id)` storage key
   (per-order double-fill) + `signature_expiration_ledger` (signature lifetime) + `order.expiration`
   (business deadline, checked via `env.ledger().timestamp()`). Keep all four.
6. Amounts are **`i128` in base units** = display × 10^7 (7 decimals for classic assets / SACs).
7. Token SAC ids are **derived** (`Asset.contractId(passphrase)`), never invented; only
   `OTC_CONTRACT_ID` is hardcoded.

---

## 1. Platform model & toolchain

### What Soroban is

Rust contracts compiled to **WebAssembly** (`wasm32v1-none`), invoked on-chain via
`InvokeHostFunctionOp`. Runs `no_std`: narrow Rust subset, no std lib, most third-party crates
incompatible; use `soroban-sdk` for storage, crypto (hashing / sig verification), cross-contract
calls. Contracts **cannot** touch SDEX, claimable balances, or sponsorships and are exempt from
base-reserve minimums; they **can** authenticate accounts, read source-account context, and move
Stellar assets via the built-in **Stellar Asset Contract (SAC)**, which preserves issuer flags
(`AUTH_REQUIRED`, `AUTH_REVOCABLE`, `CLAWBACK`). Prefer issuing tokens as classic assets (via SAC)
for interop + performance.

### Toolchain

```bash
# Rust ≥ 1.84 for the wasm32v1-none target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh && rustup update stable
rustup target add wasm32v1-none          # MUST re-add after every `rustup update`

# Stellar CLI (v27): pick one
brew install stellar-cli
cargo install --locked stellar-cli@27.0.0
winget install --id Stellar.StellarCLI --version 27.0.0
source <(stellar completion --shell zsh) # autocomplete
```

**Trap:** the wasm target is **`wasm32v1-none`, NOT `wasm32-unknown-unknown`**: soroban-sdk 26
hard-rejects the latter (reference-types / multi-value). Reinstall the target after any toolchain
update.

### Network & identity

```bash
stellar keys generate alice --network testnet --fund   # gen + Friendbot-fund; used as --source-account
```

### Contract crate anatomy

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, contractmeta, vec, Env, String, Vec};

contractmeta!(key = "Description", val = "One-line contract description");  // → wasm custom section

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    // First arg typically Env. Fn names ≤ 32 chars. Args cannot be references.
    pub fn hello(env: Env, to: String) -> Vec<String> {
        vec![&env, String::from_str(&env, "Hello"), to]
    }
}
mod test;
```

The SDK auto-generates a `ContractClient` (name = `<Struct>Client`) for tests and TS bindings.

**Cargo.toml (workspace root)**: the `[profile.release]` block is critical (64KB wasm cap):

```toml
[workspace]
resolver = "2"
members = ["contracts/*"]

[workspace.dependencies]
soroban-sdk = "26"

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
```

**Per-contract:**
```toml
[lib]
crate-type = ["cdylib"]   # required to emit wasm; ["cdylib","rlib"] if also fuzzing/importing
doctest = false

[dependencies]
soroban-sdk = { workspace = true }
[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }   # testutils in dev only
```

### Build / test / deploy / invoke

```bash
cargo test                                                     # unit tests against the real host Env
stellar contract build                                         # → target/wasm32v1-none/release/<name>.wasm
stellar contract optimize --wasm target/.../<name>.wasm

# Deploy (single-step)
stellar contract deploy --wasm target/.../x.wasm \
  --source-account alice --network testnet --alias x           # → prints C… id

# Or upload-then-instantiate ("install" = store bytecode once by hash; many instances share it)
stellar contract upload --wasm target/.../x.wasm --source-account alice --network testnet   # → wasm hash
stellar contract deploy --wasm-hash <HASH> --source-account alice --network testnet --alias x

# Invoke ('--' separates CLI flags from contract args; read-only calls auto-simulate for free)
stellar contract invoke --id <C… | alias> --source-account alice --network testnet \
  -- hello --to RPC
```

`stellar contract init <dir>` scaffolds a workspace + a frontend package that generates TS bindings.

---

## 2. Contract programming model

### Storage tiers (choose deliberately)

All three share `set` / `get` / `has` / `remove` / `extend_ttl` / `get_ttl` off `env.storage()`.

| Tier | Accessor | Cost | On TTL expiry | Use for |
|------|----------|------|---------------|---------|
| **Instance** | `env.storage().instance()` | mid | archived (restorable); TTL tied to the contract instance, auto-loaded every call | small global config (admin, token pair); keep tiny |
| **Persistent** | `env.storage().persistent()` | most | **archived → restorable** via `RestoreFootprintOp` | balances, per-order/per-user data that must survive |
| **Temporary** | `env.storage().temporary()` | cheapest | **deleted forever** (get → None), not restorable | replaceable data: oracle feeds, sessions, rate-limit epochs |

**Rules:** keep instance storage small (every key is read on every invocation). **Never rely on a
temporary entry expiring for security**: anyone can extend its TTL; encode time bounds in the data
and check them. Keys are usually `Symbol` (≤32 chars, `[a-zA-Z0-9_]`); `symbol_short!` for ≤9-char
constants, `Symbol::new(&env, "…")` at runtime. Namespace state with a `#[contracttype] enum
DataKey { Counter(Address), Filled(u64) … }`. A contract can only touch its own storage; a
type-mismatch on `get` panics at `unwrap`.

```rust
const COUNTER: Symbol = symbol_short!("COUNTER");
pub fn increment(env: Env) -> u32 {
    let mut c: u32 = env.storage().instance().get(&COUNTER).unwrap_or(0);
    c += 1;
    env.storage().instance().set(&COUNTER, &c);
    env.storage().instance().extend_ttl(50, 100);   // (threshold, extend_to) in ledgers
    c
}
```

### TTL / state archival

Every entry has a **live-until ledger** (TTL), measured from current `sequence_number` (the count
excludes the current ledger, so a min-500 entry reports `499`). `extend_ttl(threshold, extend_to)`:
only extends if remaining TTL < `threshold`, bumping live-until to `extend_to` ledgers ahead
(capped at `max_entry_ttl`; no-op if already higher). Persistent + instance entries past TTL are
**archived** (recoverable); temporary entries are **evicted permanently**. Protocol 23+ auto-restores
archived persistent entries that appear in a tx footprint; the manual `RestoreFootprintOp` path
remains for pre-emptive restore. (JS restore/extend flow → §6.)

### Custom types / errors / events

```rust
#[contracttype]                                    // usable as arg, return, storage key/value
#[derive(Clone)]
pub struct State { pub count: u32, pub last: u32 }
#[contracttype] pub enum DataKey { Counter(Address), Filled(u64) }  // only unit/single-value variants

#[contracterror]                                   // must be #[repr(u32)] + Copy; NOT storable
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error { LimitReached = 1, NotAuthorized = 2 }
// abort + roll back all ledger changes:
panic_with_error!(&env, Error::LimitReached);
// or return Result<T, Error> so callers see the code; XDR form { "error": { "contractError": 1 } }

#[contractevent(topics = ["transfer"], data_format = "vec")]   // v23 (Whisk) macro syntax
pub struct Transfer { #[topic] from: Address, #[topic] to: Address, amount: i128 }
Transfer { from, to, amount }.publish(&env);       // struct name is default topic if `topics` omitted
```

**Convention:** most of the ecosystem assumes functions **don't** return `Result`; prefer
`panic_with_error!` unless callers need to branch on the code. Events are **discarded if the
invocation panics/errors/exhausts budget**: only emitted on success. Legacy
`env.events().publish((t1,t2), data)` still works.

### Logging

```rust
log!(&env, "value {}", x);   // compiled only when debug-assertions on; NOT visible on-chain / to dapps
```
Build with logs: a `[profile.release-with-logs]` (`inherits="release"`, `debug-assertions=true`) +
`stellar contract build --profile release-with-logs`. Use **events** for observable data.

### Cross-contract calls

```rust
mod contract_a { soroban_sdk::contractimport!(file = "../a/target/wasm32v1-none/release/a.wasm"); }
let client = contract_a::Client::new(&env, &contract);   // typed; args passed by reference
let n = client.add(&x, &y);                              // panics on callee error
// fallible: client.try_add(&x, &y) -> Result<Result<T, ConvErr>, Result<Error, Status>>
```
Callee must be **built first** (wasm imported at compile time); wrap `contractimport!` in a `mod` to
avoid type collisions. Auth propagates through the chain: sub-invocation auth must be covered by
the signed auth-entry tree (§3.3).

### Deployer / factory & upgrades

```rust
// Factory: upload wasm first (env.deployer().upload_contract_wasm(...) → hash), then:
env.deployer().with_address(deployer, salt).deploy_v2(wasm_hash, constructor_args);  // atomic deploy+ctor
// Address is deterministic from (deployer, salt) → same salt cannot redeploy.

// In-place upgrade (address preserved; upload new wasm first):
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
    let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
    admin.require_auth();
    env.deployer().update_current_contract_wasm(new_wasm_hash);   // SYSTEM event old/new executable
}
```
Upgrades do **not** re-run `__constructor` or migrate storage; handle new keys/schema explicitly
(§ storage migration below).

### Storage migration across upgrades

Reading a changed struct with the new type **traps in the host** (`Error(Object, UnexpectedSize)`)
*before* Rust sees it, so `try_from_val` can't fall back. Store the version explicitly:

```rust
#[contracttype] pub enum Data { V1(DataV1), V2(DataV2) }          // versioned-enum pattern (recommended)
impl Data { pub fn into_v2(self) -> DataV2 { match self {
    Data::V1(v1) => DataV2 { a: v1.a, b: v1.b, c: None }, Data::V2(v2) => v2 } } }
pub fn read(e: Env, id: u32) -> Option<DataV2> {                  // lazy migration: convert on read,
    let d: Data = e.storage().persistent().get(&DataKey::Data(id))?; Some(d.into_v2()) }
pub fn write(e: Env, id: u32, d: DataV2) {                        // always write the current variant
    e.storage().persistent().set(&DataKey::Data(id), &Data::V2(d)); }
```
Never delete a version branch while old entries may exist: they trap on access. Prefer lazy over
eager migration (eager hits instruction/ledger limits).

### Type conversions (cheat-sheet)

```rust
// Rust
address.to_string();  Address::from_string(&sk);  Address::from_str(&env, "G…"); // tests
address.to_xdr(&env); Address::from_xdr(&env, &bytes); Address::from_string_bytes(&bytes);
let a: [u8;32] = bytesn.into();   String::from(bytes);   Val::from(x);  x.to_val();  T::try_from_val(&env,&val);
```
```javascript
// JS (@stellar/stellar-sdk)
Address.fromString("G…"|"C…").toScVal();  Address.fromScVal(v);  Address.fromScAddress(a).toString();
nativeToScVal(1000000000n, { type: "i128" });  nativeToScVal("s", { type: "string" });  scValToNative(v);
StrKey.encodeContract(buf);   new Asset(code, issuer).contractId(passphrase);   // SAC id
```
Strkey (SEP-23): accounts `G…`, contracts `C…`, muxed `M…`.

### Fees & cost

Soroban resource fee = CPU instructions + read/write bytes + #ledger entries + TTL/rent + events/
return size + tx bandwidth. Read the floor from simulation (`minResourceFee`, `cost` breakdown).
Reduce cost: accumulate mutations and write **once** (never write in a loop); batch external
transfers; emit events instead of storing data not needed on-chain; key entries per-user for O(1)
access; pick the cheapest viable tier (temporary < instance < persistent). Measure:
`stellar contract invoke … --cost -- <fn>`.

---

## 3. Authorization framework (CRITICAL)

The security boundary. Each party signs a `SorobanAuthorizationEntry` over the **exact** invocation
args; a permissionless submitter carries the entries and cannot alter the deal.

### 3.1 The model

`require_auth()` / `require_auth_for_args()` are called **inside the contract** on an `Address`.
They don't verify anything themselves; they instruct the **host** to require a matching, valid
authorization before proceeding. The host is the enforcer.

- `address.require_auth()`: authorizes the current call with **ALL** its args (contract + fn name +
  full args). **This is what `fill` uses** (`maker.require_auth()` + `taker.require_auth()`).
- `address.require_auth_for_args(args.into_val(&env))`: authorizes an explicit/subset arg list.
  Use only when you deliberately want to sign fewer values. **Don't use for `fill`**: we want the
  signature to bind every amount.
- Contract → sub-contract calls are **implicitly authorized by the calling contract**. But if a
  sub-call does `require_auth` for a *different* address (e.g. SAC `transfer` requiring the token
  holder), that address needs its own authorization covering the sub-invocation.

### 3.2 `SorobanAuthorizationEntry` XDR (one per authorizing address)

```
SorobanAuthorizationEntry {
  credentials: SorobanCredentials,            // Address(...) | SourceAccount
  root_invocation: SorobanAuthorizedInvocation {
    function: ContractFn(InvokeContractArgs { contract_address, function_name, args }),  // exact args
    sub_invocations: [ SorobanAuthorizedInvocation … ],   // nested tree (e.g. SAC transfers)
  },
}
```

**Credentials (the central distinction):**
- **`Address(SorobanAddressCredentials { address, nonce: i64, signature_expiration_ledger: u32,
  signature: ScVal })`**: the general case; a real cryptographic signature. Off-chain AirSwap-style
  signing produces this. **Both maker and taker use Address credentials** (they aren't the tx source).
- **`SourceAccount`**, an *optimization*: the authorizing address is the enclosing transaction's
  source account, so its auth rides the ordinary tx envelope signature: **no separate Soroban
  signature, nonce, or expiration in the entry**. Use only for the party that also signs+submits.
  Our submit is permissionless → **do not use SourceAccount for maker/taker.**

### 3.3 The authorized-invocation tree

The full runtime call tree is a tree; each authorizing address's `root_invocation` + `sub_invocations`
is a **condensed subtree** containing only nodes where `require_auth` fires for *that* address.
Matching is **path-based**: the host walks the real tree and matches shape + order. If `fill`
internally calls SAC `transfer` (which does `from.require_auth()`), that `transfer` must appear as a
**sub_invocation** with exact args, or be covered by a separate entry. Our design binds `require_auth`
at the `fill` level, so the top-level args are the security surface: keep `fillCanonicalArgs`
byte-identical between sign and submit. In tests, `env.auths()` returns what actually authorized.

### 3.4 Nonces / replay (host-managed)

The host manages replay for Address credentials: **a contract does NOT manage its own auth nonces.**
On verify, the host *"verifies and consumes the nonce"*; the nonce must be **unique among the
address's non-expired signatures** (not sequential). It's bound into the signed payload, so a signed
entry can't be altered or reused. Our app adds an independent `Filled(order_id)` storage guard
(per-order double-fill) on top of the host nonce (per-signature) and `expiration` (staleness).

### 3.5 `signature_expiration_ledger`

A `u32` = the **last ledger at which the signature is valid** (invalid at +1). Bounds how long a
pre-signed off-chain entry stays usable. **Distinct from `order.expiration`** (business deadline
checked inside `fill` via `env.ledger().timestamp()`). Keep them consistent; don't conflate.

### 3.6 The signature payload (what is hashed & signed)

Each party signs **SHA-256 of an `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION` `HashIDPreimage`**, which
binds: **network id** (passphrase hash → no cross-network replay), **nonce**,
**signature_expiration_ledger**, and the **root invocation** (contract, function, args, sub-tree).
Any tamper (amount, token, nonce, network) changes the hash → signature invalid. This is exactly why
a permissionless submitter can't alter the deal. The resulting 32-byte hash reaches `__check_auth` as
`signature_payload`.

### 3.7 `__check_auth`: custom / contract accounts (smart wallets)

Invoked **by the host** only when the authorizing `address` is a **contract account** (implements
`CustomAccountInterface`), not a plain ed25519 account. **Cannot be called manually.** Handles
**authentication + policy only**: nonce and expiration are still host-enforced; don't reimplement
them, and never call `require_auth` on the contract's own address inside it (infinite recursion). It
*is* safe to mutate the account's own storage inside it.

```rust
// Minimal single ed25519 signer:
#[allow(non_snake_case)]
pub fn __check_auth(env: Env, signature_payload: BytesN<32>, signature: BytesN<64>, _ctx: Vec<Context>) {
    let pk: BytesN<32> = env.storage().instance().get(&DataKey::Owner).unwrap();
    env.crypto().ed25519_verify(&pk, &signature_payload.into(), &signature);   // panics on failure
}

// Multisig + policy (the real template) via the trait:
#[contractimpl]
impl CustomAccountInterface for AccountContract {
    type Error = AccError;
    type Signature = Vec<AccSignature>;                 // { public_key: BytesN<32>, signature: BytesN<64> }
    #[allow(non_snake_case)]
    fn __check_auth(env: Env, payload: Hash<32>, sigs: Vec<AccSignature>, auth_context: Vec<Context>)
        -> Result<(), AccError> {
        // 1. sigs ordered by pubkey asc (else BadSignatureOrder); each a registered signer (else UnknownSigner)
        // 2. env.crypto().ed25519_verify(...) per sig
        // 3. walk auth_context to enforce policy:
        //    match ctx { Context::Contract(c) => { c.contract; c.fn_name; c.args } // e.g. spend limit at args.get(2)
        //                Context::CreateContractHostFn(_) => return Err(AccError::InvalidContext) }
        Ok(())
    }
}
```
Policy patterns: require all signers signed for the current contract; filter by `fn_name`; per-window
spend limits (`day = timestamp / 86_400`, running total in storage); allow-lists that inspect **root
AND sub-invocations** so nested calls can't bypass; temporary-storage session/policy signers.
**Passkey/WebAuthn (secp256r1, Protocol 21+):** verify with `env.crypto().secp256r1_verify` over
`authenticator_data ‖ sha256(client_data_json)`, confirming the WebAuthn challenge equals the
base64url `signature_payload`. **BLS12-381:** `env.crypto().bls12_381()` provides `hash_to_g2` + `pairing_check`
for aggregated/threshold sigs (constant-time N-of-N; ~31M CPU for 10 signers). All account examples
are **API references, not audited production code.**

### 3.8 JS/TS mapping (`otc.html`)

- **`Stellar.authorizeEntry(entry, signer, validUntilLedgerSeq, networkPassphrase)`**: takes an
  unsigned Address-credential entry, builds the `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION` preimage, has
  `signer` sign the SHA-256 hash, returns the **signed** entry with `nonce` /
  `signature_expiration_ledger` (= `validUntilLedgerSeq`) / `signature` populated. `signer` = a
  `Keypair`, or `async (preimage) => signatureBytes` wrapping a wallet.
- **Wallet `kit.signAuthEntry(preimageXdr)` (SEP-43)** returns the signature bytes; wrap it inside
  `authorizeEntry` so the SDK builds the correct preimage and reassembles a valid entry.
  Freighter's `signAuthEntry(preimageB64, { networkPassphrase, address })` → `{ signedAuthEntry }`
  (the signed hash, not a full entry).
- **`signOrderAuth` flow:** simulate `fill` with the **counterparty as tx source** so the signer's
  `require_auth` surfaces as a signable **address credential** (not absorbed into source-account),
  sign via `kit.signAuthEntry` wrapped in `authorizeEntry`, store base64 XDR (`maker_auth` /
  `taker_auth`).
- **`fillOrder` flow:** parse both stored entries
  (`xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64")`), attach to the invoke op's `auth`, run an
  **enforcing-mode** simulation, then `assembleTransaction` (leaves auth intact) + sign envelope +
  submit. `validUntilLedgerSeq = (await server.getLatestLedger()).sequence + N` (N ≈ 12–60).

### 3.9 Security-boundary summary

| Concern | Mechanism | Where |
|---|---|---|
| Tamper-proof terms | args hashed into signature payload | host, both entries |
| Amount-tamper reverts | signature over full args (`require_auth`, not `_for_args`) | contract + host |
| Cross-network replay | network id in preimage | host |
| Per-signature replay | host-consumed unique nonce | host, on-ledger |
| Per-order double-fill | `Filled(order_id)` storage key | our contract |
| Stale signatures | `signature_expiration_ledger` (ledger seq) | host |
| Stale deals | `order.expiration` vs `env.ledger().timestamp()` | our contract |
| Permissionless submit | maker+taker use **Address** credentials | client + entries |
| Re-signable args | `fillCanonicalArgs` derived only from stored order | client |

---

## 4. Tokens: SAC & SEP-41

A **Stellar Asset Contract (SAC)** is the built-in token contract wrapping a classic asset (or native
XLM). It implements **SEP-41** (token interface) + **CAP-46-6** (admin interface). One SAC per asset;
its id is **deterministic**:

```javascript
Asset.native().contractId(networkPassphrase);              // XLM SAC
new Asset("USDC", issuerG).contractId(networkPassphrase);  // classic-asset SAC
// CLI: stellar contract id asset --asset USDC:G… --network testnet
```
Deploying the SAC ledger entry (once per asset, idempotent): `stellar contract asset deploy --asset
USDC:G… …`, or JS `Operation.createStellarAssetContract({ asset })`, or Rust
`env.deployer().with_stellar_asset(serialized_asset).deploy()`. The **id is stable across deploys**;
only creating the entry is one-time.

**SEP-41 interface** (what `token::Client.transfer(...)` hits):
```
transfer(from, to, amount: i128)         transfer_from(spender, from, to, amount)
approve(from, spender, amount, expiration_ledger: u32)     allowance(from, spender) -> i128
balance(id) -> i128    burn(from, amount)   burn_from(spender, from, amount)
decimals() -> u32      name() -> String     symbol() -> String
```
`transfer` / `burn` / `approve` call `from.require_auth()` internally: this is why each `fill` leg
needs that party's signed auth entry. **No on-chain `approve` in the AirSwap flow**: the signed auth
entry authorizes the `transfer` sub-invocation directly.

**CAP-46-6 admin** (defaults to the asset issuer): `mint`, `clawback`, `set_authorized`,
`authorized(id) -> bool`, `set_admin(new)`, `admin()`. `set_admin` **does not validate** the new
admin; a bad address bricks admin permanently.

**Rust clients / tests:** `token::TokenClient` (SEP-41) vs `token::StellarAssetClient` (admin/mint);
tests use `env.register_stellar_asset_contract_v2()` (mock SAC with issuer-flag control).

**Gotchas:** amounts are `i128` base units (× 10^7); decimals ≤ 18 (custom tokens enforce at
construction); **expired allowances silently return 0**; **Protocol 23 (Whisk)** changes `transfer`'s
destination to `MuxedAddress` (`.address()` + `to_muxed_id` in the event); `transfer_from` stays
plain `Address`. Confirm which signature the target SAC exposes before an SDK/protocol bump.

**OpenZeppelin token stack** (batteries-included alternative): crates `stellar_tokens::fungible` /
`::non_fungible`, `stellar_access::ownable`, `stellar_pausable`; `#[default_impl]` generates
boilerplate; decorators `#[only_owner]`, `#[when_not_paused]`. NFT variants Base/Consecutive/
Enumerable are **not** naively composable.

---

## 5. Example-contract patterns

### Atomic swap: the model this project is built on

Two parties swap atomically without trusting each other or knowing the counterparty at signing time.
Each signs **only its own leg**; a permissionless submitter carries both auths; amounts are bound
into each signature.

```rust
pub fn swap(env: Env, a: Address, b: Address, token_a: Address, token_b: Address,
            amount_a: i128, min_b_for_a: i128, amount_b: i128, min_a_for_b: i128) {
    if amount_b < min_b_for_a { panic!("not enough token B"); }
    if amount_a < min_a_for_b { panic!("not enough token A"); }
    a.require_auth_for_args((token_a.clone(), token_b.clone(), amount_a, min_b_for_a).into_val(&env));
    b.require_auth_for_args((token_b.clone(), token_a.clone(), amount_b, min_a_for_b).into_val(&env));
    move_token(&env, &token_a, &a, &b, amount_a, min_a_for_b);
    move_token(&env, &token_b, &b, &a, amount_b, min_b_for_a);
}
// move_token deposits max into current_contract_address(), pays counterparty, refunds remainder,
// decoupling each signature from the `to` address (sign without knowing your counterparty).
```
If either auth fails, the whole tx reverts (atomic). **This repo's `fill` diverges**: direct
`transfer` under `require_auth` (no contract-custody / no allowance hops): simpler, same
auth-binds-args principle. Other reference shapes: **single-offer-sale** (standing offer, integer
price ratio + buyer `min` slippage guard), **timelock** (claimable balance gated by
`env.ledger().timestamp()` predicate; single-use `Init` guard), **atomic-multi-swap** (a batcher that
forwards matched pairs to the single-swap contract via `try_swap`; holds no auth itself).

### Others worth knowing

- **Custom account contracts** (simple / complex-multisig / BLS) → §3.7.
- **Liquidity pool**: same `token::Client::new(&e, &sac).transfer(&from, &to, &amt)` pattern under
  `from.require_auth()`; constant-product, 0.3% fee, requires `token_a < token_b` lexicographically.
- **Mint-lock**: delegated, per-minter per-epoch capped minting;
  `minter.require_auth_for_args((&contract, &to, amount).into_val(&env))`; epoch =
  `ledger().sequence() / epoch_length`, accumulator in temporary storage.
- **Upgradeable**: admin-gated `update_current_contract_wasm` (§2).

---

## 6. Soroban transactions from JS (build → simulate → sign → submit)

Two API tiers; don't mix arbitrarily. **Low-level** (`Contract`, `TransactionBuilder`, `rpc.Server`,
`assembleTransaction`, `authorizeEntry`) is required for the AirSwap-style signed-`fill` (two
different parties sign off-chain, a third submits). **High-level** (`contract.Client` /
`AssembledTransaction.signAndSend()`) assumes the invoker is the submitter, fine for simple dApps.

```javascript
import * as StellarSDK from "@stellar/stellar-sdk";
import { Api, assembleTransaction } from "@stellar/stellar-sdk/rpc";
const server = new StellarSDK.rpc.Server("https://soroban-testnet.stellar.org");  // {allowHttp:true} for local
```

### Build an invocation (low-level)

```javascript
const contract = new StellarSDK.Contract(OTC_CONTRACT_ID);
const account  = await server.getAccount(sourcePubKey);          // fetches seq via RPC
const tx = new StellarSDK.TransactionBuilder(account, {
    fee: StellarSDK.BASE_FEE, networkPassphrase: StellarSDK.Networks.TESTNET })
  .addOperation(contract.call("fill", ...scValArgs))             // args are xdr.ScVal
  .setTimeout(30).build();
// equivalently: Operation.invokeContractFunction({ contract, function: "fill", args, auth: [...] })
```

### simulateTransaction: response shape

```javascript
const sim = await server.simulateTransaction(tx);
if (Api.isSimulationError(sim)) throw new Error(sim.error);
```
- `transactionData`: `SorobanDataBuilder` with the **footprint** (read-only + read-write ledger
  keys), resource limits, `resourceFee`. Makes the tx submittable.
- `minResourceFee`: string; add on top of the inclusion fee.
- `result`: `{ auth: xdr.SorobanAuthorizationEntry[], retval: xdr.ScVal }`. `auth` = the required
  authorizations the host recorded; `retval` = return value (`scValToNative`).
- `events`, `cost` (`{ cpuInsns, memBytes }`), `latestLedger`.
- `restorePreamble`: present only when archived entries must be restored first
  (`Api.isSimulationRestore(sim)`; see restore flow below).

### Assemble / prepare

```javascript
const readyTx = assembleTransaction(tx, sim).build();   // merges footprint + bumps fee by minResourceFee
// one-shot equivalent (simulates internally):
const readyTx = await server.prepareTransaction(tx);
```
Critical: `assembleTransaction` copies `sim.result.auth` onto the op **only when the op had no auth
attached**, which is what enables the enforcing-mode pattern.

### Enforcing-mode signed-`fill` (tamper-proof submit)

```javascript
// 1. Rebuild the SAME canonical invocation with BOTH signed entries attached up front:
const op = StellarSDK.Operation.invokeContractFunction({
  contract: OTC_CONTRACT_ID, function: "fill", args: [...scValArgs],   // byte-identical to what was signed
  auth: [makerSignedEntry, takerSignedEntry],
});
const tx = new StellarSDK.TransactionBuilder(account, { fee, networkPassphrase })
  .addOperation(op).setTimeout(30).build();
// 2. Enforcing simulate: auth pre-attached → host validates signatures, returns correct footprint.
const sim = await server.simulateTransaction(tx);
if (Api.isSimulationError(sim)) throw new Error(sim.error);          // sig/args mismatch reverts HERE
// 3. Assemble (footprint + fee only; auth intact) and sign the ENVELOPE as submitter:
const readyTx = assembleTransaction(tx, sim).build();
readyTx.sign(submitterKeypair);                                     // or kit.signTransaction(readyTx.toXDR())
```

### Sign auth entries (each party, off-chain)

```javascript
const signed = await StellarSDK.authorizeEntry(
  entry,                          // xdr.SorobanAuthorizationEntry (Address credentials)
  keypairOrSignFn,                // Keypair OR async (preimage) => signatureBytes (wallet)
  validUntilLedgerSeq,            // (await server.getLatestLedger()).sequence + N   (N ≈ 12–60)
  StellarSDK.Networks.TESTNET);
const b64 = signed.toXDR("base64");                                // store/transport
const back = StellarSDK.xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64");
```

### Submit & poll

```javascript
const sent = await server.sendTransaction(readyTx);                // { status, hash, ... }
if (sent.status !== "PENDING") throw sent;                         // else DUPLICATE/TRY_AGAIN_LATER/ERROR
const final = await server.pollTransaction(sent.hash, { attempts: 5, sleepStrategy: () => 500 });
switch (final.status) {                                            // SUCCESS | FAILED | NOT_FOUND
  case Api.GetTransactionStatus.SUCCESS:
    const ret = StellarSDK.scValToNative(final.returnValue); break;
  default: throw final;
}
```
**No synchronous confirmation on Soroban**: RPC only queues; you must poll (unlike Horizon's classic
submit). Simulation is **mandatory** before submitting a contract invocation.

### Upload / deploy from JS (redeploy after Testnet resets)

```javascript
Operation.uploadContractWasm({ wasm });                            // → returnValue.bytes() = wasm hash
Operation.createCustomContract({ wasmHash, address, salt, /* constructorArgs */ });
Operation.createStellarAssetContract({ asset });                  // classic-asset SAC
```
Normal deploy path is still `stellar contract build` + `stellar contract deploy`.

### Restore archived data / extend TTL from JS

```javascript
if (Api.isSimulationRestore(sim)) {                               // archived entries present
  const restoreTx = new TransactionBuilder(account, { fee })
    .setNetworkPassphrase(Networks.TESTNET)
    .setSorobanData(sim.restorePreamble.transactionData.build())  // footprint from the preamble
    .addOperation(Operation.restoreFootprint({}))                 // empty body; keys go in read-write set
    .build();
  await server.sendTransaction(await server.prepareTransaction(restoreTx).then(t => (t.sign(kp), t)));
  // then retry the ORIGINAL tx with a fresh sequence number
}
// Extend a persistent entry's TTL (extendFootprintTtl must be the ONLY op; entry key = READ-ONLY footprint):
tx.setSorobanData(new SorobanDataBuilder().setReadOnly(persistentEntryKey).build());
// op: Operation.extendFootprintTtl({ extendTo: 100000 })
// CLI: stellar contract extend --ledgers-to-extend 500000 --id C… / --wasm-hash <hash>
```

---

## 7. Frontend / dApp architecture

### Design & custody

Four custody models (ascending user control): **non-custodial** (user holds key, signs; this repo's
model: connected wallet = identity), **custodial** (provider holds keys; often one pooled account +
muxed `M…` addresses), **hybrid/multisig** (self-custody + multisig recovery), **third-party key mgmt**
(Ledger/Trezor/StellarGuard). Budget **~2 XLM per new user account** (1 min balance + 1 for
trustlines/fees). All traffic over strong TLS. Never leak signing secrets to frontend; keep funder/
JWT keys server-side. **Guard any fee-paying relay endpoint**: a public POST that forwards arbitrary
XDR lets attackers spend your credits.

### Bindings → invoke → sign → submit (high-level)

```bash
stellar contract bindings typescript --network testnet --id <C…|alias> --output-dir ./packages/<a> --overwrite
cd packages/<a> && npm install && npm run build   # MUST build before import; re-run on contract change
```
```javascript
import * as Client from "<a>";
const c = new Client.Client({ ...Client.networks.testnet, rpcUrl: PUBLIC_RPC_URL });
const { result } = await c.read_message({ message_id: 1 });       // read-only: simulation only, no sign
const at = await c.write_message({ author, title, text });        // → AssembledTransaction (already simulated)
await at.signAndSend({ signTransaction });                        // signTransaction from your wallet
```
**Rule:** don't pass an authenticated principal the contract reads from its own storage: the contract
should pull it internally and `require_auth()` (mirrors this repo's signed-entry design).

### Freighter (`@stellar/freighter-api` v2+, object returns, always check `.error`; HTTPS required)

```javascript
import { isConnected, requestAccess, getAddress, getNetwork, signTransaction, signAuthEntry } from "@stellar/freighter-api";
const { isConnected: installed } = await isConnected();
const { address } = await getAddress();                           // "" until app is allowed
const { address: addr } = await requestAccess();                  // prompts
const { signedTxXdr, signerAddress, error } = await signTransaction(xdr, { networkPassphrase, address });
// signAuthEntry(preimageB64, { networkPassphrase, address }) → { signedAuthEntry }  // wrap in authorizeEntry
```
This repo uses **Stellar Wallets Kit** (multi-wallet, SEP-43) instead: `kit.signTransaction(xdr, {…})`
and `kit.signAuthEntry(preimage)`.

### Passkeys / smart wallets (optional, larger footprint)

`passkey-kit` (`PasskeyKit` client + `PasskeyServer`) → WebAuthn auth instead of seed phrases, with
**Launchtube** (paymaster: abstracts gas + sequence numbers; Testnet token at
`testnet.launchtube.xyz/gen`) and **Mercury** (indexer). `account.createWallet()` deploys a
smart-wallet contract; `account.sign(built, { keyId })`. Keep JWTs server-side; guard the relay.

### Frontend gotchas (this repo)

- **esm.sh `?bundle-deps` is mandatory** for `stellar-wallets-kit` + `stellar-sdk` (default builds
  leave a CJS dep with broken named-export interop that throws on import and kills the module). Keep
  the `globalThis.Buffer = Buffer` shim. (Vite analog: `optimizeDeps.include`.)
- `getLedgerEntries()` returns **max 200 entries per call**: paginate.
- Decode return values explicitly (`xdr.ScVal.fromXDR(b64, "base64")`); guard array vs scalar.

---

## 8. Classic Stellar operations & fundamentals

Every tx: `TransactionBuilder(source, { fee, networkPassphrase }).addOperation(...).setTimeout(180)
.build()` → `.sign(kp)` → submit. Fees in **stroops** (1 XLM = 10^7); `BASE_FEE` = 100 stroops/op.
Operation amounts are decimal **strings** (`"10"`), not numbers.

- **Reserves:** min balance **1 XLM** per account; **+0.5 XLM per subentry** (trustline, offer,
  signer, data entry, claimable balance). **Can't pay a non-existent account**: use
  `Operation.createAccount({ destination, startingBalance })`.
- **Trustlines:** native XLM needs none; **every non-native asset (USDC) needs a receiver trustline**
  before receipt, else `op_no_trust`. `Operation.changeTrust({ asset: new Asset("USDC", ISSUER),
  limit })` (costs 0.5 XLM). Verify before sending: check the account's balances array / RPC
  `getLedgerEntries(trustline key)` for existence, authorized flag, and `limit - balance ≥ amount`.
- **Payments:** `Operation.payment({ destination, asset, amount })`; add `Memo.id/text` for pooled
  routing. **Path payments** convert across assets (SDEX + pools) with mandatory slippage bounds:
  `pathPaymentStrictSend({ …, destMin })` / `pathPaymentStrictReceive({ …, sendMax })`.
- **Claimable balances:** `createClaimableBalance({ claimants:[new Claimant(pk, predicate)], asset,
  amount })` + `claimClaimableBalance({ balanceId })`. Predicates: unconditional / beforeRelativeTime
  / beforeAbsoluteTime / not / and / or. Consumes 0.5 XLM; claimant still needs a trustline for
  non-native; unclaimed persist forever (add yourself as a claimant for recovery).
- **Clawbacks:** must enable at issuance (`setOptions setFlags AuthRevocable | AuthClawbackEnabled`,
  before trustlines). `clawback({ from, asset, amount })`; issuer-only; **native XLM can never be
  clawed back**.
- **Sponsored reserves** (onboard 0-XLM users): sandwich `beginSponsoringFutureReserves` … sponsored
  entry … `endSponsoringFutureReserves`; **both accounts sign**; no dangling sponsorship at tx end.
- **Fee-bump** (third party pays fees / rescue stuck tx): sign inner first, then
  `TransactionBuilder.buildFeeBumpTransaction(feeSource, fee, innerTx, passphrase)`, feeSource signs
  the outer. Replace-by-fee needs **10×** the original.
- **Channel accounts** (parallel submission, avoid `tx_bad_seq`): channel = tx source (owns
  sequence/fees), base = op source (moves assets); **both sign**.
- **Muxed accounts** (`M…`, SEP-23/Protocol 13): 64-bit id in the address; distinguish many users
  behind one `G…` account with no per-user reserves. Preferred over memos. Load account data by the
  **base G address**; don't send `M…` to platforms that don't support them.
- **Classic → Soroban:** use **RPC not Horizon** for contracts (simulation, events); **poll
  `getTransaction()`** (no sync confirm); classic assets appear to contracts as **SACs** (query by
  simulating the token contract); contracts emit **events** (not Horizon effects).

---

## 9. Events, RPC & data

**Publish** (Rust) → §2. **Consume / ingest** (RPC `getEvents`):

```javascript
const res = await rpc.getEvents({
  startLedger,                                                     // cursor = last-ingested ledger + 1
  filters: [{ type: "contract", contractIds: [contractId],
    topics: [[ nativeToScVal("transfer", { type: "symbol" }).toXDR("base64"), "*" ]] }],
  limit: 100 });
// decode: scValToNative(xdr.ScVal.fromXDR(b64, "base64"))
```
**Retention: RPC keeps events ~7 days only**: ingest into your own DB, poll often enough to never
open a >7-day gap, enforce idempotency on `(ledger, tx, event_index)`. Cold-start:
`startLedger ≈ currentLedger − (7 days / ~6s per ledger)`.

**RPC reads:** `getLedgerEntries(key)` for contract data / code (build keys via
`xdr.LedgerKey.contractData({ contract, key, durability })` / `.contractCode({ hash })`);
`Contract.getFootprint()` gives the instance key. Retrieve Wasm in two hops (instance entry →
`wasmHash` → code entry). For deep history / high-throughput pipelines use **Hubble/Galexie** or the
Go **Ingest SDK** (parses `LedgerCloseMeta`); Horizon/RPC for simple REST lookups.

---

## 10. Testing Soroban contracts

Tests run the **same host `Env`** as on-chain: real auth/storage/budget, not a simulation. Pattern:
create env → register → client → invoke + assert. Run with `cargo test`.

```rust
let env = Env::default();
let id = env.register(IncrementContract, ());              // (Contract, constructor_args); replaces register_contract
let client = IncrementContractClient::new(&env, &id);
let user = Address::generate(&env);                        // use soroban_sdk::testutils::Address as _;
```

### Auth testing (primary security surface)

- **`env.mock_all_auths()`**: every `require_auth` auto-succeeds (also
  `mock_all_auths_allowing_non_root_auth()` for deep trees). **Skips `__check_auth`**: custom
  accounts need direct coverage via `env.try_invoke_contract_check_auth::<E>(&addr, &payload, sig, &ctx)`.
- **`env.auths()`** → `Vec<(Address, AuthorizedInvocation)>`: exactly who authorized what (fn + args +
  sub-invocations) in the last top-level call. Assert it to prove `fill` demands **both** maker+taker
  auth over the **exact** args.
- **`env.mock_auths(&[MockAuth { address, invoke: &MockAuthInvoke { contract, fn_name, args,
  sub_invokes } }])`** (selective): only listed pairs authorized; **anything else panics** → this is
  how you assert a tampered-amount `fill` reverts.
- **`env.set_auths(&[SorobanAuthorizationEntry{…}])`**: raw signed entries; closest to the real
  signed-`fill` path.
- Drive time/ledger with `env.ledger().with_mut(|li| { li.sequence_number = …; li.max_entry_ttl = … })`
  to exercise `expiration` / TTL.

```rust
env.mock_all_auths();
assert_eq!(client.increment(&user, &5), 5);
assert_eq!(env.auths(), std::vec![(user.clone(), AuthorizedInvocation {
    function: AuthorizedFunction::Contract((id.clone(), symbol_short!("increment"),
        (user.clone(), 5_u32).into_val(&env))),
    sub_invocations: std::vec![] })]);
```

### Test snapshots (auto differential regression)

`cargo test` **auto-writes** a JSON snapshot per test to `test_snapshots/<module>/<test>.<n>.json`
capturing **events + final ledger storage**. **Commit `test_snapshots/` to git**: future changes
that alter events/storage for unrelated tests show up as unexpected diffs (a free regression
tripwire). *(This repo already tracks `contracts/otc_swap/test_snapshots/`: 6 snapshot files,
committed since `49345a0`.)*

### Other test types

Integration (`contractimport!` / `stellar contract fetch`), events (`env.events().all()`), fuzzing
(`cargo-fuzz` + `#[derive(Arbitrary)]`, `fuzz_target!`; `budget().reset_unlimited()`; needs
`crate-type=["cdylib","rlib"]`), mutation (`cargo-mutants`: `MISSED` = code runs but nothing asserts
it; high-value for auth/amount checks), fork (`Env::from_ledger_snapshot_file` + `stellar snapshot
create`), differential, coverage (`cargo-llvm-cov`). Best practice: assert **all** observable
outcomes including events, not just return values.

---

## 11. Securing web-based projects & threat modeling

### Web-app security checklist (wallet-signing dApp)

- **HTTPS everywhere + HSTS** (`Strict-Transport-Security`): MITM / DNS-hijack (cf. MyEtherWallet DNS
  hack). Verify no mixed-content `http://` calls to RPC/Horizon.
- **CSP**, the single most important control: an injected script can rewrite a transaction before the
  wallet prompt. Allow-list `script-src`/`connect-src` (`*.supabase.co` REST+WSS, RPC/Horizon);
  avoid `'unsafe-inline'`. **This app's JS is bundled and external** (zero inline scripts in
  `dist/`); keep it that way. (cf. Blackwallet injection hack.)
- **Clickjacking:** `X-Frame-Options: DENY` / CSP `frame-ancestors 'none'`.
- **Supply chain (high relevance):** every third-party script runs with full DOM + wallet
  access; a swapped artifact can tamper with the signed tx. **Pin exact versions** (done), add **SRI**
  hashes where supported, constrain via CSP, scan deps (Snyk). Keep libraries patched. (esm.sh
  survives only in the dev-only capture tool; the deployed bundle has no CDN scripts.)
- **Transaction-tampering (the marquee threat):** the user must cryptographically bind to the exact
  terms: this app's signed auth entries over full `fill` args already do this; the web-layer job is
  to keep the arg-building UI un-hijackable and ensure displayed amounts == signed amounts.
- **Phishing:** never ask for secret keys; prompt users to verify the domain.
- **Secrets/keys:** the private key never leaves the wallet (correct posture, no server custody). If
  you ever store secrets, use AES-256-GCM, keys offline/in-memory, never roll your own crypto.
- **Backend:** Supabase PostgREST parameterizes queries; the real exposure is **public reads with the
  anon key**: an *Information Disclosure* item to track (accepted for a Testnet MVP), not injection.
- Run the deployed site through **Mozilla Observatory**; wire error reporting (Sentry); rate-limit /
  WAF (Cloudflare) for DoS.

### STRIDE threat modeling

A living document; **the SDF Audit Bank now requires a threat model as an audit prerequisite.** Four
questions: (1) What are we building? (2) What can go wrong? (3) What do we do about it? (4) Did we do
a good job?

1. **Define the system**: verbal use-case + a **data-flow diagram** with element types: external
   entities (wallets, Stellar network, esm.sh), processes (frontend module, `fill` contract), data
   flows (RFQ over Supabase realtime, auth entries, the on-chain tx), data storage (Supabase Postgres,
   Soroban storage), and **trust boundaries** (anon backend ↔ signed on-chain settlement); give
   boundaries + sensitive data the most scrutiny.
2. **Identify threats**: walk each element against STRIDE, logging ≥1 per category (`Spoof.1`, …):

   | STRIDE | Violates | dApp example |
   |---|---|---|
   | **Spoofing** | Authentication | submit an order/`fill` as another wallet |
   | **Tampering** | Integrity | alter swap **amounts** before sign/submit; injected CDN script |
   | **Repudiation** | Non-repudiation | user denies authorizing a swap → per-user signed entries answer it |
   | **Info Disclosure** | Confidentiality | public reads expose all orders + counterparties |
   | **Denial of Service** | Availability | flood RPC/backend; single point of failure |
   | **Elevation of Privilege** | Authorization | reach an admin/settlement path without rights |

3. **Mitigate**: a treatment per issue keyed `[ThreatCode].R.[n]` (e.g. `Tamper.1.R.1`) with the
   concrete code/architecture change.
4. **Evaluate**: is the DFD detailed enough to reference? did STRIDE surface new threats across all
   categories (esp. at boundaries)? mitigations adequate? still finding issues? model kept updated?

Template = DFD + three tables (Threat Identification → Mitigation → Validation checklist); the DFD
must exist before threat analysis. The pizza-restaurant worked example maps each STRIDE class to a
concrete fix (prepared statements, server-side pricing, non-sequential GUIDs, per-user signed orders,
rate-limits, server-side admin checks).

### Operational: Testnet resets

Testnet/Futurenet reset to genesis **~quarterly**, wiping all accounts, trustlines, offers, and
**contract data**. Keep contract WASM + deploy params locally; script an idempotent setup (keygen →
Friendbot fund → trustlines/assets → deploy) and a retry-enabled submit helper. For this repo: re-run
`stellar contract deploy` and update `OTC_CONTRACT_ID` + `REFLECTOR_ORACLE_ID` in
`otc-config.js` each quarter (the Supabase data is off-chain and survives the reset).

---

## 12. Wallet SDK & SEP flows (reference)

The **Stellar Wallet SDK** (`@stellar/typescript-wallet-sdk`) targets wallet ↔ anchor integration
(fiat on/off-ramps, KYC). Orthogonal to this OTC dApp (we sign via stellar-wallets-kit), but the
canonical anchor reference.

| SEP | Purpose | SDK entry |
|-----|---------|-----------|
| **SEP-1** | `stellar.toml` metadata | - |
| **SEP-7** | `web+stellar:` URI scheme (delegated signing / deep links) | `Sep7Tx` / `Sep7Pay` |
| **SEP-9** | KYC field vocabulary | pre-fills SEP-6/24 |
| **SEP-10** | Wallet↔anchor auth → JWT | `anchor.sep10().authenticate({ accountKp })` |
| **SEP-12** | KYC submission | - |
| **SEP-24** | **Interactive** hosted deposit/withdraw (anchor UI) | `anchor.sep24().deposit()/.withdraw()` |
| **SEP-6** | **Programmatic** deposit/withdraw (you own the UI) | `anchor.sep6().deposit()/.withdraw()` |
| **SEP-38** | Anchor **quotes/RFQ pricing** (indicative or firm) | `sep38.price()/.requestQuote()` |
| **SEP-30** | Account recovery via recovery-signer servers | `createRecoverableWallet()` |
| **SEP-31** | Cross-border payments | - |
| **SEP-41** | Token interface (SACs implement it) | §4 |
| **SEP-43** | Wallet signing interface (`signTransaction`, `signAuthEntry`) | stellar-wallets-kit / Freighter |

`wallet.stellar()` also wraps classic ops (trustlines, swap, pathPay, sponsoring, fee-bump,
offline/distributed signing, submitWithFeeIncrease). Reference payment app = **BasicPay** (SvelteKit).

---

## Appendix: canonical doc URLs

- Build home / getting started: `developers.stellar.org/docs/build/smart-contracts/getting-started/{setup,hello-world,storing-data,deploy-to-testnet}`
- Authorization: `.../docs/build/guides/auth/{contract-authorization,check-auth-tutorials}` · contract accounts `.../guides/contract-accounts/{smart-wallets,advanced-patterns,examples}`
- Soroban txs from JS: `.../guides/transactions/{invoke-contract-tx-sdk,signing-soroban-invocations,simulateTransaction-Deep-Dive,submit-transaction-wait-js}`
- Storage/archival: `.../guides/storage/*` · `.../guides/archival/*` · `.../guides/conventions/*`
- Tokens/SAC: `.../guides/tokens/{stellar-asset-contract,deploying-a-sac,custom-sac-admin}`
- Events/RPC/Freighter: `.../guides/events/*` · `.../guides/rpc/*` · `.../guides/freighter/*`
- Testing: `.../guides/testing/*`  · Example contracts: `.../smart-contracts/example-contracts/*`
- Apps: `.../apps/{overview,application-design-considerations,dapp-frontend,guestbook/*}`
- Security: `.../security-docs/{securing-web-based-projects,threat-modeling/*}`
- AI tooling: `developers.stellar.org/llms.txt` · skills at `skills.stellar.org` (`stellar/stellar-dev-skill`)
