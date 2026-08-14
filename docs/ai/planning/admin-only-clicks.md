# Admin-only clicks (agent already did the rest)

Worktree: `.worktrees/feature-flare-confidential-rfq-dex`

This is **not** a production RFQ DEX. Skip 3–5 for an investor **demo**.

## Agent already did

| Item | Where |
|---|---|
| Public FDC in `.env` + smoke loads `.env` | `npm run smoke:flare:fdc-verifier` (no exports) |
| DA key request | https://github.com/flare-foundation/developer-hub/issues/1458 — OPEN, no reply (2026-08-13) |
| Venue hunt | `docs/ai/planning/venue-research.md` — **stay mocks** |
| Public FCC extract | `fixtures/flare/fcc-coston2-public.json` (`FlareTeeManager` only; no Tee*Registry names) |
| Paste-ready Flare ask | `docs/ai/planning/flare-support-ask.md` |
| Staging compose overlay | `infra/staging.env.example` (`redis://`, not `rediss://`) |
| Local TLS generator (not prod) | `node tools/generate-local-tls.mjs` → gitignored `infra/tls-local/` |
| Full walkthrough | `docs/ai/planning/phase-g-setup.md` |

## You do these (copy-paste)

### 1. Paste paid FDC key when Flare replies (2 min)

Watch #1458 or `tkien2703@gmail.com`. Then in worktree `.env`:

```
FLARE_FDC_API_KEY=<the key they send>
```

```bash
cd .worktrees/feature-flare-confidential-rfq-dex
npm run smoke:flare:fdc-verifier
```

Keep the all-zero UUID until then. It is rate-limited, not paid.

### 2. Send the Flare indexer / registry ask (5 min)

Open `docs/ai/planning/flare-support-ask.md`. Send **A** (form) or **B** (Telegram/X). Paste any reply into `.env` as documented there.

### 3. Real FCC only — GCP project + billing (hours)

Skip for demo. After billing exists, ask the agent for `gcloud` commands. Three Confidential Space VMs + dedicated extension. Hello World is not enough.

### 4. Production Mongo/Redis — or stay on compose (10 min)

Skip for demo. Staging:

```bash
cd .worktrees/feature-flare-confidential-rfq-dex
docker compose --env-file infra/staging.env.example -f infra/docker-compose.yml up -d
```

Production gates still need Atlas `mongodb+srv://` + `rediss://`.

### 5. Production-approved only — Safe + guardian + auditor (days)

https://multisig.flare.network — do **not** set `FLARE_GOVERNANCE_STATUS=production-approved` yourself until review.

## Walls the agent cannot finish

- Logging into Flare / GCP / Atlas / Telegram / your wallet
- Getting the indexer MySQL password
- Inventing Coston2 Morpho/Kinetic/Clearpool addresses
- Claiming SC-1–SC-16 or mainnet
