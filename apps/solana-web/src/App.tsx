import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { SolanaApiClient, type AssetView } from '../../../packages/solana-sdk/src/index';
import { atomicToDecimal, decimalToAtomic, SOLANA_USDC_MINT, SOLANA_USDT_MINT } from '../../../packages/solana-core/src/index';
import type { QuoteSession, TradeReceipt } from '../../../packages/solana-core/src/index';

const DEMO_WALLET = 'demo-wallet';
const client = new SolanaApiClient({ baseUrl: '' });

const fallbackAssets: readonly AssetView[] = [
  {
    mint: 'xstk-demo-AAPL-mint', issuer: 'xstocks', ticker: 'AAPLx', underlyingTicker: 'AAPL', tokenProgram: 'token-2022', decimals: 6,
    extensionFingerprint: 'metadata-pointer|active|scaled|none|none|no-memo', capabilities: { transferHook: false, pausable: true, scaledUiAmount: true, transferFee: false, permanentDelegate: false, memoTransfer: false, confidentialTransfer: false }, supportedOutputs: [SOLANA_USDC_MINT, SOLANA_USDT_MINT], referenceState: 'open', referencePriceAtomic: '100000000', referencePriceDecimals: 6, referenceTimestampMs: Date.now(), maxDeviationBps: 150, enabled: true, registryVersion: 1, balanceAtomic: '2500000', eligibility: { status: 'eligible', message: 'Ready for a checked quote', checkedAtMs: Date.now() },
  },
  {
    mint: 'ondo-demo-MSFT-mint', issuer: 'ondo', ticker: 'MSFTon', underlyingTicker: 'MSFT', tokenProgram: 'token-2022', decimals: 6,
    extensionFingerprint: 'metadata-pointer|pausable|transfer-hook|active|unscaled|none|none|no-memo', expectedHookProgram: 'ondo-jit-hook-demo', capabilities: { transferHook: true, pausable: true, scaledUiAmount: false, transferFee: false, permanentDelegate: false, memoTransfer: false, confidentialTransfer: false }, supportedOutputs: [SOLANA_USDC_MINT, SOLANA_USDT_MINT], referenceState: 'open', referencePriceAtomic: '100000000', referencePriceDecimals: 6, referenceTimestampMs: Date.now(), maxDeviationBps: 150, enabled: true, registryVersion: 1, balanceAtomic: '2500000', eligibility: { status: 'eligible', message: 'Ready for a checked quote', checkedAtMs: Date.now() },
  },
];

type TicketState = 'idle' | 'collecting' | 'ready' | 'reviewing' | 'submitting' | 'success' | 'no_quote' | 'expired' | 'error' | 'offline';

function formatAmount(atomic: string | undefined, decimals: number): string { return atomic === undefined ? '—' : atomicToDecimal(atomic, decimals); }
function formatBps(value: number | undefined): string { return value === undefined ? '—' : `${value > 0 ? '+' : ''}${value} bps`; }
function formatTimestamp(value: number | undefined): string { return value === undefined ? '—' : new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function stableSymbol(mint: string): string { return mint === SOLANA_USDT_MINT ? 'USDT' : 'USDC'; }

function MockModeBanner(): ReactElement {
  return <div className="mock-banner" role="status"><strong>LOCAL MOCK MODE</strong><span>Wallet, RPC, quotes, settlement, and receipts are simulated. No Solana transaction is submitted.</span></div>;
}

export function App(): ReactElement {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/trade';
  const isActivity = path === '/activity';
  const operationsRole: OperationsRole | undefined = path === '/maker' ? 'maker' : path === '/operator' ? 'operator' : undefined;
  const [wallet, setWallet] = useState<string | undefined>();
  const [walletState, setWalletState] = useState<'disconnected' | 'connecting' | 'connected' | 'rejected' | 'locked'>('disconnected');
  const [outputMint, setOutputMint] = useState(SOLANA_USDC_MINT);
  const [assets, setAssets] = useState<readonly AssetView[]>(fallbackAssets);
  const [assetMint, setAssetMint] = useState(fallbackAssets[0].mint);
  const [amount, setAmount] = useState('');
  const [ticketState, setTicketState] = useState<TicketState>('idle');
  const [session, setSession] = useState<QuoteSession>();
  const [trade, setTrade] = useState<TradeReceipt>();
  const [error, setError] = useState<string>();
  const [auditOpen, setAuditOpen] = useState(false);
  const [activity, setActivity] = useState<readonly TradeReceipt[]>([]);

  const asset = useMemo(() => assets.find((entry) => entry.mint === assetMint) ?? assets[0], [assetMint, assets]);
  const outputDecimals = 6;
  const inputsLocked = ['collecting', 'ready', 'reviewing', 'submitting', 'success'].includes(ticketState);

  const loadAssets = useCallback(async (address: string) => {
    try {
      const next = await client.listAssets(address, outputMint);
      if (next.length > 0) { setAssets(next); setAssetMint((current) => next.some((entry) => entry.mint === current) ? current : next[0].mint); }
      setTicketState((current) => current === 'offline' ? 'idle' : current);
    } catch {
      setTicketState('offline');
    }
  }, [outputMint]);

  useEffect(() => { if (wallet) void loadAssets(wallet); }, [wallet, loadAssets]);
  useEffect(() => { if (wallet) void client.listTrades(wallet).then(setActivity).catch(() => undefined); }, [wallet, trade]);

  const connect = async (): Promise<void> => {
    setWalletState('connecting');
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    setWallet(DEMO_WALLET);
    setWalletState('connected');
  };

  const pollSession = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 36; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      try {
        const next = await client.getQuoteSession(id);
        setSession(next);
        if (next.state === 'ready') { setTicketState('ready'); return; }
        if (next.state === 'no_quote') { setTicketState('no_quote'); return; }
        if (next.state === 'expired') { setTicketState('expired'); return; }
      } catch (pollError) { setError(pollError instanceof Error ? pollError.message : 'Quote session unavailable'); setTicketState('error'); return; }
    }
    setError('Quote sprint timed out. Request a fresh price.');
    setTicketState('no_quote');
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    setTrade(undefined);
    if (!wallet) { setError('Connect a Wallet Standard wallet before requesting a quote.'); return; }
    try {
      const inputAmountAtomic = decimalToAtomic(amount, asset.decimals, 'stock amount').toString();
      if (inputAmountAtomic === '0') throw new Error('Enter an amount greater than zero.');
      setTicketState('collecting');
      const next = await client.createQuoteSession({ wallet, inputMint: asset.mint, outputMint, inputAmountAtomic });
      setSession(next);
      if (next.state !== 'collecting') { setTicketState(next.state === 'no_quote' ? 'no_quote' : 'error'); setError(next.eligibility.message); return; }
      await pollSession(next.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not start quote sprint');
      setTicketState('error');
    }
  };

  const review = async (): Promise<void> => {
    if (!wallet || !session?.winner) return;
    setTicketState('reviewing');
    setError(undefined);
    try {
      const reviewed = await client.reviewQuoteSession(session.id, wallet);
      setSession(reviewed);
      setTicketState(reviewed.state === 'reviewing' ? 'reviewing' : 'error');
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Final simulation failed');
      setTicketState('error');
    }
  };

  const signAndExecute = async (): Promise<void> => {
    if (!wallet || !session?.winner?.transactionBase64) return;
    setTicketState('submitting');
    setError(undefined);
    try {
      // The demo adapter returns the exact v0 bytes issued by the API. A real
      // Wallet Standard adapter signs these bytes and never mutates them.
      // The production Wallet Standard adapter signs these exact bytes. The
      // local demo wallet is intentionally an identity signer so the API can
      // still exercise its issued-payload hash binding without a keypair.
      const signedTransactionBase64 = session.winner.transactionBase64;
      const receipt = await client.execute(session.id, wallet, signedTransactionBase64);
      setTrade(receipt);
      setTicketState('success');
    } catch (executeError) {
      setError(executeError instanceof Error ? executeError.message : 'Transaction rejected');
      setTicketState('error');
    }
  };

  if (isActivity) return <ActivityPage wallet={wallet} walletState={walletState} activity={activity} onConnect={() => void connect()} />;
  if (operationsRole) return <OperationsPage role={operationsRole} wallet={wallet} walletState={walletState} onConnect={() => void connect()} />;

  return <div className="shell">
      <header className="topbar">
      <a className="wordmark" href="/trade" aria-label="Katon home">KATON <span>/ SOLANA</span></a>
      <nav aria-label="Primary navigation"><a className={!isActivity && !operationsRole ? 'active' : undefined} href="/trade">Trade</a><a className={isActivity ? 'active' : undefined} href="/activity">Activity</a><a className="ops-link" href="/maker">Maker</a><a className="ops-link" href="/operator">Ops</a></nav>
      <button className="wallet-button" type="button" onClick={() => void connect()} disabled={walletState === 'connecting'}>{walletState === 'connected' ? 'demo-wallet' : walletState === 'connecting' ? 'Connecting…' : 'Connect wallet'}</button>
    </header>
    <MockModeBanner />

    <main className="main-grid">
      <section className="ticket-column" aria-labelledby="page-title">
        <div className="eyebrow">PRIVATE EXIT DESK <span className="live-dot" aria-hidden="true" /> LOCAL MOCK</div>
        <h1 id="page-title">Sell tokenized stock.<br /><em>Keep control.</em></h1>
        <p className="lede">A checked, exact-input quote sprint across vetted private makers and Jupiter. This local mock exercises the review flow without submitting a transaction.</p>

        <form className="trade-ticket" onSubmit={(event) => void submit(event)}>
          <div className="ticket-header"><div><span className="label">SELL</span><strong>Verified stock</strong></div><span className="session-pill">{walletState === 'connected' ? 'Wallet ready' : 'Connect to begin'}</span></div>
          <label className="field-label" htmlFor="asset">Asset</label>
          <select id="asset" className="select-input" value={assetMint} onChange={(event) => setAssetMint(event.target.value)} disabled={inputsLocked}>
            {assets.map((entry) => <option value={entry.mint} key={entry.mint}>{entry.ticker} · {entry.issuer === 'xstocks' ? 'xStocks' : 'Ondo'} · {entry.underlyingTicker}</option>)}
          </select>
          <div className="asset-meta"><span className={`issuer-badge issuer-${asset.issuer}`}>{asset.issuer === 'xstocks' ? 'xStocks' : 'Ondo Global Markets'}</span><span>{asset.tokenProgram === 'token-2022' ? 'Token-2022' : 'SPL Token'} · {asset.decimals} decimals</span><span>Balance {formatAmount(asset.balanceAtomic, asset.decimals)}</span></div>

          <div className="amount-label-row"><label className="field-label" htmlFor="amount">Amount</label><button type="button" className="max-button" onClick={() => setAmount(formatAmount(asset.balanceAtomic, asset.decimals))} disabled={inputsLocked}>Use full balance</button></div>
          <div className="amount-wrap"><input id="amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="0.000000" disabled={inputsLocked} required /><span>{asset.ticker}</span></div>

          <fieldset className="output-fieldset"><legend className="field-label">Receive</legend><div className="output-options">{[[SOLANA_USDC_MINT, 'USDC'], [SOLANA_USDT_MINT, 'USDT']].map(([mint, symbol]) => <label className={`output-option ${outputMint === mint ? 'selected' : ''}`} key={mint}><input type="radio" name="output" value={mint} checked={outputMint === mint} onChange={() => setOutputMint(mint)} disabled={inputsLocked} /><span>{symbol}</span><small>native Solana</small></label>)}</div></fieldset>
          <button className="primary-button" type="submit" disabled={inputsLocked || !asset || asset.eligibility.status !== 'eligible'}>{ticketState === 'collecting' ? <><span className="spinner" aria-hidden="true" /> Finding executable prices</> : 'Find best executable price'}<span aria-hidden="true">↗</span></button>
          <p className="ticket-footnote"><span aria-hidden="true">♢</span> Exact input · full fill · no custody · max quote life 30 seconds</p>
        </form>

        <StatusPanel state={ticketState} error={error} session={session} onReview={() => void review()} onRefresh={() => { setTicketState('idle'); setSession(undefined); setError(undefined); }} />
      </section>

      <aside className="context-column" aria-label="Execution context">
        <div className="context-card reference-card"><div className="card-kicker">MARKET CONTEXT</div><div className="context-row"><span>Reference price</span><strong>{asset.referencePriceAtomic ? `${formatAmount(asset.referencePriceAtomic, asset.referencePriceDecimals ?? asset.decimals)} USDC` : '—'}</strong></div><div className="context-row"><span>Reference timestamp</span><strong>{formatTimestamp(asset.referenceTimestampMs)}</strong></div><div className="context-row"><span>Session</span><strong className="status-open"><span className="live-dot" /> {asset.referenceState === 'open' ? 'Open' : asset.referenceState}</strong></div><div className="reference-note">Issuer-specific policy and Token-2022 preflight run before any maker sees your request.</div></div>
        <div className="context-card"><div className="card-kicker">BEST EXECUTION</div><div className="source-line"><span className="source-mark jupiter-mark">J</span><span><strong>Jupiter</strong><small>Meta-Aggregator</small></span><span className="source-state">Raced</span></div><div className="source-line"><span className="source-mark maker-mark">K</span><span><strong>Private makers</strong><small>Authenticated streams</small></span><span className="source-state">Raced</span></div><div className="context-divider" /><p className="context-note">One recommendation. Losing sources appear only as anonymized audit rows after the sprint.</p></div>
        <div className="context-card safety-card"><div className="card-kicker">MOCK SETTLEMENT</div><div className="safety-item"><span>01</span><p><strong>Exact bytes</strong>The mock preserves the issued v0 payload.</p></div><div className="safety-item"><span>02</span><p><strong>Atomic simulation</strong>Both legs are reported together in the mock.</p></div><div className="safety-item"><span>03</span><p><strong>Receipted</strong>Every simulated fill gets a replay-resistant receipt.</p></div><p className="context-note">{activity.length} simulated {activity.length === 1 ? 'exit' : 'exits'} in this wallet</p></div>
      </aside>
    </main>

    {session?.winner && (ticketState === 'ready' || ticketState === 'reviewing') ? <ReviewPanel session={session} outputDecimals={outputDecimals} onOpenAudit={() => setAuditOpen(true)} onSign={() => void signAndExecute()} onClose={() => setTicketState('ready')} /> : null}
    {auditOpen && session ? <AuditDrawer session={session} onClose={() => setAuditOpen(false)} outputDecimals={outputDecimals} /> : null}
    {trade ? <ReceiptPanel trade={trade} outputDecimals={outputDecimals} onClose={() => setTrade(undefined)} /> : null}
  </div>;
}

function StatusPanel({ state, error, session, onReview, onRefresh }: { readonly state: TicketState; readonly error?: string; readonly session?: QuoteSession; readonly onReview: () => void; readonly onRefresh: () => void }): ReactElement | null {
  if (state === 'idle') return null;
  if (state === 'collecting') return <div className="status-panel collecting-panel" role="status"><div className="status-icon ring-icon"><span className="spinner" /></div><div><strong>Quote sprint in progress</strong><p>Checking Jupiter and healthy private makers for up to three seconds. No placeholder prices are shown.</p></div></div>;
  if (state === 'ready' && session?.winner) return <div className="status-panel ready-panel"><div className="status-icon check-icon">✓</div><div className="ready-copy"><div className="ready-label">RECOMMENDED ROUTE · {session.winner.sourceKind === 'jupiter' ? 'JUPITER' : 'PRIVATE MAKER'}</div><strong>{formatAmount(session.winner.netOutputAtomic, 6)} {stableSymbol(session.winner.outputMint)}</strong><p>Effective {session.winner.effectivePriceAtomic ? `${formatAmount(session.winner.effectivePriceAtomic, session.winner.effectivePriceDecimals ?? 6)} ${stableSymbol(session.winner.outputMint)} / stock` : '—'} · Impact {formatBps(session.winner.priceImpactBps)}</p><p>Expires {formatTimestamp(session.winner.expiresAtMs)} · {formatBps(session.winner.deviationBps)} to reference</p><button className="secondary-button" type="button" onClick={onReview}>Review and sign <span>↗</span></button></div></div>;
  if (state === 'no_quote') return <div className="status-panel warning-panel"><div className="status-icon">!</div><div><strong>No executable quote</strong><p>{session?.eligibility.message ?? 'All sources rejected this size or state. Check eligibility, session hours, balance, or try a smaller supported size.'}</p><button className="text-button" type="button" onClick={onRefresh}>Start a fresh sprint</button></div></div>;
  if (state === 'expired') return <div className="status-panel warning-panel"><div className="status-icon">↻</div><div><strong>Quote expired</strong><p>The action was invalidated with two seconds or less remaining. Request a fresh executable price.</p><button className="text-button" type="button" onClick={onRefresh}>Find a fresh price</button></div></div>;
  if (state === 'submitting' || state === 'success') return <div className="status-panel collecting-panel" role="status"><div className="status-icon ring-icon"><span className="spinner" /></div><div><strong>{state === 'submitting' ? 'Running mock settlement' : 'Simulation complete'}</strong><p>The issued v0 payload was processed locally; no Solana transaction was submitted.</p></div></div>;
  return <div className="status-panel error-panel" role="alert"><div className="status-icon">×</div><div><strong>{state === 'offline' ? 'Desk unavailable' : 'Could not complete request'}</strong><p>{error ?? 'Try again after checking your wallet and network.'}</p><button className="text-button" type="button" onClick={onRefresh}>Try again</button></div></div>;
}

function ActivityPage({ wallet, walletState, activity, onConnect }: { readonly wallet?: string; readonly walletState: string; readonly activity: readonly TradeReceipt[]; readonly onConnect: () => void }): ReactElement {
  return <div className="shell">
    <header className="topbar">
      <a className="wordmark" href="/trade" aria-label="Katon home">KATON <span>/ SOLANA</span></a>
      <nav aria-label="Primary navigation"><a href="/trade">Trade</a><a className="active" href="/activity">Activity</a><a className="ops-link" href="/maker">Maker</a><a className="ops-link" href="/operator">Ops</a></nav>
      {wallet ? <span className="wallet-chip">{wallet}</span> : <button className="wallet-button" type="button" onClick={onConnect}>{walletState === 'connecting' ? 'Connecting…' : 'Connect wallet'}</button>}
    </header>
    <MockModeBanner />
    <main className="activity-main" aria-labelledby="activity-title">
      <div className="eyebrow">SIMULATED ACTIVITY <span className="live-dot" aria-hidden="true" /> LOCAL WALLET</div>
      <h1 id="activity-title">Your exits.</h1>
      <p className="lede">Simulated receipts are scoped to the local demo wallet. Raw transaction payloads are never shown here.</p>
      {!wallet ? <div className="empty-state"><strong>Connect the demo wallet to view activity</strong><p>Activity is scoped to the connected mock Wallet Standard account.</p><button className="primary-button" type="button" onClick={onConnect}>Connect wallet <span>↗</span></button></div> : activity.length === 0 ? <div className="empty-state"><strong>No simulated exits yet</strong><p>Mock receipts appear here; no explorer transaction is submitted.</p><a className="secondary-button" href="/trade">Start a trade <span>↗</span></a></div> : <div className="activity-table" role="table"><div className="activity-row activity-header" role="row"><span>Date</span><span>Route</span><span>Sold</span><span>Received</span><span>Status</span></div>{activity.map((trade) => <details className="activity-detail" key={trade.tradeId}><summary className="activity-row" role="row"><span>{formatTimestamp(trade.finalizedAtMs ?? trade.confirmedAtMs)}</span><span>{trade.sourceKind === 'jupiter' ? 'Jupiter' : 'Private maker'}</span><span>{formatAmount(trade.inputAmountAtomic, 6)} stock</span><span>{formatAmount(trade.netOutputAtomic, 6)} {trade.outputMint === SOLANA_USDT_MINT ? 'USDT' : 'USDC'}</span><span className="audit-good">Simulated</span></summary><div className="activity-expanded"><div><span>Trade ID</span><strong>{trade.tradeId}</strong></div><div><span>Quote ID</span><strong>{trade.quoteId}</strong></div><div><span>Signature</span><strong className="signature">{trade.signature}</strong></div><span className="mock-signature-note">Mock signature · no explorer transaction</span></div></details>)}</div>}
    </main>
  </div>;
}

type OperationsRole = 'maker' | 'operator';

function OperationsPage({ role, wallet, walletState, onConnect }: { readonly role: OperationsRole; readonly wallet?: string; readonly walletState: string; readonly onConnect: () => void }): ReactElement {
  const maker = role === 'maker';
  return <div className="shell">
    <header className="topbar">
      <a className="wordmark" href="/trade" aria-label="Katon home">KATON <span>/ SOLANA</span></a>
      <nav aria-label="Primary navigation"><a href="/trade">Trade</a><a href="/activity">Activity</a><a className={maker ? 'active ops-link' : 'ops-link'} href="/maker">Maker</a><a className={!maker ? 'active ops-link' : 'ops-link'} href="/operator">Ops</a></nav>
      {wallet ? <span className="wallet-chip">{wallet}</span> : <button className="wallet-button" type="button" onClick={onConnect}>{walletState === 'connecting' ? 'Connecting…' : 'Connect wallet'}</button>}
    </header>
    <MockModeBanner />
    <main className="operations-main" aria-labelledby="operations-title">
      <div className="eyebrow">{maker ? 'MAKER GATEWAY' : 'OPERATOR CONSOLE'} <span className="live-dot" aria-hidden="true" /> ACCESS CONTROLLED</div>
      <h1 id="operations-title">{maker ? <>Quote with<br /><em>discipline.</em></> : <>Keep the desk<br /><em>safe.</em></>}</h1>
      <p className="lede">{maker ? 'Authenticated streaming is the integration surface. This dashboard never becomes a public bid board or a manual spread-entry form.' : 'Policy, source health, program manifests, and solver controls stay behind an operator role. No browser action can bypass the release gates.'}</p>
      <div className="gated-banner" role="status"><div className="status-icon">{wallet ? '✓' : '◎'}</div><div><strong>{wallet ? 'Identity connected; role still required' : 'Invite required'}</strong><p>{wallet ? 'A connected wallet does not grant maker or operator authority. Request a role-scoped session from the desk administrator.' : 'Connect a Wallet Standard account to identify yourself, then request a role-scoped session from the desk administrator.'}</p></div>{wallet ? null : <button className="secondary-button" type="button" onClick={onConnect}>Connect wallet <span>↗</span></button>}</div>
      <section className="operations-grid">
        {maker ? <>
          <OperationsCard kicker="ACCESS" title="Credentials" value="Role-scoped stream key" detail="Rotated credentials, IP allowlist, and signed maker identity are required before quotes are accepted." status="Gated" />
          <OperationsCard kicker="INVENTORY" title="Supported assets" value="xStocks · Ondo" detail="Only registry-enabled mints appear in the stream. Token-2022 extension fingerprints are checked per quote." status="Policy-bound" />
          <OperationsCard kicker="LIQUIDITY" title="Stable balances" value="USDC · USDT" detail="Balances and spendable rent are checked before a maker can advertise a full-fill quote." status="Read-only" />
          <OperationsCard kicker="RELIABILITY" title="Heartbeat & SLA" value="Awaiting authenticated stream" detail="The desk records heartbeat, quote latency, fill latency, expiry, and rejection reasons for source ranking." status="Offline" />
          <OperationsCard kicker="QUALITY" title="Rejects" value="No live rejects" detail="Structured rejects never expose private inventory or losing payloads to sellers." status="Private" />
          <OperationsCard kicker="SANDBOX" title="RFQ simulator" value="Ready after invite" detail="Replay exact-input requests against deterministic fixtures before production credentials are issued." status="Gated" />
        </> : <>
          <OperationsCard kicker="POLICY" title="Asset registry" value="2 issuer adapters" detail="xStocks and Ondo policies, mints, Token-2022 capabilities, references, and pause state." status="Signed manifest" />
          <OperationsCard kicker="SOURCES" title="Source health" value="Jupiter + private makers" detail="Rolling reliability, quote failures, expiry, and sanitized audit comparisons." status="Monitoring" />
          <OperationsCard kicker="PROGRAMS" title="Program / IDL hashes" value="Kamino · Jupiter Lend" detail="Runtime discovery must match the signed deployment manifest or the solver halts." status="Halt on drift" />
          <OperationsCard kicker="SOLVER" title="Shadow results" value="No submission" detail="Liquidations remain dormant until seven shadow days and representative fork evidence pass." status="Shadow mode" />
          <OperationsCard kicker="CANARY" title="Limits" value="1,000 USDC / tx" detail="Daily volume starts at 5,000 USDC; prefunded USDC never exceeds 2,000 USDC." status="Human approval" />
          <OperationsCard kicker="EMERGENCY" title="Pause guardian" value="Pause-only authority" detail="Three landing failures, residual stock, adverse output, stale state, or manifest drift halt execution." status="Ready" />
        </>}
      </section>
    </main>
  </div>;
}

function OperationsCard({ kicker, title, value, detail, status }: { readonly kicker: string; readonly title: string; readonly value: string; readonly detail: string; readonly status: string }): ReactElement {
  return <article className="operations-card"><div className="card-kicker">{kicker}</div><div className="operations-card-head"><h2>{title}</h2><span className="operations-status">{status}</span></div><strong className="operations-value">{value}</strong><p>{detail}</p></article>;
}

function ReviewPanel({ session, outputDecimals, onOpenAudit, onSign, onClose }: { readonly session: QuoteSession; readonly outputDecimals: number; readonly onOpenAudit: () => void; readonly onSign: () => void; readonly onClose: () => void }): ReactElement {
  const winner = session.winner!;
  return <div className="modal-scrim"><section className="review-panel" role="dialog" aria-modal="true" aria-labelledby="review-title"><div className="review-head"><div><div className="card-kicker">MOCK FINAL REVIEW</div><h2 id="review-title">Confirm your exit</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="Close review">×</button></div><div className="review-amounts"><div><span>You sell</span><strong>{formatAmount(winner.inputAmountAtomic, 6)} stock</strong><small>{winner.inputMint}</small></div><div className="arrow">→</div><div><span>You receive</span><strong>{formatAmount(winner.netOutputAtomic, outputDecimals)} {stableSymbol(winner.outputMint)}</strong><small>minimum receive protected</small></div></div><div className="review-grid"><div><span>Counterparty / venue</span><strong>{winner.sourceKind === 'jupiter' ? 'Jupiter Meta-Aggregator' : 'Allowlisted private maker'}</strong></div><div><span>Settlement program</span><strong>solana-rfq · v0 mock</strong></div><div><span>Effective price</span><strong>{winner.effectivePriceAtomic ? `${formatAmount(winner.effectivePriceAtomic, winner.effectivePriceDecimals ?? outputDecimals)} ${stableSymbol(winner.outputMint)} / stock` : '—'}</strong></div><div><span>Price impact</span><strong>{formatBps(winner.priceImpactBps)}</strong></div><div><span>Katon fee</span><strong>{winner.katonFeeAtomic === '0' ? '0' : `${formatAmount(winner.katonFeeAtomic, outputDecimals)} ${stableSymbol(winner.outputMint)} · 10 bps`}</strong></div><div><span>Venue fee</span><strong>{formatAmount(winner.venueFeeAtomic, outputDecimals)} {stableSymbol(winner.outputMint)}</strong></div><div><span>Fee payer / network</span><strong>Mock seller wallet · no network fee</strong></div><div><span>Simulation</span><strong className="simulation-ok">✓ Passed · {winner.simulation.unitsConsumed?.toLocaleString()} CU</strong></div></div><div className="expiry-bar"><span>Expires {formatTimestamp(winner.expiresAtMs)}</span><span>Exact mock payload · no network submission</span></div><div className="review-actions"><button type="button" className="text-button" onClick={onOpenAudit}>View audit comparison</button><button type="button" className="primary-button" onClick={onSign}>Run mock settlement <span>↗</span></button></div></section></div>;
}

function AuditDrawer({ session, onClose, outputDecimals }: { readonly session: QuoteSession; readonly onClose: () => void; readonly outputDecimals: number }): ReactElement {
  return <div className="modal-scrim"><section className="audit-drawer" role="dialog" aria-modal="true" aria-labelledby="audit-title"><div className="review-head"><div><div className="card-kicker">EXECUTION AUDIT</div><h2 id="audit-title">Source comparison</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="Close audit">×</button></div><p className="drawer-intro">Losing payloads and inventory stay private. This comparison records only source class, net amount, timestamp, and structured outcome.</p><div className="audit-table" role="table"><div className="audit-row audit-header" role="row"><span>Source class</span><span>Net received</span><span>At</span><span>Outcome</span></div>{session.audit.map((row, index) => <div className="audit-row" role="row" key={`${row.sourceClass}-${index}`}><span>{row.sourceClass === 'jupiter' ? 'Jupiter' : 'Private maker'}</span><span>{row.netOutputAtomic ? `${formatAmount(row.netOutputAtomic, outputDecimals)} ${session.request.outputMint === SOLANA_USDT_MINT ? 'USDT' : 'USDC'}` : '—'}</span><span>{formatTimestamp(row.receivedAtMs)}</span><span className={row.status === 'executable' ? 'audit-good' : 'audit-bad'}>{row.status === 'executable' ? 'Executable' : row.rejectionCode?.replaceAll('_', ' ')}</span></div>)}</div><button type="button" className="secondary-button full-button" onClick={onClose}>Back to review</button></section></div>;
}

function ReceiptPanel({ trade, outputDecimals, onClose }: { readonly trade: TradeReceipt; readonly outputDecimals: number; readonly onClose: () => void }): ReactElement {
  return <div className="modal-scrim"><section className="receipt-panel" role="dialog" aria-modal="true" aria-labelledby="receipt-title"><div className="receipt-mark">✓</div><div className="card-kicker">SIMULATED RECEIPT</div><h2 id="receipt-title">Exit simulated</h2><p className="receipt-lede">The local mock reports both legs together; no Solana transaction was submitted.</p><div className="receipt-grid"><div><span>Net received</span><strong>{formatAmount(trade.netOutputAtomic, outputDecimals)} {stableSymbol(trade.outputMint)}</strong></div><div><span>Effective price</span><strong>{trade.effectivePriceAtomic ? `${formatAmount(trade.effectivePriceAtomic, trade.effectivePriceDecimals ?? outputDecimals)} ${stableSymbol(trade.outputMint)} / stock` : '—'}</strong></div><div><span>Price impact</span><strong>{formatBps(trade.priceImpactBps)}</strong></div><div><span>Route</span><strong>{trade.sourceKind === 'jupiter' ? 'Jupiter' : 'Private maker'}</strong></div><div><span>Trade ID</span><strong>{trade.tradeId}</strong></div><div><span>Mock signature</span><strong className="signature">{trade.signature}</strong></div></div><span className="mock-signature-note">Mock signature · no explorer transaction</span><button className="secondary-button full-button" type="button" onClick={onClose}>Done</button></section></div>;
}
