---
phase: testing
title: Katon Solana Tokenized-Stock Exit Desk Test Plan and Evidence
feature: solana-tokenized-stock-desk
status: gated
date: 2026-09-16
---

# Test plan

## Deterministic unit coverage

- Amount parsing rejects JavaScript numbers, exponent notation, excess
  decimals, negative values, and unsafe floating-point conversions.
- Fee vectors cover 0/10/25 bps, floor rounding, fee-cap rejection, and gross
  less than fees.
- Registry vectors cover classic Token, Token-2022, unknown extensions,
  changed hooks, pauses, permanent delegates, confidential transfers, and
  output-mint allowlists.
- Anchor vectors cover audited bootstrap authority, distinct quorum signers,
  initialized asset/maker PDAs, derived transfer-hook validation PDA, owner and
  flags, exact ordered metas, duplicate/reserved accounts, complete live mint
  TLV hashing, validation-account hashing, Execute discriminator/amount context,
  dynamic PDA resolution, and malformed seed data that must fail closed.
- Ranking vectors cover failed simulation, malformed fee reconciliation,
  expiry with two-second safety margin, price bands, exact-input/output
  equality, and every deterministic tie-break.
- RFQ service vectors cover source identity and adapter reliability binding,
  independent simulation replacing source claims, verified maker balance amount
  and freshness, one shared three-second deadline across quote/simulation/
  balance work, live timestamp refresh, future-dated metadata, and effective
  price/impact projection.
- Manifest vectors cover canonical Ed25519 payload signing, trusted signer
  allowlists, tampering, malformed signatures, and a required solver startup
  gate.
- SDK/API vectors cover hash binding, wallet mismatch, expiry, Jupiter byte
  preservation, concurrent source collection, SSE state transitions, audit
  redaction, and receipt projection.
- Solver vectors cover manifest mismatch, stale health, flashloan-first
  selection, the 2,000 USDC prefunded cap, atomic unwind, compute limits,
  residual stock, adverse execution, and three-failure circuit breaking.

## Program and fork coverage before launch

LiteSVM/Mollusk tests must exercise classic and Token-2022 happy paths,
transfer hooks/fees/pauses/memos, duplicate mutable accounts, arbitrary CPI
attempts, wrong signer/mint/program, overflow, replay, expiry, and exact token
account deltas. Surfpool must fork real xStocks/Ondo mints, Jupiter/Raydium,
Kamino obligations, Jupiter Lend vaults, ALTs, paused tokens, oracle/session
changes, compute limits, and transaction-size boundaries. Prefix every
agent-run Solana command with `NO_DNA=1`.

## Fresh local evidence

Evidence is appended after commands are run from this worktree. A failed
dependency resolution is recorded as a release blocker, not converted into a
success claim. No signing key or transaction submission is used here.

- [x] `NO_DNA=1 npm run test:solana` — 21 tests passed (2026-09-16).
- [x] `NO_DNA=1 npm run typecheck:solana` — passed (2026-09-16).
- [x] `NO_DNA=1 npm run typecheck:solana-api` — passed (2026-09-16).
- [x] `NO_DNA=1 npm run build:solana-web` — Vite production build passed (2026-09-16).
- [x] `NO_DNA=1 cargo fmt --check --manifest-path contracts/solana-rfq/Cargo.toml` — passed (2026-09-16).
- [x] `NO_DNA=1 cargo check --manifest-path contracts/solana-rfq/Cargo.toml --offline` — passed with Anchor macro `unexpected cfg` warnings (2026-09-16).
- [x] `NO_DNA=1 cargo test --manifest-path contracts/solana-rfq/Cargo.toml --offline` — 8 unit tests passed; doc-tests passed (2026-09-16).
- [x] `NO_DNA=1 npm run check:solana:release` — scaffold checks passed; production gates remain explicit (2026-09-16).
- [x] `git diff --check` — passed (2026-09-16).

For workspace context, `NO_DNA=1 npm test` ran 373 existing tests with 367
passing. Six legacy Flare tests remain environment-bound: five require a local
WebSocket listener (sandbox `EPERM`) and one expects the absent worktree
`FLARE_FDC_API_KEY`; none exercise the Solana feature.

An ephemeral local API smoke run also returned the verified xStocks/Ondo asset
registry from `GET /v1/assets` and a `ready` quote session from
`POST /v1/quote-sessions`/`GET /v1/quote-sessions/:id`, with the private maker
winner and sanitized Jupiter comparison (2026-09-15). The temporary server was
stopped after the probe.

The repository-wide legacy `npm run typecheck` remains outside this feature's
scope and reports pre-existing Flare test/declaration errors from the Base
line; the Solana-specific projects above typecheck cleanly.

The optional `NO_DNA=1 npx ai-devkit@latest lint --feature
solana-tokenized-stock-desk` probe could not resolve the npm registry
(`ENOTFOUND` in the sandbox). The phase documents and implementation were
therefore reviewed manually against the DevKit structure; rerun the lint in a
networked CI environment before release.

The local evidence covers deterministic code and scaffold compilation only. No
wallet key, mainnet RPC submission, live issuer balance, or Surfpool fork was
used; those remain release-gated evidence items.
