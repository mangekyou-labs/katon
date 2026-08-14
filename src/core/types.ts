// Shape of a row in public.orders (see README schema + CLAUDE.md data model).
// All DB strings are attacker-writable (anon key, no auth) — integrity is
// enforced by wallet signatures and the on-chain fill, never by trusting these.

export type OrderStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered';
export type SettlementStatus = 'idle' | 'signing' | 'ready' | 'settling' | 'settled' | 'failed';

export interface Order {
  id: string;
  created_at: string;
  updated_at?: string | null;

  maker_address: string;
  maker_amount: string;
  maker_token: string;
  taker_address: string;
  taker_amount: string;
  taker_token: string;

  expiration: string;
  nonce: string;
  signature: string;
  signed_payload: string;
  taker_signature?: string | null;
  status: OrderStatus;

  settlement_status?: SettlementStatus | null;
  maker_auth?: string | null;
  taker_auth?: string | null;
  settle_tx_hash?: string | null;
  settle_error?: string | null;
  settled_at?: string | null;

  /** intent layer: fan-out rows carry the broadcast they came from; direct orders stay null */
  broadcast_id?: string | null;
}

/** My role in an order: did this wallet create it (maker) or receive it (taker)? */
export type Side = 'maker' | 'taker';

// ---------------------------------------------------------------------------
// Intent layer rows (public.intents / public.broadcasts / public.rounds —
// see docs/migrations/2026-07-10-intent-layer.sql). Same trust model as Order:
// anon-writable coordination state, never an integrity boundary.
// ---------------------------------------------------------------------------

/** A taker's standing pair-interest toggle: insert = on, delete = off. */
export interface IntentRow {
  id: string;
  address: string;
  pair_key: string;
  created_at: string;
}

export type BroadcastStatus = 'active' | 'completed' | 'cancelled' | 'expired';

/** One maker composition of terms, fanned out as per-taker orders rows. */
export interface BroadcastRow {
  id: string;
  maker_address: string;
  pair_key: string;
  maker_amount: string;
  maker_token: string;
  taker_amount: string;
  taker_token: string;
  expiration: string;
  status: BroadcastStatus;
  created_at: string;
}

export type RoundResolution = 'pending' | 'accepted' | 'declined' | 'superseded';

/** One counter-offer within a thread (round 0 = the order row itself). */
export interface RoundRow {
  id: string;
  order_id: string;
  n: number;
  proposer: Side;
  maker_amount: string;
  taker_amount: string;
  signed_payload?: string | null;
  signature?: string | null;
  resolution: RoundResolution;
  created_at: string;
}
