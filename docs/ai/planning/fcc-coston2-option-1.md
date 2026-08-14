# FCC Coston2 option 1 — Weather-first three-TEE plan

> Superseded baseline: use `fce-weather-api` for implementation and retain the
> scaffold only for conformance. The execution envelope is ABI encoded with
> three secp256k1 ECIES recipients; instruction/result relay keys on the FCC
> instruction ID and maps it back to the TrustRFQ logical action ID.

Last updated: 2026-08-14.

## Outcome

Run TrustRFQ's real deterministic matcher handler through the official Flare
FCC extension scaffold on Coston2 using exactly three independently keyed local
simulated TEE stacks. One instruction is delivered to all three machines, at
least two machines return the same canonical `bytes32` route hash, and those
signed results satisfy `ConfidentialRFQInstructionSender`'s 2-of-3 quorum.

This is Coston2 integration evidence, not production confidentiality or real
attestation evidence. `SIMULATED_TEE=true` must remain visible in manifests,
logs, UI status, and release-gate output. Production still requires three real
Confidential Space machines, accepted attestations, reproducible image/code
hashes, and independent review.

## Progress reconciliation — 2026-08-14

The support-issued Coston2 indexer pair is now present only in the ignored
`.env.fcc.local` file. `tools/fcc-indexer-preflight.mjs` validates the
documented host/port/database, loads either `FCC_*` or `FLARE_*` aliases, and
reports only endpoint, database, credential presence, and safe protocol/auth
status. It performs the MySQL greeting/auth exchange and distinguishes
connectivity, post-connect handshake, protocol, authentication, and secure
transport failures. This sandbox still cannot open the socket, so the
network-permitted shell must complete the check. `tools/fcc-proxy-preflight.mjs` separately
checks registered HTTPS `/info` endpoints and reports only identity and
signing-policy freshness fields.
Compose interpolation is valid with the three proxy services receiving the
same indexer settings, and the new preflight tests, Flare typecheck, secret
scan, and compose config checks pass.

## Operator-shell runbook for live checks

Run network- and Docker-dependent commands from the operator's ordinary shell,
not from a restricted Codex session. The commands load credentials from the
ignored `.env.fcc.local` and print only safe status fields:

```bash
npm run check:flare:fcc:indexer
docker compose -f infra/docker-compose.fcc.yml ps --all
docker compose -f infra/docker-compose.fcc.yml restart ext-proxy-a ext-proxy-b ext-proxy-c
FCC_PROXY_INFO_URLS="https://<registered-proxy-a>/info,https://<registered-proxy-b>/info,https://<registered-proxy-c>/info" \
  npm run check:flare:fcc:proxy
FCC_VALIDATE_LIVE=true npm run check:flare:fcc:stacks
```

Expected indexer evidence includes `mysqlAuthenticated=true`. Proxy evidence
must show the registered `teeId`, extension ID, and current signing-policy
freshness. Do not restart `extension-tee-*` during an indexer diagnosis: a TEE
restart mints a new simulated identity and requires re-registration. If a
Codex run reports `EPERM`, DNS failure, `FCC_INDEXER_UNREACHABLE`, proxy
unreachable, or Docker permission denied while the operator shell passes, mark
the result as an execution-boundary limitation and retain the operator-shell
output as the live evidence.

The FAQ guidance supersedes the earlier tunnel shortcut: selected machines
must be status `2` (`PRODUCTION`), have availability newer than six hours, a
registered `teeId`, and a stable public HTTPS URL. Dispatch events alone do
not prove delivery; providers POST directly to each registered `/instruction`
endpoint. The current local compose remains a custom matcher rehearsal, not
the pinned official weather/scaffold runtime, so C2-FCC-0 through C2-FCC-5
remain open or partial until that boundary is replaced and exercised.

The rehearsal now matches the provider-facing delivery shape: proxies listen
on internal port `6664`, forward `/instruction` to the extension TEE, and
expose `/action/status/<epoch>/<instructionId>`; TEE processes retain the
Weather action/decrypt boundary. This improves local wire fidelity but does
not change the scaffold pin or constitute Coston2 delivery evidence.

## Fixed architecture

- Pin one reviewed commit of
  `flare-foundation/fce-extension-scaffold`; record the upstream URL, commit,
  license, image digests, and any local patches.
- Port the deterministic TrustRFQ matcher into the scaffold's Go action-handler
  interface. The existing custom `/v1/match` server remains a local test seam,
  not the Coston2 FCC venue.
- Run three isolated scaffold Compose projects: `tee-a`, `tee-b`, and `tee-c`.
  Each has a distinct proxy/signing identity, Redis state, host ports, public
  HTTPS URL, and simulated TEE identity. All three register the same dedicated
  TrustRFQ extension ID.
- Register only these three machines for the milestone so
  `dispatchConfidential(..., teeCount=3, ...)` selects the complete set.
- Keep the contract's FCC quorum threshold at exactly two. FCC `cosigners` and
  `cosignersThreshold` remain empty/zero because they are a different signing
  feature and are not the TrustRFQ result quorum.
- Use one committed multi-recipient outer message. It contains three
  recipient-specific encryptions of the same canonical plaintext, one per TEE.
  It never contains a shared plaintext key.
- Each handler tries only the bounded three ciphertext entries through the
  scaffold/node decrypt boundary, accepts exactly one successful decryption,
  verifies the common plaintext commitment and authenticated action metadata,
  and rejects zero or multiple successful decryptions.
- Each handler emits the same 32-byte `hashSwapRoute` value. A result relay
  validates the scaffold response schema and submits each distinct signed
  `ActionResult` to `submitFccResult`; it never signs as a TEE.

## Multi-recipient instruction schema

The outer message is canonical, bounded, and committed on-chain with
`payloadCommitment = keccak256(message)`:

```text
FccRecipientEnvelopeV1 {
  version = 1
  chainId = 114
  extensionId
  actionId
  opType
  command
  expiry
  plaintextCommitment
  recipients[3] {
    teeId
    keyId
    ciphertext
  }
}
```

The associated data for every recipient ciphertext contains the outer fields
through `plaintextCommitment`. The client canonicalizes the instruction once,
calculates `plaintextCommitment`, and encrypts those exact bytes independently
to the three public keys discovered from verified `/info` responses. The
handler rejects duplicate TEE IDs, key IDs, or ciphertext digests; wrong chain,
extension, action, operation, expiry, or commitment; unknown fields; excessive
sizes; and plaintext whose digest differs from `plaintextCommitment`.

This first milestone intentionally uses three complete recipient ciphertexts.
A hybrid content-encryption-key optimization is deferred until the scaffold
path works and has compatible cross-language golden vectors.

## Ordered implementation tasks

### C2-FCC-0 — Pin and characterize the official scaffold

- **Outcome:** Record the upstream commit and exact action, decrypt, result,
  registration, `/info`, and indexer interfaces used by the implementation.
- **Changes:** add the pinned scaffold source/adapter boundary and an
  `UPSTREAM.md`; do not edit the current matcher behavior yet.
- **Tests first:** contract/fixture tests that parse the official action and
  result examples and fail on schema drift.
- **Validation:** clean scaffold unit/build checks pass; the recorded commit is
  reproducible; no weather-only API or payment-token dependency is retained.
- **Blocker:** source download needs network access if the pinned source is not
  already present.

### C2-FCC-1 — Add canonical three-recipient envelopes

- **Outcome:** TypeScript sender code and Go handler code share byte-identical
  outer-envelope, associated-data, and plaintext-commitment vectors.
- **Tests first:** valid three-key round trip; one key per TEE; wrong key;
  duplicate recipient; tampered ciphertext/AAD/commitment; expired action;
  unknown field; fourth recipient; oversized payload; zero or two successful
  decryptions.
- **Validation:** relay/database/log inspection exposes only ciphertext,
  commitments, key IDs, TEE IDs, and safe operational metadata.
- **Dependencies:** C2-FCC-0.

### C2-FCC-2 — Port the matcher into the scaffold handler

**Status 2026-08-14:** handler + 1-machine Coston2 simulated-TEE attestation
done (golden MATCH/FINALIZE). Envelope decrypt / 3 isolated scaffold handlers
and `submitFccResult` remain C2-FCC-1 / C2-FCC-4.

- **Outcome:** The scaffold `/action` handler supports the approved RFQ, BID,
  MATCH, and LIQUIDATION operation table; decrypts the recipient envelope inside
  the node boundary; restores isolated Redis state; and calls the existing
  deterministic matcher/hash functions.
- **Tests first:** operation allowlist, CREATE/SUBMIT/FINALIZE state sequence,
  replay and transition rejection, canonical route-hash fixture, restart
  recovery, no-plaintext logs, and concurrent/race cases.
- **Validation:** the same fixture produces the same 32-byte result in the
  custom matcher and in each of three scaffold handlers.
- **Dependencies:** C2-FCC-0, C2-FCC-1.

### C2-FCC-3 — Build three isolated simulated TEE stacks

- **Outcome:** One repeatable command renders/starts three Compose projects
  with distinct proxy identities, Redis volumes, host ports, and health checks.
- **Tests first:** configuration validator rejects reused private keys, TEE IDs,
  public URLs, host ports, Redis namespaces/volumes, or non-simulated Coston2
  labels.
- **Validation:** all three `/info` documents report the same extension and
  code version but three distinct TEE identities and encryption keys; stopping
  one stack does not stop either peer.
- **Dependencies:** C2-FCC-2.

### C2-FCC-4 — Add instruction dispatch and result relay

- **Outcome:** The sender discovers and pins the selected three `/info` keys,
  creates the recipient envelope, dispatches one instruction, collects three
  signed scaffold results, validates action/status/tag/result schema, and
  submits each result once to `submitFccResult`.
- **Tests first:** selected-TEE binding, signer recovery, duplicate submission,
  wrong action/chain/status/tag, malformed result length, stale result, one
  dissent, one unavailable, two unavailable, and relay restart idempotency.
- **Validation:** two matching distinct signers make `quorum(actionId)` return
  the canonical route hash; the relay has no TEE private key and cannot forge a
  result.
- **Dependencies:** C2-FCC-1 through C2-FCC-3 and the existing
  `ConfidentialRFQInstructionSender` hash-parity tests.

### C2-FCC-5 — Local three-stack rehearsal

- **Outcome:** Exercise RFQ CREATE, at least two encrypted BID SUBMIT actions,
  and MATCH FINALIZE across all three stacks against local contracts before
  spending Coston2 gas.
- **Validation:** expected winner and route hash, 2-of-3 quorum, no plaintext in
  API/Redis/proxy logs, one-machine outage success, two-machine outage
  fail-closed, and deterministic replay rejection.
- **Dependencies:** C2-FCC-4.

### C2-FCC-6 — Deploy/register on Coston2

- **Outcome:** Deploy one dedicated extension, register the three simulated
  machines/endpoints, and configure a fresh dedicated
  `ConfidentialRFQInstructionSender` once with the verified Coston2 registries,
  extension ID, and threshold two.
- **Safety:** generate and review a dry-run manifest before any transaction.
  Confirm chain ID 114, three distinct TEE IDs, the exact extension ID, registry
  addresses, owner, expected gas/value, and `SIMULATED_TEE=true`. Do not reuse an
  already configured InstructionSender or set `FLARE_FCC_MODE=real`.
- **Validation:** read-only registry and `/info` smokes agree with the manifest;
  configuration events and bytecode are recorded.
- **Dependencies:** C2-FCC-5, funded Coston2 accounts, the configured
  support-provided indexer credentials, stable public HTTPS endpoints, and
  explicit operator approval for the
  state-changing deployment/configuration commands.

### C2-FCC-7 — Coston2 acceptance and evidence

- **Outcome:** Run TrustRFQ's actual encrypted CREATE → BID → FINALIZE flow and
  submit the two matching signed route results on Coston2.
- **Validation:** transaction hashes, block numbers, extension/machine IDs,
  public `/info` fields, outer/plaintext commitments, result signers, selected
  route hash, and contract quorum are recorded without secrets or plaintext.
  Repeat with one machine unavailable; verify two unavailable fail closed.
- **Dependencies:** C2-FCC-6.

## Credentials and operator inputs

| Input | Quantity | Needed for | Handling |
|---|---:|---|---|
| `DEPLOYMENT_PRIVATE_KEY` | 1 | Deploy/register the dedicated Coston2 extension and fresh sender | Fund with faucet C2FLR; store only in ignored `.env`; may also be `INITIAL_OWNER` for the demo |
| `INITIAL_OWNER` | 1 address | Initial extension/sender owner | Public address only; production governance is out of scope |
| `PROXY_PRIVATE_KEY_A/B/C` | 3 | Three distinct simulated TEE/proxy signing identities | Each must be unique and funded with faucet C2FLR; never commit or log |
| Coston2 indexer MySQL user/password | 1 read-only credential pair | Each ext-proxy reads the FCC/indexer state | Configured from Flare support in ignored env/secret files; complete TCP/auth preflight before deployment |
| Three stable public HTTPS URLs | 3 | FCC delivery to the three local proxies | Use fixed hostnames with valid certificates; changing temporary quick-tunnel URLs are not acceptable for registered Coston2 machines |
| Coston2 RPC URL | 1+ | Chain reads/writes | Official public RPC is adequate for the milestone; no API key assumed |
| Registry addresses and dedicated extension ID | 1 set | Contract configuration and verification | Resolve/confirm from official Coston2 deployment/support data; never copy an unverified search result |

TrustRFQ does **not** need `OPENWEATHERMAP_API_KEY` or the weather tutorial's
`PAY_TOKEN`. It also does not need a GCP account, KMS, Confidential Space, or
production attestation credentials for this simulated milestone.

## Expected cost

| Item | Expected milestone cost |
|---|---:|
| Coston2 deployment and instruction gas | `$0` monetary value; paid in faucet C2FLR |
| Three local simulated TEE/proxy/Redis stacks | `$0` cloud spend; uses the operator machine's CPU, RAM, bandwidth, and electricity |
| Stable public HTTPS endpoints | `$0` for local/operator-hosted endpoints; hosting may add cost |
| Official public Coston2 RPC | `$0` under normal public limits |
| Flare support-provided read-only indexer credentials | No published charge expected; confirm with Flare support |
| Optional always-on VPS for a longer demo | Not required; typically a small external hosting charge if chosen |

Production GCP Confidential Space, managed databases, monitoring, KMS, egress,
audits, and mainnet gas are excluded from this estimate.

## Definition of done

- Three distinct simulated Coston2 TEE identities run the pinned official
  scaffold and the TrustRFQ handler under one extension ID.
- The client sends one outer committed message containing exactly three
  recipient ciphertexts of one canonical instruction.
- Each TEE independently decrypts and produces the same route hash without
  plaintext appearing outside its handler boundary.
- Two signed results from selected distinct TEEs satisfy the on-chain quorum;
  one dissent/unavailable machine is tolerated and loss of two fails closed.
- The full encrypted RFQ CREATE → BID → FINALIZE path runs on Coston2 and has a
  secret-free evidence manifest.
- Release tooling continues to reject this evidence as production FCC or real
  attestation evidence.
