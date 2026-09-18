---
phase: planning
title: Katon Base B20 Stock-to-USDC RFQ Plan
feature: base-tokenized-stock-desk
status: m5-gate-blocked
---

# Delivery plan

The implementation is a breaking v2 product slice. Work is ordered so the
economic seams are testable before any mainnet integration is enabled.

## Milestone 1 — core auction and signing (complete)

- Define `SwapOrder`, v2 EIP-712 hashing, route/quote types, and deterministic
  ranking.
- Enforce one-second collection cutoff, exact pair/amount, FOK behavior,
  conservative gas, tie-breaks, partial fills, and internal blending.
- Add proportional fill accounting, delegated signer state, cancellation, pair
  salt invalidation, and standing-order capacity tracking.

## Milestone 2 — keyless API and providers (complete)

- Add `POST /v1/swaps/quote` and `/v1/swap-orders` with wallet-bound auth.
- Fan out configured makers, facilities, 0x, 1inch, and Aerodrome adapters in
  parallel with bounded timeouts and strict packet parsing.
- Preserve external provider transactions unchanged and keep losing maker bids
  private.
- Add fail-closed SIWE/eligibility, native-USDC, deadline, signature, and
  simulation preflight gates.

## Milestone 3 — Base contracts and facility accounting (complete)

- Add v2 swap settlement and taker-submitted blended router execution.
- Bind the common allowlisted settlement contract separately from LP maker
  identities; require its native-USDC asset to match the route.
- Add facility price/capacity quotes, B20 multiplier and stale-feed controls,
  exposure caps, AP redemption paths, automatic redemption lots, and realized
  P/L accounting.
- Keep liquidation route support price-bearing and separate; do not enable it
  without an official B20 lending adapter.

## Milestone 4 — indexer, SDK, and retail UI (complete)

- Index swap route/order fills, facility pricing, redemption lots, realized
  gains/losses, and optional fields without corrupting existing liquidation
  projections.
- Add SDK v2 order serialization, quote requests, registration, and revocation.
- Add the B20 stock-sale page with SIWE, quote review, source/expiry/gas/min-out
  disclosure, allowance targeting, simulation, and internal route submission.

## Milestone 5 — verification and external rollout (in progress)

- Run Vitest, TypeScript, Foundry, lint, secret scans, and UI builds on every
  change.
- Run Base mainnet-fork and Base Sepolia tests with canonical B20 behavior,
  exact token conservation, and p95 quote latency evidence.
- Add 0x/1inch measured alternatives, then CoW protected orders.
- Enable facilities only after AP/redemption documents, loss handling, and
  monitoring are approved.
- Enable mainnet only after compliance review, verified addresses, multisig
  controls, simulation, monitoring, and small-value canary fills.

## Decision log

| Decision | Rationale |
| --- | --- |
| B20 → native USDC only first | Keeps policy, recipient, and settlement invariants explicit. |
| 1,000 ms private auction | Gives institutional makers a deterministic window without exposing losing prices. |
| Internal blending only | Katon can make multiple legs atomic; external venues own their settlement. |
| Taker submits | The seller controls recipient/min-out and avoids a winning-funder custody race. |
| AP-gated facility quotes | Coinbase redemption is conditional and institutional; inventory must have a committed exit. |
| Breaking v2 schema | Prevents liquidation-domain signatures and old calldata from replaying. |
| Mainnet disabled by default | Production evidence and compliance are operational requirements, not API flags alone. |

## Exit criteria

- Every requirements acceptance criterion has a focused test and a traceability
  entry in `docs/TECHNICAL_ARCHITECTURE.md`.
- Fresh commands show all tests/typechecks/builds/lint passing.
- Documentation and code agree that the current thesis is a B20 stock sale for
  native USDC, with no contradictory legacy product statement.

## M5 execution checkpoint — 2026-09-18

The authoritative preflight, approval-before-quote seller sequence, proof
schema, ranking benchmark, qualified authenticated 600-second soak, pinned
venue-fork matrix, and injected-provider browser regression are implemented
and locally validated. The Base Sepolia candidate remains non-production
because the live stock-sale proof is blocked by missing native USDC funding
and an unconfigured LP bot credential; the MetaMask extension download also
prevented the required headed wallet capture. Promotion therefore remains
correctly closed until those external inputs are supplied. This is an M5 gate
block, not a reason to count deferred facility, external-provider, or Base
mainnet work against the LP-only M5 scope.
