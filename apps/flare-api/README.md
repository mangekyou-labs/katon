# Flare coordination API

The API is a **local** coordination process, not the designed NestJS production
broker. The encrypted relay stores seller envelopes and operational metadata.
Bid ciphertext is counted, not persisted, so FCC cannot later reconstruct the
book. Parallel workflow routes (`POST /v1/auctions`, `POST /v1/standing-bids`)
still accept pair / amount / capacity plaintext. Do not treat this process as
FR-3 complete. The local slice implements scheduled lifecycle state, idempotent
bid *acceptance*, safe public errors, role-scoped cursor replay, and
cursor-resumable WebSocket event delivery. The network broker remains gated,
but the local transport is exercised with a real WebSocket client.

Run `npm run dev:flare-api` for the local HTTP boundary. It exposes quote,
read-model, auction, standing-bid, facility withdrawal, blind encrypted-auction
lifecycle, health, SIWE challenge/verification, and RPC-backed
transaction-index endpoints. When configured, `/v1/oracles/ftso` resolves
FTSOv2 through the supplied Flare Contract Registry address, while the FDC
prepare/proof endpoints proxy only typed request metadata and proof responses;
API keys remain server-side. Set
`FLARE_API_STORE=/secure/path/store.json` to enable atomic JSON persistence;
without it, the process is intentionally ephemeral. Set
`FLARE_MONGO_URL` (optionally `FLARE_MONGO_DATABASE` and
`FLARE_MONGO_COLLECTION`) to enable startup hydration and queued transactional
Mongo persistence; Mongo is used instead of the local JSON backend when both
are configured. The API waits for persistence flush before acknowledging a
workflow mutation.
`FLARE_API_AUTH_REQUIRED=true` to require a wallet-bound SIWE bearer token on
mutating workflow commands. `FLARE_API_DOMAIN` and `FLARE_API_CHAIN_ID` bind
the authentication message to the deployed API domain and chain.
`FLARE_RELAY_REQUIRE_REGISTERED_KEYS=true` requires LP bid envelope key IDs to
be active in the durable `/v1/lp-encryption-keys` registry.
Set `FLARE_BOT_CREDENTIAL_ADMIN_TOKEN` to enable the administrator-only
`POST /v1/lp-credentials` and `DELETE /v1/lp-credentials/:id` endpoints. Issued
LP bot tokens are wallet-bound, institution-labelled, scope-limited, hashed in
the persisted snapshot, expire automatically, and can be revoked immediately.
Use scopes such as `bid:submit`, `rfq:create`, `rfq:finalize`,
`rfq:cancel`, `key:manage`, `bid:standing`, and `facility:withdraw`. This is a
bearer-token boundary. Bot mutations must also send `x-trf-timestamp`,
`x-trf-body-sha256`, and `x-trf-signature` (HMAC-SHA256 over
`METHOD\\nPATH\\nTIMESTAMP\\nBODY_DIGEST`); timestamps are replay-window checked.
Set `FLARE_BOT_MTLS_REQUIRED=true` in production to require the TLS client
certificate on bot mutations and wallet-scoped bot reads; the certificate CN or
DNS SAN must match the credential's institution label. Local HTTP mode cannot
satisfy this setting and will fail closed with `BOT_MTLS_REQUIRED`.
Run `npm run test:e2e:flare:api-auth` against an auth-required API to rehearse
unsigned rejection, signed mutation/read access, and revocation.
Configure `FLARE_API_TLS_CERT_FILE`, `FLARE_API_TLS_KEY_FILE`, and (for mTLS)
`FLARE_API_TLS_CA_FILE` to make the API listen on HTTPS. Partial TLS settings
fail startup; `FLARE_BOT_MTLS_REQUIRED=true` requires HTTPS plus a client CA and
uses Node's `requestCert`/`rejectUnauthorized` handshake checks.
Commitment-only FCC `POST /v1/action` lives on the **matcher** process
(`services/fcc-matcher`), not on this API. The API has no `/v1/action`
handler. Matcher `/v1/match` currently accepts plaintext auction and bid JSON
in simulated mode.

Live data configuration is opt-in and fail-closed: `FLARE_NETWORK`,
`FLARE_CONTRACT_REGISTRY_ADDRESS`, `FLARE_FDC_VERIFIER_URL`,
`FLARE_FDC_DA_URL`, and `FLARE_FDC_API_KEY` must be supplied by the service
deployment. The verifier URL is the service root (for example
`https://fdc-verifiers-testnet.flare.network`); the SDK selects the canonical
`/verifier/eth/...` or `/verifier/web2/...` path and encodes attestation/source
names as fixed-width bytes32 values. The frontend never receives the FDC API key.

The JSON store is a local deployment seam, not a production database. A
production deployment must replace it with a durable transactional projection
and keep the same authorization, idempotency, and ciphertext-only boundaries.
Run `FLARE_RELEASE_PROFILE=production npm run check:flare:release-gates` only
from a managed deployment environment. That profile requires API authentication,
HTTPS+mTLS, MongoDB, TLS Redis for the indexer and keepers, and all five
idempotent keeper job-source pairs; local compose intentionally remains a
non-production rehearsal.
