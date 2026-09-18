---
phase: implementation-check
title: Base Tokenized Stock Desk M5 Verdict and Phase 7 Alignment
feature: base-tokenized-stock-desk
status: m5-gate-blocked
date: 2026-09-18
---

# Outcome

The LP-only Base Sepolia M5 candidate is **NO-GO**. The implementation slices
are present and the deterministic evidence is substantially green, but the
candidate-bound live stock-sale proof and the required headed MetaMask evidence
were not produced. Promotion correctly remains closed. No receipt, wallet
capture, or proof file was fabricated.

This report separates the M5 verdict from the broader Phase 7 implementation
alignment check. Facility/blended approval, external-provider, and Base
mainnet activation work is deferred full-feature scope; it is not counted as a
failure of the LP-only M5 gate.

## M5 verdict

| Gate | Evidence | Verdict |
| --- | --- | --- |
| Server-owned preflight | `ViemBaseSwapPreflightPort` captures N-1/N canonical hashes, validates exact settlement allowance at N, serializes the router call, simulates at N, and detects a changed latest block. Focused adapter/API tests pass. | Pass |
| Approval-before-quote | `approveStockSale` targets settlement for the exact stock amount and waits for the receipt before `/v1/swaps/quote`; route submission is route-only and stale calldata is cleared. Focused UI/wallet tests and injected-provider E2E pass. | Pass |
| Stored LP routing | v2 FOK order registration, signature/state checks, server-owned ranking, serialized calldata, and internal-to-external fallback are covered by Base tests. | Pass locally |
| Economic canary | Existing candidate digest `c6e80120cc1cb9d31e5d0749a67fd54885f3e25a211c2edddb670ee5e2a2afe3` still matches deployed bytecode. Smoke proof (35 checks) and deposit proof validate. `qa:base:swap` stops at `BASE_QA_LP_BOT_CREDENTIALS`; no swap proof exists. | **Blocker** |
| Promotion | `npm run promote:base:sepolia` fails closed with `BASE_QA_SWAP_PROOF_REQUIRED`. | **Blocker** |
| Rank performance | `npm run bench:base:rank`: warmup 25, measured 100, p95 `0.143 ms`, max `1.234 ms`, RPC excluded; threshold 200 ms. | Pass |
| Authenticated soak | Qualified managed run completed at 600 seconds/concurrency 4 with SIWE and a stored signed FOK order: 197,668 requests, zero request/schema failures, quote p95 3.28 ms, negative retained growth, and negative heap slope. | Pass |
| Browser evidence | Injected-provider regression passes approval, quote review, stale handling, route-only submission, axe, keyboard, responsive, and reduced-motion checks. It is explicitly non-extension evidence. MetaMask setup reached the 13.17.0 download step but did not complete. | Partial; extension blocker |
| Venue fork | The fresh pinned run passed I-FORK-1, I-FORK-2, I-FORK-3, I-FORK-4A, I-FORK-5, I-FORK-6, I-FORK-7, and I-FORK-8 at Base mainnet block 51068301. | Pass |

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
  proof validator, but live zero-dust confirmation is necessarily pending the
  blocked canary.

Provider-native 0x/1inch, CoW, facilities, and Base mainnet activation remain
outside M5 by decision. Return to implementation only for a code deviation;
return to design if one of these deferred items requires a changed scope or
economic model. The immediate release action is operational: fund the
disposable Sepolia accounts, configure the normal LP bot credential, complete
the live canary and headed wallet flow, rerun the managed soak and non-rate-
limited venue fork, then rerun promotion and this verdict.
