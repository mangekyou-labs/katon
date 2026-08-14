// Settlement strip for an accepted order: three-step stepper (maker signed →
// taker signed → settled) + the action for the current state. Ported from
// otc.js settlementStrip(); side = my role in the list rendering this strip.

import { EXPLORER, settlementEnabled } from '../config';
import { isTxHash } from '../core/tokens';
import type { Order, Side } from '../core/types';

function Step({ done, current, final, label }: { done: boolean; current: boolean; final?: boolean; label: string }) {
  const cls = ['stepper__step', done && 'is-done', current && 'is-current', final && 'is-final']
    .filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <span className="stepper__dot">{done ? '✓' : ''}</span>
      <span className="stepper__label">{label}</span>
    </div>
  );
}

interface StripProps {
  order: Order;
  side: Side;
  onSign: (order: Order, side: Side) => void;
  onSettle: (order: Order) => void;
}

export function SettlementStrip({ order: o, side, onSign, onSettle }: StripProps) {
  if (!settlementEnabled) {
    return (
      <div className="settle">
        <div className="settle__msg">
          On-chain settlement isn't configured yet — set <b>OTC_CONTRACT_ID</b> in otc-config.js.
        </div>
      </div>
    );
  }

  const st = o.settlement_status || 'idle';
  const makerOk = !!o.maker_auth, takerOk = !!o.taker_auth;
  const myOk = side === 'maker' ? makerOk : takerOk;
  const otherOk = side === 'maker' ? takerOk : makerOk;
  const settled = st === 'settled';

  let actions;
  if (settled) {
    actions = isTxHash(o.settle_tx_hash) ? (
      <div className="settle__msg">
        <a href={`${EXPLORER}/tx/${o.settle_tx_hash}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>
      </div>
    ) : null;
  } else if (st === 'settling') {
    actions = <div className="settle__msg">Submitting settlement…</div>;
  } else if (!myOk) {
    actions = (
      <div className="order__actions">
        <button className="btn btn--gold btn--sm" onClick={() => onSign(o, side)}>Sign order</button>
      </div>
    );
  } else if (!otherOk) {
    actions = <div className="settle__msg">Waiting for the counterparty to sign…</div>;
  } else {
    actions = (
      <div className="order__actions">
        <button className="btn btn--gold btn--sm" onClick={() => onSettle(o)}>Settle now</button>
      </div>
    );
  }

  return (
    <div className="settle">
      <div className="settle__title">On-chain settlement</div>
      <div className="stepper">
        <Step done={makerOk || settled} current={!makerOk && !settled} label="Maker signed" />
        <div className={`stepper__bar${(makerOk && takerOk) || settled ? ' is-done' : ''}`} />
        <Step done={takerOk || settled} current={!takerOk && !settled} label="Taker signed" />
        <div className={`stepper__bar${settled ? ' is-done' : ''}`} />
        <Step done={settled} current={makerOk && takerOk && !settled} final label="Settled" />
      </div>
      {actions}
      {st === 'failed' && o.settle_error
        ? <div className="settle__err">Last attempt failed: {o.settle_error}</div>
        : null}
    </div>
  );
}
