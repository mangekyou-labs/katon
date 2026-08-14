// One order row, incoming or sent — ported from otc.js renderIncoming/
// renderSent templates. Markup and classes mirror styles.css exactly
// (.order, .legs, .legbox, .badge, .sig, .settle__err, …).

import { fmtRemaining, isExpired, orderTokensKnown, trunc } from '../core/tokens';
import type { Order, Side } from '../core/types';
import { SettlementStrip } from './SettlementStrip';
import { TokenBadge } from './TokenBadge';

function StatusBadge({ order, now }: { order: Order; now: number }) {
  const expired = order.status === 'pending' && isExpired(order, now);
  const s = expired ? 'expired' : order.status;
  return <span className={`badge badge--${s}`}>{s}</span>;
}

function Leg({ dir, label, amount, token }: { dir: 'in' | 'out'; label: string; amount: string; token: string }) {
  return (
    <div className={`legbox legbox--${dir}`}>
      <div className="legbox__k">{label}</div>
      <div className="legbox__v">{amount}<span className="legbox__t"><TokenBadge value={token} /></span></div>
    </div>
  );
}

interface CardProps {
  order: Order;
  /** which list this card sits in — 'incoming' (I'm the taker) or 'sent' (I'm the maker) */
  role: 'incoming' | 'sent';
  now: number;
  onAccept?: (order: Order) => void;
  onDecline?: (order: Order) => void;
  onCancel?: (order: Order) => void;
  onSign: (order: Order, side: Side) => void;
  onSettle: (order: Order) => void;
}

export function OrderCard({ order: o, role, now, onAccept, onDecline, onCancel, onSign, onSettle }: CardProps) {
  const expired = o.status === 'pending' && isExpired(o, now);
  const known = orderTokensKnown(o);
  const canAct = o.status === 'pending' && !expired;
  const side: Side = role === 'incoming' ? 'taker' : 'maker';
  const expiryText = o.status === 'pending' ? (expired ? 'Expired' : `Expires in ${fmtRemaining(o.expiration, now)}`) : '';

  return (
    <div className="order">
      <div className="order__top">
        <div className="order__party">
          {role === 'incoming' ? <>From maker <b>{trunc(o.maker_address)}</b></> : <>To taker <b>{trunc(o.taker_address)}</b></>}
        </div>
        <StatusBadge order={o} now={now} />
      </div>

      {role === 'incoming' ? (
        <div className="legs">
          <Leg dir="in" label="You receive" amount={o.maker_amount} token={o.maker_token} />
          <div className="legs__swap" aria-hidden="true">⇄</div>
          <Leg dir="out" label="You send" amount={o.taker_amount} token={o.taker_token} />
        </div>
      ) : (
        <div className="legs">
          <Leg dir="out" label="You send" amount={o.maker_amount} token={o.maker_token} />
          <div className="legs__swap" aria-hidden="true">⇄</div>
          <Leg dir="in" label="You receive" amount={o.taker_amount} token={o.taker_token} />
        </div>
      )}

      <div className="order__meta">
        <span>{expiryText}</span>
        {role === 'incoming'
          ? <span className="sig">✎ maker signed</span>
          : (o.taker_signature ? <span className="sig is-done">✓ taker signed</span> : null)}
      </div>

      {role === 'incoming' && canAct && !known ? (
        <div className="settle__err">
          ⚠ Unrecognized asset — verify the issuer shown above before trading. Accept is disabled.
        </div>
      ) : null}

      {role === 'incoming' && canAct ? (
        <div className="order__actions">
          {known ? <button className="btn btn--gold btn--sm" onClick={() => onAccept?.(o)}>Accept</button> : null}
          <button className="btn btn--danger btn--sm" onClick={() => onDecline?.(o)}>Decline</button>
        </div>
      ) : null}

      {role === 'sent' && canAct ? (
        <div className="order__actions">
          <button className="btn btn--danger btn--sm" onClick={() => onCancel?.(o)}>Cancel order</button>
        </div>
      ) : null}

      {o.status === 'accepted' ? <SettlementStrip order={o} side={side} onSign={onSign} onSettle={onSettle} /> : null}
    </div>
  );
}
