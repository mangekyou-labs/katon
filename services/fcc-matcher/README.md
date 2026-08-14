# FCC matcher

The FCC execution surface is Weather-compatible: `GET /info`, `GET /state`,
`POST /action`, and the local-node-only `POST /decrypt`. The provider-facing
proxy boundary is `POST /instruction` on port `6664`; it forwards the
cosigned instruction to the extension action handler. Completed results are
available at `GET /action/status/<epoch>/<instructionId>`. Envelopes are ABI
encoded and carry exactly three independently encrypted secp256k1 ECIES
recipient ciphertexts. The legacy `/v1/match` and `/v1/quorum` endpoints remain
local deterministic parity harnesses; they are not the Coston2 FCC path.

The matcher is a deterministic, strict-input Go service intended to run inside
an attested FCC extension. It operates on commitments and typed encrypted
payloads; production confidentiality requires real FCC attestation and a
2-of-3 result quorum.

The local HTTP boundary is `go run ./services/fcc-matcher/cmd/server` (or
`FCC_MATCHER_PORT=6664`). It exposes `GET /healthz`, `GET /readyz`,
`GET /ready`,
`GET /v1/types`, `POST /v1/match`, `POST /v1/quorum`,
`POST /v1/operation`, and `POST /v1/action`. Requests are bounded to 256 KiB,
reject unknown/trailing fields, and return stable error codes without payload
or stack-trace leakage. The server is a simulated matcher until deployed
inside Confidential Space with attestation and key-release policy.

`/v1/action` is the legacy commitment-only FCC ingress: plaintext and arbitrary
unknown fields are rejected.

When `FCC_SERVICE_ROLE=ext-proxy`, `/info`, `/state`, `/instruction`, and
action-status requests are forwarded to `FCC_EXTENSION_TEE_URL`; the proxy
never decrypts and never discovers instructions from the indexer. When the
role is `extension-tee`, the same paths are handled by the local
Weather-compatible extension boundary.

`FCC_MATCHER_MODE=real` is fail-closed until all three configured attestation
endpoints answer `/info` with the expected code hash, extension ID, owner,
platform measurement, and a distinct required TEE identity. The verifier accepts
`FCC_MATCHER_ATTESTATION_URLS` or the legacy variable
`FCC_MATCHER_ATTESTATION_URL` (both must contain three comma-separated
endpoints), plus `FCC_MATCHER_CODE_HASH`, `FCC_MATCHER_EXTENSION_ID`, and
`FCC_MATCHER_REQUIRED_TEE_IDS`. It rejects explicit simulated/local-mode
responses. Evidence is cached for `FCC_MATCHER_ATTESTATION_TTL` (30s by
default), and readiness diagnostics do not return private payloads.
