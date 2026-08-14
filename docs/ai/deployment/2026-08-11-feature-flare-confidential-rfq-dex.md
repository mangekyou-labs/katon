---
phase: deployment
title: Flare Confidential RFQ DEX Deployment Strategy
description: Environment boundaries, release gates, and rollback procedures
feature: flare-confidential-rfq-dex
status: in-progress
---

# Deployment Strategy

## Current local artifacts

- `apps/flare-web` builds to `dist/flare-web` with a CSP-safe Vite bundle.
- `contracts/flare` compiles for Cancun through Foundry.
- `services/fcc-matcher` is a separately versioned Go module.
- `infra/` is the deployment boundary; no production credentials or addresses
  are checked in.

## Coston2 core deployment — 2026-08-12

The hardened Flare core contracts were deployed from the funded testnet
deployer and wired through the public manifest at
`contracts/flare/deployments/coston2.json`. This is a non-production
deployment: mock assets and a test eligibility policy are enabled, but no
venue adapters, FCC attestation, or real user funds are enabled.

- EligibilityRegistry: `0x040b49f3408267fbf95f048e6bb7a5b09e830fac`
- RFQRouter: `0x593095709e16275cc0b8aa0ef908fd13d693c36c`
- RFQSettlement: `0x6dc51b3ef4eea9d7b0609381491e00abf3720674`
- InstructionSender: `0x6b97db10f053e384bd6d4acb22d3f5851040310`
- FacilityAggregator: `0x9f120294475039166d665d8f226737acd7b96c7d`
- NavProofRegistry (FDC-configured): `0x792d6e3ecd9541bcf7bf31273f42bf41b758b02a`
- FtsoRiskGuard: `0xe1ca72b7397c361c6fc4100fa33b999681205094`

The mock Coston2 integration fixture is also recorded in the manifest: RWA
`0xdeca491298a0e9f00d87d0390565cc33b3ac336f`, USDX
`0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0`, and fixed-output source
`0x29713643c62c6743a5bf68e39ac1de8eaec0bc97`. The hardened Registry exposes a
two-day policy delay. The minimum-value typed swap completed in transaction
`0x314611dbf70d2609ef18298308db98a06583994511fb3cba3dbfa62e6cd629b4` with
exact 1-RWA and 1,000-USDX balance deltas.

## Transparent proxy candidate — 2026-08-12

`contracts/flare/deployments/coston2-proxy-candidate.json` records the fresh
guardian-enabled transparent-proxy candidate. Its seven coordination-facing
addresses are the candidate addresses consumed by `packages/flare-contracts`;
the historical direct deployment remains in `coston2.json` for mock-funding and
migration tooling. The candidate has a two-day `GovernanceTimelock`, with the
funded deployer still acting as bootstrap proposer, executor, and guardian. It
has not been promoted to production governance.

- EligibilityRegistry: `0x9D1Ce80e382102674CEf721C674CD6f205cD0DcD`
- RFQRouter: `0x7fA1817951dE405a0c466696052cF50Eba409333`
- RFQSettlement: `0xD19daEB89ad906557e4AD4FE7D23068B49BD6F2F`
- InstructionSender: `0xC018A20d1694ed588320758529bc55b56e2beA60`
- FacilityAggregator: `0x0de3d0392C4F0e06F4f50D24Cb98Bd85bFE41446`
- NavProofRegistry: `0x1de19aF3FD9B609F6087a0972442895B2d6DE2AE`
- FtsoRiskGuard: `0xcfC765f1A6B9eEb28Cb7017A4F8E05f05b0fF0a8`
- ProxyAdmin: `0x69fB8903044285547015E8332a408C97f8eE9ca5`
- GovernanceTimelock: `0x56E3778CbE591E590A4c86717127D8D7BBDB1f89`
- Bootstrap guardian: `0xeD37FD0d6F0f69236E7472B36796e133D20EcC32`

The candidate is marked `contractRevision: guardian-pause-v1`. Guardian
bindings were set during deployment and the expanded Coston2 smoke verifies
all seven guarded proxies. The bootstrap guardian is intentionally not a
production guardian: a dedicated pause-only address, multisig proposer/
executor, immutable facility/adapter registry, and independent review are still
required.

The live Coston2 Contract Registry resolves `FdcVerification`, `FdcHub`,
`FdcRequestFeeConfigurations`, and `FlareSystemsManager`. FCC registry lookups
for `TeeExtensionRegistry` and `TeeMachineRegistry` currently return the zero
address, so FCC registration/attestation remains an external FCC scaffold and
Confidential Space operation gate.

## Free-tier Render three-TEE (wake-first demo only) — 2026-08-14

Repo-root `render.yaml` defines three isolated free Web Services:
`trustrfq-tee-a`, `trustrfq-tee-b`, `trustrfq-tee-c`. Each builds
`third_party/fcc-extension-scaffold/Dockerfile.render` (Redis + tee-proxy +
simulated TEE in one container). This is **not** always-on FCC.

Deployed 2026-08-14 via Render API (`POST /services`, workspace
`tea-cspsq3ggph6c73f4ln6g`, region singapore, plan free). GitHub
`acakbin1881/TrustRFQ` is read-only from this machine, so the Docker context
was pushed to public `https://github.com/MrSufferer/trustrfq-fcc-tees`
branch `feature-flare-confidential-rfq-dex` (commit `24d65f8`). Secrets were
set as service env vars from ignored `.env.fcc.local` and were not committed.

| Service | Render id | Public `/info` | Initial deploy |
|---|---|---|---|
| trustrfq-tee-a | `srv-d9vi3pojo6nc73fvdss0` | https://trustrfq-tee-a.onrender.com/info | `dep-d9vi3q8jo6nc73fvdtp0` live |
| trustrfq-tee-b | `srv-d9vi3qht0dsc73d7a6p0` | https://trustrfq-tee-b.onrender.com/info | `dep-d9vi3r1t0dsc73d7a8ng` live |
| trustrfq-tee-c | `srv-d9vi3rbl550s738m7atg` | https://trustrfq-tee-c.onrender.com/info | `dep-d9vi3rrl550s738m7bl0` live |

`npm run wake:flare:fcc` against those three URLs returned
`fcc-wake=PASS count=3` with HTTP 200. Each `/info` is official FCC JSON
(`teeInfo.publicKey`, `machineData`, signatures). The three public-key
fingerprints are distinct. `chainId` is 114.

As of 2026-08-14 the live TrustRFQ FCC path is **extension 66283**
(`0x…0102eb`) bound to sender `0x55aA4F400f3819498eD4Cbe120839E609f0897F3`
(manifest `contracts/flare/deployments/coston2-fcc-sender.json`). Render
`EXTENSION_ID` is `0x…0102eb`. PRODUCTION machines (status 2):
A `0x09131744…` / B `0x9A25Bf3A…` / C `0xE70A3D59…`.
Extension 66280 + legacy sender `0x6b97db10…` are retired for
`submitFccResult` (missing selectors). Do not `configureFcc` again on
either sender.

Wake immediately before any register or dispatch:

```bash
FCC_PROXY_INFO_URLS='https://trustrfq-tee-a.onrender.com/info,https://trustrfq-tee-b.onrender.com/info,https://trustrfq-tee-c.onrender.com/info' npm run wake:flare:fcc
```

Free-tier services sleep after idle. A cold FTDC poll can miss delivery; that
is a stop-and-report, not a 1-TEE fallback.

Rotate the Render API key that was pasted in chat; it was used only as an
in-memory `Authorization: Bearer` header and was not written to git.

## Environment separation

| Environment | Chain | FCC | Assets / proof sources |
|---|---:|---|---|
| local | 31337 | simulated only | local mocks |
| Coston2 | 114 | reduced assurance or real extension when available | test assets, deployment-time registry |
| Flare | 14 | real attestation and 2-of-3 quorum required | verified deployment-time registry and issuer configuration |

The FDC-backed NAV registry was redeployed and configured on Coston2 after its
request-policy hardening. Its `FdcVerification` address is resolved from the
live Flare Contract Registry and the deployment/configuration hashes are
recorded in the manifest. Typed proof submission remains credential-gated until
a live Web2Json proof and an owner-configured fixed request policy are supplied.

The web bundle may contain public RPC/API configuration only. API, indexer,
keeper, broker, verifier, KMS, and FCC secrets belong in managed secret stores.

## Release gates

1. Run `npm ci`, `npm test`, `npm run typecheck:flare`, `npm run build`,
   `npm run build:flare-web`, `npm run test:go`, `forge test --root
   contracts/flare`, and the existing Soroban suite.
2. Verify contract bytecode, ABI, Cancun target, registry-resolved system
   interfaces, and deployment transaction parameters from the intended network.
3. On Coston2, exercise wallet approval/sign/submit/confirmation plus FDC and
   FTSO proof paths with test assets.
4. Before mainnet, require real FCC `/info` evidence, reproducible code hashes,
   2-of-3 failure injection, external contract/FCC review, load report, and
   multisig/timelock sign-off.

## Rollback

Frontend releases roll back to the previous immutable static asset version.
Coordination services stop accepting new auctions, drain ciphertext queues,
and replay the indexer from the last safe cursor. Contract incidents use the
guardian pause boundary; guardian authority cannot upgrade, withdraw, or
redirect user assets. Any upgrade or risk-increasing configuration requires
the reviewed governance path.

## Current blocker

The Coston2 core and mock integration deployment is complete and its read-only
smoke, live registry/feed reads, typed dry-run, and state-changing swap pass.
The proxy candidate smoke and layout checks pass, but the release candidate
remains blocked on production governance handoff, credentialed FDC verifier/DA proofs,
verified venue adapters, real FCC runtime, extension-wallet evidence, managed
load/soak, and external release review. Mainnet still requires real
attestation, audited deployment configuration, multisig/timelock approval, and
the production pilot gate.
