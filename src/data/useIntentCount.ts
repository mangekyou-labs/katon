// Live "N takers subscribed" counter for the Broadcast ticket (spec §4.2).
// count stays null until the first fetch lands (and on error) so the UI can
// distinguish "loading/unknown" from a real zero.

import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { countIntents } from './intents';

export function useIntentCount(pair_key: string | null, excludeAddress?: string) {
  const [count, setCount] = useState<number | null>(null);

  // guards a slow count resolving after the selected pair changed
  const keyRef = useRef(pair_key);
  keyRef.current = pair_key;

  useEffect(() => {
    const key = pair_key;
    if (!key) {
      setCount(null);
      return;
    }
    const load = async () => {
      try {
        const c = await countIntents(key, excludeAddress);
        if (keyRef.current === key) setCount(c);
      } catch {
        if (keyRef.current === key) setCount(null);
      }
    };
    void load();
    // UNFILTERED channel on purpose: pair_key contains '|' and ':', which are
    // not safe in the realtime filter syntax (unlike the plain uuid/G-address
    // filters useOrders uses). intents is tiny, so refetching the count on any
    // INSERT/DELETE is cheap. (Toggles are insert/delete only — no UPDATE.)
    const ch = supabase.channel(`otc-intent-count-${key.replace(/[^A-Z0-9]/gi, '')}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'intents' }, () => void load())
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'intents' }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [pair_key, excludeAddress]);

  return { count };
}
