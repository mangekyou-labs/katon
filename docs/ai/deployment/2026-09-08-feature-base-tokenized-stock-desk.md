---
phase: deployment
title: Katon Base Tokenized Stock Desk Deployment Strategy
description: Environment boundaries, Sepolia-first release gates, and rollback
feature: base-tokenized-stock-desk
status: m5-gate-blocked
---

# Deployment Strategy

No production deploy in the requirements phase. This file records the intended boundary so implementation does not skip gates.

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
targeted Vitest checks plus both fixed-target cleanup commands. No Sepolia
deployment receipt or M-6 claim exists at this stage.

The M5 continuation keeps the hard safety gate before RPC/client creation and
before deployment: `assertNonstandardQaWallet` rejects the three standard Anvil
mnemonic addresses with `BASE_QA_STANDARD_WALLET_FORBIDDEN`. The configured
Sepolia wallet passes the nonstandard-address check and the RPC/chain preflight,
but all three derived QA accounts currently report zero native Sepolia USDC
with a 1,000,000-unit funding deficit. The candidate deployment and existing
smoke/deposit evidence remain candidate-only; no stock-sale transaction was
submitted. Fund the disposable accounts, configure the normal LP bot
credential, then run the stock-sale canary and headed wallet flow before
promotion. Base mainnet remains prohibited.

## M5 rollout checkpoint — 2026-09-18

The candidate digest and deployed bytecode still match, so no redeployment was
needed. `qa:base:validate -- --target=sepolia` passes the chain and wallet
shape checks, while the funding report shows zero native Sepolia USDC for the
disposable depositor and LP accounts. `qa:base:swap` fails closed at
`BASE_QA_LP_BOT_CREDENTIALS` and the promotion command fails closed at
`BASE_QA_SWAP_PROOF_REQUIRED`. The required proof is intentionally absent
rather than synthesized. The extension setup reached the MetaMask 13.17.0
download step but could not complete in this environment, so there is no
headed MetaMask transaction/UI evidence to claim.

## Database Migrations

- Mongo collections for public RFQs, bid metadata (not a public losing ladder), SIWE sessions, indexer cursors
- Forward-only migrations with backup before Sepolia→mainnet cut
- Rollback: restore snapshot; chain state is not migrated through Mongo

## Secrets Management

- RPC URLs and Mongo URIs in the host secret store
- No settlement private key
- Playwright QA accounts stay uncommitted
- Rotate bot API keys independently of contract guardians

## Rollback Plan

- Triggers: oracle fail-open, B20 policy miss, unexpected fee, custody of funds by the API, venue bytecode mismatch, liquidation gate drift
- Steps: pause router/facilities, freeze API rank endpoint, announce status, patch, re-verify swap/facility/release-gate tests before unpause
- Mainnet rollback never includes "skip Sepolia and hotfix live"
