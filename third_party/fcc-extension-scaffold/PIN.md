# FCC Extension Scaffold — Pinned Vendor Copy

Task C2-FCC-0 (pin official scaffold). Vendored unmodified; no `.git` directory carried.

| Upstream | Commit | Cloned (UTC) |
|---|---|---|
| https://github.com/flare-foundation/fce-extension-scaffold | `e3f587949069780084e2ced8a53c9419ed05c250` (2026-08-11) | 2026-08-14 |

Reference example also reviewed (not vendored): `fce-weather-api` @ `d759e3de258913c51480c8dae485e510da6c5c64`.

## Why vendored

The Go replica under `services/fcc-matcher` reproduces the wire surface by hand. This pinned
copy is the authoritative source for:

- `docs/extension-contract.md` — normative HTTP/wire contract
- `testdata/conformance/` — golden wire fixtures
- `scripts/` — full lifecycle (pre-build → start-services → post-build → test) incl. Coston2
- `tools/cmd/` — deploy-contract, register-extension, register-tee, set-governance, start-proxy

## Local modifications

1. **`scripts/start-services.sh`** (task C2-FCC-6, 2026-08-14): replaced `"${proj[@]}"`
   and `"${since[@]}"` with the `${arr[@]+"${arr[@]}"}` idiom (5 sites). Upstream assumes
   bash ≥ 4.4; macOS ships bash 3.2 where expanding an empty array under `set -u`
   is an unbound-variable error. Behavior identical on bash ≥ 4.4.

2. **Matcher port (C2-FCC-2, 2026-08-14):** TrustRFQ deterministic auction matcher
   copied into `go/internal/extension` (`rfq.go`, `rfq_match.go`, `rfq_test.go`)
   plus `go/internal/matcher`. Scaffold `InstructionSender.sol` gained
   `sendRFQCreate` / `sendBidSubmit` / `sendMatchFinalize`; bindings regenerated
   under `tools/pkg/contracts/helloworld/`. `tools/cmd/run-test` dispatches the
   golden RFQ→BID→MATCH sequence. `GOWORK=off` required when building
   `go/` or `tools/` from this tree.

