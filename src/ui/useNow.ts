// Re-render tick for the expiry countdowns — the React equivalent of vanilla's
// 60s setInterval re-render. Components derive isExpired/fmtRemaining from the
// returned timestamp so the whole tree refreshes together.

import { useEffect, useState } from 'react';

export function useNow(intervalMs = 60000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
