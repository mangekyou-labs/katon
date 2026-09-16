---
phase: implementation
title: Katon Solana Tokenized-Stock Exit Desk Implementation Record
feature: solana-tokenized-stock-desk
status: in_progress
date: 2026-09-16
---

# Implementation record

## Delivered boundaries

The implementation is deliberately split into boundaries that can be replaced
by production adapters without changing product semantics:

- `packages/solana-core`: integer-only monetary math, issuer/Token-2022
  registry preflight, eligibility, candidate validation/ranking, state and fee
  invariants.
- `packages/solana-sdk`: fetch-based API client, Wallet Standard-compatible
  signer interface, v0 transaction hashing and exact-payload validation.
- `apps/solana-api`: in-memory local source/provider adapters, concurrent quote
  session service, sanitized SSE, winner-only forwarding, and receipt model.
- `apps/solana-web`: brokerage-clear `/trade` surface with an explicit audit
  drawer and review/sign/receipt states. Every local route carries a visible
  `LOCAL MOCK MODE` disclosure, and quote/review/receipt views show effective
  price and price impact. `brand.md` records the intentionally deferred palette
  handoff.
- `contracts/solana-rfq`: Anchor `settle_private_quote`, Token Interface
  checked transfers, exact transfer-hook account metas and Execute context,
  live Token-2022 TLV hashing, quorum-gated PDA initialization, fee cap, delta
  checks, FillReceipt PDA, and permissionless post-grace close to the original
  payer.
- `services/solana-liquidator`: Ed25519 manifest signature verification against
  an explicit trusted-key allowlist, lender/flashloan program IDs, opportunity
  gating, atomic simulation, funding order, and circuit breakers.

The local API sources are explicitly mock adapters. They are useful for
deterministic UI and contract-shape tests only; they are not mainnet liquidity
or a custody path.

## Security invariants implemented

1. Amounts cross the API as decimal strings and become `bigint` only in core.
2. Unknown or changed Token-2022 extensions, hooks, pauses, delegates, and
   registry entries fail closed. The Anchor program hashes the complete live
   Token-2022 TLV buffer and binds it to the registry.
3. Registry and maker PDAs are initialized by explicit instructions. Governance
   bootstrap is restricted to the audited compile-time bootstrap authority, and
   asset/maker setup requires two distinct members of the configured 2-of-3
   quorum.
4. Transfer-hook settlement checks the derived validation PDA, owner and flags,
   exact ordered account metadata, the live validation-account data hash, and
   the dynamic Execute discriminator/amount context before the Token CPI.
5. Quote collection races sources within one shared three-second deadline,
   binds source identity and adapter reliability, replaces source simulation
   claims with independent simulation, and requires fresh verified maker
   balance evidence before ranking.
6. Rank order is net output, validity, rolling reliability, then stable source
   ID; losing payloads are not included in the session response. Live operation
   timestamps are refreshed after asynchronous source work.
7. Jupiter candidates keep their returned transaction bytes and Katon fee is
   zero. Private candidates compute floor(gross × bps / 10,000), capped at 25.
8. Execute checks seller wallet, expiry, and the hash of the issued winner
   payload before selecting the Jupiter `/execute` or private sender boundary.
9. The Anchor program requires seller/maker signatures and registry accounts,
   performs checked Token/Token-2022 transfers, verifies deltas, and records a
   quote-ID receipt to prevent replay.
10. Liquidation is dormant on manifest mismatch, including an invalid or
    untrusted Ed25519 manifest signature, stale health, non-atomic unwind,
    compute overflow, residual inventory, or a tripped breaker.

## Known release work

Production replaces the local providers with RPC, Redis/Mongo, Jupiter,
maker-stream, Kamino, Jupiter Lend, trusted sender, Codama, and audited IDL
adapters only after the release gates in the requirements and testing records.

## Fresh local verification (2026-09-16)

The deterministic Vitest suite now covers 20 Solana tests, including source
identity binding, independent simulation, verified maker liquidity, a shared
three-second collection deadline, live clock refresh, manifest signature
verification, and exact price fields. Solana core/API typechecks and the
seller/maker/operator Vite bundle build are part of the release baseline. The
Anchor workspace covers seven offline unit tests for governance bootstrap,
registry/hook invariants, live mint TLV binding, Execute-context resolution,
and malformed hook data; upstream Anchor macro `unexpected cfg` warnings are
the only expected compiler warnings. The release scaffold check and
`git diff --check` also pass. No signing key or transaction was used. The
optional DevKit lint could not resolve the npm registry (`ENOTFOUND` in the
sandbox), so it remains a networked-CI gate. Mainnet manifests, real
issuer/venue adapters, Surfpool fork evidence, independent audit, and
legal/compliance approval remain gated.

The manual credential handoff is `npm run setup:solana:credentials`. It writes
cluster/RPC, keypair path, trusted manifest signer, signed manifest path, and a
hidden liquidator token to owner-only `.env.solana.local`; it never reads or
prints keypair contents and is not run by automated tests.
