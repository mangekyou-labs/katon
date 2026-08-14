// Shared per-thread negotiation view (both sides render through it):
// header (pair / counterparty / expiry / status), current terms from MY
// perspective, round timeline, and the accept / decline / counter actions —
// gated by currentTerms.awaiting (only the non-proposer may act). Once a
// thread is accepted the EXISTING settlement flow takes over unchanged:
// OrderCard + useSettlement, wired exactly like src/App.tsx — nothing
// funds-critical is reimplemented here.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BalanceMap } from '../core/balances';
import { currentTerms } from '../core/negotiation';
import { orderPairKey, pairLabel } from '../core/pairs';
import { fmtRemaining, isExpired, orderTokensKnown, trunc } from '../core/tokens';
import type { Order, Side } from '../core/types';
import {
  acceptInitialTerms, acceptRound, cancelOrderThread, declineInitialTerms, declineRound,
  repairCounteredStatus,
} from '../data/rounds';
import { useRounds } from '../data/useRounds';
import { OrderCard } from './OrderCard';
import { errMsg, useToast } from './Toast';
import { TokenBadge } from './TokenBadge';
import { useSettlement } from './useSettlement';
import { walletSign } from '../wallet/kit';
import { CounterForm } from './CounterForm';
import { RoundTimeline } from './RoundTimeline';

export interface ThreadViewProps {
  order: Order;
  side: Side;
  address: string;
  balances: BalanceMap | null;
  refreshBalances: () => Promise<BalanceMap | null>;
  now: number;
  onChanged: () => Promise<void>;
}

// One settlement action at a time across EVERY mounted ThreadView. This is now
// the page's ONLY settlement mutex: ThreadView is the sole render site of
// OrderCard, so App.tsx no longer calls useSettlement at all (whose txBusy ref
// is per-instance and would be invisible to this lock). Panels stay mounted, so
// up to three ThreadViews can be alive at once — Incoming's list, Sent's list,
// and Sent's BroadcastList. Module scope is what serializes them, without
// touching the frozen useSettlement.
const settleLock = { current: false };

/** Status chip incl. the intent-layer 'countered' status (styles.css has no badge for it). */
export function ThreadStatusBadge({ order, now }: { order: Order; now: number }) {
  const open = order.status === 'pending' || order.status === 'countered';
  const s = open && isExpired(order, now) ? 'expired' : order.status;
  return <span className={s === 'countered' ? 'badge intent-badge--countered' : `badge badge--${s}`}>{s}</span>;
}

export function ThreadView({ order, side, address, balances, refreshBalances, now, onChanged }: ThreadViewProps) {
  const toast = useToast();
  const onRoundsError = useCallback((m: string) => toast(m, 'err'), [toast]);
  const { rounds } = useRounds(order.id, onRoundsError);
  const { signOrder, settle } = useSettlement({ address, refresh: onChanged, toast });
  const [busy, setBusy] = useState(false);
  const [showCounter, setShowCounter] = useState(false);

  const withSettleLock = useCallback(async (fn: () => Promise<void>) => {
    if (settleLock.current) return toast('Another settlement action is in progress.', 'err');
    settleLock.current = true;
    try {
      await fn();
    } finally {
      settleLock.current = false;
    }
  }, [toast]);

  // Self-repair for counterOffer's partial-failure window (see
  // repairCounteredStatus in rounds.ts): an order left 'pending' while a live
  // counter round exists would let the Phase-1 desk accept stale round-0
  // terms. Fire-and-forget, at most once per order id per mount.
  const repairedFor = useRef<string | null>(null);
  useEffect(() => {
    if (order.status !== 'pending') return;
    if (!rounds.some((r) => r.n >= 1 && r.resolution === 'pending')) return;
    if (repairedFor.current === order.id) return;
    repairedFor.current = order.id;
    void repairCounteredStatus(order);
  }, [order, rounds]);

  const terms = currentTerms(order, rounds);
  const known = orderTokensKnown(order);
  const open = order.status === 'pending' || order.status === 'countered';
  const expired = isExpired(order, now);
  const settling = order.status === 'accepted' || (!!order.settlement_status && order.settlement_status !== 'idle');
  const myMove = open && !expired && terms.awaiting === side;
  const pk = orderPairKey(order);

  const giveAmount = side === 'taker' ? terms.taker_amount : terms.maker_amount;
  const giveToken = side === 'taker' ? order.taker_token : order.maker_token;
  const receiveAmount = side === 'taker' ? terms.maker_amount : terms.taker_amount;
  const receiveToken = side === 'taker' ? order.maker_token : order.taker_token;

  const act = async (action: 'accept' | 'decline') => {
    if (busy) return;
    if (isExpired(order, Date.now())) return toast('This order has expired.', 'err');
    if (action === 'accept' && !orderTokensKnown(order))
      return toast('Unrecognized asset — verify the issuer before accepting.', 'err');
    setBusy(true);
    try {
      const pending = terms.latestPending;
      if (!pending) {
        // Round 0 is always the maker's proposal, so only the taker ever lands
        // here — the desk's takerAction pattern, via the 0-row-checked helpers
        // so a row that just closed elsewhere fails honestly.
        const taker_signature = await walletSign(JSON.stringify({ order_id: order.id, action }), address);
        if (action === 'accept') await acceptInitialTerms(order, taker_signature);
        else await declineInitialTerms(order, taker_signature);
      } else if (side === 'taker') {
        const taker_signature = await walletSign(JSON.stringify({ order_id: order.id, action }), address);
        if (action === 'accept') await acceptRound(order, pending, { taker_signature });
        else await declineRound(order, pending, { taker_signature });
      } else {
        // No message signature for a maker RFQ-accept: orders has no column
        // for one, and the maker's binding signature happens at settlement
        // (the signed auth entry) — same accepted-risk class as the
        // stored-but-unverified RFQ signatures (CLAUDE.md).
        if (action === 'accept') await acceptRound(order, pending);
        else await declineRound(order, pending);
      }
      toast(action === 'accept' ? 'Order accepted.' : 'Order declined.', 'ok');
      await onChanged();
    } catch (err) {
      toast(errMsg(err, 'Action failed.'), 'err');
    } finally {
      setBusy(false);
    }
  };

  // The maker's withdrawal while waiting on the counterparty. Only offered when
  // it is NOT my move: with the move, Decline already closes the thread, and
  // two buttons that both close it (declined vs cancelled) only confuse.
  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await cancelOrderThread(order);
      toast('Offer cancelled.', 'ok');
      await onChanged();
    } catch (err) {
      toast(errMsg(err, 'Could not cancel the offer.'), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thread">
      <div className="thread__head">
        <div className="thread__id">
          <span className="thread__pair">
            {pk ? pairLabel(pk) : <><TokenBadge value={order.maker_token} /> / <TokenBadge value={order.taker_token} /></>}
          </span>
          {order.broadcast_id ? <span className="intent-badge">Private offer</span> : null}
          <ThreadStatusBadge order={order} now={now} />
        </div>
        <div className="thread__meta">
          <span className="thread__party">
            {side === 'taker'
              ? <>From maker <b>{trunc(order.maker_address)}</b></>
              : <>To taker <b>{trunc(order.taker_address)}</b></>}
          </span>
          {open ? <span>{expired ? 'Expired' : `Expires in ${fmtRemaining(order.expiration, now)}`}</span> : null}
        </div>
      </div>

      {settling ? (
        <>
          <OrderCard order={order} role={side === 'taker' ? 'incoming' : 'sent'} now={now}
            onSign={(o, s) => void withSettleLock(() => signOrder(o, s))}
            onSettle={(o) => void withSettleLock(() => settle(o))} />
          <RoundTimeline order={order} rounds={rounds} side={side} />
        </>
      ) : (
        <>
          <div className="thread__terms">
            <div className="thread__round-label">
              {terms.n === 0 ? 'Initial terms' : `Counter #${terms.n}`} · proposed by {terms.proposer === side ? 'you' : 'counterparty'}
            </div>
            <div className="legs">
              <div className="legbox legbox--out">
                <div className="legbox__k">You give</div>
                <div className="legbox__v">{giveAmount}<span className="legbox__t"><TokenBadge value={giveToken} /></span></div>
              </div>
              <div className="legs__swap" aria-hidden="true">⇄</div>
              <div className="legbox legbox--in">
                <div className="legbox__k">You receive</div>
                <div className="legbox__v">{receiveAmount}<span className="legbox__t"><TokenBadge value={receiveToken} /></span></div>
              </div>
            </div>
          </div>

          <RoundTimeline order={order} rounds={rounds} side={side} />

          {myMove && !known ? (
            <div className="settle__err">
              ⚠ Unrecognized asset — verify the issuer shown above before trading. Accept and counter are disabled.
            </div>
          ) : null}

          {myMove ? (
            <>
              <div className="order__actions">
                {known ? (
                  <button className="btn btn--gold btn--sm" disabled={busy} onClick={() => void act('accept')}>Accept</button>
                ) : null}
                <button className="btn btn--danger btn--sm" disabled={busy} onClick={() => void act('decline')}>Decline</button>
                {known ? (
                  <button className="btn btn--ghost btn--sm" disabled={busy}
                    onClick={() => setShowCounter((v) => !v)}>{showCounter ? 'Hide counter' : 'Counter'}</button>
                ) : null}
              </div>
              {showCounter ? (
                <CounterForm order={order} rounds={rounds} side={side} address={address}
                  balances={balances} refreshBalances={refreshBalances}
                  onDone={async () => { setShowCounter(false); await onChanged(); }}
                  onCancel={() => setShowCounter(false)} />
              ) : null}
            </>
          ) : open && !expired ? (
            <>
              <div className="thread__wait">Waiting for the counterparty to respond…</div>
              {side === 'maker' ? (
                <div className="order__actions">
                  <button className="btn btn--danger btn--sm" disabled={busy}
                    onClick={() => void cancel()}>Cancel offer</button>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
