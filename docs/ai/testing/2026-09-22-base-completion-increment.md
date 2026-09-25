---
phase: testing
title: Base Tokenized Stock Completion Increment — Verification
feature: base-tokenized-stock-desk
status: implementation-verified-live-evidence-open
date: 2026-09-23
---

# Scope of this increment

Covers canonical 8-decimal B20 metadata, ERC-8021 Builder Code attribution at
the wallet boundary, provider-native 0x/1inch/CoW adapters, external 0x wallet
execution safeguards, and the evidence API/view. It does not claim any live
provider execution. Fresh Sepolia controlled QA deployment and redemption
evidence are recorded below; these do not represent Coinbase/AP redemption.

# New and updated coverage

| File | What it proves |
| --- | --- |
| `src/base-core.assets.test.ts` | All 13 canonical assets are 8-decimal; the pinned block/hash is asserted; `assertCanonicalAssetMetadata` accepts only a matching observation and fails closed on decimals, symbol, code, feed, and unknown-address drift; a QA decimals override cannot change the canonical registry. |
| `src/base-core.builder-code.test.ts` | ERC-8021 encoding matches `ox/erc8021` spec vectors; round-trip decode; rejection of empty, comma-bearing, oversized, and non-printable codes; de-duplication; single append with duplicate-suffix rejection; value-only calldata untouched; malformed hex fails closed. |
| `src/base-wallet-attribution.test.ts` | Facility, approval, and venue calldata all carry exactly one suffix; the simulation uses the same attributed calldata; ETH-only transfers stay `0x`; no builder code leaves calldata untouched; a pre-attributed payload fails closed without sending; a malformed builder code throws at construction. |
| `src/base-swap-providers.test.ts` | 0x AllowanceHolder v2 URL/header/packet shape and gas pricing; 1inch Classic Swap v6.1 path and gas pricing; no-liquidity honesty; fail-closed rejection of wrong sell amount, insufficient minimum output, foreign allowance target, unallowlisted execution target, empty/malformed calldata, native value, zero output, and wrong chain; one failing provider cannot suppress a live one; server-only config fail-closed rules; CoW quote parse, EIP-712 order construction, local signer recovery, taker binding, sell-amount/min-out/expiry/recipient rejection, exclusion from the executable fan-out, and mainnet-only gating. |
| `src/base-api.test.ts` | `GET /v1/evidence` returns injected canonical pin, 0x rejection, provider-unverified CoW quote, deferred 1inch, and controlled QA redemption fields through the actual HTTP route; the default file reader also loads the same safe projection from `KATON_BASE_EVIDENCE_DIR` while omitting raw provider bodies and signatures. |
| `src/base-web.ui.test.ts` | External route execution requires wallet/chain/token/amount/recipient binding, exact allowance to the provider target, a fresh decision block, successful simulation and receipt, and exact stock decrease plus minimum USDC increase. A quote bound to another wallet fails before approval. |

# Verified commands (this worktree, 2026-09-23)

```sh
npm run validate:base:b20          # assets=13 block=51068301 PASS, stale-feeds=0
npm run test:base                  # 30 files / 214 tests passed
npm run typecheck:base             # passed
npx tsc -p tsconfig.base-api.json --noEmit       # passed
npm run build:base-web             # vite production build passed
FOUNDRY_OFFLINE=true forge test --root contracts/base --offline  # 76 passed; 8 fork cases skipped
node tools/check-base-secrets.mjs  # secret-scan=PASS files=95
git diff --check                   # passed
```

`npm run validate:base:b20` is a live RPC gate: without `BASE_FORK_RPC` (or
`KATON_BASE_RPC_URL`) it fails with `BASE_FORK_RPC_REQUIRED`, and with the RPC
available it re-derives every canonical asset and feed from chain state at block
`51068301` and compares the digest with the tracked fixture.

# Live and lifecycle gates still open

- Live 0x AAPLc route and execution on the canonical Base fork. The worktree has
  configured 0x credentials and a fork RPC, but `npm run validate:base:b20`
  failed before reading the pinned block (`fetch failed`), so no route response
  was obtained and no holder was selected or impersonated.
- Live CoW AAPLc quote and locally verified signature on the canonical fork.
  Public endpoint access and signer owner match remain to be proven.
- 1inch AAPLc execution is deferred: there is no configured key, and execution
  stays disabled unless the explicit server flag is enabled after its live gate.
- A fresh 8-decimal mock-AAPLc Base Sepolia deployment, purchase, redemption
  booking, operator settlement, and realized P/L (needs funded disposable role
  wallets). The current deploy and swap scripts still use an 18-decimal token
  amount, so they need to be made 8-decimal-safe before deployment.
- Headed wallet E2E of external route execution and the evidence view. UI/build
  implementation exists; the browser lifecycle has not been run.

## 2026-09-23 provider and controlled redemption evidence

The previous open-gate notes above are historical and superseded by the
following captured evidence:

- Canonical Base pin: block `51068301`, hash
  `0x81ceda4cb39bf70b057c08dc2d70b201b5190ecb8ebb79ccdca3e12b1d73ea41`.
- 0x AllowanceHolder quote request for AAPLc returned HTTP 422 with
  `SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`; response hash
  `0x80e6afc40804ee2f8143e33b18741f859fd5932eb949f30e28834f69506d92b9`.
  No route or transaction was produced.
- CoW returned HTTP 200 in 9 ms; response hash
  `0xa9cd1c5c3d9596cdfdb5db5a206f764d05ca74e2e3d930c1c44e9696f9fb7713`.
  The locally computed EIP-712 digest and recovered owner matched, while the
  provider reported `verified=false`. No order was submitted; this is not
  executable liquidity.
- A fresh Sepolia mock AAPLc deployment uses 8 decimals and is explicitly
  non-production. The controlled QA lifecycle purchased `100000000` stock
  units for `900000` native-USDC units and settled for `1000000`, verifying
  `100000` realized profit, zero remaining facility stock/exposure/inventory
  cost, and canonical transaction receipt block hashes. Classification is
  `CONTROLLED_QA_REDEMPTION`, not Coinbase/AP redemption.
- `npm run qa:base:redeem` is an idempotent verifier/resumer and refreshes the
  ignored proof at `output/base-qa/sepolia/redemption-proof.json`.

The API exposes these captured fields without raw provider bodies or
signatures. Its source files live under ignored `output/base-qa`. The default
file reader uses that path under the current working directory; deployed
runtimes mount or copy `evidence/provider-gates.json` and
`sepolia/redemption-proof.json` into one artifact tree and set
`KATON_BASE_EVIDENCE_DIR` to its absolute path. The endpoint allowlists its
response fields, so raw provider bodies, signatures, and unrelated proof
details are omitted. The HTTP tests cover both the injected-reader seam and
the configured file-reader path. The headed wallet flow has not been exercised
against a live external route because 0x rejected AAPLc.

Fresh prior-session verification after these code changes: provider suite 17
tests; Base suite 215 tests; Base API typecheck and Base web build passed; the
controlled redemption verifier passed. These are not a substitute for reruns
after subsequent edits in this session.

### Earlier handoff continuation reruns — 2026-09-23 (superseded where noted)

- `npm run qa:base:redeem` failed before refreshing its proof:
  `qa-base-redemption=FAIL reason=HTTP request failed.`
- At that earlier attempt, B20 validation and the venue fork runner failed
  before reading/running due to transport and Foundry system-proxy errors.
- The `/v1/evidence` endpoint test passed through HTTP with an injected fixture
  reader. Deployed packaging/configuration remains a separate requirement.

After adding the injected-reader seam, fresh local checks passed:

- `npm run test:base`: 30 files, 217 tests passed.
- `npm run typecheck:base`: passed.
- `npx tsc -p tsconfig.base-api.json --noEmit`: passed.
- `npm run build:base-web`: passed.
- `node tools/check-base-secrets.mjs`: `secret-scan=PASS files=95`.
- `git diff --check`: passed.

### Final continuation gates — 2026-09-23

- `npm run test:base`: 30 files, 220 tests passed, including the default file
  reader over HTTP and visible missing-artifact behavior.
- `npm run validate:base:b20`: passed for 13 assets at block `51068301`, with
  zero stale feeds.
- `npm run test:base:venues:fork`: passed all eight cases at block `51068301`.
- `npm run qa:base:redeem`: two fresh retries failed at RPC transport
  (`RPC Request failed.`); no proof refresh occurred. The already recorded
  controlled redemption remains historical evidence.
- Base, API, and indexer typechecks, Base web production build, offline Foundry
  tests (76 passed, 8 network fork cases skipped), secret scan, both AI DevKit
  lints, and `git diff --check` passed.
- 0x still rejects AAPLc; CoW remains provider-unverified and unsubmitted;
  1inch is deferred. No executable route exists for headed wallet QA.

### External wallet submit-path coverage — 2026-09-23

Added a deterministic success-path test for `submitExternalStockSaleRoute` and
a wrong-wallet binding rejection test. Fresh verification after those tests:

- `npm run test:base`: 30 files, 219 tests passed.
- `npm run typecheck:base`: passed.
- `npx tsc -p tsconfig.base-api.json --noEmit`: passed.
- `node tools/check-base-secrets.mjs`: `secret-scan=PASS files=95`.
- `npx ai-devkit@latest lint --feature base-tokenized-stock-desk`: passed.
- `git diff --check`: passed.
