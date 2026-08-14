// Thin query/mutation layer over public.broadcasts + the fan-out into orders.
// Broadcast terms are frozen at insert (anon may update ONLY the status column,
// and there is no updated_at column — docs/migrations/2026-07-10-intent-layer.sql),
// so unlike orders.ts there is nothing to stamp here. Signing stays in the UI
// layer: this module receives a ready signed_payload + signature and never
// touches the wallet (payload composition lives in src/core/negotiation.ts).

import { supabase } from './supabase';
import type { BroadcastRow, BroadcastStatus } from '../core/types';

/** Insert a broadcast and return the stored row — the id feeds the signed payload + fan-out. */
export async function insertBroadcast(
  row: Omit<BroadcastRow, 'id' | 'created_at' | 'status'>,
): Promise<BroadcastRow> {
  const { data, error } = await supabase.from('broadcasts')
    .insert({ ...row, status: 'active' }) // RLS requires status='active' on insert
    .select().single();
  if (error) throw error;
  return data as BroadcastRow;
}

export async function fetchMyBroadcasts(maker_address: string): Promise<BroadcastRow[]> {
  const { data, error } = await supabase.from('broadcasts')
    .select('*').eq('maker_address', maker_address)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as BroadcastRow[];
}

/** Scoped like orders.ts updateOrder — e.g. a 'completed' write scoped to status=active never clobbers 'cancelled'. */
export async function updateBroadcastStatus(
  id: string,
  status: BroadcastStatus,
  match?: Record<string, string>,
): Promise<void> {
  let q = supabase.from('broadcasts').update({ status }).eq('id', id);
  for (const [k, v] of Object.entries(match ?? {})) q = q.eq(k, v);
  const { error } = await q;
  if (error) throw error;
}

/**
 * Fan a broadcast out as one private orders row per subscribed taker (spec
 * §4.2): each row routed by taker_address exactly like a Phase-1 order, all
 * sharing broadcast_id. The maker signed the broadcast payload ONCE; the same
 * signed_payload + signature go onto every row (stored-but-unverified — the
 * accepted Phase-1 risk; on-chain auth entries are the real boundary). The
 * nonce is still unique PER ROW so each thread keeps a distinct identity.
 */
export async function fanOut(
  broadcast: BroadcastRow,
  takers: string[],
  signed_payload: string,
  signature: string,
): Promise<number> {
  if (takers.length === 0) return 0;
  const rows: Record<string, unknown>[] = takers.map((taker_address) => ({
    maker_address: broadcast.maker_address,
    // String(...): PostgREST hands numeric columns back as JSON numbers
    maker_amount: String(broadcast.maker_amount),
    maker_token: broadcast.maker_token,
    taker_address,
    taker_amount: String(broadcast.taker_amount),
    taker_token: broadcast.taker_token,
    expiration: broadcast.expiration,
    nonce: crypto.randomUUID(),
    signed_payload,
    signature,
    status: 'pending',
    broadcast_id: broadcast.id,
  }));
  const { error } = await supabase.from('orders').insert(rows);
  if (error) throw error;
  return rows.length;
}

/**
 * The maker's "Cancel remaining" action after settling one thread (spec §4.4):
 * every still-open sibling thread of the broadcast → cancelled. Scoped to
 * open statuses so accepted/settled threads are never touched.
 */
export async function cancelRemainingThreads(broadcast_id: string): Promise<void> {
  const { error } = await supabase.from('orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('broadcast_id', broadcast_id)
    .in('status', ['pending', 'countered']);
  if (error) throw error;
}
