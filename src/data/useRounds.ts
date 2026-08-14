// Rounds state for one negotiation thread: initial load + Supabase realtime.
// Counters alternate live via rounds INSERTs; resolutions arrive as UPDATEs
// (spec §4.4). order_id is a uuid, so it is safe in the realtime filter
// syntax. Mirrors useOrders' stale-fetch guard and channel teardown.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { fetchRounds } from './rounds';
import type { RoundRow } from '../core/types';

export function useRounds(orderId: string | null, onError: (msg: string) => void) {
  const [rounds, setRounds] = useState<RoundRow[]>([]);

  // guards a slow fetch resolving after the thread changed/closed
  const idRef = useRef(orderId);
  idRef.current = orderId;

  const refresh = useCallback(async () => {
    const id = orderId;
    if (!id) return;
    try {
      const rows = await fetchRounds(id);
      if (idRef.current === id) setRounds(rows);
    } catch {
      onError('Failed to load counter-offers.');
    }
  }, [orderId, onError]);

  useEffect(() => {
    if (!orderId) {
      setRounds([]);
      return;
    }
    void refresh();
    // unique channel name per order id — several threads can be open at once
    const ch = supabase.channel(`otc-rounds-${orderId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'rounds', filter: `order_id=eq.${orderId}` },
        () => void refresh())
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rounds', filter: `order_id=eq.${orderId}` },
        () => void refresh())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [orderId, refresh]);

  return { rounds, refresh };
}
