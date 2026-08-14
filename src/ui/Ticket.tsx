// The one compose form. A single field decides everything: type a counterparty
// address and the offer is DIRECTED to that wallet (one orders row, the Phase-1
// path); leave it empty and it is a BROADCAST to every taker watching the pair
// (one broadcasts row, fanned out per subscriber). Nothing else differs — the
// old broadcast form's pair select and direction radios were redundant, because
// orderPairKey derives the canonical pair key from the two legs and the
// direction IS the leg order.
//
// Both legs feed both paths, so the validation runs once, and the balance gate
// and the too-large-amount guard cover the directed path too (the desk used to
// allow an amount that BigInt cannot parse back at settlement — an order both
// parties could sign but nobody could ever fill).
//
// Layout (redesigned 2026-07-13 from the "New RFQ Ticket v2" handoff): an
// AirSwap-style OTC ticket. A frosted hero holds the two legs side by side with
// the swap orb pinned to the exact centre; a white strip below carries
// counterparty → expiry → CTA; a signature line closes the card. The legs grid
// is `1fr auto 1fr` with the legs justified INWARD on purpose: the side tracks
// stay equal, so swapping a narrow token (XLM) for a wide one (USDC) cannot
// drift the orb off centre. A plain flex row does drift — do not "simplify" it.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ADDR_MSG, checkAddress, normalizeAddress } from '../core/address';
import { canAfford, type BalanceMap } from '../core/balances';
import { canonicalPayload } from '../core/canonical';
import { amountTooLarge, composeBroadcastPayload } from '../core/negotiation';
import { suggestedAmount } from '../core/oracle';
import { orderPairKey, pairLabel } from '../core/pairs';
import { TOKENS, tokenLabel, validAmount } from '../core/tokens';
import { fanOut, insertBroadcast, updateBroadcastStatus } from '../data/broadcasts';
import { fetchIntentAddresses } from '../data/intents';
import { insertOrder } from '../data/orders';
import { useFairPrice } from '../data/useFairPrice';
import { useIntentCount } from '../data/useIntentCount';
import { walletSign } from '../wallet/kit';
import { AddressSeal } from './AddressSeal';
import { TokenSelect } from './TokenSelect';
import { errMsg, useToast } from './Toast';

const DEFAULT_MAKER_TOKEN = 'XLM';
const DEFAULT_TAKER_TOKEN = TOKENS[1].value; // USDC

// Client-side sanity cap on fan-out (DoS friction, not enforcement); real
// per-maker limits are deferred.
const MAX_FANOUT = 100;

/** The amount inputs size themselves to their content, AirSwap-style. */
const chWidth = (v: string) => `${Math.min(Math.max((v || '0').length, 1), 14)}ch`;

// …and step their glyphs down as the number gets longer. Each leg is capped at
// half the hero (see the layout note above), so a realistic amount at the full
// 46px would overrun its track and wrap the token code under the number. The
// steps live in CSS so the mobile breakpoints keep control of the actual sizes.
const amountClass = (v: string) =>
  v.length >= 12 ? 'input--num is-xxlong'
    : v.length >= 9 ? 'input--num is-xlong'
      : v.length >= 7 ? 'input--num is-long'
        : 'input--num';

/** Implied rate, formatted for a read-back chip. Never a quote — see below. */
function fmtRate(x: number): string {
  if (!isFinite(x) || x <= 0) return '';
  if (x >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: x >= 100 ? 2 : 4 });
  return String(parseFloat(x.toPrecision(4)));
}

interface TicketProps {
  /** null while disconnected — the ticket stays mounted (hidden) so drafts survive */
  address: string | null;
  /** send gates on a FRESH fetch, never a cached map — the topbar strip shows the standing balance */
  refreshBalances: () => Promise<BalanceMap | null>;
  /** called after a successful send (reload lists + switch section) */
  onSent: () => Promise<void>;
}

export function Ticket({ address, refreshBalances, onSent }: TicketProps) {
  const toast = useToast();
  const [makerAmount, setMakerAmount] = useState('');
  const [takerAmount, setTakerAmount] = useState('');
  const [makerToken, setMakerToken] = useState(DEFAULT_MAKER_TOKEN);
  const [takerToken, setTakerToken] = useState(DEFAULT_TAKER_TOKEN);
  const [takerAddress, setTakerAddress] = useState('');
  // Address errors stay SOFT until the field has been touched (blurred, or made
  // valid, or a submit attempted) — half a pasted address is not a mistake yet.
  const [touched, setTouched] = useState(false);
  const [expValue, setExpValue] = useState('60');
  const [expUnit, setExpUnit] = useState('3600000'); // hours
  const [busy, setBusy] = useState(false);

  const printRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // THE discriminator. Everything below reads off these two.
  const directed = takerAddress.length > 0;
  const pairKey = orderPairKey({ maker_token: makerToken, taker_token: takerToken });
  // Both pickers are populated from TOKENS, so "unknown token" is unreachable
  // here — a null pair key can only mean the two legs are the same token.
  const sameToken = pairKey === null;

  const addrCode = checkAddress(takerAddress, address);
  const addrOk = addrCode === 'ok';
  const addrErr = touched && directed && !addrOk;

  // Subscriber count, only while it means something. The `address &&` guard is
  // load-bearing: this form stays MOUNTED while disconnected so drafts survive,
  // and without it the page would hold an `intents` realtime channel open with
  // no wallet — something no other hook in the app does.
  const { count } = useIntentCount(address && !directed ? pairKey : null, address ?? undefined);

  // The `!directed &&` guards are explicit rather than leaning on `count`
  // happening to be null in directed mode: on the first keystroke into the
  // address box, `directed` flips during render while useIntentCount's effect
  // has not yet reset `count`, so a stale `count === 0` would disable the button
  // for one frame. `count === null` (still loading) must NOT disable.
  const disabled = busy || (!directed && sameToken) || (!directed && count === 0);

  // A local echo of the two numbers the maker typed — NOT a fetched quote and
  // never to become one. It exists so a fat-fingered zero is visible as an
  // absurd rate before the wallet prompt, not after settlement.
  const rates = useMemo(() => {
    const a = parseFloat(makerAmount.replace(/,/g, ''));
    const b = parseFloat(takerAmount.replace(/,/g, ''));
    const ta = tokenLabel(makerToken);
    const tb = tokenLabel(takerToken);
    const live = isFinite(a) && a > 0 && isFinite(b) && b > 0;
    return {
      live,
      aLabel: `1 ${ta} =`,
      bLabel: `1 ${tb} =`,
      aChip: live ? `${fmtRate(b / a)} ${tb}` : '—',
      bChip: live ? `${fmtRate(a / b)} ${ta}` : '—',
    };
  }, [makerAmount, takerAmount, makerToken, takerToken]);

  // Reflector reference rate for this pair (taker tokens per 1 maker token).
  // null → no suggestion (unsupported token, stale/unreachable feed, or off).
  const { rate: fairRate } = useFairPrice(makerToken, takerToken);

  // A tap-to-fill suggestion for whichever leg is EMPTY, derived from the leg
  // that has a value. It never overwrites a typed amount, and it is a reference
  // aid only — the maker still edits and signs the field.
  const fmtAmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 7 });
  // Fill string: fixed notation (never exponent) with trailing zeros trimmed, so
  // it always parses back through validAmount, even for tiny amounts.
  const fillStr = (n: number) => n.toFixed(7).replace(/\.?0+$/, '');
  const recvGuess = fairRate != null && validAmount(makerAmount) && takerAmount.trim() === ''
    ? suggestedAmount(parseFloat(makerAmount), fairRate) : null;
  const sendGuess = fairRate != null && validAmount(takerAmount) && makerAmount.trim() === ''
    ? suggestedAmount(parseFloat(takerAmount), 1 / fairRate) : null;
  const suggestReceive = recvGuess && recvGuess > 0 ? recvGuess : null;
  const suggestSend = sendGuess && sendGuess > 0 ? sendGuess : null;

  // The field is one line that scrolls sideways: a "printed" layer underneath
  // renders the address with its head bolded and its last 8 characters on an ink
  // chip, and a transparent textarea sits on top carrying the caret. The two
  // must scroll together or the chip drifts away from the glyphs it belongs to.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.scrollLeft = 1e6; // keep the tail — the part you actually compare — in view
    if (printRef.current) printRef.current.scrollLeft = ta.scrollLeft;
  }, [takerAddress]);

  const tailShown = takerAddress.length === 56 && addrCode !== 'start' && addrCode !== 'charset';

  function swapLegs() {
    setMakerAmount(takerAmount);
    setTakerAmount(makerAmount);
    setMakerToken(takerToken);
    setTakerToken(makerToken);
  }

  function reset() {
    setMakerAmount(''); setTakerAmount(''); setTakerAddress(''); setTouched(false);
    setMakerToken(DEFAULT_MAKER_TOKEN); setTakerToken(DEFAULT_TAKER_TOKEN);
    setExpValue('60'); setExpUnit('3600000');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!address) return; // unreachable while hidden; guards the type

    const maker_amount = makerAmount.trim();
    const taker_amount = takerAmount.trim();
    const taker_address = takerAddress;
    const v = parseInt(expValue, 10);
    const u = parseInt(expUnit, 10);

    // ---- sync phase: no writes, no network -------------------------------
    if (!validAmount(maker_amount)) return toast('Enter a valid "send" amount (max 7 decimals).', 'err');
    if (!validAmount(taker_amount)) return toast('Enter a valid "receive" amount (max 7 decimals).', 'err');
    if (amountTooLarge(maker_amount) || amountTooLarge(taker_amount))
      return toast('Amount too large (max 10,000,000,000,000).', 'err');
    if (directed && !addrOk) {
      setTouched(true);
      return toast(ADDR_MSG[addrCode as Exclude<typeof addrCode, 'ok'>], 'err');
    }
    if (!directed && sameToken)
      return toast('A broadcast needs two different tokens — pick a different token, or enter a counterparty address to send this as a directed offer.', 'err');
    if (!(v > 0)) return toast('Expiry must be greater than zero.', 'err');

    const expiration = new Date(Date.now() + v * u).toISOString();

    setBusy(true);
    try {
      // Gate on a FRESH balance, never a stale map (canAfford fails closed on
      // null). This covers the directed path too: a maker proposing terms they
      // cannot honor burns the TAKER's signature and fee when the SAC transfer
      // reverts at settlement — identical in both modes.
      let fresh: BalanceMap | null;
      try {
        fresh = await refreshBalances();
      } catch {
        return toast('Could not check your balance — try again.', 'err');
      }
      if (!canAfford(fresh, makerToken, maker_amount))
        return toast(`Insufficient ${tokenLabel(makerToken)} balance for this ${directed ? 'order' : 'broadcast'}.`, 'err');

      if (directed) {
        // ---- directed: one orders row, unchanged Phase-1 path -------------
        const order = {
          maker_address: address,
          maker_amount, maker_token: makerToken,
          taker_address, taker_amount, taker_token: takerToken,
          expiration,
          nonce: crypto.randomUUID(),
        };
        const signed_payload = canonicalPayload(order);
        const signature = await walletSign(signed_payload, address);
        await insertOrder({ ...order, signature, signed_payload, status: 'pending' });
        toast('Order signed and sent.', 'ok');
      } else {
        // ---- broadcast: one broadcasts row, fanned out per subscriber -----
        // pairKey cannot be null here (the sync guard returned) — narrow for the
        // type checker, and keep it as one more layer for a future refactor.
        if (!pairKey) return;

        // The authoritative fan-out list, fetched BEFORE any DB write: an empty
        // broadcast must never leave a row behind (the live count can lag).
        const takers = await fetchIntentAddresses(pairKey, address);
        if (takers.length === 0)
          return toast('No takers are subscribed to this pair yet — nothing was sent.', 'err');
        if (takers.length > MAX_FANOUT)
          return toast(`Too many subscribed takers (${takers.length}). Fan-out is capped at ${MAX_FANOUT} for now.`, 'err');

        const row = await insertBroadcast({
          maker_address: address,
          pair_key: pairKey,
          maker_amount, maker_token: makerToken,
          taker_amount, taker_token: takerToken,
          expiration,
        });

        let sentCount: number;
        try {
          // Compose from the RETURNED row (String-wrapped: PostgREST hands
          // numerics back as JS numbers) so the signed bytes match the values
          // fanOut copies onto every order row.
          const payload = composeBroadcastPayload({
            broadcast_id: row.id,
            maker_address: row.maker_address,
            pair_key: row.pair_key,
            maker_amount: String(row.maker_amount),
            maker_token: row.maker_token,
            taker_amount: String(row.taker_amount),
            taker_token: row.taker_token,
            expiration: row.expiration,
          });
          const signature = await walletSign(payload, address);
          sentCount = await fanOut(row, takers, payload, signature);
        } catch (err) {
          // The row exists but no fan-out rows do (e.g. the wallet prompt was
          // rejected) — best-effort cleanup of the orphan 'active' broadcast;
          // if this write fails too, the orphan just sits until it expires.
          await updateBroadcastStatus(row.id, 'cancelled', { status: 'active' }).catch(() => {});
          throw err;
        }
        toast(`Broadcast signed and sent to ${sentCount} taker${sentCount === 1 ? '' : 's'}.`, 'ok');
      }

      reset();
      await onSent();
    } catch (err) {
      toast(errMsg(err, directed ? 'Could not send order.' : 'Could not send broadcast.'), 'err');
    } finally {
      setBusy(false);
    }
  }

  const addrClass = ['field', 'addr', addrOk ? 'is-ok' : '', addrErr ? 'is-err' : ''].filter(Boolean).join(' ');

  return (
    <form className={busy ? 'ticket ticket--swap is-busy' : 'ticket ticket--swap'}
      id="orderForm" autoComplete="off" onSubmit={submit}>
      {/* The shadow lives on this wrapper, not on the card: the old notched
          design masked the card, and a CSS mask clips everything its own element
          paints — box-shadow and drop-shadow alike. The notch is gone, but the
          wrapper stays, because a `filter` here would ALSO make it the backdrop
          root and silently kill the hero's backdrop-filter. box-shadow does not. */}
      <div className="ticket__card-shadow">
        <div className="ticket__card">

          <div className="ticket__hero">
            <div className="ticket__legs">
              <div className="leg-col field field--card field--card-top">
                <label className="field__label" htmlFor="makerAmount">You send</label>
                <div className="leg">
                  <input type="text" id="makerAmount" className={amountClass(makerAmount)} inputMode="decimal"
                    placeholder="0" spellCheck={false} style={{ width: chWidth(makerAmount) }}
                    value={makerAmount} disabled={busy}
                    onChange={(e) => setMakerAmount(e.target.value)} />
                  <TokenSelect id="makerToken" label="Token you send" value={makerToken}
                    options={TOKENS} disabled={busy} onChange={setMakerToken} />
                </div>
                <p className={suggestSend != null ? 'readback readback--fair' : rates.live ? 'readback' : 'readback is-idle'} aria-live="polite">
                  {suggestSend != null ? (
                    <button type="button" className="readback__fair" disabled={busy}
                      onClick={() => setMakerAmount(fillStr(suggestSend))}
                      title="Reference price from the Reflector oracle — tap to fill">
                      <span className="readback__fair-tag">Fair</span>
                      <span className="readback__fair-val">≈ {fmtAmt(suggestSend)} {tokenLabel(makerToken)}</span>
                    </button>
                  ) : (
                    <><span>{rates.aLabel}</span> <span className="readback__chip">{rates.aChip}</span></>
                  )}
                </p>
              </div>

              <div className="ticket__swap">
                <span className="swap-seam" aria-hidden="true" />
                <button type="button" className="ticket__swap-btn" disabled={busy}
                  aria-label="Swap the two legs" onClick={swapLegs}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 20V5M8 5l-3.1 3.2M8 5l3.1 3.2" />
                    <path d="M16 4v15M16 19l-3.1-3.2M16 19l3.1-3.2" />
                  </svg>
                </button>
              </div>

              <div className="leg-col field field--card field--card-bottom">
                <label className="field__label" htmlFor="takerAmount">You receive</label>
                <div className="leg">
                  <TokenSelect id="takerToken" label="Token you receive" value={takerToken}
                    options={TOKENS} disabled={busy} onChange={setTakerToken} />
                  <input type="text" id="takerAmount" className={amountClass(takerAmount)} inputMode="decimal"
                    placeholder="0" spellCheck={false} style={{ width: chWidth(takerAmount) }}
                    value={takerAmount} disabled={busy}
                    onChange={(e) => setTakerAmount(e.target.value)} />
                </div>
                <p className={suggestReceive != null ? 'readback readback--fair' : rates.live ? 'readback' : 'readback is-idle'} aria-live="polite">
                  {suggestReceive != null ? (
                    <button type="button" className="readback__fair" disabled={busy}
                      onClick={() => setTakerAmount(fillStr(suggestReceive))}
                      title="Reference price from the Reflector oracle — tap to fill">
                      <span className="readback__fair-tag">Fair</span>
                      <span className="readback__fair-val">≈ {fmtAmt(suggestReceive)} {tokenLabel(takerToken)}</span>
                    </button>
                  ) : (
                    <><span>{rates.bLabel}</span> <span className="readback__chip">{rates.bChip}</span></>
                  )}
                </p>
              </div>
            </div>
            <div className="hero-flow" aria-hidden="true" />
          </div>

          <div className="field--details">
            <div className={addrClass}>
              <div className="addrline">
                <span className="addr__seal" role="img"
                  aria-label="Address seal — a mark derived from this address; a different address draws a different seal">
                  <AddressSeal state={addrOk ? 'ok' : addrErr ? 'err' : 'idle'} address={takerAddress} size={28} />
                </span>
                <div className="addr__field">
                  <div className="addr__print" ref={printRef} aria-hidden="true">
                    <span className="g--head">{takerAddress.slice(0, 4)}</span>
                    <span>{takerAddress.slice(4, Math.max(takerAddress.length - 8, 4))}</span>
                    {takerAddress.length > 12 ? (
                      <span className={tailShown ? 'g--tail' : undefined}>{takerAddress.slice(-8)}</span>
                    ) : null}
                  </div>
                  <textarea id="takerAddress" className="input--addr addr__ta" rows={1}
                    placeholder="Counterparty wallet address" spellCheck={false}
                    autoCapitalize="characters" autoCorrect="off"
                    aria-label="Counterparty wallet address"
                    aria-invalid={addrErr}
                    value={takerAddress} disabled={busy}
                    onChange={(e) => {
                      const raw = normalizeAddress(e.target.value);
                      setTakerAddress(raw);
                      // A complete, valid address is self-evidently "touched" —
                      // show the green state without waiting for a blur.
                      if (checkAddress(raw, address) === 'ok') setTouched(true);
                    }}
                    // read the DOM value, not the render closure: a paste
                    // followed immediately by a blur (or a browser autofill)
                    // blurs before React has re-rendered with the new value,
                    // and a stale `takerAddress` here would leave a bad address
                    // sitting in the field with no error shown.
                    onBlur={(e) => { if (e.currentTarget.value) setTouched(true); }}
                    onScroll={(e) => {
                      if (printRef.current) printRef.current.scrollLeft = e.currentTarget.scrollLeft;
                    }}
                    ref={taRef} />
                </div>
                {!directed ? <span className="addr-optional">(optional)</span> : null}
              </div>

              {/* One line, three jobs: it explains the directed/broadcast fork
                  while empty, confirms the checksum when valid, and names the
                  specific problem when not. */}
              <span className={addrErr ? 'hint is-err' : addrOk ? 'hint is-ok' : 'hint'}>
                {addrErr
                  ? ADDR_MSG[addrCode as Exclude<typeof addrCode, 'ok'>]
                  : addrOk
                    ? <><b>Checksum OK.</b> Compare the highlighted tail with the address your counterparty sent you.</>
                    : sameToken
                      ? 'Leave empty to broadcast — pick two different tokens first.'
                      : `Name a taker and the offer goes to them alone. Leave it empty to broadcast to every taker watching ${pairLabel(pairKey)}.`}
              </span>
            </div>

            <div className="field exp">
              <div className="row2">
                <svg className="exp__clock" width="19" height="19" viewBox="0 0 19 19" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <circle cx="9.5" cy="9.5" r="7.75" />
                  <path d="M9.5 5.5v4.2l2.8 1.7" />
                </svg>
                <label className="field__label" htmlFor="expValue">Expires in</label>
                <input type="number" id="expValue" className="input--num input--exp" min={1} step={1}
                  value={expValue} disabled={busy} onChange={(e) => setExpValue(e.target.value)} />
                <select id="expUnit" className="exp-unit" aria-label="Expiry unit" disabled={busy}
                  value={expUnit} onChange={(e) => setExpUnit(e.target.value)}>
                  <option value="60000">Minutes</option>
                  <option value="3600000">Hours</option>
                  <option value="86400000">Days</option>
                </select>
              </div>
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn--gold" id="sendBtn" disabled={disabled}>
                <span className="btn__label">
                  {busy ? 'Waiting for signature…' : directed ? 'Sign & send order' : 'Sign & broadcast offer'}
                </span>
                <span className="btn__chevs" aria-hidden="true">
                  <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1.5 7h14M15.5 7l-5-5M15.5 7l-5 5" />
                  </svg>
                </span>
                <span className="btn__orb" aria-hidden="true"><span className="spin" /></span>
              </button>
            </div>
          </div>

          <div className="signline">
            <span className="field__label">Signing as (maker)</span>
            <span className="signline__seal" aria-hidden="true">
              {address ? <AddressSeal state="ok" address={address} size={20} /> : null}
            </span>
            <span className="maker-addr" id="makerAddrBox">{address ?? '—'}</span>
          </div>

        </div>
      </div>

      {/* Broadcast mode only: in directed mode "N takers subscribed" would be a
          statistic about the people who will NOT receive this offer. */}
      {!directed ? (
        <div role="status"
          className={sameToken || count === 0 ? 'broadcast-subs broadcast-subs--zero' : 'broadcast-subs'}>
          {sameToken
            ? 'A broadcast needs two different tokens. Pick a different token, or enter a counterparty address to send this as a directed offer.'
            : count === null
              ? 'Checking subscriber count…'
              : count === 0
                ? 'No takers are subscribed to this pair yet — there is no one to send to.'
                : `${count} taker${count === 1 ? '' : 's'} subscribed — each will receive a private offer.`}
        </div>
      ) : (
        <span className="hint hint--canvas">You'll be asked to sign the order in your wallet.</span>
      )}
    </form>
  );
}
