# Katon

**Sealed size. Atomic settlement.**

A confidential RFQ exchange for RWA issuers on [Flare](https://flare.network). You request a block of liquidity without posting a public book. Liquidity providers bid inside Flare Confidential Compute. One typed route clears on-chain.

**Live demo:** [katon-azure.vercel.app](https://katon-azure.vercel.app)  
**Network:** Flare Coston2 (chain 114)  
**Status:** Working testnet demo. Simulated TEEs (`SIMULATED_TEE=true`), not Confidential Space. Not audited. Do not use with real funds.

---

## Description

Public AMMs are the wrong venue for issuer-sized flow. A large redeem walks the pool, advertises remaining inventory, and lets everyone else trade first. A handshake plus two transfers is not atomic — one side can walk.

Katon keeps the request private, collects sealed bids, and settles once:

```
Issuer RFQ  →  encrypted bids in FCC  →  2-of-3 submitFccResult
                                           ↓
                              FTSO snapshot + eligibility + fee
                                           ↓
                         RFQRouter.executeSwapRoute  (Coston2)
```

| Role | Route | What they do |
|---|---|---|
| Issuer / taker | `/swap` | Immediate or scheduled liquidity |
| Issuer + LPs | `/auctions` | Create an RFQ, submit encrypted bids, finalize |
| LP | `/standing-bids` | Resting capacity the matcher can use as a route leg |
| Anyone connected | `/dashboard` | Balances and recent activity |
| Curator / LP | `/facility` | Facility positions and withdrawals |
| Keeper / curator | `/liquidations` | Typed venue routes (adapters off until official addresses exist) |
| Policy admin | `/curator` | Eligibility and adapter policy |

Protocol fee is **50 bps** on the receive asset.

The hosted demo is the **web app**. The full auction loop (create → encrypted bid → finalize → FCC dispatch) needs the local `flare-api` process. Browser “Sign and submit” follows the demo-router path. The live FCC settle was script-signed and is shown in the UI as proof.

---

## Motivation

Tokenized funds and RWA issuers need block liquidity. They cannot leak size on a public book, and they cannot accept a two-step settlement where the other side disappears.

Flare is the right substrate for that desk:

- **FCC** holds sealed bids until a 2-of-3 quorum posts `submitFccResult`
- **FTSO** refuses a stale price before `executeSwapRoute`
- **FDC** can attach a NAV proof to an issuer-attested fund
- Settlement is one Cancun contract call on Coston2, not a chat thread

Katon exists to prove that stack end to end: issuer desk, blind relay, Go matcher inside the official FCC extension, and an isolated Coston2 router that will not fill without the quorum verifier.

---

## Quick Start

Need **Node 20.19+** (`.nvmrc` is `24.10.0`). Foundry and Go are only required for contract / matcher tests.

```bash
git clone https://github.com/mangekyou-labs/katon.git
cd katon
npm ci

# Typecheck + unit tests
npm run typecheck:flare
npm run test:flare

# Web app → http://127.0.0.1:5173
npm run dev:flare
```

Optional local relay (ciphertext + metadata only — no plaintext bids):

```bash
npm run dev:flare-api
```

Copy `.env.example` to `.env` only if you run wallet QA. Never put a real seed phrase in that file.

### Wallet

1. MetaMask → add **Flare Coston2**: RPC `https://coston2-api.flare.network/ext/C/rpc`, chain id **114**, symbol **C2FLR**.
2. Get test C2FLR from the official Coston2 faucet.
3. Demo assets are the mock RWA / USDX addresses below, not mainnet tokens.

---

## Usage

### Hosted app

Open [https://katon-azure.vercel.app](https://katon-azure.vercel.app). Walk `/swap`, `/auctions`, `/standing-bids`, `/dashboard`, `/facility`, `/liquidations`, and `/curator`.

Unbundled runtime config lives at [`/runtime-config.js`](https://katon-azure.vercel.app/runtime-config.js). It pins the live isolated router, FCC sender, and extension id so addresses can change without a rebuild.

The team alias `katon-gadillacers-projects.vercel.app` is behind Vercel SSO. Use `katon-azure.vercel.app`.

A “Read model: Failed to fetch” banner on the hosted demo is expected: Vercel serves the SPA only. Start `npm run dev:flare-api` locally if you want the auction read model.

### Commands

| Command | Purpose |
|---|---|
| `npm run dev:flare` | Vite SPA (`apps/flare-web`) |
| `npm run build:flare-web` | Production bundle → `dist/flare-web` |
| `npm run test:flare` | Vitest suites for core, SDK, API, UI |
| `npm run typecheck:flare` | `tsc -p tsconfig.flare.json --noEmit` |
| `forge test --root contracts/flare` | Solidity tests (Foundry, Cancun) |
| `npm run smoke:flare:coston2` | Read-only Coston2 smoke |
| `npm run settle:flare:fcc:coston2` | Operator live FCC settle (needs funded keys) |

### How Flare is used

| Primitive | What we call | Where |
|---|---|---|
| **FCC** (extension **66283**, quorum 2 of 3) | `dispatchConfidential` + three `submitFccResult` + `executeSwapRoute` gated on `fccQuorumVerifier` | Isolated router `0xb136b8a1…`, sender `0x55aA4F40…` |
| **FTSO** | `FtsoRiskGuard` freshness / max-age 256 | `0xe1ca72b7…` |
| **FDC** | `NavProofRegistry` wired to official FDC verification `0x906507E0…` | NAV request + voting-round proof on Coston2 |
| **Contract Registry / TEE manager** | Official Coston2 `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` | Extension + machine registration |
| **FAssets / venues** | Adapter interfaces exist | **Disabled** until official Coston2 venue addresses exist |

EIP-712 typed-data domain and version are pinned by golden vectors in `fixtures/flare/`. Do not rename them — every signed bid and order would break.

### Live Coston2 addresses

Isolated FCC path (what the demo loads from `/runtime-config.js`):

| Piece | Address | Notes |
|---|---|---|
| RFQRouter (isolated) | [`0xb136b8a143bF358Ae7976ED558BBB054fd13faE9`](https://coston2-explorer.flare.network/address/0xb136b8a143bF358Ae7976ED558BBB054fd13faE9) | `fccQuorumVerifier` = sender below |
| ConfidentialRFQInstructionSender | [`0x55aA4F400f3819498eD4Cbe120839E609f0897F3`](https://coston2-explorer.flare.network/address/0x55aA4F400f3819498eD4Cbe120839E609f0897F3) | Extension **66283**, quorum 2 |
| RFQSettlement | [`0x6dc51b3ef4eea9d7b0609381491e00abf3720674`](https://coston2-explorer.flare.network/address/0x6dc51b3ef4eea9d7b0609381491e00abf3720674) | Shared settlement |
| EligibilityRegistry | `0x040b49f3408267fbf95f048e6bb7a5b09e830fac` | |
| FacilityAggregator | `0x9f120294475039166d665d8f226737acd7b96c7d` | |
| NavProofRegistry | `0x792d6e3ecd9541bcf7bf31273f42bf41b758b02a` | FDC NAV |
| FtsoRiskGuard | `0xe1ca72b7397c361c6fc4100fa33b999681205094` | FTSO freshness |
| LiquidityFacility (mock) | `0xd4a4AD10f85a017EfB1ff3b2739cA2313fb248e2` | Demo facility, not a verified venue |
| Mock RWA | `0xdeca491298a0e9f00d87d0390565cc33b3ac336f` | Test token |
| Mock USDX | `0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0` | Test token |

Do **not** use the legacy router `0x59309570…`, the browser proxy candidate `0x7fA18179…`, or extension **66280**. Manifests live in `contracts/flare/deployments/`.

Recent confidential swap (script path, 2026-08-14):

| Field | Value |
|---|---|
| Swap tx | [`0x927fc6be3a9c0ecf159c063930b89bc5a0111aa63c079a8a865b964a19842b63`](https://coston2-explorer.flare.network/tx/0x927fc6be3a9c0ecf159c063930b89bc5a0111aa63c079a8a865b964a19842b63) |
| Block | 34063162 |
| Dispatch | `0xb5489f35318eaca14ab1dd347f05cd76a8bd882348485a64ea665366ed5d28f0` |
| Selected route hash | `0xdb5fab2f0e0c0fd9e0cd841a218fa5844f2e32f7588089a372a5df4e71241a49` |

### What is live vs simulated

| Claim | Reality |
|---|---|
| Contracts on Coston2 | Yes. Isolated router + sender + settlement are deployed. |
| FCC extension 66283, 2-of-3 `submitFccResult` | Yes, live on Coston2. Three registered machines. |
| Confidential Space / hardware attestation | **No.** Render TEEs run with `SIMULATED_TEE=true`. |
| Browser MetaMask `executeSwapRoute` | **No.** Live settle is `npm run settle:flare:fcc:coston2`. The UI displays that proof. |
| Hosted full auction matcher | **No.** Vercel serves the SPA only. `apps/flare-api` is a long-lived Node process. |
| Official Morpho / Kinetic / FAsset venues | **No.** Adapters stay off until official Coston2 addresses exist. |
| Paid FDC credentials | **No.** Public testnet verifier only. |
| Songbird / Flare Mainnet | **No.** |
| Users, pilots, revenue | **None.** Internal QA and Coston2 script evidence only. |

Free-tier Render TEE proxies sleep. Do not restart them (a restart mints a new TEE identity). Wake them with `npm run wake:flare:fcc` if you have the operator env.

### Repository map

```
apps/flare-web/          React desk
apps/flare-api/          Blind relay (ciphertext + metadata only)
packages/flare-core/     Matching, envelopes, oracles, canonical typed data
packages/flare-sdk/      Unsigned Coston2 txs
packages/flare-contracts/Deployment manifests
contracts/flare/         Cancun Solidity: router, settlement, FCC sender, FTSO, FDC NAV
services/fcc-matcher/    Deterministic Go matcher
docs/hackathon/          Pitch deck and DoraHacks field pack
fixtures/flare/          Golden vectors (do not edit)
```

### Next

1. Hardware Confidential Space TEEs and real attestation
2. MetaMask-signed `executeSwapRoute` from the dApp
3. Official Coston2 / Songbird venue adapters once addresses exist
4. Paid FDC NAV for issuer-attested funds
5. Invite-only issuer pilot, then Songbird, then Flare Mainnet

---

## Contributing

This is a public testnet demo, not a production protocol. PRs that tighten the FCC path, the desk, or the honesty of the docs are welcome.

1. Fork [mangekyou-labs/katon](https://github.com/mangekyou-labs/katon) and work on a feature branch.
2. `npm ci`, then `npm run typecheck:flare` and `npm run test:flare`.
3. Do not commit `.env*`, `demo-keys.json`, filled FCC proxy configs, indexer credentials, or `.vercel/`.
4. Do not change the pinned EIP-712 domain in `fixtures/flare/` unless you are deliberately rotating signatures and updating every golden vector.
5. Open a pull request with what changed and how you verified it.

MIT. See `LICENSE`.

Not audited. Simulated TEEs. Coston2 only. No real funds.
