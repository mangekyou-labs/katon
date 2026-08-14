// ---------------------------------------------------------------------------
// Negotiation logic — pure helpers for the intent/private-offer layer.
// ---------------------------------------------------------------------------
// Payload composition + thread-state derivation for broadcasts and counter-
// offer rounds (spec §3.4, §4). Like canonical.ts this module is PURE — no
// wallet, no network, no window — but it is NOT a signature boundary: these
// payloads follow the Phase-1 pattern (wallet-signed, stored, unverified;
// the on-chain auth entries are the real integrity boundary). The `kind`
// discriminator keeps a broadcast payload from ever colliding with a round
// or Phase-1 order payload. Fixed key order = deterministic bytes, so the
// one signature a maker produces can be copied verbatim onto every fan-out
// row (mirrors canonicalPayload's style).

import type { Order, RoundRow, Side } from './types';

/** The fields the maker signs once per broadcast (after the row exists — the id is part of the payload). */
export interface BroadcastTerms {
  broadcast_id: string;
  maker_address: string;
  pair_key: string;
  maker_amount: string;
  maker_token: string;
  taker_amount: string;
  taker_token: string;
  expiration: string;
}

/** exact bytes the maker signs for a broadcast — fixed key order = deterministic */
export function composeBroadcastPayload(b: BroadcastTerms): string {
  return JSON.stringify({
    kind: 'broadcast',
    broadcast_id: b.broadcast_id,
    maker_address: b.maker_address,
    pair_key: b.pair_key,
    maker_amount: b.maker_amount,
    maker_token: b.maker_token,
    taker_amount: b.taker_amount,
    taker_token: b.taker_token,
    expiration: b.expiration,
  });
}

/** The fields the proposer signs for one counter-offer round. */
export interface RoundTerms {
  kind: 'round';
  order_id: string;
  n: number;
  proposer: Side;
  maker_amount: string;
  maker_token: string;
  taker_amount: string;
  taker_token: string;
  expiration: string;
}

/** exact bytes the proposer signs for a round — fixed key order = deterministic */
export function composeRoundPayload(r: RoundTerms): string {
  return JSON.stringify({
    kind: 'round',
    order_id: r.order_id,
    n: r.n,
    proposer: r.proposer,
    maker_amount: r.maker_amount,
    maker_token: r.maker_token,
    taker_amount: r.taker_amount,
    taker_token: r.taker_token,
    expiration: r.expiration,
  });
}

/**
 * Upper bound keeping numerics round-trippable through PostgREST/JS-number/BigInt.
 * A stored numeric ≥ 1e21 comes back from PostgREST as a JS number whose
 * String(...) is exponential ('1e+21'), and BigInt('1e+21') THROWS at
 * settlement (base-unit conversion). 1e13 leaves plain-digit strings with
 * headroom for the ×10^7 base-unit scale — and exceeds any real supply anyway.
 */
export const MAX_AMOUNT = 1e13;
export const amountTooLarge = (v: string): boolean => parseFloat(v) > MAX_AMOUNT;

/** Next round number for a thread: 1 on an empty thread, else max(n)+1. */
export function nextRoundN(rounds: RoundRow[]): number {
  return rounds.reduce((max, r) => Math.max(max, r.n), 0) + 1;
}

/**
 * The highest-n round still awaiting a response. The write path keeps at most
 * one pending round per thread (countering supersedes the previous one), but
 * anon writes have no transactions — picking the highest n keeps reads sane
 * even if a supersede write was lost.
 */
export function latestPendingRound(rounds: RoundRow[]): RoundRow | null {
  let latest: RoundRow | null = null;
  for (const r of rounds) {
    if (r.resolution === 'pending' && (!latest || r.n > latest.n)) latest = r;
  }
  return latest;
}

/** The party who did NOT propose — the only one who may accept/decline/counter. */
export const responderOf = (proposer: Side): Side =>
  proposer === 'maker' ? 'taker' : 'maker';

/** The live terms of a thread: what's on the table, who proposed it, whose move it is. */
export interface ThreadTerms {
  maker_amount: string;
  taker_amount: string;
  /** 0 = the order row's initial terms; ≥1 = a counter-offer round */
  n: number;
  proposer: Side;
  /** whose response the thread is waiting on; null once the thread is closed */
  awaiting: Side | null;
  latestPending: RoundRow | null;
}

/**
 * Derive the current terms of a thread from the order row + its rounds.
 * A pending round overrides the order row's amounts (round 0 = the order
 * itself, proposed by the maker). Tokens never change mid-thread — only
 * amounts do — so tokens always come from the order row. `awaiting` is null
 * whenever the order is closed (accepted/declined/cancelled/expired), even
 * if a stale pending round is still lying around.
 */
export function currentTerms(order: Order, rounds: RoundRow[]): ThreadTerms {
  const open = order.status === 'pending' || order.status === 'countered';
  const pending = latestPendingRound(rounds);
  if (pending) {
    return {
      // PostgREST returns numeric columns as JSON numbers — normalize back to
      // the string convention amounts follow everywhere else.
      maker_amount: String(pending.maker_amount),
      taker_amount: String(pending.taker_amount),
      n: pending.n,
      proposer: pending.proposer,
      awaiting: open ? responderOf(pending.proposer) : null,
      latestPending: pending,
    };
  }
  return {
    maker_amount: String(order.maker_amount),
    taker_amount: String(order.taker_amount),
    n: 0,
    proposer: 'maker',
    awaiting: order.status === 'pending' ? 'taker' : null,
    latestPending: null,
  };
}
