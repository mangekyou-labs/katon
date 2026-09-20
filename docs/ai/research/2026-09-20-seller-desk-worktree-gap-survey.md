# Survey: Seller Desk worktree vs canonical spec

- **Date:** 2026-09-20
- **Worktree:** `feature-solana-tokenized-stock-desk`
- **HEAD:** `3c61b9d092d078f391ba861b85b731f0ec7ef84a` (`research/local-devnet-seller-qa-harness`)
- **Dirty:** yes — 20 modified files (~949 insertions / 1991 deletions) plus 8 untracked files. Notable paths:
  - Modified: `apps/solana-api/src/{server,service,sources}.ts`, `apps/solana-web/src/App.tsx`, `contracts/solana-rfq/programs/solana-rfq/src/lib.rs`, `packages/solana-core/src/{index,quote,ranking,types,venues}.ts`, `packages/solana-sdk/src/transactions.ts`, `services/solana-liquidator/src/{manifest,solver,startup}.ts`, `src/solana-tokenized-stock.test.ts`, `docs/domain/solana-tokenized-stock-desk/CONTEXT.md`, plus historical `docs/ai/{design,planning,requirements,testing}/2026-09-15-feature-solana-tokenized-stock-desk.md`
  - Untracked: `contracts/solana-rfq/programs/solana-rfq/src/{errors,governance,registry,settlement,state,tests,transfer_hook}.rs`, `packages/solana-core/src/transactions.ts`
- **Canonical contract:** [GitHub issue 16](https://github.com/mangekyou-labs/katon/issues/16) (`Canonical Seller Desk full specification`, `ready-for-agent`, open; body surveyed from `/tmp/canonical-seller-desk-spec.md`, live metadata confirmed 2026-09-20)
- **Ticket:** Survey Seller Desk worktree gaps against the canonical spec
- **Scope:** Survey only. Does not implement, enable, stash, commit, reset, or discard working-tree changes.

Working-tree line citations below describe the **dirty tree** unless marked HEAD-only. Uncommitted-only improvements are **not** credited as Satisfies at HEAD.

## Method

Primary sources, in authority order:

1. Canonical spec issue 16 (sole behavioral contract).[^spec]
2. Worktree source at HEAD `3c61b9d` **and** the dirty working tree (explicitly distinguished).
3. Domain glossary `docs/domain/solana-tokenized-stock-desk/CONTEXT.md` (terminology only).[^context]
4. ADRs 0001–0006 in `docs/domain/solana-tokenized-stock-desk/docs/adr/`.[^adr0001][^adr0002][^adr0003][^adr0004][^adr0005][^adr0006]
5. Map notes issue 9 and closed harness decision issue 11 (interactive QA is offline Surfpool; Jupiter is a spec-faithful stub; mock API is **not** the accept loop).[^issue9][^issue11]

Inspected: `apps/solana-web/src/App.tsx` and `package.json`; `apps/solana-api/src/{server,service,sources,registry}.ts`; `packages/solana-core/src/{quote,ranking,types,venues,registry,issuers,eligibility,index}.ts` and untracked `transactions.ts`; `packages/solana-sdk/src/{wallet,transactions,api,index}.ts` and `package.json`; `contracts/solana-rfq/programs/solana-rfq/src/{lib,settlement,governance,registry,state,tests}.rs`; `services/solana-liquidator/src/{startup,solver,manifest}.ts`; `src/solana-tokenized-stock.test.ts`; root `package.json` scripts. Grepped for Ondo, liquidation, demo wallet, mock, Wallet Standard, `signTransaction`, transfer fee, Reference Policy, quote sprint, expiry, Squads, guardian, Jupiter.

Historical `docs/ai/{design,planning,requirements,testing}/2026-09-15-*.md` dossiers are **non-canonical** after issue 16 and were not used as behavioral evidence.[^spec]

Classification is exclusive per finding: **Satisfies** / **Violates** / **Incomplete**. Mixed areas take **Violates** when forbidden behavior is present, else **Incomplete** when a required behavior is missing.

## Executive verdict

The dirty `feature-solana-tokenized-stock-desk` worktree is a **LOCAL MOCK MODE Seller Desk prototype**, not a spec-faithful accept loop. Ranking constants, losing-payload drop, pause-only guardian instruction, 24h delay constant, FillReceipt PDA seeds, and liquidation **startup** fail-closed are real partial matches; they do not make the Seller journey compliant. The Seller UI still treats **enabled Ondo** (`ondo-demo-MSFT-mint`) as executable inventory, connects a hardcoded **demo wallet** instead of Wallet Standard, identity-signs issued bytes, and labels mock settlement as a completed exit. The API still exposes `/v1/quote-sessions` (not `quote-sprints`), durable `reviewing` (not immutable `winner_ready`), and a `MockSender` that returns `mock-…` signatures without RPC. Mock wire bytes are **legacy** (`[1,0,1]`), labeled `v0`. The program copies Squads **member keys** into state, uses `transfer_checked` rather than `transfer_checked_with_fee` expected 0, and does not bind `issued_at`. Uncommitted work adds a strict parser, Ed25519 verify, real-looking `DEMO_WALLET` base58, and Jupiter zero-fee ranking — none of which exist as Satisfies at HEAD `3c61b9d`, and none of which close the mock/Ondo/Wallet Standard gaps. Liquidation Execution is **not live in the Seller accept loop**, but it is also **not independently gated** as an Execution Surface (`absent` / `read_only` / `transaction_producing` plus delayed Squads). Issue 11 remains the harness decision: this mock API is not the Seller QA accept loop.

## Coverage table

| Area | Status | Evidence |
| --- | --- | --- |
| Seller journey and copy (incl. executable Ondo + mock settlement) | **Violates** | Fallback and registry list enabled Ondo as `eligible`; selector option “Ondo”; Ops cards “xStocks · Ondo”; mock settlement / simulated receipt copy. AC-004 INV-007 JNY-001.[^ac004][^app-ondo][^registry-ondo] |
| Wallet Standard vs demo wallet | **Violates** | `connect()` assigns `DEMO_WALLET` after 250ms; button “Demo wallet”; no Kit/`@solana/react`/`kit-plugin-wallet` in `apps/solana-web`. REQ-001 AC-054.[^req001][^app-connect][^web-pkg] |
| Frozen Private Maker then Seller co-sign | **Violates** | Identity-sign returns issued base64 unchanged; mock tx is legacy header, pre-signed with demo PKCS8; no maker-then-Seller v0 co-sign. INV-001 AC-021–023 ADR-0001.[^inv001][^adr0001][^app-sign][^mock-tx] |
| Exact Input and Token-2022 fees | **Incomplete** (preflight) / **Violates** (program path vs AC-011) | Registry accepts `transferFeeBps === 0` when capability true; never rejects **nonzero** bps. Program uses `transfer_checked`, not `transfer_checked_with_fee` expected 0. INV-002 AC-010–011 ADR-0003.[^adr0003][^registry-fee][^settle-cpi] |
| Reference Policy | **Incomplete** | Eligibility uses signed `referenceState` / `referencePriceAtomic` on the registry entry; no licensed equities authority, no independent fail-closed cross-check, no DEX-fallback test as a live policy service. INV-006 AC-006–008 ADR-0004.[^adr0004][^eligibility] |
| Quote Sprint privacy and expiry | **Mixed → Satisfies (core constants + drop) / Violates (external contract)** | 3s / 15s / 30s / ≤2s remaining and rank sort exist; losers cleared; audit class-level. External API is still `quote-sessions`; review mutates lifecycle. REQ-004–005 AC-013–018 AC-024.[^quote-const][^rank][^service-drop][^api-paths] |
| Operator / governance fail-closed | **Violates** | Program stores `squad_signers: [Pubkey; 3]` and `require_squad_quorum` on two of those keys. Guardian pause-only instruction exists. 24h delay constant exists. INV-009 AC-047–050 ADR-0002.[^adr0002][^gov-init][^guardian] |
| Liquidation Execution ungated or dormant | **Incomplete** (surface model) / **not Seller-ungated** | Seller ticket does not call the solver. Startup withholds solver without signed manifest, markets, and durable safety store. `prepare()` can still return `executable: true` with no Execution Surface mode or delayed Squads enablement. INV-008 AC-060–062 ADR-0005.[^adr0005][^liq-start][^liq-prepare] |
| **Seam 1** eligibility and Asset Capability | **Violates** | Enabled Ondo is `eligible` and selectable; `adapterForIssuer` maps any non-xstocks issuer to Ondo. AC-001–005 INV-007.[^issuers][^app-ondo] |
| **Seam 2** Reference Policy and registry/preflight | **Incomplete** | Fingerprint/pause/confidential/permanent-delegate checks exist; licensed policy + independent cross-check + nonzero-fee reject + `transfer_checked_with_fee` do not. AC-006–012.[^eligibility][^registry-fee] |
| **Seam 3** Quote Sprint collection, rejection, ranking, privacy, expiry | **Violates** (AC-018) / **Satisfies** (timing + rank + privacy drop) | Concurrent collection with `QUOTE_SPRINT_MS`; rank drops failed sim/expiry; `candidates = []` after rank. Paths are `quote-sessions`. AC-013–020.[^collect][^api-paths] |
| **Seam 4** immutable winner review and authorization | **Violates** | Durable `reviewing` / `signing` / `submitting` on `QuoteSessionState`; UI `review()` sets `reviewing`; no `winner_ready`, no authorize-by-identical-message resource. AC-021–025 REQ-006.[^types-state][^service-review] |
| **Seam 5** Private Maker settlement | **Incomplete** | FillReceipt PDA `[b"fill", maker, quote_id]`, seller payer, `MAX_FEE_BPS=25`, Ondo generic settlement rejected in program tests. Missing: `issued_at` window, exact maker stock delta, fee-aware CPI, receipt-first field write vs AC-030 intent. AC-026–034.[^lib-pda][^settle-expiry][^tests-ondo] |
| **Seam 6** Jupiter execution | **Incomplete** | `assertJupiterPayloadUnchanged` exists (dirty tree uses parser). `MockJupiterSource` is not a spec-faithful stub; labeled v0, emits legacy; `MockSender` does not land. AC-035–037 REQ-015 issue 11.[^jupiter-assert][^mock-tx][^issue11] |
| **Seam 7** Execution Attempt submission, ambiguity, reconciliation, receipt | **Incomplete** | No Execution Attempt resource, no idempotency key, no `reconciling` / `not_landed`, mock signature, no cluster-aware Solscan link. AC-039–044 REQ-008–009.[^mock-send][^api-sdk] |
| **Seam 8** operator, governance, pause, recovery | **Violates** | Squads member keys copied; no vault-PDA-only signer; Ops UI is a gated **placeholder** (no disable-source / stop-sprints API). AC-046–053.[^gov-init][^ops-ui] |
| **Seam 9** seller, Private Maker, and operator journeys | **Violates** | Seller journey is mock + “Trade” nav + demo wallet. Maker/Ops pages are placeholders that still name Ondo and liquidation. JNY-001–003 AC-054–056.[^app-copy][^ops-ui] |
| **Seam 10** Liquidation Execution as independently gated Execution Surface | **Incomplete** | Fail-closed startup and circuit breaker exist; no `mode`/`enablement`/`evidence`/`health` axes; passing test gates construct a solver. AC-060–062.[^liq-start][^liq-prepare] |
| **Seam 11** retention, redaction, and audit | **Satisfies** (partial) | `sanitizeAudit` copies class-level rows; losing candidates dropped; audit drawer copy claims privacy. No retention/redaction policy for logs/SSE beyond that. AC-016 INV-010.[^sanitize][^audit-ui] |
| **Seam 12** release-evidence and runtime-health transitions | **Incomplete** | No four-layer model (immutable evidence / readiness / Squads enablement / runtime health). Passing tests never auto-enable Seller Desk execution (there is no enablement bit). Liquidation solver construction is the closest auto-enable. AC-072 AC-078 AC-080.[^spec-seams] |

## Satisfies

These match the spec in the dirty tree. Several already existed at HEAD `3c61b9d`; callouts note uncommitted-only items.

1. **Quote Sprint timing constants.** `QUOTE_SPRINT_MS = 3_000`, private default 15s, hard max 30s, `MIN_REVIEW_REMAINING_MS = 2_000`.[^quote-const] Spec REQ-004 REQ-005 AC-013 AC-015. Present at HEAD.

2. **Ranker ordering and floors.** Ranker requires Exact Input mint/amount/wallet match, native stable output, `transactionVersion === 'v0'`, lifetime ≤30s, `expiresAtMs - now ≤ 2_000` → `expired`; sort net desc / remaining validity / reliability / source ID.[^rank] Spec AC-014. Present at HEAD (Jupiter `katonFeeBps !== 0` reject is **uncommitted-only**).

3. **Default private fee 10 bps, cap 25 bps.** `DEFAULT_KATON_FEE_BPS = 10`, `MAX_KATON_FEE_BPS = 25`; program `MAX_FEE_BPS = 25`.[^quote-const][^lib-pda] Spec REQ-007 AC-027. Present at HEAD.

4. **Losing-maker privacy after ranking.** `stored.candidates = []` and `verifiedSourceBalances = {}` after rank; `sanitizeAudit` copies `sourceClass` / net / timestamp / rejection only; UI audit drawer states losing payloads stay private.[^service-drop][^sanitize][^audit-ui] Spec AC-016 INV-010. Present at HEAD.

5. **Unknown JSON fields rejected on create.** `parseRequest` rejects unknown keys; amounts must be strings.[^server-parse] Spec AC-017. Present at HEAD.

6. **Pause-only guardian instruction.** `guardian_pause_asset` sets `paused = true` only.[^guardian] Spec AC-050 INV-009. Present at HEAD (logic lived in monolithic `lib.rs`; dirty tree splits to `governance.rs`).

7. **24-hour governance delay constant.** `GOVERNANCE_DELAY_SECONDS = 24 * 60 * 60`.[^lib-pda] Spec AC-047 INV-009. Present at HEAD.

8. **FillReceipt PDA seeds and seller rent payer.** `seeds = [b"fill", maker.key().as_ref(), quote_id.as_ref()]`, `init, payer = seller`.[^lib-pda] Spec FillReceipt contract / INV-003. Present at HEAD.

9. **Program rejects generic settlement for Ondo.** `validate_generic_settlement_issuer(ISSUER_ONDO)` is asserted `is_err` in program tests.[^tests-ondo] Spec INV-007 (program-side only; **contradicted** by executable Ondo in UI/API). Present at HEAD.

10. **Liquidation startup fail-closed.** `startLiquidationSolver` returns no solver unless signed manifest, market discovery, and durable safety store succeed; tests assert solver undefined on unsigned manifest / missing safety / bytecode drift.[^liq-start][^liq-test] Spec INV-008 AC-060 (startup only). Present at HEAD; dirty tree tightens safety-store requirement.

11. **SDK Wallet Standard adapter requires `signTransaction`.** Rejects `signAndSendTransaction`-only wallets; comments state API must hash-check bytes before forward.[^wallet] Spec REQ-001 INV-001. Present at HEAD. **Unused by Seller UI.**

12. **Jupiter message-unchanged helper.** `assertJupiterPayloadUnchanged` compares serialized messages.[^jupiter-assert] Spec AC-035. Present at HEAD; dirty tree routes through `parseSolanaTransaction`.

13. **Eligibility status vocabulary.** `eligible` / `action_required` / `ineligible` / `unknown`; non-eligible cannot collect when `preflight` fails.[^eligibility] Spec REQ-002 AC-002 (status names). Present at HEAD. **Undermined** because enabled Ondo preflights as `eligible`.

14. **CONTEXT.md Seller glossary (uncommitted-only).** Dirty `CONTEXT.md` adds Seller / Seller Desk definitions matching issue 16 terminology.[^context] Spec language section. **Missing at HEAD** (HEAD CONTEXT lacked the Seller definition lines).

## Violates

Forbidden or contradictory behavior present in the dirty tree. All of these except the noted parser/wallet-string deltas also exist at HEAD.

1. **Executable Ondo leakage (INV-007 / AC-004 / ADR-0006).**  
   - UI fallback inventory: `mint: 'ondo-demo-MSFT-mint'`, `issuer: 'ondo'`, `enabled: true`, `eligibility.status: 'eligible'`, selector `{ticker} · Ondo`, badge “Ondo Global Markets”.[^app-ondo]  
   - API registry duplicates the same enabled Ondo mint.[^registry-ondo]  
   - Server funds `DEMO_WALLET` on `demoAssets[1]` and constructs the desk with `MockOndoManagedSource`.[^server-ondo]  
   - Tests rank an Ondo managed route as executable winner.[^test-ondo-rank]  
   Spec: wallet-held disabled Ondo is informational `Managed Route not enabled` and excluded from selector/collection/ranking/review/execution. Prohibited: executable Ondo.[^ac004][^adr0006]

2. **Demo wallet instead of Wallet Standard identity (REQ-001 / AC-054 / AC-055).**  
   `connect()` waits 250ms then `setWallet(DEMO_WALLET)`. Connected button label is “Demo wallet”. `apps/solana-web/package.json` depends only on `@katon/solana-core` and `@katon/solana-sdk` — no `@solana/kit`, `@solana/react`, or `@solana/kit-plugin-wallet`.[^app-connect][^web-pkg]  
   HEAD used `DEMO_WALLET = 'demo-wallet'` (not even base58). Dirty tree switched to `GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB` — still not Wallet Standard discovery.  
   `WalletStandardAdapter` exists in the SDK, defaults `expectedChain = 'solana:mainnet'`, and `sign()` throws “wallet is not connected to Solana mainnet”. It is never imported by `App.tsx`.[^wallet]

3. **Mock settlement is not frozen v0 maker-then-Seller co-sign (INV-001 / AC-021–023 / ADR-0001).**  
   `signAndExecute` sets `signedTransactionBase64 = session.winner.transactionBase64` (identity signer). Comments admit the local demo does not sign.[^app-sign]  
   `mockTransactionBase64` builds header `Buffer.from([1, 0, 1])` (legacy), not v0 prefix `0x80`, while candidates set `transactionVersion: 'v0'`.[^mock-tx]  
   `MockSender.execute` returns `{ signature: \`mock-${sourceKind}-${quoteId}\`, commitment: 'finalized' }` with no RPC submit.[^mock-send]  
   Review copy: “MOCK FINAL REVIEW”, “Run mock settlement”, “SIMULATED RECEIPT”, “no Solana transaction was submitted.”[^app-copy]  
   Spec: Private Maker partially signs frozen v0 bytes **before** review; Seller `signTransaction` on the identical message; API re-parses, verifies Ed25519, submits **once** to trusted RPC.[^inv001][^adr0001][^issue11]

4. **External contract still `quote-sessions` (AC-018 / REQ-008 / SRC-009 superseded).**  
   API routes, SDK client, and UI types use `/v1/quote-sessions` and `QuoteSession`. No `/v1/quote-sprints`, no Execution Attempt, no authorize resource.[^api-paths][^api-sdk]  
   Spec prohibits `quote-session` as the external contract.[^ac018]

5. **Durable `reviewing` mutates lifecycle (AC-024 / REQ-006).**  
   `QuoteSessionState` includes `reviewing` | `signing` | `submitting`.[^types-state]  
   `review()` requires `ready` then sets `state: 'reviewing'`; `execute()` requires `reviewing`.[^service-review]  
   UI `TicketState` includes `reviewing`; opening review calls `reviewQuoteSession`.[^app-connect]  
   Spec: open review is an audit event only; lifecycle stays `winner_ready` until authorize/expire. There is no `winner_ready` state in this tree.

6. **Squads member keys copied into program state (INV-009 / AC-049 / ADR-0002).**  
   `initialize_governance` writes `governance.squad_signers = squad_signers` (`[Pubkey; 3]`); `require_squad_quorum` checks two of those keys.[^gov-init]  
   Spec/ADR: RFQ recognizes a **Squads vault PDA as sole governance authority** and must **not** copy individual member keys or quorum rules into program state.[^adr0002]

7. **Seller-facing copy uses “Trade” / mock / Ondo (JNY-001 / CONTEXT.md).**  
   Nav `href="/trade"` label “Trade”; empty activity “Start a trade”; eyebrow “PRIVATE EXIT DESK”; lede “local mock exercises the review flow without submitting a transaction.”[^app-copy]  
   CONTEXT.md: avoid Trader / exchange as product terms; Seller Desk is the seller-facing Quote Sprint and settlement flow.[^context]

8. **Ondo adapter is the default non-xstocks issuer (INV-007).**  
   `adapterForIssuer` returns `OndoIssuerAdapter` for any issuer other than `'xstocks'`.[^issuers]  
   Combined with `Issuer = 'xstocks' | 'ondo'` this makes Ondo a first-class executable issuer in core types.[^types-state]

9. **Program settlement vs Exact Input fee-aware path (INV-002 / AC-011 / AC-026 / ADR-0003).**  
   Settlement CPIs are `token_interface::transfer_checked` (stock, stable, fee).[^settle-cpi]  
   Maker stock credit is `>= maker_min_stock_receipt`, not exact debit=credit.[^settle-delta]  
   Expiry check is `expiry >= now && expiry <= now + 30` with **no `issued_at`**.[^settle-expiry]  
   FillReceipt fields are written **after** CPIs (Anchor `init` still creates the account before the handler; AC-030 wants receipt-create-then-CPI with rollback).[^settle-receipt]  
   Spec: zero-fee transfer-fee config uses `transfer_checked_with_fee` expected 0; Clock outside `[issued_at, expiry]` or lifetime >30s fails; stock debit=credit=Exact Input.[^adr0003]

10. **Mock sources reject any wallet except `DEMO_WALLET`.**  
    `requireDemoWallet` throws if `request.wallet !== DEMO_WALLET`.[^mock-tx]  
    Spec Seller identity is the connected Wallet Standard wallet, not a hardcoded mock signer.[^req001]

## Incomplete

Required by the spec; missing in both HEAD and the dirty tree, or present only as a stub/mock that cannot satisfy the AC.

1. **Kit plugins + `@solana/react` + `@solana/kit-plugin-wallet` Seller UI.** Not in `apps/solana-web` or `packages/solana-sdk` dependencies.[^web-pkg][^sdk-pkg] Issue 9 / frontend observation: new Solana frontends use Kit Wallet Standard, not a demo timeout.

2. **Honest frozen-v0 Private Maker partial-sign.** No headless maker that compiles v0 (`0x80`) and `partiallySign` before review. Dirty `mockTransactionBase64` is legacy and demo-pre-signed as a **single** signer.[^mock-tx] ADR-0001.

3. **Spec-faithful Jupiter stub.** Issue 11: Jupiter may be a stub with real v0 bytes, hash-binding, and surfnet submit — never live Ultra `/execute`. `MockJupiterSource` is not that stub.[^issue11][^mock-tx]

4. **Offline Surfpool Seller QA harness.** Root scripts: `dev:solana-api`, `dev:solana-web`, Playwright `qa:cli`. No Surfpool `--offline` Seller loop, no Token-2022 cheatcode provision, no `solana:localnet` chain parameter in the UI.[^root-pkg][^issue11]

5. **`/v1` Quote Sprint / Execution Attempt / Eligibility Assessment / Governance Change resources.** SDK only implements assets, quote-sessions, review, execute, events, trades.[^api-sdk] Spec REQ-008.

6. **Authorize-by-identical-message.** No authorize endpoint; execute accepts identity-signed (or hash-matched) bytes after `reviewing`. AC-022.

7. **Licensed Reference Policy + independent cross-check.** `evaluateEligibility` reads `entry.referenceState` and registry fingerprints. No second observation, no `market_closed` / `conflicting` / `corporate_action_pending` as policy outcomes distinct from issuer session, no live “DEX offered as fallback → still halt” service. AC-006–009 ADR-0004.[^eligibility][^adr0004]

8. **Nonzero Token-2022 transfer fee rejection.** `checkMintAgainstRegistry` requires `transferFeeBps` defined iff capability true; `MemoryAssetProvider` sets `transferFeeBps: 0` when capability true. No `> 0` reject. No test for nonzero fee. AC-010 INV-002 ADR-0003.[^registry-fee][^service-snapshot]

9. **`transfer_checked_with_fee` expected 0.** Missing in `settlement.rs`. AC-011.

10. **`issued_at` in program expiry window.** AC-029. Current check is expiry-only.[^settle-expiry]

11. **Execution Attempt ambiguity / reconciling / not_landed / cluster receipt.** Mock sender fabricates finalized commitment. AC-039–044.

12. **Squads vault PDA as sole authority, delayed queue apply-before-24h-fails, individual member rejected.** Delay constant exists; authority model contradicts ADR-0002. AC-047–049.

13. **Operator fail-closed controls that cannot enable/unpause/fee/registry.** Ops UI is copy-only cards. AC-046 AC-078.

14. **Execution Surface axes** (`mode` absent|read_only|transaction_producing, enablement, evidence, health) for **both** Seller Desk and Liquidation Execution. Passing evidence must not auto-enable. AC-052 AC-060–062 AC-072 INV-008.

15. **External eligibility consumed, not implemented in-product.** REQ-003. Current `evaluateEligibility` **is** in-product registry/preflight. May be acceptable as a local stand-in; it is not the specified external decision service.

16. **Release-evidence bundles and runtime-health transitions** that can stop sprints / suppress sources / set liquidation read-only without enabling. AC-072 AC-078 AC-080.

17. **Strict v0 parser at HEAD.** Untracked `packages/solana-core/src/transactions.ts` accepts only message prefix `0x80` for v0 and also parses **legacy** (used by the mock). HEAD has **no** this file (`git ls-tree HEAD packages/solana-core/src/transactions.ts` empty). Dirty `index.ts` re-exports it. Ranking still only **labels** `transactionVersion === 'v0'` and does not parse the wire prefix, so a legacy mock labeled v0 still ranks.

18. **Ed25519 verify on execute at HEAD.** Dirty `packages/solana-sdk/src/transactions.ts` verifies signatures via SubtleCrypto. HEAD hashed `serializedMessage` only (no signer/signature check). Still unused by the identity-sign UI.

## Uncommitted vs HEAD deltas that change the verdict

Do **not** treat these as Satisfies at `3c61b9d`. None flip the overall “mock, not accept-loop” verdict.

| Delta | HEAD `3c61b9d` | Dirty tree | Verdict impact |
| --- | --- | --- | --- |
| Demo wallet string | `'demo-wallet'` | base58 `GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB` | Still Violates REQ-001. Slightly less fake as a pubkey. |
| Mock payload | `encodeEnvelope` JSON base64 | Legacy Solana-looking bytes `[1,0,1]` + Ed25519 demo key | Still not v0 `0x80`. Ranking `transactionVersion: 'v0'` is now a **label lie** against a parseable legacy message. |
| `packages/solana-core/src/transactions.ts` | **Absent** | Untracked strict parser (legacy + v0 `0x80` only) | Incomplete at HEAD; dirty parser exists but mock does not emit v0. |
| SDK `validateSignedTransaction` | Message hash only | Hash + Ed25519 verify | Incomplete at HEAD; dirty still identity-signs so verify is unexercised by UI. |
| Ranking Jupiter `katonFeeBps` | No `katonFeeBps` policy | Nonzero Jupiter `katonFeeBps` → `policy_failure`; private fee floor | Uncommitted-only Satisfies for REQ-007 Jupiter fee 0. |
| SSE `terminalStates` | omitted `ready` | includes `ready` | Collection stream no longer hangs after winner; does not fix AC-018. |
| `scheduleExpiry` timers | expire-on-touch | unref timeout at `expiresAtMs - 2s` | Uncommitted-only closer to AC-015; still mock. |
| CONTEXT Seller glossary | missing Seller/Seller Desk entries | +4 lines | Uncommitted-only terminology Satisfies. |
| Program module split | monolithic `lib.rs` (~1800 lines) | `governance.rs` / `settlement.rs` / … untracked | Same Squads-member-key and `transfer_checked` behavior. |
| Liquidation safety store required at startup | weaker (dirty adds durable restore) | no solver without `safetyStore` | Uncommitted-only tighter INV-008 startup. Does not add Execution Surface gating. |
| Executable Ondo, `quote-sessions`, `reviewing`, identity-sign, MockOndo source | present | **still present** | No verdict change. |

## Implications for later tickets (no implementation)

Later implementation tickets should treat this worktree as **scaffolding plus some reusable ranking/program constants**, not as a passing Seller Desk.

1. **Do not accept against the mock API.** Issue 11 already closed that decision: interactive QA is offline Surfpool; Jupiter is a spec-faithful stub; mock API is UI-shape only.[^issue11]
2. **Ondo must leave executable inventory** (selectors, fallback, `demoAssets`, `MockOndoManagedSource`, funded balances, ranking tests that expect an Ondo winner) before any Seller accept loop. Informational “Managed Route not enabled” is the only allowed Ondo surface. AC-004 INV-007 ADR-0006.
3. **Wallet Standard is a greenfield UI wiring job** in `apps/solana-web`: Kit plugins + `@solana/react` + `walletSigner({ chain: 'solana:localnet' })`. Reusing `WalletStandardAdapter` as-is is blocked by hardcoded `solana:mainnet`. REQ-001 AC-054–055.
4. **Frozen v0 co-sign is the first honest settlement ticket:** maker partial-sign → Seller `signTransaction` on identical bytes → API parse + Ed25519 → one RPC submit. Identity-sign and `MockSender` cannot be incrementally “turned honest” without replacing the payload and sender. ADR-0001 INV-001.
5. **Rename the external contract** from `quote-sessions` / `QuoteSession` / durable `reviewing` to `quote-sprints` / `winner_ready` / authorize. SRC-009 is superseded; keeping the old names is an AC-018 fail even if ranking is correct.
6. **Governance ADR-0002 vs program is an ADR-first block** if agents implement operator tickets against `squad_signers`. Reconcile vault-PDA-only authority before `ready-for-agent` governance work.[^spec][^adr0002]
7. **Exact Input fee path** is a dedicated program+preflight ticket: reject nonzero `transferFeeBps`; settle zero-fee configs with `transfer_checked_with_fee` expected 0; exact maker stock delta; `[issued_at, expiry]`. ADR-0003 AC-011 AC-026 AC-029.
8. **Reference Policy** is not the registry price field. A later ticket must add licensed authority + independent cross-check and prove DEX cannot restore eligibility. ADR-0004.
9. **Liquidation Execution must stay independently gated and not enabled.** Do not wire Seller review into the solver. Add Execution Surface mode/enablement/evidence/health before any `transaction_producing` path. Passing manifests must not auto-enable. ADR-0005 INV-008 AC-060–062.
10. **Uncommitted parser/Ed25519/fee-ranking/expiry-timers** are useful starting points **if** they are committed as part of an implementation ticket; they do not currently satisfy the accept loop.

## Sources

[^spec]: `/tmp/canonical-seller-desk-spec.md` — GitHub issue 16 body; live `gh issue view 16 --repo mangekyou-labs/katon` (open, `ready-for-agent`, title “Canonical Seller Desk full specification”, updated 2026-09-20). Sole behavioral contract.
[^spec-seams]: Same, “Validation Seams and acceptance criteria” (Seams 1–12, AC-001–AC-080) and invariants INV-001–INV-009, requirements REQ-001–REQ-009.
[^ac004]: Spec AC-004 / INV-007 — disabled Ondo informational only; prohibited executable Ondo.
[^ac018]: Spec AC-018 / REQ-008 / SRC-009 superseded — external language is `quote-sprints`, not `quote-session`.
[^inv001]: Spec INV-001 / Solution paragraph — frozen co-sign envelope; maker partial-sign then Seller identical message.
[^req001]: Spec REQ-001 / Solution — Wallet Standard wallet is Seller identity; no Katon customer account.
[^context]: `docs/domain/solana-tokenized-stock-desk/CONTEXT.md` (dirty tree, including uncommitted Seller / Seller Desk glossary).
[^adr0001]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0001-maker-signs-the-frozen-transaction.md`.
[^adr0002]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0002-squads-vault-is-the-governance-authority.md`.
[^adr0003]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0003-exact-input-excludes-nonzero-transfer-fees.md`.
[^adr0004]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0004-reference-policy-never-falls-back-to-dex-price.md`.
[^adr0005]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0005-execution-surfaces-have-independent-release-gates.md`.
[^adr0006]: `docs/domain/solana-tokenized-stock-desk/docs/adr/0006-initial-mainnet-execution-is-xstocks-only.md`.
[^issue9]: [GitHub issue 9](https://github.com/mangekyou-labs/katon/issues/9) — map notes; local/devnet Wallet Standard ship target; not mainnet, Ondo, or Liquidation Execution.
[^issue11]: [GitHub issue 11](https://github.com/mangekyou-labs/katon/issues/11) (closed) and `docs/ai/research/2026-09-20-local-devnet-seller-qa-harness.md` — offline Surfpool; spec-faithful Jupiter stub; mock API is not the accept loop.
[^app-ondo]: `apps/solana-web/src/App.tsx:10-18` fallbackAssets Ondo mint `enabled: true` / `eligible`; `:162-164` selector “Ondo” and badge “Ondo Global Markets”.
[^app-connect]: `apps/solana-web/src/App.tsx:7` `DEMO_WALLET`; `:66-71` timeout connect; `:148` “Demo wallet”.
[^app-sign]: `apps/solana-web/src/App.tsx:121-132` identity-sign; comments that local demo is an identity signer.
[^app-copy]: `apps/solana-web/src/App.tsx:28-29` LOCAL MOCK MODE banner; `:146-156` Trade nav / PRIVATE EXIT DESK / mock lede; `:258-272` mock review and simulated receipt.
[^ops-ui]: `apps/solana-web/src/App.tsx:234-247` Maker “xStocks · Ondo”; Ops “2 issuer adapters” xStocks and Ondo; solver “Shadow results / No submission / Shadow mode”.
[^audit-ui]: `apps/solana-web/src/App.tsx:265-266` audit drawer privacy copy and class-level rows.
[^web-pkg]: `apps/solana-web/package.json` — dependencies `@katon/solana-core`, `@katon/solana-sdk` only.
[^sdk-pkg]: `packages/solana-sdk/package.json` — dependency `@katon/solana-core` only.
[^root-pkg]: root `package.json` scripts `dev:solana-api`, `dev:solana-web`, `qa:cli` — no Surfpool harness script.
[^registry-ondo]: `apps/solana-api/src/registry.ts:45-67` `ondo-demo-MSFT-mint` `enabled: true`.
[^server-ondo]: `apps/solana-api/src/server.ts:9-17` balances on both demo mints; desk constructed with `MockOndoManagedSource`.
[^server-parse]: `apps/solana-api/src/server.ts:41-45` unknown field reject; `:67-71` `/v1/quote-sessions`.
[^mock-tx]: `apps/solana-api/src/sources.ts:51-97` demo PKCS8, `DEMO_WALLET`, `mockTransactionBase64` header `[1,0,1]`; `:185-186` `transactionVersion: 'v0'`.
[^mock-send]: `apps/solana-api/src/sources.ts:216-243` `MockOndoManagedSource`; `MockSender` `mock-${sourceKind}-${quoteId}`.
[^service-review]: `apps/solana-api/src/service.ts:274` `state: 'reviewing'`; `:295` execute requires `reviewing`; `:298` `validateSignedTransaction`.
[^service-drop]: `apps/solana-api/src/service.ts:520-525` clear candidates after rank.
[^service-snapshot]: `apps/solana-api/src/service.ts:60-75` `transferFeeBps: asset.capabilities.transferFee ? 0 : undefined`.
[^collect]: `apps/solana-api/src/service.ts:418-422` concurrent `Promise.all` with `QUOTE_SPRINT_MS` deadline.
[^api-paths]: `apps/solana-api/src/server.ts:67-71`; `packages/solana-sdk/src/api.ts:27-53`.
[^api-sdk]: `packages/solana-sdk/src/api.ts` — no quote-sprints, execution-attempts, or authorize.
[^quote-const]: `packages/solana-core/src/quote.ts:4-9`.
[^rank]: `packages/solana-core/src/ranking.ts:81-164`.
[^sanitize]: `packages/solana-core/src/ranking.ts:167-169`.
[^registry-fee]: `packages/solana-core/src/registry.ts:91-96`.
[^eligibility]: `packages/solana-core/src/eligibility.ts:14-53`.
[^issuers]: `packages/solana-core/src/issuers.ts:59-71`.
[^types-state]: `packages/solana-core/src/types.ts:1-32` Issuer includes `ondo`; states include `reviewing`/`signing`/`submitting`.
[^jupiter-assert]: `packages/solana-core/src/venues.ts:57-68`.
[^parser]: `packages/solana-core/src/transactions.ts:115-123` — untracked; v0 prefix must be `0x80`.
[^wallet]: `packages/solana-sdk/src/wallet.ts:38-49`, `:82-86`.
[^lib-pda]: `contracts/solana-rfq/programs/solana-rfq/src/lib.rs:24-31`, `:191-192`.
[^gov-init]: `contracts/solana-rfq/programs/solana-rfq/src/governance.rs:13-26`; `registry.rs` `require_squad_quorum` / `squad_signers`.
[^guardian]: `contracts/solana-rfq/programs/solana-rfq/src/governance.rs:183-190`.
[^settle-cpi]: `contracts/solana-rfq/programs/solana-rfq/src/settlement.rs:224-265`.
[^settle-expiry]: `contracts/solana-rfq/programs/solana-rfq/src/settlement.rs:24-33`.
[^settle-delta]: `contracts/solana-rfq/programs/solana-rfq/src/settlement.rs:277-285`.
[^settle-receipt]: `contracts/solana-rfq/programs/solana-rfq/src/settlement.rs:312-320`.
[^tests-ondo]: `contracts/solana-rfq/programs/solana-rfq/src/tests.rs:355` `validate_generic_settlement_issuer(ISSUER_ONDO)` err.
[^liq-start]: `services/solana-liquidator/src/startup.ts:93-125`.
[^liq-prepare]: `services/solana-liquidator/src/solver.ts:272` `prepare`; test expects `decision.executable === true` after forged gates (`src/solana-tokenized-stock.test.ts:454-461`).
[^liq-test]: `src/solana-tokenized-stock.test.ts:412-417`, `:462-466`, `:469-479`.
[^test-ondo-rank]: `src/solana-tokenized-stock.test.ts:201-235` ranks Ondo managed route as winner.
)
