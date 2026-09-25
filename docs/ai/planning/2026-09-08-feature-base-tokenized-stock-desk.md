---
phase: planning
title: Katon Base B20 Stock-to-USDC RFQ Plan
feature: base-tokenized-stock-desk
status: evidence-and-8-decimal-qa-gates-open
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
schema, ranking benchmark, qualified authenticated 600-second soak, and
injected-provider browser regression are implemented and locally validated.
One configured pinned venue-fork run passed all eight cases, but the latest
retry was blocked before execution by upstream Infura RPC errors (`-32603` and
HTTP 429 rate limits).
The Base Sepolia candidate remains non-production because the live stock-sale
proof is blocked by missing native USDC funding (all three derived QA accounts
currently report zero; the canary requires 1,000,000 units) and an unconfigured
LP bot credential; the MetaMask extension download also prevented the required
headed wallet capture. Promotion therefore remains correctly closed until
those external inputs are supplied. This is an M5 gate block, not a reason to
count deferred facility, external-provider, or Base mainnet work against the
LP-only M5 scope.

## Historical M5 execution checkpoint — 2026-09-21 stop point (superseded)

The external inputs were supplied far enough to exercise the fresh candidate,
but the user-requested run was stopped before the swap and promotion gates.
The current M5 candidate was deployed to Base Sepolia at block `47107393` with
candidate digest `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`;
`npm run smoke:base:sepolia` passed all 35 checks. The disposable depositor was
funded with 1,000,000 native-USDC units, the operator was funded for the canary,
and a dedicated LP bot id/secret with `lp` scope was configured in the ignored
local environment. No wallet secret is recorded here.

The headed MetaMask setup completed with MetaMask 13.17.0. The depositor account
connected to the dApp, the exact facility allowance was mined, and the direct
facility deposit emitted its on-chain event at block `47108154`
(`0x5ea2a0ffb53e95b3b7c5adf5f4b64dfe29724a5e95d45520b04a5dff94a6bf8b`). The
browser and QA stack are now closed. `npm run qa:base:deposit --
--deposit-tx=0x5ea2a0ffb53e95b3b7c5adf5f4b64dfe29724a5e95d45520b04a5dff94a6bf8b`
now passes against candidate digest
`8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56` and writes
the candidate-bound `output/base-qa/sepolia/deposit-proof.json`. The proof binds
the facility `0x65397D3aD2076A5d6ffE380b4A23d535449671A6`, disposable depositor
`0x23F166fD1FBd679e27B2A4c67CAD7eE0F02A31AA`, positive `1,000,000` asset and
share units, and the share balance increase from `0` to `1,000,000`.

At this stop point, the remaining gates were `npm run qa:base:swap`, a fresh
non-rate-limited venue-fork result, and `npm run promote:base:sepolia`. The QA
stack readiness probe now uses `/v1/auth/nonce` because
the LP-only Sepolia API intentionally returns 403 for `/v1/liquidations`; the
stock-sale canary also leaves standing-order `allowedTaker` unset and preserves
API error codes for diagnosis.

## M5 execution checkpoint — 2026-09-21 candidate promoted

The queued release sequence completed in order:

1. `npm run qa:base:swap` passed and materialized the candidate-bound
   `output/base-qa/sepolia/swap-proof.json` for digest
   `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`.
   The proof shows `1e18` stock sold for `1,000,000` native-USDC units,
   allowance `0`, and zero router/settlement dust.
2. A fresh pinned `npm run test:base:venues:fork` passed all eight cases at
   Base block `51068301`.
3. `npm run promote:base:sepolia` passed and wrote the public Sepolia manifest;
   its canonical digest independently matches the candidate and
   `productionEligible` remains `false`.

The candidate is now promoted for non-production Sepolia QA. Mainnet,
facility, external-provider, and broader operational approvals remain future
gates; no production enablement is implied by this checkpoint.

## Tokenized-stock demo completion checkpoint — 2026-09-23

The implementation increment adds canonical 8-decimal metadata and pinning,
Builder Code attribution, provider-native quote adapters, a locally verified
CoW EIP-712 signed-intent DTO, validated 0x wallet execution, and an evidence
API/page. 1inch execution is explicitly gated and remains deferred. No CoW
order is submitted and no Base mainnet execution is enabled.

The canonical 8-decimal registry and pinned Base state are verified. At the
pinned block, 0x returned HTTP 422 (`SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`) for
AAPLc, so there is no executable route. CoW returned HTTP 200 and the local
EIP-712 signer recovery matched the owner, but the provider marked the quote
`verified=false`; no order was submitted. A fresh 8-decimal Sepolia candidate
completed a controlled QA redemption lifecycle with verified receipts and
100,000 native-USDC units of realized profit. The candidate remains
`productionEligible=false`.

Earlier local checks recorded in the testing increment include provider tests,
Base tests, typechecks, web build, offline Foundry tests, secret scan, and diff
check. On the first handoff retry, redemption and canonical-state reads failed
at HTTP transport and the venue-fork runner crashed before executing tests.
The later continuation results below supersede the B20 and fork outcomes, but
the redemption retry still fails at RPC transport. The current
provider and redemption artifacts are ignored under
`output/base-qa`; deployment must package them or set
`KATON_BASE_EVIDENCE_DIR` to the packaged artifact directory. A deterministic
public HTTP test now covers `/v1/evidence` through an injected evidence reader.
Live 0x execution and a headed browser run against a usable provider route
remain open; 1inch and CoW execution remain disabled/deferred.

Remaining exit evidence:

- Keep the recorded 0x AAPLc authorization rejection as an open route/execution
  gate until the provider grants token access or another verified venue is
  available.
- Preserve CoW as quote/signature evidence only while `verified=false`; do not
  submit the signed intent.
- Keep 1inch marked deferred until onboarding plus a live AAPLc route passes.
- Package evidence artifacts or configure `KATON_BASE_EVIDENCE_DIR` in deployed
  environments.
- Capture a headed wallet lifecycle when a live executable provider route is
  available; the controlled QA redemption is complete and must retain that
  classification.

## Handoff continuation checkpoint — 2026-09-23

- Runtime evidence delivery is implemented and covered through `GET
  /v1/evidence` using the default file reader configured by
  `KATON_BASE_EVIDENCE_DIR`. The response test confirms raw provider bodies and
  signatures are omitted; missing artifacts remain visibly unavailable.
- Fresh local verification passed: Base tests (220), Base/API/indexer
  typechecks, web production build, offline Foundry tests (76 passed; 8 fork
  tests skipped), secret scan, global and feature AI DevKit lint, and
  `git diff --check`.
- Fresh pinned B20 validation passed for 13 assets at block `51068301` with
  zero stale feeds. The venue fork runner executed and passed all eight cases
  at that same pinned block; this replaces the earlier runner-crash result.
- The fresh controlled Sepolia redemption verifier was retried twice and
  failed at RPC transport (`RPC Request failed.`), so the earlier captured QA
  proof remains historical and was not refreshed in this continuation.
- AAPLc still has no executable provider route: 0x rejects the token with HTTP
  422; CoW reports `verified=false` and remains an unsubmitted signed intent;
  1inch is deferred. Headed wallet QA remains blocked by the absent route.
- Candidate remains non-production (`productionEligible=false`). No provider
  order submission or mainnet execution occurred.
