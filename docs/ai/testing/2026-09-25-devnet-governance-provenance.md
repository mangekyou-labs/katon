---
phase: testing
title: Devnet governance and executable provenance observation
feature: solana-tokenized-stock-desk
status: open-evidence-gates
date: 2026-09-25
---

# Devnet governance and executable provenance observation

This is read-only Devnet evidence for
[issue #19](https://github.com/mangekyou-labs/katon/issues/19) and
[issue #20](https://github.com/mangekyou-labs/katon/issues/20). No Devnet
transaction was simulated or sent by these inspection commands. This document
does not certify a deployment or authorize enablement.

## Squads v4 executable observed on Devnet

The Squads Program and ProgramData accounts were read together through
`getMultipleAccountsInfoAndContext` at confirmed slot `503926524`:

| Field | Observed value |
| --- | --- |
| Cluster | Devnet (`https://api.devnet.solana.com`) |
| Program | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| ProgramData | `Fy3YMJCvwbAXUgUM5b91ucUVA3jYzwWLHL3MwBqKsh8n` |
| Loader owner | `BPFLoaderUpgradeab1e11111111111111111111111` |
| Upgrade authority | `HM5y4mz3Bt9JY9mr1hkyhnvqxSH4H2u2451j7Hc2dtvK` |
| Last deployed slot | `446638068` |
| ProgramData size | `1774845` bytes, including loader header |
| Executable length | `1774800` bytes |
| Raw executable SHA-256 | `97fb2a5c08e5df5e862d8354ac5b97d3587117f98c4457754ca12e30bef0664d` |
| `solana-verify get-program-hash` | `57a8d2d7ef5409df250415135f29f83da876e5adf5a2e5b5752e323cfb4f2f74` |
| `solana-verify get-executable-hash` on downloaded executable | Same `57a8d2d7ef5409df250415135f29f83da876e5adf5a2e5b5752e323cfb4f2f74` |
| Verifier used for fresh hash query | `solana-verify 0.5.2`; installed tool SHA-256 `c949f2d0983b24710939721e6d011c38c5f136501e3f9ab56791b27458e7da0e` |

`solana-verify list-program-pdas` returned **no verification PDAs** for this
program on Devnet. That query provides no official Devnet source revision.

## Official source candidate comparison

The previously recorded official source build at
[`64af7330413d5c85cbbccfd8c27a05d45b6e666f`](https://github.com/Squads-Protocol/v4/tree/64af7330413d5c85cbbccfd8c27a05d45b6e666f)
used the Squads repository, Anchor CLI `0.29.0`, `solana-verify 0.5.2`, and
`solanafoundation/solana-verifiable-build:1.18.16` image digest
`sha256:1388b6e423013b0a4a1b67b3481b1c35f5a13034af97d9059439d923c19f1c87`
(`linux/amd64`). Its reproducible executable hash was
`d48660833989ecea3145ff726164fe640bd90696f03ce00dfd0cda258cbf2fac`; raw
`.so` SHA-256 was
`ae9587376b1d5febf83f558b87ed876cdd4bdcc9ad877f257992287fb09d0b11`. Neither
hash matches the current Devnet Squads executable. The prior build's verifier
binary SHA-256 was
`11d5a8316cb4fac9c78c06345bca0052e4020dfafcbb4a52156c0c0c42c543ce`.

The official current source revision
`af94153ff77a28b6effe46b9c94baaa93742b48c` was previously inspected, but its
Cargo lockfile version prevented that pinned-image build from producing an
executable. This turn refreshed the live hash and account identity; it did not
rebuild either source candidate. The Docker daemon was unavailable
(`docker image inspect` returned “Cannot connect to the Docker daemon”), so no
new build under the pinned image was possible. Do not treat the prior
non-matching build or the current source checkout as Devnet provenance.

The verified result is a provenance gap: the current executable is identified
by account address and hash, but its official source revision and complete
build inputs remain unknown. Governance must not rely on this Squads binary for
an enablement claim until a matching build or verified alternate provenance
establishes which code controls the vault. Issue #19 remains open.

## RFQ program and delayed-action state

The current RFQ Program and ProgramData, plus governance and maker-registry
PDAs, were read together at confirmed slot `503926524`:

| Field | Observed value |
| --- | --- |
| RFQ program | `J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib` |
| ProgramData | `tb4nZHmJkiVLozmxVwX2LKQj52vQZor8fVgMYZsb7aj` |
| Upgrade authority | `8LmRZFAUJxxXpDXKUPH9B5J3dzDvePQJDPHDP1FNLJgf` |
| Last deployed slot | `502828531` |
| Executable length | `563688` bytes |
| Raw executable SHA-256 | `b2b964780396e69be8070e63d6ccd6591fa417cc8e6e19409207feea249d372d` |
| `solana-verify get-program-hash` | `bf28a0054a568f31fff2ac45d4786274412c083f44c4049e9f82853f5671025b` |
| GovernanceConfig PDA | `EzXW2sNUnbnzzNWk6HeyKxWSgVb1juwM2D8G1tsGPzBf` — absent |
| MakerRegistry PDA | `3BN1JorBwmcpGk8XHgHsvWUkZgXt6iMAj3wDzeMoFxYL` — absent |
| QueuedGovernanceAction accounts | `0` |
| QueuedGovernanceChange accounts | `0` |

The checkout's current `contracts/solana-rfq/target/deploy/solana_rfq.so`
has normalized executable hash
`d227a1fa3797c73ad2e6148400d93efe451a52b14a640e99351d235230f263e4` and raw
SHA-256
`2f7a6437ade5f57f24c653d8a0f2074d75b63a9115fa403798ee414f32483784`. It does
not match the observed Devnet RFQ executable hash or size. This local artifact
is not a reproducible provenance claim for Devnet.

Because the deployed Devnet RFQ code has not been matched to this source and
there is no initialized governance account, maker registry, or queued action,
there is no live state to bind to the evidence bundle or use to prove delayed
application. No source/surface enablement is observed. The absence of those
accounts is a concrete blocker for issue #20; it is not evidence that a mock or
local validator run happened on Devnet.

## Local evidence and remaining gates

Local checks remain separate evidence: the 0.1 AAPLx TEST Seller journey and
RPC reconciliation are in
[`2026-09-25-feature-solana-seller-settlement.md`](2026-09-25-feature-solana-seller-settlement.md),
and local governance delay behavior passed 14 unit and 17 LiteSVM tests. Local
results do not supply Devnet program provenance, production fork/operations/
runtime evidence, a signed policy-scoped bundle, independent review, or an
observed delayed Squads action.

Issue #20 remains open. The evidence inventory is being prepared as an
**unsigned draft only**. No independent reviewer or authorized Squads
signatures are present, no exact bundle hash is queued, and no enablement action
has been applied. Seller Desk enablement, Mainnet execution, and Liquidation
Execution remain unclaimed.
