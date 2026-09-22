---
phase: implementation-check
title: Base Tokenized Stock Desk M5 Verdict and Phase 7 Alignment
feature: base-tokenized-stock-desk
status: m5-candidate-promoted
date: 2026-09-21
---

# Outcome

The LP-only Base Sepolia M5 candidate is now **PROMOTED FOR NON-PRODUCTION QA**.
The candidate-bound live stock-sale proof, fresh pinned venue-fork run, and
promotion gate all passed. The public manifest has the exact candidate digest,
but `productionEligible` remains `false`; this is not a Base mainnet approval.
The injected-provider browser evidence remains separate from extension-backed
wallet evidence, and no receipt, wallet capture, or proof file was fabricated.

This report separates the M5 verdict from the broader Phase 7 implementation
alignment check. Facility/blended approval, external-provider, and Base
mainnet activation work is deferred full-feature scope; it is not counted as a
failure of the LP-only M5 gate.

## Historical M5 verdict — 2026-09-18 (superseded)

| Gate | Evidence | Verdict |
| --- | --- | --- |
| Server-owned preflight | `ViemBaseSwapPreflightPort` captures N-1/N canonical hashes, validates exact settlement allowance at N, serializes the router call, simulates at N, and detects a changed latest block. Focused adapter/API tests pass. | Pass |
| Approval-before-quote | `approveStockSale` targets settlement for the exact stock amount and waits for the receipt before `/v1/swaps/quote`; route submission is route-only and stale calldata is cleared. Focused UI/wallet tests and injected-provider E2E pass. | Pass |
| Stored LP routing | v2 FOK order registration, signature/state checks, server-owned ranking, serialized calldata, and internal-to-external fallback are covered by Base tests. | Pass locally |
| Economic canary | Existing candidate digest `c6e80120cc1cb9d31e5d0749a67fd54885f3e25a211c2edddb670ee5e2a2afe3` still matches deployed bytecode. Smoke proof (35 checks) and deposit proof validate. `qa:base:swap` stops at `BASE_QA_LP_BOT_CREDENTIALS`; no swap proof exists. | **Blocker** |
| Promotion | `npm run promote:base:sepolia` fails closed with `BASE_QA_SWAP_PROOF_REQUIRED`. | **Blocker** |
| Rank performance | `npm run bench:base:rank`: warmup 25, measured 100, p95 `0.087 ms`, max `0.672 ms`, RPC excluded; threshold 200 ms. | Pass |
| Authenticated soak | Qualified managed run completed at 600 seconds/concurrency 4 with SIWE and a stored signed FOK order: 197,306 requests, zero request/schema failures, quote p95 2.94 ms, retained growth -357,408 bytes, heap slope -28,142.96 bytes/minute, and 21 post-GC samples. | Pass |
| Browser evidence | Injected-provider regression passes approval, quote review, stale handling, route-only submission, axe, keyboard, responsive, and reduced-motion checks. It is explicitly non-extension evidence. MetaMask setup reached the 13.17.0 download step but did not complete. | Partial; extension blocker |
| Venue fork | One configured pinned run passed I-FORK-1, I-FORK-2, I-FORK-3, I-FORK-4A, I-FORK-5, I-FORK-6, I-FORK-7, and I-FORK-8 at Base mainnet block 51068301; the latest retry failed before execution on upstream Infura `-32603`/HTTP 429 errors for all eight cases. | Pending fresh confirmation |

Additional checks passed: Base typechecks, Base web build, Foundry Base suite
(76 passed and 8 intentionally skipped in the offline suite), AI DevKit lint,
secret scan (`files=93`), and `git diff --check`. The full repository test run
was `81` files passed / `1` failed and `544` tests passed / `1` failed; the
single failure is the pre-existing worktree environment fixture requiring
`FLARE_FDC_API_KEY`, which is absent here. No secret was copied into the
worktree to mask it.

## Phase 7 implementation alignment

### Aligned with the approved LP-only M5 scope

- The quote collection type contains maker, facility, and external quote
  packets only; provider decision/simulation metadata is rejected by the HTTP
  adapter and production composition. The server owns the decision snapshot.
- Internal route calldata is serialized from the server-ranked route and is
  simulated before it is returned. A failed internal simulation is omitted and
  the best otherwise-valid external packet remains quote-only.
- The web seller sequence has exact stock approval, receipt ordering, decision
  freshness checking, and route-only submission.
- The release validator binds smoke, deposit, and stock-sale proofs to the
  candidate digest, accounts, addresses, blocks, receipts, events, balance
  conservation, zero remaining seller allowance, and zero router/settlement
  dust.
- Mainnet is fail-closed and the Sepolia candidate is not production eligible.

### Deferred full-feature findings

These are requirements/design follow-ups, not reasons to change the LP-only M5
verdict:

- Facility and blended approvals/redemptions have contract/core seams and
  local coverage, but no live AP/redemption deployment evidence or approved
  operational policy is present.
- Live HTTP-maker verification and external 0x/1inch/CoW packet verification
  are fail-closed parser paths only; no production endpoint measurement or
  external settlement proof was run.
- Recipient eligibility and Base mainnet activation remain approval-gated and
  intentionally unverified in this M5 candidate.
- Ranking ties are deterministic in core tests, but no live multi-provider tie
  observation is part of the candidate evidence.
- Router dust behavior is covered by local contract tests and the stock-sale
  proof validator. The historical checkpoint lacked live confirmation; the
  promoted candidate proof now records zero router and settlement dust.

Provider-native 0x/1inch, CoW, facilities, and Base mainnet activation remain
outside M5 by decision. Return to implementation only for a code deviation;
return to design if one of these deferred items requires a changed scope or
economic model. The immediate release action is to retain the promoted
candidate as non-production, complete any separately required headed-wallet
capture, and keep mainnet disabled until the independent compliance,
canonical-address, multisig, monitoring, and small-value canary gates are
approved.

## Current M5 reconciliation — 2026-09-21

| Gate | Evidence | Verdict |
| --- | --- | --- |
| Economic canary | `qa:base:swap` produced `output/base-qa/sepolia/swap-proof.json` for candidate digest `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`; approval and settlement receipts are `0xeb44ef8c925717217417044cd3f282336e421feeb5d867838b3f6a575b634c4b` and `0x156c607aeaf8a6201cbbe4bddd616331e15c9ced5333bec405b3d6491b8ffa28`. Positive `1e18` stock/`1,000,000` USDC, exact conservation, zero allowance, and zero dust validate independently. | Pass |
| Approval evidence | Deployed QA B20 omitted the standard `Approval` event. The proof records receipt-input `approve` calldata and allowance-at-receipt-block; the validator checks canonical selector/padding, spender, amount, receipt hashes, and all receipt/event block links. | Pass; truthful call evidence |
| Venue fork | Fresh pinned `npm run test:base:venues:fork` passed all eight configured cases at Base block `51068301`. | Pass |
| Promotion | `npm run promote:base:sepolia` passed; `contracts/base/deployments/sepolia.json` independently hashes to the candidate digest and remains `productionEligible: false`. | Pass; non-production |
| Browser evidence | Injected-provider regression remains green. The headed MetaMask lane is separate evidence; the Sepolia depositor flow produced the deposit receipt, but no additional extension capture is claimed here. | Partial; follow-up |

The implementation matches the approved LP-only M5 design for the promoted
candidate. The remaining items are production or separately scoped wallet-
evidence gates, not blockers to this candidate-bound promotion.
