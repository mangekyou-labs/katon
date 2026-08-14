-- ============================================================
-- Intent / private-offer layer (Feature 1, Phase 2) schema
-- Spec: docs/superpowers/specs/2026-07-10-intent-private-offer-layer-design.md
-- APPLIED to live project zaflldqvenbgfaxtzbjc on 2026-07-10 via
-- supabase MCP apply_migration (name: intent_layer_schema).
-- Mirrors the anon-grant hardening pattern documented in README.md.
-- ============================================================

-- 1. intents — taker pair-interest toggles (insert = on, delete = off)
create table if not exists public.intents (
  id         uuid primary key default gen_random_uuid(),
  address    text not null
    constraint intents_addr_shape check (address ~ '^G[A-Z2-7]{55}$'),
  pair_key   text not null
    constraint intents_pair_shape
    check (pair_key ~ '^[A-Z0-9]{1,12}(:G[A-Z2-7]{55})?\|[A-Z0-9]{1,12}(:G[A-Z2-7]{55})?$'),
  created_at timestamptz not null default now(),
  unique (address, pair_key)
);
create index if not exists intents_pair_key_idx on public.intents (pair_key);

alter table public.intents enable row level security;
create policy intents_anon_select on public.intents for select to anon using (true);
create policy intents_anon_insert on public.intents for insert to anon with check (true);
create policy intents_anon_delete on public.intents for delete to anon using (true);
revoke update on public.intents from anon;   -- toggles are never updated in place

alter table public.intents replica identity full;
alter publication supabase_realtime add table public.intents;

-- 2. broadcasts — one maker composition, fanned out as per-taker orders rows
create table if not exists public.broadcasts (
  id            uuid primary key default gen_random_uuid(),
  maker_address text not null
    constraint broadcasts_maker_shape check (maker_address ~ '^G[A-Z2-7]{55}$'),
  pair_key      text not null
    constraint broadcasts_pair_shape
    check (pair_key ~ '^[A-Z0-9]{1,12}(:G[A-Z2-7]{55})?\|[A-Z0-9]{1,12}(:G[A-Z2-7]{55})?$'),
  maker_amount  numeric not null
    constraint broadcasts_maker_amount_pos check (maker_amount > 0),
  maker_token   text not null
    constraint broadcasts_maker_token_shape check (maker_token ~ '^[A-Z0-9]{1,12}(:G[A-Z2-7]{55})?$'),
  taker_amount  numeric not null
    constraint broadcasts_taker_amount_pos check (taker_amount > 0),
  taker_token   text not null
    constraint broadcasts_taker_token_shape check (taker_token ~ '^[A-Z0-9]{1,12}(:G[A-Z2-7]{55})?$'),
  expiration    timestamptz not null,
  status        text not null default 'active'
    constraint broadcasts_status_check
    check (status in ('active','completed','cancelled','expired')),
  created_at    timestamptz not null default now()
);
create index if not exists broadcasts_maker_idx on public.broadcasts (maker_address);

alter table public.broadcasts enable row level security;
create policy broadcasts_anon_select on public.broadcasts for select to anon using (true);
create policy broadcasts_anon_insert on public.broadcasts for insert to anon with check (status = 'active');
create policy broadcasts_anon_update on public.broadcasts for update to anon using (true) with check (true);
revoke update on public.broadcasts from anon;        -- freeze terms after insert;
grant  update (status) on public.broadcasts to anon; -- only the workflow column advances

-- 3. orders — link fan-out rows to their broadcast + allow 'countered'
alter table public.orders
  add column if not exists broadcast_id uuid references public.broadcasts(id);
create index if not exists orders_broadcast_idx on public.orders (broadcast_id);

alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('pending','accepted','declined','cancelled','expired','countered'));

-- 4. rounds — counter-offer negotiation rounds (round 0 = the order row itself)
create table if not exists public.rounds (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id),
  n              int  not null
    constraint rounds_n_pos check (n >= 1),
  proposer       text not null
    constraint rounds_proposer_check check (proposer in ('maker','taker')),
  maker_amount   numeric not null
    constraint rounds_maker_amount_pos check (maker_amount > 0),
  taker_amount   numeric not null
    constraint rounds_taker_amount_pos check (taker_amount > 0),
  signed_payload text,   -- wallet-signed round payload (stored, unverified — on-chain is the boundary)
  signature      text,
  resolution     text not null default 'pending'
    constraint rounds_resolution_check
    check (resolution in ('pending','accepted','declined','superseded')),
  created_at     timestamptz not null default now(),
  unique (order_id, n)
);
create index if not exists rounds_order_idx on public.rounds (order_id);

alter table public.rounds enable row level security;
create policy rounds_anon_select on public.rounds for select to anon using (true);
create policy rounds_anon_insert on public.rounds for insert to anon with check (resolution = 'pending');
create policy rounds_anon_update on public.rounds for update to anon using (true) with check (true);
revoke update on public.rounds from anon;            -- freeze proposal terms after insert;
grant  update (resolution) on public.rounds to anon; -- only the resolution advances

alter table public.rounds replica identity full;
alter publication supabase_realtime add table public.rounds;

-- ============================================================
-- Reconciliation (post-review). APPLIED to live project
-- zaflldqvenbgfaxtzbjc on 2026-07-11 via supabase MCP
-- apply_migration (name: intent_layer_reconcile_grants_realtime).
-- ============================================================

-- 5. broadcasts was missing from the realtime publication — useBroadcasts'
--    channel was permanently dead (cross-tab updates never arrived).
alter table public.broadcasts replica identity full;
alter publication supabase_realtime add table public.broadcasts;

-- 6. Restore the README "freeze order terms after insert" hardening on orders
--    (found live with TABLE-WIDE anon update — the documented revoke was never
--    applied), amended for the intent layer: maker_amount/taker_amount are
--    anon-updatable because acceptRound writes the agreed round's amounts back
--    onto the order row (spec §3.4). Addresses, tokens, expiration, nonce,
--    signature, signed_payload stay frozen after insert. Accepted residual
--    risk: amounts on an open row are mutable via the anon key — the on-chain
--    dual-auth entries over the exact fill args remain the integrity boundary,
--    and settlement UIs render the same row the parties sign over.
revoke update on public.orders from anon;
grant update (status, taker_signature, updated_at,
              settlement_status, maker_auth, taker_auth,
              settle_tx_hash, settle_error, settled_at,
              maker_amount, taker_amount)
  on public.orders to anon;
