// A list of offers, from one side. Each row is a compact summary that expands
// into the shared ThreadView — one thread open at a time keeps the per-thread
// rounds realtime channels lean.
//
// Used twice: Incoming (side='taker', every order addressed to me) and Sent
// (side='maker', my DIRECT orders — broadcasts are grouped by BroadcastList
// instead, because a broadcast is one offer with N threads, a different object).
// Directed and broadcast offers share this list on the taker side and interleave
// by recency: a taker does not care which channel an offer arrived through, only
// that the "Private offer" pill says it came from a broadcast.

import { useState } from 'react';
import type { BalanceMap } from '../core/balances';
import { orderPairKey, pairLabel } from '../core/pairs';
import { fmtRemaining, isExpired, trunc } from '../core/tokens';
import type { Order, Side } from '../core/types';
import { TokenBadge } from './TokenBadge';
import { ThreadStatusBadge, ThreadView } from './ThreadView';

export interface OfferListProps {
  address: string;
  orders: Order[];
  /** my role in these orders: 'taker' (Incoming) or 'maker' (Sent) */
  side: Side;
  emptyText: string;
  now: number;
  balances: BalanceMap | null;
  refreshBalances: () => Promise<BalanceMap | null>;
  onChanged: () => Promise<void>;
}

export function OfferList({
  address, orders, side, emptyText, now, balances, refreshBalances, onChanged,
}: OfferListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (orders.length === 0) return <div className="empty">{emptyText}</div>;

  return (
    <div className="intent-offers">
      {orders.map((o) => {
        const expanded = selectedId === o.id;
        const pk = orderPairKey(o);
        const open = o.status === 'pending' || o.status === 'countered';
        return (
          <div key={o.id} className="order thread-card">
            <button type="button" className="thread-card__toggle" aria-expanded={expanded}
              onClick={() => setSelectedId(expanded ? null : o.id)}>
              <span className="thread-card__pair">
                {/* pk is null for a same-token order (XLM→XLM, the E2E vehicle) —
                    render the legs honestly rather than inventing a pair label */}
                {pk ? pairLabel(pk) : <><TokenBadge value={o.maker_token} /> / <TokenBadge value={o.taker_token} /></>}
              </span>
              <span className="thread-card__party">
                {side === 'taker'
                  ? <>from <b>{trunc(o.maker_address)}</b></>
                  : <>to <b>{trunc(o.taker_address)}</b></>}
              </span>
              {/* provenance: directed and broadcast offers share this list now */}
              {o.broadcast_id ? <span className="intent-badge">Private offer</span> : null}
              <ThreadStatusBadge order={o} now={now} />
              {open ? (
                <span className="thread-card__expiry">
                  {isExpired(o, now) ? 'Expired' : `Expires in ${fmtRemaining(o.expiration, now)}`}
                </span>
              ) : null}
              <span className="thread-card__chev" aria-hidden="true">▾</span>
            </button>
            {expanded ? (
              <ThreadView order={o} side={side} address={address} balances={balances}
                refreshBalances={refreshBalances} now={now} onChanged={onChanged} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
