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
and pinned audited lender IDLs. This local scaffold does not download
dependencies or touch a wallet. Its deterministic local program address is
`59MVYbUATHzCgYtD7uio4RvCkZhdwrRh6c38ZefycwMX`; a deployment key and audited
build must replace it before devnet or mainnet. Devnet receives mocks only.
The web surface labels every local route `LOCAL MOCK MODE`; wallet, RPC,
liquidity, settlement, and receipts shown there are simulated and are not
mainnet/finalized transaction evidence.

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
- Anchor registry bootstrap must run through the audited compile-time authority;
  later asset and maker registry creation requires two distinct configured
  quorum members. Transfer-hook validation PDAs, flags, account order, and
  live TLV data hashes must match the initialized registry.
- Quote adapters must provide source-bound independent simulation and verified,
  fresh maker balance evidence within one three-second collection deadline.
- Concrete registry-verified Kamino and Jupiter Lend stock markets with fresh
  oracle/session state.
- Production RPC/SWQoS/Jito, maker health, receipt indexing, alerts, and
  guardian/multisig runbooks.
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
