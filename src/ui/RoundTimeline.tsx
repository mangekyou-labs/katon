// Negotiation history for one thread: round 0 (the order row's initial terms,
// always proposed by the maker) followed by each counter round ascending.
// Amounts render from MY perspective (`side`); tokens never change mid-thread,
// so both legs' tokens always come from the order row. RoundRow numerics
// arrive as JS numbers from PostgREST — String(...) restores the string
// convention before display.

import { orderTokensKnown, tokenLabel } from '../core/tokens';
import type { Order, RoundResolution, RoundRow, Side } from '../core/types';
import { TokenBadge } from './TokenBadge';

export interface RoundTimelineProps {
  order: Order;
  rounds: RoundRow[];
  side: Side;
}

interface TimelineEntry {
  n: number;
  proposer: Side;
  maker_amount: string;
  taker_amount: string;
  resolution: RoundResolution;
  created_at: string;
}

// Round 0 has no rounds row — derive its resolution: any counter supersedes
// the initial terms; otherwise the order row's own status is the answer.
function round0Resolution(order: Order, rounds: RoundRow[]): RoundResolution {
  if (rounds.length > 0) return 'superseded';
  if (order.status === 'accepted') return 'accepted';
  if (order.status === 'declined') return 'declined';
  return 'pending';
}

export function RoundTimeline({ order, rounds, side }: RoundTimelineProps) {
  // acceptRound rewrites the order row's amounts with the final agreed terms
  // (the row is settlement's single source of truth), so after an accepted
  // counter the true round-0 amounts are unrecoverable — don't mislabel the
  // final amounts as "initial". Gated on an actually-ACCEPTED round: a
  // round-0 accept with stale (unresolved) counter rows lying around never
  // rewrote anything, and the order amounts really are the initial terms.
  const round0Rewritten = order.status === 'accepted' && rounds.some((r) => r.resolution === 'accepted');
  // unknown-token quarantine (same rule as everywhere else): only allow-listed
  // tokens render as a bare label; anything else goes through TokenBadge
  const known = orderTokensKnown(order);

  const entries: TimelineEntry[] = [
    {
      n: 0,
      proposer: 'maker',
      maker_amount: String(order.maker_amount),
      taker_amount: String(order.taker_amount),
      resolution: round0Resolution(order, rounds),
      created_at: order.created_at,
    },
    ...[...rounds].sort((a, b) => a.n - b.n).map((r) => ({
      n: r.n,
      proposer: r.proposer,
      maker_amount: String(r.maker_amount),
      taker_amount: String(r.taker_amount),
      resolution: r.resolution,
      created_at: r.created_at,
    })),
  ];

  return (
    <section className="round-list">
      <div className="round-list__title">Negotiation</div>
      <ol className="round-list__items">
        {entries.map((e) => {
          const give = side === 'taker' ? e.taker_amount : e.maker_amount;
          const giveToken = side === 'taker' ? order.taker_token : order.maker_token;
          const recv = side === 'taker' ? e.maker_amount : e.taker_amount;
          const recvToken = side === 'taker' ? order.maker_token : order.taker_token;
          return (
            <li className="round-item" key={e.n}>
              <div className="round-item__head">
                <span className="round-item__who">
                  {e.n === 0 ? 'Initial terms' : `Counter #${e.n}`} · {e.proposer === side ? 'you' : 'counterparty'}
                </span>
                <span className={`round-res round-res--${e.resolution}`}>{e.resolution}</span>
              </div>
              {e.n === 0 && round0Rewritten ? (
                <div className="round-item__terms">Superseded — the accepted round's terms were written onto the order.</div>
              ) : (
                <div className="round-item__terms">
                  You give {give} {known ? tokenLabel(giveToken) : <TokenBadge value={giveToken} />}
                  {' → receive '}{recv} {known ? tokenLabel(recvToken) : <TokenBadge value={recvToken} />}
                </div>
              )}
              <div className="round-item__time">{new Date(e.created_at).toLocaleString()}</div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
