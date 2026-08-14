// Reference fair-price for a token pair, from the Reflector oracle. `rate` is
// how many TAKER tokens one MAKER token is worth (takerAmount ≈ makerAmount ×
// rate). null whenever there is no trustworthy number: an unsupported token, an
// unreachable/stale price, or the feature turned off. The Ticket treats null as
// "show no suggestion" — the oracle never blocks the form.
//
// Fetches ONLY when the token PAIR changes (the rate does not depend on the
// typed amounts), and caches each symbol's price briefly so toggling tokens
// back and forth does not re-hit RPC. Reflector updates every ~5 min.

import { useEffect, useRef, useState } from 'react';
import { crossRate, isStale, oracleSymbol } from '../core/oracle';
import { fetchLastPrice, type PriceData } from './oracle';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { data: PriceData | null; at: number }>();

async function cachedPrice(symbol: string): Promise<PriceData | null> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await fetchLastPrice(symbol);
  cache.set(symbol, { data, at: Date.now() });
  return data;
}

export function useFairPrice(makerToken: string, takerToken: string) {
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // guards a slow fetch resolving after the pair changed
  const pairRef = useRef('');

  useEffect(() => {
    const makerSym = oracleSymbol(makerToken);
    const takerSym = oracleSymbol(takerToken);
    const pair = `${makerSym}|${takerSym}`;
    pairRef.current = pair;

    if (!makerSym || !takerSym || makerSym === takerSym) {
      setRate(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    void (async () => {
      const [m, t] = await Promise.all([cachedPrice(makerSym), cachedPrice(takerSym)]);
      if (pairRef.current !== pair) return; // stale — a newer pair is in flight
      const now = Date.now();
      const fresh = m && t && !isStale(m.timestamp, now) && !isStale(t.timestamp, now);
      setRate(fresh ? crossRate(m.price, t.price) : null);
      setLoading(false);
    })();
  }, [makerToken, takerToken]);

  return { rate, loading };
}
