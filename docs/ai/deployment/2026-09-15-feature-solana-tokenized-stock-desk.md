---
phase: deployment
title: Katon Solana Tokenized-Stock Exit Desk Deployment and Rollout Gates
feature: solana-tokenized-stock-desk
status: gated
date: 2026-09-16
---

# Deployment dossier

## Environment

Target versions are Node 22, Solana CLI 3.1.10, Anchor CLI/framework 1.1.2,
v0 transactions, Codama-generated clients, `@solana/kit` 7+, Wallet Standard,
and pinned audited lender IDLs. Devnet QA uses program address
`J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib`, matched to the ignored local
deploy keypair. It is a mock-only test deployment; this identity and build are
not approved for mainnet. Devnet receives mocks only.
The web surface labels every local route `LOCAL MOCK MODE`; wallet, RPC,
liquidity, settlement, and receipts shown there are simulated and are not
mainnet/finalized transaction evidence.

The checked-in local vault authority is a test fixture. A fresh read-only
Devnet `solana program show` on 2026-09-23 resolved the deployed program's
upgrade authority to `8LmRZFAUJxxXpDXKUPH9B5J3dzDvePQJDPHDP1FNLJgf`, matching
the existing Squads vault reported in the deployment handoff. `build.rs` pins
that authority for deployment builds and rejects a different configured value;
the local fixture remains the default for tests. This confirms the current
upgrade-authority account identity only; it does not certify the program binary
or grant approval for another Devnet transaction.
The Solana loader upgrade authority is separate from the RFQ governance queue.
The RFQ 24-hour delay does not bind program upgrades (canonical AC-053).

## Preflight gates

- Reproducible program build, IDL/program hashes, SBOM, dependency review, and
  independent security audit.
- Signed asset/mint/Token-2022 extension and program/IDL deployment manifests.
  The liquidator must verify the canonical manifest payload with Ed25519,
  require the signer to be in the configured governance-key allowlist, compare
  runtime hashes/authorities and enabled mints, and pass the startup gate before
  preparing any liquidation transaction. The startup initializer must also
  discover at least one fresh, registry-enabled native-USDC lender market with
  complete reserve, vault, oracle, IDL, and upgrade-authority metadata; an
  unavailable or empty discovery leaves the solver dormant.
- Anchor registry bootstrap must run through the compile-time pinned Squads
  vault PDA. Squads enforces its member approvals; the RFQ program does not
  store member keys or quorum. Transfer-hook validation PDAs, flags, account order, and
  live TLV data hashes must match the initialized registry.
- Quote adapters must provide source-bound independent simulation and verified,
  fresh maker balance evidence within one three-second collection deadline.
- Concrete registry-verified Kamino and Jupiter Lend stock markets with fresh
  oracle/session state.
- Production RPC/SWQoS/Jito, maker health, receipt indexing, alerts, and
  guardian/multisig runbooks.
- Operator read-only evidence configuration: `SOLANA_RPC_URL`,
  `SOLANA_CLUSTER`, `SOLANA_DEPLOYMENT_MANIFEST`, and
  `SOLANA_MANIFEST_TRUSTED_SIGNERS`. The reader verifies the signed manifest
  and compares live lender, RFQ, and Squads v4 bytecode hashes and upgrade
  authorities through RPC, then validates RFQ and Squads account identities.
  Production evidence remains unavailable until trusted manifest, signer, and
  RPC configuration are supplied. The confirmed Devnet RFQ upgrade authority
  is not a bytecode hash or proof of a deployed RFQ binary/governance action.
- Legal/compliance approval for eligible non-US access.

## Rollout

1. Run seller and solver paths against LiteSVM/Surfpool, then mocks on devnet;
   keep the mock disclosure visible during all local and devnet demonstrations.
2. Observe quotes and run solver shadow mode without submission for seven
   consecutive days.
3. Require 20 representative opportunities, at least 95% prediction-to-
   simulation agreement, no unexplained registry changes, and zero unsupported
   extension handling.
4. Enable execution only via explicit human/multisig action. Canary limits are
   1,000 USDC repayment per transaction and 5,000 USDC daily volume.
5. Keep the prefunded wallet at or below 2,000 USDC and increase caps only with
   reviewed configuration.

## Automatic halts

Trip the pause-only guardian/circuit breaker after three landing failures,
residual stock lasting more than one minute, more than 25 bps adverse output
versus final simulation, stale policy/oracle state, any invalid/untrusted
manifest signature, or any program/IDL/mint/extension/transfer-hook mismatch.
Do not automatically escalate limits or route to an unsupported venue.

## Credential handoff

After code and offline verification, a human operator can collect the external
values with:

```sh
cd /Users/kyler/repos/katon/.worktrees/feature-solana-tokenized-stock-desk
npm run setup:solana:credentials
```

The wizard collects the cluster/RPC endpoint, a wallet/deployer keypair path
(never keypair contents), the trusted Ed25519 manifest signer, and the signed
deployment-manifest path. Kamino liquidation is permissionless and does not
require a provider token. It also offers an optional Jupiter API key for higher
rate limits and portal analytics; keyless access is sufficient for low-rate
development. Do not paste secrets into chat or commit this file. The current
devnet mock does not consume the optional key. Network, wallet, RPC,
deployment, manifest, and transaction-submission checks remain explicit
operator-run gates.
