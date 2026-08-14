// The connected maker's broadcasts: initial load + Supabase realtime.
// Status advances (active → completed/cancelled) arrive as UPDATEs — e.g.
// when another of the maker's own tabs settles a thread. Same shape as
// useOrders: address-filtered channel, addrRef stale-fetch guard, teardown
// on address change/disconnect.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { fetchMyBroadcasts } from './broadcasts';
import type { BroadcastRow } from '../core/types';

export function useBroadcasts(maker_address: string | null, onError: (msg: string) => void) {
  const [broadcasts, setBroadcasts] = useState<BroadcastRow[]>([]);

  // guards a slow fetch resolving after disconnect/reconnect
  const addrRef = useRef(maker_address);
  addrRef.current = maker_address;

  const refresh = useCallback(async () => {
    const a = maker_address;
    if (!a) return;
    try {
      const rows = await fetchMyBroadcasts(a);
      if (addrRef.current === a) setBroadcasts(rows);
    } catch {
      onError('Failed to load your broadcasts.');
    }
  }, [maker_address, onError]);

  useEffect(() => {
    if (!maker_address) {
      setBroadcasts([]);
      return;
    }
    void refresh();
    const ch = supabase.channel('otc-broadcasts')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'broadcasts', filter: `maker_address=eq.${maker_address}` },
        () => void refresh())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [maker_address, refresh]);

  return { broadcasts, refresh };
}
