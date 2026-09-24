---
phase: planning
title: Katon Solana Tokenized-Stock Exit Desk Implementation Plan
feature: solana-tokenized-stock-desk
status: historical_non_canonical
date: 2026-09-15
---

> **Non-canonical.** Historical evidence only. The sole behavioral and acceptance contract is [Canonical Seller Desk full specification](https://github.com/mangekyou-labs/katon/issues/16).

# Implementation plan

The work is isolated on `feature-solana-tokenized-stock-desk` in
`.worktrees/feature-solana-tokenized-stock-desk`; the Base worktree is out of
scope. This dossier is not the source of truth.

## Work packages

- [x] Create isolated worktree and deferred brand handoff.
- [x] Capture cited requirements and design dossiers dated 2026-09-15.
- [x] Implement pure bigint amounts, issuer/token registry checks, eligibility,
  quote sprint state, deterministic ranking, fee caps, and audit redaction.
- [x] Implement SDK API client, Wallet Standard signer boundary, v0 payload
  hashing, cryptographic signer binding, and winner-only execution binding.
- [x] Implement a Nest-compatible HTTP/SSE coordination seam with mock sources
  for local/LiteSVM and devnet-only demonstrations.
- [x] Implement the brokerage seller surface with explicit loading, no-quote,
  expiry, offline, review, execution, receipt, and audit states.
- [x] Implement the Anchor settlement boundary and replay-resistant receipt
  schema; keep registry/governance checks in the program account model.
- [x] Implement manifest-verified Kamino/Jupiter Lend solver decisions,
  flashloan-first funding, prefunded cap, atomic simulation gate, and breakers.
- [x] Remediate the review findings: durable liquidation safety restoration and
  leases, authoritative profit derivation, private-maker fee policy, terminal
  SSE delivery, expiry payload purge, commitment evidence, canonical transaction
  parsing, shared deployment identity, and zero-residual transition checks.
- [x] Split the Anchor program into cohesive registry, transfer-hook, state,
  error, event, and test modules while preserving its ABI.
- [ ] Resolve the production Anchor/Codama generated client and audited IDLs at
  release time; local dependencies are intentionally not fetched in this
  offline worktree.
- [ ] Complete legal/compliance, independent audit, Surfpool mainnet fork
  evidence, and seven-day shadow-mode gates before any mainnet submission.

## Validation order

1. `git diff --check` and worktree isolation check.
2. Core and solver unit tests with deterministic vectors.
3. Typecheck each new TypeScript package and build the web app.
4. Anchor formatting/checks when the pinned toolchain and registry cache are
   available; never submit a transaction from this worktree.
5. Record fresh command output in the implementation/testing dossiers.

The local Anchor dependency lock is now available and formatting plus offline
`cargo check` pass. Production Codama generation, audited external IDLs, and
mainnet fork evidence remain intentionally unchecked release work rather than
being represented by local mocks.
