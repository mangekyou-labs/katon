// Wallet balances for the connected wallet, from Horizon GET /accounts/{id}
// (spec §4.5). Mirrors useOrders' conventions: addrRef guards a slow fetch
// resolving after disconnect/reconnect; state clears to null on disconnect.
//
// `balances` semantics (canAfford in core/balances.ts fails closed on null):
//   null → not loaded yet, or the last fetch FAILED — unknown ≠ zero.
//   {}   → loaded, unfunded account. Horizon 404 is a normal Testnet state,
//          not an error (spec: friendly zero-balance handling), so it sets
//          emptyBalances() + funded=false instead of throwing.
//
// `refresh()` resolves to the fresh map so Send/Counter flows can gate on
// up-to-date values instead of possibly-stale state (spec: balances are
// refreshed before any Send/Counter). Real failures (non-OK, network) rethrow
// from refresh() so interactive callers can toast; the on-mount load swallows
// them into a console.warn.

import { useCallback, useEffect, useRef, useState } from 'react';
import { HORIZON_URL } from '../config';
import { emptyBalances, parseAccountBalances } from '../core/balances';
import type { BalanceMap } from '../core/balances';

export function useBalances(address: string | null) {
  const [balances, setBalances] = useState<BalanceMap | null>(null);
  const [funded, setFunded] = useState(false);
  // starts true when mounted already-connected, so the UI shows "loading"
  // rather than "unavailable" before the first fetch settles
  const [loading, setLoading] = useState(address !== null);

  // guards a slow fetch resolving after disconnect/reconnect
  const addrRef = useRef(address);
  addrRef.current = address;

  const refresh = useCallback(async (): Promise<BalanceMap | null> => {
    const a = address;
    if (!a) return null;
    setLoading(true);
    try {
      const res = await fetch(`${HORIZON_URL}/accounts/${a}`);
      let next: BalanceMap;
      let isFunded: boolean;
      if (res.status === 404) {
        next = emptyBalances(); // unfunded account — a normal state, not an error
        isFunded = false;
      } else if (res.ok) {
        next = parseAccountBalances(await res.json());
        isFunded = true;
      } else {
        throw new Error(`Horizon ${res.status} loading balances`);
      }
      if (addrRef.current === a) {
        setBalances(next);
        setFunded(isFunded);
      }
      return next;
    } catch (err) {
      // unknown ≠ zero: drop to null so canAfford fails closed, then rethrow
      // so the caller decides how to surface it
      if (addrRef.current === a) setBalances(null);
      throw err;
    } finally {
      if (addrRef.current === a) setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (!address) {
      setBalances(null);
      setFunded(false);
      setLoading(false);
      return;
    }
    refresh().catch((err) => console.warn('Balance load failed:', err));
  }, [address, refresh]);

  return { balances, funded, loading, refresh };
}
