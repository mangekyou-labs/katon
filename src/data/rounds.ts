// Thin query/mutation layer over public.rounds + the order-row transitions the
// negotiation loop drives. Anon PostgREST has no transactions, so every
// multi-write sequence here is ordered so the most critical write lands first
// and a partial failure stays recoverable (the reader, currentTerms in
// src/core/negotiation.ts, tolerates a lost supersede/resolution write).
// Round terms are frozen at insert — anon may update ONLY the resolution
// column, and rounds has no updated_at (docs/migrations/2026-07-10-intent-layer.sql).

import { supabase } from './supabase';
import { latestPendingRound, nextRoundN } from '../core/negotiation';
import type { Order, RoundRow, RoundResolution, Side } from '../core/types';

export async function fetchRounds(order_id: string): Promise<RoundRow[]> {
  const { data, error } = await supabase.from('rounds')
    .select('*').eq('order_id', order_id)
    .order('n', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RoundRow[];
}

// Order-row transition scoped to open threads only. updateOrder's match only
// supports equality, and these transitions usually fire from EITHER 'pending'
// or 'countered' — hence a direct query with `.in()` (same updated_at
// stamping). PostgREST reports success even when the scoped match hit zero
// rows, so `.select('id')` reads the matched rows back and an empty result
// throws — a thread that was cancelled/expired/accepted elsewhere must fail
// honestly, never advance round bookkeeping on a phantom write.
async function updateOrderWhileOpen(
  id: string,
  patch: Record<string, unknown>,
  statuses: string[] = ['pending', 'countered'],
): Promise<void> {
  const { data, error } = await supabase.from('orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', statuses)
    .select('id');
  if (error) throw error;
  if ((data ?? []).length === 0) throw new Error('This order is no longer open.');
}

// Advance a round's resolution, scoped to resolution=pending so a concurrent
// writer can never regress an already-resolved round.
async function setResolution(id: string, resolution: RoundResolution): Promise<void> {
  const { error } = await supabase.from('rounds')
    .update({ resolution }).eq('id', id).eq('resolution', 'pending');
  if (error) throw error;
}

/**
 * Insert a counter-offer (spec §4.3): new round n+1, previous pending round
 * superseded, order marked 'countered'. The insert lands first — it carries
 * the proposal itself; if a follow-up write fails, currentTerms still surfaces
 * the highest-n pending round, so the thread state self-heals on read.
 */
export async function counterOffer(
  order: Order,
  rounds: RoundRow[],
  proposer: Side,
  maker_amount: string,
  taker_amount: string,
  signed_payload: string,
  signature: string,
): Promise<void> {
  const prev = latestPendingRound(rounds);
  const { error } = await supabase.from('rounds').insert({
    order_id: order.id,
    n: nextRoundN(rounds),
    proposer,
    maker_amount,
    taker_amount,
    signed_payload,
    signature,
    resolution: 'pending', // RLS requires resolution='pending' on insert
  });
  if (error) throw error;
  try {
    if (prev) await setResolution(prev.id, 'superseded');
    await updateOrderWhileOpen(order.id, { status: 'countered' });
  } catch (err) {
    // The round row landed but the order row didn't move (a write failed, or
    // the scoped status write matched zero rows — the thread just closed).
    // Surface an honest error instead of "signed and sent"; ThreadView's
    // repairCounteredStatus heals the pending-order/live-round mismatch.
    console.warn('rounds: counter follow-up writes failed', err);
    throw new Error('Counter saved, but the order could not be updated — the thread may have just closed.');
  }
}

/**
 * Accept the pending round (spec §4.4): the final agreed amounts are written
 * back onto the orders row FIRST — the order row is the single source of truth
 * for settlement (fillCanonicalArgs reads it), so it must win. Step 1 throws
 * upward (including on a 0-row match — the thread closed under us), so the
 * resolution bookkeeping only runs after a real order write; a step-2 failure
 * is non-fatal.
 */
export async function acceptRound(
  order: Order,
  round: RoundRow,
  opts?: { taker_signature?: string },
): Promise<void> {
  await updateOrderWhileOpen(order.id, {
    maker_amount: String(round.maker_amount), // String(...): PostgREST numeric → JSON number
    taker_amount: String(round.taker_amount),
    status: 'accepted',
    ...(opts?.taker_signature ? { taker_signature: opts.taker_signature } : {}),
  });
  // Past this point the order row already says 'accepted' with final amounts —
  // the agreement stands no matter what the rounds table does (mirrors the
  // "confirmed fill is the point of no return" convention in useSettlement).
  // A failed resolution write just leaves the round 'pending'; currentTerms
  // ignores it once the order is closed.
  await setResolution(round.id, 'accepted').catch((err) => {
    console.warn('rounds: accepted-order resolution write failed (non-fatal)', err);
  });
}

/** Decline the pending round: order closes first, round bookkeeping is non-fatal (same rationale as acceptRound). */
export async function declineRound(
  order: Order,
  round: RoundRow,
  opts?: { taker_signature?: string },
): Promise<void> {
  await updateOrderWhileOpen(order.id, {
    status: 'declined',
    ...(opts?.taker_signature ? { taker_signature: opts.taker_signature } : {}),
  });
  await setResolution(round.id, 'declined').catch((err) => {
    console.warn('rounds: declined-order resolution write failed (non-fatal)', err);
  });
}

/**
 * Round-0 (initial terms) accept: the desk's takerAction transition, but via
 * the 0-row-checked helper — scoped to status='pending' only, so a thread
 * that just closed (or already moved to 'countered') fails honestly instead
 * of silently no-opping.
 */
export async function acceptInitialTerms(order: Order, taker_signature: string): Promise<void> {
  await updateOrderWhileOpen(order.id, { status: 'accepted', taker_signature }, ['pending']);
}

/** Round-0 (initial terms) decline — same scoping and 0-row check as acceptInitialTerms. */
export async function declineInitialTerms(order: Order, taker_signature: string): Promise<void> {
  await updateOrderWhileOpen(order.id, { status: 'declined', taker_signature }, ['pending']);
}

/**
 * The maker's withdrawal of an offer they are still waiting on (the desk's old
 * cancelOrder, re-homed into the thread). Scoped to open statuses via
 * updateOrderWhileOpen's default — a thread is cancellable while 'pending' OR
 * 'countered' (I countered back and I'm waiting), and the old pending-only
 * write would have silently no-opped on the latter. The 0-row check makes a
 * race with a concurrent accept/decline fail honestly.
 *
 * A taker's still-pending counter round is deliberately LEFT pending: there is
 * no 'cancelled' resolution in the enum, 'declined' would be a lie, and
 * currentTerms already reports awaiting=null once the order is closed. This is
 * exactly what the broadcast sweep does (cancelRemainingThreads never touches
 * rounds either).
 */
export async function cancelOrderThread(order: Order): Promise<void> {
  await updateOrderWhileOpen(order.id, { status: 'cancelled' });
}

/**
 * Heal counterOffer's partial-failure window: the round insert landed but the
 * follow-up status write didn't, leaving the order 'pending' with a live
 * pending round (n>=1). The original hazard — the Phase-1 desk accepting stale
 * round-0 terms — is gone with the OrderCard accept path (every order is a
 * thread now, and ThreadView.act only takes the round-0 branch when there is no
 * pending round). What remains is still worth healing: a row that says
 * 'pending' while a live counter round exists lies to every naive
 * orders.status reader — the section counts, the status badges, BroadcastList's
 * tally, and anyone doing SQL triage. Scoped to status='pending' (a no-op if
 * anything already moved the row) and swallows its own errors: this is
 * opportunistic repair, fired from ThreadView; the next mount retries.
 */
export async function repairCounteredStatus(order: Order): Promise<void> {
  try {
    const { error } = await supabase.from('orders')
      .update({ status: 'countered', updated_at: new Date().toISOString() })
      .eq('id', order.id)
      .eq('status', 'pending');
    if (error) throw error;
  } catch (err) {
    console.warn('rounds: countered-status repair failed (non-fatal, retried next mount)', err);
  }
}
