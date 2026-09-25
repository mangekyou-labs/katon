---
phase: implementation
title: Katon Base B20 Stock-to-USDC RFQ Implementation
feature: base-tokenized-stock-desk
status: completion-increment-canonical-decimals-providers-attribution
---

# Implemented seams

- `packages/base-core/src/eip712.ts` defines the v2 `SwapOrder` domain and digest
  while retaining v1 liquidation hashing.
- `packages/base-core/src/swap.ts` implements request validation, one-second
  cutoff filtering, signed maker/facility/external quote validation, greedy
  partial/blended internal routes, effective-output ranking, FOK handling, and
  deterministic ties.
- `apps/base-api/src/service.ts` authenticates the taker, gates mainnet
  eligibility, fans out sources, revalidates standing orders, serializes
  seller-private route bundles, and registers/revokes maker orders.
- `apps/base-api/src/swap-sources.ts` provides strict HTTP maker/facility/
  external parsing and wallet-bound eligibility attestation.
- `apps/base-api/src/external-providers.ts` provides provider-native 0x and
  1inch adapters plus the CoW signed-intent flow.
- `packages/base-sdk` serializes v2 orders and exposes quote/register/revoke
  calls; `services/indexer/src/base` projects swap and facility events;
  `apps/base-web` hosts the seller-first stock sale page.
- `contracts/base` contains `BaseEIP712.sol`, `RFQSettlement.sol`,
  `RFQRouter.sol`, `LiquidityFacility.sol`, `OracleGuard.sol`, `B20Guard.sol`,
  and the venue adapters.

# Completion increment — 2026-09-22

## 1. Canonical 8-decimal B20 precision (corrected)

Canonical Coinbase B20 tokenized stocks are **8-decimal** ERC-20s on Base;
native USDC is 6-decimal. The previous registry declared 18 decimals, which
scaled every stock amount, oracle reference, and UI disclosure wrongly.

- `packages/base-core/src/assets.ts` pins all 13 canonical assets to
  `B20_STOCK_DECIMALS = 8` and adds `B20_CANONICAL_PIN` (Base `8453`, block
  `51_068_301`, hash
  `0x81ceda4cb39bf70b057c08dc2d70b201b5190ecb8ebb79ccdca3e12b1d73ea41`).
- `assertCanonicalAssetMetadata` fails closed on a wrong symbol, non-8 decimals,
  missing token or feed bytecode, or a mismatched Chainlink feed.
- `tools/validate-base-b20-assets.mjs` (`npm run validate:base:b20`) reads live
  mainnet state at the pinned block for every canonical asset plus its
  Chainlink feed and compares it with the tracked fixture
  `fixtures/base/b20-assets-mainnet.json`. `--write` materializes the fixture; a
  plain run fails closed on any drift and writes the redacted evidence file
  `output/base-qa/evidence/b20-canonical.json`.
- Verified result: `assets=13 block=51068301 hash=0x81ceda…ea41
  digest=sha256:7172826771435e51bc9bff379e0b304232993a1448993502fe80394930c99781`,
  `stale-feeds=0`. Every canonical token reports `decimals() == 8` with live
  runtime bytecode and a fresh 8-decimal Chainlink reference feed.
- QA/deployment overrides remain possible (`getB20DecimalsByAddress`), but the
  canonical registry itself can no longer be silently replaced.

## 2. ERC-8021 Builder Code attribution (new)

- `packages/base-core/src/builder-code.ts` implements the ERC-8021 suffix
  (`[schema-0 data][uint8 length][uint8 schemaId][16-byte 0x8021 marker]`) with
  spec vectors cross-checked against `ox/erc8021`, strict code validation,
  de-duplication, decode, and duplicate-suffix rejection.
- `apps/base-web/src/wallet.ts` appends the suffix at the single shared
  transaction boundary (`sendTransaction`/`simulate`), so router submissions,
  facility calls, venue calls, and approvals are all attributed. Value-only
  transfers stay plain `0x` data, and calldata that already carries the marker
  fails closed with `BUILDER_CODE_DUPLICATE_SUFFIX`.
- The code resolves from the injected runtime config (`builderCode`) first, then
  the build-time `VITE_KATON_BASE_BUILDER_CODE`; an unset code disables
  attribution and a malformed one throws at wallet construction.

## 3. Provider-native external adapters (replaces generic pass-throughs)

`apps/base-api/src/external-providers.ts`:

- **0x** — `GET {base}/swap/allowance-holder/quote` with the `0x-version: v2`
  header, validated against `ZERO_EX_ALLOWANCE_HOLDER`
  (`0x0000000000001fF3684f28c67538d4D072C22734`).
- **1inch** — `GET {base}/swap/v6.1/{chainId}/swap` (Classic Swap 6.1), gas
  priced into USDC through the configured native/USDC price.
- **CoW** — `POST {base}/base/api/v1/quote` plus `buildCowOrder`, which
  constructs the exact EIP-712 order (domain `Gnosis Protocol` / `v2` /
  settlement `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`), signs it with a
  controlled QA key, and recovers the signer locally. The DTO is explicitly
  `kind: 'SIGNED_INTENT'`, `executable: false`, `submitted: false`, and CoW is
  never part of the executable quote fan-out.
- `loadExternalProviderConfig` is server-only and fails the process closed when a
  provider is enabled without execution/allowance target allowlists or without
  the native/USDC gas price. 0x additionally requires its real allowance target
  to be allowlisted.
- Every provider packet is normalized to the strict shape the core ranker
  re-validates: chain, taker, recipient, token pair, exact sell amount, minimum
  output, allowance target, execution target, calldata, and zero native value.
- `CompositeSwapQuotePort` merges the legacy HTTP maker/facility port with the
  provider-native adapters; `apps/base-api/src/server.ts` composes it at boot.

## Decision log additions

| Decision | Rationale |
| --- | --- |
| Canonical decimals are 8, verified at a pinned block | Prevented a silent 10^10 scale error in every stock amount. |
| CoW is a separate signed-intent DTO, not an executable route | CoW orders are asynchronous intents, not swap transactions. |
| Provider gas is priced from an explicit native/USDC config | Fabricating a gas price would corrupt route ranking. |
| Attribution is applied once at the wallet boundary | A second suffix would double-count attribution. |

# Historical M5 record (condensed; unchanged by this increment)

- A non-production Base Sepolia M5 candidate was deployed and promoted with
  candidate digest
  `8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`
  (`productionEligible: false`). The promoted public manifest is
  `contracts/base/deployments/sepolia.json`, whose `b20Assets` entry still
  describes the **18-decimal control mock B20** of that deployment. That
  mismatch is exactly what the fresh 8-decimal QA deployment above must remove.
- Candidate-bound live evidence: deposit proof at block `47108154`; stock-sale
  proof with approval
  `0xeb44ef8c925717217417044cd3f282336e421feeb5d867838b3f6a575b634c4b` and
  settlement
  `0x156c607aeaf8a6201cbbe4bddd616331e15c9ced5333bec405b3d6491b8ffa28`
  (order hash `0x6085b4f85eaa4973ea60cb98163cafec751df03c8016611033b6ceb1dfd81282`).
- A fresh pinned venue-fork run passed I-FORK-1 … I-FORK-8 at Base block
  `51068301`; official wire-format mirror artifacts were mirrored into
  `tests/fixtures/hyperliquid/`.

# Still open (blocked or deferred, not claimed as complete)

- External wallet execution for a fresh, validated 0x route and the `/evidence`
  API/view are implemented. They are not proof of a live route: execution checks
  exact approval, chain and quote binding, decision-block freshness, receipt,
  stock balance decrease, and USDC minimum output.
- The pinned Base provider requests are now recorded in the ignored evidence
  artifact. 0x returned HTTP 422 (`SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`) for
  AAPLc, so route and execution remain unavailable. CoW returned HTTP 200; the
  local EIP-712 digest and signer recovery match the quote owner, but the
  provider marked it `verified=false`. It was not submitted and is not
  executable liquidity.
- 1inch is deferred. Its executable adapter is disabled unless
  `KATON_BASE_ENABLE_1INCH_EXECUTION=true`; no key or live AAPLc route has been
  verified.
- A fresh 8-decimal Sepolia QA candidate completed purchase, automatic
  redemption booking, operator settlement, proceeds verification, exposure
  reduction, and realized P/L. This evidence is classified
  `CONTROLLED_QA_REDEMPTION`, not Coinbase/AP redemption. The candidate remains
  non-production.
- The evidence API now accepts an injected `BaseEvidenceReader`, is covered
  through the public HTTP route with explicit fixtures, and its default file
  reader accepts `KATON_BASE_EVIDENCE_DIR`. Deployed packaging/configuration
  must provide the artifact directory.

# Completion update — 2026-09-23

- Corrected CoW hashing to the typed-data EIP-712 digest and bound the signature
  recovery to the owner returned by the live quote. The order remains a local
  signed intent and is never submitted.
- Added the external 0x wallet path, evidence endpoint and evidence page; 1inch
  stays opt-in and deferred. The recorded 0x provider response rejects AAPLc
  (HTTP 422); the CoW quote is locally signed but provider-unverified, and no
  order was submitted.
- Fresh Base Sepolia controlled QA redemption evidence verifies the
  purchase/settlement receipts and 100,000 native-USDC units of realized profit.
  This is not Coinbase/AP redemption and does not make the candidate
  production-eligible.
- Fresh local verification includes provider tests (17), Base tests (219),
  Base/API typechecks, Base web production build,
  offline Foundry tests (76 passed; 8 network fork cases skipped), secret scan,
  and `git diff --check`. The new endpoint test passed through HTTP with
  injected fixtures. Artifact packaging/configuration remains a deployment
  requirement.

## Evidence runtime continuation — 2026-09-23

`KATON_BASE_EVIDENCE_DIR` is the API runtime's artifact mount point. It contains
`evidence/provider-gates.json` and `sepolia/redemption-proof.json`; local runs
default to `output/base-qa` relative to the API working directory. Deployment
images or volumes must supply these two files and set the variable to the
absolute path of their parent tree. The `/v1/evidence` controller projects
allowlisted status, canonical pin, response hash, receipt, and realized P/L
fields. It does not serialize provider response bodies, CoW signatures, or
unrelated redemption proof fields. Missing files leave their corresponding
provider/redemption evidence visibly unavailable.

`src/base-api.test.ts` now verifies the configured directory through a real
`GET /v1/evidence` HTTP request. Its source fixtures deliberately include a
provider body and signature sentinel and assert neither appears in the public
response. `docs/ai/deployment/2026-09-08-feature-base-tokenized-stock-desk.md`
records the deployment mount contract; the testing increment records the
configured-reader scenario.

## Continuation verification — 2026-09-23

Fresh local gates passed: Base tests (220), Base/API/indexer typechecks, web
production build, offline Foundry tests (76 passed; 8 fork cases skipped),
secret scan, both AI DevKit lints, and diff check. Pinned B20 validation passed
for 13 assets with zero stale feeds, and the venue fork runner passed all eight
cases. Two fresh controlled-redemption verifier attempts failed at RPC transport,
so the earlier QA proof was not refreshed. The live AAPLc provider route remains
unavailable (0x rejects it; CoW is provider-unverified; 1inch is deferred), and
the candidate remains `productionEligible=false`.
