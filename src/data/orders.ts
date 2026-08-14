// Thin query/mutation layer over public.orders. Every update stamps updated_at
// (as every vanilla call site did) and can be scoped with `match` so writes
// stay conditional — e.g. a 'failed' write scoped to settlement_status=settling
// never clobbers a concurrent winner's 'settled'.

import { supabase } from './supabase';
import type { Order } from '../core/types';

export async function fetchOrders(field: 'maker_address' | 'taker_address', address: string): Promise<Order[]> {
  const { data, error } = await supabase.from('orders')
    .select('*').eq(field, address)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Order[];
}

export async function insertOrder(row: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('orders').insert(row);
  if (error) throw error;
}

export async function updateOrder(
  id: string,
  patch: Record<string, unknown>,
  match?: Record<string, string>,
): Promise<void> {
  let q = supabase.from('orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  for (const [k, v] of Object.entries(match ?? {})) q = q.eq(k, v);
  const { error } = await q;
  if (error) throw error;
}

export async function fetchSettlementStatus(id: string): Promise<string | null> {
  const { data } = await supabase.from('orders')
    .select('settlement_status').eq('id', id).single();
  return (data?.settlement_status as string | undefined) ?? null;
}
