---
phase: testing
title: Public Seller demo closeout
feature: solana-tokenized-stock-desk
status: not-accepted
date: 2026-09-26
---

# Public Seller demo closeout

## Outcome

The public Devnet Seller demo was not accepted. The existing Vercel production
project now serves a static, unavailable Seller shell at
[`https://katon-azure.vercel.app`](https://katon-azure.vercel.app). The page
states that trading is unavailable and that no verified stock is available.
It has no Seller API connection, wallet authorization, quote path, or settlement
path. This is a hosted status page, not a functional Devnet demo. The new
deployment is `dpl_tiQAitbZMkohZh8wWjo9uaMdS6yd` and Vercel reported it `READY`
for production; the deployment-specific URL is
[`katon-jqq2unhhq-gadillacers-projects.vercel.app`](https://katon-jqq2unhhq-gadillacers-projects.vercel.app).

The existing same-origin `/v1/*` rewrite to an API service was not configured
or deployed. No Render API is connected. The deployment therefore does not
satisfy the deployment or human acceptance criteria in [#50](https://github.com/mangekyou-labs/katon/issues/50)
or [#51](https://github.com/mangekyou-labs/katon/issues/51).

## Why acceptance failed

- No issuer-verified stock available for Devnet settlement, and no authorized,
  funded Maker inventory was configured or evidenced. Local AAPLx TEST is a
  synthetic automated fixture, not issuer-backed stock.
- The latest complete RFQ/governance snapshot was read-only at slot `503926524`.
  It found no initialized GovernanceConfig or MakerRegistry and no queued
  governance actions. The observed Devnet RFQ executable did not match the
  checkout artifact. A later refresh found MakerRegistry absent at slot
  `504259691`; RFQ and GovernanceConfig reads timed out, so their refreshed
  states remain unknown. See the detailed [Devnet provenance observation](2026-09-25-devnet-governance-provenance.md)
  and [#45](https://github.com/mangekyou-labs/katon/issues/45). Governance and
  delayed-enablement gates [#19](https://github.com/mangekyou-labs/katon/issues/19)
  and [#20](https://github.com/mangekyou-labs/katon/issues/20) remain open.
- No Devnet transaction or funding action was performed, and no human wallet
  acceptance or receipt reconciliation occurred.
- A fresh read-only local API check returned HTTP `200` with an empty asset
  list (`[]`). Surfpool remained available on its local RPC listener. No
  synthetic asset was made visible to normal product users.

## Changes made

- Synthetic local fixtures require the explicit automated-test opt-in
  `KATON_LOCALNET_TEST_FIXTURE_ASSETS=1`; normal API asset inventory remains
  empty when no verified asset is configured.
- Removed automatic fake wallet funding from the API.
- The local Seller UI filters out non-executable assets and clears stale quote
  state when no executable asset remains. The automated fixture journey opts
  into its synthetic fixture explicitly.
- Non-localhost hosts render a static unavailable shell before mounting the
  wallet and API flow. The shell has no active asset, wallet, quote, or trade
  controls.

## Lessons for the next attempt

1. Verify an issuer-backed asset, its exact cluster mint, and an authorized
   Maker/funding owner before presenting a trading UI as a demo.
2. Confirm the target chain, RPC, governance accounts, and executable
   provenance early; timeouts are unknown state, not evidence of absence.
3. Test one end-to-end vertical slice across the actual hosted UI, API, chain,
   wallet signature, and receipt reconciliation before polishing the broader
   interface.
4. Keep local fixtures, Devnet test configuration, and production release
   gates separate. Give synthetic assets unmistakable test-only labels and
   keep them out of normal asset lists.
5. Reserve an explicit deployment and human-acceptance window. A static site
   deployment alone does not establish a working demo.

## Verification

- `NO_DNA=1 npm test` — 11 test files and 98 tests passed.
- `NO_DNA=1 npm run build` — TypeScript checks passed; Vite built 120 modules.
- `git diff --check` — passed.
- `vercel build --prod --yes --scope gadillacers-projects` — production static
  build completed successfully.
- `vercel inspect katon-azure.vercel.app --scope gadillacers-projects` —
  deployment `dpl_tiQAitbZMkohZh8wWjo9uaMdS6yd`, target `production`, status
  `Ready`, alias `https://katon-azure.vercel.app`.

This closeout does not change the separate product and governance gates in
[#9](https://github.com/mangekyou-labs/katon/issues/9),
[#16](https://github.com/mangekyou-labs/katon/issues/16),
[#19](https://github.com/mangekyou-labs/katon/issues/19), or
[#20](https://github.com/mangekyou-labs/katon/issues/20).
