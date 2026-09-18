---
phase: implementation
title: Katon Base B20 Stock-to-USDC RFQ Implementation
feature: base-tokenized-stock-desk
status: m5-gate-blocked
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

## M5 gate validation — 2026-09-18

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
  the rank benchmark, the authenticated 600-second quote soak, the pinned
  venue-fork matrix, the injected-provider non-extension browser regression,
  and the secret scan. The live canary and extension-backed wallet evidence
  remain externally blocked as recorded in the deployment and QA runbooks; no
  swap proof was fabricated.
- The M5 candidate verdict is **NO-GO**: `npm run qa:base:swap` fails closed at
  `BASE_QA_LP_BOT_CREDENTIALS`, and `npm run promote:base:sepolia` fails closed
  at `BASE_QA_SWAP_PROOF_REQUIRED`. The required candidate-bound stock-sale
  proof is therefore absent. The full-repository test command also has one
  unrelated worktree-environment failure because `FLARE_FDC_API_KEY` is not
  present; no secret was copied or synthesized to make that test green.
