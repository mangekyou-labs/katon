# FCC scaffold characterization (conformance reference only)

This directory records the local adapter boundary for the official Flare FCC
extension scaffold. It is retained only as a shared wire/conformance reference;
the Weather API implementation is the primary baseline for this milestone.

- Upstream: `https://github.com/flare-foundation/fce-extension-scaffold`
- Contract: `docs/extension-contract.md`
- Current pin: intentionally not used as the implementation source; see
  [`fixtures/flare/fcc-scaffold-contract.json`](../../../fixtures/flare/fcc-scaffold-contract.json)
- License: MIT
- Local mode: `MODE=1` / `SIMULATED_TEE=true` only

The adapter must preserve the scaffold boundary:

1. `POST /action` receives the scaffold `Action` JSON and returns an
   `ActionResult` for routed handlers.
2. `GET /state` is serialized with handler mutations.
3. `DataFixed.originalMessage` is hex on the action wire.
4. The node `/decrypt` request and response carry base64 bytes.
5. Empty result byte fields serialize as `0x`, not `null`, `""`, or omitted
   fields.

Do not register or deploy this adapter. Use the Weather-derived handler and
three isolated stacks instead.
