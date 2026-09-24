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
  gating, authoritative market discovery startup gate, atomic simulation,
  funding order, and circuit breakers.

The local API sources are explicitly mock adapters. They are useful for
deterministic UI and contract-shape tests only; they are not mainnet liquidity
or a custody path.

## Security invariants implemented

1. Amounts cross the API as decimal strings and become `bigint` only in core.
2. Unknown or changed Token-2022 extensions, hooks, pauses, delegates, exact
   metadata pointers, issuer authorities, Ondo issuer/JIT fingerprints, and
   registry entries fail closed. The Anchor program hashes the complete live
   Token-2022 TLV buffer and binds it to the registry.
3. Registry and maker PDAs are initialized by explicit instructions. Governance
   bootstrap and subsequent changes require the pinned Squads vault signer;
   guardian instructions can only pause. Local tests use a separate generated
   signer fixture. Deployment builds pin the read-only confirmed Devnet vault
   authority; this address check does not certify an RFQ binary or governance
   transaction.
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
10. Liquidation is dormant unless manifest and market discovery pass, a
    separate delayed Squads enablement verifier proves the applied action, the
    approved solver identity matches the configured worker, durable safety
    state restores, and the remaining opportunity checks pass.

## Known release work

Production replaces the local providers with RPC, Redis/Mongo, Jupiter,
maker-stream, Kamino, Jupiter Lend, trusted sender, Codama, and audited IDL
adapters only after the release gates in the requirements and testing records.

## Maker and operator boundary implementation (2026-09-23)

Provisioned maker and operator keys obtain short-lived HMAC role sessions from
signed one-time challenges. Maker WebSocket messages reauthenticate the
session on every message; quote commitments include the quote terms and
transaction hash, and the API checks the maker's partial v0 signature before
the quote reaches sprint collection. Streamed quotes must match the active
request terms. Operator controls stop intake or disable sources, and maker
views are identity-scoped. The headless maker remains the local fixture.

Reference Policy is exposed as an independent dual-source observation. The
local fixture is deterministic; collection uses the licensed-primary value,
requires a fresh agreeing independent observation, and fails closed for every
non-ready state. Production stays unavailable because no licensed provider
adapter is configured. Registry price fields are metadata, not quote inputs.

Governance now uses the configured compile-time vault authority for bootstrap
and later vault-signed actions. The local test fixture remains separate from
deployment builds. A read-only Devnet `solana program show` resolved the
deployed RFQ program's upgrade authority to
`8LmRZFAUJxxXpDXKUPH9B5J3dzDvePQJDPHDP1FNLJgf`, matching the existing Squads
vault reported by the deployment handoff. `build.rs` pins this Devnet authority
and requires the deployment configuration to match; the fixture is never
accepted for deployment builds.

The delayed queue supports asset state, maker allowlists and pause state,
economics and quote limits, authority rotation, and program unpause. Its digest
commits to the serialized action, proposal ID, target, expected version,
proposing vault, creation time, and apply time. Apply and cancel require the
configured vault signer, stale target versions are rejected, and the guardian
handlers remain pause-only. Settlement enforces the governed fee, maximum fee,
quote lifetime, and stock input limit.

The operator API now has validated, read-only readers for Anchor-owned asset,
maker, governance, and queued-action accounts plus trusted signed deployment
manifests. Account owner, executable flag, base64 encoding, discriminator,
serialized fields, and collection bounds are checked before projection. The
web surface shows observed or explicit `unavailable` states. With a trusted
signed manifest and configured RPC, the reader compares live lender, RFQ, and
Squads v4 bytecode hashes and upgrade authorities with the signed identities;
it also checks the RFQ GovernanceConfig vault, Squads multisig owner and
discriminator, create-key PDA, and derived vault PDA. No governance write route
exists in the operator browser or API. Ondo and Liquidation Execution remain
separately gated. Production maker balance verification still has no provider,
and production Reference Policy inputs remain unavailable.

The RFQ-specific Surfnet validator scenario passes bootstrap, queue,
apply/cancel, stale-version, generated-member-signer rejection, and
guardian-pause boundaries. Its generated keypair is a direct RFQ vault signer;
it does not demonstrate Squads threshold approval, member authorization, or
PDA signing. A follow-up official build of the pinned Squads v4 source now
completes in `/private/tmp/ticket14-squads/source-pinned`, but its executable
hash `d48660833989ecea3145ff726164fe640bd90696f03ce00dfd0cda258cbf2fac`
differs from the fresh Devnet hash
`57a8d2d7ef5409df250415135f29f83da876e5adf5a2e5b5752e323cfb4f2f74`. The
local hash matches the current Mainnet executable hash. The real local Squads
integration remains gated; this binary was not loaded into Surfnet. See the
testing dossier for the pinned build inputs and read-only provenance checks.
The user accepted the local Seller Desk Wallet Standard walkthrough on
2026-09-23 after a 1 lamport proof transfer; this verifies the local review
flow, not stock or stablecoin settlement. Production maker balance and
licensed Reference Policy inputs remain unavailable and fail closed. The
Devnet authority pin is a read-only account identity observation, not bytecode
or governance-action evidence.

The program crate includes Anchor's required `idl-build` feature; optimized
program compilation and IDL generation both pass. See the testing dossier for
the current local review runs and remaining evidence gate.

## Fresh local verification (2026-09-16)

The deterministic Vitest suite now covers 22 Solana tests, including source
identity binding, independent simulation, verified maker liquidity, a shared
three-second collection deadline, live clock refresh, manifest signature
verification plus the immutable lender-discovery startup gate, and exact price
fields. Solana core/API typechecks and the
seller/maker/operator Vite bundle build are part of the release baseline. The
Anchor workspace covers eight offline unit tests for governance bootstrap,
registry/hook invariants, live mint TLV binding, Execute-context resolution,
and malformed hook data; upstream Anchor macro `unexpected cfg` warnings are
the only expected compiler warnings. The release scaffold check and
`git diff --check` also pass. No signing key or transaction was used. The
optional DevKit lint could not resolve the npm registry (`ENOTFOUND` in the
sandbox), so it remains a networked-CI gate. Mainnet manifests, real
issuer/venue adapters, Surfpool fork evidence, independent audit, and
legal/compliance approval remain gated.

The manual credential handoff is `npm run setup:solana:credentials`. The wizard
collects cluster/RPC configuration, a wallet/deployer keypair path without
reading keypair contents, the trusted Ed25519 manifest signer, and the signed
deployment-manifest path. Kamino liquidation is permissionless, so there is no
generic liquidator token. It also optionally writes a hidden Jupiter API key to
owner-only `.env.solana.local`; keyless development access remains supported,
and the current devnet mock does not consume the key. It is not run by
automated tests.

## Seller Desk human acceptance walkthrough (2026-09-23)

The localnet acceptance UI explicitly identifies the transaction that may be
signed as a 1 lamport System Program SOL transfer. It displays the recipient,
fee payer, `solana:localnet` cluster, signer count, and the quote-only stock and
stablecoin figures separately. The client decodes the frozen v0 message and
blocks signing unless it matches the expected proof-transfer shape and current
wallet. It checks the message again immediately before invoking the wallet.

The pre-sign simulation displayed by the demo API is a fixed demo-provider
result, not an independent Surfpool simulation. The review labels it as such.
After wallet signing, the API simulates the submitted bytes against localnet
before sending. Receipt and activity copy identify this as a proof transfer;
quoted stock and stablecoin amounts are not represented as settled.

The user accepted the localnet Seller Desk walkthrough on 2026-09-23 after
driving Backpack and reading the receipt. Backpack displayed that simulation
was unsupported on the custom RPC; the user approved, and the desk showed the
1 lamport System Program proof transfer landed. Surfpool `getTransaction`
confirmed the receipt at slot 1216 with no transaction error. Acceptance is
limited to this localnet proof-transfer UX; no stock or stablecoin settlement
or mainnet readiness was accepted. Issue #15 is closed, and project map #9
records the decision.

## Browser startup recovery (2026-09-23)

The Vite client had imported the server-only `wire.ts` module just to encode a
public key as base58. Vite externalized `node:crypto` and the browser failed at
runtime. Base58 encoding now lives in a browser-safe module; the server wire
module re-exports it to preserve existing callers. The Seller Desk loads in a
real browser again. Wallet connection and signing were not exercised.

## Ticket 14 Squads governance harness: initial blocked checkpoint (2026-09-23)

Historical checkpoint. The matching-Devnet-hash preflight described below was
revised after its first run showed that deployment identity and local behavior
were separate questions. The completed local integration and current
provenance gate are recorded in the later update in this dossier.

`tools/solana-governance-validator-test.mjs` is now the real Squads acceptance
path. It derives a 2-of-3 multisig vault PDA, pins that address into the local
RFQ build, and expresses RFQ bootstrap and later governance actions as Squads
vault proposals. It checks that one approval and a nonmember cannot execute,
that two member approvals do execute, and then covers the 24-hour delay,
early apply rejection, successful apply, stale-version rejection, and cancel.
Before building or starting Surfnet, it checks the official clean Squads source
checkout, pinned revision, and SDK version, and requires a local executable
hash that matches the live Devnet program hash.
`tools/solana-rfq-only-governance-validator-test.mjs` retains the
generated-signer RFQ test with an explicit RFQ-only label.

The program source is pinned at official Squads v4 revision
`64af7330413d5c85cbbccfd8c27a05d45b6e666f`; the Node-compatible SDK is pinned
to `@sqds/multisig@2.1.4`. The official `solana-verify` build did not produce a
local binary: Docker Desktop's metadata/content store returned I/O errors on a
host data volume with 1.4 GiB free. No matching local hash or Squads proposal
execution is claimed. Ticket 14 remains open pending a successful verified
build and local run; details and hashes are in the testing dossier.

## Ticket 14 governance integration update (2026-09-23)

The Squads harness now gates the local behavior run on a clean official source
checkout at revision 64af7330413d5c85cbbccfd8c27a05d45b6e666f, the pinned
Node-compatible SDK and lockfile integrity, the documented source build
procedure, the expected local executable and raw SHA-256 hashes, and the
canonical Squads program identity. The live Devnet hash is read-only evidence
and is reported separately; it does not block local behavior coverage.

The actual official Squads v4 executable ran in Surfnet. A real 2-of-3
multisig bootstrapped the RFQ vault authority and executed delayed governance
actions. The run covered one-approval and nonmember rejection, vault-PDA
signing, queue hash/target/version/delay, early-apply failure, delayed apply,
stale queue/apply rejection, immediate cancellation, direct member and
unrelated-PDA rejection, and the Guardian's pause-only boundary. The harness
records signatures, expected program errors, and account state in
[the local governance evidence report](../testing/evidence/2026-09-23-ticket14-squads-local.json).

The Squads ProgramConfig singleton was seeded as Surfnet genesis state because
the official one-time initialization instruction requires Squads' unavailable
team key. The official program binary still handled multisig creation,
proposals, approvals, vault execution, and every RFQ governance instruction.
This fixture does not stand in for threshold approval or vault-PDA signing.

The pinned executable hash is
d48660833989ecea3145ff726164fe640bd90696f03ce00dfd0cda258cbf2fac; its raw
SHA-256 is ae9587376b1d5febf83f558b87ed876cdd4bdcc9ad877f257992287fb09d0b11.
The observed Devnet hash is
57a8d2d7ef5409df250415135f29f83da876e5adf5a2e5b5752e323cfb4f2f74, so this
run makes no claim that the local executable is deployed on Devnet.

The clean official current-source checkout is revision
af94153ff77a28b6effe46b9c94baaa93742b48c. Its README documents Rust 1.85 and a
Cargo.lock version-3 workaround; the pinned-image build attempt stopped at
Cargo metadata because the untouched checkout has lockfile version 4 and
produced no executable. The current-source checkout therefore does not explain
the Devnet hash difference. That provenance gap remains open, and no Devnet or
Mainnet transaction was sent.

## Local Anchor/LiteSVM settlement implementation update (2026-09-24)

Settlement now enforces the signed quote's inclusive issue-to-expiry window,
the independent 30-second hard limit, governed lifetime and stock-input limits,
governed fee equality, and the maximum fee cap. For Token-2022 mints with a
transfer-fee extension, the live current and scheduled fee rates must both be
zero; the program uses `transfer_checked_with_fee` with an expected fee of
zero so a fee change fails closed. After both token transfers, the program
checks exact stock debit and credit, exact maker stable debit and fee credit,
and the seller's minimum stable receipt before persisting the quote-bound
FillReceipt.

For a Token-2022 destination with MemoTransfer enabled, the seller supplies the
canonical executable Memo program account. The program emits a Memo CPI with
the quote ID immediately before the stock transfer CPI. That account is
removed from the registered transfer-hook account list, which continues to be
validated and passed in its exact registered order. Destinations without the
active extension do not require a Memo program account.

`contracts/solana-rfq/programs/solana-rfq/tests/litesvm_settlement.rs` exercises
these public Anchor instructions through LiteSVM. The current suite has 16
passing tests for classic and Token-2022 settlement, rollback and exact deltas,
quote replay/window boundaries, guardian pause, receipt cleanup, fee and
extension rejection, hook invocation and malformed hook accounts, memo CPI
ordering, and the Anchor governance queue/apply delay. Command output and the
scope limits are recorded in the testing dossier. This is local runtime
evidence; its governance fixture does not execute a Squads v4 proposal, and it
does not resolve the Devnet executable-provenance, AC-052, or AC-053 gates.

## Ticket 14 public event privacy correction (2026-09-24)

The Quote Sprint SSE route now publishes only the sprint ID and state. It had
serialized the full session, which could expose Seller request terms, a Private
Maker's source ID and quote ID, and the reusable partially signed winner bytes
to any listener with the sprint ID. The authoritative GET remains the review
package path used by the local Seller client. The route change follows the
canonical public-SSE and role-isolation boundary in issue #16; it does not
change transaction construction or Seller review copy.

Current map #9 excludes Mainnet and Squads production enablement and release
certification. AC-052 and Devnet Squads executable provenance therefore remain
separate release obligations, while ticket #14 still requires its local Maker,
operator, governance, and program evidence. AC-053 is a wording and assertion
boundary: the RFQ queue does not delay loader upgrades.

## Ticket 14 maker availability and role-view correction (2026-09-24)

An authenticated maker heartbeat now updates last-seen time without changing
advertised availability. Only a fresh advertisement can make the source
available after the maker withdrew it or a stream disconnected. The stream
closes when its five-minute role session expires, so an idle expired connection
cannot remain a healthy quote source. Maker and operator browser data is tied
to the connected wallet's in-memory role session; disconnecting or switching
wallets hides the prior role data and requires a new signed challenge after
reload. This keeps the UI within the role-isolation boundary in AC-057/071.

The operator's source-disable action now covers configured Jupiter and Private
Maker sources. Collection and final ranking exclude disabled sources, and an
already-issued winner is rejected at authorization or execution after its
source is disabled. The Maker quote-rejection count now excludes malformed
heartbeat, advertisement, and other non-quote stream messages.
