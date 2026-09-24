# Seller localnet harness (ticket 13)

Operator notes for `tools/solana-seller-localnet.mjs`. Not a product spec.

## Agent / CLI requirement

Always set `NO_DNA=1` for Surfpool / Anchor agent CLI:

```bash
NO_DNA=1 surfpool start --offline --no-tui --no-studio --yes --no-deploy --daemon
```

Binary default: `/Users/kyler/.local/bin/surfpool` (override with `SURFPOOL_BIN`).

## One-shot bootstrap

From repo root:

```bash
npm run seller:localnet
# or
node tools/solana-seller-localnet.mjs
```

The script:

1. Checks `http://127.0.0.1:8899`; if down, starts offline Surfpool in the background with `NO_DNA=1` (`--daemon` on Linux; detached child on macOS).
2. Funds seller + maker SOL via `surfnet_setAccount` (and startup `--airdrop` when it starts Surfpool).
3. Creates a **local** Token-2022 QA stock mint + classic SPL USDC stand-in via `surfnet_setAccount` / `surfnet_setTokenAccount` — **not** cloned mainnet xStocks.
4. Loads `solana_rfq.so` with `surfnet_writeProgram` when `contracts/solana-rfq/target/deploy/solana_rfq.so` exists. If governance init blocks a full deploy path, the harness still continues so the API loop can land a System transfer. **Does not** rewrite Squads vault PDA (ticket 14).
5. Writes `.local/solana-seller-localnet.json`, `.local/maker-keypair.json`, `.local/seller-keypair.json` (gitignored).

### Program build notes (ticket 13)

`anchor build` produces `target/deploy/solana_rfq.so` but exits non-zero: SBF stack checks warn that `settle_private_quote` / `SettlePrivateQuote::try_accounts` exceed the 4096-byte frame (undefined behavior risk), and `idl-build` feature is missing on the program crate. Workspace `[profile.release] overflow-checks = true` is set. Harness loads the `.so` via `surfnet_writeProgram` with **hex** chunks when present (`programLoaded: true`). The local loop still lands a System-transfer v0 under `KATON_LOCALNET=1` (does not invoke settle CPI yet). Exact Input program path is covered by `cargo test --lib`.

## Env printed by the harness

```bash
export SOLANA_RPC_URL=http://127.0.0.1:8899
export KATON_LOCALNET=1
export KATON_MAKER_SECRET_KEY=$(cat .local/maker-keypair.json)
export SOLANA_API_PORT=8787
```

`KATON_LOCALNET=1` makes the API emit landable System-transfer v0 bytes (private maker co-signed; Jupiter stub self-transfer). No `api.jup.ag` calls.

## API + loop

```bash
npm run seller:localnet
npm run dev:solana-api:localnet   # separate terminal
npm run seller:loop
```

Loop asserts the cluster signature does **not** start with `mock-` and that nothing called `api.jup.ag`.

## Background Surfpool (manual)

```bash
mkdir -p .local
NO_DNA=1 /Users/kyler/.local/bin/surfpool start \
  --offline --no-tui --no-studio --yes --no-deploy --daemon \
  --airdrop <SELLER_PUBKEY> --airdrop <MAKER_PUBKEY> \
  --airdrop-amount 1000000000
# pid/log helpers are under .local/ when started via the harness
```

Stop with the process listed in `.local/surfpool.pid` or your process manager. Studio/TUI are disabled for agent use.
