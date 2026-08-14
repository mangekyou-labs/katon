// Thin query/mutation layer over public.intents (taker pair-interest toggles).
// Insert = toggle on, delete = toggle off — the table has no anon UPDATE grant,
// and rows are never updated in place (docs/migrations/2026-07-10-intent-layer.sql).

import { supabase } from './supabase';
import type { IntentRow } from '../core/types';

export async function fetchMyIntents(address: string): Promise<IntentRow[]> {
  const { data, error } = await supabase.from('intents')
    .select('*').eq('address', address)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as IntentRow[];
}

/** The fan-out list for a pair — every subscribed address except the maker's own. */
export async function fetchIntentAddresses(pair_key: string, excludeAddress?: string): Promise<string[]> {
  let q = supabase.from('intents').select('address').eq('pair_key', pair_key);
  if (excludeAddress) q = q.neq('address', excludeAddress);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as { address: string }[]).map((r) => r.address);
}

/** Subscriber count for the live "N takers subscribed" counter — no rows transferred. */
export async function countIntents(pair_key: string, excludeAddress?: string): Promise<number> {
  let q = supabase.from('intents')
    .select('*', { count: 'exact', head: true })
    .eq('pair_key', pair_key);
  if (excludeAddress) q = q.neq('address', excludeAddress);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function addIntent(address: string, pair_key: string): Promise<void> {
  const { error } = await supabase.from('intents').insert({ address, pair_key });
  if (error) throw error;
}

export async function removeIntent(address: string, pair_key: string): Promise<void> {
  const { error } = await supabase.from('intents').delete().match({ address, pair_key });
  if (error) throw error;
}
