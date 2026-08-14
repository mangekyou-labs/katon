---
phase: testing
title: Flare Confidential RFQ DEX Testing Strategy
description: Verification plan for contracts, FCC matching, Flare data integrations, API, adapters, and production frontend
feature: flare-confidential-rfq-dex
status: in-progress
---

# Flare Confidential RFQ DEX Testing Strategy

## Live 66283 confidential settle — 2026-08-15 (post-restart registry recovery)

Operator restart of the Render TEE services minted fresh teeIds; recovered with
scaffold `register-tee -command rRap` + `pause` of stale ids (details in the
implementation doc, same date). Fresh working txs:

```text
fcc-settle=PASS dispatch=0x7b3e9777516193817939da63685b6ed1137b75996df98a6be16adc9363886694
  actionId=0x9057337fbf60764398172604e81da7f9e8942e313a306ed22ccbe60c01a4cec6
  selectedHash=0xf04674389bf14f894e64c05192b902597b0deec1f3c940e68500835fbd4aaed8
  swap=0x84f291d974c186d5c4c30fa9e575bc0b4e80d02b0168d1cde9cb0426064dcec9
  blockNumber=34062229 rwaDelta=1e18 usdxDelta=1000e18
paused-stale: 0xfe2acc2c0752febd96eaa79de09f011ad170c60cdaaedf8aba07704f7bfcff74
              0xd07d772b2cd4a1d8ad97409dc3307c732868a72623d8517200f0eda96ca6cfcb
              0x96a37c5ea326561e76f49a5fef108bd7017f7c1a2d89a05ed81fcdc88065423e
getActiveTeeMachines(66283) = A 0x5C7FF00942F9AB85d3424E017DeD3075d158E1b1
                               B 0x1F709397A5d1DBc619EFaE0F1C79DE0eAeF57eCd
                               C 0xD5628BAb1B03db18334BEB8cF085d2157bE33456 (all status 2)
```

Headed proof walk on the fresh evidence (`FLARE_FCC_E2E_REUSE=1
npm run test:e2e:flare:fcc:live`) → `playwright-cli=PASS flow=fcc-live-66283`;
`/swap` rendered router `0xb136b8a1…`, the new dispatch/actionId/swap hashes,
and the dummy-golden guard was exercised (`DUMMY_GOLDEN_VISIBLE` check ran).
Newly discovered scenario: a lingering playwright-cli session holding the
MetaMask profile lock fails the next session with `Browser is already in use` —
close the prior session before starting a new headed flow.

T-WALLET-4 (browser-signed live swap) stopped at the design boundary: `/swap`
Sign-and-submit is the demo path (`buildDemoSwapTransaction` → `DEMO_ROUTER`,
fresh commitment as `fccActionId`); a submittable live `executeSwapRoute` from
the browser would be a design change (dispatch-only lane + route construction +
QA allowances), not a test gap.

## Live 66283 confidential settle — 2026-08-14

Script path is no longer dummy-golden-only. After rRap of recycled Render
identities and pause of the stale PRODUCTION set:

```text
fcc-relay=PASS dispatch=0x44a1bec47fa4a7a9d7ff7f58c27622e6aaa2e1a68240b2ce8931dc4d6cce6840
fcc-settle=PASS dispatch=0xbe72307c388333c57463e66fecb95516679f25610005e8bfff9253288dabf063
  instructionId=0xab451a2046f613f9464f3dfb9485b2c2dffaff4a30e3879bdf436fc8bbe12ab0
  actionId=0xa179a2619ecc05db3f2599f1f94aa3c68c8a3ec56c5428dbbd3b7ea62e9c8b28
  selectedHash=0xfa3c292e753018e65493ede84c7c362f8ac5315dfbf0c74d74d007f638540581
  swap=0xf8542ac805c222617e916c4738761fb301e2ab4f80e7ef97e857eaf1441e96f9
  blockNumber=34058401
```

`npx vitest run src/flare-fcc-settle.test.ts src/flare-fcc-match.test.ts src/flare-fcc-e2e.test.ts` → 6 passed.

Task 4 (2026-08-14) headed `npm run test:e2e:flare:fcc:live` (`FLARE_FCC_E2E_REUSE=1` after a fresh settle):

```text
fcc-settle=PASS dispatch=0x385ffbcf5a774b77065b1a0c494710274cce84be5913823dfcbbb25e8bcf3948
  actionId=0x4a977fdc8173cdebf9b17d8d04f0f58e882ba45b5a88ee69c2a697a4c1d1181d
  routeHash=0x13887129271449b1824810c288cb289bd56b6c1735383703a10084b5f655d43f
  swap=0x58331d08b9a5b50acdf85ce86597f9ab461e274ecefce9bf9ba6468f75a43e86
  blockNumber=34058733
playwright-cli=PASS flow=fcc-live-66283 screenshot=output/playwright/flare-fcc-live-cli.png
```

The Swap page shows those hashes and isolated router `0xb136b8a1…`. The walk does **not** inject `0xd9` and does **not** submit to `0x7fA18179…`. Local `/v1/read-model` on :8787 was down (console ERR_CONNECTION_REFUSED); that is not settlement evidence. T5.8 dAppwright was not run.

## Coston2 matcher e2e (simulated-TEE) — 2026-08-14

Official scaffold `test.sh` against dedicated extension 66277 / sender
`0x876398bB…6F26`. MATCH/FINALIZE instruction
`0x91a8a8f6c73721058579f27272648eb82a1cd12fcc58ede2bc2d7f5a14044750` returned
golden route hash `0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975`.
RFQ/CREATE and BID/SUBMIT accepted. Hello World still passes. Not claimed:
`submitFccResult` on TrustRFQ sender, 3-TEE quorum, MODE=0 Confidential Space.

## Task 0 / wake-first Render (2026-08-14)

Fresh operator-shell evidence:

```text
secret-scan=PASS files=189
fcc-indexer=PASS host=34.38.42.208 port=3306 database=indexer credentialsConfigured=true mysqlAuthenticated=true
fcc-candidate=unconfigured instructionSender=0xC018A20d1694ed588320758529bc55b56e2beA60
getRandomTeeIds(66277, 3) revert 0xd65ac61e
fccQuorumVerifier() revert on 0x7fA181…933 and 0x593095…c36c
```

`npx vitest run src/flare-wake-fcc.test.ts` → 4 passed. Live three-URL
`wake:flare:fcc` is not runnable until the operator pastes Render `/info`
URLs. Headed playwright-cli confidential e2e is still simulated-only
(`tools/flare-playwright-cli-flow.js` / fake `0xd9…`).

## Weather-first FCC milestone evidence — 2026-08-14

The FCC local path follows the Weather extension wire surface: `/info`,
`/state`, `/action`, and node-boundary `/decrypt`. The client uses one
canonical ABI-encoded `FccRecipientEnvelopeV1` with exactly three independent
secp256k1 ECIES recipients; no application key or plaintext is persisted by
the relay, proxy, or Redis. TypeScript and Go envelope tests cover canonical
encoding, recipient selection, commitment checks, duplicate-recipient
rejection, stale-action rejection, and tamper rejection.

FCC result acceptance is keyed by the FCC instruction ID returned from
`sendInstructions`, then mapped to the logical TrustRFQ action ID. The relay
checks the Weather `TEE_ACTION_RESULT` signature, selected signer,
status/tag/schema, expiry, replay, and dissent before counting the matching
2-of-3 route-hash quorum. Solidity instruction-sender tests cover this
mapping and instruction-ID signature boundary.

The three isolated rehearsal stacks are defined in
`infra/docker-compose.fcc.yml`; `node tools/validate-fcc-stacks.mjs` rejects
duplicate identities, keys, ports, URLs, or state volumes. The secret-free
Coston2 manifest is checked by `node tools/dry-run-flare-fcc-coston2.mjs`
without spending gas or registering a machine. The support-issued indexer pair
is now configured only in ignored `.env.fcc.local`; the new
`npm run check:flare:fcc:indexer` preflight performs the MySQL greeting/auth
exchange and fails closed with a stage-specific reason when the endpoint is
not reachable or authentication fails. The lane remains blocked until
network reachability, dedicated
registries, an extension ID, three stable HTTPS endpoints, a simulated code
hash, funded keys, and explicit operator approval are available. These results
are simulated FCC integration evidence only and do not claim confidentiality,
attestation, or production readiness.

The local provider boundary is covered by Go tests for `POST /instruction` and
`GET /action/status/<epoch>/<instructionId>`. With
`FCC_SERVICE_ROLE=ext-proxy`, those requests forward to the configured
extension TEE without decryption or indexer discovery. The test-only
`npm run fcc:local:deliver` harness posts one instruction to three local proxy
URLs and waits for all three status results while printing no payload bodies.
The upstream scaffold pin remains blocked until GitHub access is restored.

## Execution-environment reproducibility — 2026-08-14

Live FCC checks have two distinct execution contexts and must not be conflated.
From the operator's network-enabled shell, the support-issued indexer pair
completed the full MySQL greeting/auth exchange:

```text
fcc-indexer=PASS host=34.38.42.208 port=3306 database=indexer credentialsConfigured=true mysqlAuthenticated=true
```

The Codex sandbox is intentionally more restricted: Node TCP sockets return
`EPERM`, public DNS/HTTPS requests fail, and the Docker daemon socket is not
accessible. Its `FCC_INDEXER_UNREACHABLE`, proxy-unreachable, or Docker
permission errors are therefore environment evidence, not contradictory
application evidence. Static tests and Compose-file validation can run in the
sandbox; live `/info`, container health, TEE availability, and Coston2
registration checks must be captured from the operator shell (or an explicitly
networked/container-enabled agent).

The acceptance record must label each command with its execution context and
retain only secret-free output. Never copy the mnemonic, private keys, or the
indexer password into logs, screenshots, or test artifacts.

The 2026-08-14 implementation adds authenticated outer-metadata AAD to both
the TypeScript and Go envelope implementations. Focused verification passes
for the three-recipient envelope, SDK dispatch/result transaction builders,
three-account Coston2 derivation/balance preflight, and the role-checkpoint UI
(26 tests across the focused suites). The MetaMask setup now requires chain
114, derives seller/LP-A/LP-B at address indices 0/1/2, preflights each
`eth_getBalance` without logging seed material, and creates LP-A/LP-B accounts
in the persisted profile. It writes only public addresses and balances to the
ignored `.playwright/qa-accounts.json` artifact.

## Current Execution Snapshot — 2026-08-14

Independent Phase 7 Check Implementation retracted “remaining-local unfinished
in code: none” again. Feature is **not** complete. Production M0–M5 = **0/6**.
Local-complete = **1/6 (M0)**. Remaining-local design-alignment gaps are listed
in the implementation check (open-taker standing route, matcher/router hash
seam, discarded bid envelopes, facility idle-only fill/NAV). Persist profile +
`cli.config.json` exist locally (gitignored). Playwright CLI + MetaMask
evidence boxes below are checked except cleanup (not run). Suite counts below
were re-run once in the Phase 7 pass (not a suites-twice implementer loop).
T1.2/T1.3 residual and T5 live-index stay local unless a new shipped-function
defect appears in those files. Simulated matcher / invented venue-mock ABIs
are local seams, not production FCC or verified venues.

The following local gates are complete and reproducible in the selected
worktree. The full Vitest command is sandbox-limited by five WebSocket tests
that cannot bind `127.0.0.1` here; the FCC/browser-focused set is green.

- [x] TypeScript regression suite: **319 passed / 5 sandbox-limited failures**
  across 48 files (fresh `npm test`); the failures are relay WebSocket setup
  tests stopped by `listen EPERM 127.0.0.1`. This includes durable LP-key, browser
  API-client tests, indexer `projectEventsToReadModel`
  opportunity/activity/facility mapping, and `indexedOpportunityRows` UI
  transform.
- [x] Flare core TypeScript unit slices: canonical EIP-712 boundary, exact
  decimals, runtime/network validation, AES-GCM envelope, matcher/quorum,
  facility accounting, adapters, oracle guards, auction durations, SIWE auth,
  relay, operations, SDK, FAssets boundary, UI shell, and explicit
  loading/empty/ready/stale/offline/error/FCC-matching/queued-redemption state
  labels. The canonical suite also rejects expiries outside the EIP-712
  `uint64` range in TypeScript and Go. The web model also covers eligible-chain asset filtering, exact
  display-amount parsing, and integer balance shortcuts. The web build verifies
  read-model status badges and loading accessibility attributes compile in the
  shell.
- [x] Flare web typecheck and production Vite build.
- [x] Browser/API decimal-input compatibility: canonical `1.0` and `995.0`
  inputs produce the same exact-base-unit quote as `1` and `995`.
- [x] Frontend interaction coverage: verified Coston2 asset address display and
  copy state, accessible `aria-sort` table controls, and 25%/50%/Max balance
  shortcuts with a gas/constraint reserve; headed Chrome verified 25%=`1.2475`
  and Max=`4.99` from a 5-RWA balance with a 0.01-RWA reserve.
- [x] Go matcher unit tests with strict input types, deterministic ordering,
  legacy Keccak route hash, and 2-of-3 quorum selection.
- [x] Cancun Solidity compilation and **105** Foundry tests across **16** suites
  (fresh Phase 7 command: `cd contracts/flare && forge test --offline`; `via_ir=true`
  required for Order growth / stack depth) covering settlement, confidential
  executor/context binding, fee-cap vs router, aggregate delegated notional,
  eligibility-required direct fills, settlement reentrancy, remainingFillable
  conservation (partial/full/cancel + fuzz), protocolFeeOn vs charged swap fee,
  high-s / reentrant ERC-20 / reverting ERC-1271 / wrong-executor remaining
  integrity, verified NAV registry facility path, replay/min-output, exact
  token balance-delta enforcement, canonical EIP-712 encoding and expiry-width
  rejection, allowlisted atomic router legs, decision-block policy, router
  reentrancy, facility shares/withdrawals/redemptions, facility registry,
  proof/risk guards, deterministic FCC operation/quorum boundaries,
  eligibility policy/revocation and execution wiring, typed seller-bound swap
  routes, aggregate fee accounting, typed liquidation routes, observed balance
  deltas, allowlisted adapters, Settlement composition, and complete local
  rollback cases.
- [x] Existing Soroban contract suite: 6 tests with the pinned Rust toolchain.
- [x] Local T1.2/T1.3 residual TDD: red then green on `SettlementRouterInvariant.t.sol`
  (`remainingFillable` / `protocolFeeOn` / malicious-wallet). Local T5 TDD: red
  then green on `projectEventsToReadModel` and `indexedOpportunityRows`.
- [x] Headed `playwright-cli` against `npm run dev:flare` (Playwright MCP is
  not used): `/liquidations` shows `No live opportunity` and empty
  `Indexed opportunities` when the API is down (fail-closed;
  `127.0.0.1:8787` refused). Empty review alerts `LIQUIDATION_REVIEW`; a
  filled review shows `Ready for verified route binding` without constructing
  a venue tx. Swap, Auctions, Facility, and Dashboard still render.
  Viewport 375px: heading and live-opportunity copy remain present;
  document `scrollWidth` equals `clientWidth` (375); the 8-column table
  scrolls inside `.table-wrap` (`overflow-x: auto`). This is not extension
  or venue-fork evidence.
- [x] Read-only Coston2 deployment smoke: `npm run smoke:flare:coston2`
  verifies chain ID, bytecode, deployer ownership, shared eligibility wiring,
  router fee/snapshot policy, Settlement↔Router configuration, the two-day
  eligibility policy delay, and manifest-recorded deployed bytecode hashes.
- [x] Coston2 typed mock swap: `npm run dry-run:flare:coston2:swap` passed with
  no state change, followed by one 1-RWA mock swap through the typed Router;
  receipt and exact 1,000-USDX gross balance delta are recorded in the
  deployment manifest. The source was refilled with test-only USDX so the
  dry-run remains repeatable after the state-changing fixture test.
- [x] Direct Coston2 mock facility deployment, aggregator registration, and
  typed facility-backed swap pass; the recorded flow is explicitly
  non-production and does not claim a verified Morpho/Kinetic venue.
- [x] Flare web browser E2E: `FLARE_HEADED=true npm run test:e2e:flare` passed in
  headed Chromium with an injected EIP-1193 provider, covering successful Coston2
  connection, live quote API, blind relay lifecycle, auction/standing-bid/
  facility/liquidation/dashboard workflows, wallet submission, Coston2
  RPC-backed indexed state, and
  wrong-network rejection. The fixture never holds or uses a private key and
  does not claim extension-specific UX or a production persistent indexer.
- [x] The wallet E2E asserts that the submitted transaction targets the current
  Coston2 transparent-proxy Router and that the quote uses the current
  Coston2 mock asset/source/policy deployment constants.
- [x] Local Flare API transport: quote, read-model, auction, standing-bid,
  facility withdrawal, health, and RPC-backed transaction-index endpoints are
  typechecked and exercised by the browser flow. The API now has tested SIWE
  session verification and an atomic durable JSON-store seam; MongoDB
  persistence and deployment wiring remain release work. The durable local
  indexer checkpoint seam is covered separately by the operations tests. The
  relay also has a real WebSocket cursor replay/live-event test and strict
  commitment-only FCC action ingress coverage.
- [x] Live-data boundaries: live Coston2 Contract Registry/FTSO feed and FDC
  finalization-registry reads, plus mocked signed decimal/timestamp
  preservation, strict credentialed FDC verifier preparation/DA proof response
  validation, official public Web2Json preparation with a required API-key
  boundary, and fail-closed
  unconfigured API endpoints. The DA client accepts Flare's official `proof`
  alias and `attestation_type` metadata, and the Coston2 owner-controlled test
  registry has a successful request-to-proof-to-NAV transaction sequence.
- [x] Production persistence/container boundary: Mongo hydration and queued
  flush behavior, dual Mongo/Redis indexer projection hydration/restart, Redis
  keeper lease ownership, strict malformed-store rejection, API/matcher image builds,
  matcher readiness, and API relay/read-model persistence across container restart;
  the current compose stack also passed a real opaque-auction restart rehearsal.
- [x] Release artifacts: source secret scan, deterministic CycloneDX SBOM,
  bytecode/storage-layout deployment-manifest verification, reproducible FCC
  artifact/source-tree provenance validation, production-profile persistence/
  TLS/keeper configuration validation, and privacy-safe Prometheus metrics for
  indexer/keeper health and counters.
- [x] API privacy and boundary controls: anonymous read models are empty,
  wallet-scoped reads require session/bot authorization, relay list reads are
  cursor-paginated, bot mutations use timestamp/body-digest HMAC headers,
  mutation/connection/request-size limits are enforced, and HTTP error status
  codes preserve auth/throttle/size semantics.

- [x] Release-gate integrity: malformed or unverified FCC artifact, venue,
  governance, and production-service manifests fail closed; local/demo checks
  remain distinct from the managed production profile.
- [x] FCC/FDC external-boundary probes: the live Coston2 FCC manager and normal
  proxy are read-checked, the candidate's zero FCC configuration is surfaced,
  and the documented public FDC development verifier accepts a Web2Json request.
  These probes do not satisfy dedicated FCC attestation, production FDC, or
  controlled NAV-proof release gates.
- [x] Canonical public event catalog: all projected event families are
  allowlisted; unknown event kinds/fields and private payload fields are
  rejected before indexer persistence.

The unchecked cases below remain release gates rather than being inferred from
unit-test success. In particular, the local proof guards use explicit test
seams, FCC is simulated, the liquidation route uses interface-faithful local
mocks rather than verified venue adapters, no external venue fork is pinned,
and no browser-extension signing or release-candidate financial flow was
executed. The Coston2 core contracts and direct mock facility flow are now
deployed and wired; local live-indexed opportunity mapping (projector events →
API read-model → Liquidations table) is covered. Extension signing and
production evidence remain open. The UI still will not construct a transaction
from unverified venue addresses.

The fresh local additions also cover cross-language EIP-712 parity, strict
matcher trailing-input and auction/bid metadata rejection in Go and TypeScript,
scheduled auction lifecycle/cursor replay,
finality-aware projection, SDK route leg-total validation, and malformed
attestation-reference rejection before quorum selection, exact 2-of-3 FCC
configuration, and distinct/nonzero real-mode TEE selection. They do not
substitute for credentialed FDC verifier/DA proofs, real FCC, venue fork, or
browser-extension signing evidence.

The facility slice additionally covers haircut-adjusted quotes, per-RWA
inventory caps, total and adapter exposure caps, and deterministic queued
withdrawal ordering in both the Solidity and pure ledger boundaries, including
owner-share locking, cancellation with FIFO progress, ERC-4626 preview/max
views, standard conversion, synchronous exit liquidity checks, and future/stale
quote snapshot rejection.
Settlement fuzz coverage exercises bounded partial fills and explicit overfill
rejection.
- Typed swap tests cover seller/recipient binding, fee mismatch, aggregate
  net-output minimums, and stale/revoked eligibility. Typed liquidation tests
  cover winner/binding checks, allowlisted funding and adapters, measured debt
  repayment, one aggregate collateral fee, minimum net collateral, adapter
  failure rollback, and no arbitrary target path. SDK tests cover unsigned
  `executeSwapRoute` and `executeLiquidationRoute` assembly.
- [x] Wallet boundary tests cover EIP-1193 account/chain validation, sender
  authorization, user rejection/revert handling, receipt confirmation, and
  indexed-confirmation polling. The headless browser E2E covers injected-wallet
  connection, quote review, confirmed state, and wrong-network rejection;
  browser-extension signing remains a release gate.
- The focused `EligibilityRegistry` suite covers owner-only policy changes,
  role and issuer-reference matching, valid-from/expiry enforcement, policy
  revocation, and stale revocation-epoch rejection. Separate local execution
  tests consume the same policy boundary in Router, Settlement, Facility, and
  liquidation routes; a complete cross-entrypoint matrix remains release work.
The settlement suite also verifies a false-returning token cannot leave a fill
marked or transfer the maker's asset, fee-on-transfer tokens cannot underpay a
maker, and accepts a valid ERC-1271 contract wallet signature. Solidity
canonical type/domain/digest construction is pinned independently of the
deployment address used by TypeScript vectors.
Full ERC-4626/7540 compatibility and live adapter behavior remain release work.

The approved design changed the trust boundary: protocol fee assessment moves
from settlement to one aggregate router path; confidential orders bind seller,
router, auction/context, chain (EIP-712 domain), and expiry; standing limits
remain reusable; and every typed fund-moving route checks a shared
execution-time eligibility policy. Local tests now pin the Order typehash and
digest across TS/Go/Solidity, reject incomplete confidential orders, bind
executor on `execute`, lock direct `fill`, and enforce fee-cap / delegated
aggregate / reentrancy. Full-stack confidential auction E2E with real FCC
remains release work. Local remainingFillable / protocolFeeOn / malicious-wallet
handler coverage is now in `SettlementRouterInvariant.t.sol` (9 tests).

The local migration verifies that Settlement does not assess a second protocol
fee, typed Router swap/liquidation tests verify one aggregate fee against net
minimum output, and `SettlementRouterComposition.t.sol` exercises the typed
LP-to-Settlement path. SDK source-data encoding is covered by a deterministic
unit test; Solidity/SDK golden-vector parity remains release work.

The typed redemption-proof slice covers request binding, proof owner/source,
validity windows, amount bounds, exact/short proceeds, and proof replay.

The local adapter conformance suite now covers typed Morpho/Kinetic-style
liquidation requests, facility caller and venue/market/position/asset binding,
unhealthy-position checks, close-factor limits, paused state, and integer
collateral calculation. It remains a local policy harness until verified venue
interfaces and fork state are available.

The relay slice covers payload-size, LP-fanout, bid-count, and idempotency
limits. The registry slice covers chain-specific FTSO feed resolution and
missing-feed rejection. Settlement covers signed fee-limit validation, maker
minimum preservation, partial/FOK fills, expiry, cancellation, delegated signer
scope, and revocation; aggregate protocol-fee accounting remains a router test
and implementation gate.

The relay lifecycle also rejects seller cancellation at or after the scheduled
auction deadline. Relay key tests cover LP scoping, key expiry, time-bound
rotation, and explicit revocation.

The facility aggregator slice covers deterministic active-quote enumeration and
excludes paused, revoked, reverting, and zero-output facilities.

Adapter coverage also rejects empty withdrawal receivers at the facility
boundary in addition to caller, pause, and liquidity failures.

The SDK slice covers decimal-independent standing-bid minimums, pair rejection,
and nonnegative/capped fee validation.

The oracle slice covers positive NAV values, malformed NAV identity/time/
decimal rejection, empty-policy and nonpositive-reference rejection in addition
to freshness, feed support, decimal normalization, and deviation.

The SIWE slice also covers checksum/lowercase address equivalence at nonce
consumption.

The Solidity proof/feed suite also rejects zero feed identifiers before policy
configuration.

## Phase boundary and deployment posture

This document is the Phase 8 test plan, but the feature is currently still in
implementation/integration hardening (DevKit phases 5–7). The local unit and
contract commands below are evidence for implemented seams; they do not close
the Coston2 financial, fork, FCC, proxy-governance, load, security-review, or
mainnet gates. The Coston2 core deployment and injected-wallet browser check
are recorded, but no browser-extension signing or release-candidate financial
flow has been executed there.

Do not deploy the frontend to Cloudflare, run production keeper instances, or
provision FCC machines during this documentation and local-test reconciliation.
The core Coston2 contracts have been deployed as a non-production integration
fixture; the Coston2 release candidate still requires test assets, live
registry/proof paths, wallet confirmation, browser E2E, and release review.
Mainnet remains blocked by the release policy.

## Test Coverage Goals

- Target 100% statement and branch coverage for new or changed pure TypeScript/Go business logic and critical Solidity settlement, signature, accounting, and proof-validation paths.
- Require a documented exception for unreachable defensive branches or generated code.
- Use Solidity unit, fuzz, invariant, fork, and adversarial tests rather than relying on line coverage alone.
- Exercise every requirements success criterion (`SC-1` through `SC-16`) in at least one automated integration or end-to-end scenario.
- Keep canonical EIP-712, route-result, encryption-envelope, and integer-rounding fixtures shared across TypeScript, Go, and Solidity.
- Preserve and run the existing Stellar frontend and Soroban test suites to ensure the parallel Flare implementation causes no regression.

## Test Layers and Commands

Planned commands may be refined during repository scaffolding, but CI must expose stable top-level equivalents.

```bash
npm test                         # all TypeScript/React unit suites
npm run typecheck                # all TypeScript workspaces
npm run test:integration         # API, indexer, local-chain, FCC integration
npm run test:e2e                 # Playwright role-based browser flows
forge test --offline -vvv        # Solidity unit/fuzz/invariant tests
go test ./... -race -cover       # FCC matcher unit/race tests
npm run test:fork                # Flare mainnet-fork adapter tests
npm run test:load                # API/FCC pilot load profile
npm run build                    # production web/API/SDK builds
```

Currently wired commands in this worktree are `npm test`, `npm run test:flare`,
`npm run test:e2e:flare`, `npm run test:e2e:flare:extension`, `npm run qa:wallet:validate`,
`npm run qa:wallet:setup`, `npm run qa:wallet:cleanup`, `npm run qa:cli`,
`npm run typecheck:flare`, `npm run typecheck:flare-api`, `npm run build`, `npm run build:flare-web`,
`npm run test:go`, `npm run test:go:race`, `npm run test:go:vet`, and the
existing Soroban command. `npm run test:solidity` invokes Foundry without the
offline flag and currently hits a macOS system-proxy lookup panic before test
execution; use `forge test --root contracts/flare --offline` for the local
gate. The integration,
fork, and load commands above remain planned gates until their process fixtures
and scripts are added. `test:e2e:flare*` covers the injected EIP-1193 wallet
boundary only. The MetaMask-extension path is `qa:wallet:*` + `qa:cli` (see
`docs/qa-playwright-metamask.md`) and must not be reported as mainnet custody
or a release-candidate financial flow.

## Unit Tests

### Canonical types, signatures, and route math

- [ ] Golden-test the EIP-712 domain and order hash in TypeScript, Go, and Solidity for EOAs.
- [ ] Golden-test ERC-1271 validation using valid, invalid, reverting, and malformed-return wallets.
- [ ] Verify delegated signers are accepted only for the configured principal, pairs, notional cap, fill mode, and expiry.
- [ ] Reject revoked, expired, cross-chain, cross-router, wrong-domain, malleable, and replayed signatures.
- [ ] Verify integer decimal normalization for 6-, 8-, and 18-decimal tokens without floating point.
- [ ] Verify ranking maximizes taker output after fees and applies deterministic tie-break rules.
- [ ] Verify route blending respects source capacity, exact sell amount, min output, and per-leg rounding.
- [ ] Verify confidential one-off bids bind seller, router, auction/context commitment, chain, expiry, winner, and recipient; copied public calldata cannot redirect them.
- [ ] Verify public standing/limit bids remain reusable only within signed pair, capacity, fill mode, expiry, fee-limit, and aggregate-limit constraints.
- [ ] Verify one aggregate router fee is applied across LP, facility, and liquidation output; settlement does not assess a second TrustRFQ fee.
- [ ] Verify `24 hours`, `1 week`, `1 month`, and `3 months` encode to exact deterministic deadlines.
- [ ] Verify no 3-30-second auction option appears in the domain model or UI configuration.
- [ ] Verify early close is permitted only when committed at auction creation and always ranks the deterministic best eligible route at the pinned decision context.

### `RFQSettlement`

- [ ] Fill a valid RFQ order through EOA signature validation.
- [ ] Fill a valid order through ERC-1271 validation.
- [ ] Fill with an active delegated signer and reject every scope violation.
- [ ] Track partial fills and prevent aggregate overfill.
- [ ] Require exact fill for fill-or-kill orders.
- [ ] Reject expired orders and route/order deadline mismatch.
- [ ] Reject reused nonce/order hash after completion.
- [ ] Advance pair salt and invalidate only the intended maker/pair orders.
- [ ] Cancel one order without invalidating unrelated orders.
- [ ] Enforce optional taker restriction.
- [ ] Enforce active router fee <= signed order limit without charging a protocol fee inside settlement.
- [ ] Verify zero-fee pilot configuration transfers no fee.
- [ ] Validate SafeERC20 behavior and reject unsupported fee-on-transfer/rebasing behavior unless explicitly allowed.
- [ ] Assert all events contain sufficient identifiers for reconstruction without sensitive off-chain data.

### `RFQRouter`

- [ ] Execute one LP leg and one facility leg independently.
- [ ] Execute multiple LP and facility legs as one route.
- [ ] Revert the whole route when any leg reverts.
- [ ] Revert when observed aggregate output is below `minOutput`.
- [ ] Reject expired route, wrong decision block, wrong chain, wrong router, and mismatched RFQ commitment.
- [ ] Reject a decision block/hash mismatch and a snapshot older than the configured settlement bound.
- [ ] Reject unregistered sources and any attempt to inject arbitrary calldata/targets.
- [ ] Reject duplicate leg/order consumption that would overfill.
- [ ] Verify route replay protection after successful execution.
- [ ] Verify reentrancy cannot re-enter route or source fills.
- [ ] Verify result quorum accepts two byte-identical valid TEE results and rejects fewer than two.
- [ ] Reject mismatched result hashes even when each individual TEE signature is valid.
- [ ] Execute a typed `executeSwapRoute` bound to seller, recipient, router, chain, order/auction commitment, decision context, and deadline.
- [ ] Execute a typed `executeLiquidationRoute` bound to venue, market, position, debt/collateral pair, max repay, minimum net collateral, winner, recipient, adapter, and quorum.
- [ ] Apply exactly one aggregate fee across every route kind and enforce the recipient's minimum against net output.
- [ ] Reject arbitrary targets, calldata, delegatecalls, unapproved sources/adapters, stale policy context, and execution by an unbound wallet.
- [ ] Verify complete rollback when a swap leg, liquidation repayment, collateral delivery, fee transfer, or recipient transfer fails.

### `EligibilityRegistry`

- [ ] Register, expire, revoke, and audit wallet/role policies with valid-from, expiry, issuer reference, and revocation epoch.
- [ ] Enforce the same current policy snapshot at router, settlement, facility, and liquidation entry points.
- [ ] Verify policy changes are timelocked and guardian pause cannot upgrade, transfer, or bypass eligibility.
- [ ] Keep KYC/sanctions payloads off-chain; on-chain records contain only minimal status and audit references.

### `FacilityAggregator`

- [ ] Register, pause, unpause, and revoke facilities under the correct roles/timelock.
- [ ] Return comparable quotes from active facilities and isolate one facility's quote failure.
- [ ] Exclude expired, paused, revoked, wrong-pair, and insufficient-capacity facility quotes.
- [ ] Route blended fills only to facilities present in the signed source snapshot.

### `LiquidityFacility`

- [ ] Mint shares with correct ERC-4626 rounding for initial and non-initial deposits.
- [ ] Calculate total assets across idle assets, adapter balances, RWA inventory, receivables, fees, and realized losses.
- [ ] Execute an immediate withdrawal when sufficient liquidity exists.
- [ ] Queue a withdrawal when liquidity is deployed or redemption is pending.
- [ ] Lock/burn shares exactly once and settle queued requests in deterministic order.
- [ ] Respect `minAssets` and reject loss beyond depositor tolerance.
- [ ] Allocate and deallocate only through curator-approved, governance-whitelisted adapters.
- [ ] Enforce per-asset, aggregate, concentration, and adapter caps.
- [ ] Quote verified NAV less haircut with explicit rounding in the facility's favor/taker's disclosed minimum.
- [ ] Reject stale NAV, stale FTSO guardrail, excessive deviation, paused pair, or expired quote.
- [ ] Fill an RFQ and atomically book acquired RWA inventory.
- [ ] Book one issuer-redemption request per inventory lot and prevent duplicate settlement.
- [ ] Account for exact, short, late, and failed redemption proceeds.
- [x] Carry each acquired-RWA lot at the lower of acquisition cost and latest verified NAV; recognize impairment immediately and redemption upside only after proceeds settle. Selected-lot redemption removes the exact inventory quantity and leaves unrelated lots intact.
- [ ] Prevent curator, guardian, and governance roles from exceeding their authority.

### Adapter conformance

Run the same suite against every adapter:

- [ ] `asset()` returns the facility base token.
- [ ] `deposit` moves no more than the approved amount and accurately reports deployed assets.
- [ ] `withdraw` sends assets only to the facility-provided receiver and accurately reports returned assets.
- [ ] `totalAssets` includes principal plus supported accrued yield with conservative rounding.
- [ ] `maxWithdraw` never exceeds venue liquidity or the adapter's actual claim.
- [ ] Unsupported assets, markets, receivers, and direct external callers revert.
- [ ] Paused, illiquid, insolvent, or reverting venue behavior cannot corrupt facility accounting.
- [ ] Reentrancy and malicious token callbacks do not bypass facility controls.

Venue-specific cases:

- [ ] Morpho adapter handles approved market/vault share conversion, caps, and current liquidity.
- [ ] Kinetic adapter handles exchange-rate accrual, available cash, paused markets, and withdrawal constraints.
- [ ] Clearpool adapter accepts USDX only, values cUSDX correctly, and handles T-Pool withdrawal/reward edge cases.

### Atomic liquidation adapters

- [ ] Run the common liquidation adapter suite against Morpho and Kinetic interface-faithful mocks and every supported deployed market.
- [ ] Validate fixed market/token configuration, borrower/position binding, unhealthy-position and close-factor rules, debt repayment, collateral receipt, and recipient constraints.
- [ ] Measure repayment and seized collateral by balance delta; reject malformed returns, fee-on-transfer behavior, approval residue, and unexpected token pairs.
- [ ] Verify Clearpool is rejected as an atomic liquidation venue and remains yield-only.
- [ ] Verify adapter pause, venue pause, zero liquidity, and every downstream revert leaves no partial economic effect.

### FDC proof modules

- [ ] Accept a valid typed issuer NAV proof and store its scaled value, decimals, source, and as-of time.
- [ ] Reject invalid Merkle proof, wrong attestation type, wrong source, wrong asset ID, malformed ABI data, and wrong proof owner.
- [ ] Reject older NAV records and duplicate request/proof digests.
- [ ] Reject values outside configured numeric bounds or unexpected decimals.
- [ ] Accept a valid issuer-redemption proof for the matching open request.
- [ ] Reject mismatched amount, recipient, issuer reference, transaction/event, or already-settled request.
- [ ] Verify no raw Web2 response or proof bytes are interpreted as free-form instructions.

### FTSO risk guard

- [ ] Resolve the expected FTSO interface through the network-specific registry mock.
- [ ] Normalize positive and negative decimal values correctly.
- [ ] Accept a fresh feed inside the configured range.
- [ ] Reject stale timestamp, unsupported feed ID, zero/invalid value, and excessive deviation.
- [ ] Verify stablecoin depeg pauses only dependent pairs.
- [ ] Verify Scaling anchor proof validation when configured.

### FCC Go matcher

- [ ] Reject unknown JSON/ABI fields, invalid lengths, oversized payloads, numeric overflow, and unsupported OP identifiers.
- [ ] Validate RFQ commitment, eligibility, pair, deadline, chain, router, and token metadata.
- [ ] Validate EIP-712 bid signatures and delegated signer scope at the pinned block.
- [ ] Reject duplicate bid commitments, replayed nonces, late bids, and bids for cancelled auctions.
- [ ] Rank one-off bids, standing bids, and facility snapshots deterministically.
- [ ] Rank swap and liquidation sources with the same deterministic tie-break rules while preserving route-kind-specific bindings.
- [ ] Reject liquidation bids whose venue, market, position, debt/collateral pair, max repay, winner, recipient, or decision context differs from the opportunity.
- [ ] Reject early-close requests unless the creation commitment enabled them; early close must not expose or cherry-pick an individual sealed bid.
- [ ] Produce identical route bytes across repeated runs and supported architectures.
- [ ] Produce identical results regardless of input arrival ordering when sequence metadata is the same.
- [ ] Apply deterministic tie-break behavior.
- [ ] Fail closed when facility snapshot proof/block context is missing or inconsistent.
- [ ] Redact plaintext payloads from logs and errors.
- [ ] Pass Go race detection for concurrent auctions and bids.
- [ ] Verify state recovery does not revive cancelled, expired, or already-finalized auctions.

### Encryption envelope

- [ ] Round-trip a versioned client-to-TEE encrypted RFQ and bid.
- [ ] Golden-test one canonical plaintext encrypted independently to exactly
  three selected TEE keys in one committed outer envelope; TypeScript and Go
  must agree on outer bytes, associated data, plaintext commitment, and digest.
- [ ] Verify each of three handlers decrypts exactly one recipient entry and
  rejects zero or multiple successful decryptions, duplicate TEE/key IDs,
  duplicate ciphertext digests, a fourth recipient, and recipient reordering
  that changes the committed canonical envelope.
- [ ] Verify all three decrypted payloads match the same public plaintext
  commitment; intentionally different per-recipient plaintext must fail before
  matching or produce no quorum.
- [ ] Reject tampered ciphertext, associated data, key ID, nonce, commitment, or expiry.
- [x] Verify tampered outer action metadata is rejected as authenticated-data
  failure before commitment comparison (TypeScript + Go).
- [ ] Reject ciphertext for a superseded/unattested key according to rotation policy.
- [x] Verify relay/database serialization never introduces plaintext fields; the
  persisted snapshot contains only the encrypted envelope and routing metadata,
  and invalid relay snapshots fail startup rather than serving an empty state.
- [ ] Verify role-scoped auction delivery cannot be decrypted by an ineligible LP fixture.
- [ ] Verify FCC re-encrypts only the allowed quoting view to the eligible LP's registered key and honors key rotation/revocation.
- [ ] Verify sensitive data never appears in URL state, analytics payloads, browser logs, or API logs.

### Coston2 scaffold-native three-TEE acceptance

- [ ] Pin the official scaffold commit and fixture-test the action, decrypt,
  `/info`, registration, and signed-result schemas used by TrustRFQ.
- [ ] Start three isolated simulated TEE/proxy/Redis stacks with distinct
  identities, keys, ports, URLs, and state; fail configuration on any reuse.
- [ ] Execute encrypted RFQ CREATE, at least two BID SUBMIT operations, and MATCH
  FINALIZE through all three handlers and obtain the shared canonical route
  hash.
- [ ] Submit signed results from two selected distinct TEEs and verify
  `quorum(actionId)` returns that route hash; reject non-selected, duplicate,
  malformed, expired, wrong-chain, wrong-status, and wrong-action results.
- [ ] Stop one machine and verify the 2-of-3 result still completes. Stop two
  machines and verify matching and settlement fail closed.
- [ ] Scan API, Redis, proxy, tunnel, result-relay, and evidence output for RFQ
  and losing-bid plaintext, private keys, database passwords, and signatures.
- [ ] Verify release gates continue to classify the evidence as simulated and
  reject any production FCC/attestation claim.

### API and authorization

- [ ] SIWE nonce is single-use, domain-bound, time-bound, and chain-aware.
- [ ] Reject invalid wallet signature, stale nonce, wrong origin/domain, and replay.
- [ ] Enforce eligibility on RFQ creation, delivery, bid intake, transaction retrieval, and settlement preparation.
- [ ] Keep off-chain eligibility decisions consistent with the on-chain `EligibilityRegistry` policy ID, expiry, and revocation epoch at execution time.
- [ ] Enforce liquidation opportunity/bid/transaction authorization without giving keepers custody, plaintext bids, arbitrary target selection, or proceeds.
- [x] Enforce bot credential scopes, institution binding, request timestamp, body digest, revocation, optional mTLS identity binding, and signed bot WebSocket subscriptions; deployment certificates remain an operations gate.
- [x] Return safe stable error codes without stack traces, signatures, proof bytes, or plaintext.
- [x] Apply rate and connection limits per human/bot role; request-size limits are enforced by `FLARE_API_MAX_BODY_BYTES`.
- [x] Real auth-required API rehearsal rejects unsigned bot mutation/read requests,
  accepts signed HMAC requests, and enforces immediate credential revocation;
  optional mTLS institution binding has focused certificate tests.
- [x] Real HTTPS+mTLS listener probe rejects a clientless handshake and accepts a
  CA-trusted institution certificate; health reports TLS/mTLS state.
- [x] Headed browser rehearsal checks responsive no-overflow at 375/768/1280px,
  visible keyboard focus across the main route, reduced-motion media, and axe
  violations for the role routes; extension-specific signing remains external.
- [x] Deduplicate retries by idempotency key; relay/API tests return the original
  accepted result for repeated bid submissions.
- [x] Resume WebSocket streams from a cursor without duplicate lifecycle transitions; human SIWE and signed bot subprotocols are covered.

### Indexer and keepers

- [x] Project contract events idempotently into the dual Redis/Mongo checkpoint
  boundary; duplicate and conflict behavior is covered by operations tests.
- [x] Roll back and replay projections across simulated RPC reorg/inconsistent-provider cases; finalized reorgs fail closed.
- [x] Detect and report indexer freshness as `fresh`, `stale`, or `unknown`; the
  indexer `/readyz` endpoint fails closed before a recent successful poll and
  exposes a Prometheus freshness gauge.
- [ ] Trigger expiry/finalization, FDC progression, redemption settlement, and liquidation RFQs idempotently.
- [ ] Project aggregate-fee, eligibility-policy, liquidation-opportunity, liquidation-route, collateral-delta, rollback, and recipient-delivery events without confidential payloads.
- [x] Allow independent keeper lease owners to race safely; the same due job
  admits exactly one action and the losing worker fails closed.
- [ ] Verify keeper failure never grants custody or bypasses user signatures.

### React frontend

- [x] Render Swap/Redeem, Auctions, Standing Bids, Dashboard, Facility,
  Liquidations, and Curator routes; headed Chrome navigation covered each route.
- [ ] Render disconnected, wrong-network, loading, empty, stale, offline, error, ready, awaiting-signature, submitted, confirmed, reverted, cancelled, expired, FCC matching, and queued-redemption states.
- [x] Token selector supports search, verified symbol/address, copy, network, and eligibility filtering; headed Chrome also verifies the clipboard-denied fallback state.
- [x] Amount fields use text/decimal input, preserve canonical `1.0` and `995.0`
  values, and the live quote flow verifies exact integer output.
- [x] Balance shortcuts calculate 25%, 50%, and Max correctly after reserving required gas/constraints where applicable.
- [x] Swap and liquidation review surfaces expose route/source, fee, gross/net,
  minimum, and recipient-bound details before the wallet-signing boundary.
- [x] Swap and liquidation route review separates gross output, venue/source
  costs, the single protocol fee, and recipient net output; minimum-output labels
  refer to net output.
- [x] Liquidation surfaces show venue, market, position, debt/collateral,
  maximum repay, freshness/binding fields, and route status without exposing
  competing bids; unverified venues cannot construct a transaction.
- [x] Tables sort accessibly with `aria-sort`, retain URL-safe filters/pagination, and avoid sensitive URL values.
- [ ] Dialogs trap/return focus and close with Escape.
- [ ] All actions use semantic buttons/links, visible focus, and >=40x40 px touch targets.
- [ ] Skeletons preserve layout and errors provide inline recovery without clearing financial forms.
- [x] Motion respects `prefers-reduced-motion`; headed Chrome exercised the
  reduced-motion route state.

## Solidity Fuzz and Invariant Tests

- [ ] Fuzz order amounts, fill amounts, decimals, fees, expiries, and salts across valid bounds.
- [ ] Fuzz blended routes with varying source count/capacity; total input consumed never exceeds the seller-authorized amount.
- [ ] Invariant: successful route output is always >= signed `minOutput`.
- [ ] Invariant: a route either applies every leg or no observable state/fund movement remains.
- [ ] Invariant: no signed order can be filled beyond its maximum amount.
- [ ] Invariant: cancellation/expiry/replay state is monotonic.
- [ ] Invariant: facility share supply and accounted claims cannot exceed conservatively valued assets after realized loss.
- [ ] Invariant: queued withdrawals cannot be paid or shares consumed twice.
- [ ] Invariant: adapter-reported assets cannot make the facility transfer more base tokens than it owns/receives.
- [ ] Invariant: guardian and curator cannot access upgrade or arbitrary-transfer authority.
- [ ] Invariant: protocol fee can never exceed 50 bps and is assessed once by the router, never by settlement plus router.
- [ ] Invariant: confidential route bindings cannot be replayed by another seller, winner, recipient, router, auction, chain, or expired context.
- [ ] Invariant: an atomic liquidation either repays the approved position, receives/delivers measured collateral at or above net minimum, and updates all state, or leaves no economic state change.
- [ ] Invariant: liquidation adapters cannot repay an unapproved market/borrower/pair or use arbitrary calldata.
- [ ] Invariant: expired/revoked/ineligible wallets cannot pass any fund-moving entry point even when off-chain eligibility is stale.

## Integration Tests

### Local full-stack

- [x] Start local EVM chain, MongoDB, broker, mock FCC stack, API, indexer, and
  keepers from the documented Compose command; the web app was run alongside it
  for headed browser verification.
- [ ] Create a mock permissioned RWA and stablecoin with representative decimals and eligibility checks.
- [ ] Complete immediate LP-only settlement (`SC-1`).
- [ ] Complete facility-only settlement (`SC-2`).
- [ ] Complete blended settlement and force one-leg rollback (`SC-3`).
- [ ] Complete all scheduled-auction durations and deterministic finalization (`SC-4`).
- [ ] Early-close an auction whose creation policy permits it and verify the deterministic best eligible route; reject early-close when policy did not permit it (`SC-4`).
- [ ] Inspect relay/API/database/log output and assert confidential plaintext absence (`SC-5`).
- [ ] Exercise all invalid signature, attestation, quorum, eligibility, and replay paths (`SC-6`).
- [ ] Complete facility deposit-to-redemption-to-withdrawal lifecycle (`SC-7`).
- [ ] Expire FDC/FTSO data and assert pair-local quote suspension (`SC-8`).
- [ ] Execute an interface-faithful Morpho or Kinetic liquidation route, assert one router fee and net minimum, then inject repayment/collateral/fee/recipient failures and verify full rollback (`SC-16`).

### Flare system integration

- [x] Coston2 contract suite compiles with Cancun target and the deployment
  smoke resolves the recorded Flare system contracts through the registry.
- [x] Coston2 FTSO reads validate feed value, decimals, and timestamp through
  typed interfaces; the latest live read returned FLR/USD value `601038`,
  decimals `8`, and a current timestamp.
- [ ] FDC prepare-request, submit, finalization wait, proof retrieval, and on-chain verification work for a controlled NAV fixture.
- [ ] Coston2 route calls resolve the shared eligibility policy and typed liquidation adapter through the correct network registry/configuration.
- [ ] Real FCC proxy `/info` reports the expected extension ID, owner, platform measurement, and non-simulated code hash before any security claim.
- [ ] FCC instruction round-trip validates exact OP type/command mapping and signed result verification.
- [ ] Production-mode build rejects simulated attestation configuration.

### Venue fork and mocks

- [x] Add a fail-closed harness that requires an operator-supplied positive Flare
  mainnet fork block and skips without RPC inputs; this is harness coverage, not
  a successful fork result.
- [ ] Run at an approved pinned Flare mainnet block and verify deployment-time
  code/address/underlying bindings from authoritative registries/docs.
- [ ] Execute Morpho adapter deposit, accrual/read, and withdrawal against the available Flare contracts.
- [ ] Execute Kinetic supply, exchange-rate valuation, cash constraint, and withdrawal against the available Flare contracts.
- [ ] Execute Clearpool USDX/cUSDX deposit, valuation, and withdrawal against the T-Pool.
- [x] Run the common conformance fixture against the Coston2 interface mock;
  the fixture explicitly records that it is not deployed venue or fork evidence.
- [x] Local mocks cover facility/caller and asset binding, pause, zero cash,
  market error codes, approval cleanup, non-1:1 Vault V2 shares, and Kinetic
  exchange-rate valuation. They do not prove deployed venue behavior.
- [ ] Add malformed ABI-return and insolvent-market cases for every selected live
  venue interface.
- [x] Local liquidation mocks cover health, close factor, venue/position binding,
  debt repayment, collateral transfer, and a successful partial liquidation.
- [ ] Verify seized-collateral shortfall, allowance residue, recipient mismatch,
  every rollback point, and production venue semantics on a pinned fork.
- [x] The evidence runner rejects skips, failures, ambiguous summaries, and
  multiple matching tests; it records measured duration and only the RPC origin.

### Optional FAssets extension

- [ ] Resolve FXRP AssetManager and token addresses through the Flare registry.
- [ ] Encode a Core Vault mint recipient through supported destination-tag or memo fixtures.
- [ ] Model delayed minting limits and executor windows without representing pending FXRP as spendable.
- [ ] Model amount-based and destination-tag redemption states.
- [ ] Require explicit wallet/user confirmation for each Flare or XRPL state-changing step.
- [ ] Verify disabling/removing this extension leaves every core RFQ flow passing.

## End-to-End Browser Tests

Use isolated seller, LP, depositor, curator, and guardian wallet fixtures.

- [ ] Seller connects on Coston2, switches from a wrong network, selects tokens, reviews an immediate LP route, signs, and sees confirmed settlement.
- [ ] Seller accepts a facility-only quote after reviewing NAV age, haircut, guardrail, and source.
- [ ] Seller creates a 24-hour scheduled auction; eligible LP receives it and submits an encrypted bid through the UI.
- [ ] LP bot submits a bid using scoped credentials; the LP UI sees status without competitor plaintext.
- [ ] Seller sees bid count and authorized best-price status, finalizes, reviews the route, and settles.
- [ ] A losing LP sees a non-winning status but no winner identity or competing price before public settlement.
- [ ] Seller cancels an open auction and all later bids/route retrieval fail safely.
- [ ] LP creates, pauses, replaces, and cancels a standing bid.
- [ ] Depositor enters a facility, sees shares/NAV, requests an illiquid withdrawal, and sees it progress from queued to claimable/settled.
- [ ] Curator changes policy within bounds, allocates to an approved adapter, and is prevented from selecting an unapproved adapter.
- [ ] Curator enables a liquidation market within separate caps and is prevented from selecting an unapproved venue, market, adapter, borrower, or recipient.
- [ ] Guardian pauses one adapter/pair and unrelated routes remain available.
- [ ] Seller or winning liquidator reviews a typed liquidation route's gross collateral, one fee, net minimum, and recipient before signing; another wallet cannot consume it.
- [ ] FCC outage fails closed and presents explicit opt-in for facility-only public quoting.
- [ ] FDC/FTSO stale state explains why a quote is unavailable and provides a safe retry path.
- [ ] All production routes and operational states satisfy `SC-10`.

## Playwright CLI + MetaMask (extension-backed)

This layer is separate from injected EIP-1193 smokes. dAppwright bootstraps a
disposable MetaMask profile once; Playwright CLI reuses that profile. Default
network is Coston2 (`chainId` 114 / `0x72`, native `C2FLR`). Mainnet
(`chainId` 14 / `0xe`, `FLR`) is approval-gated. Operator docs:
`docs/qa-playwright-metamask.md`.

```bash
npm run qa:browser:install
npm run qa:cli:install-browser
npm run qa:wallet:validate
npm run qa:wallet:setup          # requires disposable seed + running DAPP_URL
npm run qa:cli -- --config .playwright/cli.config.json open "$DAPP_URL" --headed
```

- [x] `qa:wallet:validate` accepts Coston2 config and a disposable BIP-39 seed; rejects missing/invalid password or mnemonic. (2026-08-13: exit 0, `MetaMask QA configuration is valid.`)
- [x] `qa:wallet:setup` downloads MetaMask, imports the disposable wallet, adds Coston2, and persists `.playwright/metamask-local/` plus `.playwright/cli.config.json`. (2026-08-13: exit 0 after Vite IPv4 bind; MetaMask 13.17.0.)
- [x] Opening `DAPP_URL` with the persisted profile exposes `window.ethereum` and reports chain ID `0x72`. (`eval` after connect: `hasEth=true`, `chainId=0x72`.)
- [x] Connect-wallet QA: snapshot dApp → activate connect → approve MetaMask popup → screenshot in `output/playwright/`. (`t58-dapp-connected.png`; header `0xcC1B…088A`.)
- [x] After CLI restart, MetaMask unlock uses the current snapshot refs (Password / Unlock), not hardcoded selectors. (`t58-metamask-unlock.yml` refs `e13`/`e14`.)
- [x] Named-session isolation: `-s=isolated --profile=.playwright/metamask-isolated` does not share the default wallet state. (Isolated MetaMask `#/onboarding/welcome`; `selected=null`; default session stayed `0x72` + same account.)
- [x] Artifact scan of `output/playwright/` and committed files contains no seed, password, or private key. (`secret_hits=0`, `tracked_secret_hits=0`, `forbidden_tracked=0`; one fill snapshot redacted.)
- [ ] `qa:wallet:cleanup` removes only `.playwright/metamask-local/` and `.playwright/metamask-extension/`. (Not run; persist profile retained.)
- [x] Injected `test:e2e:flare*` evidence is recorded separately and is not cited as extension-backed.
- [x] The setup path derives and preflights three disposable Coston2 accounts;
  no mnemonic/private key is written to the profile or evidence output.
- [x] `test:e2e:flare:cli` has fail-closed server preflights and a syntax-checked
  Playwright CLI script for confidential auction ingress, standing bid,
  withdrawal, liquidation review, swap submission/indexing, and responsive
  overflow.
- [ ] Run the new CLI acceptance script in a listener-capable environment. This
  environment rejected both Vite and API binds to `127.0.0.1` with `EPERM`, so
  no fresh browser-pass claim is made.

## Security Testing

- [ ] Run Slither with reviewed findings and configuration.
- [ ] Run Foundry fuzz/invariant tests at CI and extended nightly depths.
- [x] Generate the deterministic CycloneDX SBOM; external dependency review and
  signed release approval remain gates.
- [ ] Run secret scanning over source, history introduced by the feature branch, build output, and deployment manifests.
- [ ] Test reentrancy, malicious ERC-20, signature malleability, ERC-1271 gas/revert griefing, approval front-running, stale-oracle, proof replay, arbitrary-call, and role-escalation attacks.
- [ ] Test atomic liquidation market/position binding, close-factor and health validation, debt/collateral balance deltas, allowance cleanup, recipient binding, single-fee accounting, and complete rollback.
- [ ] Test proxy initialization, storage-layout compatibility, timelock delay, guardian pause-only authority, immutable facility/adapter versioning, and voluntary migration registration.
- [ ] Test ciphertext replay, TEE key substitution, downgrade to simulated attestation, code-hash mismatch, split-brain result, quorum loss, and malicious relay ordering.
- [ ] Verify CSP, CORS, CSRF posture, SIWE origin binding, WSS authentication, rate limits, request bounds, and safe error serialization.
- [ ] Verify logs, traces, metrics labels, analytics, crash dumps, and support exports contain no RFQ/bid plaintext or credentials.
- [ ] Conduct an external review of contracts and FCC cryptographic/attestation boundaries and close all critical/high findings (`SC-12`).
- [ ] Run the mainnet release gate with real attestation and 2-of-3 quorum failure injection (`SC-13`).

## Test Data and Fixtures

- Deterministic wallets for seller, two LPs, depositor, curator, guardian, multisig, and malicious actors; never production keys.
- Mock permissioned RWA tokens covering 6, 8, and 18 decimals plus allowlist/freeze behavior.
- Coston2 stablecoin fixtures and local mock stablecoins with depeg scenarios.
- EIP-712 golden vectors for every order/fill mode and delegated signer state.
- Encrypted RFQ/bid vectors with valid, tampered, expired, wrong-key, and replayed envelopes.
- FCC route-result vectors for LP-only, facility-only, blended, tie, insufficient-capacity, and quorum-mismatch cases.
- Liquidation route/result vectors for Morpho/Kinetic success, unhealthy/close-factor rejection, collateral shortfall, one-fee/net-minimum, recipient binding, and every rollback point.
- Eligibility policy vectors for valid, expired, revoked, wrong-role, wrong-issuer-reference, and stale-revocation-epoch decisions across all fund-moving entry points.
- FDC NAV and redemption fixtures with fixed ABI schemas, scaled integers, proof owner, source, round, and timestamp.
- FTSO fixtures for fresh, stale, negative-decimal, unsupported, depeg, and excessive-deviation cases.
- Facility accounting fixtures for profit, exact redemption, short redemption, default, illiquidity, and queued withdrawals.
- Recorded ABI-conformant venue state for deterministic local adapter mocks; fork tests remain separately pinned.

## Manual Testing

- [ ] Compare every desktop route with the approved visual references for hierarchy, density, alignment, spacing, table behavior, and action emphasis.
- [ ] Verify screenshots' recording controls and chat bubbles are absent.
- [ ] Keyboard-only walkthrough: logical Tab order, arrows for composites, Enter/Space activation, Escape dismissal, and focus return.
- [ ] Screen-reader walkthrough for wallet state, token selector, forms, table headers/sorting, status changes, errors, and transaction progress.
- [ ] Contrast audit for default, hover, focus, disabled, semantic tags, and error states.
- [ ] Responsive review at 375 px, 768 px, and 1280 px with no hidden required actions or horizontal-page overflow.
- [ ] Reduced-motion review and 200% zoom review.
- [ ] Browser matrix: current and previous Chrome, Firefox, Safari, and Edge releases.
- [ ] Hardware-wallet/manual ERC-1271 flow where automation cannot accurately reproduce wallet UX.
- [ ] Production smoke test after deployment: static assets/CSP, wallet connect, read paths, encrypted RFQ dry run, index freshness, and explorer links.

## Performance and Reliability Testing

- [ ] Generate 100 concurrent auctions with 50 bids each and representative standing/facility sources.
- [ ] Measure encrypted bid ingestion below 500 ms p95 excluding client encryption (`SC-14`).
- [ ] Measure deterministic ranking plus quorum below 2 seconds p95 after decision deadline (`SC-14`).
- [x] Unit-test monotonic elapsed measurement around the actual awaited matcher
  operation; reject a backward clock rather than emitting false evidence.
- [x] Run the listener-free simulated confidential lifecycle through the actual
  `BlindRelay` finalization and TypeScript matcher, capture its monotonic elapsed
  duration, validate winner/result hash, and prove unprovisioned real FCC mode
  fails closed. Fresh result: **1.823 ms** for pinned scenario time
  `1700000000`; simulated/non-production only.
- [ ] Capture real HTTP matcher elapsed samples and p95. The local RFQ E2E cannot
  bind its API server in this environment (`EPERM`).
- [ ] Test WebSocket reconnect storms, slow consumers, broker backpressure, API restart, TEE restart, and indexer replay.
- [ ] Test one TEE unavailable, one TEE dissenting, two TEEs unavailable, and all TEEs returning late.
- [ ] Test primary RPC failure and secondary-provider recovery without accepting inconsistent decision-block data.
- [ ] Test FDC finalization delay, verifier/DA-layer retry, and proof expiry behavior.
- [ ] Test adapter liquidity shock and withdrawal queue growth.
- [ ] Run Lighthouse/Web Vitals against representative production builds and meet LCP/INP/CLS targets (`SC-15`).
- [ ] Soak the coordination stack for 24 hours with confidential payload logging assertions enabled.

### Venue-fork continuation evidence — 2026-08-13

- `forge test --offline --root contracts/flare`: **123 passed, 0 failed, 29 skipped**; every skip is an
  opt-in mainnet-fork case, so the result is local/compiler evidence only.
- The checked Kinetic plan pins block **65,078,017** and maps one-to-one to
  **18** Foundry cases: all common yield/binding cases, fresh-adapter allowlist
  rejection, plus real-position
  liquidation success, health/close-factor rejection, router net-minimum
  rollback, approval cleanup, recipient rejection, and redemption-failure
  atomic rollback. The Clearpool plan maps **10** common T-Pool cases. Morpho is
  limited to an official core/factory binding probe until an authoritative live
  vault is selected.
- Kinetic liquidation access is tested in two explicitly separate modes. The
  Unitroller's `liquidatorsWhitelistVerifier()` must equal Kinetic's documented
  verifier, and a strict current-state case proves a fresh adapter is rejected
  with full rollback. Positive liquidation cases impersonate the verifier's real
  `owner()` only to call its real owner-only `allow(adapter)` function. This
  simulates the deployment prerequisite and is not current mainnet eligibility
  evidence. `vm.store`, `vm.etch`, and code substitution remain prohibited.
- Both venue plans reached their first fork case, but installed Forge 1.5.1
  panicked in macOS `SCDynamicStore` initialization before receiving an RPC
  response; elevated execution produced the same result. The isolated Forge
  1.7.1 download attempt was DNS-blocked, so no case received a pass manifest.
  The runner's exact-one-pass guard and plan validation pass **18/18**. Its
  Foundry invocation uses `--offline`, scopes `--match-contract` to the fork
  suite, and supplies a literal validated test name after anchored matching was
  found to produce false "No tests found" results in Foundry 1.5.1.
- Flare web/API typechecks pass. The focused FCC/browser boundary set passes
  **26/26**. Full Vitest reaches **319 passed / 5 failed**; each failure is a
  WebSocket test stopped by `listen EPERM 127.0.0.1`. The Go matcher core package
  passes, normal/race HTTP suites are listener-blocked, and `go vet` passes.
- `npm run test:e2e:flare:in-process` passed through the actual simulated relay
  finalization/matcher boundary with result hash
  `0xde9f8b94c58188d07f04fb945c87d39eaf1d7acf4ff893ea93b74d4385dd6beb`,
  expected winner, **1.823 ms** elapsed for pinned scenario time `1700000000`,
  opaque-envelope-only relay read state, and real-mode fail-closed behavior.
  This is not HTTP, TEE, or attestation evidence.
- Playwright shell/JavaScript parse checks pass. Runtime acceptance remains open:
  loopback server setup fails with `listen EPERM 127.0.0.1`, and Playwright CLI
  cannot create its daemon cache file (`EPERM`, including elevated execution).
- A successful fork run, a live Morpho vault round trip, executed real-state
  Clearpool/Kinetic operations, SC-9, SC-16, and mainnet readiness remain
  unclaimed. A pinned state where Kinetic's verifier rejects the adapter
  additionally requires real eligibility through the venue's governance path.

## Traceability Matrix

| Success criterion | Primary verification |
|---|---|
| SC-1 | Local integration + seller LP-only E2E |
| SC-2 | Local integration + facility-only E2E |
| SC-3 | Router invariant + blended rollback integration |
| SC-4 | Duration unit tests + scheduled-auction E2E |
| SC-5 | Confidentiality inspection test + log/DB security tests |
| SC-6 | Contract/FCC adversarial suites + quorum integration |
| SC-7 | Facility lifecycle integration + accounting invariants |
| SC-8 | FDC/FTSO unit and integration failure tests |
| SC-9 | Adapter conformance, mainnet-fork, and Coston2 mocks |
| SC-10 | Role-based Playwright suite + manual UX/accessibility review |
| SC-11 | CI coverage reports, fuzz/invariant runs, documented exceptions |
| SC-12 | Static/dependency/secret scans and independent-review closure |
| SC-13 | Mainnet release-gate test and 2-of-3 failure injection |
| SC-14 | API/FCC load test report |
| SC-15 | Accessibility audit and production Web Vitals report |
| SC-16 | Morpho/Kinetic liquidation conformance or interface-faithful mock, router single-fee/net-minimum assertions, and failure-rollback integration |

## Test Reporting and Release Policy

- CI publishes TypeScript, Go, Solidity, Playwright, coverage, fuzz seed, static-analysis, dependency, and load-test artifacts.
- Fork block, network chain ID, contract addresses, FCC code hash, and proof fixture versions are recorded with each applicable report.
- A failed critical-path, confidentiality, atomicity, invariant, or release-gate test blocks promotion.
- Flaky tests are treated as failures and quarantined only with an owner, issue, reason, and removal deadline.
- Mainnet sign-off requires engineering, security, product/UX, and operations approval plus explicit confirmation that no real funds were used before the gate.
- Cloudflare, API, broker, indexer, keeper, and FCC deployment smoke tests are release evidence only after the implementation/integration gates; a local unit-test pass does not authorize network deployment.

## Bug Severity

- **Critical:** fund loss/theft, unauthorized transfer/upgrade, custody breach, forged route/proof, confidentiality compromise at scale, or atomicity failure.
- **High:** replay/overfill, incorrect NAV/share accounting, eligibility bypass, quorum bypass, or inability to withdraw under promised conditions.
- **Medium:** recoverable transaction failure, stale read model, broken role flow, significant accessibility failure, or misleading financial state.
- **Low:** cosmetic inconsistency, non-blocking copy issue, or minor operational inconvenience.

Critical and high issues block all network promotion. Medium issues block production when they affect a required user journey or financial understanding. Any unresolved atomicity, eligibility, confidentiality, or liquidation-route failure blocks `SC-16` and all promotion.

## Scenario log — 2026-08-14 Coston2 live lane

- **Completed (live network, Coston2, SIMULATED_TEE=true):**
  - ext-proxy health gate: internal `/ready` returns 503 with a lagging indexer
    DB and 200 against the shared hackathon indexer — treat 503 as
    "indexer behind", not "proxy down" (matches Flare FCC FAQ).
  - `register-tee -command rRap` full pass: pre-register → fresh attestation →
    availability check proof → promote; on-chain `getTeeMachineStatus=2`.
  - `run-test` end-to-end through public FTDC providers: SAY_HELLO (`0x4085…60cc`)
    and SAY_GOODBYE (`0x5f89…3c92c`) instructions dispatched on-chain, delivered
    to the registered public URL, processed by the TEE, signed results verified.
  - Indexer preflight unchanged: `mysqlAuthenticated=true` against the
    support-issued credentials.
- **Newly discovered scenarios (to codify):**
  - Availability-check instruction dispatched while `/ready`=503 is never
    retried by providers; registration must be re-run after health returns.
  - `query-tee` default registry address reverts on Coston2; must target the
    FlareTeeManager diamond `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`.
  - Quick-tunnel URL churn invalidates the on-chain machine URL; a stable named
    tunnel (or static host) is a prerequisite for anything longer-lived than a
    demo session.
- **Invalidated scenarios:**
  - "Shared hackathon indexer can lag materially" — the observed stall was
    transient; expected steady-state lag is effectively zero.
  - "Local flare-cchain-indexer can substitute for the shared DB" — its
    backfill cannot keep up with head; usable only for offline fixtures.

## 2026-08-14 — playwright-cli wallet lane (real MetaMask, headed)

- **Completed scenarios (live, 2026-08-14 ~23:56 UTC):**
  - dAppwright bootstrap re-run: MetaMask 13.17.0 initialized for Coston2
    (0x72) with persisted profile; provider detected at the dApp.
  - Headed playwright-cli wallet flow (`tools/write-flare-wallet-flow.mjs` →
    `output/playwright/wallet-flow.generated.js`, gitignored):
    real MetaMask connect via the `notification.html`-as-tab workaround;
    connected account `0xcC1B…088A`, `chainId 0x72`; all 7 routes walked;
    confidential auction lifecycle CREATE → LP-A encrypted bid → LP-B
    encrypted bid → FINALIZE; result
    `{walletConnected:true, routesWalked:7, relayRequestsCaptured:4,
    auctionFinalized:true}`; zero console errors; no horizontal overflow;
    screenshot `output/playwright/flare-wallet-cli.png`.
  - Read-model confidentiality: auctions table shows `Encrypted RFQ`
    only; bid amounts (`1234.5`, `2345.6`) and minimum output never
    appear in the read model.
- **Newly discovered scenarios (codified):**
  - The MetaMask extension popup is not drivable as a context page under
    playwright-cli; pending requests must be approved by opening
    `chrome-extension://<id>/notification.html` as a tab.
  - Relay finalize from the browser was impossible before 2026-08-14:
    `ENVELOPE_COMMITMENT` on bids (fresh content commitment instead of the
    auction's) and `SIM_MATCH_PAYLOAD_REQUIRED` (AES-GCM ciphertext where
    the simulated matcher expects JSON). Both fixed in
    `apps/flare-web/src/App.tsx` with TDD
    (`src/flare-web.ui.test.ts` round-trips
    `buildSimAuctionEnvelopePayload`/`buildSimBidEnvelopePayload` through
    `createSimFinalizeMatch`).
- **Invalidated scenarios:**
  - "UI relay bid submission works end-to-end" was never true before this
    fix despite unit suites being green — the browser path had no e2e
    coverage of relay bids/finalize until this flow.


## 2026-08-14 (late) — T-E2E-1 live settle BLOCKED (external dependency)

- **Scenario:** fresh `settle:flare:fcc:coston2` → dispatch → TEE results →
  `submitFccResult` quorum → `executeSwapRoute` swap.
- **Result: BLOCKED (external), not a code regression.** Two fresh dispatches
  mined on Coston2 (`dispatch=0x9374044d…`, `0xa0e2c967…`; actionIds
  `0x0545c769…`, `0xc4a1d0c3…`). All three Render TEE result endpoints 404 for
  the full 300 s poll; on-chain `quorum(actionId)` reads `ready=false` for both.
  TEE `/info` remains healthy (policy 5937, ext 66283) — the HTTP front-end is
  up but the instruction-processing workers are not delivering results.
- **Classification:** admin-gated external service (Render dashboard required to
  inspect logs / restart). Repo-side tools can wake (`fcc-wake=PASS`) but cannot
  restart the workers. Reported to operator per phase contract stop conditions.
- **Regression suite state:** full vitest suite green after today's UI fixes —
  55 files / 363 tests PASS; `typecheck:flare` clean.
- **Newly discovered scenario (codified):** TEE front-end health (`/info` 200) is
  not sufficient evidence that the FCC result pipeline is live; live settle
  evidence must include on-chain `quorum.ready=true` or a successful swap hash,
  not just `fcc-wake=PASS`.
