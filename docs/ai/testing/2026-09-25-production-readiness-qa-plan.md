---
phase: testing
title: Seller Desk and Liquidation production-readiness QA plan
version: 1.0.0
status: draft
date: 2026-09-25
canonical_spec: https://github.com/mangekyou-labs/katon/issues/16
---

# Production-readiness QA plan — v1.0.0

This is the scripted staging QA plan and result record for the Seller Desk. The
canonical behavior and acceptance criteria remain [issue #16](https://github.com/mangekyou-labs/katon/issues/16).
This plan records evidence against that contract; it does not change it, certify
production readiness, or authorize an Execution Surface.

## Run identity

Complete this block before each run. A result without a complete identity is
`incomplete` and cannot support readiness.

| Field | Required value |
| --- | --- |
| QA plan version | `1.0.0` or the exact later version used |
| Canonical spec revision | Issue #16 body SHA-256 and retrieval time |
| Release candidate | Source revision; build and deployment IDs; container, web, API, and program hashes |
| Policy identity | Signed deployment, asset, issuer, venue, registry, Reference Policy, and retention manifest versions and hashes |
| Environment | Staging name, cluster, RPC identities, and observation-path administrators |
| Test identities | Seller, Private Maker, and Operator staging identities; no production secrets in the record |
| Run window | UTC start and end times |
| Product owner | Name, role, decision, signed timestamp, and evidence links for that role only |
| Findings | Finding IDs, severity, owner, rationale, due date, disposition, and evidence |

Record artifact hashes and source identities directly. Do not substitute a local
build, synthetic local asset, ungoverned source, or local RPC result for the
staging release candidate. No wallet signature or transaction may use a
production Seller or production funds during this QA plan.

## Shared staging preflight

1. Read issue #16 and record the exact body hash, including any approved
   amendment. Record this plan version and the candidate identity above.
2. Confirm the target is the designated staging environment and that the
   supported test wallet, test xStock, and test stablecoin are staging-only.
   Confirm no Mainnet signing or submission can occur from the test session.
3. Confirm the observed candidate is the one deployed to staging by comparing
   its source revision, artifact hashes, signed manifests, and deployment ID.
4. Confirm the staging Reference Policy is live and versioned, its independent
   cross-check is available, and no DEX observation is being used as a fallback.
5. Confirm both a real Jupiter candidate and a governed, enabled Private Maker
   candidate are available for the eligible asset and selected output. Record
   each source identity and governance evidence. If either is absent, stop the
   affected Seller route run and record a blocker.
6. Confirm two administratively independent RPC observation paths and the
   reviewed delivery policy are configured. Record the path identities without
   credentials.
7. Confirm the Seller Desk and Liquidation Execution start in their separately
   recorded modes. Passing this plan never enables either surface.

## Seller product-owner run

Use a supported Wallet Standard test wallet in a supported staging browser and
device combination. Complete every step and attach browser evidence, API
observations, and independent RPC observations to this result.

1. Open `/trade`, connect the test wallet, and verify the displayed cluster and
   wallet address. Try a wrong-cluster wallet session; it must be blocked before
   authorization or submission.
2. Inspect asset discovery. An eligible registry-approved xStock is selectable
   with its exact balance and selected native USDC or USDT output. A disabled
   or unsupported holding is informational with a reason and cannot enter a
   Quote Sprint. An ineligible, stale, conflicting, closed, or unknown
   Reference Policy state cannot collect quotes.
3. Enter an exact atomic input and start a Quote Sprint. Confirm the Sprint
   includes the approved xStock, selected output, live Reference Policy version,
   and both healthy source classes. Confirm the displayed result ranks only
   independently simulated exact-input full fills by net stable atomic units.
4. Complete a Private Maker winning-route run. Compare the frozen pre-sign
   Review with the candidate and record the exact message hash, seller debit,
   maker credit, stablecoin gross, governed fee rate and amount, Seller net
   minimum, fee payer, expiry, cluster, and simulation. The fee shown in Review
   must match the governed fee exactly (10 bps at the current default), with no
   second venue fee. Sign only the reviewed message. After confirmation,
   compare the receipt to the same terms, FillReceipt, signature, slot, and
   independently observed account deltas.
5. Complete a separate Jupiter winning-route run. Verify the returned winner
   bytes remain unchanged from the venue response, the Katon fee is zero, and
   the receipt derives its status and transaction identity from the venue and
   independent RPC observations.
6. In a controlled staging fault scenario, allow the sender to accept a
   transaction and drop the response. Verify one durable Execution Attempt,
   `reconciling` status, independent observation without a blind resend, and no
   replacement Quote Sprint until the attempt reaches a terminal result. Verify
   the final private activity record and receipt are wallet-scoped and truthful.
7. Open review and activity with a second Seller identity and with an
   unauthenticated session. Verify neither can read or mutate the first
   Seller's resources. Verify public Sprint events contain only sanitized
   information.
8. Check keyboard-only operation, visible focus, reduced motion, target size,
   and the supported accessibility/browser/device matrix. Record any
   noncritical usability finding separately with an owner, rationale, and due
   date.

**Expected Seller result:** every mandatory Seller acceptance and safety check
passes for the exact staging candidate; Private Maker fee and receipt reconcile;
Jupiter bytes and zero-fee receipt reconcile; ambiguous execution resolves
without resend or double sale; role isolation and the supported experience
matrix pass. Any failed mandatory criterion or safety requirement blocks
Seller Desk readiness. The earlier Seller `ACCEPT` remains historical evidence
for its original 1.0 localnet walkthrough. The corrected local 0.1 fee
screenshots are technical evidence only until a Seller product owner reviews
the corrected flow under this plan.

## Private Maker product-owner run

1. Sign in as the staging Private Maker and open its gated dashboard. Confirm
   the source identity, governance status, advertised capabilities, health,
   outcomes, and own fills.
2. Confirm provisioning alone leaves the source disabled and unable to receive
   Quote Sprints. Confirm advertisement or an availability change cannot enable
   the source. Verify the source becomes eligible only after the separate
   delayed Squads action for that exact source is observed.
3. Advertise a supported asset, output, size range, and availability; then
   self-disable. Verify the source stops receiving new Sprints while prior
   attempts retain truthful status.
4. For a governed enabled source, submit a quote and partially sign the exact
   expiry-bound frozen transaction. Verify the maker dashboard binds the quote
   to that message and refuses a changed message, signer, amount, mint,
   account privilege, or expired blockhash.
5. Inspect dashboard history as this Maker, another Maker, and a Seller. The
   Maker sees only its own health, quotes, rejections, wins, fills, and receipts;
   it cannot see Seller-private balances or another Maker's data. Seller and
   other-Maker credentials cannot read this Maker's private history.

**Expected Private Maker result:** source enablement is governed separately
from provisioning and availability; the maker can serve only valid governed
quotes; frozen authorization and expiry checks hold; all dashboard data is
maker-scoped. A failed mandatory criterion or safety requirement blocks the
Private Maker staging result and any dependent Seller readiness.

## Operator product-owner run

1. Sign in with the staging Operator role and inspect source health, Reference
   Policy and registry versions, release-gate status, execution modes, recent
   attempts, and sanitized receipts. Verify there are no reusable credentials,
   losing quote payloads, or Seller-private data in the console.
2. Disable a source. Verify the source stops receiving new Quote Sprints
   immediately and its unavailable reason is visible. Verify the operator
   cannot re-enable it through the same command.
3. Stop new Quote Sprints. Verify new collection is rejected while existing
   attempts remain reconcilable. Exercise the documented recovery view and
   verify it shows a truthful terminal state before another Seller attempt can
   proceed.
4. Inspect governance queues and guardian status in read-only mode. Verify the
   Operator role cannot impersonate Squads, apply a delayed change, unpause,
   change fee or registry policy, expand authority, or enable either execution
   surface. Confirm an observed pause prevents already-issued settlement from
   landing.
5. Review the audit trail for both stop actions. Verify actor, scope, time,
   reason, resulting state, and evidence are retained without credentials or
   reusable transaction bytes.

**Expected Operator result:** immediate stop controls and read-only operational
visibility work, and the role cannot expand authority or enable execution.
Failure of a mandatory control or safety requirement blocks the Operator
staging result and Seller Desk readiness.

## Liquidation demonstration and shadow evidence

Record Liquidation Execution separately from Seller Desk readiness.

1. Research candidate tokenized-stock lending markets and identify the exact
   lender, market, reserves, collateral and debt assets, oracle, venue, upgrade
   authorities, IDLs, lookup tables, and solver version. If no trustworthy
   eligible market is found, Liquidation Execution remains `absent`; Seller
   Desk status is unchanged.
2. Select and justify one representative Devnet environment or a pinned
   mainnet-state fork. If Devnet is unsuitable, record why and use pinned fork
   evidence for readiness. A capped Mainnet trial may happen only after a
   separate Liquidation Squads enablement action.
3. Observe opportunities through authoritative lender discovery without
   sending transactions. Verify stale, missing, mismatched, or drifted market
   and oracle identities force `read_only` or `absent` as specified.
4. Simulate the complete atomic liquidation, unwind, repayment, fee/profit, and
   zero-residual path. Inject failure at each leg and verify full rollback, zero
   residual stock, and the required breaker response. Verify compute, size,
   blockhash, RPC disagreement, adverse execution, residual, and safety-store
   breakers prevent submission.
5. Run the prospective shadow for seven qualifying days and at least 20
   representative opportunities. Record immutable opportunity inputs before
   outcomes are known. Require at least 95% agreement, zero
   predicted-executable/simulation-rejected outcomes, and zero atomicity or
   residual mismatches. Apply the spec's reset rules; do not cherry-pick or
   replay observations.
6. Produce the Liquidation pre-enable evidence bundle separately. Verify a
   Liquidation-specific failure leaves Seller Desk evidence, enablement, and
   runtime health unchanged.

**Expected Liquidation result:** evidence supports only the selected
environment and exact reviewed identities; discovery, atomicity, rollback,
breakers, and shadow thresholds pass before Liquidation is ready for
enablement. A Liquidation failure never changes Seller Desk status. Readiness
does not perform the later Squads enablement action.

## Finding and result rules

- A failed mandatory acceptance criterion or safety requirement is a readiness
  blocker for the affected surface. Record the exact criterion, evidence, and
  failure effect; do not mark the affected product-owner result as passing.
- Record a noncritical usability finding with a unique ID, affected journey,
  observed behavior, rationale for noncritical classification, named owner,
  concrete due date, and disposition. It remains visible in the result and
  bundle.
- Each result is independently `incomplete`, `passing`, `failed`, or `blocked`.
  A Seller result cannot stand in for a Private Maker or Operator result.
- `Ready for enablement` means the applicable evidence gates pass and a bundle
  is prepared for separate governance review. It does not mean enabled or
  transaction-producing. Seller Desk and Liquidation Execution have independent
  status, evidence, and Squads actions.

### Finding record template

| Field | Value |
| --- | --- |
| Finding ID and version |  |
| Surface and role |  |
| Severity and status |  |
| Acceptance criterion / safety requirement |  |
| Observation and reproduction steps |  |
| Evidence links and hashes |  |
| Owner |  |
| Rationale and compensating control |  |
| Due date (UTC) |  |
| Disposition and approver |  |

### Seller product-owner result — separate record

- Status: `incomplete` (not reviewed)
- Product owner, decision, signed time:
- Run identity: complete Run identity block above
- Scenarios and criteria reviewed:
- Findings and evidence links:
- Decision: `pass` / `fail` / `blocked`, with rationale:

### Private Maker product-owner result — separate record

- Status: `incomplete` (not reviewed)
- Product owner, decision, signed time:
- Run identity: complete Run identity block above
- Scenarios and criteria reviewed:
- Findings and evidence links:
- Decision: `pass` / `fail` / `blocked`, with rationale:

### Operator product-owner result — separate record

- Status: `incomplete` (not reviewed)
- Product owner, decision, signed time:
- Run identity: complete Run identity block above
- Scenarios and criteria reviewed:
- Findings and evidence links:
- Decision: `pass` / `fail` / `blocked`, with rationale:

## Known open readiness findings

These are evidence gaps from the current record, not claims that a staging run
has failed. Keep them open until the named evidence exists.

| ID | Surface | Finding | Severity/status | Owner | Rationale / closure evidence |
| --- | --- | --- | --- | --- | --- |
| QA-OPEN-001 | Seller Desk | Corrected 0.1 fee Review and receipt screenshots have no fresh human Seller product-owner review. | Blocker / open | Seller product owner | Required staging walkthrough and signed result under this plan; the earlier 1.0 localnet acceptance remains historical. |
| QA-OPEN-002 | Seller Desk | Production xStock, live Reference Policy, real Jupiter, and governed Private Maker candidate evidence is incomplete. | Blocker / open | Seller Desk release owner | Record signed source, asset, Reference Policy, venue, registry, and deployment identities and pass both route scenarios. |
| QA-OPEN-003 | Seller Desk | Independent production transaction delivery and reconciliation evidence is incomplete. | Blocker / open | Operations release owner | Pass reconciliation, ambiguous submission, recovery, and independent RPC observation gates for the exact candidate. |
| QA-OPEN-004 | Seller Desk | Devnet Squads provenance and bundle-bound delayed-governance evidence remain open. | Blocker / open | Governance release owner | Reuse [issue #19](https://github.com/mangekyou-labs/katon/issues/19); bind the exact accepted Seller bundle hash to a separate delayed action before enablement. |
| QA-OPEN-005 | Liquidation Execution | Eligible reviewed market, selected environment, demonstration, and seven-day/20-opportunity shadow evidence are incomplete. | Blocker / open | Liquidation release owner | Complete the independent Liquidation path; a failure does not change Seller Desk status. |

## Version history

| Version | Date | Change |
| --- | --- | --- |
| 1.0.0 | 2026-09-25 | Initial scripted staging plan and separate product-owner result records. |
