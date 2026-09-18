# Playwright CLI + MetaMask QA (Base)

This runbook is the M6 operator path for the Base tokenized-stock desk. Base
Sepolia is authoritative for chain gating, deployed core runtime bytecode,
native Circle USDC, and a real deposit. An isolated local Anvil profile proves
the complete LP-won liquidation route against explicitly classified mocks.
Mocks are test infrastructure, never evidence that a production lending venue
exists.

Do not use this workflow for Base mainnet. Do not reuse the Flare profiles or
commands in `docs/qa-playwright-metamask.md`.

## Prerequisites and secret file

Install project and browser dependencies. Node.js 22+ is required by
dappwright.

```bash
npm ci
npm run qa:browser:install
npm run qa:cli:install-browser
forge build --root contracts/base
```

Create the ignored `.env.base-qa.local` file yourself. It is the only file
from which the Base QA tools read wallet material:

```dotenv
BASE_QA_MNEMONIC="twelve-or-more words for one disposable QA wallet only"
BASE_QA_PASSWORD="a disposable password of at least twelve characters"
BASE_QA_KEEPER_SECRET="a local HMAC secret for the Anvil keeper fixture"
BASE_SEPOLIA_RPC_URL="https://sepolia.base.org"
BASE_FORK_RPC="https://your-pinned-Base-mainnet-RPC.example"
BASE_ANVIL_RPC_URL="http://127.0.0.1:8545"
BASE_QA_DAPP_URL="http://127.0.0.1:5174"
BASE_QA_API_URL="http://127.0.0.1:4010"
```

Never use a production seed. The tools derive operator, depositor, and LP
public addresses at indices 0, 1, and 2. Private keys, the mnemonic, and the
MetaMask password are not printed, written to public account files, or passed
to the API or Vite processes. The API receives only its non-wallet HMAC bot
credential for the local keeper fixture.

## Funding preflight

Validate first. This reports the derived public addresses and exact ETH and
six-decimal USDC deficits without persisting wallet material:

```bash
npm run qa:base:validate -- --target=sepolia
```

Fund only the reported disposable addresses. The operator needs Base Sepolia
ETH for deployment and wiring. The depositor needs Base Sepolia ETH plus
native Circle USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
The LP does not need Sepolia USDC because Sepolia intentionally has no pinned
B20 liquidation venue.

For Anvil, `BASE_FORK_RPC` must serve Base mainnet block `51,068,301` with
hash `0x81ceda4cb39bf70b057c08dc2d70b201b5190ecb8ebb79ccdca3e12b1d73ea41`.
The stack forks that block onto loopback chain `8453`, keeps the upstream RPC
credential out of child environments, and uses the real Base USDC contract:

```bash
npm run qa:base:stack -- --target=anvil
npm run qa:base:validate -- --target=anvil
```

## Candidate deployment and release evidence

Build and deploy Base Sepolia only after the funding preflight is clear. The
deployment resumes from ignored checkpoints, waits for receipts, and refuses
loopback, the wrong chain, or Base mainnet. Sepolia deployment is candidate
only: it writes neither the public manifest nor a public deployment directory.

```bash
npm run deploy:base:sepolia
npm run smoke:base:sepolia
npm run qa:base:stack -- --target=sepolia
```

The candidate manifest and checkpoint are
`output/base-qa/sepolia/candidate-manifest.json` and
`output/base-qa/sepolia/candidate-checkpoint.json`. The 35-check smoke writes
`output/base-qa/sepolia/smoke-proof.json`, including the candidate SHA-256
digest. The Sepolia manifest has an empty adapter list and
`productionEligible: false` because its policy, oracle, and sequencer
dependencies are explicitly labeled mocks. The Sepolia QA stack consumes this
candidate automatically; it must not be pointed at
`contracts/base/deployments/sepolia.json` before promotion.

After the headed depositor flow has produced a native-USDC approval and a
facility deposit with positive assets and increased shares, verify both on-chain
events and write the credential-free proof. Passing transaction hashes may be
provided explicitly to avoid selecting unrelated events:

```bash
npm run qa:base:deposit -- \
  --candidate output/base-qa/sepolia/candidate-manifest.json \
  --approval-tx 0x<approval-transaction-hash> \
  --deposit-tx 0x<deposit-transaction-hash>
```

Promotion is the only command that may create the public Sepolia manifest. It
rechecks the candidate digest, chain `84532`, expected operator/depositor/LP
accounts, 35-check smoke proof, native-USDC `Approval`, facility `Deposit`,
positive assets/shares, and share growth before atomically writing
`contracts/base/deployments/sepolia.json`:

```bash
npm run promote:base:sepolia
```

Missing, mismatched, or invalid evidence fails with stable `BASE_QA_*` errors;
the public manifest remains absent or unchanged. Never copy a candidate or
Anvil manifest into the public path manually.

The Anvil stack launches a loopback-only Base-mainnet fork at chain ID 8453,
checks the pinned block/hash, native USDC, and Anvil debug RPCs, then deploys
classified control fixtures plus real Base venue adapters and fork-created
Morpho/Euler scenarios. Its ignored manifest is written to
`output/base-qa/anvil.json`; `productionEligible` remains false.

## Create the two isolated profiles

With each target stack running in its own terminal, initialize the profiles:

```bash
npm run qa:base:setup -- --target=sepolia
npm run qa:base:setup -- --target=anvil
```

The fixed profiles are `.playwright/base-sepolia-profile` and
`.playwright/base-anvil-profile`; extensions, public account summaries, and
CLI configurations use the same target prefix. Evidence belongs under
`output/playwright/base-sepolia` and `output/playwright/base-anvil`.

### MetaMask 13.17 account-cell contract

The wallet helper creates the next SRP child only through the current account
cell UI. It opens `account-menu-icon`, counts `.multichain-account-cell`, clicks
`add-multichain-account-button`, waits for the last cell to become visible, and
requires the count to increase by exactly one. It then opens
`multichain-account-cell-end-accessory`, selects the exact `Rename` label, fills
`account-name-input`, confirms with `Confirm`, and selects the new last cell.
Existing roles are selected by deterministic account-cell index: operator `0`,
depositor `1`, LP `2`. Validation failures use stable codes such as
`BASE_QA_ACCOUNT_COUNT`, `BASE_QA_ACCOUNT_INDEX`, and
`BASE_QA_STANDARD_WALLET_FORBIDDEN`.

This flow does not evaluate extension DOM, import private keys, import an SRP
child, or fall back to obsolete Add-wallet controls. Never capture onboarding,
unlock, recovery, account-export, or any other wallet-secret surface.

## CLI-first headed Sepolia walk

Open the Sepolia dApp in the named session. Use fresh snapshots to obtain
element references; never copy refs from this runbook.

```bash
npm run qa:cli -- --config .playwright/base-sepolia-cli.config.json -s=base-sepolia-depositor open http://127.0.0.1:5174 --headed
npm run qa:cli -- -s=base-sepolia-depositor snapshot
```

Only after MetaMask onboarding/unlocking is complete, select the dApp tab and
begin artifact capture. Prove a wrong-network rejection, switch to `0x14a34`,
connect account index 1 (depositor), approve the exact native-USDC deposit,
submit it, and record the receipt plus the increased facility share balance.
The on-chain approval/deposit proof must be tied to the candidate digest before
promotion. On `/liquidations`, record that deposit remains enabled while bid
and route controls are disabled with the stable reason
`VENUE_MANIFEST_UNAVAILABLE`.

### Smart-account and relayer receipt semantics

MetaMask smart-account or delegated-account transactions may be submitted by a
relayer. The outer receipt `from` is therefore audit metadata and may differ
from the configured depositor. Deposit-proof schema version `1` optionally
records a normalized `receiptFrom` field; no CLI flag or public interface
changes. Authorization is unchanged and remains log-based: candidate-bound
native-USDC `Approval.owner`, facility `Deposit.sender`, and `Deposit.owner`
must equal the depositor; the spender and facility must match; values must be
positive and sufficient; approval must precede deposit; and the facility share
balance must increase. Explicit transaction hashes and successful receipts are
still required. A mismatched event owner/sender/spender or non-positive share
delta fails closed even when the outer receipt sender is a relayer.

Capture dApp-only snapshots and screenshots after each checkpoint:

```bash
npm run qa:cli -- -s=base-sepolia-depositor snapshot
npm run qa:cli -- -s=base-sepolia-depositor screenshot
```

## CLI-first headed Anvil LP-won walk

Keep this session separate from Sepolia:

```bash
npm run qa:cli -- --config .playwright/base-anvil-cli.config.json -s=base-anvil-lp open http://127.0.0.1:5174 --headed
npm run qa:cli -- -s=base-anvil-lp snapshot
```

Seed exactly one RFQ through the authenticated local keeper endpoint. Confirm
the UI is reading live Anvil snapshots containing one fresh floor and the mock
B20/oracle stack. Connect account index 2 (LP), sign the RFQ-bound EIP-712 bid,
finalize it as the winner, review the winner-only typed route, approve the
exact six-decimal USDC requirement, submit, and record the LP's increased mock
B20 balance. Label every capture `ANVIL_MOCK`; it is execution-path evidence,
not venue evidence.

Run the deterministic authenticated seed after the Anvil stack reports
`base-qa-stack=READY`:

```bash
npm run qa:base:seed -- --target=anvil
```

The command reads the keeper HMAC secret from `.env.base-qa.local`, posts one
RFQ, and writes only its public request/result to
`output/playwright/base-anvil/seed.json`.

To prove named-session profile locking, leave `base-anvil-lp` open and attempt
a second named session with the same config. Record the expected profile-lock
failure, close the attempted session, and continue only in the owner session.

## Artifact scan and cleanup

Do not capture MetaMask onboarding, unlock, recovery, or account-export pages.
After dApp evidence is complete, close each CLI session, validate (which scans
textual artifacts for the exact mnemonic/password and wallet-secret labels),
review every screenshot, snapshot, receipt, smoke proof, and deposit proof,
then remove both disposable profiles:

```bash
npm run qa:cli -- -s=base-sepolia-depositor close
npm run qa:cli -- -s=base-anvil-lp close
npm run qa:base:validate -- --target=sepolia
npm run qa:base:validate -- --target=anvil
npm run qa:base:cleanup -- --target=sepolia
npm run qa:base:cleanup -- --target=anvil
```

Cleanup has fixed Base-only targets and preserves the ignored evidence
directories. Review captures before reporting E2E-MM-1 through E2E-MM-7. Do not
report T6.2, T6.3, or M6 from local Anvil or injected-provider evidence alone.

## M5 validation checkpoint — 2026-09-18

The non-extension browser regression is green and covers approval, quote
review, decision-block freshness, and route-only submission. It is labeled
non-extension evidence and does not satisfy the headed MetaMask gate. The
installed `playwright-cli` is available (`npm run qa:cli:help` passes), but
`qa:base:setup -- --target=sepolia` could not finish the MetaMask 13.17.0
download in this environment, so no extension profile or wallet transaction/UI
capture was produced.

The live candidate preflight passes RPC and wallet-shape checks but reports a
1,000,000-unit native-USDC deficit for the disposable QA accounts. The swap
runner also fails closed until the normal LP bot credential is configured. Do
not substitute the keeper secret, mint native USDC, or create a synthetic
`swap-proof.json`; after funding and bot configuration, rerun the exact canary,
then the headed CLI flow and promotion gate.

## Recovery

- Profile already exists or is locked: close every CLI session for that
  target, run its `qa:base:cleanup`, then rerun setup. Never delete an
  unrelated Chromium profile.
- Wrong chain or unavailable RPC: rerun target validation and compare the
  reported chain ID with 8453 for Anvil or 84532 for Sepolia before reopening
  MetaMask.
- Partial Sepolia deployment: rerun `deploy:base:sepolia`; it verifies and
  resumes its ignored checkpoint instead of guessing deployed addresses.
- Missing or stale candidate: redeploy the matching target. Never copy an
  Anvil or candidate manifest into the public Sepolia deployment path.
- Failed or replaced transaction: retain the receipt/error artifact, verify
  the operator nonce and funding, then resume deployment. Do not edit a
  checkpoint to manufacture success.
- Artifact scan failure: quarantine the evidence, close and clean the profile,
  and repeat onboarding and capture with dApp-only snapshots. Do not redact a
  leaked seed and call the same run valid; rotate the disposable wallet.
