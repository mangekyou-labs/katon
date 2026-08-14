// Counter-offer form (spec §4.3): two amounts prefilled from the live thread
// terms, labeled from MY perspective; tokens are fixed by the thread — only
// amounts change. Submit is balance-gated on MY give-leg against a FRESH
// Horizon fetch (client-side friction, not enforcement — spec §5), then
// wallet-signs the deterministic round payload and hands the writes to
// counterOffer (insert → supersede → order status).

import { useState, type FormEvent } from 'react';
import { balanceOf, canAfford, fmtBalance } from '../core/balances';
import type { BalanceMap } from '../core/balances';
import { amountTooLarge, composeRoundPayload, currentTerms, nextRoundN } from '../core/negotiation';
import { isExpired, tokenLabel, validAmount } from '../core/tokens';
import type { Order, RoundRow, Side } from '../core/types';
import { counterOffer } from '../data/rounds';
import { errMsg, useToast } from './Toast';
import { walletSign } from '../wallet/kit';

export interface CounterFormProps {
  order: Order;
  rounds: RoundRow[];
  side: Side;
  address: string;
  balances: BalanceMap | null;
  refreshBalances: () => Promise<BalanceMap | null>;
  /** called after a successful counter (collapse the form + refetch orders) */
  onDone: () => Promise<void>;
  /** collapse the form without submitting */
  onCancel: () => void;
}

export function CounterForm({ order, rounds, side, address, balances, refreshBalances, onDone, onCancel }: CounterFormProps) {
  const toast = useToast();
  const terms = currentTerms(order, rounds);
  const [giveAmount, setGiveAmount] = useState(side === 'taker' ? terms.taker_amount : terms.maker_amount);
  const [receiveAmount, setReceiveAmount] = useState(side === 'taker' ? terms.maker_amount : terms.taker_amount);
  const [busy, setBusy] = useState(false);

  const giveToken = side === 'taker' ? order.taker_token : order.maker_token;
  const receiveToken = side === 'taker' ? order.maker_token : order.taker_token;

  async function submit(e: FormEvent) {
    e.preventDefault();
    // click-time re-check, mirroring ThreadView.act — the form can sit open
    // past the thread's expiry
    if (isExpired(order, Date.now())) return toast('This thread has expired.', 'err');
    const give = giveAmount.trim();
    const receive = receiveAmount.trim();
    if (!validAmount(give)) return toast('Enter a valid "give" amount (max 7 decimals).', 'err');
    if (!validAmount(receive)) return toast('Enter a valid "receive" amount (max 7 decimals).', 'err');
    if (amountTooLarge(give) || amountTooLarge(receive))
      return toast('Amount too large (max 10,000,000,000,000).', 'err');

    setBusy(true);
    try {
      // gate on a fresh balance, never a stale map; refreshBalances rethrows
      // on network failure and canAfford fails closed on null
      let fresh: BalanceMap | null;
      try {
        fresh = await refreshBalances();
      } catch {
        return toast('Could not check your balance — try again.', 'err');
      }
      if (!canAfford(fresh, giveToken, give))
        return toast(`Insufficient ${tokenLabel(giveToken)} balance for this counter-offer.`, 'err');

      const maker_amount = side === 'taker' ? receive : give;
      const taker_amount = side === 'taker' ? give : receive;
      const n = nextRoundN(rounds);
      const payload = composeRoundPayload({
        kind: 'round',
        order_id: order.id,
        n,
        proposer: side,
        maker_amount,
        taker_amount,
        maker_token: order.maker_token,
        taker_token: order.taker_token,
        expiration: order.expiration,
      });
      const signature = await walletSign(payload, address);
      await counterOffer(order, rounds, side, maker_amount, taker_amount, payload, signature);
      toast('Counter-offer signed and sent.', 'ok');
      await onDone();
    } catch (err) {
      toast(errMsg(err, 'Could not send counter-offer.'), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="counter-form" onSubmit={submit}>
      <div className="counter-form__title">Counter-offer</div>

      <div className="field">
        <label className="field__label" htmlFor={`counterGive-${order.id}`}>You give</label>
        <div className="leg">
          <input type="text" id={`counterGive-${order.id}`} className="input--num" inputMode="decimal"
            placeholder="0.00" value={giveAmount} disabled={busy}
            onChange={(e) => setGiveAmount(e.target.value)} />
          <span className="counter-token">{tokenLabel(giveToken)}</span>
        </div>
        <div className="hint">
          Spendable: {balances ? `${fmtBalance(balanceOf(balances, giveToken))} ${tokenLabel(giveToken)}` : 'unknown'}
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`counterReceive-${order.id}`}>You receive</label>
        <div className="leg">
          <input type="text" id={`counterReceive-${order.id}`} className="input--num" inputMode="decimal"
            placeholder="0.00" value={receiveAmount} disabled={busy}
            onChange={(e) => setReceiveAmount(e.target.value)} />
          <span className="counter-token">{tokenLabel(receiveToken)}</span>
        </div>
      </div>

      <div className="counter-form__actions">
        <button type="submit" className="btn btn--gold btn--sm" disabled={busy}>
          {busy ? 'Waiting for signature…' : 'Sign & send counter'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <span className="hint">You'll be asked to sign the counter-offer in your wallet.</span>
      </div>
    </form>
  );
}
