# Remaining tasks — flare-confidential-rfq-dex

Last updated: 2026-08-14 (Task 4 headed e2e shows live 66283 hashes; next is Task 5 docs close).

## Remaining-local (design alignment in shipped code)

**None.** The four Phase 7 local gaps are closed with TDD on the shipped units:

| ID | Closed how | Evidence |
|---|---|---|
| T1 standing-route | `RFQSettlement.execute` allows `taker==0 \|\| taker==seller` | `testOpenTakerStandingOrderIsExecutableAsRouteLeg` |
| T2 hash seam | TS/Go `hashSwapRoute` = Solidity `keccak256(abi.encode(route))` | `src/flare-core.matcher.test.ts`, Go matcher, `SwapRouteHashVector.t.sol` |
| T2/T3 relay book | Bids persist; finalize → `matchAuction`; plaintext POST fail-closed | `src/flare-api.test.ts` (19); `PLAINTEXT_WORKFLOW_DISABLED` |
| T3 facility depth | Adapter NAV, `_ensureIdle` pull-on-fill, `fund` + `fundLiquidation`, registry-mode settle | `testExecuteLiquidationRouteFundsFromShippedFacility` (router calls `fund` on shipped facility) |

Sim FCC finalize is wired on the HTTP API (`createSimFinalizeMatch`). Real mode without a dedicated extension returns `DEDICATED_EXTENSION_REQUIRED`. This is **not** production FCC.

## FCC option-1 lane — progress reconciliation — 2026-08-14

The prior “none remaining-local” statement covered the old custom simulated
matcher scope. The selected next milestone adds locally actionable work:

- `C2-FCC-0`: pin and characterize the official FCC extension scaffold;
- `C2-FCC-1`: implement cross-language three-recipient envelopes;
- `C2-FCC-2`: port TrustRFQ matching into the scaffold handler;
- `C2-FCC-3`: run three isolated simulated TEE/proxy/Redis stacks;
- `C2-FCC-4`: bridge distinct signed results to `submitFccResult`; and
- `C2-FCC-5`: pass local three-stack and failure-injection rehearsal.

`C2-FCC-6` and `C2-FCC-7` then require the reachable Coston2 indexer endpoint,
three funded proxy identities, stable public HTTPS endpoints, verified registry
data, and operator approval for state-changing deployment/configuration. See
[`fcc-coston2-option-1.md`](./fcc-coston2-option-1.md).

Progress after receiving the support-issued indexer pair:

| Task | Status | Evidence / remaining gate |
|---|---|---|
| C2-FCC-0 | partial/blocked | The provider-facing `/instruction`, `/action/status`, and `/ready` boundaries now match the required local wire shape, but the official scaffold source/version is not pinned because package fetch is DNS-blocked. The current compose still builds the custom matcher. |
| C2-FCC-1 | partial | Three-recipient TS/Go envelope seams and vectors exist locally; scaffold/node decrypt compatibility is unverified. |
| C2-FCC-2 | done (1-machine simulated-TEE, 2026-08-14) | Matcher ported into vendored scaffold (`go/internal/extension` RFQ/BID/MATCH). Dedicated Coston2 extension 66277 (`0x…0102e5`), sender `0x876398bBb8C040FF83bCcf6ccEB160989AF86F26`, machine `0xE73bCaaf2e5c0259835ec6cb6e621C3B7Aa04336`. `run-test` MATCH/FINALIZE instruction `0x91a8a8f6…44750` returned golden route hash `0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975`. Deferred: `ConfidentialRFQInstructionSender.submitFccResult` (requires teeCount==3 / quorum 2). |
| C2-FCC-3 | done (3 live PRODUCTION on 66283 after recycle rRap) | After free-tier recycle, live `/info` identities no longer matched the first 66283 PRODUCTION set. Re-registered without restart: A `0xA03CA4589003aea72402E886AD8474fD1DD409bF`, B `0x04251c4D4052d29691788aBAcFF4a68d27aaA198`, C `0xDf3D9C2BCE5f39a373ea0D45b03101c4755bD796`. Paused stale `0x09131744…` / `0x9A25Bf3A…` / `0xE70A3D59…` (status 4). `getRandomTeeIds(66283, 3)` now returns only the live three. Do not restart Render (new identity). Do not drop to 1 TEE. |
| C2-FCC-4 | done (live Coston2, 2026-08-14) | New EOA sender `0x55aA4F400f3819498eD4Cbe120839E609f0897F3` (deploy `0xeab945e4…` block 34055860, bytecode `0x34064d7e…`) is the official instruction sender for extension 66283. `configureFcc` `0xdb8af378…` block 34056056 (registries = diamond, id 66283, quorum 2). Live relay `fcc-relay=PASS`: dispatch `0x23663327…` block 34056066, 3 matching TEE results (golden `0x72661810…`, tag `threshold`), 3 `submitFccResult` txs (`0xc61693bf…`, `0x3d6bbd16…`, `0xc33655be…`), `quorum.ready=true`. Manifest `contracts/flare/deployments/coston2-fcc-sender.json`. Do **not** `configureFcc` again on this sender or on `0x6b97db10…`. |
| C2-FCC-5 | not started | No fresh official three-stack rehearsal or one-/two-machine failure run has passed. |
| C2-FCC-6 | done (this machine, 2026-08-14) | Coston2 deploy+register complete on unrestricted environment: official scaffold pinned (`fce-extension-scaffold@e3f5879`), stack up via official compose + coston2 overlay, proxy DB on the shared hackathon indexer (`/ready` 200), `register-tee rRap` promoted machine `0x6c825C…dbb2` to status 2 (PRODUCTION) under extensionId 66251, `run-test` SAY_HELLO/SAY_GOODBYE round-tripped through public FTDC providers. Caveats: SIMULATED_TEE=true; ephemeral quick-tunnel URL (named tunnel = follow-up). Indexer preflight `mysqlAuthenticated=true` unchanged. |
| C2-FCC-7 | done (live confidential `executeSwapRoute`, 2026-08-14) | Isolated router `0xb136b8a143bF358Ae7976ED558BBB054fd13faE9` `fccQuorumVerifier()=0x55aA4F40…`. After rRap+pause, golden control `fcc-relay=PASS` dispatch `0x44a1bec4…`. Live settle `fcc-settle=PASS`: dispatch `0xbe72307c…`, instruction `0xab451a20…`, actionId `0xa179a261…`, selectedHash `0xfa3c292e…` = `hashSwapRoute(route)`, swap `0xf8542ac8…` block **34058401**. Event gross 1000e18 / net 995e18. First live swap (assertion later fixed) `0xcacedaaa…` block **34058293**. Indexer was not the 404 cause. |

The indexer credential pair is therefore no longer an acquisition blocker, but
the execution environment still matters for live evidence. The operator shell
authenticated the pair successfully; this Codex sandbox cannot reproduce that
result because outbound TCP/DNS and the Docker socket are denied. Treat
`FCC_INDEXER_UNREACHABLE` or proxy-unreachable output from this session as a
sandbox boundary, not as credential evidence. Official runtime integration,
registered machines, stable HTTPS endpoints, and real attestation remain
blockers for production T2.4.

### Execution-boundary blocker — 2026-08-14

This is a tooling/environment distinction, not a second FCC implementation:

| Check | Operator shell | Codex sandbox | Interpretation |
|---|---|---|---|
| MySQL TCP + greeting/auth | `PASS`, `mysqlAuthenticated=true` | `EPERM` / `FCC_INDEXER_UNREACHABLE` | Credentials and endpoint are valid; live network access differs. |
| Public HTTPS `/info` | Must be run with registered URLs | DNS/socket denied here | Proxy freshness is unverified by this session. |
| Docker daemon | Available only where the operator has Docker access | Docker socket denied here | Compose restart/health evidence must come from the operator environment. |

Do not downgrade the authenticated indexer result because of the sandbox
failure, and do not claim proxy or TEE health until the operator-shell checks
produce fresh output.

### Next actionable tasks

1. Task 4 done (2026-08-14): `settle:flare:fcc:coston2` wrote live evidence
   (`fcc-settle=PASS` dispatch `0x385ffbcf…` swap `0x58331d08…` block **34058733**,
   route `0x13887129…`). `npm run test:e2e:flare:fcc:live` headed walk showed the
   isolated router `0xb136b8a1…`, extension 66283, and those hashes on `/swap`.
   Refuses `0xd9`, dummy golden `0x72661810…`, and browser proxy `0x7fA18179…`.
   This is **proof display** of the live script path, not MetaMask-signed
   `executeSwapRoute` from the browser (T5.8 dAppwright not requested).
2. Task 5: keep implementation/testing docs aligned with the Task 4 hashes.
3. Encrypted 3-recipient envelopes remain C2-FCC-1 and are **not** required to
   prove 2-of-3 `submitFccResult` (already proven with plaintext MATCH).
4. Indexer preflight is already green on this host
   (`mysqlAuthenticated=true`). Re-run only if credentials change. Indexer lag
   was not the 404 cause: providers POST `/instruction` to the registered URL.
5. Rotate **both** Render API keys pasted in chat (dashboard). Do not write them
   into git. Do not restart Render unless the live teeId changes again.

## Other local slices (excl. T5.8)

Outside the newly selected `C2-FCC-0` through `C2-FCC-5` lane, no additional
local MVP residual is currently selected. Existing local slices remain (still
not production SC):

- T4.3–T4.8: Solidity Morpho/Kinetic/Clearpool yield + Morpho/Kinetic liquidation adapters (custom mock market ABI)
- T5.6: `curatorAdapterSummary` / `DEFAULT_CURATOR_ADAPTERS` (0 enabled until governance)
- T7.1–T7.2 prep: `FAssetsRail.prepareMint` / `prepareRedeem` (disabled-by-default; never signs)
- T5.7 local: flare-web bundle budget (`check:flare:web-performance`)

## External / untackleable (after ≥2 fail-closed attempts)

| ID | Need | Latest result | Operator setup |
|---|---|---|---|
| T2.4 | Real FCC 2-of-3 + dedicated extension | `smoke:flare:fcc-registry` → `DEDICATED_EXTENSION_REQUIRED` ×2; local e2e real mode `400 DEDICATED_EXTENSION_REQUIRED` | GCP Confidential Space; dedicated Tee extension + 3 machines; `FLARE_TEE_EXTENSION_REGISTRY`, `FLARE_TEE_MACHINE_REGISTRY`, `FLARE_FCC_EXTENSION_ID`, `FLARE_FCC_MODE=real`; then `node tools/configure-flare-fcc-coston2.mjs` |
| T4 SC-16 | Verified venue manifests + fork RPC | Official-source pass 2026-08-13: **no Coston2 registry** (`docs/ai/planning/venue-research.md`); stay mocks | Wait for official Coston2 addresses; then `FLARE_VENUE_MANIFEST=fixtures/flare/venues-coston2.json` |
| T4.1–T4.2 | Paid FDC credentials | Public UUID smoke `fdc-verifier=PASS`; #1458 OPEN no reply | When Flare replies, paste key into worktree `.env`; `npm run smoke:flare:fdc-verifier` (loads `.env`) |
| T5.7 extras | Screen-reader, visual baselines, production Lighthouse | Local bundle only; no production URL | Public HTTPS URL + approved visual refs |
| T6.4–T6.7 | Managed ops, 24h soak, RC, review, mainnet | `FLARE_RELEASE_PROFILE=production npm run check:flare:release-gates` → `release-gate=BLOCKED` ×2; `check:flare:production-config` → `production-config=BLOCKED` ×2; `check:flare:governance` → `GOVERNANCE_MANIFEST_REQUIRED` ×2. Local 30s soak is **not** 24h managed soak. No RC/mainnet. | HTTPS+mTLS, Mongo/`rediss://`, all keeper job HTTPS pairs, D+E+F evidence, multisig/guardian manifest, `FLARE_EXTERNAL_REVIEW_ID`. Humans set `FLARE_GOVERNANCE_STATUS=production-approved`. Then re-run release-gates. T6.5 RC / T6.7 mainnet need explicit human approval. |
| T7.3 | FXRP LP funding UX | Not started | Product decision |
| **T5.8** | dAppwright re-run | **Excluded** (prior evidence retained) | Re-open only if requested |

## Fresh suite snapshot (post Phase A, twice; re-verified 2026-08-13 resume)

- `npm test` → **283** passed / 39 files (both runs; `suites-run{1,2}-resume.log`)
- `cd contracts/flare && forge test --offline` → **113** passed / 17 suites (both runs; includes `testExecuteLiquidationRouteFundsFromShippedFacility`)
- `go test -count=1 ./...` under `services/fcc-matcher` → ok (both runs)
- `cargo test --manifest-path contracts/otc_swap/Cargo.toml` → **6** passed (both runs)
- `npm run typecheck:flare` → pass; `typecheck:flare-api` → pass
- `npm run check:flare:web-performance` → PASS (`jsBytes=258084` / budget 300000)

## Local + Coston2 evidence (not production)

- Local RFQ path: `node tools/local-rfq-e2e.mjs` → simulated finalize `resultHash=0xa9b5c739…`; `FLARE_FCC_MODE=real` → `400 DEDICATED_EXTENSION_REQUIRED`
- Coston2 smoke ×2 on `contracts/flare/deployments/coston2.json` (not proxy-candidate): `chainId=114` router `0x593095709e16275cc0b8aa0ef908fd13d693c36c`

## Not claimed

SC-1–SC-16 production closure, real FCC 2-of-3 attestation, verified Morpho/Kinetic/Clearpool
deployments, paid FDC policies, multisig/guardian handoff, Coston2 RC, mainnet pilot.
Simulated FCC is **not** production FCC proof.

## Phase 5 e2e/wallet lane — 2026-08-14

| Task | Status | Evidence / remaining gate |
|---|---|---|
| Phase lint | done | `ai-devkit lint` + `--feature flare-confidential-rfq-dex` all OK |
| T-WALLET-1 dAppwright re-open | done | `qa:wallet:cleanup` + `qa:wallet:setup` on Node 24.10.0: MetaMask 13.17.0 initialized for Coston2 (0x72), provider detected at 127.0.0.1:5173. No fix needed. |
| T-WALLET-2 wallet + navigation UI flow | done | Headed playwright-cli via `.playwright/cli.config.json`; real MetaMask connect (notification.html tab workaround), `0xcC1B…088A`, chain `0x72`, 7/7 routes, 0 console errors, no overflow. |
| T-WALLET-3 confidential auction lifecycle UI flow | done | CREATE → LP-A → LP-B → FINALIZE PASS; `relayRequestsCaptured:4`; read model ciphertext-only. Two product bugs fixed with TDD (see testing doc). |
| T-E2E-1 fresh script settle on Coston2 | done | **UNBLOCKED via Render API + registry recovery, then PASS.** Operator supplied a Render API key; restart of the three TEE services minted fresh teeIds (restart = new identity, as documented). Root cause of the 404s was identity mismatch, not dead workers: registered PRODUCTION set was the pre-restart identities. Recovery (no redeploy): scaffold `register-tee -command rRap` (pinned `e3f5879`, `SIMULATED_TEE=true`, FTDC ext proxy `https://tee-proxy-coston2-1.flare.rocks`) on the live identities A `0x5C7FF009…`, B `0x1F709397…`, C `0xD5628BAb…`; paused stale `0xA03CA458…` / `0x04251c4D…` / `0xDf3D9C2B…` (txs `0xfe2acc2c…`, `0xd07d772b…`, `0x96a37c5e…`). `getActiveTeeMachines(66283)` = live three only. Fresh `fcc-settle=PASS` dispatch `0x7b3e9777…` actionId `0x9057337f…` selectedHash `0xf0467438…` swap `0x84f291d9…` block 34062229. Evidence: `output/playwright/fcc-live-e2e.json`. |
| T-E2E-4 live proof walk re-run | done | `FLARE_FCC_E2E_REUSE=1 npm run test:e2e:flare:fcc:live` → `playwright-cli=PASS flow=fcc-live-66283`; `/swap` showed router `0xb136b8a1…`, new dispatch/actionId/swap hashes; dummy-golden guard (`DUMMY_GOLDEN_VISIBLE`) exercised. One retry needed: stale wallet-flow session held the MetaMask profile lock (`Browser is already in use`); closed prior `playwright-cli` session first. |
| T-WALLET-4 browser-signed live swap | **stopped at design boundary** | The `/swap` Sign-and-submit path is the demo path (`buildDemoSwapTransaction`): targets `DEMO_ROUTER`, uses a fresh commitment as `fccActionId`, not the isolated FCC router with a quorum-ready actionId. Wiring a submittable live `executeSwapRoute` (dispatch-only lane + browser route construction + QA-account allowances) is a design change → per plan, stop and report rather than hack. Evidence model remains: script-signed live Coston2 swap (T-E2E-1) + browser proof display (T-E2E-4). |
| T-E2E-5 three-stack rehearsal | todo | Not attempted this session. |

**Operator action (admin-gated, still open):** rotate the Render API key that was
pasted in chat (dashboard → API Keys). Do not restart/redeploy the TEE services
again unless the live `/info` teeId changes — and if it does, recover with
`register-tee rRap` + `pause` of the stale ids exactly as recorded above, never
with a redeploy.
