---
phase: requirements
title: Katon Solana Tokenized-Stock Exit Desk Requirements
description: Seller-first, non-custodial RFQ requirements for verified xStocks and Ondo assets on Solana
feature: solana-tokenized-stock-desk
status: historical_non_canonical
date: 2026-09-15
---

> **Non-canonical.** Historical evidence only. The sole behavioral and acceptance contract is [Canonical Seller Desk full specification](https://github.com/mangekyou-labs/katon/issues/16).

# Requirements & Problem Understanding

## Problem statement

Eligible non-US self-custody traders can hold issuer-backed equities on Solana, but an exact-size exit still requires comparing a public aggregator with fragmented private liquidity. A public dump can leak inventory and incur avoidable price impact. Katon provides a three-second private quote sprint that races Jupiter's Meta-Aggregator against vetted makers and returns one executable, exact-input full-fill route.

The product is a seller-first stock-to-stablecoin RFQ. It is not a credit facility UI, a public auction board, a custody service, or an automatic fallback router. The wallet signs the exact transaction that was simulated for the selected winner.

This requirement set is informed by the Solana Foundation's xStocks case study (issuer-backed SPL assets, Jupiter/Raydium/Kamino distribution and Token Extensions), Ondo's Global Markets launch, Solana tokenization and Token-2022 extension documentation, Jupiter Order/Execute and Lend documentation, Meteora DBC documentation, and Octarine's staged bid flow:

- [Solana xStocks case study](https://solana.com/news/case-study-xstocks)
- [Ondo Global Markets on Solana](https://ondo.finance/blog/global-markets-live-on-solana)
- [Solana tokenization](https://solana.com/docs/tokenization) and [Token Extensions](https://solana.com/docs/tokens/extensions)
- [Jupiter Order and Execute](https://developers.jup.ag/docs/swap/order-and-execute)
- [Jupiter Lend liquidation](https://developers.jup.ag/docs/lend/borrow/liquidation) and [flashloans](https://developers.jup.ag/docs/lend/flashloan)
- [Meteora DBC](https://github.com/MeteoraAg/docs/blob/main/core-products/dbc/what-is-dbc.mdx)
- [Octarine bid flow](https://docs.octarine.finance/user-guides/how-to-bid-via-app) and [near-instant fills](https://docs.octarine.finance/user-guides/how-to-swap/near-instant-fill)

## Actors

- **Seller:** eligible non-US trader with a self-custody Wallet Standard wallet.
- **Private maker:** authenticated institution quoting supported issuer assets over the streaming API.
- **Operator:** manages asset, issuer, program/IDL, policy, and source-health registries.
- **Liquidation solver:** independent service funding verified native-USDC debt and atomically unwinding approved stock collateral.
- **Governance:** 2-of-3 Squads authority behind a 24-hour delay; a separate pause-only guardian can halt execution.

## Goals

1. Sell verified xStocks or Ondo assets for native Solana USDC or USDT with an exact-input, full-fill quote.
2. Race Jupiter and all healthy private makers concurrently for at most three seconds.
3. Rank only executable candidates by exact stablecoin atomic units received after route-specific fees.
4. Preserve issuer-specific eligibility and Token/Token-2022 correctness, including hooks and pauses.
5. Deliver only the winner's transaction and a sanitized audit comparison; never publish losing maker payloads.
6. Settle private wins atomically in an Anchor program with no inventory custody and with replay-resistant receipts.
7. Keep lending integrations fail-closed and registry-verified; ship adapters dormant when no supported stock market is present.
8. Provide a brokerage-clear seller UI, maker dashboard, operator console, receipt history, and an independent liquidation solver.

## Non-goals for v1

- Buying stocks, partial fills, persistent orders, auctions, public bid ladders, custody, or automatic worse-route fallback.
- Treating all SPL or Token-2022 mints as interchangeable.
- Creating Meteora DBC curves for existing issuer-backed assets; DBC is deferred to an issuer-approved primary-launch module.
- Rewriting Jupiter transactions, especially JupiterZ managed-signing transactions.
- Retail US access, issuer mint/redemption, bridges, or unsupported issuer assets.

## Functional requirements

### RFQ and ranking

- A quote session accepts `{ wallet, inputMint, outputMint, inputAmountAtomic }` where all monetary values are base-10 atomic strings.
- Output is exactly one of native USDC or native USDT. Quotes compete only for the selected output mint.
- Eligibility completes before quote collection and returns `eligible`, `action_required`, `ineligible`, or `unknown`; only `eligible` can quote.
- Jupiter and healthy vetted makers start concurrently. Collection ends after three seconds or when all sources have answered.
- Private quotes are valid for 15 seconds by default and never more than 30 seconds. Candidates with two seconds or less remaining are invalidated before review.
- The ranker rejects failed simulation, expired terms, insufficient source balance, policy failure, unsupported/changed extensions, and asset-specific price-band violations.
- Sort key is net selected-stable amount, then remaining validity, rolling reliability, then stable source ID.
- The API exposes one winner plus anonymized losing-source amounts, timestamps, and structured rejection reasons. It never exposes losing payloads or inventory.

### Asset and issuer safety

- Registry entries are keyed by mint address and include issuer (`xstocks` or `ondo`), token program, expected transfer-hook program, allowed extension fingerprint, supported outputs, and enablement.
- Asset discovery validates mint owner, decimals, metadata pointer, scaled UI amount, pausable state, transfer fees, permanent delegate, memo requirements, and transfer hook accounts.
- Unknown extensions, changed hook programs, paused assets, missing issuer metadata, or registry mismatch produce `unknown`/`ineligible` and halt quoting.
- xStocks and Ondo are separate adapters. Ondo's JIT/managed route is never treated as a generic SPL transfer.

### Private settlement

- `settle_private_quote` requires seller and allowlisted maker signatures and uses only classic Token or Token-2022 `transfer_checked` CPIs.
- The signed transaction pins seller, maker, recipient, stock/stable mints and token programs, exact input, maker minimum stock receipt, seller minimum stable receipt, quote ID, expiry, and fee bps.
- Fee is `floor(grossStable * feeBps / 10_000)`, default 10 bps and hard-capped at 25 bps. The maker receives the exact stock input; seller receives gross less fee; fee recipient receives fee.
- A `FillReceipt` PDA keyed by maker and quote ID prevents reuse. Anyone can close it one hour after expiry and receive rent only when permitted by the account rules.
- Maximum quote lifetime enforced on-chain is 30 seconds. Post-transfer balance deltas are checked; logs are informational, not settlement truth.
- Every dynamic transfer-hook account is validated against the registry and instruction context. Duplicate mutable accounts, arbitrary CPI targets, changed extensions, and overflow fail closed.

### Jupiter execution

- A Jupiter winner is forwarded to `/execute` with the returned transaction bytes unchanged. The browser and API may not mutate JupiterZ managed-signing transactions.
- Katon fee is zero for Jupiter winners. Jupiter and venue fees are displayed from the returned route data.
- `POST /v1/quote-sessions/:id/execute` accepts only the original winner transaction after signed-message hash validation.

### APIs and persistence

- `GET /v1/assets?wallet=&outputMint=` returns verified assets, issuer, capabilities, balance, reference/session state, supported outputs, and eligibility.
- `POST /v1/quote-sessions` starts a session; `GET /v1/quote-sessions/:id/events` streams `collecting`, `ready`, `no_quote`, `expired`, and failure states; `GET /v1/quote-sessions/:id` returns winner and sanitized audit data.
- `GET /v1/trades?wallet=` returns indexed receipts.
- Quote sessions retain transaction bytes only until expiry. Persistent data is hashes, signatures, terms, audit metadata, and receipts. No private keys or inventory are held.
- All API monetary fields remain strings; JavaScript `number` is prohibited at trust boundaries.

### Liquidation solver

- Integrate Kamino `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`, Jupiter Lend `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi`, and Jupiter flashloan `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS` only through pinned, audited IDLs/SDKs and a signed deployment manifest.
- Startup discovers markets, reserves, vaults, stock mints, oracle configuration, and upgrade authorities from mainnet and halts on unreviewed changes.
- Monitor only registry-enabled stock collateral with native USDC debt. Use each lender's authoritative liquidation instruction; do not duplicate seize math.
- Funding order is Jupiter flashloan, then a capped prefunded USDC wallet (2,000 USDC maximum). Unwind, repayment, stock transfer, and profit transfer must be atomic. Leave zero residual stock.
- Skip stale, under-compute, non-atomic, or sub-threshold opportunities (less than $10 and 50 bps expected net profit).

### Frontend and operations

- `/trade` presents wallet balance, verified asset selector, issuer/session/reference state, amount, output selector, and **Find best executable price**.
- Quote sprint locks inputs and shows source classes without placeholder prices. No-quote states explain eligibility setup, paused token, stale/closed reference, liquidity, or supported-size actions.
- Result shows exact stable received, effective stock price, reference deviation, price impact, all fees, route, and expiry; audit drawer shows anonymized losses.
- Review/sign is symmetrical and includes counterparty/venue, program, issuer restrictions, fee payer, network fee estimate, minimum receive, expiry, and simulation result.
- Execution shows `signing → submitting → confirmed → finalized`, decoded recovery errors, and one Solscan network link. `/activity` contains compact history with expandable details.
- Maker dashboard and operator console are gated surfaces; makers integrate primarily via authenticated streaming APIs.
- Keyboard operation, visible focus, 44 px mobile targets, reduced motion, dark-mode-safe semantic tokens, and WCAG AA are required at 375/768/1280 px.

## Acceptance criteria

- **AC-1:** Every enabled asset has a registry-verified issuer, mint/program, extension fingerprint, hook, stable outputs, and passing preflight; unknown states cannot quote.
- **AC-2:** A session races Jupiter and private makers for no longer than three seconds and ranks deterministically using integer net output.
- **AC-3:** Only one executable winner is delivered; losing payloads and maker identities remain private, while sanitized audit reasons are visible.
- **AC-4:** Jupiter bytes are forwarded unchanged and Katon fee is zero for Jupiter winners; private winners show the 10 bps fee.
- **AC-5:** Private settlement is exact-term, seller+maker authorized, replay-resistant, expiry-bound, fee-capped, and delta-checked for classic and Token-2022 assets.
- **AC-6:** Execute rejects a changed signed-message hash, expired quote, changed wallet, or non-winner transaction.
- **AC-7:** Lending adapters are enabled only after manifest/IDL/program/mint checks; dormant adapters are read-only when no stock vault exists.
- **AC-8:** Frontend covers idle/loading/empty/error/success/expired/offline states and signs only a freshly simulated v0 transaction.
- **AC-9:** Solver tests demonstrate flashloan-first funding, safe prefunded fallback, atomic unwind, residual-token detection, circuit breakers, and no submission on stale or mismatched state.
- **AC-10:** Release is gated by reproducible builds, hashes, SBOM/dependency review, independent audit, Rust/TypeScript tests, accessibility, and fresh Surfpool evidence. Mainnet execution requires explicit human/multisig approval after seven shadow days and 20 representative opportunities with at least 95% prediction-to-simulation agreement.

## Locked decisions

- Solana mainnet target; local/LiteSVM and Surfpool first; devnet receives mocks only.
- Node 22, Solana CLI 3.1.10, Anchor CLI/framework 1.1.2 target, v0 transactions, Codama-generated clients, `@solana/kit` 7+ target, and Wallet Standard.
- Native USDC/USDT only; native USDC only for liquidation repayment.
- Katon private fee 10 bps (25 bps protocol maximum); zero on Jupiter winners.
- No DBC, public auctions, partial fills, custody, unsupported-route fallback, or automatic cap escalation.

## Ticket 14 governance evidence reconciliation (2026-09-23)

This dossier is historical evidence. Canonical behavioral acceptance remains
Seller Desk specification issue #16; the local governance exercise is scoped
to its AC-047 through AC-051 and does not add or replace product requirements.

| Canonical criterion | Local evidence |
| --- | --- |
| AC-047: queue hash, target, expected version and 24-hour delay; reject early apply; apply only at the expected active version | The Surfnet run observed the queue fields and verified the payload hash, rejected early apply with GovernanceDelayActive, applied after the delay, and rejected stale queue/apply attempts. |
| AC-048: bootstrap by the vault without the delay | A 2-of-3 Squads proposal executed RFQ governance bootstrap; the resulting GovernanceConfig retained the 24-hour delay for later changes. |
| AC-049: reject a member key or unrelated PDA as the governance signer | Direct member-key and unrelated-vault attempts failed with ConstraintAddress; no queue account was created for the rejected actions. |
| AC-050: Guardian non-pause actions fail | Guardian queue, apply, and cancel attempts failed with ConstraintAddress. The separate pause instruction succeeded and changed programPaused from false to true. |
| AC-051: Squads can immediately cancel a queued change | A 2-of-3 Squads vault proposal canceled a queued action before its apply time; the queued account was removed. |

Detailed transaction signatures, rejection logs, and account snapshots are in
the [machine-readable testing evidence](../testing/evidence/2026-09-23-ticket14-squads-local.json).
The run used the source-built official Squads v4 executable in local Surfnet.
It provides direct program-execution evidence for this governance subset; it
does not replace the broader EVD-002 settlement, hook, fee, memo, and replay
coverage or other fork, operational, and runtime obligations in issue #16.
AC-052 and AC-053 were not evaluated by this run; no evidence-to-enablement or
loader-upgrade-delay claim is made.

The local executable hash differs from the live Devnet executable hash. The
untouched official current-source checkout was clean at revision
af94153ff77a28b6effe46b9c94baaa93742b48c, but its documented build did not
produce an executable in the pinned image because its Cargo.lock uses version
4 and the image rejected it during Cargo metadata processing. The README
documents a version-3 lockfile workaround. There is no current-source
executable to compare, so the Devnet mismatch cause remains unproven.
