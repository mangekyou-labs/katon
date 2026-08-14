// Orders state for the connected wallet: initial load + Supabase realtime.
// Mirrors the vanilla setup: two channels routed by address (incoming = rows
// where I'm the taker, sent = rows where I'm the maker), each change reloading
// its list. Cleanup on address change/disconnect tears the channels down.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { fetchOrders } from './orders';
import type { Order } from '../core/types';

export function useOrders(address: string | null, onError: (msg: string) => void) {
  const [incoming, setIncoming] = useState<Order[]>([]);
  const [sent, setSent] = useState<Order[]>([]);

  // guards a slow fetch resolving after disconnect/reconnect
  const addrRef = useRef(address);
  addrRef.current = address;

  const loadIncoming = useCallback(async () => {
    const a = address;
    if (!a) return;
    try {
      const rows = await fetchOrders('taker_address', a);
      if (addrRef.current === a) setIncoming(rows);
    } catch {
      onError('Failed to load incoming orders.');
    }
  }, [address, onError]);

  const loadSent = useCallback(async () => {
    const a = address;
    if (!a) return;
    try {
      const rows = await fetchOrders('maker_address', a);
      if (addrRef.current === a) setSent(rows);
    } catch {
      onError('Failed to load sent orders.');
    }
  }, [address, onError]);

  const refresh = useCallback(
    () => Promise.all([loadIncoming(), loadSent()]).then(() => undefined),
    [loadIncoming, loadSent],
  );

  useEffect(() => {
    if (!address) {
      setIncoming([]);
      setSent([]);
      return;
    }
    void loadIncoming();
    void loadSent();
    const inc = supabase.channel('otc-incoming')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `taker_address=eq.${address}` },
        () => void loadIncoming())
      .subscribe();
    const snt = supabase.channel('otc-sent')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `maker_address=eq.${address}` },
        () => void loadSent())
      .subscribe();
    return () => {
      void supabase.removeChannel(inc);
      void supabase.removeChannel(snt);
    };
  }, [address, loadIncoming, loadSent]);

  return { incoming, sent, loadIncoming, loadSent, refresh };
}
