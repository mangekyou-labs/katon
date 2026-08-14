---
phase: implementation
title: Flare Confidential RFQ DEX — Implementation Guide
description: Technical implementation notes, patterns, and code guidelines
feature: flare-confidential-rfq-dex
status: in-progress
---

# Implementation Guide

> Weather-first FCC amendment (2026-08-14): the FCC execution path uses the
> `fce-weather-api` wire pattern (`/info`, `/state`, `/action`, `/decrypt`), a
> binary ABI `FccRecipientEnvelopeV1`, and three independent secp256k1 ECIES
> ciphertexts. Older AES-GCM/custom-HTTP notes below describe the replaced
> prototype only. The Weather upstream commit remains a release blocker until
> it can be fetched and reviewed.

Implementation update (2026-08-14): the local matcher now exposes the
provider-facing `POST /instruction` boundary and
`GET /action/status/<epoch>/<instructionId>`. `ext-proxy` processes forward
those paths to `FCC_EXTENSION_TEE_URL` without decrypting or polling the
indexer; extension-TEE processes handle them locally. Compose uses internal
ports `6664` (proxy) and `6674` (TEE), with isolated local host ports. The
official scaffold source remains unpinned because this environment cannot
resolve GitHub; no upstream commit was fabricated.

Task 4 (2026-08-14): live e2e is `npm run settle:flare:fcc:coston2` plus
`npm run test:e2e:flare:fcc:live`. Settlement writes
`output/playwright/fcc-live-e2e.json`; the headed walk injects
`__FLARE_LIVE_PROOF__` / `__FLARE_ROUTER__` and refuses `0xd9`, the dummy
golden route, and the browser proxy. Fresh settle swap
`0x58331d08b9a5b50acdf85ce86597f9ab461e274ecefce9bf9ba6468f75a43e86`. Do not
treat the simulated `tools/flare-playwright-cli-flow.js` `0xd9` path as
confidential settlement.

## Development Setup

The Flare worktree is `/Users/kyler/repos/TrustRFQ/.worktrees/feature-flare-confidential-rfq-dex`.

```bash
npm ci
npm test
npm run typecheck:flare
npm run build
npm run build:flare-web
npm run test:go
npm run test:go:race
npm run test:go:vet
forge test --root contracts/flare
cargo test --manifest-path contracts/otc_swap/Cargo.toml
```

Node is pinned by `.nvmrc`, Rust by `rust-toolchain.toml`, Solidity by
`contracts/flare/foundry.toml` (`evm_version = "cancun"`), and Go by
`services/fcc-matcher/go.mod`. The `public` Flare deployment must supply
network-specific RPC/API values at runtime; production secrets never enter the
frontend bundle.

## FCC browser and wallet boundaries

`packages/flare-core/src/fccEnvelope.ts` and the Go matcher authenticate the
complete outer action metadata (chain, extension, action, operation, command,
expiry, and plaintext commitment) as AES-GCM associated data. A mutation of
any field therefore fails as `FCC_ENVELOPE_AUTH_FAILED` before matching.

`packages/flare-sdk/src/fcc.ts` constructs only chain-114
`dispatchConfidential` and `submitFccResult` transactions, pins `teeCount=3`,
and validates bytes32/65-byte result boundaries. `qaAccounts.ts` derives the
seller, LP-A, and LP-B addresses from one disposable mnemonic and exposes only
public address/balance records. `scripts/setup-metamask.mjs` enforces Coston2,
preflights all three accounts, and creates the two LP accounts in the
persistent MetaMask profile; it never prints or persists the mnemonic.

The Auctions route now exposes explicit seller/LP-A/LP-B checkpoints for
encrypted bid submission, finalization, and FCC-result relay. Until the
dedicated extension, indexer credentials, three HTTPS proxy tunnels, and
operator-approved Coston2 registration exist, the UI keeps instruction ID,
quorum, and route hash visibly pending instead of presenting simulated relay
state as on-chain FCC evidence.

## Code Structure

```text
apps/flare-web/          React shell and role-based route states
apps/flare-api/          Blind relay boundary (ciphertext + metadata only)
packages/flare-core/     Pure canonical, envelope, matcher, facility, oracle logic
packages/flare-sdk/      Unsigned wallet transaction and standing-bid helpers
packages/flare-contracts/Contract package boundary and deployment manifest/smoke helpers
contracts/flare/         Cancun Solidity settlement/router/guard contracts + tests
services/fcc-matcher/    Strict, deterministic Go matcher and quorum helpers
services/indexer/        Idempotent event projector
services/keepers/        Idempotent keeper job coalescing
infra/                   Deployment boundary documentation and local dependencies
```

Pure logic does not read `window`, hold keys, call wallets, or call networks.
State-changing transactions are assembled as unsigned data and remain with the
user wallet.

## Implementation Notes
**Key technical details to remember:**

### Core Features

- Canonical orders use EIP-712 `TrustRFQ` / version `1`, integer base units,
  explicit chain ID, verifying contract, pair salt, expiry, fill mode, and fee
  cap, plus signed `executor` and `contextCommitment` for confidential
  binding. Typehash:
  `Order(address maker,address taker,address executor,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint64 expiry,uint256 nonce,bytes32 pairSalt,bytes32 contextCommitment,uint8 orderType,uint8 fillMode,uint16 feeBps)`.
  Settlement coverage includes both EOA/delegated signatures and the ERC-1271
  contract-wallet validation path. Cross-language golden digest (domain
  TrustRFQ/1/114/0x…aa with fixed vector fields):
  `0x14abeb3f994d71d79fe5f99fc15ee7b781c885e399427124da9a3da2cfe16572`.
- SIWE sessions verify EIP-4361 domain, chain, time, address, signature, and
  single-use alphanumeric nonce before the relay can authorize a session;
  address casing is normalized at nonce comparison.
- AES-GCM envelopes authenticate version, key ID, commitment, and expiry. The
  blind relay stores only the envelope and operational metadata, while request
  size, LP fanout, bid count, and idempotency limits fail closed at the API
  boundary; cancellation is also rejected once an auction reaches its scheduled
  deadline. A role-scoped relay key registry makes LP key registration,
  time-bound rotation, expiry, and revocation explicit without handling private
  keys.
- Redemption proofs are bound to the open request's asset, inventory, expected
  amount, recipient, issuer reference, source, validity window, and proof owner;
  accepted proof digests are single-use. NAV proofs also reject empty identity
  fields, non-integral timestamps, invalid time windows, and non-integral
  decimals before monotonic storage.
- Matching ranks quoted output descending, then sequence ascending, then
  commitment ascending. A route requires two matching attested results and
  selects the lowest qualifying result hash deterministically; empty TEE or
  result references are ignored so quorum cannot succeed on malformed metadata;
  simulated/test seams are clearly labeled. The API has a durable local store
  seam with atomic replacement, configurable chain/domain SIWE binding, and
  optional wallet-bound bearer authorization for mutations.
- Facility accounting keeps idle assets, deployed assets, inventory NAV, and
  receivables separate. Withdrawals queue when idle liquidity is insufficient;
  redemption loss is explicit and replay-protected. The Solidity facility also
  enforces configurable total-asset, total-deployed, adapter, inventory, and
  haircut policies, settles owner-locked withdrawal requests in ID order,
  supports owner-authorized withdrawal cancellation with locked-share
  restoration, and the aggregator returns only active facilities with
  successful nonzero quotes. Facility quotes now reject future or stale
  decision blocks under an owner-configured bounded snapshot policy. Settlement
  fuzz coverage asserts partial fills never exceed the signed amount. The
  facility also exposes ERC-4626 preview and max-limit views, while
  false-returning and fee-on-transfer token behavior rolls back fill state and
  transfers. RFQ settlement also pins its Solidity EIP-712 type/domain/digest
  construction, rejects expiries outside the canonical `uint64` range, and
  fails closed when token balance introspection is malformed.
- Adapter mocks reject non-facility callers, paused operations, insufficient
  liquidity, and empty withdrawal receivers before changing accounting.
- The pure adapter boundary now also models typed atomic liquidation for Morpho
  and Kinetic categories. Requests bind facility, venue, market, position, debt
  asset, collateral asset, and recipient; unhealthy health factor and close
  factor are enforced with integer balance math, and paused/caller/asset/
  liquidity failures fail closed. These are interface-faithful local policy
  adapters, not verified Flare deployment integrations.
- `RFQSettlement.execute` is the typed LP source consumed by the Router. It
  decodes a fixed `RouteFill` tuple, requires the configured Router caller,
  binds the order pair/taker/executor, enforces `order.feeBps >=
  router.protocolFeeBps()` (maker-signed fee is a hard upper bound on the
  router fee), transfers the maker leg to the Router, and pays the order's full
  signed buy amount to the maker. The Router then measures gross output and
  applies the sole protocol fee. Direct `fill` always reverts
  `ELIGIBILITY_REQUIRED`; `fillWithEligibility` accepts only public standing
  orders (`executor == 0`). Confidential `orderType == 0` requires taker,
  executor, and nonzero context commitment and must settle through the bound
  executor. Settlement and facility fund-moving paths use `nonReentrant`.
  Delegated-signer notional is tracked in aggregate (`delegatedConsumed`).
  When `navProofRegistry` is set, facility quotes/fills/lot refresh use
  `NavProofRegistry.latest` and owner mark-to-market is blocked. The SDK exposes
  matching `buildSettlementSourceData` encoding so route assembly does not rely
  on hand-built ABI bytes. Production FCC config validation rejects simulated
  matcher modes and unset/dummy verifiers (fail-closed).
- The indexer rejects confidential event fields such as ciphertext, plaintext,
  signatures, proof bytes, private keys, and bid payloads before projection.
  Public event projection remains idempotent and finality-aware; the local
  checkpoint adapter persists events, cursor, and finality atomically.
- The web model keeps read-model and confidential execution states typed and
  explicit: loading, empty, ready, stale, offline, error, FCC matching, and
  queued redemption. Read-model tables expose the state as an accessible status
  badge and `aria-busy` signal; current fixtures remain explicitly empty until
  wallet/indexer wiring is available.
- The same pure web model filters only eligible assets on the selected chain,
  parses display amounts into integer base units with decimal precision checks,
  and computes 25%, 50%, and 100% balance shortcuts without floating point.
  Wallet balances, gas reservations, and live token registries remain external
  integration inputs.
- Coston2 deployment addresses are recorded in a public manifest, while the
  deployment helper reads `PRIVATE_KEY` only from the ignored local `.env`.
  The read-only smoke helper checks bytecode, chain identity, proxy admin and
  implementation slots, timelock delay/proposer/executor, ownership, Router
  policy, shared eligibility, and Settlement composition. The proxy candidate
  is explicitly `guardian-pause-v1`; it remains a bootstrap testnet governance
  artifact until a dedicated guardian and multisig handoff are verified.
- The SDK wallet boundary accepts an injected EIP-1193 provider, validates the
  selected chain and authorized sender account, serializes unsigned route data,
  and separates wallet signature, submitted, receipt-confirmed, reverted, and
  indexed states. Indexed confirmation is an injected polling boundary so the
  SDK never invents final indexed state without an indexer observation.
- Browser-extension QA is a separate CLI-first harness, not an injected-provider
  smoke. `scripts/setup-metamask.mjs` uses dAppwright to import a disposable
  BIP-39 wallet, add Coston2 (`114` / `0x72` / `C2FLR` /
  `https://coston2-api.flare.network/ext/C/rpc`), verify `window.ethereum` at
  `DAPP_URL`, and persist `.playwright/metamask-local/` plus
  `.playwright/cli.config.json`. `scripts/cleanup-metamask.mjs` deletes only
  those disposable paths. Operator docs: `docs/qa-playwright-metamask.md`.
  Mainnet (`14` / `0xe` / `FLR`) is approval-gated. Never use a funded seed.
  `@playwright/test` is a direct devDependency because dAppwright imports it
  (`ERR_MODULE_NOT_FOUND` if omitted).

### Patterns & Best Practices

- Every new behavior was added red → green → refactor, with a focused Vitest or
  Foundry/Go test first.
- All external proof, RPC, wallet, ciphertext, and venue values are treated as
  untrusted and validated before business logic.
- Solidity sources are allowlisted and called through typed interfaces; the
  router does not accept arbitrary delegate calls or arbitrary user targets.
- Flare system addresses and FAsset addresses are deployment-time registry
  lookups, never universal constants.
- FTSO feed names resolve through a chain-specific reader and reject missing or
  blank feed IDs before a guard can use them.
- Venue routes require a chain-matched, nonzero, explicitly verified deployment
  record with supported assets before an adapter can be selected; no universal
  Morpho/Kinetic/Clearpool address is assumed.
- The on-chain `EligibilityRegistry` stores only the execution-time policy
  snapshot: wallet, role bitmask, validity window, issuer reference, active
  status, and revocation epoch. Policy replacement increments the epoch, and
  `isEligible`/`requireEligible` fail closed on stale epochs, revoked policies,
  mismatched roles or issuer references, and out-of-window execution. The
  existing-policy replacement is scheduled and activated only after the
  two-day on-chain policy timelock; emergency revocation remains immediate.
  The registry is consumed by the typed Router swap/liquidation paths, Settlement's
  eligibility-aware fill, and Facility execution; legacy paths and governance
  hardening remain before T1.5 is complete.
- `RFQRouter.executeSwapRoute` is the seller-bound typed swap path. It requires
  the configured active fee, an eligibility snapshot, allowlisted sources,
  exact leg totals, and pays one measured aggregate fee before the recipient's
  net minimum is checked. The legacy `executeRoute` remains for compatibility
  and is not the production trust-boundary path.
- `RFQRouter.executeLiquidationRoute` accepts only allowlisted funding sources
  and liquidation adapters. It binds winner, recipient, venue, market,
  position, debt/collateral pair, decision context, and eligibility; it measures
  funded debt, repaid debt, and seized collateral, clears the adapter approval,
  charges one fee, and reverts atomically on any failure. The local adapter is
  interface-faithful but is not a Morpho or Kinetic deployment integration.
- `RFQSettlement.fillWithEligibility` and facility `execute` source metadata
  provide execution-time policy checks for those paths. The generic legacy
  settlement/facility calls remain compatibility seams until the shared policy
  ABI and governance model are finalized.

## Integration Points

The web/SDK produces unsigned EVM calls; standing-bid validation keeps sell and
buy base units independent and rejects same-pair or negative-fee inputs. The
API/relay accepts encrypted
envelopes, uses eligibility plus idempotency keys, and maintains a role-scoped
LP encryption-key lifecycle boundary. The Go and TypeScript
matchers consume strict typed auction/bid input, validate routing and bid
metadata before ranking, and return a deterministic route hash. The
indexer projects `(transaction hash, log index)` once; keepers coalesce the same
economic action and retry only after failure. The router now consumes a decision
block/hash policy, records successful route commitments, uses typed allowlisted
source calls, and rejects reentrancy. `LiquidityFacility` provides the local
  shares/withdrawal/adapter/inventory/redemption baseline, including standard
  share conversion and synchronous exits when idle liquidity exists, while the relay exposes
deterministic lifecycle events from a role-scoped resumable cursor.
`RFQSettlement` validates the shared order/fill enums, supports partial and fill-or-kill fills, expiry/cancellation/
pair-salt replay controls, caps signed protocol fees, and supports
maker-configured delegated signers scoped by token pair, notional, fill mode,
and expiry; the delegation is revoked by the maker and does not replace
ERC-1271 validation.

The local proof/FTSO guards reject nonpositive NAV/reference values, empty
policies, and zero feed IDs before normalizing signed decimals. Live FDC
integration must follow prepare → FdcHub request → finalization → DA Layer proof
retrieval → typed contract verification. Live FTSO integration must
resolve the active registry feed and enforce freshness/decimals/deviation. Those
network calls are intentionally not faked by the local implementation.

## Error Handling

Errors use stable safe codes such as `RFQ_NOT_ELIGIBLE`, `ENVELOPE_AUTH_FAILED`,
`NO_EXECUTABLE_ROUTE`, `QUORUM_UNAVAILABLE`, `FTSO_STALE`, and
`WITHDRAWAL_LIQUIDITY`. Plaintext, signatures, proof bytes, and stack traces do
not belong in user/API/log responses. Private matching fails closed; facility-
only fallback requires explicit user opt-in.

## Performance Considerations

The local core is synchronous/pure where possible, uses cursor/idempotency keys
at service boundaries, and avoids floating-point values. The plan's 100-auction
load target, 500 ms bid-ingestion p95, 2 s route/quorum p95, and Web Vitals
targets still need measured integration reports.

## Security Notes

- EOA low-s malleability checks, ERC-1271 validation, signed fee-limit checks,
  and maker-scoped delegated signer checks are present in `RFQSettlement`; the
  Solidity canonical type/domain/digest and adversarial token slices are local,
  while production-scale nightly fuzz remains follow-up work. Local handler-style
  remainingFillable / protocolFeeOn / malicious-wallet coverage is in
  `contracts/flare/test/SettlementRouterInvariant.t.sol`. The TypeScript/Go
  EIP-712 vector is parity tested.
- Production must replace local proof booleans/configured feeds with Flare's
  registry-resolved FDC/FTSO interfaces and verify typed proofs before state
  changes. The local NAV seam now binds `msg.sender` to the declared proof
  owner, rejects request replay, and enforces monotonic timestamps.
- Real FCC confidentiality is not claimed in simulated mode. Mainnet requires
  reproducible code hashes, real attestation, and a 2-of-3 result quorum.
  The local matcher and InstructionSender now fail closed on thresholds other
  than 2, duplicate attestation endpoints/TEE identities, invalid extension
  IDs, and zero/duplicate machine selections. Real FCC `/info` evidence and
  registered Coston2 machines remain external.
- All fund-moving, instruction, NAV, and FTSO acceptance boundaries expose a
  pause-only guardian path. The guardian cannot unpause, configure, transfer
  ownership, or administer upgrades. The fresh Coston2 candidate has these
  bindings, but its deployer-controlled guardian is not production evidence.
- `packages/flare-sdk/src/data.ts` contains the runtime FTSOv2 Contract Registry
  read boundary and strict FDC verifier/DA client. The API exposes these only
  when deployment-provided endpoints and registry addresses are configured;
  missing live-data configuration fails closed.
  Web2Json preparation additionally requires Flare's JSON ABI-signature schema;
  the public verifier endpoint prepares the documented request only when a real
  `FLARE_FDC_API_KEY` is supplied, while the smoke command fails closed without
  that credential. The Coston2 test flow also accepts the official DA `proof` field
  and records a successful request/finalization/DA/on-chain NAV proof sequence.
- `apps/flare-api/src/mongoStore.ts` provides startup hydration, queued writes,
  flush-before-ack mutation semantics, and graceful shutdown for MongoDB. The
  opaque relay snapshot (ciphertext plus routing metadata, never plaintext) is
  persisted in the same Mongo document and restored fail-closed on startup. The
  JSON store remains a local fallback, and `infra/docker-compose.yml` runs the
  API, MongoDB, Anvil, and matcher boundaries together.
- The relay now exposes a cursor-resumable WebSocket event stream at
  `/v1/relay/events`, durable LP encryption-key registration/rotation/revocation,
  and an opt-in `FLARE_RELAY_REQUIRE_REGISTERED_KEYS=true` production gate.
- The API now has administrator-gated LP bot credential issue/revoke endpoints.
  Credentials are wallet-bound, institution-labelled, scope-limited, hashed in
  durable snapshots, expiry-checked, and used with operation-specific scopes.
  Bot mutation and wallet-scoped read requests require timestamp/body-digest
  HMAC headers; optional HTTPS/mTLS transport binds the certificate CN/SAN to
  the institution. Role-scoped relay reads are bounded by an
  opaque cursor and page-size limit, and authenticated WebSocket reads use a
  negotiated subprotocol when auth is required.
- The API applies per-actor mutation and WebSocket connection limits, enforces a
  configurable request-body bound, and preserves actionable HTTP statuses for
  authentication, authorization, throttling, and oversized requests. The
  indexer detects changed unfinalized block hashes and rolls back/replays
  projections while failing closed on finalized reorgs.
- The bot transport boundary supports optional mTLS institution binding; explicit
  bot bearer tokens cannot bypass HMAC verification even in local demo mode.
  `npm run test:e2e:flare:api-auth` passes against a real auth-required API for
  unsigned rejection, signed mutation/read access, and immediate revocation.
- The relay WebSocket transport supports signed bot subprotocols with replay
  windows and keeps human SIWE sessions on the existing session subprotocol.
- The FCC matcher and `ConfidentialRFQInstructionSender` share the complete
  operation allowlist, including typed liquidation create/finalize commands;
  unknown operations fail closed.
- No API, relay, keeper, or SDK code receives user private keys or signs on the
  user's behalf.

## Verification Evidence

Fresh verification completed in this worktree on 2026-08-13 (T1.2/T1.3 residual
+ T5 live-index close):

- `npm test`: 39 files / 275 tests passed, including relay WebSocket, durable
  LP-key, bot-credential, replay-signature, browser API-client coverage,
  `projectEventsToReadModel` opportunity mapping, and `indexedOpportunityRows`.
- `FLARE_HEADED=true npm run test:e2e:flare`: headed Chromium interaction passed
  for injected-wallet Coston2 connection and wrong-network
  browser flows, live quote API, blind relay lifecycle,
  auction/standing-bid/facility/liquidation/dashboard workflows, receipt
  lifecycle, and RPC-backed indexed confirmation passed in headed Chromium.
- The headed wallet flow also asserts that the submitted unsigned transaction
  targets the current Coston2 transparent-proxy Router rather than a stale
  demo address.
- The indexer now validates ingested events against a canonical public event
  catalog; unknown ABI fields, unknown event kinds, and private coordination
  fields fail closed before projection.
- `npm run typecheck:flare-api`: passed for the local API/read-model process.
- `npm run typecheck:flare`: passed.
- `npm run build`: passed.
- `npm run build:flare-web`: passed.
- Real headed Chrome inspection via the Playwright CLI passed at 375px, 768px,
  and 1280px widths with no horizontal overflow; anonymous Auctions reads show
  an empty privacy-safe model rather than legacy plaintext rows. The real API
  pagination contract returned two bounded pages and rejected `limit=101`.
- The headed browser flow also passed keyboard-focus traversal with reduced
  motion enabled after waiting for the first interactive control before
  traversal; extension-specific signing remains blocked on an approved
  extension build.
- Real headed Chrome against the running API accepted canonical `1.0` and
  `995.0` inputs and rendered the expected 1,000 gross / 5 fee / 995 net quote.
- The browser audit also verified verified-chain asset address display/copy,
  accessible table sorting, and gas-reserved balance shortcuts: 25% of the
  4.99-RWA spendable balance fills `1.2475`, while Max fills `4.99` exactly.
- The added asset metadata initially failed axe contrast and the isolated
  browser clipboard assertion; both regressions were fixed and the fresh
  headed E2E now passes with the clipboard-denied fallback state covered.
- A real HTTPS+mTLS API probe rejected a clientless TLS handshake and accepted a
  CA-trusted institution certificate; `/v1/health` reported `tls=true` and
  `mutualTls=true`.
- `npm run test:go`: passed.
- `go test -race ./services/fcc-matcher && go vet ./services/fcc-matcher`: passed,
  including strict commitment-only `/v1/action` ingress and typed liquidation
  operation routing.
- `cd contracts/flare && forge test --offline`: 15 suites / **97** tests passed
  (`via_ir=true`; inherited proxy vars disabled on this macOS runner). Fresh
  re-verify 2026-08-13 after T1.2/T1.3 residual (`SettlementRouterInvariant.t.sol`)
  and T5 live-index mapping. Includes remainingFillable conservation, protocolFeeOn
  vs charged swap fee, confidential execute remaining consumption, high-s,
  reentrant ERC-20 (`TOKEN_TRANSFER_FAILED`), reverting ERC-1271, and wrong
  executor (`EXECUTE_AUTH`).
- The isolated Docker Compose integration stack passed Mongo, Redis, Anvil, API,
  indexer, keeper, and matcher readiness checks. Restarting the indexer restored
  its checkpoint cleanly. A 5-second API soak served 203,510 requests with zero
  failures; the 5,000 read-model plus 5,000 quote load passed with zero failures
  (p95 3.52 ms and 4.85 ms). Independent keeper lease owners were also tested
  against the same due job and exactly one entered the action.
- Indexer freshness now reports `fresh`, `stale`, or `unknown`; `/readyz` fails
  closed until a recent successful poll exists, and metrics expose the freshness
  gauge. The updated behavior passed the container readiness check.
- `cargo test --manifest-path contracts/otc_swap/Cargo.toml`: 6 tests passed.
- `forge test --root contracts/flare --offline --match-path
  test/EligibilityRegistry.t.sol`: 5 tests passed, covering owner-only policy
  changes, role/issuer/time-window checks, and revocation-epoch invalidation.
- `node tools/deploy-flare-coston2.mjs`: Coston2 core deployment and owner
  wiring succeeded; public addresses and transaction hashes are recorded in
  `contracts/flare/deployments/coston2.json`.
- `npm run smoke:flare:coston2`: read-only Coston2 RPC smoke passed for bytecode,
  ownership, Router policy, Settlement composition wiring, policy delay, and
  manifest-recorded bytecode hashes.
- `FLARE_FACILITY_C2_DEPLOY=true npm run setup:flare:coston2:facility`: the
  direct, non-production Coston2 manifest records a deployed
  `LiquidityFacility` (`0xd4a4AD10f85a017EfB1ff3b2739cA2313fb248e2`) and a
  successful typed facility-backed swap
  (`0x15a72b60d671f8104d946ed1c5c323fb11a21280013af9eea8d890d7c3fddeec`)
  with 1 RWA input, 1 gross USDX output, and a 0.995 USDX minimum-net check.
  This is mock/testnet evidence only; it is not verified venue evidence.
- `npm run check:flare:secrets`: source/deployment secret scan passed.
- `npm run --silent sbom:flare`: deterministic CycloneDX SBOM generated from
  `package-lock.json` (component count is derived from the current lockfile).
- `npm run check:flare:upgrade-layout`: seven transparent-proxy candidate
  implementation artifacts match the recorded bytecode and storage-layout
  fingerprints. Guardian fields are append-only; the deployed candidate is
  guardian-enabled but is not a production release candidate.
- Acquired inventory now records per-lot acquisition cost and verified NAV;
  carrying value is `min(cost, verified NAV)`, so impairment is immediate and
  uncollected NAV upside cannot inflate facility assets. Focused TypeScript and
  Foundry tests pass, with the new Solidity fields appended after the original
  proxy storage layout. Selected-lot redemption consumes the exact inventory
  quantity and the canonical public-event ABI includes both lot lifecycle
  events.
- `FLARE_VENUE_CONFORMANCE_MANIFEST=fixtures/flare/venue-conformance-interface-mock.json
  npm run check:flare:venue-conformance`: local Kinetic interface harness passes
  all eight required cases; this is explicitly not fork or deployment evidence.
- `npm run build:flare:fcc` with fixed `SOURCE_DATE_EPOCH=1786555858` produced
  matcher SHA-256 `0xa222a2f1c0f1b3da16cd7b2e86435faf1fd23977ca4a2f7344ec5cda172bcff5`;
  the manifest also records a deterministic source-tree hash; real FCC
  attestation and mode remain gated.
- `npm run test:e2e:flare`: axe checks pass across Swap, Auctions, Standing Bids,
  Facility, Liquidations, and Dashboard routes.
- `npm run smoke:flare:live-data`: live Coston2 Contract Registry/FTSO feed and
  FDC finalization-registry reads passed; the public testnet verifier/DA proof
  and owner-controlled Coston2 NAV submission also passed, while production
  credentials/policies remain gated.
- `npm run smoke:flare:fdc-verifier` passed against Flare's documented public
  Coston2 verifier with the published development API key; this proves request
  preparation and verifier reachability only, not a paid/production credential
  or a controlled NAV proof submission.
- `npm run smoke:flare:fcc-registry` passed against the live Coston2 FCC manager
  and normal proxy. The manager has code and `nextPublicExtensionId=66186`, but
  the proxy candidate's FCC registry/machine registry are still zero addresses,
  while the shared normal proxy reports extension `0`; a dedicated TrustRFQ FCC
  extension and independently registered TEE machines are still required.
- `npm run execute:flare:fdc-nav:coston2` with the owner-controlled historical
  Coston2 test registry: request `0x9995bb…e012b`, voting round `1423526`, and
  NAV proof transaction `0x415237…b6bb4c` succeeded. The recorded mock RWA NAV
  is `(value=1, decimals=0, asOf=1786547000, validUntil=1786550600)`.
- `npm run load:flare` passed 5,000 read-model and 5,000 quote requests with
  zero failures; `FLARE_SOAK_MS=5000 npm run soak:flare` passed 200,520 requests.
  The planned 24-hour managed-environment soak remains an external release gate.
- Redis-backed indexer checkpoint hydration/restart and keeper lease tests,
  plus Redis/Mongo compose wiring, passed locally.
- `docker compose -f infra/docker-compose.yml up -d --build` passed with
  alternate host ports: API, indexer, keepers, FCC matcher, Mongo, Redis, and
  Anvil all became healthy; a synthetic opaque auction survived an API restart
  via Mongo hydration. Compose now gates dependents on Mongo/Redis/Anvil health
  and permits all host ports to be overridden for isolated validation.
  binds Anvil explicitly to the container interface.
- `npm run check:flare:web-performance`, `npm run check:flare:secrets`, and
  `npm run check:flare:upgrade-layout` passed; the proxy candidate manifest now
  records the proposed `InstructionSender` bytecode and storage-layout hashes
  for the typed liquidation allowlist change.
- `npm run check:flare:release-gates` remains intentionally blocked by missing
  dedicated FCC attestation/configuration, production FDC service values,
  verified venue manifest, production multisig/guardian governance handoff, and
  an independent security review record. The public verifier probe and normal
  FCC proxy are deliberately not promoted into those release inputs.
- `npm run check:flare:production-config` now fails closed unless the managed
  profile supplies API auth, HTTPS+mTLS, MongoDB, TLS Redis, and all five
  keeper job-source pairs. `FLARE_RELEASE_PROFILE=production` includes that
  profile in the main release gate; local compose remains explicitly non-prod.
- `docker buildx build` passed for the Mongo-backed API and FCC matcher images;
  a compose runtime mutation survived API container restart from Mongo.
- `npm run dry-run:flare:coston2:swap`: typed Router `eth_call` passed without
  changing state; `npm run execute:flare:coston2:mock-swap` then passed one
  1-RWA mock settlement with exact balance-delta assertions (tx
  `0xdb3527…c02e4`).
- `npm run refill:flare:coston2:mocks` restored test-only source liquidity, and
  the smoke plus dry-run passed again with `stateChanged=false`.

No mainnet or real-funds claim is made by these local checks.

## Check Implementation — 2026-08-13 (re-run after P0/P1)

Phase 7 compared the worktree to the approved design and requirements.

**Design summary:** hybrid confidential match (off-chain FCC) + on-chain custody.
EIP-712 `Order` binds maker/taker/executor/context/tokens/amounts/expiry/nonce/
pair salt/type/fill/fee; typed Router swap and liquidation; one aggregate fee;
shared EligibilityRegistry; facility lots at lower-of cost/NAV; fail-closed
FCC. Stellar path stays untouched.

**Fresh local evidence this re-run:** `npm test` 39/275; `cd contracts/flare &&
forge test --offline` 15/97; `go test -count=1 ./...` under `services/fcc-matcher`
passed; Soroban 6/6; `npm run smoke:flare:coston2` PASS twice. Docs lint is not
re-run as a production claim. Task tracing unavailable (`ai-devkit` has no `task`
command).

- **Aligned (local):** monorepo shape; EIP-712 Order with `executor` +
  `contextCommitment` (TS/Go/Solidity typehash; golden digest
  `0x14abeb3f994d71d79fe5f99fc15ee7b781c885e399427124da9a3da2cfe16572`);
  confidential `orderType==0` requires taker/executor/context and bound
  executor; chain bound via EIP-712 domain `chainId`; public standing
  (`orderType==1`, `executor==0`) via `fillWithEligibility` only; direct `fill`
  reverts `ELIGIBILITY_REQUIRED`; `execute` enforces executor +
  `feeBps >= router.protocolFeeBps`; aggregate `delegatedConsumed`; settlement
  `nonReentrant`; facility `NavProofRegistry.latest` when configured; FCC
  production config fail-closed; typed Router swap/liquidation; EligibilityRegistry
  on typed paths; lower-of-NAV lots; blind relay/SIWE/matcher (simulated FCC);
  indexer/keeper compose seams; frontend role shell; Coston2 mock swap and
  facility-backed mock swap; live FTSO/FDC smoke boundaries.
- **Closed vs prior Check Implementation:** the previous high-severity gap
  (confidential Order context binding) is now implemented locally. The named
  residual (fuzz/invariant/malicious-wallet matrix + T5 live-index mapping)
  is now local: `remainingFillable` / `protocolFeeOn` plus projector→API→UI
  opportunities. Production FCC, verified venues, and SC closure remain blocked.
- **Medium deviations:** facility method names (`execute` /
  `bookRedemptionFromLot` vs design `fill` / `bookRedemption`); no facility
  `fundLiquidation`; legacy `executeRoute` remains owner-gated; pure
  Morpho/Kinetic adapters are not verified deployment adapters. Design “chain”
  binding is domain `chainId`, not an extra Order field.
- **Blocked external:** real FCC attestation, venue forks, production FDC
  credentials, multisig/guardian handoff, independent review, mainnet pilot.
- **Not claimed:** SC-1–SC-16 production closure, production readiness.
- Planning residuals that still listed confidential Order as remaining local
  work were reconciled in the same-day planning update.

## Residual close — 2026-08-13 (T1.2/T1.3 + T5)

Shipped local views and mapping (not production FCC/venues):

- `RFQSettlement.remainingFillable(Order)`: 0 when cancelled, pair-salt cancelled, or fully filled; otherwise `sellAmount - filled`.
- `RFQRouter.protocolFeeOn(uint256)`: `(amount * protocolFeeBps) / 10_000`.
- `services/indexer/src/readModel.ts` `projectEventsToReadModel` maps finalized `OrderFilled`, `SwapRouteExecuted`, `LiquidationRouteExecuted`, `InventoryLotBooked`, `Deposit`, and withdrawal events into activity/opportunities/facility. It does not invent Morpho/Kinetic/Clearpool venues.
- `apps/flare-api` `/v1/read-model` merges `projectEventsToReadModel` from `FLARE_INDEXER_STORE` (fail-closed on a bad snapshot). Empty wallet still returns `opportunities: []`.
- `apps/flare-web` Liquidations panel shows `N indexed` vs `No live opportunity` and a DataTable of indexed rows. It still will not construct a tx from unverified venue addresses.

**Blocked / not claimed:** T2.4 real FCC, T4 fork SC-16 verified venues, T4 production FDC, T6.4–T6.7 managed ops/RC/review/mainnet. Optional FAssets mint/redeem **prep** is local only. **T5.8 is done (local)** as of the 2026-08-13 headed evidence pass (dAppwright re-run skipped).

**Phase 6 stop (2026-08-13):** operator halted the implementer `/goal` loop. That stop is **not** feature-complete. Do not reopen T1.2/T1.3 residual or T5 live-index without a new shipped-function defect. Do not start another suites-twice goal. Browser QA is **dAppwright + playwright-cli**. Playwright MCP stays deleted.

## Local adapter / curator / FAssets close — 2026-08-13

Shipped local (not production SC / not verified venues):

- `contracts/flare/src/adapters/` — `BaseYieldAdapter`, Morpho/Kinetic/Clearpool yield, Morpho/Kinetic liquidation + mocks.
- Foundry: `VenueAdapters.t.sol` (6), `TypedLiquidationRoute` uses shipped Morpho + Kinetic adapters (suite total **105**).
- `apps/flare-web` curator panel: `curatorAdapterSummary(DEFAULT_CURATOR_ADAPTERS)` — all adapters disabled until governance.
- `packages/flare-core/src/fassets.ts` `prepareRedeem` — awaiting human confirmation; never signs.
- Evidence: `npm test` **277/277**; `forge test --offline` **105**; Go matcher; Soroban **6/6**; Coston2 admin smoke PASS ×2; `check:flare:web-performance` PASS (`jsBytes=258084`).

**External 2-fail (untackleable without inputs):** venue manifests missing; FCC `DEDICATED_EXTENSION_REQUIRED`; FDC `FLARE_FDC_API_KEY` blocked; production Lighthouse/screen-reader/visual not available.

## Remaining-task inventory — 2026-08-13 (retracted empty)

A later Check Implementation **retracted** the “remaining-local is empty / implementation closed” write. File inventory of T0–T7:

- **Production M0–M5:** still `[ ]` (**0/6**). Local-complete M0–M5: **1/6 (M0 only)**. M1–M5 are **partial**.
- **Remaining-local unfinished in code:** none after adapter/curator/FAssets local close + prior T5.8 evidence. Persist dirs exist locally and are gitignored (`.playwright/metamask-local/`, `cli.config.json`). Testing-doc T5.8 evidence boxes are checked except `qa:wallet:cleanup` (not run).
- T1.2/T1.3 residual and T5 live-index stay **done (local)** unless a new shipped-function defect appears. Production SC and T6.5–T6.7 checkboxes stay open.

**Suite evidence (2026-08-13 adapter pass):** `npm test` 277/277 across 39 files; `forge test --offline` 105/105; Go matcher; Soroban 6/6; admin-owned Coston2 smoke PASS against `contracts/flare/deployments/coston2.json` (`chainId=114`, router `0x593095709e16275cc0b8aa0ef908fd13d693c36c`, settlement `0x6dc51b3ef4eea9d7b0609381491e00abf3720674`, eligibilityRegistry `0x040b49f3408267fbf95f048e6bb7a5b09e830fac`). Default smoke still prefers `coston2-proxy-candidate.json` when present; that file is not this MVP claim.

**External / not remaining-local:** T2.4 real FCC; T4 fork SC-16; T4.1–T4.2 paid FDC; T5.7 screen-reader/Lighthouse/visual; T6.4–T6.7; T7.3 FXRP LP UX.

**Not claimed:** SC-1–SC-16, production FCC, verified venues, multisig/guardian, or production readiness.

## Check Implementation — 2026-08-13 (honest re-score)

Phase 7 compared the worktree to design/requirements/planning. This pass is **file + source inventory**, not a suite re-run.

**Design:** attested 3-machine FCC match + on-chain custody; verified Morpho/Kinetic/Clearpool adapters; production role UI (`SC-10`); SC-1–SC-16 closed only with live evidence.

| Area | In the tree | Not in the tree |
|---|---|---|
| M0 workspace | `apps/flare-*`, `packages/flare-*`, `contracts/flare`, `services/{fcc-matcher,indexer,keepers}`, `infra/`, CI | production release credentials |
| M1 settlement | `RFQSettlement.sol` (`remainingFillable`), `RFQRouter.sol` (`protocolFeeOn`, `executeLiquidationRoute`), `EligibilityRegistry.sol`, 97 Foundry `test` fns | SC-1 production user flow / extension signing |
| M2 FCC | blind relay, Go matcher (simulated / fail-closed `real`), `ConfidentialRFQInstructionSender.sol` | `gcp-confidential/`, 3 Confidential Space machines, attested 2-of-3 |
| M3 facilities | `LiquidityFacility.sol` (15 tests), `FacilityAggregator.sol` | full ERC-4626/7540 + live adapters |
| M4 venues / data | `ProofGuards.sol`, FDC/FTSO seams; Solidity adapters under `contracts/flare/src/adapters/`; TS in-memory facility adapters | no verified mainnet venue addresses; no fork SC-16 |
| M5 app | 7 `NAVIGATION` routes; curator summary from model (`0 enabled`); demo quote exactly 1 RWA → 1000 USDX | SC-10 production screens |
| T5.8 | `setup-metamask.mjs` (dAppwright `bootstrap` + persist), `qa:wallet:*`, `@tenkeylabs/dappwright@2.13.12`; headed `qa:cli` connect + isolation + scan | `qa:wallet:cleanup` not run; not production-custody / SC-10 |
| M7 | `FAssetsRail` mint + redeem prep (disabled-by-default) | FXRP LP UX / live Core Vault orchestration |

**Deviations:** high — simulated FCC vs attested TEEs; interface-faithful mock adapters vs verified venues. Medium — role-shell UI vs SC-10. Low — admin-owned Coston2, not production governance. T5.8 headed evidence is in-tree (gitignored artifacts).

**Next:** no remaining-local code task. External: T2.4 / T4 fork SC-16 / paid FDC / T6.5–T6.7 / T7.3. Optional operator: `qa:wallet:cleanup` when the persist profile is no longer needed. Do not start a suites-twice goal.

## T5.8 evidence — 2026-08-13 (existing harness)

Executed on the existing `qa:wallet:*` + `qa:cli` path. No second harness. No Playwright MCP.

| Step | Result |
|---|---|
| `npm run qa:wallet:validate` | exit 0, `MetaMask QA configuration is valid.` |
| Vite bind | `npm run dev:flare -- --host 127.0.0.1 --port 5173` (Vite 8 default is `[::1]` only; IPv4 `DAPP_URL` otherwise `ERR_CONNECTION_REFUSED`) |
| `npm run qa:wallet:setup` | exit 0; persist `.playwright/metamask-local/`, `.playwright/metamask-extension/`, `.playwright/cli.config.json` (Chromium 1234, headed, load extension) |
| Unlock | MetaMask `#/unlock`; snapshot refs Password `e13` / Unlock `e14`; after wait, home `#/` Account 1 / Flare Coston2 / C2FLR |
| Connect | dApp `Connect wallet` → `notification.html#/connect` → Connect; header `0xcC1B…088A`; `window.ethereum` `chainId=0x72` `selected=0xcc1bc072595a4964e000247eb311e72e5d20088a` |
| Isolation | `-s=isolated --profile=.playwright/metamask-isolated`: MetaMask `#/onboarding/welcome` (`Create a new wallet` / `I have an existing wallet`); dApp still `Connect wallet`; `chainId=0x1` `selected=null` `accounts=[]`; default session unchanged |
| Scan | `secret_hits=0` in `output/playwright` + source trees; `tracked_secret_hits=0`; `forbidden_tracked=0`. One fill snapshot redacted in-place. Report: `output/playwright/t58-scan-report.txt` |
| Cleanup | **not run** (profile retained) |

Screenshots: `output/playwright/t58-metamask-unlocked.png`, `t58-dapp-connected.png`, `t58-isolated-dapp.png`, `t58-isolated-metamask.png`.

## Check Implementation — 2026-08-13 (independent Phase 7)

Phase 7 compared shipped code in
`.worktrees/feature-flare-confidential-rfq-dex` (branch
`feature-flare-confidential-rfq-dex` @ `2fac5aa` plus uncommitted Flare tree)
to the lint-validated design and requirements. Feature name is
`feature-flare-confidential-rfq-dex` (not the abbreviated
`feature-flare-confidential-rfq`). Prior same-day Check Implementation
sections remain historical; this pass independently re-read contracts, API,
FCC matcher, facility, adapters, and the web shell.

`npx ai-devkit@latest lint --feature feature-flare-confidential-rfq-dex`
passed. Task tracing is unavailable (`npx ai-devkit@latest task list` →
`error: unknown command 'task'`).

**Design recap:** hybrid confidential match (off-chain FCC) + on-chain
noncustodial settlement. EIP-712 `TrustRFQ`/`1` `Order` binds maker, taker,
executor, tokens, amounts, expiry, nonce, pair salt, context, type, fill
mode, and fee. Confidential `orderType==0` binds taker/executor/context.
Public standing is reusable and must be blendable with facility legs.
Typed Router swap/liquidation charge one aggregate fee ≤ 50 bps after
EligibilityRegistry + FCC quorum. Facilities are isolated share vaults
whose NAV includes adapter balances; fill deallocates what is needed;
redemption settles on verified FDC proof; facilities can
`fundLiquidation`. Production FCC is attested 2-of-3. Frontend is the
full role product (SC-10). Stellar path stays untouched.

### Fresh evidence this pass

| Command | Result |
|---|---|
| `npm test` | **277** passed / 39 files, exit 0 |
| `cd contracts/flare && forge test --offline` | **105** passed / 16 suites, exit 0 |
| `go test -count=1 ./...` under `services/fcc-matcher` | ok (matcher + `cmd/server`) |
| `cargo test --manifest-path contracts/otc_swap/Cargo.toml` | **6** passed, exit 0 |

Coston2 smoke, headed E2E, and `qa:wallet:cleanup` were **not** re-run.
This is not a suites-twice implementer loop.

### Aligned (local)

- Monorepo shape: `apps/flare-{web,api}`, `packages/flare-{core,sdk,contracts}`,
  `contracts/flare`, `services/{fcc-matcher,indexer,keepers}`, compose-only
  `infra/`.
- EIP-712 Order typehash includes `executor` + `contextCommitment`. Cross-
  language golden digest
  `0x14abeb3f994d71d79fe5f99fc15ee7b781c885e399427124da9a3da2cfe16572`
  is pinned in `src/flare-core.canonical.test.ts` and
  `services/fcc-matcher/matcher_test.go`. Solidity pins encoding in
  `testOrderDigestUsesCanonicalEip712Encoding`.
- Confidential `orderType==0` requires taker, executor, and nonzero context
  (`RFQSettlement._assertConfidentialBinding`). Direct `fill` always reverts
  `ELIGIBILITY_REQUIRED`. `fillWithEligibility` requires `executor==0`.
- Settlement `_transferFillLegs` moves both legs with exact balance-delta
  checks and does **not** assess a protocol fee. Maker-signed `feeBps` is a
  cap vs `router.protocolFeeBps()` (`MAX_FEE_BPS = 50`).
- `remainingFillable` and `protocolFeeOn` exist and are covered by
  `SettlementRouterInvariant.t.sol`.
- Typed `executeSwapRoute` / `executeLiquidationRoute`: seller/winner
  binding, allowlisted sources/adapters, one fee ≤ 50 bps on net output,
  EligibilityRegistry, FCC quorum hash check, `nonReentrant`, no user
  `delegatecall`. Legacy `executeRoute` is **disabled by default**.
- Inventory lots carry at `min(acquisitionCost, verifiedNav)` in Solidity
  and `packages/flare-core/src/facility.ts`.
- Auction durations are only `24h` / `1w` / `1m` / `3m`.
- FAssets `prepareMint` / `prepareRedeem` are disabled-by-default and never
  sign.
- Production runtime rejects non-`real` FCC (`runtime.ts`). InstructionSender
  `configureFcc` is one-shot 2-of-3 and blocks simulated submit/dispatch
  after configure.
- Indexer rejects confidential fields before projection. Keepers advertise
  `custody: false` and do not select winners.
- Web `NAVIGATION` has seven routes. Curator adapters are disabled until
  governance. Stellar vitest + Soroban suites still pass.

### High deviations

1. **Open-taker standing cannot be a router/facility blend leg (FR-1 / FR-2).**
   Design: reusable public standing (`taker==0`, `executor==0`) competes
   with facilities in one atomic route. `RFQSettlement.execute` requires
   `routeFill.order.taker == seller` with no open-taker exception. `_validateOrderBasics`
   *does* allow `taker==0`. Standing therefore only works via P2P
   `fillWithEligibility`. Prior docs that called this “public standing via
   `fillWithEligibility` only” described the bug, not the approved design.
2. **Matcher result hash ≠ on-chain route hash (FCC trust seam).**
   Go/TS matcher hashes a JSON
   `{"auction","winner","output","sequence"}` string. Router quorum requires
   `selectedHash == keccak256(abi.encode(SwapRoutePlan|LiquidationRoutePlan))`.
   Typed-route tests inject `router.hashSwapRoute(route)` into a mock
   verifier. A real InstructionSender quorum of matcher hashes reverts
   `FCC_RESULT_MISMATCH`.
3. **Blind relay cannot reconstruct the book (FR-3).**
   `BlindRelay.submitBid` validates the envelope, increments `bidCount`,
   and drops the bid ciphertext. `finalizeAuction` only flips status; the
   API never calls the matcher. Parallel plaintext `POST /v1/auctions` and
   `POST /v1/standing-bids` store pair / minOutput / capacity.
   Browser “encrypt” in simulated mode uses `new Uint8Array(32).fill(7)`;
   `real` mode throws `FCC_BROWSER_ENCRYPTION_UNAVAILABLE`. Matcher
   `/v1/match` accepts plaintext auction + bids. `eligibleLps` is
   client-supplied. Auth is off unless `FLARE_API_AUTH_REQUIRED=true`.
4. **Facility fill/NAV/funding/redemption vs FR-5 / FR-7 / FR-13 / SC-7.**
   - `execute` spends only `idleAssets`; `quote` requires
     `output <= idleAssets`. Allocated adapter liquidity is invisible
     until a curator `deallocate`.
   - `totalAssets = idle + deployed + inventoryNav + receivables`.
     `deployedAssets` is allocated **principal**, not
     `IFacilityAdapter.totalAssets()`. Yield is recognized only on
     deallocate.
   - Solidity `IFacilityAdapter` omits design `totalAssets` / `maxWithdraw`
     (adapters implement them; the facility never calls them).
   - No `fundLiquidation`. Router funding tests use
     `MockLiquidationFundingSource`.
   - `settleRedemption(requestId, receivedAssets)` is `onlyOwner` amounts,
     not `FdcProof`. `bookRedemptionFromLot` lets the owner set
     `expectedAssets` (can inflate receivables/NAV).
5. **Venue adapters are custom mocks, not Morpho/Kinetic ABIs (SC-9 / SC-16).**
   Liquidation adapters wrap
   `IMockLendingMarket.liquidate(bytes32,uint256,address)`, not Morpho Blue
   `liquidate(MarketParams, borrower, …)` or a Kinetic comptroller. Morpho
   and Kinetic liquidation adapters share that invented market. Docs that
   say “interface-faithful” overstate ABI fidelity. No verified Flare
   venue manifests or fork tests. Simulated FCC is not attested 3-machine
   TEE.

### Medium deviations

- Facility method names: `execute` / `bookRedemptionFromLot` vs design
  `fill` / `bookRedemption`. Quote `decisionBlock` is `uint256`, not
  `uint64`.
- Design NestJS API vs custom `node:http`/`https` in
  `apps/flare-api/src/server.ts`. Missing designed `/v1/rfqs*`,
  facilities, dashboard, liquidation transaction endpoints. Errors are
  `{ error }` not `{code,message,retryable,requestId}`. Envelope is
  AES-GCM, not HPKE/ECIES.
- `apps/flare-api/README.md` claimed RFQ/bid plaintext never crosses the
  API and that `POST /v1/action` exists. Code has plaintext workflow
  routes and **no** `/v1/action` handler (matcher only). README corrected
  in this pass.
- Frontend is a role-shell: seven routes, but Auction Detail is missing
  and `/liquidations` was added instead. No wagmi / TanStack Query
  (viem only). `fcc-matching` is a label, not a derived state. Not SC-10.
- `FacilityAggregator` is registry + isolated quotes; it does not route
  fills. Single `owner` does curator + policy; no FacilityPolicy ranges /
  SLA / liquidation concentration caps.
- TS withdrawal snapshots assets at request; Solidity recomputes
  `(shares * totalAssets()) / totalShares` at settle.
- Facility eligibility is optional (`if (eligibilityRegistry != address(0))`).
  Settlement `execute` does not call the registry and does not bind
  `contextCommitment` to `route.commitment`.
- Owner can flip `legacyRouteEnabled` immediately; the enabled path has
  no fee, eligibility, FCC, or seller/recipient binding.
- `decisionBlockHashRequired` defaults false. Fee/source/FCC-verifier
  config is immediate owner, not forced through the timelock.
- New EligibilityRegistry `policyId` is instant; only in-place
  replacement is delayed two days.
- `FtsoRiskGuard.assertUsable` takes caller-supplied numbers; it does
  not read FTSO via the Flare registry. No on-chain
  `RedemptionProofRegistry`.
- Router outgoing `_safeTransfer` is not a recipient balance-delta check
  (fee-on-transfer buy/collateral can underpay the min).
- ERC-4626/7540: preview/max views and a FIFO queue exist; shares are
  not a transferable ERC-20; no `mint`; no 7540 controller/operator.
- `infra/` is compose + README only. Designed `cloudflare/`, `azure/`,
  `gcp-confidential/` are absent.
- InstructionSender production `dispatch` forwards any message whose
  keccak matches `payloadCommitment` (ciphertext can be posted on-chain).
  No on-chain Confidential Space attestation / code-hash check.

### Low deviations

- `ProtocolFeeCollected` is declared on settlement and never emitted.
- Typehash field order differs from design prose; off-chain vectors
  match the Solidity typehash.
- Settlement `feeRecipient` is also admin. Router `feeRecipient` is not
  rotatable after `initialize`.
- Coston2 admin MVP (`contracts/flare/deployments/coston2.json`, chainId
  114, router `0x593095709e16275cc0b8aa0ef908fd13d693c36c`) is
  deployer-owned, not proxy-candidate / multisig.
- T5.8 `qa:wallet:cleanup` not run. Entire Flare tree is uncommitted
  (~107 dirty paths at the same commit as `main`).
- Optional ERC-2612 permit not implemented.

### Remaining-local vs external

This pass **retracts** “remaining-local unfinished in code: none.”

**Remaining-local (design-alignment gaps in shipped code, not production SC):**

| ID | Gap |
|---|---|
| T1 standing-route | Open-taker standing through `execute` / `executeSwapRoute` |
| T2 hash seam | Shared canonical result hash across matcher and Router |
| T2/T3 relay book | Persist bid envelopes; finalize → matcher; stop or encrypt plaintext workflow APIs |
| T3 facility depth | Deallocate-on-fill; live adapter NAV; `fundLiquidation`; FDC `settleRedemption` |

**Accepted local seams** (do not treat as closed SC; amend design if this *is* the local slice): custom HTTP API, AES-GCM envelopes, role-shell UI, simulated FCC, invented venue mock ABI, compose-only infra.

**External / blocked:** T2.4 real FCC + dedicated extension; T4 fork SC-16 + verified venue manifests; T4.1–T4.2 paid FDC; T5.7 screen-reader / production Lighthouse / visual; T6.4–T6.7 ops / RC / review / mainnet; T7.3 FXRP LP UX.

### Not claimed

SC-1–SC-16 production closure, production FCC, verified Morpho/Kinetic/Clearpool, multisig/guardian handoff, or production readiness. Production M0–M5 = **0/6**. Local-complete = **1/6 (M0)**. M1–M5 stay **partial**.

### Next

`/dev-testing` then `/dev-review` as a readiness snapshot — **not** another
suites-twice implementer loop. If the operator wants the remaining-local
rows closed, return to Execute Plan (or amend design if the idle-only
facility + P2P-only standing + simulated AES-GCM relay is formally the
local slice). Do not reopen T1.2/T1.3 residual / T5 live-index unless a
new shipped-function defect appears in those specific files.

## Venue-Fork Continuation — 2026-08-13 (superseding venue status)

Implemented locally:

- `MorphoYieldAdapter` now uses Vault V2 share semantics
  (`balanceOf`/`convertToAssets`/`maxWithdraw`/`deposit`/`withdraw`). No live
  Morpho vault is selected or claimed.
- `KineticYieldAdapter` now uses the Compound-style underlying-market semantics
  exposed by Kinetic: `mint`, `redeemUnderlying`, `balanceOf`,
  `exchangeRateStored`, and `getCash`, with error-code checks and approval
  cleanup.
- `VenueMainnetFork.t.sol` binds the documented Flare Kinetic USDT0 market and
  Clearpool USDX T-Pool at block 65,078,017. It validates code/underlying,
  deposit/valuation/withdrawal, pause/caller/asset rejection, zero-liquidity,
  over-balance, and one-base-unit behavior. It requires both an
  operator-provided HTTPS RPC URL and the exact pinned fork block; without them
  it skips rather than manufacturing proof.
- `KineticLiquidationAdapter` now follows the Compound-style Kinetic route:
  comptroller health/close-factor checks, `liquidateBorrow`, measured seized
  cTokens, `redeem`, and measured underlying delivery with allowance/cToken
  cleanup. Seven fork cases construct an actual Kinetic borrower position,
  accrue it into shortfall, and cover route success plus the principal rejection
  and atomic-rollback edges.
- Kinetic liquidation access follows the approved option-1 split. The
  official Comptroller implementation delegates `liquidateBorrowAllowed` to
  `IAllowList(liquidatorsWhitelistVerifier).allowed(liquidator)`.
  `_kineticLiquidatorAllowList` asserts the Unitroller getter binds Kinetic's
  documented verifier. `testForkKineticLiquidatorAllowlistRejection` keeps a fresh
  adapter unauthorized, submits the actual route, and verifies complete rollback.
  Positive liquidation cases separately read `owner()` and impersonate that
  address solely to invoke the real owner-only `allow(adapter)` method. This is
  labeled simulated deployment-prerequisite setup, not proof of current mainnet
  eligibility. The fixture never uses `vm.store`, `vm.etch`, or substituted code.
- Checked plan fixtures enumerate **18 Kinetic** and **10 Clearpool** cases.
  Morpho retains only the official core/factory code-binding probe because no
  authoritative live Flare Vault V2 instance is selected.
- `run-flare-venue-fork-tests.mjs` runs each fork case in isolation, requires
  exactly `1 passed; 0 failed; 0 skipped`, measures real wall-clock operation
  time, creates evidence exclusively, records only the RPC origin, and supplies
  `--offline` to suppress unrelated selector-service network calls while still
  using the explicit fork URL. It scopes Foundry discovery to
  `VenueMainnetForkTest` and passes the validated test name literally; anchored
  `--match-test` input was removed after Foundry 1.5.1 incorrectly discovered no
  tests with that form.
- `local-rfq-e2e.mjs` measures the actual finalize request rather than a
  configured or synthetic duration. `test:e2e:flare:cli` is a fail-closed
  Playwright CLI script for the principal local business journeys.
- `local-rfq-in-process.mjs` is the listener-free evidence lane for the same
  relay/finalize/matcher seam. It verifies that relay read state exposes only the
  envelope, checks the selected LP and route hash, measures the actual call with
  a monotonic clock, and proves unprovisioned real FCC mode fails closed. It is
  labeled simulated and non-production in its output.

Fresh evidence in this environment:

- `forge test --offline --root contracts/flare`: **123 passed, 0 failed, 29 skipped**. The skipped cases
  are the RPC-gated mainnet fork tests, so this is local evidence only.
- Both Flare TypeScript typecheck commands pass. Fork-runner tests pass **18/18**;
  the focused FCC/browser set passes **26/26**. The Go matcher core package
  passes, but normal and race HTTP suites cannot bind loopback in this runtime;
  `go vet` passes with an isolated cache.
- `npm run test:e2e:flare:in-process` passed with result hash
  `0xde9f8b94c58188d07f04fb945c87d39eaf1d7acf4ff893ea93b74d4385dd6beb`,
  the expected winner, a **1.823 ms** measured matcher duration for pinned
  scenario time `1700000000`, opaque-envelope-only relay read state, and
  `DEDICATED_EXTENSION_REQUIRED` in real mode.
- Full Vitest reaches **319 passed / 5 failed**; every failure is a WebSocket
  transport test stopped before its assertion by `listen EPERM 127.0.0.1`.
- Both Kinetic and Clearpool runners reach the first fork case, but installed
  Forge 1.5.1 panics in `system-configuration`'s macOS `SCDynamicStore` setup
  before receiving an RPC response, including under elevated execution. A
  process-isolated Forge 1.7.1 download was attempted but DNS resolution for
  GitHub is blocked. The fail-closed runner wrote no conformance manifest.
- The Playwright CLI script passes shell/JavaScript parse checks but cannot run
  acceptance here because the API cannot listen on `127.0.0.1` (`EPERM`) and the
  CLI cannot create its daemon cache file (`EPERM`, including elevated execution).

Still open and not claimed: a successful mainnet fork, a live Morpho vault
round trip, executed real-state Clearpool/Kinetic operations, browser acceptance
for this new script, production FCC, SC-9/SC-16 closure, or mainnet readiness.
If the pinned Kinetic state has restricted liquidation enabled, governance-backed
adapter eligibility is also an external deployment prerequisite.

## 2026-08-14 — Coston2 deployment/registration lane (this machine, network-unrestricted)

Environment change vs. the evidence above: this shell has working outbound
network, Docker, and loopback listeners. Stale `listen EPERM` evidence no longer
applies here.

- Baseline suites: `go vet` clean; `go test ./services/fcc-matcher` passes
  (HTTP suites bind loopback normally). Focused FCC vitest set passes 24/24
  (envelope 4, relay 3, scaffold 3, sdk 3, indexer preflight 11).
- **C2-FCC-0 pinned.** Official scaffolds cloned and vendored earlier into
  `third_party/fcc-extension-scaffold`; upstream pins recorded:
  `flare-foundation/fce-extension-scaffold@e3f587949069780084e2ced8a53c9419ed05c250`
  (2026-08-11) and `flare-foundation/fce-weather-api@d759e3de258913c51480c8dae485e510da6c5c64`
  (2026-04-01). The scaffold ships golden conformance fixtures
  (`testdata/conformance/`, 16 cases) and deployment/registration CLI tools.
- Stack running via the official compose (coston2 overlay): `redis`,
  `ext-proxy`, `extension-tee`, plus the shared `cloudflared` quick tunnel at
  `EXT_PROXY_URL=https://packing-drivers-helen-plain.trycloudflare.com`
  (ephemeral — acceptable for simulated-TEE testnet only).
- Pre-build already complete on Coston2: `INSTRUCTION_SENDER=0xbD968c97e6b6400F3153b79bCdFf534C677458Cd`
  (verified `eth_getCode` non-empty), `EXTENSION_ID=0x…0102cb`. Deployer holds
  ~42 C2FLR. Shared normal proxy `https://tee-proxy-coston2-1.flare.rocks/info` live.
- **Blocker (external):** the support-issued Coston2 C-chain indexer
  (34.38.42.208:3306, db `indexer`) stalled at block 34045729
  (ts 2026-08-14T09:50:55Z, last `states.updated` 09:50:57Z). Verified by direct
  SQL (`SELECT index, block_timestamp, updated FROM states WHERE
  name='last_database_block'`); local clock checked against chain head (2 s
  skew) so it is a genuine remote stall, not clock skew. `ext-proxy` refuses to
  bind until `WaitCIndexerToSync` passes (30 retries, ~60 min budget), so
  post-build (allow-tee-version → set-governance → register-tee rRap) cannot run
  yet. Monitor + auto-register armed: `/tmp/fcc-indexer-watch.log` (DB lag every
  60 s) and `/tmp/fcc-autoregister.sh` (restarts ext-proxy on recovery, waits
  for `/info`, runs `scripts/post-build.sh`).
- Diagnosis aids added out-of-tree (not committed): raw-MySQL `states` probe at
  `/tmp/fcc-scaffold-pin/tools/cmd/db-state` reusing the worktree's
  `.env.fcc.local` credentials; no secrets logged.

### Resolution (same day, 18:48–18:50 local): machine PRODUCTION, e2e green

The earlier shared-indexer stall was transient (it recovered; Flare's FCC FAQ
confirms expected hackathon-indexer lag is effectively zero). A local
`flare-cchain-indexer` fallback we stood up meanwhile could not keep up
(11m+ delay, `/ready` 503 on ext-proxy internal port). Re-pointing the proxy's
`[db]` back to the official indexer (34.38.42.208:3306, db `indexer`,
support-issued credentials, gitignored TOML) flipped `/ready` to 200 within 30s.

Key operational findings (all now confirmed on this machine):

- `/ready` on the proxy **internal** port (6673) is the authoritative health
  gate: 503 "c-chain indexer delay" parks instruction processing; 200 unblocks.
- Availability-check instructions dispatched while `/ready`=503 are **not
  retried** by providers; re-run `register-tee -command rRap` after health
  returns.
- `query-tee` must be aimed at the FlareTeeManager diamond
  (`-reg 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`), not its default
  registry address, or every call reverts.

Registration + acceptance evidence (Coston2, SIMULATED_TEE=true):

- `register-tee -command rRap` succeeded: fresh attestation requested,
  availability check proof obtained, machine promoted.
- On-chain state: `getTeeMachineStatus: 2` (PRODUCTION), teeId
  `0x6c825C5F566a0dD478472E83d353d4e99e36dbb2`, teeProxyId
  `0x752724bb896716e674e146f789a9580c272f3689`, extensionId 66251 (0x…0102cb),
  url `https://packing-drivers-helen-plain.trycloudflare.com`, initial signing
  policy 5936.
- `run-test` e2e through the public FTDC providers: SAY_HELLO instruction
  `0x40857b104a5091578318f3eaaf779d43299a8e38905ea9c4bf32621770e160cc` returned
  `{Greeting:"Hello, World! Welcome to Flare Confidential Compute.",
  GreetingNumber:1}`; SAY_GOODBYE `0x5f895ee4186d544244017fecf7830d5c0f931b39a83e6a51a1845c3d7043c92c`
  returned a valid farewell; "All tests passed."

Caveats / follow-ups:

- The quick-tunnel URL is ephemeral; a tunnel restart mints a new URL and
  strands the on-chain registration (per FAQ). Stable fix = named Cloudflare
  tunnel (`TUNNEL_ARGS` token) or any stable public HTTPS host; re-register
  (`rRap`) + pause the stale machine after any URL or identity change.
- Single machine, single extension = the deployment/registration acceptance
  lane. The feature's 3-TEE quorum evidence remains the local three-stack
  rehearsal (C2-FCC-3/5), which is independent of this lane.
- Deployed extension is the pinned official scaffold handler (Hello World
  wire surface). Porting the FCC matcher handler into this scaffold image and
  re-running `run-test` against matcher opTypes is the remaining integration
  step for the feature extension itself (C2-FCC-2 linkage).

## 2026-08-14 — Matcher port + dedicated Coston2 extension (simulated-TEE)

Decision: do **not** reuse `ConfidentialRFQInstructionSender` for the 1-machine
attestation. That contract hard-requires `teeCount==3` and `fccQuorumThreshold==2`
and has no `setExtensionId`. Registry has no sender-update. T-2 therefore
extended the official scaffold `HelloWorldInstructionSender` with
`sendRFQCreate` / `sendBidSubmit` / `sendMatchFinalize` (`TeeInstructionParams`
wire-compat). TrustRFQ sender remains the 3-TEE production path.

On-chain (Coston2, MODE=1, SIMULATED_TEE=true, test codeHash
`0x194844cf417dde867073e5ab7199fa4d21fd82b5dbe2bdea8b3d7fc18d10fdc2`):

- `EXTENSION_ID` 66277 (`0x…0102e5`)
- `INSTRUCTION_SENDER` `0x876398bBb8C040FF83bCcf6ccEB160989AF86F26`
- TEE machine `0xE73bCaaf2e5c0259835ec6cb6e621C3B7Aa04336` registered via `rRap`
- Previous hello-world ext 66251 / sender `0xbD968c…458Cd` retired for this lane

`scripts/test.sh` (2026-08-14): SAY_HELLO, SAY_GOODBYE, RFQ/CREATE
`0x8055f053…7b2683` accepted, BID/SUBMIT `0x80a70001…980981` accepted,
MATCH/FINALIZE `0x91a8a8f6…044750` data = golden route hash
`0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975`.

Deferred: 3-machine 2-of-3, real Confidential Space, playwright-cli e2e,
`submitFccResult` on TrustRFQ sender.

Go commands against the scaffold must use `GOWORK=off` (repo `go.work` only
includes `./services/fcc-matcher`).

## 2026-08-14 — Task 0 Coston2 preflight + Render wake-first stop

Read-only Coston2 preflight (no keys printed, no gas):

- `npx ai-devkit@latest lint --feature flare-confidential-rfq-dex` passed.
- `npm run check:flare:secrets` → `secret-scan=PASS`.
- `npm run check:flare:fcc:indexer` → `fcc-indexer=PASS … mysqlAuthenticated=true`.
- `npm run smoke:flare:fcc-registry` → candidate sender unconfigured;
  shared `tee-proxy-coston2-1.flare.rocks` is extension `0`
  (`DEDICATED_EXTENSION_REQUIRED`).
- TrustRFQ `0x6b97db10…` owner `0xeD37FD0d…`, FCC fields zero.
- TrustRFQ `0xC018A20d…` owner `0x56E3778…` (timelock `minDelay=172800`),
  FCC fields zero.
- `getRandomTeeIds(66277, 1)` → `0xE73bCaaf…`; count 3 reverts `0xd65ac61e`.
- `getRandomTeeIds(66251, 1)` → `0x6c825C…`; count 3 reverts `0xd65ac61e`.
- `fccQuorumVerifier()` reverts on browser router, legacy router, and
  implementation `0x9506b636…`.
- Task tracing `npx ai-devkit@latest task list` → `unknown command 'task'`.

Task 1 prep (no register / no `configureFcc`):

- `render.yaml` — three free web services `trustrfq-tee-a|b|c`.
- `third_party/fcc-extension-scaffold/Dockerfile.render` + `scripts/start-render.sh`
  pack Redis + official proxy + simulated TEE in one container (free-tier
  constraint). Config is generated from env; ignored Coston2 TOML is not copied.
- `tools/wake-fcc-proxies.mjs` / `tools/validate-fcc-render.mjs`
- Tests: `src/flare-wake-fcc.test.ts` (4).

Stopped for operator URLs and the two on-chain gates above.

## 2026-08-14 — Render API created the three TEE services

- Render API docs used: [The Render API](https://render.com/docs/api),
  [Create service](https://api-docs.render.com/reference/create-service),
  [List workspaces](https://api-docs.render.com/reference/list-owners).
- `GET /owners` → workspace `tea-cspsq3ggph6c73f4ln6g`.
- Could not `git push` to `acakbin1881/TrustRFQ` (403 for `MrSufferer`).
  Docker context commit `24d65f8` was pushed to
  `https://github.com/MrSufferer/trustrfq-fcc-tees`
  (`feature-flare-confidential-rfq-dex`).
- `POST /services` created `trustrfq-tee-a|b|c` (201). Initial deploys
  `dep-d9vi3q8j…`, `dep-d9vi3r1t…`, `dep-d9vi3rrl…` reached `status=live`.
- `npm run wake:flare:fcc` → `fcc-wake=PASS count=3` HTTP 200.
- Public URLs:
  `https://trustrfq-tee-a.onrender.com/info`,
  `https://trustrfq-tee-b.onrender.com/info`,
  `https://trustrfq-tee-c.onrender.com/info`.
- Still not done: on-chain register, `configureFcc`, `submitFccResult`.
  API key was not written to git; rotate it because it was pasted in chat.

## 2026-08-14 — 66280 configured; submitFccResult blocked on old sender bytecode

- Three Render TEEs registered PRODUCTION on dedicated extension **66280**.
  `getRandomTeeIds(66280, 3)` returns A/B/C. Official instruction sender for
  66280 is legacy TrustRFQ `0x6b97db10…`.
- `configureFcc` on that sender succeeded:
  `0xff575f130a0a6f3c40ce5e5b066963c546db96c265e3a3e6a8ca34059cb4ea86`
  (block 34055305). On-chain: registries = diamond
  `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`, extension 66280, quorum 2.
  Do **not** re-run `configureFcc` on this address.
- Relay added: `tools/relay-flare-fcc-coston2.mjs` /
  `npm run relay:flare:fcc:coston2`. TDD: `parseFccActionResponse` + dispatch
  `value=1_000_000n` (9 tests).
- Live `dispatchConfidential` eth_call reverted. Selector scan of deployed
  legacy bytecode `0xb3f55116…` (5812 bytes): **no** `dispatchConfidential`,
  **no** `submitFccResult`. Current artifact `0x34064d7e…` (7529 bytes) has
  both. Browser proxy impl `0xC4Ec7445…` also lacks those two selectors.
- Diamond `sendInstructions` from `0x6b97db10…` **does** succeed (3 TEEs,
  1e6 wei) — the FCC side of 66280 is fine. The TrustRFQ sender cannot accept
  or submit results. Registry has no sender-update. Next step is a new sender
  deploy + new extension + re-register the three TEEs. Do not weaken 2-of-3.

## 2026-08-14 — new sender 0x55aA4F40… / extension 66283 / live submitFccResult

- Isolated sender-only deploy (`tools/deploy-flare-fcc-sender-coston2.mjs`,
  `npm run deploy:flare:fcc:sender:coston2`). Did **not** redeploy the rest of
  the flare suite. Address `0x55aA4F400f3819498eD4Cbe120839E609f0897F3`,
  owner `0xeD37FD0d…`, deploy tx `0xeab945e4…` block **34055860**, on-chain
  bytecode hash `0x34064d7e…` (7529 bytes). Selectors present:
  `dispatchConfidential` `0xd65f9da6`, `submitFccResult` `0x149e2a73`.
- Official extension **66283** (`0x…0102eb`) bound to that sender
  (`getTeeExtensionInstructionsSender` match). Do not reuse 66280/66277/66251.
- Render A/B/C `EXTENSION_ID` retargeted to `0x…0102eb` (per-key PUT, not
  replace-all) and redeployed live. New PRODUCTION machines after `rRap`:
  A `0x09131744fD49888526fEd63924E586Ec59430e31`,
  B `0x9A25Bf3A46f21ADa33c14f0fA2dB37AbF131d85C`,
  C `0xE70A3D592dF4dC707bc7b849735f6D2aD8601105`. Status 2.
  `getRandomTeeIds(66283, 3)` returns those three.
- `configureFcc` on the **new** sender only:
  `0xdb8af3782aad5433191dbcc7f88fcea363d31f5de0cbce8e1e91e4c90871f469`
  block **34056056**. Registries = diamond, id 66283, quorum 2. Do not repeat.
  Did not call `configureFcc` on `0x6b97db10…`.
- Live relay (wake-first)
  `FLARE_DEPLOYMENT_MANIFEST=contracts/flare/deployments/coston2-fcc-sender.json FLARE_FCC_EXTENSION_ID=66283 npm run relay:flare:fcc:coston2`
  → `fcc-relay=PASS`. Dispatch `0x23663327…` block 34056066. All three TEE
  results = golden `0x72661810…` (tag `threshold`). Three `submitFccResult`
  txs. On-chain `quorum(actionId).ready=true` selectedHash golden.
- Relay no longer hardcodes extension 66280; it reads
  `FLARE_FCC_EXTENSION_ID` / manifest `configuration.fccExtensionId`.
- Secrets scan `secret-scan=PASS files=191`. FCC unit tests 9/9.
- Isolated router `0xb136b8a1…` now has `fccQuorumVerifier()=0x55aA4F40…`.
  Browser proxy `0x7fA18179…` was not upgraded.

## 2026-08-14 — recycle identity mismatch, rRap, live executeSwapRoute

- Official Coston2 guide: providers POST the cosigned instruction to the
  registered proxy `/instruction`. The proxy does not read the indexer.
  Expected indexer lag is ~0. A 404 on `/action/result/{id}` means that
  identity never received the instruction. Restart mints a new teeId; recover
  with rRap of the live `/info` identity then `pause` the stale one.
- Free-tier recycle left URLs the same but live teeIds became
  A `0xA03CA458…` / B `0x04251c4D…` / C `0xDf3D9C2B…` while
  `getRandomTeeIds` still returned the old PRODUCTION set. `POST /instruction`
  on the live hosts returned HTTP 400 `wrong teeID`.
- Fix: `register-tee -command rRap` on the live identities (no Render restart),
  then `pause` stale `0x09131744…` / `0x9A25Bf3A…` / `0xE70A3D59…`
  (txs `0x98622f54…`, `0xb7af3e3f…`, `0x641c78c7…`). Active set is only the
  live three, status 2. Stale status 4.
- Golden control after rRap: `fcc-relay=PASS` dispatch `0x44a1bec4…`,
  3 `submitFccResult`, quorum golden `0x72661810…`.
- Live settle: `fcc-settle=PASS` dispatch `0xbe72307c…` instruction
  `0xab451a20…` actionId `0xa179a261…` selectedHash `0xfa3c292e…` =
  `hashSwapRoute` of the executed plan (not the dummy golden). Swap
  `0xf8542ac8…` block **34058401**. Earlier live swap `0xcacedaaa…` block
  **34058293** already emitted gross 1000e18 / net 995e18; the script first
  asserted recipient USDX == net while `feeRecipient` is the same deployer.
  Helper `expectedRecipientBuyTokenDelta` + tests cover that.
- Do not `configureFcc` again. Do not weaken 2-of-3. Rotate both pasted
  Render API keys. Do not restart Render unless `/info` teeId changes again.

## 2026-08-14 — e2e wallet lane (playwright-cli + real MetaMask) and sim-lane envelope fix

### Changed files
- `tools/write-flare-wallet-flow.mjs` (new) — generates the headed
  playwright-cli wallet flow (real MetaMask connect via `notification.html`
  opened as a tab — the extension popup is not a context page under
  playwright-cli; same workaround dAppwright uses internally), full
  7-route navigation walk, and the confidential auction lifecycle
  CREATE → LP-A bid → LP-B bid → FINALIZE with assertions.
- `src/flare-playwright-wallet-flow.test.ts` (new) — vitest suite pinning the
  generated flow's guards (no dummy `0xd9…` hash, no proxy router,
  notification-tab connect, read-model confidentiality assertions).
- `apps/flare-web/src/model.ts` — added `buildSimAuctionEnvelopePayload`,
  `buildSimBidEnvelopePayload`, `SIM_ASSET_DECIMALS` (TDD in
  `src/flare-web.ui.test.ts` round-trip through `createSimFinalizeMatch`).
- `apps/flare-web/src/App.tsx` — auction/bid envelopes now follow the
  simulated-lane contract (see decisions).

### Decisions
- **Simulated-lane envelope contract:** the relay matcher
  (`createSimFinalizeMatch`) revives `JSON.parse(ciphertext)`; the UI
  previously sealed envelopes with real AES-GCM (`encryptEnvelope`), so
  relay finalize could never match from the browser. The UI now emits
  JSON-as-ciphertext envelopes exactly like `tools/sim-rfq-payload.mjs`
  and `local-rfq-in-process.mjs`. Real encryption remains the FCC/TEE
  lane's job; the UI footer still labels the mode
  "FCC assurance: simulated local/testnet mode".
- **Bid commitment reuse:** bids must carry the auction's commitment
  (`ENVELOPE_COMMITMENT` correlation check in `blindRelay.submitBid`);
  the UI now reads it from `listRelayAuctions` instead of deriving a
  fresh content commitment.
- **Confidentiality assertion target:** with JSON-as-ciphertext the local
  relay request bodies intentionally contain the payload; the business
  guarantee asserted by the flow is that the *read model* exposes only
  commitment metadata (`Encrypted RFQ`, bid counts) — no pair/bid
  plaintext.

### Edge cases handled
- Already-authorized origin (connect skipped if the dApp shows the
  truncated address button).
- MetaMask extension id discovered from open pages, with a fallback id.
- Stale HMR auctions from the old envelope format remain open in the
  local relay store; new finalize runs create a fresh auction per run.

## 2026-08-15 — Render restart identity recycle #2, rRap recovery, fresh live settle

### What happened
- Operator (with a Render API key supplied in chat) restarted the three TEE
  services. As documented, **restart mints new teeIds**: live identities became
  A `0x5C7FF009…`, B `0x1F709397…`, C `0xD5628BAb…` while on-chain PRODUCTION
  still held the pre-restart set (`0xA03CA458…` / `0x04251c4D…` / `0xDf3D9C2B…`).
  Symptom: dispatch mined, all TEE result polls 404, `quorum.ready=false`.
- Confirmed via scaffold tooling (`/tmp/fce-scaffold`, pinned `e3f5879`):
  `query-tee -reg 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` (FlareTeeManager
  diamond — the tool's default registry is stale for Coston2) and
  `fccutils.TeeProxyId(/info)` to derive the live teeIds.
### Recovery (runbook executed, no redeploy)
- `register-tee -command rRap` per host with `-a config/coston2/deployed-addresses.json`,
  `-c https://coston2-api.flare.network/ext/C/rpc`, `-ep https://tee-proxy-coston2-1.flare.rocks`,
  `SIMULATED_TEE=true`, `DEPLOYMENT_PRIVATE_KEY` (worktree `.env` deployer
  `0xeD37FD0d…`, machine owner) passed via env only — never written to disk.
  One transient failure: parallel rRap from one key hit
  `replacement transaction underpriced` (nonce/gas collision); sequential retry
  succeeded.
- `pause(_teeId)` on the three stale ids via a small Go tool built on the
  `machinemanager` binding. Post-state: `getActiveTeeMachines(66283)` = live
  three only, all status 2.
### Outcomes
- Fresh `fcc-settle=PASS` (dispatch `0x7b3e9777…`, swap `0x84f291d9…` block
  34062229) and headed proof-walk `playwright-cli=PASS` — see testing doc
  2026-08-15 entry.
- T-WALLET-4 stopped at the design boundary (browser `/swap` submit is the
  demo path; a live browser-signed `executeSwapRoute` needs a dispatch-only
  lane + route wiring = design change, not attempted).
### Follow-ups
- Operator must rotate the Render API key pasted in chat.
- Do not restart/redeploy Render TEEs unless `/info` teeId changes; recover
  with rRap + pause as above.

