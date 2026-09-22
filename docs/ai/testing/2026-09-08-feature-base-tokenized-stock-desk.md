---
phase: testing
title: Katon Base B20 Stock-to-USDC RFQ Test Plan
feature: base-tokenized-stock-desk
status: m5-candidate-promoted
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

## Historical M5 fresh validation record — 2026-09-18 (superseded)

The implementation checks completed in this worktree are:

- `npm run test:base`: 27 files, 182 tests passed.
- Base API and indexer typechecks, and `npm run build:base-web`: passed.
- `npm run test:solidity:base`: 76 passed, 8 intentionally skipped.
- `npm run test:base:venues:fork`: one configured pinned run passed for
  I-FORK-1, I-FORK-2, I-FORK-3, I-FORK-4A, I-FORK-5, I-FORK-6, I-FORK-7,
  and I-FORK-8; the latest retry failed before execution because the upstream
  Infura endpoint returned `-32603` internal errors and HTTP 429 responses for
  all eight cases.
- `npm run bench:base:rank`: warmup 25, measured 100, p95 0.087 ms (max
  0.672 ms), excluding RPC, below the 200 ms gate.
- `npm run test:e2e:base`: injected-provider evidence passed, including exact
  approval, quote review, stale-route handling, and router-only submission.
  It is explicitly non-extension evidence.
- `npm run soak:base:api`: qualified managed run passed with 600 seconds,
  concurrency 4, request interval 10 ms, 197,306 authenticated quote
  requests, zero request/schema failures, quote p95 2.94 ms, retained growth
  -357,408 bytes, heap slope -28,142.96 bytes/minute, and 21 post-GC samples.
  The deterministic quote deadline is duration-aware so it remains valid for
  the complete run.
- `node tools/check-base-secrets.mjs` and `git diff --check`: passed.

At that checkpoint, the Sepolia stock-sale canary remained incomplete: the
facility deposit proof was materialized below, but the `qa:base:swap` gate had
not passed and no `swap-proof.json` existed. Promotion was correctly closed
with `BASE_QA_SWAP_PROOF_REQUIRED` until the candidate-bound swap proof and the
remaining operational evidence became available.

The required managed soak completed with its qualifying defaults (600 seconds,
concurrency 4, authenticated SIWE, stored signed FOK order). The pinned
venue-fork matrix has one successful run at block 51068301, but the latest
fresh retry was blocked before execution by upstream `-32603`/HTTP 429 errors;
release sign-off still requires a non-rate-limited confirmation.

## M5 deposit proof — 2026-09-21 (completed before final release gates)

`npm run qa:base:deposit --
--deposit-tx=0x5ea2a0ffb53e95b3b7c5adf5f4b64dfe29724a5e95d45520b04a5dff94a6bf8b`
passed with live Base Sepolia RPC access and wrote the ignored
`output/base-qa/sepolia/deposit-proof.json`. The proof is candidate-bound to
`8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`, identifies
the configured facility and disposable depositor, records positive `1,000,000`
asset/share amounts, and proves the share balance increased from `0` to
`1,000,000`. At that checkpoint, the swap proof, fresh venue-fork confirmation,
and promotion were the remaining release gates.

## M5 release-gate completion — 2026-09-21

- `npm run qa:base:swap` passed and wrote
  `output/base-qa/sepolia/swap-proof.json`, bound to candidate digest
  `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`.
  The approval and settlement receipts are
  `0xeb44ef8c925717217417044cd3f282336e421feeb5d867838b3f6a575b634c4b` and
  `0x156c607aeaf8a6201cbbe4bddd616331e15c9ced5333bec405b3d6491b8ffa28`.
- Independent release-gate validation passed for the smoke, deposit, and swap
  proofs. The swap proof records positive `1e18` stock and `1,000,000` USDC,
  seller allowance `0`, and zero router/settlement dust. Its receipt-backed
  `ApprovalCall` evidence is required because the deployed QA B20 omits the
  standard `Approval` log; the validator checks the exact mined calldata and
  allowance rather than synthesizing an event.
- A fresh pinned `npm run test:base:venues:fork` passed
  `I-FORK-1`, `I-FORK-2`, `I-FORK-3`, `I-FORK-4A`, `I-FORK-5`, `I-FORK-6`,
  `I-FORK-7`, and `I-FORK-8` at Base block `51068301`.
- `npm run promote:base:sepolia` passed. The promoted public manifest has the
  same candidate digest and remains `productionEligible: false`.

## Phase 8 fresh verification — 2026-09-22

### Local deterministic verification

The complete fresh command set passed in the feature worktree:

- `npm run test:base`: 27 test files, 184 tests passed.
- `npm run typecheck:base`: passed.
- `npx tsc -p tsconfig.base-api.json --noEmit`: passed.
- `npx tsc -p tsconfig.base-indexer.json --noEmit`: passed.
- `npm run build:base-web`: passed; Vite production build completed.
- `FOUNDRY_OFFLINE=true forge test --root contracts/base --offline`: 76
  passed, 0 failed, 8 intentionally skipped.
- `npx vitest run src/base-release-gate.test.ts`: 11 tests passed. This covers
  receipt-backed `ApprovalCall` validation, canonical ABI padding, exact
  calldata, candidate binding, receipt/event block ordering, conservation, and
  zero-dust release-gate behavior.
- `npx ai-devkit@latest lint` and the feature-scoped lint: passed.
- `git diff --check`: passed.
- `node tools/check-base-secrets.mjs`: `secret-scan=PASS files=93`.
- Read-only candidate validation passed for
  `output/base-qa/sepolia/candidate-manifest.json`: digest
  `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`, chain
  84532, block `47107393`, `releaseCandidate: true`, `stockSaleGate: true`,
  and `productionEligible: false`.
- A direct canonical-digest comparison passed between that candidate and the
  tracked `contracts/base/deployments/sepolia.json` manifest; both hash to
  `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56` and
  the promoted manifest remains `productionEligible: false`.

The executable QA-stack readiness probe reached
`base-qa-stack=READY target=sepolia dapp=http://127.0.0.1:5174
api=http://127.0.0.1:4010` using the nonce endpoint. The first attempt was
blocked by the sandbox local-listen policy (`EPERM`); the elevated retry
reached readiness and was intentionally stopped after the assertion because
the stack is a long-running process.

### Previously captured live Sepolia evidence

Phase 8 did not rerun the completed live swap or promotion. The authoritative
2026-09-21 records remain the candidate-bound deposit proof, stock-sale proof
(approval `0xeb44ef8c925717217044cd3f282336e421feeb5d867838b3f6a575b634c4b`,
settlement `0x156c607aeaf8a6201cbbe4bddd616331e15c9ced5333bec405b3d6491b8ffa28`),
fresh pinned venue-fork pass at block `51068301`, and promotion with the same
candidate digest. The stock-sale proof records positive `1e18` stock and
`1,000,000` USDC, seller allowance `0`, and zero router/settlement dust.

Phase 8 is green for the promoted non-production QA candidate. Base mainnet,
funded facilities, external provider/canonical venue evidence, and additional
headed-wallet extension evidence remain separately gated; `productionEligible`
must remain `false`.
