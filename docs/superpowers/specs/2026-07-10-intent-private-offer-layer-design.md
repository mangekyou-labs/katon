# Intent / Private-Offer Layer — Design Spec

**Date:** 2026-07-10 · **Status:** Approved design, implementation not yet scheduled
**Feature:** TrustRFQ Feature 1, Phase 2 ("intent layer" in the CLAUDE.md roadmap)

---

## 1. Overview & goals

Phase 1 (live today): a maker types a known taker's wallet address into the RFQ ticket and
sends a direct private offer. That flow **stays unchanged as an optional path** — it is the
right tool when two parties already know each other.

Phase 2 (this spec) adds a discovery + negotiation layer on top:

- **Takers declare interest in asset pairs** with a manual toggle ("I want to trade XLM/USDC").
- **Makers send a private offer to every interested taker in one click** — no addresses typed.
  The system fans the offer out as individual, privately-routed offers.
- **Each interested taker negotiates with the maker in an isolated thread** — takers never see
  each other, and there is **no race**: nothing auto-cancels when one taker accepts. A real
  **counter-offer loop** (taker counters → maker accepts/declines/counters → …) replaces the
  binary Accept/Decline as the negotiation mechanic.
- Settlement is untouched: agreement still funnels into the existing signed-auth-entry +
  atomic `fill` pipeline. Binding commitment continues to exist **only** at settlement signing;
  broadcasts, offers, and counter-rounds are off-chain coordination.

Non-goals are listed in §6.

## 2. Concepts & vocabulary

| Term | Meaning |
|---|---|
| **Intent** | A taker's standing, manually-toggled declaration of interest in a pair. Stored as one row; removing the toggle deletes it. |
| **Pair key** | Direction-agnostic canonical id for a token pair: the two `TOKENS` values (see `otc.js:25-28`) sorted lexicographically and joined with `|`. Example: `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5|XLM`. An intent covers **both directions** of the pair. |
| **Broadcast** | A maker's single composition of terms for a pair. Sending it creates one thread (an `orders` row) per subscribed taker. |
| **Thread** | One (broadcast × taker) private negotiation: the per-taker `orders` row plus its `rounds`. |
| **Round** | One proposal within a thread: initial terms (round 0, implicit) or a counter-offer with new amounts. |

Only allow-listed tokens (`TOKENS` / `TOKEN_VALUES`, `otc.js:25-28,60`) can form pairs — the
existing unknown-token quarantine keeps applying to everything rendered.

## 3. Data model

All DDL runs via the Supabase SQL Editor (anon key cannot run DDL — CLAUDE.md gotcha). The
migration follows the README's re-runnable pattern (`create table if not exists`, anon grants,
realtime publication).

### 3.1 New table `intents`

```sql
create table if not exists public.intents (
  id          uuid primary key default gen_random_uuid(),
  address     text not null,          -- G… (taker wallet)
  pair_key    text not null,          -- canonical, see §2
  created_at  timestamptz not null default now(),
  unique (address, pair_key)
);
-- realtime (live "N takers subscribed" counters on the maker side):
alter publication supabase_realtime add table public.intents;
```

Toggle ON = insert; toggle OFF = delete. No soft-delete/history in this phase.

### 3.2 New table `broadcasts`

```sql
create table if not exists public.broadcasts (
  id            uuid primary key default gen_random_uuid(),
  maker_address text not null,
  pair_key      text not null,
  maker_amount  numeric not null,     -- what the maker gives (initial terms)
  maker_token   text not null,
  taker_amount  numeric not null,     -- what the maker asks
  taker_token   text not null,
  expiration    timestamptz not null,
  status        text not null default 'active',  -- active|completed|cancelled|expired
  created_at    timestamptz not null default now()
);
```

`completed` = maker settled one of its threads; `cancelled` = maker withdrew the broadcast.

### 3.3 `orders` changes (existing table)

- New nullable column `broadcast_id uuid references public.broadcasts(id)`. Phase-1 direct
  orders keep `broadcast_id = null`; broadcast fan-out rows carry the group id.
- `status` gains one value: `countered` (alongside `pending|accepted|declined|cancelled|expired`).
  An order is `countered` while the latest round awaits the counterparty's response.

Everything else — routing by `taker_address`, settlement columns, realtime — is reused as-is.

### 3.4 New table `rounds`

```sql
create table if not exists public.rounds (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id),
  n              int  not null,                 -- 1, 2, 3, … (initial terms are round 0, implicit in the order row)
  proposer       text not null,                 -- 'maker' | 'taker'
  maker_amount   numeric not null,              -- full proposed terms (tokens fixed by the pair)
  taker_amount   numeric not null,
  signed_payload text,                          -- wallet-signed round payload (stored, unverified)
  signature      text,
  resolution     text not null default 'pending',  -- pending|accepted|declined|superseded
  created_at     timestamptz not null default now(),
  unique (order_id, n)
);
alter publication supabase_realtime add table public.rounds;
```

Round rules:
- Tokens never change mid-thread; only amounts do. Direction stays as composed by the maker.
- Only the party who did **not** propose the latest round may act on it (accept / decline /
  counter). Countering marks the previous round `superseded` and inserts `n+1`.
- **On accept, the final agreed amounts are written back onto the `orders` row** and the order
  becomes `accepted`. The order row remains the single source of truth for settlement —
  `fillCanonicalArgs` / `signOrderAuth` / `fillOrder` (`otc.js`) are **not modified**.
- Round signatures follow the existing Phase-1 pattern: the proposer wallet-signs the round
  payload; it is stored but not verified (the on-chain auth entries remain the integrity
  boundary — same accepted risk already documented in CLAUDE.md).

## 4. Flows (end to end)

### 4.1 Taker declares intent
Taker connects wallet → opens a new **Pairs** panel → toggles a pair on/off → row inserted
into / deleted from `intents`. The panel shows only pairs constructible from `TOKENS`.

### 4.2 Maker broadcasts a private offer
1. Maker opens the RFQ ticket in a new **Broadcast** mode (the Phase-1 "direct address" mode
   remains next to it).
2. Picks pair + terms + expiry. UI shows a live **"N takers subscribed"** count (from `intents`).
3. **Balance gate (spam prevention):** the give-leg amount is validated against the connected
   wallet's Horizon balance (§4.5); over-balance blocks Send with an error.
4. Send: client inserts one `broadcasts` row, then one `orders` row per subscribed taker
   (excluding the maker's own address), each routed by `taker_address` exactly like Phase-1
   orders, all sharing `broadcast_id`.

### 4.3 Taker responds (isolated thread)
Each targeted taker sees the offer in the existing **Incoming** tab with a "private offer"
badge. Actions: **Accept** (→ §4.4), **Decline** (order `declined`; other threads unaffected),
or **Counter** — a form pre-filled with current amounts; submitting inserts round `n+1`
(balance-gated on the taker's give-leg) and sets the order to `countered`.

### 4.4 Negotiation loop & agreement
Counters alternate via realtime (`rounds` inserts). When the responding party (the one who did
not propose the latest round) accepts it: final amounts are copied onto the order, status →
`accepted`, and the **existing settlement stepper takes over unchanged** (both parties sign
auth entries → permissionless `fill`).

There is **no automatic race resolution**. When the maker settles one thread of a broadcast,
the broadcast becomes `completed` and the UI **prompts** the maker to cancel the remaining open
threads (single "Cancel remaining" action). Whether to keep negotiating other threads (e.g.
with remaining inventory) stays the maker's decision.

Thread expiry equals the broadcast `expiration`; counters do **not** extend it.

### 4.5 Balance panel (wallet-asset integration)
- The topbar gains a balance panel: the connected wallet's balances for allow-listed tokens,
  fetched from Horizon `GET /accounts/{address}` (`balances[]`), refreshed on connect and
  before any Send/Counter.
- Validation rule: *amount you would give* ≤ *current balance of that token*. XLM checks should
  subtract the ledger minimum reserve; MVP may start with the raw balance and note the
  refinement.
- Non-existent account (unfunded) → treated as zero balance with a friendly error.

## 5. Privacy & trust boundaries

Stated honestly, consistent with the existing threat model:

- **Taker↔taker privacy is a product rule enforced at the UI/data-shape level.** Fan-out
  produces per-taker rows, and each client renders only rows addressed to it — takers never see
  sibling threads. The maker UI shows only the subscriber **count** before sending, never the
  address list.
- **It is not cryptographic privacy.** Fan-out runs client-side (the maker's browser reads the
  `intents` list to create rows), and all reads use the public anon key — the same accepted
  Testnet-MVP risk already recorded in CLAUDE.md. Anyone polling the REST API can enumerate
  intents and orders.
- **Future hardening (explicitly out of this phase):** Sign-In-With-Stellar (signed nonce →
  JWT) + per-wallet RLS so takers can only read their own rows, and/or moving fan-out into a
  Supabase Edge Function so the maker's client never sees the subscriber list.
- **Balance validation is client-side friction, not enforcement.** The anon backend cannot
  verify balances; a hostile client can bypass the check. Real enforcement is unchanged: an
  over-balance deal simply fails at on-chain `fill` (SAC `transfer` reverts). The gate exists
  to stop honest mistakes and lazy spam.
- Settlement security is untouched: both parties still sign Address-credential auth entries
  over exact `fill` args (STELLAR.md §0 invariants all still hold).

## 6. Out of scope (this phase)

- The institutional RFQ protocol (peer-to-server quoting, quote servers, on-chain registry).
- SIWS / RLS / Edge-Function fan-out (listed as hardening, not built here).
- The React + TypeScript migration itself (this spec is stack-agnostic behavior + data model;
  per CLAUDE.md the implementation lands on the new stack).
- Partial fills / splitting a broadcast's amount across multiple takers.
- Automatic intent inference from trade history.
- Maker reputation, ratings, or stake-based gating.

## 7. Decided later

- **Implementation sequencing** relative to the React+TS migration (CLAUDE.md records
  "migration first" as the standing rule; final call deferred).
- Per-maker limits (max concurrent open broadcasts/threads) — revisit after first usage.
- Round-level expiry refinements (e.g. per-counter response deadlines).

## 8. Verification (when implemented)

1. Migration applies cleanly on a fresh Supabase project (README pattern) and re-runs safely.
2. Two-browser E2E: taker toggles intent → maker broadcasts to N≥2 takers → each taker sees
   only its own thread → counter loop across both sides → accept → existing settlement stepper
   completes an XLM↔USDC `fill` on Testnet → maker prompted to cancel remaining threads.
3. Balance gate: composing an offer above the wallet's Horizon balance blocks Send/Counter.
4. Phase-1 regression: direct-address orders (null `broadcast_id`) behave exactly as before.
5. `cargo test` for the contract stays green (no contract changes expected — assert none made).
