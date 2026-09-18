---
phase: testing
title: Katon Base B20 Stock-to-USDC RFQ Test Plan
feature: base-tokenized-stock-desk
status: m5-gate-blocked
---

# Verification matrix

Tests must prove both the economic result and the failure behavior. A passing
test must show exact token conservation or an atomic revert; a mocked provider
or B20 token is not production evidence.

## Core and API

| Area | Required cases |
| --- | --- |
| EIP-712 | v2 domain/version, chain and verifying-contract binding, v1 replay rejection, delegated signer, bad signature |
| Auction | exact 1,000 ms window, late response exclusion, deterministic ties, gas/fee ranking, expiry |
| Blending | LP-only, facility-only, partial linear fills, LP+facility blend, capacity shortfall, FOK, min-out |
| Providers | parallel fan-out, timeout, HTTP error, malformed signature/transaction, chain/pair/recipient/amount/allowance/simulation attestation, exact sell amount |
| Orders | registration, standing capacity, on-chain fill state, cancellation, pair salt, unauthorized revoke |
| Eligibility | valid wallet-bound attestation, expiry, denied/missing provider, mainnet fail-closed |
| API security | keyless configuration, SIWE/taker binding, native-USDC enforcement, private losing prices |

## Contracts

| Area | Required cases |
| --- | --- |
| Settlement | proportional fill, FOK, overfill, expiry, fee cap, cancellation, delegated EOA/ERC-1271, pair salt |
| Router | taker sender binding, settlement allowlist/asset, LP maker identity, facility router binding, exact stock total, per-leg and aggregate min-out, stale decision, dust |
| B20/oracle | transfer authorization, pause vectors, multiplier, stale/future/zero feed, sequencer and policy failure |
| Facility | fresh price, changed multiplier, haircut, exposure cap, stale quote, missing AP path, automatic redemption lot, profit and loss, duplicate booking |
| Withdrawals | synchronous exit, adapter pull, FIFO queue, reserved assets protected during stock acquisition |
| Liquidation | API/UI gate is disabled by default; the legacy v1 funding seam is not release evidence, and a future verified adapter must prove price-bearing max-seize and surplus return |

## Integration and operational checks

- Decode every returned calldata packet and independently verify chain ID,
  router target, settlement target, allowance spender, stock/USDC addresses,
  taker, recipient, amounts, expiry, and decision block.
- Simulate the full internal transaction at the decision block. Treat a
  failed simulation, stale oracle, changed multiplier, changed B20 policy, or
  insufficient allowance as unavailable.
- Run the Base mainnet fork harness for canonical B20 behavior and venue
  conformance. Run Base Sepolia with interface-faithful mocks where a canonical
  B20 market is unavailable; never promote mock evidence as production proof.
- Measure the 1,000 ms collection window and quote-response p95 target of
  1,500 ms, excluding wallet approval/signing.
- Run the browser wallet flow for connect, SIWE, quote review, allowance,
  simulation, receipt, and failure rollback.

## Fresh command set

From the feature worktree:

```sh
npm run test:base
npm run typecheck:base
npx tsc -p tsconfig.base-api.json --noEmit
npx tsc -p tsconfig.base-indexer.json --noEmit
npm run build:base-web
FOUNDRY_OFFLINE=true forge test --root contracts/base --offline
npx ai-devkit@latest lint
git diff --check
node tools/check-base-secrets.mjs
```

Mainnet enablement additionally requires fresh provider quote measurements,
canonical-address verification, compliance approval, multisig ownership,
monitoring alerts, and small-value canary fills.

## M5 fresh validation record — 2026-09-18

The implementation checks completed in this worktree are:

- `npm run test:base`: 27 files, 182 tests passed.
- Base API and indexer typechecks, and `npm run build:base-web`: passed.
- `npm run test:solidity:base`: 76 passed, 8 intentionally skipped.
- `npm run test:base:venues:fork`: pinned matrix passed for I-FORK-1,
  I-FORK-2, I-FORK-3, I-FORK-4A, I-FORK-5, I-FORK-6, I-FORK-7, and I-FORK-8.
- `npm run bench:base:rank`: p95 0.143 ms (max 1.234 ms), excluding RPC,
  below the 200 ms gate.
- `npm run test:e2e:base`: injected-provider evidence passed, including exact
  approval, quote review, stale-route handling, and router-only submission.
  It is explicitly non-extension evidence.
- `BASE_API_SOAK_DURATION_SECONDS=600 BASE_API_SOAK_CONCURRENCY=4 npm run
  soak:base:api`: qualified managed run passed with 197,668 authenticated
  quote requests, zero request/schema failures, quote p95 3.28 ms, retained
  growth -304,336 bytes, and heap slope -97,615.78 bytes/minute. The default
  deterministic quote deadline is duration-aware so it remains valid for the
  complete run.
- `node tools/check-base-secrets.mjs` and `git diff --check`: passed.

The Sepolia stock-sale canary is not a passing test: `qa:base:validate` reports
zero native Sepolia USDC for the depositor and LP, and the normal LP bot
credential is not configured. `npm run qa:base:swap` therefore fails closed
with `BASE_QA_LP_BOT_CREDENTIALS`; no `swap-proof.json` exists and promotion
correctly fails closed with `BASE_QA_SWAP_PROOF_REQUIRED`.

The required managed soak completed with its qualifying defaults (600 seconds,
concurrency 4, authenticated SIWE, stored signed FOK order), and the pinned
venue-fork matrix also completed successfully at block 51068301.
