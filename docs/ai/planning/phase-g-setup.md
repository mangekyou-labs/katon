# Phase G operator setup (T6.4–T6.7)

**Start here if you only want the clicks:** [`admin-only-clicks.md`](./admin-only-clicks.md)

**Worktree:** `.worktrees/feature-flare-confidential-rfq-dex`  
**Secrets:** worktree `.env` only (gitignored via `.env*`). Never commit keys.

Do **not** set `FLARE_GOVERNANCE_STATUS=production-approved` until a human
approves after independent review. Do **not** treat local `npm run soak:flare`
(30s against 127.0.0.1) as a 24h managed soak. Do **not** invent venue or FCC
registry addresses.

Those env vars are not a single TrustRFQ signup. They come from **Flare** (FDC/FCC),
**venue docs** (Morpho/Kinetic/Clearpool), **GCP** (TEEs), and **infra you create**.

Flare smokes **load the worktree `.env`**. Run them from this worktree with no exports.

---

## Agent already did (2026-08-13)

1. Public FDC UUID in `.env`. Smoke: `npm run smoke:flare:fdc-verifier` (loads `.env`).
2. DA key request: https://github.com/flare-foundation/developer-hub/issues/1458 — OPEN, no comments. Do not nag the same day.
3. Venue official-source pass → **stay mocks.** [`venue-research.md`](./venue-research.md)
4. Public FCC extract: [`fixtures/flare/fcc-coston2-public.json`](../../../fixtures/flare/fcc-coston2-public.json). `TeeExtensionRegistry` / `TeeMachineRegistry` are **not** in the Flare scaffold file.
5. Paste-ready Flare ask: [`flare-support-ask.md`](./flare-support-ask.md)
6. Staging compose overlay: [`infra/staging.env.example`](../../../infra/staging.env.example) — `redis://`, **not** production `rediss://`.
7. Local TLS (not prod): `node tools/generate-local-tls.mjs` → gitignored `infra/tls-local/`

## You do these clicks only

| # | Action | Time | Skip for investor demo? |
|---|---|---|---|
| 1 | When #1458 or email gets a key, paste `FLARE_FDC_API_KEY` into `.env` | 2 min | Keep public UUID |
| 2 | Send [`flare-support-ask.md`](./flare-support-ask.md) | 5 min | Yes, if you stay on sim FCC |
| 3 | GCP project + billing (real TEEs) | hours | **Yes** |
| 4 | Atlas **or** stay on compose staging | 10 min | Stay on compose |
| 5 | Safe + guardian + auditor | days | **Yes** |

## Walls I cannot finish

I cannot log into Flare, GCP, Atlas, Telegram, or your wallet. I cannot obtain the indexer MySQL password or paid FDC key. This track does **not** close D/E/F/G by itself.

---

## Status (2026-08-13)

| Step | State |
|---|---|
| Already have | Coston2 `PRIVATE_KEY` + C2FLR, RPC `https://coston2-api.flare.network/ext/C/rpc` (chain 114), local sim RFQ |
| D1 public FDC | **Done.** Public UUID in worktree `.env`. Smoke: `fdc-verifier=PASS` (Web2Json). **Not** paid / not production |
| D2 paid / higher-limit key | **Requested.** https://github.com/flare-foundation/developer-hub/issues/1458 — wait for Flare; they may reply on the issue, email, or [t.me/FlareNetwork](https://t.me/FlareNetwork) |
| E venues | **Researched — stay mocks.** See [`venue-research.md`](./venue-research.md). No official Coston2 Morpho/Kinetic/Clearpool registry. |
| F real FCC | **Public extract only.** [`fcc-coston2-public.json`](../../../fixtures/flare/fcc-coston2-public.json). Still `DEDICATED_EXTENSION_REQUIRED`. Indexer password not obtained. |
| G ops / humans | **Staging overlay only.** `infra/staging.env.example`. Release gates stay BLOCKED. |

This is **not** a production RFQ DEX and does **not** close SC-1–SC-16 or mainnet.

---

## Suggested order

| When | What you do | What you get |
|---|---|---|
| Done | D1 public UUID + smoke | FDC smoke green (not paid/prod) |
| Waiting | D2 GitHub issue #1458 | Higher DA / verifier limits when they reply |
| Next | E1 research only | Official venue URLs **or** stay mocks |
| Next | F1 Flare support + @FlareDevs | Indexer user/pass + confirm registry JSON |
| Parallel | G1–G3 Atlas / Redis / TLS / keeper host | Ops URLs you own |
| After Flare + GCP | F2–F3 three Confidential Space machines + dedicated extension | Real FCC env |
| Last | G4 Safe + auditor | Never self-approve production |

---

## Phase D — FDC

Official: [FDC getting started](https://dev.flare.network/fdc/getting-started) · [Network API resources](https://dev.flare.network/network/overview)

### D1. Public testnet smoke (done)

Flare publishes a **rate-limited public verifier key**. It is **not** a paid production key.

```bash
FLARE_FDC_VERIFIER_URL=https://fdc-verifiers-testnet.flare.network
FLARE_FDC_DA_URL=https://ctn2-data-availability.flare.network
FLARE_FDC_API_KEY=00000000-0000-0000-0000-000000000000
```

Swagger (confirm service is up):  
https://fdc-verifiers-testnet.flare.network/verifier/api-doc  

Coston2 DA docs: https://ctn2-data-availability.flare.network/api-doc  
Mainnet DA (later): https://flr-data-availability.flare.network

Re-run from the worktree (script loads `.env`; no export needed):

```bash
cd .worktrees/feature-flare-confidential-rfq-dex
npm run smoke:flare:fdc-verifier
```

Expect `fdc-verifier=PASS attestation=Web2Json ...`. Header Flare uses: `X-API-KEY`.

### D2. Higher DA rate limits (waiting on Flare)

Template: [API Key Request](https://github.com/flare-foundation/developer-hub/issues/new/choose)  
Filed: https://github.com/flare-foundation/developer-hub/issues/1458  

Their form only allows **Flare Mainnet** or **Songbird** (no Coston2). Issue #1458 selected Mainnet and asked whether Coston2 uses a separate key or the public UUID.

When they send a key:

1. Replace `FLARE_FDC_API_KEY` in worktree `.env` (do not keep the all-zero UUID).
2. Update `FLARE_FDC_VERIFIER_URL` / `FLARE_FDC_DA_URL` if they assign different hosts.
3. Re-run `npm run smoke:flare:fdc-verifier`.

### D3. Production FDC (later)

Public verifiers are for development. Production should run:

- Verifier: https://github.com/flare-foundation/fdc-client
- DA service: https://github.com/flare-foundation/data-availability

Then point the two URLs at **your** hosts and use **your** key.

---

## Phase E — Venues (you cannot buy these)

There is **no** official Morpho/Kinetic/Clearpool Coston2 address list in this repo. Do not invent one.

### E1. Hunt official addresses

1. Protocol docs first — Morpho: https://docs.morpho.org/developers/contracts/addresses/  
   Kinetic / Clearpool: their official Flare deployment pages only if they publish Coston2.
2. Flare ecosystem / builders pages and the protocol’s own GitHub `deployments/`.
3. Coston2 explorer only to **confirm** an address from (1) or (2): https://coston2-explorer.flare.network

If nothing official exists → **stop**. Leave `FLARE_VENUE_MANIFEST` unset. Keep mock adapters.

### E2. If official addresses exist

Write `fixtures/flare/venues-coston2.json` per venue:

- `venue`, checksum `address`, `supportedAssets`
- `verifiedReference` (URL of the official doc)
- `bytecodeHash` (`keccak256` of on-chain runtime bytecode)

```bash
FLARE_VENUE_MANIFEST=fixtures/flare/venues-coston2.json
node tools/verify-flare-venues.mjs
```

Uses `FLARE_RPC_URL` or the Coston2 public RPC. Empty code, zero address, or hash mismatch is a **fail**.

---

## Phase F — Real FCC (Flare + GCP + you)

Official:

- Overview: https://dev.flare.network/fcc/overview
- First extension: https://dev.flare.network/fcc/guides/getting-started
- Scaffold: https://github.com/flare-foundation/fce-extension-scaffold
- TEE node: https://github.com/flare-foundation/tee-node

FCC on Coston2 is still in development. Hello World with `SIMULATED_TEE=true` and **one** machine is **not** TrustRFQ `FLARE_FCC_MODE=real`. Real mode needs a dedicated extension and **three** TEEs (2-of-3). Songbird/mainnet custom TEE registration is gated.

### F1. Flare registries + indexer (request; not self-serve)

1. Official Coston2 extract is in `fixtures/flare/fcc-coston2-public.json`. The scaffold file has **`FlareTeeManager`** `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`. It does **not** contain names `TeeExtensionRegistry` or `TeeMachineRegistry`. Do not invent them. Send [`flare-support-ask.md`](./flare-support-ask.md) and wait:

```bash
FLARE_TEE_MANAGER=0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE
# FLARE_TEE_EXTENSION_REGISTRY=  # only after Flare confirms
# FLARE_TEE_MACHINE_REGISTRY=    # only after Flare confirms
```

2. Indexer MySQL for `ext-proxy` is **not public**. Ask:
   - https://flare.network/resources/technical-support
   - https://x.com/FlareDevs  
   Say: TrustRFQ confidential RFQ matcher, Coston2 FCC extension, need Coston2 C-chain indexer read-only credentials. Host they document: `34.38.42.208:3306`, database `indexer`. Username/password only from Flare.

3. Shared Hello World proxy: `https://tee-proxy-coston2-1.flare.rocks` (`NORMAL_PROXY_URL`). Production matcher needs **your** three `/info` URLs, not this shared proxy.

### F2. GCP Confidential Space (you create)

1. Google Cloud account + billing.
2. Enable Confidential Space / Confidential VM (Intel TDX or AMD SEV-SNP per tee-node docs).
3. Follow tee-node with **`SIMULATED_TEE=false`**.
4. Stand up **three** machines. Each proxy must serve HTTPS `GET /info`.

```bash
FCC_MATCHER_ATTESTATION_URLS=https://tee1.example/info,https://tee2.example/info,https://tee3.example/info
FCC_MATCHER_REQUIRED_TEE_IDS=id1,id2,id3
```

IDs come from on-chain registration / `/info`, not invented.

### F3. Dedicated TrustRFQ extension (after F1 + F2)

1. Fork scaffold → implement the matcher. Route hash must be `keccak256(abi.encode(route))` (same as `RFQRouter.hashSwapRoute`).
2. `LOCAL_MODE=false`, **`SIMULATED_TEE=false`**.
3. `./scripts/pre-build.sh` writes `EXTENSION_ID` → `FLARE_FCC_EXTENSION_ID`.
4. Register 3 TEE machines (`post-build`).
5. Set:

```bash
FLARE_FCC_MODE=real
FCC_MATCHER_MODE=real
FLARE_FCC_ALLOW_SIMULATED=false
FLARE_FCC_EXTENSION_ID=...          # from extension.env
FCC_MATCHER_CODE_HASH=0x...         # 32-byte attested hash (not simulated 0x194844cf…)
FCC_MATCHER_OWNER=0x...
FCC_MATCHER_PLATFORM_MEASUREMENT=...
FCC_MATCHER_ARTIFACT_SHA256=0x...
FCC_MATCHER_ARTIFACT_MANIFEST=services/fcc-matcher/dist/manifest.json
FLARE_FCC_QUORUM_VERIFIER=0x...     # non-dummy
```

6. `node tools/configure-flare-fcc-coston2.mjs` then `npm run smoke:flare:fcc-registry`.

If smoke still prints `DEDICATED_EXTENSION_REQUIRED`, you are still on the shared / Hello World path.

---

## Phase G — ops you create

Do this after D/E/F exist, or in parallel for staging.

### G1. TLS + mTLS

Issue a real cert (Let’s Encrypt or your CA) for the API hostname:

```bash
FLARE_API_AUTH_REQUIRED=true
FLARE_BOT_MTLS_REQUIRED=true
FLARE_API_TLS_CERT_FILE=/path/cert.pem
FLARE_API_TLS_KEY_FILE=/path/key.pem
FLARE_API_TLS_CA_FILE=/path/ca.pem    # client CA for bot mTLS
```

### G2. Mongo + Redis

- Mongo: https://cloud.mongodb.com → cluster → Connect → `mongodb+srv://...`
- Redis TLS: Upstash / Memorystore / ElastiCache as `rediss://`

```bash
FLARE_MONGO_URL=mongodb+srv://...
FLARE_INDEXER_MONGO_URL=mongodb+srv://...
FLARE_INDEXER_REDIS_URL=rediss://...
FLARE_KEEPER_REDIS_URL=rediss://...
```

### G3. Keeper HTTPS jobs

Deploy the keeper (Cloud Run / Fly / your host). Paste **your** public HTTPS due/run URLs — they are not Flare URLs.

```bash
FLARE_KEEPER_REQUIRE_JOB_SOURCES=true
FLARE_KEEPER_AUCTION_EXPIRY_DUE_URL=https://keepers.yourdomain/...
FLARE_KEEPER_AUCTION_EXPIRY_RUN_URL=https://keepers.yourdomain/...
FLARE_KEEPER_LIQUIDATION_DETECTION_DUE_URL=https://keepers.yourdomain/...
FLARE_KEEPER_LIQUIDATION_DETECTION_RUN_URL=https://keepers.yourdomain/...
FLARE_KEEPER_FDC_PROGRESSION_DUE_URL=https://keepers.yourdomain/...
FLARE_KEEPER_FDC_PROGRESSION_RUN_URL=https://keepers.yourdomain/...
FLARE_KEEPER_REDEMPTION_SETTLEMENT_DUE_URL=https://keepers.yourdomain/...
FLARE_KEEPER_REDEMPTION_SETTLEMENT_RUN_URL=https://keepers.yourdomain/...
FLARE_KEEPER_WITHDRAWAL_QUEUE_DUE_URL=https://keepers.yourdomain/...
FLARE_KEEPER_WITHDRAWAL_QUEUE_RUN_URL=https://keepers.yourdomain/...
```

### G4. Humans only (do not fake)

1. Flare Safe: https://multisig.flare.network — Coston2 first, mainnet later → `FLARE_MULTISIG_ADDRESS`
2. Separate pause key → `FLARE_GUARDIAN_ADDRESS`
3. Write `fixtures/flare/governance.json` (owners, threshold, guardian) → `FLARE_GOVERNANCE_MANIFEST`
4. Independent auditor → report id → `FLARE_EXTERNAL_REVIEW_ID`
5. **Only after** humans sign off: `FLARE_GOVERNANCE_STATUS=production-approved`

Then from the worktree, with vars exported:

```bash
FLARE_RELEASE_PROFILE=production
npm run check:flare:release-gates
npm run check:flare:production-config
npm run check:flare:governance
```

Expect **BLOCKED** until the values above are real.

---

## Env checklist (after D + E + F exist)

```bash
# FDC (D)
FLARE_FDC_API_KEY=...
FLARE_FDC_VERIFIER_URL=https://...
FLARE_FDC_DA_URL=https://...

# FCC (F)
FCC_MATCHER_MODE=real
FLARE_FCC_MODE=real
FLARE_FCC_ALLOW_SIMULATED=false
FLARE_FCC_QUORUM_VERIFIER=0x...          # non-dummy
FLARE_TEE_EXTENSION_REGISTRY=0x...
FLARE_TEE_MACHINE_REGISTRY=0x...
FLARE_FCC_EXTENSION_ID=...
FCC_MATCHER_CODE_HASH=0x...              # 32 bytes
FCC_MATCHER_OWNER=0x...
FCC_MATCHER_PLATFORM_MEASUREMENT=...
FCC_MATCHER_ARTIFACT_SHA256=0x...        # 32 bytes
FCC_MATCHER_ARTIFACT_MANIFEST=services/fcc-matcher/dist/manifest.json
FCC_MATCHER_ATTESTATION_URLS=https://tee1/.../info,https://tee2/.../info,https://tee3/.../info
FCC_MATCHER_REQUIRED_TEE_IDS=id1,id2,id3

# Venues (E)
FLARE_VENUE_MANIFEST=fixtures/flare/venues-coston2.json

# HTTPS API + mTLS
FLARE_API_AUTH_REQUIRED=true
FLARE_BOT_MTLS_REQUIRED=true
FLARE_API_TLS_CERT_FILE=/path/cert.pem
FLARE_API_TLS_KEY_FILE=/path/key.pem
FLARE_API_TLS_CA_FILE=/path/ca.pem
FLARE_MONGO_URL=mongodb+srv://...

# Indexer / keepers
FLARE_INDEXER_MONGO_URL=mongodb+srv://...
FLARE_INDEXER_REDIS_URL=rediss://...
FLARE_KEEPER_REDIS_URL=rediss://...
FLARE_KEEPER_REQUIRE_JOB_SOURCES=true
FLARE_KEEPER_AUCTION_EXPIRY_DUE_URL=https://...
FLARE_KEEPER_AUCTION_EXPIRY_RUN_URL=https://...
FLARE_KEEPER_LIQUIDATION_DETECTION_DUE_URL=https://...
FLARE_KEEPER_LIQUIDATION_DETECTION_RUN_URL=https://...
FLARE_KEEPER_FDC_PROGRESSION_DUE_URL=https://...
FLARE_KEEPER_FDC_PROGRESSION_RUN_URL=https://...
FLARE_KEEPER_REDEMPTION_SETTLEMENT_DUE_URL=https://...
FLARE_KEEPER_REDEMPTION_SETTLEMENT_RUN_URL=https://...
FLARE_KEEPER_WITHDRAWAL_QUEUE_DUE_URL=https://...
FLARE_KEEPER_WITHDRAWAL_QUEUE_RUN_URL=https://...

# Governance + review (human)
FLARE_MULTISIG_ADDRESS=0x...
FLARE_GUARDIAN_ADDRESS=0x...
FLARE_GOVERNANCE_MANIFEST=fixtures/flare/governance.json
FLARE_EXTERNAL_REVIEW_ID=...             # auditor record
# Only after humans sign off:
# FLARE_GOVERNANCE_STATUS=production-approved

FLARE_RELEASE_PROFILE=production
npm run check:flare:release-gates
npm run check:flare:production-config
npm run check:flare:governance
```

---

## T6.5 / T6.6 / T6.7

- T6.5 Coston2 RC: only after the production profile is `CONFIGURED` and D/E/F live.
- T6.6: independent security/performance/ops review (`FLARE_EXTERNAL_REVIEW_ID`).
- T6.7 mainnet (chain 14): explicit human approval after T6.6. Agent will not deploy.
