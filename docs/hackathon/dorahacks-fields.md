# DoraHacks — Flare Summer Signal field pack

Paste these into the BUIDL. Do not invent extra traction. Demo URL is the public Vercel production alias.

Today: 2026-08-15. If the DoraHacks form is locked after 2026-08-14 19:59, paste this into comments / an update, or send it to organizers.

---

## Project name

Katon Finance

## Selected bounty or bounties

1. **Confidential Compute** (primary) — sealed RFQ matching inside FCC extension 66283, 2-of-3 `submitFccResult`, `executeSwapRoute` gated on the FCC quorum verifier.
2. **Interoperable Asset Products** — RWA issuer desk that binds FTSO freshness, FDC NAV proofs, eligibility, and (interfaces only) FAsset / venue adapters.

## Short product description

Katon is a confidential RFQ exchange for RWA issuers on Flare. Issuers request size without a public order book. Liquidity providers bid inside Flare Confidential Compute. A 2-of-3 TEE quorum, an FTSO snapshot, and a typed route hash unlock one atomic Coston2 settlement.

## Target user

Primary: RWA issuers and tokenized-fund managers who need block-sized liquidity without leaking inventory.  
Secondary: professional LPs who will quote sealed bids, and curators who set eligibility policy.

## Demo link, video, or working app link

**Web app (Coston2 UI):** https://katon-azure.vercel.app

**What the hosted demo shows:** wallet connect, all seven routes, runtime-config addresses, and display of the live FCC settle proof.

**What it does not do in the browser:** MetaMask-signed `executeSwapRoute`. That live settle is the script path below.

**On-chain proof (Coston2 explorer):**  
https://coston2-explorer.flare.network/tx/0x927fc6be3a9c0ecf159c063930b89bc5a0111aa63c079a8a865b964a19842b63

**Pitch deck:** `docs/hackathon/Katon-Finance-Flare-Summer-Signal.pptx` in the repo.

## GitHub repo or technical materials

https://github.com/mangekyou-labs/katon

Start with the root `README.md`. Contract manifests:

- `contracts/flare/deployments/coston2-fcc-router.json`
- `contracts/flare/deployments/coston2-fcc-sender.json`
- `apps/flare-web/public/runtime-config.js`

## Explanation of how the project uses Flare

Katon is built on Flare primitives, not a generic EVM port:

- **FCC:** dedicated extension **66283**. `ConfidentialRFQInstructionSender.dispatchConfidential` fans the sealed auction to three registered machines. Each machine submits `submitFccResult`. Quorum is 2. `RFQRouter` will not `executeSwapRoute` unless `fccQuorumVerifier` (the same sender) reports ready.
- **FTSO:** `FtsoRiskGuard` requires a fresh price snapshot (max age 256) before the route can settle.
- **FDC:** `NavProofRegistry` is configured against official Coston2 FDC verification (`0x906507E0…`). A public-testnet NAV request and voting-round proof were recorded in `coston2.json`.
- **Contract Registry / TEE manager:** machines and the extension are registered on `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`.
- **FAssets / external venues:** adapter interfaces exist; they stay disconnected until official Coston2 addresses exist.

Network: **Coston2 only** (chain 114).

## Explanation of what was newly built, ported, integrated, or improved

Before this program the product was TrustRFQ: a Stellar/Soroban peer-to-peer OTC desk.

During Flare Summer Signal we built Katon on Flare:

- New Cancun Solidity stack: RFQRouter, RFQSettlement, EligibilityRegistry, FacilityAggregator, FtsoRiskGuard, NavProofRegistry, ConfidentialRFQInstructionSender.
- Isolated Coston2 router `0xb136b8a1…` bound to FCC sender `0x55aA4F40…`.
- Go matcher ported into the official FCC extension handler (`RFQ` / `BID` / `MATCH`).
- Three-recipient envelopes and live 2-of-3 `submitFccResult` → `executeSwapRoute`.
- React issuer/LP/curator desk (`apps/flare-web`) and a blind relay (`apps/flare-api`) that refuses plaintext bids.
- FTSO freshness and FDC NAV wiring on Coston2.

The EIP-712 domain name remains `TrustRFQ` / `1` so signed-typehashes stay stable.

## Smart contract addresses or relevant deployment details

See the README table. Short list for the form:

- Isolated RFQRouter: `0xb136b8a143bF358Ae7976ED558BBB054fd13faE9`
- FCC instruction sender: `0x55aA4F400f3819498eD4Cbe120839E609f0897F3`
- RFQSettlement: `0x6dc51b3ef4eea9d7b0609381491e00abf3720674`
- Extension id: `66283` (quorum 2)
- Latest confidential swap: `0x927fc6be3a9c0ecf159c063930b89bc5a0111aa63c079a8a865b964a19842b63` (block 34063162)

Do not submit the legacy router `0x59309570…` or proxy candidate `0x7fA18179…`.

## Short roadmap or next steps

1. Move TEEs from `SIMULATED_TEE=true` to Confidential Space with real attestation.
2. Browser-signed confidential `executeSwapRoute` (MetaMask), not only the operator script.
3. Turn on official venue / FAsset adapters when Coston2 addresses are published.
4. Paid FDC NAV for issuer-attested funds.
5. Invite-only issuer pilot → Songbird → Flare Mainnet.

---

## Encouraged fields (honest)

### Network deployed

**Coston2.** Not Songbird. Not Flare Mainnet.

### User acquisition, distribution, testing, feedback

Internal QA only: Vitest, Foundry, scripted Coston2 smokes, and a headed Playwright walk that displays the live proof hashes. No public users.

### Early usage, community, pilots, partners, traction

None to report. No pilots, no partner LOIs, no volume. The signal is technical: a live 2-of-3 FCC settle on Coston2 and a judge-reproducible UI.

### TEE honesty sentence (use this wording)

Render FCC workers are registered on extension 66283 and completed a live 2-of-3 `submitFccResult` settle, but they run `SIMULATED_TEE=true` (not Confidential Space). Treat them as protocol-complete on Coston2, not as hardware-attested production TEEs.
