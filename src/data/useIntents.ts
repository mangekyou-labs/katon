// The connected wallet's own pair-interest toggles (Pairs panel state).
// No realtime channel: only this wallet writes its own intents, and every
// toggle refetches — a subscription would only echo our own writes back.
// Mirrors useOrders' addrRef stale-fetch guard.

import { useCallback, useEffect, useRef, useState } from 'react';
import { addIntent, fetchMyIntents, removeIntent } from './intents';
import type { IntentRow } from '../core/types';

export function useIntents(address: string | null, onError: (msg: string) => void) {
  const [intents, setIntents] = useState<IntentRow[]>([]);
  // the pair being toggled right now — disables that toggle, prevents double-fires
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // guards a slow fetch resolving after disconnect/reconnect
  const addrRef = useRef(address);
  addrRef.current = address;

  const refresh = useCallback(async () => {
    const a = address;
    if (!a) return;
    try {
      const rows = await fetchMyIntents(a);
      if (addrRef.current === a) setIntents(rows);
    } catch {
      onError('Failed to load your pair interests.');
    }
  }, [address, onError]);

  useEffect(() => {
    if (!address) {
      setIntents([]);
      return;
    }
    void refresh();
  }, [address, refresh]);

  const has = useCallback(
    (pair_key: string) => intents.some((i) => i.pair_key === pair_key),
    [intents],
  );

  const toggle = useCallback(async (pair_key: string) => {
    const a = address;
    if (!a || busyKey) return;
    setBusyKey(pair_key);
    try {
      if (intents.some((i) => i.pair_key === pair_key)) await removeIntent(a, pair_key);
      else await addIntent(a, pair_key);
      await refresh();
    } catch {
      onError('Could not update your pair interest.');
    } finally {
      setBusyKey(null);
    }
  }, [address, busyKey, intents, refresh, onError]);

  return { intents, has, toggle, busyKey, refresh };
}
