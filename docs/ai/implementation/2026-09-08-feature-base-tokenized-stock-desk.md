---
phase: implementation
title: Katon Base B20 Stock-to-USDC RFQ Implementation
feature: base-tokenized-stock-desk
status: m5-candidate-promoted
---

# Implemented seams

The feature worktree now contains the following vertical slices.

## Core and API

- `packages/base-core/src/eip712.ts` defines the v2 `SwapOrder` domain and
  digest while retaining v1 liquidation hashing.
- `packages/base-core/src/swap.ts` implements request validation, one-second
  cutoff filtering, signed maker/facility/external quote validation, greedy
  partial/blended internal routes, effective-output ranking, FOK handling, and
  deterministic ties.
- `apps/base-api/src/service.ts` authenticates the taker, gates mainnet
  eligibility, fans out sources, revalidates standing orders, serializes
  seller-private route bundles, and registers/revokes maker orders.
- `apps/base-api/src/swap-sources.ts` provides strict HTTP maker/facility/
  external parsing and wallet-bound eligibility attestation. Timeouts, bad
  status, malformed signatures, and malformed packets fail closed.
- Memory and Mongo repositories persist signed swap orders and operational fill
  state without identity documents.

## Contracts

- `BaseEIP712.sol` uses domain version 2 for swap orders.
- `RFQSettlement.sol` supports proportional/FOK swap fills, delegated signers,
  cancellation, pair-salt invalidation, and exact token transfers.
- `RFQRouter.sol` executes a taker-submitted `SwapRoutePlan` atomically. LP
  legs identify makers while the plan binds the allowlisted settlement
  contract; facility legs call the configured facility and enforce router
  ownership, quote expiry, and per-leg minimums.
- `LiquidityFacility.sol` prices stock from fresh references and multipliers,
  enforces haircut/exposure/redemption controls, auto-books acquisitions, and
  realizes AP redemption profit/loss. ERC-4626 and FIFO queued withdrawal
  behavior remain intact.

## SDK, indexer, and UI

- `packages/base-sdk` serializes v2 orders and exposes quote/register/revoke
  calls.
- `services/indexer/src/base` projects swap route/order and facility pricing,
  redemption, and P/L events while preserving the isolated legacy liquidation
  projection.
- `apps/base-web` contains a seller-first stock sale page, quote review,
  allowance/simulation checks, and internal route submission. External packets
  are displayed but never mutated or blended.

## Known operational gates

The code is pre-production. Provider endpoints, canonical B20/native-USDC
addresses, AP redemption contracts, eligibility policy, and router/settlement
deployments must be configured and independently verified. Base mainnet is
disabled unless explicit production and mainnet flags are both enabled; a
Sepolia deployment and canary evidence are required first. Liquidations are
product-disabled by default even when a legacy adapter address is configured;
the price-bearing max-seize/surplus adapter described by the product plan is a
future reviewed seam, not a production capability of this release.

## Verification record

Focused Vitest coverage includes core ranking, API collection, maker order
registration/revocation, provider fail-closed parsing, and eligibility. Foundry
coverage includes taker-submitted LP settlement, facility quote freshness and
multiplier/haircut math, AP redemption loss, queued withdrawal, liquidation
invariants, guards, and adapter behavior. The commands in the testing document
are the source of truth for a fresh release check.

## Historical M5 gate validation — 2026-09-18 (superseded)

- `ViemBaseSwapPreflightPort` now owns the N-1 decision block and N simulation
  block, validates both canonical hashes, checks exact settlement allowance at
  N, simulates the serialized router transaction at N, and rejects a changed
  snapshot before a quote is returned.
- The quote contract contains no provider-controlled decision or simulation
  metadata. A failed internal preflight is removed from the executable result;
  a valid external packet may remain as a quote-only fallback.
- The seller web flow waits for the exact stock allowance receipt before SIWE
  quote collection, shows the decision/simulation review, checks decision-block
  freshness, and submits only the reviewed router transaction. Stale calldata
  returns to re-quote instead of being sent.
- Fresh verification passed for the Base Vitest slice, the Foundry Base suite,
  the rank benchmark, the authenticated 600-second quote soak, the injected-
  provider non-extension browser regression, and the secret scan. One
  configured pinned venue-fork run passed all eight cases, but the latest
  retry was blocked before execution by upstream Infura RPC errors (`-32603`
  and HTTP 429 rate limits).
  The live canary and extension-backed wallet evidence remain externally
  blocked as recorded in the deployment and QA runbooks; no swap proof was
  fabricated.
- At that checkpoint, the M5 candidate verdict was **NO-GO**:
  `npm run qa:base:swap` failed closed at
  `BASE_QA_LP_BOT_CREDENTIALS` (Sepolia validation also reports zero native
  USDC for all three derived QA accounts), and `npm run promote:base:sepolia`
  fails closed at `BASE_QA_SWAP_PROOF_REQUIRED`. The required candidate-bound stock-sale
  swap proof is therefore absent; the deposit proof is recorded below. The
  full-repository test command also has one
  unrelated worktree-environment failure because `FLARE_FDC_API_KEY` is not
  present; no secret was copied or synthesized to make that test green.

## M5 deposit proof — 2026-09-21

- `npm run qa:base:deposit -- --deposit-tx=0x5ea2a0ffb53e95b3b7c5adf5f4b64dfe29724a5e95d45520b04a5dff94a6bf8b`
  passed against Base Sepolia candidate digest
  `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`.
- The generated ignored artifact is
  `output/base-qa/sepolia/deposit-proof.json`. It binds the facility, disposable
  depositor, approval/deposit events, and Base Sepolia chain ID; the deposit
  reports `1,000,000` assets and `1,000,000` shares.
- Historical facility reads prove the depositor share balance increased from
  `0` before block `47108154` to `1,000,000` at that block. This completes the
  deposit-proof task. At the time of this checkpoint, the next gates were
  `qa:base:swap`, a fresh venue-fork run, and `promote:base:sepolia`.

## M5 candidate promotion — 2026-09-21

- `npm run qa:base:swap` passed against candidate digest
  `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56` and
  wrote `output/base-qa/sepolia/swap-proof.json`. The proof binds approval
  transaction `0xeb44ef8c925717217417044cd3f282336e421feeb5d867838b3f6a575b634c4b`
  and settlement transaction
  `0x156c607aeaf8a6201cbbe4bddd616331e15c9ced5333bec405b3d6491b8ffa28`, with
  order hash `0x6085b4f85eaa4973ea60cb98163cafec751df03c8016611033b6ceb1dfd81282`
  and route ID
  `0x8d52d2ab58a3a49d347fa9e7203f930b6c3601c1baf53e1ae5889688d4f306e7`.
- The live proof records `1e18` stock for `1,000,000` native-USDC units,
  exact balance conservation, zero remaining seller allowance, and zero
  router/settlement dust. The deployed `BaseQaB20` does not emit the standard
  `Approval` event, so the proof truthfully records receipt-backed `approve`
  calldata plus the allowance at the approval block; the release validator
  accepts only that exact call shape and never fabricates an event.
- The canary pins balance reads to the mined settlement block and waits for a
  newer block after approval so public load-balanced RPC responses cannot make
  a valid route look out of order. Focused release-gate coverage includes the
  receipt-backed approval path.
- A fresh `npm run test:base:venues:fork` passed all eight configured cases
  (`I-FORK-1`, `I-FORK-2`, `I-FORK-3`, `I-FORK-4A`, `I-FORK-5`, `I-FORK-6`,
  `I-FORK-7`, and `I-FORK-8`) at pinned Base block `51068301`.
- `npm run promote:base:sepolia` passed and wrote
  `contracts/base/deployments/sepolia.json`. An independent digest check
  confirms the public manifest equals the candidate digest; it remains
  `productionEligible: false`.

The M5 candidate-bound Sepolia release gates are now complete and the candidate
is promoted. Mainnet activation, facilities, external-provider settlement,
and any remaining headed-wallet evidence stay outside this promotion and remain
explicitly gated.
