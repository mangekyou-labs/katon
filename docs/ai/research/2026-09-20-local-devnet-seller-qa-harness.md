# Local/devnet harness for Wallet Standard Seller QA

- **Ticket:** [Choose the local/devnet harness for Wallet Standard Seller QA](https://github.com/mangekyou-labs/katon/issues/11) (part of [#9](https://github.com/mangekyou-labs/katon/issues/9))
- **Date:** 2026-09-20
- **Scope:** Recommendation only. Does not implement the Seller Desk, enable mainnet, enable Ondo, or enable Liquidation Execution.
- **Worktree:** `feature-solana-tokenized-stock-desk` (research branch `research/local-devnet-seller-qa-harness`)

## Question

Which local/devnet harness should the seller-drivable desk use so a Seller can connect a Wallet Standard wallet, sign the exact frozen v0 bytes, and receive an honest receipt without mainnet enablement?

Compare Surfpool (including the Kit plugin, cheatcodes, and Jupiter scenarios), `solana-test-validator`, public devnet, and the current mock API. Recommend one default for interactive Seller QA and one for automated program tests. State how a headless Private Maker can auto-partial-sign, how Token-2022 xStocks balances get onto the harness, and whether Jupiter must be stubbed.

## Constraints (from the map and ADRs)

- Ship target is **local/devnet with Wallet Standard**, not mainnet, Ondo, or Liquidation Execution.[^issue9]
- First seller-drivable bar: Wallet Standard connect and sign of the **exact frozen v0 bytes**; a **headless Private Maker auto-partial-signs**; cluster, fee payer, simulation, and receipt are **honest**; **Jupiter may be a spec-faithful stub**.[^issue9]
- A Private Maker **partially signs the exact frozen v0 transaction before seller review**; the Seller signs the same message afterward. An expired quote or blockhash requires a new quote and new signatures. No standing token delegations.[^adr0001]
- Seller Desk execution and Liquidation Execution are **independent release gates**. Liquidation absence must not block a local Seller Desk QA loop.[^adr0005]
- Initial mainnet execution is xStocks-only; Ondo stays disabled. This research does not enable either on mainnet.[^adr0006]
- Domain language: **Seller**, **Seller Desk**, **Quote Sprint**, **Private Maker**, **Exact Input**, **Token-2022**. Avoid Trader / user / customer / Liquidator / exchange.[^context]
- Agent Solana CLI commands use `NO_DNA=1`.[^nodna] Never store production private keys. Local-only headless maker keys may be described, not invented.

## What “honest” Seller QA requires

The frozen-v0 contract is already specified in the design dossier and ADR 0001:

1. The API (or Private Maker) **builds a v0 transaction** with the Exact Input terms.
2. The Private Maker **partially signs those bytes** before review.
3. The Seller’s Wallet Standard wallet **signs the identical message** (`signTransaction`, not managed send).
4. On execute, the API **hash-checks** the signed message against the issued winner, verifies both Ed25519 signatures, and **forwards the same bytes** to a trusted RPC. No browser mutation; no transplanting signatures onto rebuilt bytes.[^design-tx][^adr0001]

Core already enforces a **strict v0 wire parser** (message prefix `0x80` only) and rejects Jupiter message mutation.[^parser][^jupiter-unchanged] The Wallet Standard adapter **requires `signTransaction`** and rejects wallets that only expose `signAndSendTransaction`, because the API must hash-check signed bytes before forwarding.[^wallet-adapter]

An honest receipt therefore needs:

- A real JSON-RPC cluster the wallet can advertise (`solana:localnet` or `solana:devnet`, not `solana:mainnet` for this QA loop).[^ws-chains]
- A Token-2022 mint + Seller ATA with a **real spendable raw balance**.
- A deployed (or loaded) `solana_rfq` program on that cluster (`programs.localnet` in `Anchor.toml` is `59MVYbUATHzCgYtD7uio4RvCkZhdwrRh6c38ZefycwMX`).[^anchor-toml]
- A headless Private Maker that **partially signs** the compiled v0 message without sending it.
- Settlement that **lands on that cluster** and returns a **cluster signature**, not a `mock-…` string.

## Current product: LOCAL MOCK MODE is not that loop

`apps/solana-web` is a Vite Seller Desk that currently:

- Banners **LOCAL MOCK MODE**: “Wallet, RPC, quotes, settlement, and receipts are simulated. No Solana transaction is submitted.”[^app-banner]
- “Connects” by assigning the hardcoded `DEMO_WALLET` (`GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB`) after a timeout — no Wallet Standard discovery.[^app-connect]
- Identity-signs: `signAndExecute` **returns the issued `transactionBase64` unchanged**. Comments state this is intentional so the API can exercise payload hash-binding without a keypair.[^app-sign]
- Still lists an **executable Ondo demo mint** in fallback inventory (`ondo-demo-MSFT-mint`).[^app-ondo]

`apps/solana-api` `MockJupiterSource` / `MockPrivateMakerSource`:

- Reject any wallet other than `DEMO_WALLET`.[^demo-wallet]
- Label candidates `transactionVersion: 'v0'` but **`mockTransactionBase64` builds a legacy-looking message** (`[1, 0, 1]` header, no `0x80` version prefix) and pre-signs it with a demo PKCS8 key of all-`0x07`.[^mock-tx]
- `MockSender.execute` returns `{ signature: \`mock-${sourceKind}-${quoteId}\`, … commitment: 'finalized' }` **without submitting bytes to any RPC**.[^mock-send]

So the current mock API **cannot** satisfy “sign the exact frozen v0 bytes and receive an honest receipt.” It is a UI-shape stand-in. Keep it for offline UI iteration; do not use it as the Seller QA harness.

**QA blocker (do not fix in this ticket):** `WalletStandardAdapter` defaults `expectedChain = 'solana:mainnet'` and `sign()` throws “wallet is not connected to Solana mainnet.”[^wallet-adapter] Interactive Seller QA on localnet/devnet needs that chain parameterized to `solana:localnet` (or `solana:devnet`). New UI work should use Kit `walletSigner({ chain })` + `@solana/kit-plugin-wallet/react`, not wallet-adapter.[^frontend]

## Option A — Surfpool (recommended)

Official docs: Surfpool is a **drop-in replacement for `solana-test-validator`**, LiteSVM-based, with lazy remote cloning, 26 `surfnet_*` cheatcodes, Studio, and an embeddable SDK. Default datasource is **mainnet fork**.[^surfpool-home][^surfpool-overview]

### Interactive (CLI daemon)

```bash
NO_DNA=1 surfpool start --offline --airdrop <SELLER_PUBKEY> --airdrop <MAKER_PUBKEY>
```

- RPC `http://127.0.0.1:8899`, WebSocket `8900`, Studio `18488`.[^surfpool-overview]
- `--offline` starts **without a remote RPC client**, so the harness does not lazily pull mainnet accounts.[^surfpool-overview] That is the flag that keeps Seller QA off mainnet enablement. **Do not use default `surfpool start` (mainnet fork) for this loop.**
- `--network devnet` is available if a wallet can only advertise `solana:devnet` and a custom RPC; it still forks **public devnet**, not a Katon program, and is a fallback — not the default.[^surfpool-overview]
- `--airdrop` funds SOL for fees on start (repeatable).[^surfpool-overview]
- `--watch` auto-redeploys `target/deploy/*.so`. Anchor 1.0+ uses Surfpool as the default `anchor test` / `anchor localnet` runner.[^surfpool-overview]
- Agent prefix: `NO_DNA=1`.[^nodna]

Wallet Standard chain for this daemon: **`solana:localnet`** (`http://localhost:8899`).[^ws-chains] Kit UI: `walletSigner({ chain: 'solana:localnet' })` + `solanaRpc({ rpcUrl: 'http://127.0.0.1:8899' })` or `solanaLocalRpc()`.[^frontend][^kit-overview]

Cheatcodes for Seller inventory (typed via Kit, or JSON-RPC on 8899):

- `surfnet_setTokenAccount` / `client.cheatcodes.setTokenAccount(owner, mint, { amount, state? }, token_program?)` — **the mint must already exist** (create, `cloneProgramAccount`, or `setAccount` + mint encoder). Optional fourth arg is the token program (Token-2022: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).[^kit-plugin][^cheatcodes]
- `surfnet_setAccount` for SOL, program accounts, or encoded mints.[^cheatcodes]
- `surfnet_profileTransaction` to simulate the frozen v0 bytes **without committing**, returning CU + pre/post snapshots — this is the honest pre-sign simulation surface.[^cheatcodes]
- `surfnet_pauseClock` / `timeTravel` for quote expiry without waiting on wall clock.[^cheatcodes]
- `surfnet_exportSnapshot` + `surfpool start --snapshot` for repeatable fixtures.[^cheatcodes]

**Kit plugin, two modes:**[^kit-plugin-official]

| Mode | Entry | Use |
| --- | --- | --- |
| Attach (interactive QA) | `surfpool({ rpcUrl: 'http://127.0.0.1:8899' })` | Long-lived `surfpool start`. Synchronous. Requires an existing `payer`. No `client.surfnet` handle. |
| Embedded (automated tests) | `await createClient().use(surfpool({ surfnet: { offline: true } }))` | In-process surfnet, dynamic ports, pre-funded payer, typed `client.cheatcodes`. Teardown: `client.surfnet.stop()`. |

Default embedded config **forks mainnet**. Pass `surfnet: { offline: true }` so program tests do not pull mainnet state.[^kit-plugin]

### Jupiter scenarios on Surfpool

`surfnet_registerScenario` can apply **Jupiter v6 TokenLedger** account overrides on a slot timeline, alongside Pyth, Raydium, etc.[^scenarios] That is **protocol-account theatre**, not Jupiter Ultra `/order` + `/execute`. It does not produce a frozen Seller settlement tx, does not land via Jupiter Beam, and does not replace a spec-faithful Quote Sprint stub. Optional later for quote-comparison fixtures; **not required for the first seller-drivable bar.**

### Why Surfpool wins interactive QA

- Real JSON-RPC + WebSocket so a Wallet Standard wallet can connect to `solana:localnet` and **sign real v0 bytes**.
- Cheatcodes put Token-2022 balances on the Seller ATA **without mint authority ceremonies**.
- Attach-mode Kit plugin lets the headless Private Maker and API talk to the same daemon.
- `--offline` avoids mainnet cloning, which would otherwise be the Surfpool default and would violate the no-mainnet-enablement constraint.
- Sub-second start vs 10–30s for `solana-test-validator`; 26 cheatcodes vs none.[^surfpool-overview]

## Option B — `solana-test-validator`

Official advantages: no RPC/airdrop limits, `--bpf-program`, `--clone` / `--clone-upgradeable-program` from a public cluster, `--account` files, warp slot.[^test-validator] RPC is still `http://127.0.0.1:8899`, so Wallet Standard `solana:localnet` works the same.

Gaps versus the Seller QA bar:

- **No cheatcodes.** Token-2022 balances require mint/ATA txs or `--account` dumps, then a restart to reload files.
- **No Jupiter scenario templates.** Cloning Jupiter programs from mainnet would be mainnet-derived state.
- **Slow start**, no Studio, no typed Kit plugin, no `surfnet_profileTransaction`.
- Upgradeable clones need `--clone-upgradeable-program` (not plain `--clone`) or last-deployed-slot issues appear.[^test-validator]

Use only if a later ticket needs **full validator fidelity** Surfpool does not emulate (vote processing, leader schedule).[^testing] Not the Seller QA default.

## Option C — Public devnet

Wallet Standard defines `solana:devnet` (`https://api.devnet.solana.com`).[^ws-chains] Kit ships `solanaDevnetRpc()`.[^kit-overview] Official cluster docs: application developers target Devnet; tokens are not real; faucet exists; ledger may reset; the public RPC is rate-limited.[^clusters]

Gaps:

- **xStocks Token-2022 mints are mainnet issuer assets** (Token-2022 + Scaled UI + pausable).[^xstocks] They are **not assumed to exist as spendable Seller inventory on public devnet**. Do not require a Seller to hold mainnet-issued xStocks to QA a local desk.
- `solana_rfq` is not a published public-devnet program in this repo (`Anchor.toml` provider cluster is `Localnet`).[^anchor-toml]
- Live Jupiter Ultra `/execute` **broadcasts via Jupiter’s proprietary engine** (Beam) against **mainnet liquidity**. That is mainnet execution, not a local/devnet Quote Sprint.[^jup-execute]
- Faucet and public RPC make HITL QA flaky. Cluster smoke tests “are slow and flaky by nature — never gate PRs on them.”[^testing]

Public devnet is a **later optional smoke** (deploy + one happy path), not the interactive Seller QA harness.

## Option D — Current mock API

Covered above. Useful for UI layout without a cluster. **Fails** frozen-v0 signing, Wallet Standard connect, Token-2022 balances, and honest receipts.

## Headless Private Maker partial-sign

ADR 0001 + design: maker signs first, Seller signs the **same** message.[^adr0001][^design-tx]

Kit first-party signing:

- Load a **local-only** maker key as a `KeyPairSigner`: `createKeyPairSignerFromBytes` (attach-mode example in the official Kit plugin docs) or `signerFromFile('…')` / `payer(...)` + `identity(...)` when fee payer and maker authority differ.[^kit-plugin-official][^kit-overview]
- Compile a **v0** transaction message (`createTransactionMessage({ version: 0 })`).
- **Partial-sign without sending:** `partiallySignTransactionMessageWithSigners(transactionMessage)`. This uses `TransactionPartialSigners` in parallel, **ignores `TransactionSendingSigners`**, and does **not** require every required signature to be present.[^kit-partial]
- Do **not** call `signAndSendTransactionMessageWithSigners` / wallet `signAndSendTransaction`. The Seller path must keep bytes for API hash-check.[^wallet-adapter]
- Encode with `getBase64EncodedWireTransaction` and issue that payload as `transactionBase64` (`transactionVersion: 'v0'`). Core parser accepts only prefix `0x80`.[^parser]
- After Seller `signTransaction`, API verifies message bytes unchanged (already the Jupiter helper; Private Maker needs the same message-equality check) and submits to the surfnet RPC — not to Jupiter `/execute`.

Local maker key material: a file under the operator’s machine (e.g. a dedicated local keypair path), funded via `--airdrop` / `setAccount`. **Do not invent or commit secrets.** Production maker keys are out of scope.

## How Token-2022 xStocks balances get onto the harness

Facts:

- Solana xStocks are **SPL Token-2022** with **Scaled UI Amount** (raw amount constant; UI = raw × multiplier), plus pausable / metadata pointer / permanent delegate on mainnet.[^xstocks][^scaled-ui]
- Transfers and Exact Input **must use the raw atomic amount**, not the scaled UI amount.[^xstocks]
- Surfpool `setTokenAccount` **does not create the mint**. Create it, encode it with a Token-2022 mint encoder + `setAccount` (owner = Token-2022 program), or clone a program account.[^kit-plugin]

Recommended provision (offline surfnet, no mainnet clone):

1. Start `NO_DNA=1 surfpool start --offline`.
2. Create (or `setAccount`-encode) a **local Token-2022 mint** that matches registry fingerprints the desk already checks (metadata pointer, scaled UI, pausable, **no transfer fee** — ADR 0003). This is a **QA stand-in mint**, not a mainnet xStock and not an Ondo JIT mint.
3. `cheatcodes.setTokenAccount(seller, mint, { amount: <raw atomic>, state: 'initialized' }, TOKEN_2022_PROGRAM)`.
4. Repeat for the Private Maker’s output stablecoin ATA (local USDC/USDT stand-in or encoded mint) so inventory verification is on-chain, not `MemorySourceBalanceProvider`.
5. `--airdrop` both pubkeys for SOL fees.
6. Point the Seller wallet at `solana:localnet` / `http://127.0.0.1:8899` so `getTokenAccountsByOwner` returns the cheatcode balance.

Do **not** lazily clone mainnet xStock mints via default Surfpool fork for this QA loop: that is mainnet-derived issuer state and collides with “without mainnet enablement.” Fork-based evidence remains a later, separately gated Surfpool job in the historical testing dossier; it is not the seller-accept harness.[^testing-doc]

## Jupiter: live vs spec-faithful stub

Live Ultra / Swap V2 meta-aggregator:

- `GET https://api.jup.ag/ultra/v1/order` returns a base64 unsigned (or MM-partial) **versioned** tx; `POST …/execute` lands it through Jupiter Beam. Integrators **must not modify** the transaction. JupiterZ (RFQ) **cannot be modified** after return; use `partiallySignTransaction` because an additional MM signer is applied at `/execute`.[^jup-execute][^jup-z]
- Katon already treats JupiterZ / managed JIT as **not instruction-buildable** and asserts the signed **message bytes equal the issued bytes**.[^jupiter-unchanged][^route-buildable]

Live `/execute` is **mainnet landing**. Using it from the Seller Desk would enable mainnet execution and break the frozen-v0 “API forwards to a trusted RPC” Private Maker path for the Jupiter candidate. Public devnet has no equivalent Ultra book for local Token-2022 stand-in mints.

Surfpool’s Jupiter v6 **TokenLedger scenario** overrides account data; it is not `/order`.[^scenarios]

**Therefore Jupiter must be a spec-faithful stub on this harness:**

- Same Quote Sprint fields as a Jupiter candidate (`sourceKind: 'jupiter'`, Exact Input, `transactionVersion: 'v0'`).
- Payload is a **real v0 wire tx** the core parser accepts (`0x80`), hash-bound, optionally a no-op or local Token-2022 transfer that **settles on the surfnet**.
- Execute path: submit those bytes to **surfnet RPC** (or reject with a stub reason), **never** `POST api.jup.ag/…/execute`.
- Preserve `assertJupiterPayloadUnchanged` so a stub still trains the “do not rebuild JupiterZ-shaped bytes” invariant.
- Do not pretend live Ultra prices on local mints.

The current `MockJupiterSource` is **not** spec-faithful: legacy bytes, demo-only wallet, mock signature.[^mock-tx][^mock-send] Replace it when implementing the desk; this ticket only records that requirement.

## Comparison

| Harness | Wallet Standard connect | Frozen v0 co-sign | Honest receipt | Token-2022 balances | Headless maker | Jupiter | Mainnet leak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Surfpool `--offline` + Kit attach** | `solana:localnet` → `:8899` | Yes (real RPC) | Cluster signature | `setTokenAccount` after local mint | Kit `partiallySign…` | Stub (+ optional TokenLedger scenario) | None if `--offline` / `surfnet.offline` |
| Surfpool default (mainnet fork) | Same | Yes | Yes, but against cloned mainnet accounts | Lazy clone mainnet xStocks | Same | Could hit forked Jupiter programs | **Yes — default datasource is mainnet** |
| `solana-test-validator` | `solana:localnet` | Yes | Yes | Manual mint/`--account` | Same Kit signer | Stub only | Only if `--clone` from mainnet |
| Public devnet | `solana:devnet` | Only if program+mints exist | Flaky public RPC | Not assumed | Possible | Live Ultra = mainnet | Execution risk via Jupiter Beam |
| Current mock API | Demo string, no WS | Identity / legacy bytes | `mock-…` | Fabricated `balanceAtomic` | Demo PKCS8 | Fabricated | None, but dishonest |

## Recommendation

- **Interactive Seller QA harness (one choice):** Long-lived **Surfpool CLI surfnet**, started `NO_DNA=1 surfpool start --offline` (RPC `http://127.0.0.1:8899`), Wallet Standard chain **`solana:localnet`**, Kit **attach** plugin `surfpool({ rpcUrl: 'http://127.0.0.1:8899' })` for cheatcodes and the API/maker. Do not use default mainnet-fork `surfpool start`. Do not use the current mock API as the accept loop. Fallback only if a given wallet cannot advertise `solana:localnet`: `--network devnet` + `solana:devnet` custom RPC, still stub Jupiter, still deploy `solana_rfq` locally — not public-devnet-as-the-cluster.
- **Automated program-test harness (one choice):** **Embedded Surfpool Kit plugin** `await createClient().use(surfpool({ surfnet: { offline: true } }))` for integration tests (teardown `client.surfnet.stop()`). **LiteSVM or Mollusk** for in-process unit tests of `settle_private_quote` / Token-2022 `transfer_checked`. Reserve `solana-test-validator` for full-validator-fidelity only. Do not gate PRs on public-devnet smoke.
- **Headless Private Maker partial-sign approach:** Local-only `KeyPairSigner` (`createKeyPairSignerFromBytes` / `signerFromFile`) that **`partiallySignTransactionMessageWithSigners`** the compiled **v0** message and returns base64 wire bytes. Never `signAndSend`. Seller Wallet Standard **`signTransaction`** on those exact bytes; API hash-checks then `sendTransaction` to the surfnet.
- **How xStocks Token-2022 balances are provisioned:** On the offline surfnet, **create or `setAccount`-encode a local Token-2022 mint** (Scaled UI allowed; raw amounts for Exact Input; no transfer fee), then **`cheatcodes.setTokenAccount(seller, mint, { amount }, Token-2022 program id)`**. Airdrop SOL for fees. Do not clone mainnet xStock mints for this QA loop.
- **Jupiter: live vs spec-faithful stub, and why:** **Spec-faithful stub.** Live Ultra `/order`+`/execute` lands on **mainnet** via Jupiter Beam and forbids mutation (JupiterZ adds a later MM signature). Surfpool Jupiter v6 TokenLedger scenarios are account overrides, not a swap API. The stub must emit real v0 bytes and settle (or fail) on the surfnet without calling `api.jup.ag`.

[^issue9]: [Ship a user-accepted Solana Seller Desk #9](https://github.com/mangekyou-labs/katon/issues/9) — destination, standing preferences (Wallet Standard frozen v0 on local/devnet; headless Private Maker; honest receipt; Jupiter may be a spec-faithful stub; no mainnet/Ondo/Liquidation Execution).
[^adr0001]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0001-maker-signs-the-frozen-transaction.md`
[^adr0005]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0005-execution-surfaces-have-independent-release-gates.md`
[^adr0006]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0006-initial-mainnet-execution-is-xstocks-only.md`
[^context]: `docs/domain/solana-tokenized-stock-desk/CONTEXT.md` — Seller, Seller Desk, Quote Sprint, Private Maker, Exact Input.
[^nodna]: [no-dna.org](https://no-dna.org); Solana skill + Surfpool overview require `NO_DNA=1` on agent CLI (`NO_DNA=1 surfpool start`, `NO_DNA=1 anchor test`).
[^design-tx]: `docs/ai/design/2026-09-15-feature-solana-tokenized-stock-desk.md` — Private Maker partial-sign, seller co-sign, hash-check, no mutation, trusted RPC sender.
[^parser]: `packages/solana-core/src/transactions.ts` — only version prefix `0x80` is v0; other versioned prefixes rejected.
[^jupiter-unchanged]: `packages/solana-core/src/venues.ts` — `assertJupiterPayloadUnchanged` compares issued vs signed **message** bytes.
[^route-buildable]: `packages/solana-core/src/venues.ts` — `routeIsInstructionBuildable` is false for `jupiterz` and Ondo/JIT managed routers.
[^wallet-adapter]: `packages/solana-sdk/src/wallet.ts` — `expectedChain` default `'solana:mainnet'`; requires `signTransaction`; rejects managed-only wallets.
[^ws-chains]: [anza-xyz/wallet-standard `packages/core/chains/src/index.ts`](https://github.com/anza-xyz/wallet-standard/blob/master/packages/core/chains/src/index.ts) — `solana:mainnet`, `solana:devnet`, `solana:testnet`, `solana:localnet` (`http://localhost:8899`).
[^frontend]: Solana skill `references/frontend.md` — `walletSigner({ chain: 'solana:devnet' })` + `@solana/kit-plugin-wallet/react`; do not use wallet-adapter or stale `@solana/client`.
[^kit-overview]: Solana skill `references/kit/overview.md` — `signerFromFile`, `solanaLocalRpc` / `solanaDevnetRpc`, `createKeyPairSignerFromBytes` via Kit signers.
[^anchor-toml]: `contracts/solana-rfq/Anchor.toml` — `[programs.localnet] solana_rfq = "59MVYbUATHzCgYtD7uio4RvCkZhdwrRh6c38ZefycwMX"`; `[provider] cluster = "Localnet"`; `[scripts] test = "NO_DNA=1 anchor test"`.
[^app-banner]: `apps/solana-web/src/App.tsx` — `MockModeBanner` LOCAL MOCK MODE copy.
[^app-connect]: `apps/solana-web/src/App.tsx` — `connect()` assigns `DEMO_WALLET`.
[^app-sign]: `apps/solana-web/src/App.tsx` — `signAndExecute` identity-returns `session.winner.transactionBase64`.
[^app-ondo]: `apps/solana-web/src/App.tsx` — `fallbackAssets` includes `ondo-demo-MSFT-mint` with `enabled: true`.
[^demo-wallet]: `apps/solana-api/src/sources.ts` — `DEMO_WALLET`; `requireDemoWallet`.
[^mock-tx]: `apps/solana-api/src/sources.ts` — `mockTransactionBase64` concatenates `[1, 0, 1]` message header and a demo Ed25519 signature; candidates still set `transactionVersion: 'v0'`.
[^mock-send]: `apps/solana-api/src/sources.ts` — `MockSender.execute` returns `signature: \`mock-${sourceKind}-${quoteId}\``.
[^surfpool-home]: [solana.com/docs/tools/surfpool](https://solana.com/docs/tools/surfpool) — drop-in for `solana-test-validator`; just-in-time Mainnet accounts; Kit plugin + cheatcodes.
[^surfpool-overview]: Solana skill `references/surfpool/overview.md` (Surfpool v1.5.0) — `--offline`, `--network {mainnet,devnet,testnet}`, `--airdrop`, default mainnet fork, vs `solana-test-validator` table, `NO_DNA=1`.
[^kit-plugin]: Solana skill `references/surfpool/kit-plugin.md` — embedded vs attach; `setTokenAccount` mint-must-exist; `surfpool({ surfnet: { offline: true } })`; `client.surfnet.stop()`.
[^kit-plugin-official]: [solana.com/docs/tools/surfpool/sdk/kit-plugin](https://solana.com/docs/tools/surfpool/sdk/kit-plugin) — same entry points; attach-mode `createKeyPairSignerFromBytes` example; cheatcode mint warning.
[^cheatcodes]: Solana skill `references/surfpool/cheatcodes.md` — `surfnet_setTokenAccount` params `[owner, mint, {amount, …}, token_program?]`; `profileTransaction`; `registerScenario`.
[^scenarios]: Solana skill `references/surfpool/overview.md` Scenarios — Jupiter v6 TokenLedger template (not Ultra HTTP).
[^testing]: Solana skill `references/testing.md` — pyramid: LiteSVM/Mollusk unit, Surfpool integration, cluster smoke not PR-gating; `solana-test-validator` only for full validator fidelity.
[^testing-doc]: `docs/ai/testing/2026-09-15-feature-solana-tokenized-stock-desk.md` — later Surfpool fork evidence is a mainnet-adjacent gate, not this local Seller accept loop.
[^test-validator]: [Solana Labs test-validator](https://docs.solanalabs.com/cli/examples/test-validator) — `--clone`, `--bpf-program`; [Solana local validator clone docs](https://github.com/solana-foundation/developer-content/blob/main/docs/toolkit/local-validator.md) — `--clone-upgradeable-program`.
[^clusters]: [Solana clusters](https://github.com/solana-foundation/developer-content/blob/main/docs/core/clusters.md) — Devnet faucet, ledger resets, rate-limited `api.devnet.solana.com`.
[^xstocks]: [xStocks FAQ](https://docs.xstocks.fi/docs/frequently-asked-questions) and [multipliers](https://docs.xstocks.fi/developers/multipliers) — Solana Token-2022; Scaled UI; use raw amount in transactions. [Solana case study](https://solana.com/news/case-study-xstocks) — Scaled UI, pausable, metadata pointer, permanent delegate.
[^scaled-ui]: [solana.com Scaled UI Amount](https://solana.com/docs/tokens/extensions/scaled-ui-amount) — UI multiplier; raw token-account amount unchanged.
[^kit-partial]: [solanakit.com `partiallySignTransactionMessageWithSigners`](https://www.solanakit.com/api/functions/partiallySignTransactionMessageWithSigners) and [Transactions — Signing](https://www.solanakit.com/docs/concepts/transactions) — partial sign ignores sending signers; `signTransactionMessageWithSigners` asserts fully signed.
[^jup-execute]: [Jupiter Ultra execute](https://dev.jup.ag/docs/ultra/execute-order.md) — `POST https://api.jup.ag/ultra/v1/execute` with `signedTransaction` + `requestId`; Jupiter broadcasts via proprietary engine. [Get started FAQ](https://dev.jup.ag/docs/ultra/get-started) — Ultra txs cannot be modified.
[^jup-z]: [Jupiter Swap overview](https://dev.jup.ag/docs/swap) — JupiterZ transactions cannot be modified after return. [Fees / signing](https://dev.jup.ag/docs/swap/fees.md) — use `partiallySignTransaction` because JupiterZ adds an MM signer at `/execute`.
