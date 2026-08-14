# Paste-ready Flare asks (admin click #2)

Send **one** of these. Do not invent a password if they ask you to wait.

**Who:** you (admin). Agent cannot post to Telegram or the support form.

**Context we already filed:** DA / verifier key → https://github.com/flare-foundation/developer-hub/issues/1458 (OPEN, no reply as of 2026-08-13). Do not re-file that request.

---

## A. Technical support form

https://flare.network/resources/technical-support

Subject: Coston2 FCC indexer credentials + Tee registry names (TrustRFQ)

```
Hello Flare team,

We are building TrustRFQ, a confidential RFQ matcher on Coston2 using FCC.

Already done:
- Public FDC testnet smoke with the published all-zero verifier UUID
- GitHub API key request: https://github.com/flare-foundation/developer-hub/issues/1458
- Confirmed official Coston2 FlareTeeManager 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE from fce-extension-scaffold config/coston2/deployed-addresses.json

We need (not self-serve):
1. Read-only Coston2 C-chain indexer MySQL credentials for ext-proxy. Documented host 34.38.42.208:3306, database indexer. Username/password only from you.
2. Confirmation of the current TeeExtensionRegistry and TeeMachineRegistry addresses (those names are not in deployed-addresses.json). If they now resolve through FlareContractRegistry, please give the exact names to query.
3. Whether a dedicated 2-of-3 TrustRFQ extension on Coston2 requires a separate allow-list beyond the Hello World / shared proxy at https://tee-proxy-coston2-1.flare.rocks

Contact: tkien2703@gmail.com / GitHub @MrSufferer

Thank you.
```

---

## B. Telegram @FlareNetwork or X @FlareDevs

```
Hi — TrustRFQ on Coston2 FCC. We filed DA key request #1458. Need (1) Coston2 indexer MySQL read-only creds (host 34.38.42.208 db indexer) and (2) current TeeExtensionRegistry / TeeMachineRegistry — those names are not in fce-extension-scaffold deployed-addresses.json. Contact tkien2703@gmail.com / @MrSufferer
```

---

## After they reply

Paste into worktree `.env` only (gitignored):

```
FLARE_INDEXER_MYSQL_HOST=34.38.42.208
FLARE_INDEXER_MYSQL_PORT=3306
FLARE_INDEXER_MYSQL_DATABASE=indexer
FLARE_INDEXER_MYSQL_USER=...
FLARE_INDEXER_MYSQL_PASSWORD=...
FLARE_TEE_EXTENSION_REGISTRY=0x...
FLARE_TEE_MACHINE_REGISTRY=0x...
```

Do not set `FLARE_FCC_MODE=real` until a **dedicated** extension + three TEEs exist. Hello World `SIMULATED_TEE=true` is not TrustRFQ 2-of-3.
