// Maker-side broadcast dashboard: one card per broadcast (mine, newest first)
// showing the INITIAL terms from the broadcasts row — after acceptance the
// order rows hold the final negotiated amounts (spec §3.4), so the broadcast
// row is the only honest source for "what I originally asked". Each card
// expands into its threads, and each thread into the shared ThreadView with
// side='maker'. Spec §4.4's no-race rule lives here: settling one thread
// NEVER auto-cancels siblings — the broadcast is auto-marked 'completed' when
// a settled thread is detected (the status is a fact, not a decision), and a
// dismissible banner only PROMPTS the maker to cancel the remaining open
// threads. Whole-broadcast cancel is a two-step button. Both cancel flows
// sweep the threads FIRST (the sweep is idempotent) so a failed sweep stays
// retryable — status-first ordering used to strand open threads behind a
// no-longer-'active' broadcast. Expiry is display-only (no status write).

import { useEffect, useRef, useState } from 'react';
import type { BalanceMap } from '../core/balances';
import { isKnownPairKey, orderPairKey, pairLabel } from '../core/pairs';
import { fmtRemaining, isExpired, trunc } from '../core/tokens';
import type { BroadcastRow, Order } from '../core/types';
import { cancelRemainingThreads, updateBroadcastStatus } from '../data/broadcasts';
import { errMsg, useToast } from './Toast';
import { TokenBadge } from './TokenBadge';
import { ThreadStatusBadge, ThreadView } from './ThreadView';

export interface BroadcastListProps {
  address: string;
  broadcasts: BroadcastRow[];       // mine, newest first (from the shell's useBroadcasts)
  orders: Order[];                  // my sent orders that have broadcast_id set (pre-filtered by the shell)
  now: number;
  balances: BalanceMap | null;
  refreshBalances: () => Promise<BalanceMap | null>;
  onChanged: () => Promise<void>;   // refetch broadcasts + orders
}

// .badge (styles.css) provides the chip shape; these map each broadcast status
// to its color modifier. DB strings are untrusted — junk falls back to plain.
const BADGE_CLASS: Record<string, string> = {
  active: 'badge broadcast-badge--active',
  completed: 'badge broadcast-badge--completed',
  cancelled: 'badge badge--cancelled',
  expired: 'badge badge--expired',
};

// display order for the per-status thread tally; unknown statuses trail
const TALLY_ORDER = ['settled', 'accepted', 'countered', 'pending', 'declined', 'cancelled', 'expired'];

/** A thread's status as the maker cares about it here: settled > expired-open > raw. */
function threadTallyStatus(o: Order, now: number): string {
  if (o.settlement_status === 'settled') return 'settled';
  const open = o.status === 'pending' || o.status === 'countered';
  return open && isExpired(o, now) ? 'expired' : o.status;
}

function tallyText(threads: Order[], now: number): string {
  const counts = new Map<string, number>();
  for (const o of threads) {
    const s = threadTallyStatus(o, now);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const s of TALLY_ORDER) {
    const n = counts.get(s);
    if (n) parts.push(`${n} ${s}`);
    counts.delete(s);
  }
  for (const [s, n] of counts) parts.push(`${n} ${s}`);
  return parts.join(' · ');
}

export function BroadcastList({ address, broadcasts, orders, now, balances, refreshBalances, onChanged }: BroadcastListProps) {
  const toast = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null); // two-step cancel
  const [busyId, setBusyId] = useState<string | null>(null);
  // banner dismissals are per-session by design (spec §4.4: prompt, don't decide)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  // Spec §4.4: the broadcast BECOMES completed when one of its threads
  // settles — record the fact automatically (scoped to active so it never
  // clobbers a concurrent cancel). Fire-and-forget, attempted once per
  // broadcast id per mount; errors are swallowed (the next mount retries) and
  // the broadcasts realtime channel delivers the successful UPDATE.
  const completedAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const b of broadcasts) {
      if (b.status !== 'active' || completedAttempted.current.has(b.id)) continue;
      if (!orders.some((o) => o.broadcast_id === b.id && o.settlement_status === 'settled')) continue;
      completedAttempted.current.add(b.id);
      updateBroadcastStatus(b.id, 'completed', { status: 'active' }).catch(() => {});
    }
  }, [broadcasts, orders]);

  // the settled-banner action: ONLY the sweep — completion is recorded by the
  // effect above, and the sweep is idempotent, so a failure is plain retryable
  const cancelRemaining = async (b: BroadcastRow) => {
    if (busyId) return;
    setBusyId(b.id);
    try {
      await cancelRemainingThreads(b.id);
      toast('Remaining open threads cancelled.', 'ok');
      await onChanged();
    } catch (err) {
      toast(errMsg(err, 'Could not cancel the remaining threads.'), 'err');
    } finally {
      setBusyId(null);
    }
  };

  const cancelBroadcast = async (b: BroadcastRow) => {
    if (busyId) return;
    setBusyId(b.id);
    try {
      // sweep FIRST (idempotent, retry-safe), then the status write scoped to
      // active — when the broadcast is already completed/cancelled the write
      // matches 0 rows and no-ops, which is fine: only the open threads
      // needed cancelling.
      await cancelRemainingThreads(b.id);
      await updateBroadcastStatus(b.id, 'cancelled', { status: 'active' });
      toast(b.status === 'active' ? 'Broadcast cancelled.' : 'Open threads cancelled.', 'ok');
      setArmedId(null);
      await onChanged();
    } catch (err) {
      toast(errMsg(err, 'Could not cancel the broadcast.'), 'err');
    } finally {
      setBusyId(null);
    }
  };

  if (broadcasts.length === 0) {
    return <div className="empty">You haven't broadcast any offers yet.</div>;
  }

  return (
    <div className="intent-broadcasts">
      {broadcasts.map((b) => {
        const threads = orders.filter((o) => o.broadcast_id === b.id);
        const expanded = expandedId === b.id;
        const shown = b.status === 'active' && isExpired(b, now) ? 'expired' : b.status;
        const hasSettled = threads.some((o) => o.settlement_status === 'settled');
        const openCount = threads.filter((o) => o.status === 'pending' || o.status === 'countered').length;
        const tally = tallyText(threads, now);
        const busy = busyId !== null;
        // DB strings are untrusted: an attacker-inserted broadcasts row can
        // pair a trusted-looking pair_key with hostile token columns — only
        // render the friendly label when the key matches the actual legs,
        // else fall back to the TokenBadge quarantine (⚠ + issuer).
        const pairTrusted = isKnownPairKey(b.pair_key) &&
          b.pair_key === orderPairKey({ maker_token: b.maker_token, taker_token: b.taker_token });

        return (
          <div key={b.id} className="order broadcast-card">
            <button type="button" className="thread-card__toggle" aria-expanded={expanded}
              onClick={() => {
                setExpandedId(expanded ? null : b.id);
                setExpandedThreadId(null); // never leave a hidden thread's rounds channel live
              }}>
              <span className="thread-card__pair">
                {pairTrusted
                  ? pairLabel(b.pair_key)
                  : <><TokenBadge value={b.maker_token} /> / <TokenBadge value={b.taker_token} /></>}
              </span>
              <span className={BADGE_CLASS[shown] ?? 'badge'}>{shown}</span>
              {b.status === 'active' ? (
                <span className="thread-card__expiry">
                  {isExpired(b, now) ? 'Expired' : `Expires in ${fmtRemaining(b.expiration, now)}`}
                </span>
              ) : null}
              <span className="thread-card__chev" aria-hidden="true">▾</span>
              <span className="broadcast-card__terms">
                {/* initial terms live HERE, not on the order rows (rewritten on accept) */}
                Initial terms: give {String(b.maker_amount)} <TokenBadge value={b.maker_token} />
                {' → ask '}{String(b.taker_amount)} <TokenBadge value={b.taker_token} />
              </span>
              <span className="broadcast-card__tally">
                {threads.length === 0
                  ? 'No threads'
                  : `${threads.length} thread${threads.length === 1 ? '' : 's'}${tally ? ` · ${tally}` : ''}`}
              </span>
            </button>

            {/* not gated on broadcast.status: the prompt must survive e.g. a
                completed status landing before a failed sweep was retried */}
            {hasSettled && openCount > 0 && !dismissed.has(b.id) ? (
              <div className="broadcast-banner">
                <span className="broadcast-banner__msg">
                  A thread of this broadcast has settled on-chain.
                  {` ${openCount} other thread${openCount === 1 ? ' is' : 's are'} still open — you decide what happens to them.`}
                </span>
                <div className="broadcast-banner__actions">
                  <button className="btn btn--gold btn--sm" disabled={busy}
                    onClick={() => void cancelRemaining(b)}>Cancel remaining threads</button>
                  <button className="btn btn--ghost btn--sm" disabled={busy}
                    onClick={() => setDismissed((prev) => new Set(prev).add(b.id))}>Keep negotiating</button>
                </div>
              </div>
            ) : null}

            {expanded ? (
              <div className="broadcast-threads">
                {threads.length === 0 ? (
                  <div className="hint">No threads for this broadcast.</div>
                ) : threads.map((o) => {
                  const tExpanded = expandedThreadId === o.id;
                  return (
                    <div key={o.id} className="broadcast-thread">
                      <button type="button" className="thread-card__toggle" aria-expanded={tExpanded}
                        onClick={() => setExpandedThreadId(tExpanded ? null : o.id)}>
                        <span className="thread-card__party">to <b>{trunc(o.taker_address)}</b></span>
                        <ThreadStatusBadge order={o} now={now} />
                        <span className="thread-card__chev" aria-hidden="true">▾</span>
                      </button>
                      {tExpanded ? (
                        <ThreadView order={o} side="maker" address={address} balances={balances}
                          refreshBalances={refreshBalances} now={now} onChanged={onChanged} />
                      ) : null}
                    </div>
                  );
                })}

                {/* stays available while ANY thread is still open, whatever
                    broadcast.status says — a non-active broadcast with open
                    threads means a sweep failed and must be retryable */}
                {b.status === 'active' || openCount > 0 ? (
                  <div className="order__actions">
                    {armedId === b.id ? (
                      <>
                        <button className="btn btn--danger btn--sm" disabled={busy}
                          onClick={() => void cancelBroadcast(b)}>
                          {b.status === 'active'
                            ? <>Confirm — cancel broadcast &amp; open threads</>
                            : <>Confirm — cancel open threads</>}
                        </button>
                        <button className="btn btn--ghost btn--sm" disabled={busy}
                          onClick={() => setArmedId(null)}>Keep broadcast</button>
                      </>
                    ) : (
                      <button className="btn btn--ghost btn--sm" disabled={busy}
                        onClick={() => setArmedId(b.id)}>
                        {b.status === 'active' ? 'Cancel broadcast' : 'Cancel open threads'}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
