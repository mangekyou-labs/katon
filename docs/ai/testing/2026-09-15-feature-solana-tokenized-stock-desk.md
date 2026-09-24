---
phase: testing
title: Katon Solana Tokenized-Stock Exit Desk Test Plan and Evidence
feature: solana-tokenized-stock-desk
status: historical_non_canonical
date: 2026-09-18
---

> **Non-canonical.** Historical evidence only. The sole behavioral and acceptance contract is [Canonical Seller Desk full specification](https://github.com/mangekyou-labs/katon/issues/16).

# Test plan

## Deterministic unit coverage

- Amount parsing rejects JavaScript numbers, exponent notation, excess
  decimals, negative values, and unsafe floating-point conversions.
- Fee vectors cover 0/10/25 bps, floor rounding, fee-cap rejection, and gross
  less than fees.
- Registry vectors cover classic Token, Token-2022, unknown extensions,
  changed hooks, pauses, permanent delegates, confidential transfers, exact
  metadata pointers, issuer authorities, Ondo issuer/JIT fingerprints, and
  output-mint allowlists.
- Anchor vectors cover vault-only bootstrap and guardian pause boundaries,
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
  balance work, live timestamp refresh after review simulation and signed
  transaction validation, future-dated metadata, and effective price/impact
  projection.
- Manifest vectors cover canonical Ed25519 payload signing, trusted signer
  allowlists, tampering, malformed signatures, signed lender-program market
  binding, and a required solver startup gate.
- SDK/API vectors cover message-hash binding, cryptographic wallet-signature
  validation, wallet mismatch, malformed payloads, expiry, Jupiter byte
  preservation, concurrent source collection, SSE state transitions, audit
  redaction, and receipt projection.
- Solver vectors cover manifest mismatch, signed market identity binding, stale
  health, flashloan-first selection, the 2,000 USDC prefunded cap, atomic
  unwind, compute limits, residual stock, adverse execution, and three-failure
  circuit breaking.

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

- [x] `NO_DNA=1 npm run test:solana` — 32 tests passed (2026-09-18), including
  durable safety restoration/leases, authoritative profitability, fee caps,
  canonical legacy/v0 parsing, terminal SSE delivery, commitment evidence,
  contradictory commitment rejection, submission timestamp retention, expiry
  purge, shared deployment identity, and residual transitions.
- [x] `NO_DNA=1 npm run typecheck:solana` — passed (2026-09-18).
- [x] `NO_DNA=1 npm run typecheck:solana-api` — passed (2026-09-18).
- [x] `NO_DNA=1 npm run build:solana-web` — Vite production build passed (2026-09-18).
- [x] `NO_DNA=1 cargo fmt --manifest-path contracts/solana-rfq/Cargo.toml -- --check` — passed (2026-09-18).
- [x] `NO_DNA=1 cargo check --manifest-path contracts/solana-rfq/Cargo.toml --offline` — passed with Anchor macro `unexpected cfg` warnings (2026-09-18).
- [x] `NO_DNA=1 cargo test --manifest-path contracts/solana-rfq/Cargo.toml --offline` — 10 unit tests passed; doc-tests passed (2026-09-18).
- [x] `NO_DNA=1 npm run check:solana:release` — scaffold checks passed; production gates remain explicit (2026-09-18).
- [x] `git diff --check` — passed (2026-09-18).

For workspace context, `NO_DNA=1 npm test` ran 395 existing tests with 389
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

## Maker / operator follow-up verification (2026-09-23)

- [x] `NO_DNA=1 npm run typecheck:solana-api` — passed after role, maker stream,
  and Reference Policy changes.
- [x] `NO_DNA=1 npm run build:solana-web` — TypeScript and Vite build passed.
- [x] `NO_DNA=1 npx vitest run src/solana-maker-operator.test.ts src/solana-tokenized-stock.test.ts` —
  41 tests passed, including dual-source policy states, scoped role sessions,
  streamed quote matching, and Liquidation Execution's separate startup gate.
- [x] `cargo test --offline --manifest-path contracts/solana-rfq/Cargo.toml` —
  13 Rust unit tests and doc-tests passed; Anchor macro `unexpected cfg`
  warnings remain.
- [x] `NO_DNA=1 npm run typecheck:solana` — passed after adding explicit
  Liquidation Execution gate statuses.
- [x] `cargo check --offline --manifest-path contracts/solana-rfq/Cargo.toml` —
  passed with Anchor macro `unexpected cfg` warnings.
- [x] `git diff --check` — passed.
- [x] `cargo test --offline --manifest-path contracts/solana-rfq/Cargo.toml` —
  14 Rust unit tests and doc-tests passed, including governance digest binding
  across action payload, proposal ID, target, version, vault, and timing.
- [x] `NO_DNA=1 npm run test:solana` — 36 Solana seller-flow tests passed.
- [x] `NO_DNA=1 npm run typecheck:solana-api`, `NO_DNA=1 npm run
  typecheck:solana`, and `NO_DNA=1 npm run build:solana-web` — passed.
- [x] `NO_DNA=1 npm run check:solana:release` — scaffold gate passed; the
  message still identifies runtime manifests, audit, fork evidence, and
  multisig approval as release gates.
- [x] `cargo fmt --manifest-path contracts/solana-rfq/Cargo.toml -- --check`,
  `git diff --check` — passed after final Rust formatting.
- [x] Deployment-build guard — a build with the default local authority and
  `KATON_DEPLOYMENT_BUILD=1` was rejected with the expected message.
- [x] `NO_DNA=1 npm run smoke:solana:roles` — loopback HTTP smoke passed with
  generated maker/operator identities. Cross-role access was rejected;
  unavailable evidence, operator stop-intake, maker disablement, and the
  absence of a governance write route were verified.
- [x] `NO_DNA=1 npx ai-devkit@latest lint --feature
  solana-tokenized-stock-desk` — attempted; blocked by sandbox DNS (`ENOTFOUND`
  for registry.npmjs.org).
- [x] Validator-backed governance queue/apply/cancel and pause-scope scenarios
  are recorded in the later Surfnet evidence section. The test fixture does not
  emulate Squads PDA signing, membership, or threshold approval.
- [x] Local Seller Desk Wallet Standard walkthrough on Surfpool — accepted on
  2026-09-23 after a 1 lamport localnet proof transfer and receipt review.
  Stock and stablecoin remained unsettled; this is UI and proof-transfer
  evidence, not a completed stock settlement loop.
- [ ] Real local governance-through-Squads scenario — blocked because no
  verified Squads v4 program binary is present in the worktree or local build
  artifacts. The Surfnet RFQ scenario below uses a generated direct signer and
  does not emulate Squads PDA signing, threshold approval, or membership.
- [ ] Production maker balance and licensed Reference Policy providers —
  unavailable and fail closed. Liquidation Execution remains disabled. The
  Devnet vault authority is an account identity observation; it does not
  provide runtime hashes, configure evidence readers, or prove an RFQ
  deployment or governance action.

## Human acceptance prep (2026-09-23)

- [x] `npm run build:solana-web` — TypeScript check and Vite production build passed.
- [x] `git diff --check` — passed after the review disclosure changes.
- [x] User-driven Wallet Standard walkthrough on Surfpool — seller accepted the UX on 2026-09-23 after approving the 1 lamport proof transfer and reading the desk receipt. Backpack disclosed that simulation is unsupported on the custom RPC.
- [x] Confirm user-submitted signature with localnet RPC and inspect receipt — Surfpool `getTransaction` returned slot 1216 with `meta.err: null`; the landed instruction was the 1 lamport localnet proof transfer. Stock and stablecoin remained unsettled.
- [x] `NO_DNA=1 npm run build:solana-web` — passed after isolating browser-safe base58 encoding; no `node:crypto` externalization warning.
- [x] Playwright opened `http://localhost:5173/` — page title and Seller Desk UI rendered; wallet remained disconnected. The only console error was the existing missing `/favicon.ico` request.

## Operator evidence and release gate follow-up (2026-09-23)

- [x] `NO_DNA=1 npx vitest run src/solana-maker-operator.test.ts
  src/solana-operator-evidence.test.ts src/solana-operator-routes.test.ts
  src/solana-tokenized-stock.test.ts` — 50 tests passed. Coverage includes
  account owner/discriminator/data validation, explicit unavailable states,
  trusted manifest signature handling, live lender/RFQ/Squads hash and
  authority matching, Squads PDA/account identity, role isolation, maker
  disablement, operator stop-intake, and absence of governance write routes.
- [x] `NO_DNA=1 npm run test:solana` — 36 Solana seller-flow tests passed.
- [x] `NO_DNA=1 npm run typecheck:solana-api`,
  `NO_DNA=1 npm run typecheck:solana`, and `NO_DNA=1 npm run build:solana-web`
  — passed.
- [x] `NO_DNA=1 cargo fmt --manifest-path contracts/solana-rfq/Cargo.toml
  -- --check` and `NO_DNA=1 cargo test --offline --manifest-path
  contracts/solana-rfq/Cargo.toml` — formatting passed; 14 offline Rust tests
  and doc-tests passed. Anchor emits expected `unexpected cfg` warnings.
- [x] Anchor program crate now declares the `idl-build` feature required by
  Anchor. `NO_DNA=1 anchor build --skip-lint` completes optimized SBPF
  compilation and IDL generation; expected Anchor `unexpected cfg` warnings
  remain. This builds the local-fixture program and does not deploy it.
- [x] Deployment build guard — a build with the pinned Devnet authority passed;
  configuring the local fixture for a deployment build failed with the expected
  pinned-authority mismatch.
- [x] `NO_DNA=1 anchor build --skip-lint` — optimized program and IDL generated
  successfully with the local test fixture; no deployment transaction sent.
- [x] `git diff --check` — passed.
- [x] `NO_DNA=1 npm run smoke:solana:roles` — real loopback HTTP passed for
  role authorization/isolation, explicit unavailable evidence, maker
  disablement, stop-intake, and absence of governance write routes.
- [x] `NO_DNA=1 npm run test:solana:governance-validator` — Surfnet local
  validator deployed the freshly built RFQ binary and passed bootstrap,
  delayed economics and maker allowlist policy apply after local clock travel,
  cancel, stale versions, member signer rejection, and guardian pause-only
  boundaries. The vault authority is a
  generated keypair compiled into this local test build; this verifies the RFQ
  program's signer/address checks but does not emulate Squads PDA signing,
  membership, or threshold approval. No verified local Squads program binary
  was available for the real integration scenario. The earlier
  `127.0.0.1:8899` health-check failure is superseded by this isolated local
  runtime result.
- [x] Read-only Helius Devnet `solana program show` resolved the deployed RFQ
  program's ProgramData account `tb4nZHmJkiVLozmxVwX2LKQj52vQZor8fVgMYZsb7aj`
  and upgrade authority `8LmRZFAUJxxXpDXKUPH9B5J3dzDvePQJDPHDP1FNLJgf`.
- [x] Read-only finalized Devnet history confirms that authority was set by
  Squads v4 `VaultTransactionExecute`; the inner loader log says
  `New authority Some(8LmRZFAUJxxXpDXKUPH9B5J3dzDvePQJDPHDP1FNLJgf)`. Slot
  `502834113`, transaction
  [`4MDyNsPA8vrK7m56NRp8ZJPNmpGWrhiuT3nZkjHusNkAXXVrmAodpRL4jna4tJjNhCNfxcyb1SboULSu3aMB9gkh`](https://explorer.solana.com/tx/4MDyNsPA8vrK7m56NRp8ZJPNmpGWrhiuT3nZkjHusNkAXXVrmAodpRL4jna4tJjNhCNfxcyb1SboULSu3aMB9gkh?cluster=devnet).
  The deployment build uses this existing vault pin. The lookup was read-only;
  no transaction was sent.
- [x] Read-only `gh issue view` confirmed issues 14 and 16 are both OPEN. Issue
  16 remains the behavior authority; no tracker item was changed. Ticket 14
  stays open because the verified local Squads v4 execution gate remains
  unresolved.

The operator API reader uses `SOLANA_RPC_URL`, `SOLANA_CLUSTER`,
`SOLANA_DEPLOYMENT_MANIFEST`, and `SOLANA_MANIFEST_TRUSTED_SIGNERS`. Missing or
invalid reader configuration remains explicitly unavailable. When those
inputs are configured, the reader checks signed identities against live RPC
program hashes and authorities, including the RFQ and Squads v4 programs, then
validates the configured governance vault identities. The worktree does not
contain a trusted deployment manifest or production RPC configuration, so
production observations remain unavailable. The confirmed Devnet RFQ upgrade
authority does not establish the deployed RFQ bytecode hash or a completed
governance action.

## Ticket 14 verification rerun (2026-09-23)

- [x] `NO_DNA=1 npx vitest run src/solana-maker-operator.test.ts
  src/solana-operator-evidence.test.ts src/solana-operator-routes.test.ts
  src/solana-tokenized-stock.test.ts` — 50 tests passed. The production
  Reference Policy test confirms quote collection returns
  `capability_unavailable` before invoking a quote source; the evidence tests
  cover signed live Squads runtime identity and mismatch/unavailable cases.
- [x] `NO_DNA=1 npm run test:solana` — 36 tests passed.
- [x] `NO_DNA=1 npm run typecheck:solana-api`,
  `NO_DNA=1 npm run typecheck:solana`, and
  `NO_DNA=1 npm run build:solana-web` — passed.
- [x] `NO_DNA=1 cargo fmt --manifest-path contracts/solana-rfq/Cargo.toml
  -- --check`, `NO_DNA=1 cargo check --manifest-path
  contracts/solana-rfq/Cargo.toml --offline`, and
  `NO_DNA=1 cargo test --manifest-path contracts/solana-rfq/Cargo.toml
  --offline` — passed; 14 Rust tests and doc-tests passed. Cargo reports the
  existing Anchor `unexpected cfg` warnings.
- [x] `NO_DNA=1 npm run smoke:solana:roles` — loopback HTTP passed for role
  authorization and isolation, unavailable evidence, maker disablement,
  operator stop-intake, and no governance write route.
- [x] `NO_DNA=1 npm run test:solana:governance-validator` — the local Surfnet
  validator deployed the RFQ binary and passed its bootstrap, delayed queue
  apply/cancel, stale-version, member-signer rejection, and guardian pause
  checks. The output labels this RFQ generated-vault-signer coverage and says
  Squads threshold/PDA signing was not exercised.
- [x] `NO_DNA=1 npx ai-devkit@latest lint --feature
  solana-tokenized-stock-desk` — passed on the first verification run in this
  session. A rerun after appending this evidence section was blocked by npm
  DNS (`ENOTFOUND`); the package is not available in the offline cache. The
  final section was checked manually against the dossier structure.
- [x] Read-only GitHub issue checks confirm issues 14 and 16 remain OPEN; issue
  16 remains the behavior authority. No tracker item was edited.
- [ ] Real local governance-through-Squads remains blocked: no verified Squads
  v4 program binary is available in the worktree or local validator artifacts.
  The remaining gate is a verified Squads artifact loaded into Surfnet and an
  executed multisig proposal that exercises member authorization, threshold
  approval, vault-PDA execution, and the RFQ's delayed/stale-version checks.

Production maker-balance and licensed Reference Policy providers are still not
configured. The production Reference Policy gate keeps new Quote Sprints
unavailable before source collection; local deterministic providers are
fixtures only. Ondo remains informational and Liquidation Execution remains
disabled. Ticket 14 stays OPEN until the real local Squads execution gate passes.

## Ticket 14 Squads binary gate attempt (2026-09-23)

- [x] Pinned the official [Squads v4 source](https://github.com/Squads-Protocol/v4)
  at revision `64af7330413d5c85cbbccfd8c27a05d45b6e666f`. The checkout in
  `/private/tmp/ticket14-squads/source-pinned` has the official origin URL and
  was clean at the pinned revision; it is build input, not a test fixture. The
  source revision's SDK manifest says `2.1.2`, but that published
  tarball declares and omits `lib/index.mjs`, so Node cannot load it. The
  harness pins the official compatible `@sqds/multisig@2.1.4` release, whose
  ESM entrypoint is present ([npm package](https://www.npmjs.com/package/@sqds/multisig));
  `package-lock.json` records integrity
  `sha512-5w+NmwHOzl96nI50R/fjSD6uFydRLNUquhoEmmWbGepS4D9DnQyF2TKcUBfTyxV3sgJt00ypBt7SXB3y8WOzUQ==`.
- [x] Pinned `solana-verify 0.5.2` and invoked the official
  [Squads verification procedure](https://github.com/Squads-Protocol/v4#verifying-the-code)
  with `solanafoundation/solana-verifiable-build:1.18.16`. The image was pulled
  as `sha256:1388b6e423013b0a4a1b67b3481b1c35f5a13034af97d9059439d923c19f1c87`
  (`linux/amd64`, emulated on this arm64 host). The verifier binary's SHA-256
  is `c26e1b60f19faf8ce94412b9655fad450abd83852c869e50f3d6f812fc707f68`.
- [x] Read-only Devnet lookup on 2026-09-23 returned Squads program
  `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` executable hash
  `57a8d2d7ef5409df250415135f29f83da876e5adf5a2e5b5752e323cfb4f2f74`.
- [ ] The local verified build did not finish. `solana-verify build -b
  solanafoundation/solana-verifiable-build:1.18.16` stopped in
  `cargo_build_sbf` with `Failed to remove /root/.cache/solana/v1.41 while
  recovering from installation failure: Read-only file system (os error 30)`.
  No local `.so` or executable hash was produced, so no local-to-Devnet hash
  comparison passed and the Squads binary was not loaded into Surfnet.
- [ ] Docker Desktop then returned `write
  /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db:
  input/output error` when handling the task's dead verifier container, and
  `docker system df` reported an I/O error reading image blob
  `sha256:94aa5ae73efec9f5ca76406ed46d7f07fdbce3a6955d03fd7d37c9a0b78108aa`.
  The host data volume showed 423 GiB used of 460 GiB and 1.4 GiB free. No
  unrelated Docker images or containers were removed.
- [x] The new Squads harness checks the official Git origin, clean checkout,
  pinned Git revision, and SDK version, then requires `solana-verify
  get-executable-hash` to succeed and match the live Devnet hash before it
  builds the RFQ or starts Surfnet. Its preflight stops at the absent local
  `.so`; no Squads execution evidence is claimed.
- [x] `NO_DNA=1 npm run test:solana:rfq-governance-validator` — existing
  generated-signer RFQ-only coverage passed bootstrap, delayed economics and
  maker-policy apply, cancellation, stale versions, signer isolation, and
  guardian pause. Its output explicitly makes no Squads threshold or PDA
  signing claim.
- [x] The last successful read-only `gh issue view` checks showed #14 and #16
  OPEN. Issue #16 remains the behavior authority. Ticket 14 stays OPEN because
  the verified local Squads artifact and 2-of-3 vault execution have not been
  demonstrated.
- [ ] A final read-only `gh issue view` retry failed to connect to
  `api.github.com`; issue states could not be refreshed during this retry. No
  tracker item was edited.

The temporary verifier registry cache created for the initial failed attempt
was removed to recover 321 MiB of host space. That initial Docker failure is
superseded by the successful follow-up build below.

## Ticket 14 Squads build and hash follow-up: pre-integration checkpoint (2026-09-23)

Historical checkpoint. The local behavior run had not yet been performed at
this point. Its hash mismatch correctly identified a deployment-provenance
gap; the final evidence update below supersedes the local-execution status.

- [x] Docker started successfully and the cached official image inspected
  cleanly. `docker system df` completed without metadata or image I/O errors;
  no image, container, volume, or cache was pruned. Host free space was 18 GiB
  before the follow-up build and 15 GiB afterward.
- [x] Rechecked `/private/tmp/ticket14-squads/source-pinned`: official origin,
  commit `64af7330413d5c85cbbccfd8c27a05d45b6e666f`, clean working tree.
- [x] Followed the [Squads README build procedure](https://github.com/Squads-Protocol/v4#verifying-the-code):
  ran `anchor build` with Anchor CLI `0.29.0` in the official
  `solanafoundation/solana-verifiable-build:1.18.16` image, then ran
  `NO_DNA=1 solana-verify build -b
  solanafoundation/solana-verifiable-build:1.18.16` using pinned
  `solana-verify 0.5.2`. Both commands completed successfully. The image digest
  was `sha256:1388b6e423013b0a4a1b67b3481b1c35f5a13034af97d9059439d923c19f1c87`
  (`linux/amd64`, emulated on the arm64 host); the verifier binary SHA-256 is
  `11d5a8316cb4fac9c78c06345bca0052e4020dfafcbb4a52156c0c0c42c543ce`.
- [x] The source-built program executable hash is
  `d48660833989ecea3145ff726164fe640bd90696f03ce00dfd0cda258cbf2fac`
  (raw `.so` SHA-256
  `ae9587376b1d5febf83f558b87ed876cdd4bdcc9ad877f257992287fb09d0b11`).
  A fresh read-only Devnet lookup returned
  `57a8d2d7ef5409df250415135f29f83da876e5adf5a2e5b5752e323cfb4f2f74`.
  These hashes do not match, so the local artifact is not the Devnet executable.
- [x] A fresh read-only Mainnet lookup returned the same executable hash as the
  source-built artifact: `d48660833989ecea3145ff726164fe640bd90696f03ce00dfd0cda258cbf2fac`.
  `solana-verify list-program-pdas` found no verification metadata for this
  program on Devnet. Mainnet lists two official Squads source records, commits
  `2a47b4cc76068fb8accec3d5a599e6020c50f796` and
  `6d5235da621a2e9b7379ea358e48760e981053be`; these do not identify the
  Devnet executable's source revision.
- [ ] The real governance validator was not run. Its matching-hash preflight
  must remain in force; the local artifact was not loaded into Surfnet, no
  transaction was sent, and no Squads 2-of-3 execution is claimed.
- [x] Read-only `gh issue view 14` and `gh issue view 16` refreshes were
  attempted but could not connect to `api.github.com`; tracker state was not
  changed. The last successful check recorded both issues OPEN.
- [x] The AI DevKit root and feature lint commands were attempted again but
  could not resolve `registry.npmjs.org` (`ENOTFOUND`).

Ticket 14 remains OPEN. The next useful step is to identify an official source
revision or published build provenance for the Devnet executable, then rebuild
and compare again. Do not weaken the source/hash preflight or substitute a
program dump for a source-built artifact.

## Ticket 14 real Squads local governance run (2026-09-23)

The governance harness now uses the pinned local executable for behavior and
reports Devnet identity separately. A pre-change run had treated the differing
local and Devnet hashes as a blocking condition; that red result identified the
deployment identity mismatch, not a local governance failure. After revising
the preflight, the focused command below passed:

```sh
NO_DNA=1 SOLANA_VERIFY_BIN=/private/tmp/ticket14-squads/toolchain/bin/solana-verify \
SQUADS_V4_SOURCE_DIR=/private/tmp/ticket14-squads/source-pinned \
SQUADS_GOVERNANCE_EVIDENCE_PATH=docs/ai/testing/evidence/2026-09-23-ticket14-squads-local.json \
npm run test:solana:governance-validator
```

Fresh rerun exit status: 0. The evidence report was recorded at
2026-09-23T15:30:42.126Z and contains 13 passing assertions, 65 successful
local transactions, 10 expected rejected transactions with signatures and
program error logs, and 31 account observations. See
[the machine-readable evidence report](evidence/2026-09-23-ticket14-squads-local.json)
for the full transaction signatures and state.

The run covers the focused local governance behavior corresponding to
canonical issue #16 AC-047 through AC-051:

- AC-047: the queued action's hash, target, expected version, proposing vault,
  creation time, and apply-after time were read back and checked. An early
  apply failed with GovernanceDelayActive; applying after the delay advanced
  the governance version and updated the fee. Stale queue and apply attempts
  failed with RegistryVersionNotIncreasing.
- AC-048: bootstrap executed through the 2-of-3 Squads vault without waiting
  24 hours. The resulting governance account records a 24-hour delay for
  later changes.
- AC-049: an individual member key and an unrelated Squads vault PDA were
  rejected as the configured governance signer with ConstraintAddress.
- AC-050: Guardian queue, apply, and cancel attempts were rejected with
  ConstraintAddress. Guardian pause succeeded and changed programPaused from
  false to true.
- AC-051: a 2-of-3 proposal canceled a queued change immediately, before its
  24-hour apply time; the queued account no longer existed.

Threshold behavior was exercised against the actual Squads binary: one
approval failed with InvalidProposalStatus, a nonmember execution failed with
NotAMember, and two member approvals executed the bootstrap. The test also
observed the multisig threshold of 2 and the configured vault PDA. The generated
signer RFQ-only harness is separate and does not count toward this evidence.

The Squads ProgramConfig account was seeded as local genesis state because
ProgramConfigInit is restricted to Squads' hard-coded team key. This fixture
initializes only the existing singleton; the official binary still executes
multisig creation, proposals, approvals, vault-PDA execution, and all RFQ
governance calls. No Squads behavior was substituted with a generated signer.

Pinned provenance for this run:

- Official source origin: https://github.com/Squads-Protocol/v4.git
- Clean source revision: 64af7330413d5c85cbbccfd8c27a05d45b6e666f
- Squads program ID: SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
- SDK: @sqds/multisig 2.1.4; package-lock integrity
  sha512-5w+NmwHOzl96nI50R/fjSD6uFydRLNUquhoEmmWbGepS4D9DnQyF2TKcUBfTyxV3sgJt00ypBt7SXB3y8WOzUQ==
- Build procedure: anchor build followed by solana-verify build using
  solanafoundation/solana-verifiable-build:1.18.16
- Build image digest:
  sha256:1388b6e423013b0a4a1b67b3481b1c35f5a13034af97d9059439d923c19f1c87
- Verifier: solana-verify 0.5.2
- Local executable hash:
  d48660833989ecea3145ff726164fe640bd90696f03ce00dfd0cda258cbf2fac
- Raw executable SHA-256:
  ae9587376b1d5febf83f558b87ed876cdd4bdcc9ad877f257992287fb09d0b11
- Read-only Devnet executable hash:
  57a8d2d7ef5409df250415135f29f83da876e5adf5a2e5b5752e323cfb4f2f74
  (different from the local hash). The local hash matches Mainnet, but that
  does not identify the Devnet artifact's source revision.

The official current-source checkout was rechecked at revision
af94153ff77a28b6effe46b9c94baaa93742b48c with the official origin and a clean
working tree. Its Cargo.lock is version 4. The README documents a Rust 1.85
toolchain and a version-3 lockfile workaround; the prior build attempt in the
pinned image stopped during Cargo metadata processing before producing an
executable. The checkout therefore cannot be compared with Devnet and does not
explain the mismatch. Its cause remains unproven.

At the time of this 2026-09-23 run, canonical issue #18 had not yet settled the
Ticket 14 close bar. This was local Squads integration evidence for AC-047
through AC-051; it did not evaluate AC-052 evidence-to-enablement or AC-053
loader-upgrade wording, and did not replace EVD-002 or fork, operational, and
runtime evidence in canonical issue #16. No transaction was sent to Devnet or
Mainnet. The subsequent #18 resolution and Ticket 14 close-bar results are
recorded below; Devnet provenance and production release evidence remain
separate work.

## Private Maker settlement Surfnet exercise (2026-09-24)

`NO_DNA=1 npm run test:solana:settlement-validator` passed against a freshly
built RFQ program in offline Surfnet. The script exercises the public Anchor
instructions with real classic SPL Token accounts and observes these results:

- AC-026: Seller stock debit and Maker stock credit were each 100,000 atomic
  units. Maker stable debit was 500,000; Seller stable credit was 499,500; fee
  recipient credit was 500; a FillReceipt was created.
- AC-027–AC-029: over-cap fee, expired or overlong quote window, malformed
  all-zero quote ID, and live FillReceipt replay were rejected. Rejected cases
  left token balances unchanged and did not create a new receipt.
- AC-030–AC-034: a frozen Seller stable account caused the later stable CPI to
  fail, rolling back the earlier stock CPI and receipt. Duplicate economic
  token accounts were rejected. Guardian program pause blocked an already
  issued quote and rolled back its receipt. Third-party receipt cleanup was
  rejected before the one-hour grace period and returned rent to the Seller
  after it elapsed.

The all-zero quote ID case was red before the program added `InvalidQuoteId`.
This is local program evidence for the exercised classic-token cases only.
The same public-instruction Surfnet run now also settles a Token-2022 stock
mint with MetadataPointer and a zero-basis-point TransferFeeConfig. The Seller
stock account lost 100,000 atomic units and the Maker stock account gained
100,000; the Maker stable account lost 500,000, the Seller gained 499,500,
and the fee recipient gained 500. This exercises AC-011/AC-026 at a local
integration seam, including the program's expected-zero fee instruction path.
The test's first run failed because a later shared-fixture assertion retained
the classic-only Maker stable balance; after updating that assertion to the
two-settlement balance, the full command passed. That failure was a fixture
expectation error, not a program rejection.

The same command now rejects a Token-2022 mint initialized with a nonzero fee,
and a mint with a zero current fee plus a nonzero fee scheduled for a future
epoch. The scheduled-mint assertion reads both fee entries and confirms the
newer entry starts after the current epoch. Both rejected settlements leave
stock and stable balances unchanged and create no FillReceipt. These are
offline Surfnet integration observations; they do not satisfy the canonical
EVD-002 requirement for Anchor plus LiteSVM or Mollusk, nor EVD-003 fork
evidence. Hook execution, memo ordering, other AC-034 malformed-account cases,
and production fork evidence remain outstanding. The Solana loader upgrade
authority is separately observable and is **not** bound by the
RFQ governance delay (AC-053); this run did not exercise loader upgrades.
AC-052 still needs a signed evidence bundle and a separately observed delayed
Squads action on its exact hash. No Devnet or Mainnet transaction was sent.

## Private Maker LiteSVM settlement and governance exercise (2026-09-24)

The Anchor program was built with `NO_DNA=1 anchor build --skip-lint`, then
executed through its public instructions in LiteSVM with SPL Token, Token-2022,
Memo, and a registered transfer-hook program. The test command is:

```sh
NO_DNA=1 cargo test --offline --manifest-path contracts/solana-rfq/Cargo.toml -p solana-rfq --test litesvm_settlement
```

All 16 tests passed. This runtime evidence exercises:

- AC-026: classic SPL Token and zero-fee Token-2022 exact-input settlement,
  including stock, stablecoin, fee, and FillReceipt deltas. A later frozen
  stablecoin CPI rolls back the earlier stock transfer and receipt.
- AC-027–AC-029: fee-cap rejection; quote validity before issue, at both
  inclusive endpoints, and after expiry; the independent 30-second hard cap;
  and live FillReceipt replay rejection. After permissionless receipt cleanup,
  replay of the now-expired quote is also rejected.
- AC-030–AC-034: a guardian pause blocks an already signed quote; early receipt
  close fails; a third party can close at expiry plus one hour and rent returns
  to the original Seller. Wrong token program, unexpected non-hook remaining
  account, duplicate mutable economic account, malformed hook TLV, malformed
  extra-meta PDA seed data, and a hook meta that aliases a reserved settlement
  account are rejected before transfer or hook execution.
- Token-2022 extension paths: current and future nonzero transfer fees fail
  closed; a registered transfer-hook program runs once on stock transfer; and
  a MemoTransfer destination requires the canonical Memo program. The Memo CPI
  is quote-bound and immediately precedes the Token-2022 transfer CPI.
- Governance queue: the local vault signer queues an immutable economics
  action, early apply returns `GovernanceDelayActive`, and apply succeeds at
  the configured 24-hour boundary with the expected values and version.

This is local Anchor/LiteSVM program evidence for the covered cases. The
governance vault and registries are seeded fixture state; the governance test
does not execute a Squads v4 proposal. The malformed vectors above do not claim
to exhaust every possible account mutation. The Surfnet and pinned Mainnet
fork evidence remain separate runs and are not replaced by LiteSVM. This run
does not establish Devnet executable provenance, AC-052 evidence-to-enablement,
or AC-053 loader authority behavior. AC-052 still needs a signed evidence
bundle and a separately observed delayed Squads action on its exact hash. No
Devnet or Mainnet transaction was sent.

## Ticket 14 public event privacy regression (2026-09-24)

At the existing Quote Sprint HTTP event route, a focused regression feeds a
terminal Private Maker snapshot with Seller request terms, maker identifiers,
loser identifiers, and partially signed bytes. The public SSE event must name
only the sprint ID and state. The test failed against the original full-session
serialization, passed after the projection change, failed again with the
original line restored, and passed once the fix was restored. This covers
public event disclosure at that route; resumable event IDs and browser SSE
recovery remain separate canonical behavior.

## Ticket 14 maker and operator continuation (2026-09-24)

The maker availability regression failed before `heartbeat` existed and passed
after the route stopped using heartbeats to re-advertise a source. The role
HTTP tests cover provisioned challenge signing, maker/operator route isolation,
operator stop and disable, missing governance write route, and unavailable
reader states. The local browser snapshots showed gated Maker and Operator
pages without a connected wallet; Operator displayed no governance write action
and marked Liquidation Execution unavailable. These browser observations do
not cover a signed Wallet Standard role journey or wallet-switch interaction.
`NO_DNA=1 npm run smoke:solana:roles` passed the loopback signed-challenge,
HTTP role, WebSocket handoff, unavailable-heartbeat, operator stop/disable, and
missing governance-write checks.
The focused source test and HTTP route test also verify that an operator can
disable Jupiter, that its status becomes disabled, and that a disabled Jupiter
adapter is not queried. The loopback smoke verifies a malformed heartbeat does
not increment the Maker's quote-rejection count.

## Ticket 14 private Maker settlement and operator checkpoint (before #18 close-bar implementation, 2026-09-24)

This section records the working checkpoint before the implementation and
verification below. Its open questions and “remains open” statements were
superseded when child issue #18 settled the Ticket 14 close bar. Keep it as a
history of the diagnosis and red-green work; use the final acceptance section
below for current status.

### Attempt 1 — bind signed Maker transactions to quote terms

- Diagnosis command: `NO_DNA=1 npm run smoke:solana:roles`. Before the
  validator change, the authenticated loopback Maker stream accepted a
  correctly signed transaction whose encoded stock economics conflicted with
  the quote. After calling `validateMakerSettlement` before `submitQuote`, the
  same reproduction rejected it before source submission. The smoke was rerun
  after the test expansion and passed.
- `src/solana-maker-settlement.test.ts` now mutates the settlement account and
  each encoded quote field: quote ID, issue time, expiry, stock amount, Maker
  minimum, gross stable amount, Seller minimum, fee, and extension fingerprint.
  It also checks Anchor instruction/account identities and order, signers,
  privileges, extra instructions, and signed economics mismatch.
- `NO_DNA=1 npx vitest run src/solana-maker-settlement.test.ts
  src/solana-maker-operator.test.ts src/solana-operator-routes.test.ts` passed
  29 tests.

### Attempt 2 — Maker and operator journeys

- The Maker-only cases cover authenticated capabilities, outcomes, fill
  details, and self-disablement. An already-issued Private Maker winner now
  fails authorization after its source is disabled. Route tests cover
  operator stop/disable and reject the exposed governance queue/apply, Squads
  execution, source enablement, and liquidation enablement paths.
- `NO_DNA=1 npm run smoke:solana:roles` passed the signed-challenge loopback
  role checks, Maker stream handoff, unavailable evidence, disablement,
  stop-intake, and no-governance-write checks.
- `NO_DNA=1 npm run test:e2e:solana:maker` passed the Wallet Standard signed
  challenge and Maker capabilities/outcomes/fill/privacy/self-disable flow.
  This browser fixture intercepts API responses; authenticated HTTP and
  WebSocket paths were exercised separately, so it is not browser-to-live-API
  evidence.
- `NO_DNA=1 npm run test:solana` passed 36 tests. The six-file focused command
  `NO_DNA=1 npx vitest run src/solana-tokenized-stock.test.ts
  src/solana-client.test.ts src/solana-maker-settlement.test.ts
  src/solana-maker-operator.test.ts src/solana-operator-evidence.test.ts
  src/solana-operator-routes.test.ts` passed 73 tests. `NO_DNA=1 npm run
  typecheck:solana-api` passed.
- Earlier in this worktree, `npm run typecheck:solana`,
  `npm run build:solana-web`, Anchor formatting, and the offline Anchor suite
  passed (14 unit and 16 LiteSVM tests). No implementation files changed after
  those checks in this continuation. No wallet transaction was signed or
  submitted to a live cluster.

### Open questions at this checkpoint

- AC-046 behavior has local stop/disable checks, but its EVD-004 operational
  evidence, AC-052 signed evidence bundle plus delayed Squads action on the
  exact hash, and Devnet Squads provenance have not been produced. Map #9
  explicitly places production enablement and release-gate certification out
  of scope; #14's prior comments treated some of these as closure conditions.
- AC-056's Maker restrictions need to be reconciled with the canonical close
  bar. In particular, the local checks do not stand in for a verified
  browser/operator workflow proving that a Maker cannot enable an asset, pick
  Reference Policy, or mutate committed settings.
- AC-057 has deterministic role-route tests and a browser fixture, but the
  browser fixture uses intercepted API responses rather than the running
  authenticated API. The meaning of Sprint ID access also remains unsettled:
  `GET /v1/quote-sprints/:id` currently returns the full review package by ID
  without role authentication, while the public SSE projection is summary-only.
- AC-058 operator route checks reject governance and enablement paths. AC-071
  still needs its privacy boundary reconciled with the full-package Sprint GET
  and with the exact browser evidence required for the Maker journey.
- Operator provisioning currently creates a Maker source with `enabled: true`
  but `availability: unavailable` and no capabilities until the Maker
  advertises. Whether that represents identity onboarding or source
  enablement is not explicit in the canonical contract.

These were the questions sent to child issue
[#18](https://github.com/mangekyou-labs/katon/issues/18): whether #14 closes
on local/devnet behavior, whether Sprint IDs are bearer capabilities, how to
interpret provisioned Maker state, and whether AC-057 requires a browser run
against the authenticated API. The accepted answers and their verification
follow.

## Ticket 14 settled close-bar verification (2026-09-25)

Child issue [#18](https://github.com/mangekyou-labs/katon/issues/18) settled
the boundary: #14 closes on its applicable local and Devnet behavior. Production
release certification, AC-052 evidence-to-enablement, and Devnet Squads
executable provenance remain separate gates. Sprint IDs are identifiers, not
authorization. Seller-specific reads and writes require a short-lived signed
session bound to wallet, origin, and cluster. The full Quote Sprint review
package, including transaction bytes, is protected by the same session; public
Sprint events expose only their sanitized projection. Provisioned Maker sources
remain disabled until a separately observed delayed governance apply enables
that exact source. Advertising controls availability only after enablement.
Maker and Operator stop/disable actions remain immediate. The browser has no
governance apply or Liquidation Execution enablement path.

### Signed Seller boundary

- A Seller signs a one-use challenge to obtain a short-lived session bound to
  its wallet, requested origin, and cluster. The API also checks that the
  claimed origin matches the browser's actual `Origin` header when present.
- The SDK carries Seller proof on every Seller-specific API request. Focused
  route tests cover protected Sprint reads including transaction bytes,
  missing/expired/replayed proof, wrong wallet, wrong origin, wrong cluster,
  and cross-Seller access. A browser-origin mismatch regression rejects a
  forged custom-origin claim.
- The public SSE projection exposes the Sprint ID and state only; it contains
  no Seller terms, Maker identities, losing payloads, or signed transaction
  bytes. `src/solana-seller-auth.test.ts`,
  `src/solana-seller-routes.test.ts`, `src/solana-client.test.ts`, and the
  event privacy regression cover these seams.

### Governance-gated Maker source

- Maker provisioning initializes each Private Maker source disabled, with no
  advertised capability. A queued action alone does not enable it. The
  read-only governance observer requires a persisted delayed `SetMakers`
  application whose resulting allowlist contains the exact provisioned wallet
  key. `MakerRegistry` stores the proposal ID and payload hash, target,
  expected and resulting versions, proposing vault, creation/delay/application
  timestamps, resulting allowlist, and pause state. Bootstrap allowlists start
  with no applied-action record. The observer checks the canonical registry
  PDA, matching current list and version, configured vault, verified signed
  Squads identity/cluster, at least 24 hours of delay, and unpaused state.
- The operator evidence reader decodes that persisted record and accepts the
  zero padding from Anchor's maximum-sized account allocation while rejecting
  nonzero trailing bytes. The Operator UI reports when no applied Maker policy
  action is stored and explains that source access still needs verified
  governance and program evidence.
- Focused governance-observation tests reject wrong source keys, queued-only
  actions, insufficient delay, pauses, mismatched vaults, unavailable
  observations, and the wrong cluster. Maker operator tests verify that
  advertisement before governance is denied; after the exact enablement,
  advertisement can affect availability. Maker self-disable, Operator
  disable, and stop-intake remain immediate.
- `NO_DNA=1 npm run test:solana:rfq-governance-validator` passed the local
  generated-vault-signer program scenarios for bootstrap, delayed economics
  and Maker policy apply, cancellation, stale versions, signer isolation, and
  guardian pause. That validator explicitly claims no Squads threshold or PDA
  signing behavior.
- The provenance regression added a LiteSVM case that starts with a
  bootstrap-allowlisted key and no `last_applied` record, rejects an early
  apply, then applies the delayed exact Maker policy and checks every persisted
  field. `NO_DNA=1 cargo test --offline --manifest-path
  contracts/solana-rfq/Cargo.toml` passed 14 Anchor unit tests and 17 LiteSVM
  tests after rebuilding the local program with `anchor build --skip-lint`.
- `NO_DNA=1 npm run test:solana:settlement-validator` passed the focused local
  classic SPL and Token-2022 settlement vectors. Its output records fee caps,
  rollback, exact deltas, replay, memo, pause, and receipt cleanup.
- The separate official Squads v4 2-of-3 local run remains documented in
  [its evidence report](evidence/2026-09-23-ticket14-squads-local.json): 13
  assertions, 65 successful local transactions, 10 expected rejections, and
  31 account observations. The temporary source-built executable under
  `/private/tmp/ticket14-squads` has since been removed, so that exact binary
  run was not repeated in this continuation. Its report remains local-only
  evidence; no Devnet or Mainnet transaction was sent.

### Browser and role evidence

- `NO_DNA=1 npm run test:e2e:solana:maker` passed the intercepted-response
  Wallet Standard Maker fixture. It remains separate from the live browser
  journey.
- `NO_DNA=1 npm run test:e2e:solana:maker:live` passed against the running
  authenticated API and local Vite server. The browser signed a Maker role
  challenge, loaded Maker status, and confirmed the provisioned source stayed
  disabled, unavailable, and empty before governance enablement. It then
  signed an Operator role challenge and observed local source state, read-only
  unavailable governance and Liquidation Execution evidence, and no
  enablement action. Browser check: zero warning/error console messages and
  zero uncaught page errors. The journey ends before any on-chain wallet
  signature or submission.
- The separate Seller live browser journey signed a one-use Seller challenge
  against the running authenticated API, exercised the protected full Sprint
  GET and review package, entered transaction review, and stopped before
  signing or submitting. The journey uses only local blockhash lookup; it
  calls no transaction execution endpoint.
- `NO_DNA=1 npm run smoke:solana:roles` passed with separate authenticated
  HTTP and WebSocket evidence. It covers route isolation, disabled
  advertisement, malformed/unavailable heartbeat handling, immediate
  Operator stop/disable, and the missing governance-write route. These
  HTTP/WebSocket records are not represented as browser evidence.
- The route regression verifies Maker self-disable blocks its source without
  labeling it as Operator-disabled; a later Operator disable is reported as an
  Operator action while the source remains blocked.

### Focused verification results

- The nine Solana Vitest files covering client, Maker settlement/operator,
  Operator evidence/routes, Seller auth/routes, governance observation, and
  overall tokenized-stock behavior passed **86 tests** after the applied-action
  provenance and disable-attribution regressions were added.
- `NO_DNA=1 npm run typecheck:solana-api`,
  `NO_DNA=1 npm run typecheck:solana`, and
  `NO_DNA=1 npm run build:solana-web` passed. The web build compiled 190
  modules.
- `NO_DNA=1 cargo fmt --all --manifest-path
  contracts/solana-rfq/Cargo.toml -- --check` passed.
- `NO_DNA=1 cargo test --offline --manifest-path
  contracts/solana-rfq/Cargo.toml` passed 14 Anchor unit tests and 17
  LiteSVM settlement tests. These public-instruction vectors cover classic
  SPL and zero-fee Token-2022 settlement, token fee rejection, hook execution,
  MemoTransfer ordering, replay, expiry, pause, rollback, malformed accounts,
  and delayed program governance. They do not substitute for fork/Devnet
  evidence, AC-052, or AC-053.
- `NO_DNA=1 npm test` passed all 64 files and 449 tests. The worktree has no
  `.env`; the environment loader test used a temporary non-secret placeholder
  `.env` fixture, removed after the run.

The Devnet Squads identity mismatch remains a separate #19 provenance task;
AC-052 evidence-to-enablement and production release gates remain tracked by
#20 and map #9. They have no passing claim from this Ticket 14 work. No
Devnet or Mainnet transaction was sent.
