// The desk — the whole app, one page. Topbar (+ balance strip) + wallet gate +
// three sections switched by the SectionSheet capsule in the bar: New order (the one
// compose form, where an optional counterparty address decides directed vs
// broadcast), Incoming (offers to me + the pairs I watch), Sent (my direct
// offers + my broadcasts, grouped).
//
// The shell owns EVERY data subscription (orders, broadcasts, balances) and
// hands pre-filtered props down; no list component subscribes for itself.
//
// It deliberately does NOT call useSettlement. useSettlement's txBusy is a ref,
// i.e. per instance, and ThreadView — the only render site of OrderCard, and so
// the only place settlement can be started — serializes every settle/sign
// through its own module-scope lock. A second instance here would be invisible
// to that lock and could race a ThreadView settle: two wallet prompts, two
// submits, two competing settlement_status writes. Invariant to keep:
//   the useSettlement invariant grep in CLAUDE.md (Gotchas) → exactly 3 lines
//   (the definition, ThreadView's import, ThreadView's one call).

import { useCallback, useState, type ReactNode } from 'react';
import { isExpired, trunc } from './core/tokens';
import type { BalanceMap } from './core/balances';
import type { Order } from './core/types';
import { useBalances } from './data/useBalances';
import { useBroadcasts } from './data/useBroadcasts';
import { useOrders } from './data/useOrders';
import { useWallet, WalletProvider } from './wallet/WalletContext';
import { BalanceStrip } from './ui/BalanceStrip';
import { BroadcastList } from './ui/BroadcastList';
import { Gate } from './ui/Gate';
import { OfferList } from './ui/OfferList';
import { PairsPanel } from './ui/PairsPanel';
import { SectionSheet } from './ui/SectionSheet';
import { Ticket } from './ui/Ticket';
import { errMsg, ToastProvider, useToast } from './ui/Toast';
import { useNow } from './ui/useNow';

type TabName = 'create' | 'incoming' | 'sent';

/** An offer still awaiting somebody's move. 'countered' counts: the desk has counter-offers now. */
const isOpen = (o: Order, now: number) =>
  (o.status === 'pending' || o.status === 'countered') && !isExpired(o, now);

function Topbar({ address, balances, loading, onDisconnect, nav }: {
  address: string | null;
  balances: BalanceMap | null;
  loading: boolean;
  onDisconnect: () => void;
  /** the SectionSheet capsule — lives in the bar, so it reads as part of the layout */
  nav: ReactNode;
}) {
  return (
    <header className="topbar">
      <a className="brand" href="hero.html">
        <svg width="24" height="24" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M20 21 C26 13.5, 38 13.5, 44 21" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          <path d="M44 43 C38 50.5, 26 50.5, 20 43" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          <circle cx="15" cy="32" r="8" fill="currentColor" />
          <circle cx="49" cy="32" r="8" stroke="currentColor" strokeWidth="4" />
        </svg>
        TrustRFQ
      </a>
      <span className="net-pill">Testnet</span>
      {/* balances sit with the network label, not with the wallet: both say
          WHERE you are trading, and they line up on the bar's left run */}
      {address ? <BalanceStrip balances={balances} loading={loading} /> : null}
      <div className="topbar__right">
        {/* the nav capsule renders here but is position:fixed (styles.css), so it
            floats top-centre and takes no room in this row; the wallet (address +
            Disconnect) is the only thing left, out at the bar's top-right corner */}
        {nav}
        <div className="wallet-chip" id="walletChip">
          {address ? (
            <>
              <span className="wallet-chip__addr"><span className="wallet-chip__dot" />{trunc(address)}</span>
              <button className="btn btn--ghost btn--sm" id="disconnectBtn" onClick={onDisconnect}>Disconnect</button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function Desk() {
  const { address, connect, disconnect } = useWallet();
  const toast = useToast();
  const onError = useCallback((m: string) => toast(m, 'err'), [toast]);

  const { incoming, sent, refresh } = useOrders(address, onError);
  const { broadcasts, refresh: refreshBroadcasts } = useBroadcasts(address, onError);
  // ONE balances instance feeds the topbar strip, the Ticket's send gate, and
  // every CounterForm.
  const { balances, loading, refresh: refreshBalances } = useBalances(address);
  const [tab, setTab] = useState<TabName>('create');
  const now = useNow(60000);

  // A broadcast is ONE offer with N threads, so Sent shows the group, not the
  // threads — and the direct orders are the ones without a broadcast_id.
  const directedSent = sent.filter((o) => !o.broadcast_id);
  const broadcastSent = sent.filter((o) => o.broadcast_id);

  // The badges mean "open", not "your move". Knowing whose move it is needs
  // currentTerms(order, rounds), and the shell does not subscribe to rounds —
  // only an expanded ThreadView does. Subscribing for every order would mean N
  // realtime channels. The intent page shipped with the same over-count.
  const incomingCount = incoming.filter((o) => isOpen(o, now)).length;
  const sentCount = directedSent.filter((o) => isOpen(o, now)).length
    + broadcasts.filter((b) => b.status === 'active' && !isExpired(b, now)).length;

  const handleConnect = async () => {
    try {
      await connect();
    } catch (e) {
      toast(errMsg(e, 'Wallet connection cancelled.'), 'err');
    }
  };

  // Any thread/broadcast change → refetch both sides. This is also the `refresh`
  // every ThreadView hands to useSettlement.
  const onChanged = useCallback(async () => {
    await Promise.all([refresh(), refreshBroadcasts()]);
  }, [refresh, refreshBroadcasts]);

  const onSent = useCallback(async () => {
    await Promise.all([refresh(), refreshBroadcasts()]);
    setTab('sent');
  }, [refresh, refreshBroadcasts]);

  return (
    <>
      <div className="backdrop starfield" aria-hidden="true" />
      <Topbar address={address} balances={balances} loading={loading}
        onDisconnect={disconnect}
        nav={address ? (
          <SectionSheet
            active={tab}
            onSelect={setTab}
            options={[
              { id: 'create', label: 'New offer', glyph: '+' },
              { id: 'incoming', label: 'Incoming', glyph: '↓', count: incomingCount },
              { id: 'sent', label: 'Sent', glyph: '↑', count: sentCount },
            ] as const}
          />
        ) : null} />
      {/* Gate and desk are both mounted, visibility-toggled — so a half-typed
          ticket draft, the active section, and BroadcastList's banner dismissals
          all survive disconnect/reconnect and section switches. The SectionSheet
          is the one exception: it UNMOUNTS on disconnect, because display:none
          would hide its pixels but leak its open-state side effects (body scroll
          lock + document keydown listener). Unmounting runs the effect cleanup;
          its only state is open/closed, so nothing worth keeping is lost. */}
      <main className="wrap">
        <Gate onConnect={() => void handleConnect()} hidden={!!address} />
        <section id="app" style={address ? undefined : { display: 'none' }}>
          {/* NOT gated on address: Ticket takes `string | null` on purpose, so a
              draft survives a disconnect. The two list panels ARE gated — their
              components require a non-null address. */}
          <div className={tab === 'create' ? 'panel is-active' : 'panel'} data-panel="create">
            <Ticket address={address} refreshBalances={refreshBalances} onSent={onSent} />
          </div>

          <div className={tab === 'incoming' ? 'panel is-active' : 'panel'} data-panel="incoming">
            {address ? (
              <>
                {/* the pairs capsule leads the panel (top-left) and carries the
                    explainer as hero type to its right; the offers stack under it. */}
                <PairsPanel address={address} />
                {/* every incoming order — directed AND broadcast fan-out rows.
                    They used to appear on two different pages as two different
                    cards; now each is one thread, once. */}
                <OfferList address={address} orders={incoming} side="taker" now={now}
                  balances={balances} refreshBalances={refreshBalances} onChanged={onChanged}
                  emptyText="No offers addressed to your wallet yet. Toggle a pair above to also receive broadcast offers." />
              </>
            ) : null}
          </div>

          <div className={tab === 'sent' ? 'panel is-active' : 'panel'} data-panel="sent">
            {address ? (
              directedSent.length === 0 && broadcasts.length === 0 ? (
                <div className="empty">You haven't sent any offers yet.</div>
              ) : (
                <>
                  <div className="list-head">Direct offers</div>
                  <OfferList address={address} orders={directedSent} side="maker" now={now}
                    balances={balances} refreshBalances={refreshBalances} onChanged={onChanged}
                    emptyText="You haven't sent any direct offers yet." />
                  <div className="list-head">Broadcasts</div>
                  <BroadcastList address={address} broadcasts={broadcasts} orders={broadcastSent}
                    now={now} balances={balances} refreshBalances={refreshBalances}
                    onChanged={onChanged} />
                </>
              )
            ) : null}
          </div>
        </section>
      </main>
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <WalletProvider>
        <Desk />
      </WalletProvider>
    </ToastProvider>
  );
}
