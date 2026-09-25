import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import { useClient } from '@solana/react';
import { useConnect, useConnectedWallet, useSignMessage, useWalletStatus, useWallets } from '@solana/kit-plugin-wallet/react';
import { SolanaApiClient, type AssetView, type QuoteSprint } from '../../../packages/solana-sdk/src/index';
import { atomicToDecimal, decimalToAtomic } from '../../../packages/solana-core/src/amounts';
import { SOLANA_USDC_MINT, SOLANA_USDT_MINT } from '../../../packages/solana-core/src/registry';
import type { TradeReceipt } from '../../../packages/solana-core/src/types';
import {
  EXPECTED_CHAIN,
  explorerTxUrl,
  inspectLocalnetSettlementTransaction,
  shortAddress,
  signIssuedWinnerTransaction,
  type AppSolanaClient,
  type LocalnetSettlementSummary,
} from './solanaClient';

const api = new SolanaApiClient({ baseUrl: '' });

type TicketState = 'idle' | 'collecting' | 'ready' | 'reviewing' | 'submitting' | 'reconciling' | 'success' | 'no_quote' | 'expired' | 'error' | 'offline' | 'wrong_cluster';
type WalletUiState = 'pending' | 'disconnected' | 'connecting' | 'connected' | 'wrong-cluster' | 'rejected' | 'locked';

function formatAmount(atomic: string | undefined, decimals: number): string { return atomic === undefined ? '—' : atomicToDecimal(atomic, decimals); }
function formatDelta(atomic: string | undefined, decimals: number): string {
  if (atomic === undefined) return '—';
  const negative = atomic.startsWith('-');
  const magnitude = negative ? atomic.slice(1) : atomic;
  return `${negative ? '−' : '+'}${formatAmount(magnitude, decimals)}`;
}
function formatBps(value: number | undefined): string { return value === undefined ? '—' : `${value > 0 ? '+' : ''}${value} bps`; }
function formatTimestamp(value: number | undefined): string { return value === undefined ? '—' : new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function stableSymbol(mint: string): string { return mint === SOLANA_USDT_MINT ? 'USDT' : 'USDC'; }

function isExecutableAsset(entry: AssetView): boolean {
  if (entry.capability === 'executable') return true;
  if (entry.capability === 'informational' || entry.capability === 'unavailable') return false;
  return entry.enabled && entry.issuer === 'xstocks';
}

function issuerLabel(issuer: AssetView['issuer']): string {
  return issuer === 'xstocks' ? 'xStocks' : 'Ondo Global Markets';
}

export function App(): ReactElement {
  const [path, setPath] = useState(() => typeof window !== 'undefined' ? window.location.pathname : '/trade');
  useEffect(() => {
    const navigate = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin || !['/trade', '/activity', '/maker', '/operator'].includes(destination.pathname)) return;
      event.preventDefault();
      window.history.pushState({}, '', destination.pathname);
      setPath(destination.pathname);
    };
    const restore = (): void => setPath(window.location.pathname);
    window.addEventListener('click', navigate);
    window.addEventListener('popstate', restore);
    return () => {
      window.removeEventListener('click', navigate);
      window.removeEventListener('popstate', restore);
    };
  }, []);
  const isActivity = path === '/activity';
  const operationsRole: OperationsRole | undefined = path === '/maker' ? 'maker' : path === '/operator' ? 'operator' : undefined;

  const kit = useClient<AppSolanaClient>();
  const walletStatus = useWalletStatus(kit);
  const wallets = useWallets(kit);
  const connected = useConnectedWallet(kit);
  const { dispatch: connectWallet, isRunning: isConnecting, error: connectError } = useConnect(kit);
  const { dispatchAsync: signMessage } = useSignMessage(kit);

  const wallet = connected?.account.address;
  const currentWallet = useRef(wallet);
  currentWallet.current = wallet;
  const wrongCluster = Boolean(connected && !connected.account.chains.includes(EXPECTED_CHAIN));
  const walletUiState: WalletUiState = wrongCluster
    ? 'wrong-cluster'
    : walletStatus === 'pending' || walletStatus === 'reconnecting'
      ? 'pending'
      : walletStatus === 'connecting' || isConnecting
        ? 'connecting'
        : walletStatus === 'connected' && connected
          ? 'connected'
          : connectError
            ? 'rejected'
            : 'disconnected';

  const [outputMint, setOutputMint] = useState(SOLANA_USDC_MINT);
  const [assets, setAssets] = useState<readonly AssetView[]>([]);
  const executableAssets = useMemo(() => assets.filter(isExecutableAsset), [assets]);
  const informationalHeld = useMemo(
    () => assets.filter((entry) => !isExecutableAsset(entry) && entry.balanceAtomic !== '0'),
    [assets],
  );
  const [assetMint, setAssetMint] = useState('');
  const [amount, setAmount] = useState('');
  const [ticketState, setTicketState] = useState<TicketState>('idle');
  const [sprint, setSprint] = useState<QuoteSprint>();
  const [trade, setTrade] = useState<TradeReceipt>();
  const [reviewedSettlement, setReviewedSettlement] = useState<LocalnetSettlementSummary>();
  const [error, setError] = useState<string>();
  const [auditOpen, setAuditOpen] = useState(false);
  const [activity, setActivity] = useState<readonly TradeReceipt[]>([]);
  const [sellerSession, setSellerSession] = useState<{ readonly wallet: string; readonly expiresAtMs: number }>();
  const [sellerAuthBusy, setSellerAuthBusy] = useState(false);
  const hasSellerSession = Boolean(wallet && !wrongCluster && sellerSession?.wallet === wallet && Date.now() < sellerSession.expiresAtMs);

  const asset = useMemo(
    () => executableAssets.find((entry) => entry.mint === assetMint) ?? executableAssets[0] ?? assets[0],
    [assetMint, assets, executableAssets],
  );
  const outputDecimals = 6;
  const inputsLocked = ['collecting', 'ready', 'reviewing', 'submitting', 'reconciling', 'success'].includes(ticketState);

  const loadAssets = useCallback(async (address: string) => {
    try {
      const next = await api.listAssets(address, outputMint);
      if (currentWallet.current !== address) return;
      if (next.length > 0) {
        setAssets(next);
        const nextExecutable = next.filter(isExecutableAsset);
        setAssetMint((current) => nextExecutable.some((entry) => entry.mint === current) ? current : (nextExecutable[0]?.mint ?? current));
      }
      setTicketState((current) => current === 'offline' ? 'idle' : current);
    } catch {
      if (api.activeSellerSession()) setTicketState('offline');
      else setSellerSession(undefined);
    }
  }, [outputMint]);

  useEffect(() => {
    api.clearSellerSession();
    setSellerSession(undefined);
    setAssets([]);
    setActivity([]);
    setSprint(undefined);
    setReviewedSettlement(undefined);
    setTrade(undefined);
    if (wallet && !wrongCluster) setTicketState('idle');
  }, [wallet, wrongCluster]);
  useEffect(() => {
    if (wallet && !wrongCluster && hasSellerSession) void loadAssets(wallet);
  }, [wallet, wrongCluster, hasSellerSession, loadAssets]);
  useEffect(() => {
    if (!wallet || wrongCluster || !hasSellerSession) return;
    let active = true;
    void api.listTrades(wallet).then((next) => {
      if (active && currentWallet.current === wallet) setActivity(next);
    }).catch(() => {
      if (!api.activeSellerSession() && active) setSellerSession(undefined);
    });
    return () => { active = false; };
  }, [wallet, wrongCluster, hasSellerSession, trade]);
  useEffect(() => {
    if (wrongCluster) setTicketState('wrong_cluster');
    else setTicketState((current) => current === 'wrong_cluster' ? 'idle' : current);
  }, [wrongCluster]);

  const connect = async (): Promise<void> => {
    setError(undefined);
    const target = wallets[0];
    if (!target) {
      setError('No Wallet Standard wallet advertising solana:localnet was discovered.');
      setTicketState('error');
      return;
    }
    try {
      await connectWallet(target);
      setTicketState('idle');
    } catch (connectFailure) {
      if ((connectFailure as Error)?.name === 'AbortError') return;
      setError(connectFailure instanceof Error ? connectFailure.message : 'Wallet connection rejected');
      setTicketState('error');
    }
  };

  const authenticateSeller = async (): Promise<void> => {
    if (!wallet || wrongCluster || walletUiState !== 'connected') return;
    setSellerAuthBusy(true);
    setError(undefined);
    try {
      const session = await api.authenticateSeller(wallet, EXPECTED_CHAIN.slice('solana:'.length), signMessage);
      if (currentWallet.current !== wallet) {
        api.clearSellerSession();
        return;
      }
      setSellerSession({ wallet: session.wallet, expiresAtMs: session.expiresAtMs });
      setTicketState('idle');
    } catch (authError) {
      if (!api.activeSellerSession()) setSellerSession(undefined);
      setError(authError instanceof Error ? authError.message : 'Seller wallet proof was rejected');
      setTicketState('error');
    } finally {
      setSellerAuthBusy(false);
    }
  };

  const pollSprint = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 36; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      try {
        const next = await api.getQuoteSprint(id);
        setSprint(next);
        if (next.state === 'winner_ready') { setTicketState('ready'); return; }
        if (next.state === 'no_liquidity') { setTicketState('no_quote'); return; }
        if (next.state === 'expired') { setTicketState('expired'); return; }
        if (next.state === 'action_required' || next.state === 'ineligible' || next.state === 'capability_unavailable') {
          setError(next.eligibility.message || next.failureMessage || next.state);
          setTicketState('error');
          return;
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : 'Quote sprint unavailable');
        setTicketState('error');
        return;
      }
    }
    setError('Quote sprint timed out. Request a fresh price.');
    setTicketState('no_quote');
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    setTrade(undefined);
    if (wrongCluster) { setTicketState('wrong_cluster'); setError('Switch your wallet to solana:localnet before requesting a quote.'); return; }
    if (!wallet) { setError('Connect a Wallet Standard wallet before requesting a quote.'); return; }
    if (!hasSellerSession) { setError('Prove control of this wallet before requesting Seller-specific data or a quote.'); setTicketState('error'); return; }
    if (!asset || !isExecutableAsset(asset)) { setError('Select an executable asset. Managed Route holdings are informational only.'); return; }
    try {
      const inputAmountAtomic = decimalToAtomic(amount, asset.decimals, 'stock amount').toString();
      if (inputAmountAtomic === '0') throw new Error('Enter an amount greater than zero.');
      setTicketState('collecting');
      const next = await api.createQuoteSprint({ wallet, inputMint: asset.mint, outputMint, inputAmountAtomic });
      setSprint(next);
      if (next.state === 'winner_ready') { setTicketState('ready'); return; }
      if (next.state !== 'collecting' && next.state !== 'validating') {
        setTicketState(next.state === 'no_liquidity' ? 'no_quote' : 'error');
        setError(next.eligibility.message || next.failureMessage);
        return;
      }
      await pollSprint(next.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not start quote sprint');
      setTicketState('error');
    }
  };

  const openReview = (): void => {
    if (!wallet || !hasSellerSession || !sprint?.winner || sprint.state !== 'winner_ready') return;
    setError(undefined);
    setTicketState('reviewing');
    void api.reviewQuoteSprint(sprint.id, wallet).then((reviewed) => {
      if (!reviewed.winner?.simulation.ok) throw new Error('The issued transaction did not pass simulation. Signing is blocked.');
      const winner = reviewed.winner;
      if (!winner?.transactionBase64 || !winner.transactionHash) throw new Error('The issued settlement bytes or message hash are missing. Signing is blocked.');
      const settlement = inspectLocalnetSettlementTransaction(winner.transactionBase64, wallet, {
        sourceKind: winner.sourceKind,
        quoteId: winner.quoteId,
        inputMint: winner.inputMint,
        outputMint: winner.outputMint,
        inputAmountAtomic: winner.inputAmountAtomic,
        grossOutputAtomic: winner.grossOutputAtomic,
        netOutputAtomic: winner.netOutputAtomic,
        feeBps: winner.katonFeeBps ?? 0,
        expiresAtMs: winner.expiresAtMs,
      });
      setSprint(reviewed);
      setReviewedSettlement(settlement);
      setTicketState('ready');
    }).catch((reviewError: unknown) => {
      setError(reviewError instanceof Error ? reviewError.message : 'The localnet settlement transaction could not be reviewed.');
      setTicketState('error');
      if (!api.activeSellerSession()) setSellerSession(undefined);
    });
  };

  const signAndAuthorize = async (): Promise<void> => {
    if (!wallet || !connected?.account || !sprint?.winner) return;
    const winner = sprint.winner;
    const issuedTransactionBase64 = winner.transactionBase64;
    if (!issuedTransactionBase64) return;
    if (wrongCluster) {
      setTicketState('wrong_cluster');
      setError('Wrong cluster: connect a wallet on solana:localnet before authorizing.');
      return;
    }
    setTicketState('submitting');
    setError(undefined);
    try {
      const currentSettlement = inspectLocalnetSettlementTransaction(issuedTransactionBase64, wallet, {
        sourceKind: winner.sourceKind,
        quoteId: winner.quoteId,
        inputMint: winner.inputMint,
        outputMint: winner.outputMint,
        inputAmountAtomic: winner.inputAmountAtomic,
        grossOutputAtomic: winner.grossOutputAtomic,
        netOutputAtomic: winner.netOutputAtomic,
        feeBps: winner.katonFeeBps ?? 0,
        expiresAtMs: winner.expiresAtMs,
      });
      if (!reviewedSettlement || JSON.stringify(currentSettlement) !== JSON.stringify(reviewedSettlement)) {
        throw new Error('The transaction no longer matches the summary you reviewed. Signing is blocked.');
      }
      const reviewHash = winner.transactionHash;
      if (!reviewHash || (sprint.reviewHash !== undefined && sprint.reviewHash !== reviewHash)) {
        throw new Error('The approval hash does not match the issued transaction message. Signing is blocked.');
      }
      const signedTransactionBase64 = await signIssuedWinnerTransaction(connected.account, issuedTransactionBase64);
      const authorized = await api.authorizeQuoteSprint(sprint.id, { wallet, reviewHash, signedTransactionBase64 });
      setSprint(authorized);
      if (authorized.state !== 'authorized') {
        setError(authorized.failureMessage ?? 'Authorization did not reach authorized state');
        setTicketState('error');
        return;
      }
      const attempt = await api.createExecutionAttempt({
        quoteSprintId: authorized.id,
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      if (attempt.status === 'reconciling') {
        setTicketState('reconciling');
        setError(attempt.failureMessage ?? `Settlement submission is being reconciled${attempt.signature ? `: ${attempt.signature}` : ''}. Do not resubmit.`);
        return;
      }
      const receipt = attempt.receipt;
      if (attempt.status !== 'final' || !receipt?.signature || receipt.signature.startsWith('mock-')) {
        throw new Error(attempt.failureMessage ?? 'Execution attempt did not return confirmed settlement evidence');
      }
      if (receipt.cluster !== EXPECTED_CHAIN || !receipt.slot || !receipt.fillReceipt
        || !receipt.stockMint || !receipt.stableMint || !receipt.stockTokenProgram || !receipt.stableTokenProgram
        || receipt.sellerStockDeltaAtomic !== `-${receipt.inputAmountAtomic}`
        || receipt.sellerStableDeltaAtomic === undefined || receipt.feeStableDeltaAtomic === undefined) {
        throw new Error('Confirmed transaction receipt is missing verified localnet settlement evidence');
      }
      setTrade(receipt);
      setTicketState('success');
    } catch (executeError) {
      const message = executeError instanceof Error ? executeError.message : 'Authorization rejected';
      if (message.toLowerCase().includes('cluster') || message.toLowerCase().includes('network')) {
        setTicketState('wrong_cluster');
      } else {
        setTicketState('error');
      }
      setError(message);
    }
  };

  const walletButtonLabel = walletUiState === 'connected' && wallet
    ? shortAddress(wallet)
    : walletUiState === 'connecting' || walletUiState === 'pending'
      ? 'Connecting…'
      : walletUiState === 'wrong-cluster'
        ? 'Wrong cluster'
        : 'Connect wallet';
  const sellerAccessButtonLabel = hasSellerSession
    ? `${shortAddress(wallet!)} · Sign out`
    : sellerAuthBusy
      ? 'Proving wallet…'
      : wallet && walletUiState === 'connected'
        ? 'Prove Seller wallet'
        : walletButtonLabel;
  const sellerAccessAction = () => {
    if (hasSellerSession) {
      api.clearSellerSession();
      setSellerSession(undefined);
      setAssets([]);
      setActivity([]);
      setSprint(undefined);
      setReviewedSettlement(undefined);
      setTrade(undefined);
      return;
    }
    if (wallet && walletUiState === 'connected') void authenticateSeller();
    else void connect();
  };

  if (isActivity) {
    return <ActivityPage wallet={wallet} walletUiState={walletUiState} activity={activity} sellerSession={hasSellerSession} sellerAuthBusy={sellerAuthBusy} onSellerAccess={sellerAccessAction} sellerButtonLabel={sellerAccessButtonLabel} />;
  }
  if (operationsRole) {
    return <OperationsPage role={operationsRole} wallet={wallet} walletUiState={walletUiState} onConnect={() => void connect()} onSignMessage={signMessage} walletButtonLabel={walletButtonLabel} />;
  }

  return <div className="shell">
      <header className="topbar">
      <a className="wordmark" href="/trade" aria-label="Katon home">KATON <span>/ SOLANA</span></a>
      <nav aria-label="Primary navigation"><a className={!isActivity && !operationsRole ? 'active' : undefined} href="/trade">Seller Desk</a><a className={isActivity ? 'active' : undefined} href="/activity">Activity</a><a className="ops-link" href="/maker">Maker</a><a className="ops-link" href="/operator">Ops</a></nav>
      <button className="wallet-button" type="button" onClick={sellerAccessAction} disabled={sellerAuthBusy || walletUiState === 'connecting' || walletUiState === 'pending'}>{sellerAccessButtonLabel}</button>
    </header>

    <main className="main-grid">
      <section className="ticket-column" aria-labelledby="page-title">
        <div className="eyebrow">SELLER DESK <span className="live-dot" aria-hidden="true" /> LOCALNET</div>
        <h1 id="page-title">Sell tokenized stock.<br /><em>Keep control.</em></h1>
        <p className="lede">Request an exact-input Quote Sprint, inspect the frozen winner, and review the exact localnet transaction before deciding whether to sign.</p>
        <div className="proof-disclosure" role="note"><strong>Localnet test settlement</strong><span>This desk settles local test stock for locally provisioned USDC or USDT. These assets have no issuer backing and are not Devnet or Mainnet assets.</span></div>

        <form className="trade-ticket" onSubmit={(event) => void submit(event)}>
          <div className="ticket-header"><div><span className="label">SELL · TEST ASSET</span><strong>Local test stock</strong></div><span className="session-pill">{wrongCluster ? 'Wrong cluster' : hasSellerSession ? 'Seller session active' : wallet ? 'Wallet proof required' : 'Connect to begin'}</span></div>
          <label className="field-label" htmlFor="asset">Asset</label>
          <select id="asset" className="select-input" value={asset?.mint ?? ''} onChange={(event) => setAssetMint(event.target.value)} disabled={inputsLocked || !hasSellerSession || executableAssets.length === 0}>
            {executableAssets.map((entry) => <option value={entry.mint} key={entry.mint}>{entry.ticker} · xStocks · {entry.underlyingTicker}</option>)}
          </select>
          <div className="asset-meta"><span className={`issuer-badge issuer-${asset?.issuer ?? 'xstocks'}`}>{asset ? `${issuerLabel(asset.issuer)} test asset` : 'Local test asset'}</span><span>{asset?.tokenProgram === 'token-2022' ? 'Token-2022' : 'SPL Token'} · {asset?.decimals ?? 0} decimals</span><span>RPC balance {hasSellerSession ? formatAmount(asset?.balanceAtomic, asset?.decimals ?? 6) : 'prove wallet to view'}</span></div>
          {hasSellerSession && informationalHeld.length > 0 ? <p className="ticket-footnote informational-note"><span aria-hidden="true">◇</span> Held Ondo / managed inventory is informational only — Managed Route not enabled.</p> : null}

          <div className="amount-label-row"><label className="field-label" htmlFor="amount">Amount</label><button type="button" className="max-button" onClick={() => asset && setAmount(formatAmount(asset.balanceAtomic, asset.decimals))} disabled={inputsLocked || !asset || !hasSellerSession}>Use full balance</button></div>
          <div className="amount-wrap"><input id="amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="0.000000" disabled={inputsLocked || !hasSellerSession} required /><span>{asset?.ticker ?? '—'}</span></div>

          <fieldset className="output-fieldset"><legend className="field-label">Receive</legend><div className="output-options">{[[SOLANA_USDC_MINT, 'USDC'], [SOLANA_USDT_MINT, 'USDT']].map(([mint, symbol]) => <label className={`output-option ${outputMint === mint ? 'selected' : ''}`} key={mint}><input type="radio" name="output" value={mint} checked={outputMint === mint} onChange={() => setOutputMint(mint)} disabled={inputsLocked || !hasSellerSession} /><span>{symbol}</span><small>native Solana</small></label>)}</div></fieldset>
          <button className="primary-button" type="submit" disabled={inputsLocked || !hasSellerSession || !asset || asset.eligibility.status !== 'eligible' || wrongCluster}>{ticketState === 'collecting' ? <><span className="spinner" aria-hidden="true" /> Finding executable prices</> : 'Find best executable price'}<span aria-hidden="true">↗</span></button>
          <p className="ticket-footnote"><span aria-hidden="true">♢</span> Exact input · full fill · no custody · max quote life 30 seconds</p>
        </form>

        <StatusPanel state={ticketState} error={error} sprint={sprint} onReview={openReview} onRefresh={() => { setTicketState(wrongCluster ? 'wrong_cluster' : 'idle'); setSprint(undefined); setReviewedSettlement(undefined); setError(undefined); }} />
      </section>

      <aside className="context-column" aria-label="Execution context">
        <div className="context-card reference-card"><div className="card-kicker">REFERENCE POLICY</div><div className="context-row"><span>Status</span><strong>{asset?.referencePolicy?.status ?? 'unavailable'}</strong></div><div className="context-row"><span>Licensed primary</span><strong>{asset?.referencePolicy?.primary ? `${formatAmount(asset.referencePolicy.primary.priceAtomic, asset.referencePriceDecimals ?? asset.decimals)} USDC · ${formatTimestamp(asset.referencePolicy.primary.observedAtMs)}` : 'No current observation'}</strong></div><div className="reference-note">Collection requires a fresh licensed primary and independent cross-check. Registry values are metadata and never price fallbacks.</div></div>
        <div className="context-card"><div className="card-kicker">BEST EXECUTION</div><div className="source-line"><span className="source-mark jupiter-mark">J</span><span><strong>Jupiter</strong><small>Non-executable demo stub</small></span><span className="source-state">Excluded</span></div><div className="source-line"><span className="source-mark maker-mark">K</span><span><strong>Private Maker</strong><small>Governed local RFQ settlement</small></span><span className="source-state">Executable</span></div><div className="context-divider" /><p className="context-note">Only the governed Private Maker can win this local settlement flow.</p></div>
        <div className="context-card safety-card"><div className="card-kicker">SETTLEMENT CONTROLS</div><div className="safety-item"><span>01</span><p><strong>Inspect exact bytes</strong>Review the stock debit, stablecoin minimum, fee, accounts, and instructions.</p></div><div className="safety-item"><span>02</span><p><strong>Authorize before submit</strong>The Seller signs the frozen message hash; the API checks both signatures.</p></div><div className="safety-item"><span>03</span><p><strong>RPC confirmed receipt</strong>Activity is published after confirmation and verified token-account deltas.</p></div><p className="context-note">{activity.length} confirmed {activity.length === 1 ? 'settlement' : 'settlements'} in this wallet</p></div>
      </aside>
    </main>

    {sprint?.winner && reviewedSettlement && (ticketState === 'ready' || ticketState === 'reviewing') ? <ReviewPanel sprint={sprint} settlement={reviewedSettlement} outputDecimals={outputDecimals} onOpenAudit={() => setAuditOpen(true)} onSign={() => void signAndAuthorize()} onClose={() => setTicketState('ready')} /> : null}
    {auditOpen && sprint ? <AuditDrawer sprint={sprint} onClose={() => setAuditOpen(false)} outputDecimals={outputDecimals} /> : null}
    {trade ? <ReceiptPanel trade={trade} outputDecimals={outputDecimals} onClose={() => setTrade(undefined)} /> : null}
  </div>;
}

function StatusPanel({ state, error, sprint, onReview, onRefresh }: { readonly state: TicketState; readonly error?: string; readonly sprint?: QuoteSprint; readonly onReview: () => void; readonly onRefresh: () => void }): ReactElement | null {
  if (state === 'idle') return null;
  if (state === 'collecting') return <div className="status-panel collecting-panel" role="status"><div className="status-icon ring-icon"><span className="spinner" /></div><div><strong>Quote sprint in progress</strong><p>Checking Jupiter and healthy private makers for up to three seconds. No placeholder prices are shown.</p></div></div>;
  if (state === 'ready' && sprint?.winner) return <div className="status-panel ready-panel"><div className="status-icon check-icon">✓</div><div className="ready-copy"><div className="ready-label">EXECUTABLE LOCALNET SETTLEMENT · PRIVATE MAKER</div><strong>{formatAmount(sprint.winner.netOutputAtomic, 6)} {stableSymbol(sprint.winner.outputMint)} minimum</strong><p>Receive at least this amount for {formatAmount(sprint.winner.inputAmountAtomic, 6)} stock · fee {formatAmount(sprint.winner.katonFeeAtomic, 6)} {stableSymbol(sprint.winner.outputMint)}</p><p>Quote expires {formatTimestamp(sprint.winner.expiresAtMs)} · {formatBps(sprint.winner.deviationBps)} to reference</p><button className="secondary-button" type="button" onClick={onReview}>Review settlement <span>↗</span></button></div></div>;
  if (state === 'no_quote') return <div className="status-panel warning-panel"><div className="status-icon">!</div><div><strong>No executable quote</strong><p>{sprint?.eligibility.message ?? 'All sources rejected this size or state. Check eligibility, session hours, balance, or try a smaller supported size.'}</p><button className="text-button" type="button" onClick={onRefresh}>Start a fresh sprint</button></div></div>;
  if (state === 'expired') return <div className="status-panel warning-panel"><div className="status-icon">↻</div><div><strong>Quote expired</strong><p>The action was invalidated with two seconds or less remaining. Request a fresh executable price.</p><button className="text-button" type="button" onClick={onRefresh}>Find a fresh price</button></div></div>;
  if (state === 'wrong_cluster') return <div className="status-panel warning-panel" role="alert"><div className="status-icon">!</div><div><strong>Wrong cluster</strong><p>{error ?? 'Connect a Wallet Standard wallet on solana:localnet. Authorization is blocked on other clusters.'}</p><button className="text-button" type="button" onClick={onRefresh}>Dismiss</button></div></div>;
  if (state === 'submitting') return <div className="status-panel collecting-panel" role="status"><div className="status-icon ring-icon"><span className="spinner" /></div><div><strong>Submitting settlement</strong><p>Your wallet signed the issued message. The API is checking and submitting those same bytes once.</p></div></div>;
  if (state === 'reconciling') return <div className="status-panel warning-panel" role="status"><div className="status-icon">↻</div><div><strong>Settlement outcome is being reconciled</strong><p>{error ?? 'RPC has not confirmed whether the transaction landed. Do not submit this quote again.'}</p></div></div>;
  if (state === 'success') return <div className="status-panel ready-panel" role="status"><div className="status-icon check-icon">✓</div><div><strong>Stock settlement confirmed</strong><p>RPC confirmed the transaction and token-account deltas. Open the receipt for the fill evidence.</p></div></div>;
  return <div className="status-panel error-panel" role="alert"><div className="status-icon">×</div><div><strong>{state === 'offline' ? 'Desk unavailable' : 'Could not complete request'}</strong><p>{error ?? 'Try again after checking your wallet and network.'}</p><button className="text-button" type="button" onClick={onRefresh}>Try again</button></div></div>;
}

function ActivityPage({ wallet, walletUiState, activity, sellerSession, sellerAuthBusy, onSellerAccess, sellerButtonLabel }: { readonly wallet?: string; readonly walletUiState: WalletUiState; readonly activity: readonly TradeReceipt[]; readonly sellerSession: boolean; readonly sellerAuthBusy: boolean; readonly onSellerAccess: () => void; readonly sellerButtonLabel: string }): ReactElement {
  return <div className="shell">
    <header className="topbar">
      <a className="wordmark" href="/trade" aria-label="Katon home">KATON <span>/ SOLANA</span></a>
      <nav aria-label="Primary navigation"><a href="/trade">Seller Desk</a><a className="active" href="/activity">Activity</a><a className="ops-link" href="/maker">Maker</a><a className="ops-link" href="/operator">Ops</a></nav>
      <button className="wallet-button" type="button" onClick={onSellerAccess} disabled={sellerAuthBusy || walletUiState === 'connecting' || walletUiState === 'pending'}>{sellerButtonLabel}</button>
    </header>
    <main className="activity-main" aria-labelledby="activity-title">
      <div className="eyebrow">WALLET ACTIVITY <span className="live-dot" aria-hidden="true" /> LOCALNET</div>
      <h1 id="activity-title">Your exits.</h1>
      <p className="lede">Activity is scoped to the connected Wallet Standard account and contains only RPC-confirmed localnet stock-for-stablecoin fills.</p>
      {!wallet || walletUiState !== 'connected' ? <div className="empty-state"><strong>Connect a wallet to view activity</strong><p>Activity is scoped to the connected Wallet Standard account on solana:localnet.</p><button className="primary-button" type="button" onClick={onSellerAccess}>Connect wallet <span>↗</span></button></div> : !sellerSession ? <div className="empty-state"><strong>Prove control of this wallet</strong><p>Sign a one time Seller challenge before this wallet’s activity can be read.</p><button className="primary-button" type="button" onClick={onSellerAccess} disabled={sellerAuthBusy}>Prove Seller wallet <span>↗</span></button></div> : activity.length === 0 ? <div className="empty-state"><strong>No confirmed fills yet</strong><p>Settlements appear here after RPC confirms the transaction and account deltas.</p><a className="secondary-button" href="/trade">Open Seller Desk <span>↗</span></a></div> : <div className="activity-table" role="table"><div className="activity-row activity-header" role="row"><span>Date</span><span>Quote source</span><span>Stock debited</span><span>Stablecoin received</span><span>Status</span></div>{activity.map((trade) => {
        const link = explorerTxUrl(trade.signature);
        return <details className="activity-detail" key={trade.tradeId}><summary className="activity-row" role="row"><span>{formatTimestamp(trade.finalizedAtMs ?? trade.confirmedAtMs)}</span><span>Private Maker</span><span>{formatAmount(trade.inputAmountAtomic, 6)} stock</span><span>{formatAmount(trade.sellerStableDeltaAtomic, 6)} {trade.outputMint === SOLANA_USDT_MINT ? 'USDT' : 'USDC'}</span><span className="audit-good">{trade.commitment}</span></summary><div className="activity-expanded"><p>Confirmed stock and stablecoin account deltas from {trade.cluster ?? EXPECTED_CHAIN} slot {trade.slot ?? '—'}.</p><div><span>Fill receipt</span><strong className="signature">{trade.fillReceipt ?? '—'}</strong></div><div><span>Stock mint · Token program</span><strong className="signature">{trade.stockMint ?? trade.inputMint} · {trade.stockTokenProgram ?? '—'}</strong></div><div><span>Stable mint · Token program</span><strong className="signature">{trade.stableMint ?? trade.outputMint} · {trade.stableTokenProgram ?? '—'}</strong></div><div><span>Seller stock delta</span><strong>{formatDelta(trade.sellerStockDeltaAtomic, 6)}</strong></div><div><span>Seller stablecoin delta</span><strong>{formatDelta(trade.sellerStableDeltaAtomic, 6)}</strong></div><div><span>Fee account delta</span><strong>{formatDelta(trade.feeStableDeltaAtomic, 6)}</strong></div><div><span>Trade ID</span><strong>{trade.tradeId}</strong></div><div><span>Quote ID</span><strong>{trade.quoteId}</strong></div><div><span>Signature</span><strong className="signature">{trade.signature}</strong></div>{link ? <a className="solscan-link" href={link} target="_blank" rel="noreferrer">View on explorer ↗</a> : <span className="mock-signature-note">Localnet signatures are inspected through RPC.</span>}</div></details>;
      })}</div>}
    </main>
  </div>;
}

type OperationsRole = 'maker' | 'operator';

function OperationsPage({ role, wallet, walletUiState, onConnect, onSignMessage, walletButtonLabel }: { readonly role: OperationsRole; readonly wallet?: string; readonly walletUiState: WalletUiState; readonly onConnect: () => void; readonly onSignMessage: (message: Uint8Array) => Promise<Uint8Array>; readonly walletButtonLabel: string }): ReactElement {
  const maker = role === 'maker';
  const [roleSession, setRoleSession] = useState<{ token: string; wallet: string }>();
  const token = walletUiState === 'connected' && roleSession?.wallet === wallet ? roleSession?.token ?? '' : '';
  const [roleData, setRoleData] = useState<{ token: string; body: Record<string, unknown> }>();
  const data = token && roleData?.token === token ? roleData.body : undefined;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (session: string) => {
    const response = await fetch(maker ? '/v1/makers/me' : '/v1/operator', { headers: { authorization: `Bearer ${session}` } });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : 'Role session was rejected');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Desk returned malformed role status');
    return body as Record<string, unknown>;
  }, [maker]);
  useEffect(() => {
    if (!token) { setRoleData(undefined); return; }
    let active = true;
    void load(token).then((body) => { if (active) setRoleData({ token, body }); }).catch((cause: unknown) => {
      if (!active) return;
      setRoleSession(undefined); setRoleData(undefined); setError(cause instanceof Error ? cause.message : 'Role session expired');
    });
    return () => { active = false; };
  }, [load, token]);
  const authenticate = async () => {
    if (!wallet || walletUiState !== 'connected') return;
    setBusy(true); setError(undefined);
    try {
      const challengeResponse = await fetch('/v1/role-sessions/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: wallet, role }) });
      const challenge = await challengeResponse.json() as { challengeId?: string; message?: string; error?: string };
      if (!challengeResponse.ok || !challenge.challengeId || !challenge.message) throw new Error(challenge.error ?? 'This wallet has not been provisioned for the selected role');
      const signature = await onSignMessage(new TextEncoder().encode(challenge.message));
      const sessionResponse = await fetch('/v1/role-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: wallet, role, challengeId: challenge.challengeId, signature: btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }) });
      const session = await sessionResponse.json() as { token?: string; error?: string };
      if (!sessionResponse.ok || !session.token) throw new Error(session.error ?? 'Could not create role session');
      setRoleSession({ token: session.token, wallet }); setRoleData({ token: session.token, body: await load(session.token) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Role authentication failed'); }
    finally { setBusy(false); }
  };
  const command = async (path: string) => {
    if (!token) return;
    setBusy(true); setError(undefined);
    try {
      const response = await fetch(path, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : 'Command was rejected');
      setRoleData({ token, body: await load(token) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Command failed'); }
    finally { setBusy(false); }
  };
  const makerStatus = data?.maker as { makerId?: string; enabled?: boolean; operatorDisabled?: boolean; availability?: string; lastSeenAtMs?: number; capabilities?: Array<{ inputMint: string; outputMint: string; minInputAtomic: string; maxInputAtomic: string }>; quotesReceived?: number; quotesRejected?: number } | undefined;
  const receipts = Array.isArray(data?.receipts) ? data.receipts as TradeReceipt[] : [];
  const sources = Array.isArray(data?.sources) ? data.sources as Array<{ sourceId?: string; sourceKind?: string; enabled?: boolean }> : [];
  const onChain = typeof data?.onChain === 'object' && data.onChain !== null ? data.onChain as Record<string, unknown> : undefined;
  const registryEvidence = typeof onChain?.registry === 'object' && onChain.registry !== null ? onChain.registry as { status?: string; reason?: string; value?: { assets?: unknown[]; makers?: unknown[] } } : undefined;
  const makerRegistries = registryEvidence?.value?.makers as Array<{ lastApplied?: { registryVersion?: string } | null }> | undefined;
  const makerRegistryAction = makerRegistries?.length === 1 ? makerRegistries[0]?.lastApplied : undefined;
  const makerGovernanceDetail = makerRegistries?.length === 1
    ? makerRegistryAction && typeof makerRegistryAction.registryVersion === 'string'
      ? `Stored delayed SetMakers record for registry version ${makerRegistryAction.registryVersion}. Maker access still requires verified governance and program evidence.`
      : 'No applied SetMakers record is stored; provisioned Makers remain disabled.'
    : 'No single Maker registry account is observed; provisioned Makers remain disabled.';
  const pauseEvidence = typeof onChain?.pauses === 'object' && onChain.pauses !== null ? onChain.pauses as { status?: string; reason?: string; value?: { program?: boolean } } : undefined;
  const governanceStatus = typeof onChain?.governanceChanges === 'object' && onChain.governanceChanges !== null ? onChain.governanceChanges as { status?: string; reason?: string; value?: { queued?: unknown[]; governance?: { feeBps?: number; maxFeeBps?: number; maxQuoteLifetimeSeconds?: string; maxStockInputAtomic?: string } | null } } : undefined;
  const programEvidence = typeof data?.programEvidence === 'object' && data.programEvidence !== null ? data.programEvidence as {
    status?: string;
    reason?: string;
    value?: {
      manifest?: EvidenceObservation;
      lenderPrograms?: Array<EvidenceObservation & { name?: string }>;
      rfqProgram?: EvidenceObservation;
      squadsProgram?: EvidenceObservation;
      squads?: EvidenceObservation;
    };
  } : undefined;
  const programEvidenceRows = programEvidence?.value ? [
    { label: 'Manifest signature', observation: describeEvidence(programEvidence.value.manifest, [['cluster', 'cluster'], ['signerPublicKey', 'signer']]) },
    ...(programEvidence.value.lenderPrograms ?? []).map((item) => ({
      label: item.name ?? 'Lender program',
      observation: describeEvidence(item, [['programId', 'program'], ['bytecodeSha256', 'bytecode SHA-256'], ['upgradeAuthority', 'upgrade authority']]),
    })),
    { label: 'Seller Desk RFQ', observation: describeEvidence(programEvidence.value.rfqProgram, [['programId', 'program'], ['bytecodeSha256', 'bytecode SHA-256'], ['upgradeAuthority', 'upgrade authority']]) },
    { label: 'Squads v4 program', observation: describeEvidence(programEvidence.value.squadsProgram, [['programId', 'program'], ['bytecodeSha256', 'bytecode SHA-256'], ['upgradeAuthority', 'upgrade authority']]) },
    { label: 'Squads v4 governance', observation: describeEvidence(programEvidence.value.squads, [['programId', 'program'], ['multisigAddress', 'multisig'], ['vaultAddress', 'vault'], ['vaultAccount', 'vault account']]) },
  ] : [];
  return <div className="shell">
    <header className="topbar">
      <a className="wordmark" href="/trade" aria-label="Katon home">KATON <span>/ SOLANA</span></a>
      <nav aria-label="Primary navigation"><a href="/trade">Seller Desk</a><a href="/activity">Activity</a><a className={maker ? 'active ops-link' : 'ops-link'} href="/maker">Maker</a><a className={!maker ? 'active ops-link' : 'ops-link'} href="/operator">Ops</a></nav>
      {wallet && walletUiState === 'connected' ? <span className="wallet-chip">{shortAddress(wallet)}</span> : <button className="wallet-button" type="button" onClick={onConnect} disabled={walletUiState === 'connecting' || walletUiState === 'pending'}>{walletButtonLabel}</button>}
    </header>
    <main className="operations-main" aria-labelledby="operations-title">
      <div className="eyebrow">{maker ? 'MAKER GATEWAY' : 'OPERATOR CONSOLE'} <span className="live-dot" aria-hidden="true" /> ACCESS CONTROLLED</div>
      <h1 id="operations-title">{maker ? <>Quote with<br /><em>discipline.</em></> : <>Keep the desk<br /><em>safe.</em></>}</h1>
      <p className="lede">{maker ? 'Authenticated streaming is the integration surface. This dashboard never becomes a public bid board or a manual spread-entry form.' : 'Operator access shows configured source controls and only the chain evidence available to the local reader. This browser has no governance apply or surface enablement action.'}</p>
      <div className="gated-banner" role="status"><div className="status-icon">{token ? '✓' : '◎'}</div><div><strong>{token ? `${role} role session active` : wallet ? 'Prove provisioned role' : 'Invite required'}</strong><p>{token ? 'Session is short lived and checked against the provisioned identity on each request.' : 'Connect the provisioned Wallet Standard key and sign a one time challenge. A connected wallet alone does not grant authority.'}</p>{error ? <p role="alert">{error}</p> : null}</div>{!wallet ? <button className="secondary-button" type="button" onClick={onConnect}>Connect wallet <span>↗</span></button> : !token ? <button className="secondary-button" type="button" onClick={() => void authenticate()} disabled={busy || walletUiState !== 'connected'}>{busy ? 'Authenticating…' : `Authenticate ${role}`}</button> : <button className="text-button" type="button" onClick={() => { setRoleSession(undefined); setRoleData(undefined); }}>Sign out</button>}</div>
      <section className="operations-grid">
        {maker ? <>
          <OperationsCard kicker="ACCESS" title="Maker source" value={token ? makerStatus?.makerId ?? 'Provisioned identity' : 'Role session required'} detail={token ? `${makerStatus?.enabled ? 'Enabled' : 'Disabled'} · ${makerStatus?.operatorDisabled ? 'operator disabled' : makerStatus?.availability ?? 'unavailable'}${makerStatus?.lastSeenAtMs ? ` · last seen ${formatTimestamp(makerStatus.lastSeenAtMs)}` : ''}` : 'The stream accepts only provisioned maker keys with a valid role session.'} status={token ? makerStatus?.availability ?? 'Unavailable' : 'Gated'} />
          <OperationsCard kicker="INVENTORY" title="Advertised capabilities" value={token ? `${makerStatus?.capabilities?.length ?? 0} ranges` : 'Private'} detail={token && makerStatus?.capabilities?.length ? <ul className="maker-capability-list">{makerStatus.capabilities.map((capability) => <li key={`${capability.inputMint}:${capability.outputMint}`}><strong>{capability.inputMint}</strong><span>→ {capability.outputMint}</span><small>{capability.minInputAtomic}–{capability.maxInputAtomic} atomic units</small></li>)}</ul> : token ? 'No input, output, or size ranges are currently advertised.' : 'Maker capabilities are visible only to this authenticated identity.'} status={makerStatus?.availability ?? 'Private'} />
          <OperationsCard kicker="LIQUIDITY" title="Stable balances" value="Unavailable" detail="No production maker balance reader is configured. Demo fixture balances are not presented as observed inventory." status="Not observed" />
          <OperationsCard kicker="RELIABILITY" title="Quote outcomes" value={token ? `${makerStatus?.quotesReceived ?? 0} accepted` : 'Awaiting authenticated stream'} detail={`${makerStatus?.quotesRejected ?? 0} rejected · availability ${makerStatus?.availability ?? 'unavailable'} · ${(makerStatus?.capabilities ?? []).length} advertised ranges`} status={token ? 'Private status' : 'Offline'} />
          <OperationsCard kicker="QUALITY" title="Settlement receipts" value={token ? `${receipts.length} fills` : 'Private'} detail="Only this maker’s completed fill records are shown. Seller identities and reusable transaction bytes are withheld from the Maker dashboard." status="Identity scoped" />
          <OperationsCard kicker="SANDBOX" title="RFQ simulator" value="Ready after invite" detail="Replay exact-input requests against deterministic fixtures before production credentials are issued." status="Gated" />
        </> : <>
          <OperationsCard kicker="POLICY" title="Asset registry" value={!token ? 'Role session required' : registryEvidence?.status === 'observed' ? `${registryEvidence.value?.assets?.length ?? 0} assets · ${registryEvidence.value?.makers?.length ?? 0} maker registries` : 'Unavailable'} detail={!token ? 'Operator status is available only to provisioned operator keys.' : registryEvidence?.status === 'observed' ? <>Registry accounts were read from the configured Solana RPC and validated by owner and Anchor discriminator. {makerGovernanceDetail}</> : registryEvidence?.reason ?? 'Registry state is not observed.'} status={!token ? 'Gated' : registryEvidence?.status === 'observed' ? 'Observed' : 'Unavailable'} />
          <OperationsCard kicker="SOURCES" title="Local source controls" value={token ? `${sources.filter((source) => source.enabled).length} locally active` : 'Role session required'} detail={sources.map((source) => `${source.sourceId ?? 'source'} ${source.enabled ? 'locally active' : 'disabled'}`).join(' · ') || 'No source status loaded.'} status="Local proof" />
          <OperationsCard kicker="GOVERNANCE" title="Queued changes" value={!token ? 'Role session required' : governanceStatus?.status === 'observed' ? `${governanceStatus.value?.queued?.length ?? 0} queued` : 'Unavailable'} detail={!token ? 'Squads actions remain outside this browser.' : governanceStatus?.status === 'observed' ? `${governanceStatus.value?.governance ? `Fee ${governanceStatus.value.governance.feeBps}/${governanceStatus.value.governance.maxFeeBps} bps · quote limit ${governanceStatus.value.governance.maxQuoteLifetimeSeconds}s` : 'Governance account is missing'} · observed through read-only RPC.` : governanceStatus?.reason ?? 'Squads queue state is unavailable.'} status={!token ? 'Gated' : governanceStatus?.status ?? 'Unavailable'} />
          <OperationsCard kicker="PROGRAMS" title="Deployment evidence" value={programEvidence?.status ?? 'Unavailable'} detail={programEvidenceRows.length > 0 ? <><ul className="evidence-observations">{programEvidenceRows.map((row) => <li key={row.label}><strong>{row.label}:</strong> {row.observation}</li>)}</ul>{programEvidence?.reason ? <span className="evidence-summary">{programEvidence.reason}</span> : null}</> : programEvidence?.reason ?? 'No verified deployment evidence was returned.'} status={programEvidence?.status === 'observed' ? 'Observed' : 'Unavailable'} />
          <OperationsCard kicker="SOLVER" title="Liquidation Execution" value="Unavailable" detail="Its enablement and runtime health cannot be verified by this API." status="Not observed" />
          <OperationsCard kicker="CANARY" title="Limits" value="Unavailable" detail="Governance-controlled limits are unavailable until a validated local chain reader is configured." status="Not observed" />
          <OperationsCard kicker="EMERGENCY" title="Pause state" value={!token ? 'Role session required' : pauseEvidence?.status === 'observed' ? pauseEvidence.value?.program ? 'Program paused' : 'Program active' : 'Unavailable'} detail={!token ? 'Pause visibility requires an operator role session.' : pauseEvidence?.status === 'observed' ? 'Program, asset, and maker pause states were read from validated governance and registry accounts.' : pauseEvidence?.reason ?? 'Pause state is not observed.'} status={!token ? 'Gated' : pauseEvidence?.status ?? 'Unavailable'} />
        </>}
      </section>
      {token ? <div className="operations-actions">{maker ? <button className="secondary-button" type="button" disabled={busy || !makerStatus?.enabled} onClick={() => void command('/v1/makers/me/disable')}>Disable my maker source</button> : <><button className="secondary-button" type="button" disabled={busy || data?.sprints === 'stopped'} onClick={() => void command('/v1/operator/quote-sprints/stop')}>Stop new Quote Sprints</button>{sources.filter((source) => source.enabled).map((source) => <button className="secondary-button" type="button" disabled={busy} key={source.sourceId} onClick={() => void command(`/v1/operator/sources/${encodeURIComponent(source.sourceId!)}/disable`)}>Disable {source.sourceId}</button>)}</>}</div> : null}
      {maker && token ? <section className="operations-card maker-outcomes" aria-labelledby="maker-outcomes-title"><div className="card-kicker">PRIVATE RECEIPTS</div><h2 id="maker-outcomes-title">Fill details</h2>{receipts.length === 0 ? <p>No completed fills are recorded for this maker identity.</p> : <div className="maker-receipt-list">{receipts.map((receipt) => <details className="maker-receipt" key={receipt.tradeId}><summary><span>{formatTimestamp(receipt.confirmedAtMs)}</span><strong>{formatAmount(receipt.inputAmountAtomic, 6)} stock → {formatAmount(receipt.netOutputAtomic, 6)} {stableSymbol(receipt.outputMint)}</strong><span className="audit-good">{receipt.commitment}</span></summary><dl><div><dt>Quote ID</dt><dd>{receipt.quoteId}</dd></div><div><dt>Gross output</dt><dd>{formatAmount(receipt.grossOutputAtomic, 6)} {stableSymbol(receipt.outputMint)}</dd></div><div><dt>Venue fee</dt><dd>{formatAmount(receipt.venueFeeAtomic, 6)} {stableSymbol(receipt.outputMint)}</dd></div><div><dt>Signature</dt><dd className="signature">{receipt.signature}</dd></div><div><dt>Confirmed</dt><dd>{formatTimestamp(receipt.confirmedAtMs)}</dd></div>{receipt.finalizedAtMs ? <div><dt>Finalized</dt><dd>{formatTimestamp(receipt.finalizedAtMs)}</dd></div> : null}</dl></details>)}</div>}</section> : null}
      {!maker && <p className="ticket-footnote">Ondo and Liquidation Execution are disabled. Governance queue and pause data are read only. The browser has no governance write action.</p>}
    </main>
  </div>;
}

interface EvidenceObservation {
  readonly status?: string;
  readonly reason?: string;
  readonly value?: Record<string, unknown>;
}

function describeEvidence(observation: EvidenceObservation | undefined, fields: readonly (readonly [string, string])[]): string {
  if (!observation || observation.status !== 'observed') return observation?.reason ?? 'No observation returned';
  const details = fields.flatMap(([key, label]) => {
    const value = observation.value?.[key];
    return typeof value === 'string' || typeof value === 'number' ? [`${label} ${value}`] : [];
  });
  return details.length > 0 ? `Observed · ${details.join(' · ')}` : 'Observed';
}

function OperationsCard({ kicker, title, value, detail, status }: { readonly kicker: string; readonly title: string; readonly value: string; readonly detail: ReactNode; readonly status: string }): ReactElement {
  return <article className="operations-card"><div className="card-kicker">{kicker}</div><div className="operations-card-head"><h2>{title}</h2><span className="operations-status">{status}</span></div><strong className="operations-value">{value}</strong><div className="operations-card-detail">{detail}</div></article>;
}

function ReviewPanel({ sprint, settlement, outputDecimals, onOpenAudit, onSign, onClose }: { readonly sprint: QuoteSprint; readonly settlement: LocalnetSettlementSummary; readonly outputDecimals: number; readonly onOpenAudit: () => void; readonly onSign: () => void; readonly onClose: () => void }): ReactElement {
  const winner = sprint.winner!;
  const stable = stableSymbol(settlement.stableMint);
  const feeLabel = `${formatAmount(settlement.feeAtomic, outputDecimals)} ${stable} · ${settlement.feeBps} bps`;
  return <div className="modal-scrim"><section className="review-panel" role="dialog" aria-modal="true" aria-labelledby="review-title">
    <div className="review-head"><div><div className="card-kicker">ISSUED RFQ TRANSACTION · {EXPECTED_CHAIN}</div><h2 id="review-title">Review stock settlement</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="Close review">×</button></div>
    <div className="proof-warning" role="note"><strong>Local test assets</strong><span>This signed transaction settles the displayed local test stock and stablecoin. They have no issuer backing and are not Devnet or Mainnet assets.</span></div>
    <h3 className="review-section-title">Exact transaction economics</h3>
    <div className="review-amounts"><div><span>Seller stock debit</span><strong>{formatAmount(settlement.stockDebitAtomic, 6)} stock</strong><small>{settlement.stockMint}</small></div><div className="arrow" aria-hidden="true">→</div><div><span>Net stablecoin minimum</span><strong>{formatAmount(settlement.netStableMinimumAtomic, outputDecimals)} {stable}</strong><small>{settlement.stableMint}</small></div></div>
    <div className="review-grid"><div><span>Fee withheld</span><strong>{feeLabel}</strong></div><div><span>Gross stablecoin transfer</span><strong>{formatAmount(settlement.grossStableAtomic, outputDecimals)} {stable}</strong></div><div><span>Fee payer</span><strong className="signature">{settlement.feePayer}</strong></div><div><span>Cluster</span><strong>{EXPECTED_CHAIN}</strong></div><div><span>Private Maker signer</span><strong className="signature">{settlement.maker}</strong></div><div><span>RFQ program</span><strong className="signature">{settlement.programId}</strong></div><div><span>Source account</span><strong className="signature">{settlement.sellerStockAccount}</strong></div><div><span>Stablecoin destination</span><strong className="signature">{settlement.sellerStableAccount}</strong></div><div><span>Quote ID</span><strong className="signature">{settlement.quoteId}</strong></div><div><span>Expiry</span><strong>{new Date(settlement.expiresAtSeconds * 1_000).toLocaleString()}</strong></div></div>
    <h3 className="review-section-title">Executable instructions</h3><ol className="instruction-list">{settlement.executableInstructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
    <p className="review-note">RPC simulation passed for these issued bytes. The API rechecks live policy and balances, verifies both signatures and the unchanged message, then submits once.</p>
    <div className="review-grid"><div><span>Issued message hash</span><strong className="signature">{winner.transactionHash ?? 'Missing hash'}</strong></div><div><span>Required signatures</span><strong>{settlement.signerCount} · Seller + Maker</strong></div><div><span>Token program · stock</span><strong className="signature">{settlement.stockTokenProgram}</strong></div><div><span>Token program · stablecoin</span><strong className="signature">{settlement.stableTokenProgram}</strong></div></div>
    <div className="expiry-bar"><span>Settlement quote expires {formatTimestamp(winner.expiresAtMs)}</span><span>Full fill · exact input</span></div>
    <div className="review-actions"><button type="button" className="text-button" onClick={onOpenAudit}>View source audit</button><button type="button" className="primary-button" onClick={onSign}>Approve and sign settlement <span>↗</span></button></div>
  </section></div>;
}

function AuditDrawer({ sprint, onClose, outputDecimals }: { readonly sprint: QuoteSprint; readonly onClose: () => void; readonly outputDecimals: number }): ReactElement {
  return <div className="modal-scrim"><section className="audit-drawer" role="dialog" aria-modal="true" aria-labelledby="audit-title"><div className="review-head"><div><div className="card-kicker">EXECUTION AUDIT</div><h2 id="audit-title">Source comparison</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="Close audit">×</button></div><p className="drawer-intro">Losing payloads and inventory stay private. This comparison records only source class, net amount, timestamp, and structured outcome.</p><div className="audit-table" role="table"><div className="audit-row audit-header" role="row"><span>Source class</span><span>Net received</span><span>At</span><span>Outcome</span></div>{sprint.audit.map((row, index) => <div className="audit-row" role="row" key={`${row.sourceClass}-${index}`}><span>{row.sourceClass === 'jupiter' ? 'Jupiter' : 'Private maker'}</span><span>{row.netOutputAtomic ? `${formatAmount(row.netOutputAtomic, outputDecimals)} ${sprint.request.outputMint === SOLANA_USDT_MINT ? 'USDT' : 'USDC'}` : '—'}</span><span>{formatTimestamp(row.receivedAtMs)}</span><span className={row.status === 'executable' ? 'audit-good' : 'audit-bad'}>{row.status === 'executable' ? 'Executable' : row.rejectionCode?.replaceAll('_', ' ')}</span></div>)}</div><button type="button" className="secondary-button full-button" onClick={onClose}>Back to review</button></section></div>;
}

function ReceiptPanel({ trade, outputDecimals, onClose }: { readonly trade: TradeReceipt; readonly outputDecimals: number; readonly onClose: () => void }): ReactElement {
  const link = explorerTxUrl(trade.signature);
  const stable = stableSymbol(trade.outputMint);
  return <div className="modal-scrim"><section className="receipt-panel" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
    <div className="receipt-mark">✓</div><div className="card-kicker">RPC-CONFIRMED LOCALNET FILL</div><h2 id="receipt-title">Stock settlement complete</h2>
    <p className="receipt-lede">The Seller’s stock debit, Maker inventory, stablecoin payment, and fee were verified against confirmed localnet token-account state.</p>
    <div className="review-amounts"><div><span>Stock debited</span><strong>{formatAmount(trade.inputAmountAtomic, 6)} stock</strong><small>{trade.stockMint}</small></div><div className="arrow" aria-hidden="true">→</div><div><span>Stablecoin received</span><strong>{formatAmount(trade.sellerStableDeltaAtomic, outputDecimals)} {stable}</strong><small>{trade.stableMint}</small></div></div>
    <div className="receipt-grid"><div><span>Cluster · commitment · slot</span><strong>{trade.cluster} · {trade.commitment} · {trade.slot}</strong></div><div><span>Fee withheld</span><strong>{formatAmount(trade.feeStableDeltaAtomic, outputDecimals)} {stable} · {trade.katonFeeBps ?? 10} bps</strong></div><div><span>Seller stock delta</span><strong>{formatDelta(trade.sellerStockDeltaAtomic, 6)}</strong></div><div><span>Maker stock delta</span><strong>{formatDelta(trade.makerStockDeltaAtomic, 6)}</strong></div><div><span>Maker stablecoin delta</span><strong>{formatDelta(trade.makerStableDeltaAtomic, outputDecimals)}</strong></div><div><span>Seller stablecoin delta</span><strong>{formatDelta(trade.sellerStableDeltaAtomic, outputDecimals)}</strong></div><div><span>Fee account delta</span><strong>{formatDelta(trade.feeStableDeltaAtomic, outputDecimals)}</strong></div><div><span>Stock Token program</span><strong className="signature">{trade.stockTokenProgram}</strong></div><div><span>Stablecoin Token program</span><strong className="signature">{trade.stableTokenProgram}</strong></div><div><span>Fill receipt identity</span><strong className="signature">{trade.fillReceipt}</strong></div><div><span>Quote ID</span><strong className="signature">{trade.quoteId}</strong></div><div><span>Settlement signature</span><strong className="signature">{trade.signature}</strong></div></div>
    {link ? <a className="solscan-link" href={link} target="_blank" rel="noreferrer">View on Solana Explorer ↗</a> : <span className="mock-signature-note">Localnet transaction and token deltas were checked through RPC.</span>}
    <button className="secondary-button full-button" type="button" onClick={onClose}>Done</button>
  </section></div>;
}
