---
phase: deployment
title: Katon Base Tokenized Stock Desk Deployment Strategy
description: Environment boundaries, Sepolia-first release gates, and rollback
feature: base-tokenized-stock-desk
status: m5-candidate-promoted
---

# Deployment Strategy

The LP-only M5 candidate is promoted for non-production Base Sepolia QA. This
file records the environment boundary and remaining release gates; no Base
mainnet deployment is authorized.

## Infrastructure

- Web: static SPA (`apps/base-web`) on a CDN or Vercel-style host
- API, indexer, keepers: container host with MongoDB
- Contracts: Foundry scripts against Base Sepolia, then gated Base mainnet
- Environments: local, Base Sepolia (default), Base mainnet (approval-gated)
- No funded settlement key in any API environment

## Deployment Pipeline

### Build Process

- Typecheck Base packages from source
- `forge build --root contracts/base`
- Vite build for `apps/base-web`
- Record bytecode hashes into `contracts/base/deployments/<network>.json`

### CI/CD Pipeline

- Vitest for `base-*`, Foundry for `contracts/base`, secret scan
- Existing other-chain CI jobs stay unchanged
- Venue-fork tests are opt-in (`BASE_FORK_RPC`) and never required to skip-pass

## Environment Configuration

### Development

- Local anvil or Sepolia RPC
- Mock venues until T3.3 pins official addresses
- Native Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

### Staging

- Base Sepolia `chainId` 84532
- Pilot protocol fee 0
- Interface mocks allowed only where official B20 or lending deployments are absent, and the smoke log must say so

### Production

- Base mainnet `chainId` 8453 after M6 is green, venue-fork manifests exist, and an explicit go-ahead
- Native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Guardian, timelock, fee still 0 unless separately enabled under the 50 bps cap
- `KATON_BASE_LIQUIDATIONS_ENABLED` must remain unset/`false`. The API and UI
  fail closed even if a legacy adapter address is present; enabling it requires
  an independently reviewed B20 lending adapter with price-bearing max-seize
  and borrower/surplus-return semantics.

## Deployment Steps

1. Pre-deployment: bytecode hash, owner, fee = 0, native USDC, oracle and B20 guards configured, no USDbC, liquidation gate false
2. Deploy contracts, write manifest, verify source
3. Point API/web at the manifest; chain-gate MetaMask to the target chain
4. Post-deployment: read-only RPC smoke (M-6) and headed wallet QA on Sepolia (T6.2)
5. Rollback: pause router and facilities; do not "fix" by swapping unverified venue addresses

### Base QA operator entry point (T6.1)

`docs/qa-playwright-metamask-base.md` is the canonical runbook. Run
`qa:base:validate -- --target=sepolia|anvil` before setup, keep wallet material
only in ignored `.env.base-qa.local`, and use the target-specific stack and
profile paths. The operator tools never forward the mnemonic, password, seed,
or a private key to the keyless API/web stack. T6.1 validation is 12/12
targeted Vitest checks plus both fixed-target cleanup commands. The promoted
Sepolia deployment receipt, deposit, stock-sale, and promotion evidence are
recorded in the testing document; they authorize non-production QA only.

The M5 continuation keeps the hard safety gate before RPC/client creation and
before deployment: `assertNonstandardQaWallet` rejects the three standard Anvil
mnemonic addresses with `BASE_QA_STANDARD_WALLET_FORBIDDEN`. The promoted
candidate is deployed at Base Sepolia block `47107393`, has candidate digest
`8faef844630df3dd4f70435bbe7d5b9f61cfa74e08de2757e03eb4d376c36a56`, and
remains `productionEligible: false`. The LP-only QA stack uses
`GET /v1/auth/nonce` as its readiness probe because liquidation controls remain
disabled and `/v1/liquidations` is expected to return 403 in this scope.

## M5 candidate promotion — 2026-09-21 (current non-production state)

The candidate-bound smoke, deposit, and stock-sale proofs passed, including
receipt-backed approval evidence for the deployed nonstandard QA B20 and
block-pinned settlement balances. The public manifest was promoted with
`productionEligible: false`; the exact transaction hashes and independent
validation record are in the testing document.

Remaining gates are intentionally separate: Base mainnet deployment, funded
facilities, external provider/canonical venue evidence, and additional headed
wallet extension evidence. None is implied by this Sepolia candidate.

## Historical M5 rollout checkpoint — 2026-09-18 (superseded)

This checkpoint recorded zero native Sepolia USDC for the disposable accounts,
missing LP credentials, no stock-sale proof, and incomplete headed MetaMask
setup. Those were pre-promotion blockers at that time; the candidate-bound
stock-sale and promotion gates passed on 2026-09-21. Headed extension evidence
is still separately incomplete and is not claimed by the current candidate.

## Database Migrations

- Mongo collections for public RFQs, bid metadata (not a public losing ladder), SIWE sessions, indexer cursors
- Forward-only migrations with backup before Sepolia→mainnet cut
- Rollback: restore snapshot; chain state is not migrated through Mongo

## Secrets Management

- RPC URLs and Mongo URIs in the host secret store
- No settlement private key
- Playwright QA accounts stay uncommitted
- Rotate bot API keys independently of contract guardians

### Public evidence endpoint artifacts

The API reads two optional files from `KATON_BASE_EVIDENCE_DIR`:

```text
<KATON_BASE_EVIDENCE_DIR>/evidence/provider-gates.json
<KATON_BASE_EVIDENCE_DIR>/sepolia/redemption-proof.json
```

For a deployment image or mounted volume, copy only those required evidence
artifacts into this tree and set `KATON_BASE_EVIDENCE_DIR` to its absolute path
in the API container. The local default is `./output/base-qa`, resolved from
the API process working directory. Missing files remain unavailable in
`GET /v1/evidence`; they do not block API startup. The endpoint projects a
fixed set of status, block, response-hash, receipt, and realized-P/L fields, so
provider response bodies, CoW signatures, and other source artifact fields are
never returned.

## Rollback Plan

- Triggers: oracle fail-open, B20 policy miss, unexpected fee, custody of funds by the API, venue bytecode mismatch, liquidation gate drift
- Steps: pause router/facilities, freeze API rank endpoint, announce status, patch, re-verify swap/facility/release-gate tests before unpause
- Mainnet rollback never includes "skip Sepolia and hotfix live"
