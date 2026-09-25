---
phase: testing
title: Seller stock-for-stablecoin settlement on offline Surfpool
feature: solana-tokenized-stock-desk
status: localnet-close-bar-passed
date: 2026-09-25
---

# Seller stock-for-stablecoin settlement evidence

This note records the technical settlement close bar for
[issue #22](https://github.com/mangekyou-labs/katon/issues/22). The canonical
behavior remains the [Seller Desk full specification](https://github.com/mangekyou-labs/katon/issues/16).
The human UX decision in [issue #23](https://github.com/mangekyou-labs/katon/issues/23)
accepted a 1.0 AAPLx TEST walkthrough with a fee display discrepancy recorded.
The corrected 0.1 walkthrough below is a fresh technical rerun; it does not
represent a new human review of those screenshots.

## Corrected fee and fresh 0.1 walkthrough

The local Private Maker candidate now reports no venue fee and reports the one
governed Katon fee at 10 bps. Ranking, the issued settlement, pre-sign Review,
receipt, and RPC deltas all reconcile to that single fee. The corrected
walkthrough used **0.1 AAPLx TEST** on offline Surfpool:

| Evidence | RPC-observed value |
| --- | --- |
| Signature | `3wEdfZomdhtUuQsU69ScYhhEmJZQSFFrBymh6vv6ZQAojszyXZ6XdDYEsMCiadexY5NbeGX4HKjRz23qcnhT3ugx` |
| Slot and commitment | `798`, `confirmed` |
| FillReceipt PDA | `GKnwZ94R6qHLwM9MMpET2HcvfzcExsVJRpunCSc49sqp` |
| Seller stock debit | `100000` atomic (`0.1`) |
| Gross Maker USDC debit | `10008000` atomic (`10.008`) |
| Single governed fee | `10` bps; `10008` atomic (`0.010008`) |
| Seller net minimum and credit | `9997992` atomic (`9.997992`) |

The browser journey checked the issued quote and successful RPC simulation
before Review, asserted the exact fee and net in the frozen pre-sign Review,
signed those issued bytes, then asserted the same fee and net in the confirmed
receipt. The browser independently fetched the landed transaction and checked
the signature, instruction discriminator/accounts/data, FillReceipt, signature
status, token-balance metadata, and token-account state through RPC.

| Token account | Before (atomic) | After (atomic) | Delta |
| --- | ---: | ---: | ---: |
| Seller stock | 2500000 | 2400000 | -100000 |
| Maker stock | 0 | 100000 | +100000 |
| Maker USDC | 1000000000000 | 999989992000 | -10008000 |
| Seller USDC | 0 | 9997992 | +9997992 |
| Fee USDC | 0 | 10008 | +10008 |

Captured evidence: [pre-sign Review](evidence/2026-09-25-seller-review-0.1.png)
and [confirmed receipt](evidence/2026-09-25-seller-receipt-0.1.png). Both
screenshots show localnet test assets; the receipt includes the confirmed slot,
fee rate and amount, all token deltas, FillReceipt, quote ID, and signature.
No Devnet or Mainnet RPC request or transaction was made by this walkthrough.

## Seller Wallet Standard walkthrough

On 2026-09-25, the Playwright walkthrough drove the Seller trade page with a
Wallet Standard wallet on offline Surfpool. The Seller reviewed the decoded
Private Maker v0 settlement and signed the exact issued message. The API
verified both signatures and the unchanged message, submitted the transaction
once, and returned a receipt after RPC confirmation and exact account-delta
verification.

The browser test independently fetched the landed transaction with
`getTransaction`, checked its Seller signature, `settle_private_quote`
instruction discriminator, account roles, and instruction bytes against the
reviewed message. It also checked `getSignatureStatuses`, the RFQ-owned
FillReceipt, the transaction's pre/post token-balance metadata, and each
token account's before/after state through RPC.

## Cluster and identities

| Item | Localnet identity |
| --- | --- |
| RPC | `http://127.0.0.1:8899` (offline Surfpool) |
| Cluster | `solana:localnet` |
| RFQ program | `J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib` |
| Governance PDA | `EzXW2sNUnbnzzNWk6HeyKxWSgVb1juwM2D8G1tsGPzBf` |
| Asset registry PDA | `92GpVBs6rCp9jUAyL9JQunaMbYbKdZHnzNmVPLkeYRtZ` |
| Maker registry PDA | `3BN1JorBwmcpGk8XHgHsvWUkZgXt6iMAj3wDzeMoFxYL` |
| Seller | `GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB` |
| Private Maker | `2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1` |
| Fee recipient | `7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9` |
| Stock mint (`AAPLx TEST`) | `BbyY4pYpJr1eeKB6Ui7mcMN1hWcjZBjMoGhBtPKdLcu3` |
| Stable mint (`USDC` test fixture) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Stable mint (`USDT` test fixture) | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` (provisioned; not used in this fill) |
| Stock and stable Token program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (classic SPL Token) |

The public USDC and USDT mint keys are synthetic locally provisioned account
state in this offline bank. They are test assets with no issuer backing; their
identity does not assert live USDC or USDT state. The stock mint is also a
local test asset. No Devnet or Mainnet RPC or transaction was used.

## Confirmed fill

| Evidence | RPC-observed value |
| --- | --- |
| Signature | `42iBHbCiNnihLaNJynABQPD5exzW2CedojpG85B5Vr6hAwGLjGErkrs4BTfvi9tz6ZTMXkmRqgmSVVjM8hbVkXxf` |
| Slot and commitment | `45354`, `confirmed` |
| FillReceipt PDA | `G9WvKVnvSWMAWCav8vAhWwiQaXFma7X2rGfXuZsumYSP` |
| Seller stock debit | `100000` atomic (`0.1`) |
| Gross Maker USDC debit | `10008000` atomic (`10.008`) |
| Governed fee | `10` bps; `10008` atomic (`0.010008`) |
| Seller net USDC minimum and credit | `9997992` atomic (`9.997992`) |

Token balances below were read before and after the confirmed transaction via
RPC. The same amounts, mint, owner, and Token-program identities were present
in the transaction's RPC pre/post token-balance metadata.

| Token account | Address | Owner | Before (atomic) | After (atomic) | Delta |
| --- | --- | --- | ---: | ---: | ---: |
| Seller stock | `A8ozjEukc3MLbZ4kVVusw3LSd9jz4W6R8h1gwzZs45LS` | Seller | 2500000 | 2400000 | -100000 |
| Maker stock | `Gwm3fEP6t6RDh5KaxYTstXoq944HHnpz8oBSWmsS3HDu` | Maker | 0 | 100000 | +100000 |
| Maker USDC | `G8sVqaVs7nUeXfK48nwmaWocw1T9sVGbqUFYYbX63S1q` | Maker | 1000000000000 | 999989992000 | -10008000 |
| Seller USDC | `7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK` | Seller | 0 | 9997992 | +9997992 |
| Fee USDC | `ECGH8sEveKyzjhtjVSMs2Yr3GCaYx5DXWDMaJAY1Sso6` | Fee recipient | 0 | 10008 | +10008 |

The RPC-returned transaction had no execution error, contained one RFQ
instruction with the expected `settle_private_quote` discriminator, and named
the governed Seller, Maker, stock, stablecoin, fee, registry, governance,
FillReceipt, Token, and System accounts. The receipt references the actual
mint and Token-program identities, signature, slot, commitment, deltas, and
FillReceipt PDA.

## Verification run

- `NO_DNA=1 npx vitest run src/solana-localnet-settlement.test.ts src/solana-client.test.ts src/solana-seller-routes.test.ts src/solana-tokenized-stock.test.ts src/solana-maker-settlement.test.ts` — 59 tests passed. Covers the corrected fee quote, settlement ABI/account validation, changed accounts/messages, source liquidity and balance gating, failed simulation, quote/review expiry, replay handling, and ambiguous submission reconciliation.
- `NO_DNA=1 npm run typecheck` — passed.
- `NO_DNA=1 npm run build` — passed.
- `NO_DNA=1 cargo test --manifest-path contracts/solana-rfq/Cargo.toml --offline` — 14 unit tests and 17 LiteSVM tests passed, including governance delay and early-apply rejection.
- `NO_DNA=1 node tools/solana-seller-browser-journey.mjs` — passed on 2026-09-25; input `0.1`, successful issued RPC simulation, one Seller execution attempt, one confirmed localnet transaction, complete Review/receipt screenshots, and no Devnet/Mainnet request.
- `git diff --check` — passed.

The program and API reject unsupported or drifting mint/account state before
signing. The validator's pause, Token-2022 fee, expiry, replay, and rollback
scenarios pass. Production issuer balances, real native stablecoin state,
Devnet execution, Squads threshold execution, and human UX acceptance are
outside this localnet evidence.
