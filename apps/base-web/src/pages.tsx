import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { formatUnitsExact, parseUnitsExact, USDC_DECIMALS } from '../../../packages/base-core/src/index';
import type { Address } from 'viem';
import {
  BaseApiError,
  buildRfqFundingOrder,
  signFundingBid,
  signInWithWallet,
  type BaseBrowserApi,
  type FacilityDashboardDto,
  type OracleDashboardDto,
  type PublicLiquidationDto,
  type RouteDto,
  type StockSaleQuoteDto,
  type StockSaleRouteDto,
} from './api';
import { liquidationAvailability, type BaseRuntimeConfig } from './runtime';
import {
  allocateAdapter,
  approveAndDeposit,
  claimQueuedWithdraw,
  deallocateAdapter,
  requestQueuedWithdraw,
  setAdapterAllowed,
  setHaircut,
  setQuotePaused,
  submitWinnerRoute,
  approveStockSale,
  submitStockSaleRoute,
  withdraw,
} from './transactions';
import type { BaseWallet, BaseWalletState } from './wallet';

export interface PageProps {
  readonly config: BaseRuntimeConfig;
  readonly api: BaseBrowserApi;
  readonly wallet: BaseWallet | null;
  readonly walletState: BaseWalletState;
  readonly connectWallet: () => Promise<void>;
  readonly switchNetwork: () => Promise<void>;
}

export function HomePage({ config, api }: PageProps): ReactElement {
  const [facilities, setFacilities] = useState<readonly FacilityDashboardDto[]>([]);
  const [liquidations, setLiquidations] = useState<readonly PublicLiquidationDto[]>([]);
  const [oracle, setOracle] = useState<OracleDashboardDto | null>(null);
  const [oracleError, setOracleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const oracleAsset = Object.keys(config.b20Assets)[0] as Address | undefined;
  const liquidation = liquidationAvailability(config);
  useEffect(() => {
    let mounted = true;
    void Promise.all([
      api.getFacilities(),
      liquidation.enabled ? api.getLiquidations() : Promise.resolve<readonly PublicLiquidationDto[]>([]),
    ]).then(([nextFacilities, nextLiquidations]) => {
      if (!mounted) return;
      setFacilities(nextFacilities);
      setLiquidations(nextLiquidations);
      setError(null);
    }).catch((reason: unknown) => {
      if (mounted) setError(errorCode(reason));
    });
    if (oracleAsset) {
      void api.getOracle(oracleAsset).then((value) => {
        if (!mounted) return;
        setOracle(value);
        setOracleError(null);
      }).catch((reason: unknown) => {
        if (mounted) setOracleError(errorCode(reason));
      });
    } else {
      setOracle(null);
      setOracleError('ORACLE_UNAVAILABLE');
    }
    return () => { mounted = false; };
  }, [api, liquidation.enabled, oracleAsset]);
  return (
    <div className="content">
      <PageHeading eyebrow="BASE TOKENIZED-STOCK DESK" title="Sell B20 stock at the best executable price." description="Eligible retail holders can open a private one-second auction for native USDC. Facilities and institutional makers compete atomically; venue-native alternatives stay inspectable." config={config} />
      {error ? <UnavailableNotice reason={error} /> : null}
      <div className="grid grid--two">
        <section className="panel panel--hero" aria-labelledby="facility-overview-heading">
          <PanelHeader eyebrow="B20 SELL DESK" title="Open a private auction" />
          <p className="body-copy">Choose an eligible Coinbase B20 token, set a minimum USDC output, and review the signed route before the wallet submits it.</p>
          <a className="button button--primary button--full" href="/sell">Sell stock for USDC</a>
          <div className="subsection"><PanelHeader eyebrow="FACILITY" title="Operational capacity" />
          {facilities.length === 0 && !error ? <p className="empty-copy">No configured facilities are available yet.</p> : null}
          {facilities.map((facility) => <FacilitySummary key={facility.address} facility={facility} />)}
          <a className="button button--secondary button--full" href="/facility">Open depositor facility</a></div>
        </section>
        <section className="panel" aria-labelledby="oracle-overview-heading">
          <PanelHeader eyebrow="ORACLE / OPERATING RULES" title="Read before funding" />
          <div className="metric-list">
            <Metric label="Network" value={config.networkName} />
            <Metric label="USDC precision" value={`${USDC_DECIMALS} decimals · exact integer boundary`} />
            <Metric label="Deployment" value={config.status === 'ready' ? 'Configured' : 'Unavailable'} />
            <Metric label="Public route data" value="Winner-only" />
            {oracle ? <><Metric label="B20 ticker / feed" value={`${oracle.ticker} · ${short(oracle.feed)}`} /><Metric label="Oracle answer age" value={`${oracle.answerAge}s · ${oracle.fresh ? 'fresh' : 'stale'}`} /><Metric label="Multiplier (WAD)" value={`${formatWad(oracle.multiplierWad)}× · 18 decimals`} /></> : <Metric label="Oracle state" value={oracleError ?? 'Loading'} />}
          </div>
          <p className="body-copy">Capacity is the current post-haircut operational funding-capacity ceiling reported by <code>quoteUsdcCapacity</code>. It is not a new configurable cap.</p>
          <a className="button button--secondary button--full" href="/curator">Review curator controls</a>
        </section>
      </div>
      <section className="panel" aria-labelledby="rfq-overview-heading">
        <PanelHeader eyebrow="LIQUIDATION DESK" title="Later route" action={<a className="text-link" href="/liquidations">View status</a>} />
        {!liquidation.enabled ? <LiquidationUnavailableNotice reason={liquidation.reason} /> : <PublicRfqTable liquidations={liquidations.slice(0, 5)} config={config} />}
      </section>
    </div>
  );
}

export function SellPage({ config, api, wallet, walletState, connectWallet, switchNetwork }: PageProps): ReactElement {
  const stockToken = Object.keys(config.b20Assets)[0] as Address | undefined;
  const stock = stockToken ? config.b20Assets[stockToken.toLowerCase()] : undefined;
  const [sellAmount, setSellAmount] = useState('');
  const [minBuyAmount, setMinBuyAmount] = useState('');
  const [quote, setQuote] = useState<StockSaleQuoteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stockDecimals = stock?.decimals ?? 0;
  const parsedSellAmount = exactAmount(sellAmount, stockDecimals);
  const parsedMinBuyAmount = exactAmount(minBuyAmount, USDC_DECIMALS);
  const canQuote = Boolean(
    config.writesEnabled
      && stockToken
      && wallet
      && walletState.status === 'connected'
      && parsedSellAmount !== null
      && parsedSellAmount > 0n
      && parsedMinBuyAmount !== null
      && parsedMinBuyAmount > 0n,
  );
  const recommended = quote?.recommended;
  const canExecute = Boolean(
    canQuote
      && recommended?.kind === 'INTERNAL'
      && recommended.transaction
      && quote
      && BigInt(quote.sellAmount) === parsedSellAmount,
  );

  async function authenticate(): Promise<void> {
    if (!wallet) throw new Error('WALLET_NOT_CONNECTED');
    const existing = api.getSession();
    if (!existing || existing.address.toLowerCase() !== walletState.address?.toLowerCase()) await signInWithWallet(api, wallet);
  }

  async function requestQuote(): Promise<void> {
    if (!wallet || !stockToken || parsedSellAmount === null || parsedMinBuyAmount === null || parsedSellAmount === 0n || parsedMinBuyAmount === 0n) {
      setError('ENTER_EXACT_STOCK_AND_MINIMUM');
      return;
    }
    setBusy(true); setError(null); setFeedback(null); setQuote(null);
    try {
      const taker = wallet.assertWritable();
      const approval = await approveStockSale(wallet, config, stockToken, parsedSellAmount);
      setFeedback(approval ? 'Exact stock allowance confirmed. Collecting private quotes…' : 'Exact stock allowance already set. Collecting private quotes…');
      await authenticate();
      const next = await api.quoteStockSale({
        stockToken,
        usdcToken: config.usdc,
        sellAmount: parsedSellAmount,
        minBuyAmount: parsedMinBuyAmount,
        taker,
        recipient: taker,
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 30),
      });
      setQuote(next);
      setFeedback(next.status === 'WINNER' ? 'Private one-second auction complete. Review the route before signing.' : 'No executable route met the minimum output.');
    } catch (reason) {
      setError(errorCode(reason));
    } finally {
      setBusy(false);
    }
  }

  async function executeQuote(): Promise<void> {
    if (!wallet || !quote?.recommended || quote.recommended.kind !== 'INTERNAL' || !quote.recommended.transaction || !stockToken) return;
    setBusy(true); setError(null); setFeedback(null);
    try {
      await submitStockSaleRoute(wallet, config, { route: quote.recommended, stockToken, stockAmount: BigInt(quote.sellAmount) });
      setFeedback('Stock sale confirmed. USDC was delivered to the connected wallet.');
    } catch (reason) {
      const code = errorCode(reason);
      if (code === 'SWAP_QUOTE_STALE' || code === 'PREFLIGHT_BLOCK_STALE') {
        setQuote(null);
        setError('SWAP_QUOTE_STALE_REQUOTE');
      } else setError(code);
    } finally {
      setBusy(false);
    }
  }

  if (!stockToken || !stock) {
    return <div className="content"><PageHeading eyebrow="B20 RETAIL EXIT" title="Sell stock for native USDC." description="A configured Coinbase B20 asset is required before a seller-private auction can open." config={config} /><UnavailableNotice reason="B20_METADATA_UNAVAILABLE" /></div>;
  }

  return (
    <div className="content">
      <PageHeading eyebrow="B20 RETAIL EXIT" title="Sell stock for native USDC." description="Katon opens a private 1-second best-price auction, blends approved makers and facilities atomically, and keeps venue-native alternatives separate." config={config} />
      {error ? <InlineError message={error} /> : null}
      {feedback ? <InlineSuccess message={feedback} /> : null}
      <div className="grid grid--two">
        <section className="panel" aria-labelledby="sell-ticket-heading">
          <PanelHeader eyebrow="SELL TICKET" title="Choose exact amounts" />
          <label htmlFor="sell-stock-amount">Stock amount <span className="field-hint">{stock.ticker} · {stock.decimals} decimals</span>
            <input id="sell-stock-amount" value={sellAmount} onChange={(event) => { setSellAmount(event.target.value); setQuote(null); }} inputMode="decimal" placeholder="0.000000" />
          </label>
          {sellAmount && parsedSellAmount === null ? <p className="field-error">Enter an exact {stock.ticker} amount.</p> : null}
          <label className="field-spaced" htmlFor="sell-min-buy">Minimum USDC received <span className="field-hint">native USDC · {USDC_DECIMALS} decimals</span>
            <input id="sell-min-buy" value={minBuyAmount} onChange={(event) => { setMinBuyAmount(event.target.value); setQuote(null); }} inputMode="decimal" placeholder="0.01" />
          </label>
          {minBuyAmount && parsedMinBuyAmount === null ? <p className="field-error">Enter an exact USDC minimum.</p> : null}
          <p className="field-hint field-spaced">The minimum is bound into the atomic route. Quotes expire at their signed expiry and late auction responses are excluded.</p>
          <ActionButton testId="sell-quote" disabled={!canQuote || busy} onClick={requestQuote}>{busy ? 'Collecting quotes…' : 'Collect best price'}</ActionButton>
          {!wallet ? <WalletHint onConnect={connectWallet} /> : walletState.status === 'wrong-chain' ? <WrongChainHint expected={walletState.expectedChainId} onSwitch={switchNetwork} /> : null}
        </section>
        <section className="panel" aria-labelledby="sell-review-heading">
          <PanelHeader eyebrow="PRIVATE ROUTE REVIEW" title="Execution summary" />
          {!quote ? <p className="empty-copy">Connect the wallet and request a quote to see the recommended source, guaranteed output, gas estimate, expiry, and allowance target.</p> : quote.status === 'NO_ROUTE' ? <div className="state-card state-card--unavailable"><StatusTag tone="amber">No executable route</StatusTag><p>{quote.reason ?? 'NO_ELIGIBLE_QUOTE'}</p></div> : recommended ? <StockSaleRouteReview route={recommended} quote={quote} config={config} canExecute={Boolean(canExecute && !busy)} onExecute={executeQuote} /> : <p className="empty-copy">The auction returned no recommended route.</p>}
        </section>
      </div>
      {quote && quote.status === 'WINNER' ? <section className="panel" aria-labelledby="alternatives-heading"><PanelHeader eyebrow="COMPETING SOURCES" title="Alternatives" /><div className="grid grid--two"><div><p className="eyebrow">INTERNAL</p>{quote.alternatives.length === 0 ? <p className="empty-copy">No losing internal route is disclosed.</p> : quote.alternatives.map((route) => <StockSaleAlternative key={route.routeId} route={route} config={config} />)}</div><div><p className="eyebrow">VENUE-NATIVE</p>{quote.external.length === 0 ? <p className="empty-copy">No provider packet met the minimum.</p> : quote.external.map((route) => <StockSaleAlternative key={route.routeId} route={route} config={config} external />)}</div></div></section> : null}
    </div>
  );
}

 function StockSaleRouteReview({ route, quote, config, canExecute, onExecute }: { readonly route: StockSaleRouteDto; readonly quote: StockSaleQuoteDto; readonly config: BaseRuntimeConfig; readonly canExecute: boolean; readonly onExecute: () => Promise<void> }): ReactElement {
   const stockAllowanceTarget = route.settlementAllowanceTarget ?? route.allowanceTarget ?? route.transaction?.allowanceTarget ?? config.deployment.router ?? '';
   return <div className="quote-review" data-testid="stock-sale-review"><p className="eyebrow">RECOMMENDED · {route.source}</p><Metric label="Guaranteed USDC" value={formatUsdc(route.guaranteedUsdc)} /><Metric label="Effective output" value={formatUsdc(route.effectiveUsdc)} /><Metric label="Protocol fee" value={formatUsdc(route.fee)} /><Metric label="Conservative gas" value={formatUsdc(route.gasEstimateUsdc)} /><Metric label="Expiry" value={route.expiry} /><Metric label="Auction cutoff" value={new Date(quote.auctionCutoffAtMs).toLocaleTimeString()} /><Metric label="Decision block" value={route.decisionBlock ?? quote.decisionBlock ?? 'unavailable'} /><Metric label="Simulation block" value={quote.simulationBlock} /><Metric label="Settlement allowance target" value={short(stockAllowanceTarget)} />{route.legs ? <Metric label="Atomic legs" value={String(route.legs.length)} /> : null}<ActionButton testId="sell-submit" disabled={!canExecute} onClick={onExecute}>Submit reviewed route</ActionButton>{route.kind === 'EXTERNAL' ? <p className="helper">This provider packet is venue-native and cannot be blended with Katon legs.</p> : null}</div>;
}

 function StockSaleAlternative({ route, config, external = false }: { readonly route: StockSaleRouteDto; readonly config: BaseRuntimeConfig; readonly external?: boolean }): ReactElement {
   const stockAllowanceTarget = route.settlementAllowanceTarget ?? route.allowanceTarget ?? config.deployment.router ?? '';
   return <div className="state-card"><div className="summary-title"><strong>{route.source}</strong><StatusTag tone={external ? 'blue' : 'gray'}>{external ? 'Provider packet' : 'Internal'}</StatusTag></div><Metric label="Guaranteed USDC" value={formatUsdc(route.guaranteedUsdc)} /><Metric label="Effective output" value={formatUsdc(route.effectiveUsdc)} /><Metric label="Gas estimate" value={formatUsdc(route.gasEstimateUsdc)} /><Metric label="Expiry" value={route.expiry} /><p className="helper">{external ? `Target ${short(route.transaction?.to ?? '')}` : `${route.legs?.length ?? 0} atomic leg${route.legs?.length === 1 ? '' : 's'} · settlement allowance ${short(stockAllowanceTarget)}`}</p></div>;
}

export function FacilityPage({ config, api, wallet, walletState, connectWallet, switchNetwork }: PageProps): ReactElement {
  const [facility, setFacility] = useState<FacilityDashboardDto | null>(null);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const facilityAddress = config.deployment.facility;
  const parsedAmount = exactAmount(amount, USDC_DECIMALS);
  const canWrite = Boolean(config.writesEnabled && wallet && walletState.status === 'connected' && !facility?.paused);

  const refresh = (): void => {
    if (!facilityAddress) return;
    void api.getFacility(facilityAddress).then(setFacility).catch((reason: unknown) => setError(errorCode(reason)));
  };
  useEffect(() => { refresh(); }, [api, facilityAddress]);

  async function run(action: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      await action();
      setFeedback(success);
      refresh();
    } catch (reason) {
      setError(errorCode(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!facilityAddress || !facility || error === 'DASHBOARD_UNAVAILABLE' || error === 'FACILITY_UNAVAILABLE') {
    return <div className="content"><PageHeading eyebrow="DEPOSITOR FACILITY" title="Facility" description="USDC deposits and FIFO withdrawal recovery." config={config} />{error ? <UnavailableNotice reason={error} /> : <UnavailableNotice reason={config.reason ?? 'DASHBOARD_UNAVAILABLE'} />}</div>;
  }
  const queued = facility.queue.requests;
  const firstQueued = queued.find((request) => request.status === 'queued');
  return (
    <div className="content">
      <PageHeading eyebrow="DEPOSITOR FACILITY" title="Fund the facility precisely." description="Every amount is parsed into a bigint before it reaches a contract call. Approval is limited to the exact USDC deposit or settlement repayment." config={config} />
      {error ? <InlineError message={error} /> : null}
      {feedback ? <InlineSuccess message={feedback} /> : null}
      <div className="grid grid--two">
        <section className="panel" aria-labelledby="deposit-heading">
          <PanelHeader eyebrow="DEPOSIT / WITHDRAW" title="USDC position" />
          <label htmlFor="deposit-amount">Amount <span className="field-hint">USDC · 6 decimals</span>
            <input id="deposit-amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" aria-describedby="amount-help" />
          </label>
          <p id="amount-help" className="field-hint field-spaced">Use a plain decimal or three-digit grouping. Exponents, negatives, and excess precision are rejected.</p>
          {amount && parsedAmount === null ? <p className="field-error">Enter an exact USDC amount.</p> : null}
          <ActionButton testId="deposit-submit" disabled={!canWrite || busy || parsedAmount === null || parsedAmount === 0n} onClick={() => run(() => approveAndDeposit(wallet as BaseWallet, config, parsedAmount as bigint), 'Exact approval and deposit confirmed.')}>Approve exact amount + deposit</ActionButton>
          <div className="button-row">
            <ActionButton testId="withdraw-submit" variant="secondary" disabled={!canWrite || busy || parsedAmount === null || parsedAmount === 0n} onClick={() => run(() => withdraw(wallet as BaseWallet, config, parsedAmount as bigint), 'Synchronous withdrawal confirmed.')}>Withdraw now</ActionButton>
            <ActionButton variant="secondary" disabled={!canWrite || busy || parsedAmount === null || parsedAmount === 0n} onClick={() => run(() => requestQueuedWithdraw(wallet as BaseWallet, config, parsedAmount as bigint), 'Withdrawal queued. FIFO status will persist after reload.')}>Queue withdrawal</ActionButton>
          </div>
          {!wallet ? <WalletHint onConnect={connectWallet} /> : walletState.status === 'wrong-chain' ? <WrongChainHint expected={walletState.expectedChainId} onSwitch={switchNetwork} /> : null}
        </section>
        <section className="panel" aria-labelledby="facility-read-heading">
          <PanelHeader eyebrow="PINNED READ" title="Facility state" />
          <Metric label="Net asset value" value={formatUsdc(facility.nav)} />
          <Metric label="Idle USDC" value={formatUsdc(facility.idleAssets)} />
          <Metric label="Shares" value={formatUsdc(facility.shares)} />
          <Metric label="Haircut" value={`${formatWad(facility.haircutWad)}×`} />
          <Metric label="Post-haircut capacity" value={formatUsdc(facility.quoteUsdcCapacity)} />
          <Metric label="Pinned block" value={facility.pinnedBlock} />
          <div className="status-card-row"><StatusTag tone={facility.paused ? 'red' : 'green'}>{facility.paused ? 'Facility paused' : 'Facility live'}</StatusTag><StatusTag tone={facility.quotePaused ? 'amber' : 'blue'}>{facility.quotePaused ? 'Quotes paused' : 'Quotes live'}</StatusTag></div>
        </section>
      </div>
      <section className="panel" aria-labelledby="queue-heading">
        <PanelHeader eyebrow="FIFO RECOVERY" title="Withdrawal queue" />
        <div className="metric-list"><Metric label="Queued assets" value={formatUsdc(facility.queue.totalAssets)} /><Metric label="Queued requests" value={String(queued.length)} /></div>
        {queued.length === 0 ? <p className="empty-copy">No queued requests in the indexed projection.</p> : <div className="table-wrap"><table><thead><tr><th>Request</th><th>Assets</th><th>Shares</th><th>Status</th><th>Action</th></tr></thead><tbody>{queued.map((request) => {
          const mine = walletState.address?.toLowerCase() === request.owner.toLowerCase();
          const fifo = firstQueued?.requestId === request.requestId;
          return <tr key={request.requestId}><td className="mono">#{request.requestId}</td><td className="mono">{formatUsdc(request.assets)}</td><td className="mono">{formatUsdc(request.shares)}</td><td><StatusTag tone={request.status === 'claimed' ? 'green' : 'amber'}>{request.status}{request.status === 'queued' && !fifo ? ' · FIFO pending' : ''}</StatusTag></td><td>{request.status === 'queued' && mine ? <ActionButton variant="secondary" disabled={!canWrite || busy || !fifo} onClick={() => run(() => claimQueuedWithdraw(wallet as BaseWallet, config, BigInt(request.requestId)), `Request #${request.requestId} claimed.`)}>Claim</ActionButton> : <span className="muted">{request.status === 'claimed' ? 'Complete' : 'Owner only'}</span>}</td></tr>;
        })}</tbody></table></div>}
      </section>
    </div>
  );
}

export function CuratorPage({ config, api, wallet, walletState, connectWallet, switchNetwork }: PageProps): ReactElement {
  const [facility, setFacility] = useState<FacilityDashboardDto | null>(null);
  const [adapter, setAdapter] = useState<Address | ''>(config.adapters[0] ?? '');
  const [amount, setAmount] = useState('');
  const [haircut, setHaircutValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const facilityAddress = config.deployment.facility;
  useEffect(() => {
    if (!facilityAddress) return;
    void api.getFacility(facilityAddress).then((value) => { setFacility(value); setHaircutValue(formatUnitsExact(BigInt(value.haircutWad), 18)); }).catch((reason: unknown) => setError(errorCode(reason)));
  }, [api, facilityAddress]);
  const isCurator = Boolean(walletState.address && facility?.roles.curator.toLowerCase() === walletState.address.toLowerCase());
  const canWrite = Boolean(config.writesEnabled && wallet && walletState.status === 'connected' && !facility?.paused && isCurator && adapter);
  const parsedAmount = exactAmount(amount, USDC_DECIMALS);
  const parsedHaircut = exactAmount(haircut, 18);
  async function run(action: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true); setError(null); setFeedback(null);
    try { await action(); setFeedback(success); if (facilityAddress) setFacility(await api.getFacility(facilityAddress)); } catch (reason) { setError(errorCode(reason)); } finally { setBusy(false); }
  }
  if (!facilityAddress || !facility) return <div className="content"><PageHeading eyebrow="CURATOR CONTROL" title="Curator" description="Adapter policy and facility allocation controls." config={config} /><UnavailableNotice reason={error ?? config.reason ?? 'DASHBOARD_UNAVAILABLE'} /></div>;
  return (
    <div className="content">
      <PageHeading eyebrow="CURATOR CONTROL" title="Allocate with explicit policy." description="Curator writes are wallet-signed and simulated before submission. Guardian and admin pause state remains read-only here." config={config} />
      {error ? <InlineError message={error} /> : null}{feedback ? <InlineSuccess message={feedback} /> : null}
      <div className="grid grid--two">
        <section className="panel" aria-labelledby="adapter-heading"><PanelHeader eyebrow="ADAPTER POLICY" title="Allowlist and allocation" />
          <label htmlFor="adapter-select">Adapter<select id="adapter-select" value={adapter} onChange={(event) => setAdapter(event.target.value as Address)}><option value="">No configured adapter</option>{config.adapters.map((candidate) => <option key={candidate} value={candidate}>{short(candidate)}</option>)}</select></label>
          <div className="button-row field-spaced"><ActionButton variant="secondary" disabled={!canWrite || busy} onClick={() => run(() => setAdapterAllowed(wallet as BaseWallet, config, adapter as Address, true), 'Adapter allowlisted.')}>Allowlist</ActionButton><ActionButton variant="secondary" disabled={!canWrite || busy} onClick={() => run(() => setAdapterAllowed(wallet as BaseWallet, config, adapter as Address, false), 'Adapter removed from allowlist.')}>Remove</ActionButton></div>
          <label className="field-spaced" htmlFor="allocation-amount">USDC allocation <span className="field-hint">6 decimals</span><input id="allocation-amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" /></label>
          <div className="button-row"><ActionButton variant="secondary" disabled={!canWrite || busy || parsedAmount === null || parsedAmount === 0n} onClick={() => run(() => allocateAdapter(wallet as BaseWallet, config, adapter as Address, parsedAmount as bigint), 'Adapter allocation confirmed.')}>Allocate</ActionButton><ActionButton variant="secondary" disabled={!canWrite || busy || parsedAmount === null || parsedAmount === 0n} onClick={() => run(() => deallocateAdapter(wallet as BaseWallet, config, adapter as Address, parsedAmount as bigint), 'Adapter deallocation confirmed.')}>Deallocate</ActionButton></div>
          {!isCurator && walletState.status === 'connected' ? <p className="field-hint field-spaced">Connected account is not the facility curator.</p> : null}
        </section>
        <section className="panel" aria-labelledby="haircut-heading"><PanelHeader eyebrow="CAPACITY POLICY" title="Haircut and quote state" />
          <label htmlFor="haircut-value">Haircut <span className="field-hint">WAD · 18 decimals</span><input id="haircut-value" value={haircut} onChange={(event) => setHaircutValue(event.target.value)} inputMode="decimal" placeholder="0.95" /></label>
          <p className="field-hint field-spaced">Current post-haircut capacity: <span className="mono">{formatUsdc(facility.quoteUsdcCapacity)}</span> USDC</p>
          <ActionButton disabled={!canWrite || busy || parsedHaircut === null || parsedHaircut > 1_000_000_000_000_000_000n} onClick={() => run(() => setHaircut(wallet as BaseWallet, config, parsedHaircut as bigint), 'Haircut updated.')}>Set haircut</ActionButton>
          <div className="review-row field-spaced"><span>Quote state</span><strong>{facility.quotePaused ? 'Paused' : 'Live'}</strong></div>
          <ActionButton variant="secondary" disabled={!canWrite || busy} onClick={() => run(() => setQuotePaused(wallet as BaseWallet, config, !facility.quotePaused), facility.quotePaused ? 'Quotes resumed.' : 'Quotes paused.')}>{facility.quotePaused ? 'Resume quotes' : 'Pause quotes'}</ActionButton>
          <div className="subsection"><p className="eyebrow">GUARDIAN / ADMIN</p><p className="body-copy">Global pause is <strong>{facility.paused ? 'active' : 'not active'}</strong>. This status is intentionally read-only; no global pause transaction is exposed by the curator desk.</p></div>
        </section>
      </div>
      {!wallet ? <WalletHint onConnect={connectWallet} /> : walletState.status === 'wrong-chain' ? <WrongChainHint expected={walletState.expectedChainId} onSwitch={switchNetwork} /> : null}
    </div>
  );
}

export function LiquidationsPage({ config, api, wallet, walletState, connectWallet, switchNetwork }: PageProps): ReactElement {
  const [liquidations, setLiquidations] = useState<readonly PublicLiquidationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [route, setRoute] = useState<RouteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = liquidations.find((item) => item.id === selectedId) ?? liquidations[0];
  const adapter = config.adapters[0];
  const previewOrder = useMemo(() => {
    if (!selected || !walletState.address || !adapter || !config.deployment.settlement) return null;
    try { return buildRfqFundingOrder({ rfq: selected, maker: walletState.address, adapter, settlement: config.deployment.settlement }); } catch { return null; }
  }, [selected, walletState.address, adapter, config.deployment.settlement]);
  const winnerConnected = Boolean(selected?.winner && walletState.address && selected.winner.identity.toLowerCase() === walletState.address.toLowerCase());
  const canWrite = Boolean(config.writesEnabled && wallet && walletState.status === 'connected');
  const liquidation = liquidationAvailability(config);
  const canLiquidate = canWrite && liquidation.enabled;

  useEffect(() => {
    let mounted = true;
    const refresh = (): void => {
      if (!liquidation.enabled) {
        setLiquidations([]);
        setError(null);
        return;
      }
      void api.getLiquidations().then((value) => { if (mounted) { setLiquidations(value); setError(null); } }).catch((reason: unknown) => { if (mounted) setError(errorCode(reason)); });
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => { mounted = false; clearInterval(timer); };
  }, [api, liquidation.enabled]);
  useEffect(() => { setRoute(null); }, [selectedId]);

  async function authenticate(): Promise<void> {
    if (!wallet) throw new Error('WALLET_NOT_CONNECTED');
    const existing = api.getSession();
    if (!existing || existing.address.toLowerCase() !== walletState.address?.toLowerCase()) await signInWithWallet(api, wallet);
  }
  async function signBid(): Promise<void> {
    if (!liquidation.enabled) throw new Error(liquidation.reason);
    if (!selected || !adapter || !config.deployment.settlement || !wallet) throw new Error('BID_UNAVAILABLE');
    setBusy(true); setError(null); setFeedback(null);
    try { await authenticate(); const signed = await signFundingBid(wallet, { rfq: selected, adapter, chainId: config.chainId, settlement: config.deployment.settlement }); await api.postBid(signed); setFeedback('Signed RFQ-bound bid submitted.'); } catch (reason) { setError(errorCode(reason)); } finally { setBusy(false); }
  }
  async function loadRoute(): Promise<void> {
    if (!liquidation.enabled) throw new Error(liquidation.reason);
    if (!selected || !wallet) return;
    setBusy(true); setError(null); setFeedback(null);
    try { await authenticate(); setRoute(await api.pollWinnerRoute(selected.id, { intervalMs: 1_000, maxAttempts: 5 })); setFeedback('Winner-only route is ready for review.'); } catch (reason) { setError(errorCode(reason)); } finally { setBusy(false); }
  }
  async function submitRoute(): Promise<void> {
    if (!liquidation.enabled) throw new Error(liquidation.reason);
    if (!wallet || !route) return;
    setBusy(true); setError(null); setFeedback(null);
    try { await submitWinnerRoute(wallet, config, { source: route.source, target: route.target, data: route.data, value: BigInt(route.value), repayAssets: BigInt(route.repayAssets) }); setFeedback('Route transaction confirmed.'); } catch (reason) { setError(errorCode(reason)); } finally { setBusy(false); }
  }

  return (
    <div className="content">
      <PageHeading eyebrow="LIQUIDATION DESK" title="Public RFQs, private execution." description="The table exposes pair, repay size, minimum output, deadline, status, bid count, and finalized winner identity/source. Signatures and losing prices never enter this view." config={config} />
      {!liquidation.enabled ? <LiquidationUnavailableNotice reason={liquidation.reason} /> : null}
      {error ? <InlineError message={error} /> : null}{feedback ? <InlineSuccess message={feedback} /> : null}
      <section className="panel" aria-labelledby="rfq-table-heading"><PanelHeader eyebrow="RFQ BOOK" title="Liquidation opportunities" /><PublicRfqTable liquidations={liquidations} config={config} onSelect={(item) => setSelectedId(item.id)} selectedId={selected?.id} /></section>
      {selected ? <section className="grid grid--two"><section className="panel" aria-labelledby="bid-heading"><PanelHeader eyebrow="ONE-OFF LP BID" title="Review and sign" />
        <div className="review-row"><span>Pair</span><strong>{pairLabel(selected, config)}</strong></div><div className="review-row"><span>Repay size</span><strong className="mono">{formatUsdc(selected.repayAssets)} USDC</strong></div><div className="review-row"><span>RFQ minimum</span><strong className="mono">{formatCollateral(selected.minCollateralOut, selected.collateralAsset, config)}</strong></div><div className="review-row"><span>Deadline</span><strong className="mono">{selected.deadline}</strong></div>
        {previewOrder ? <div className="quote-review" data-testid="bid-review"><p className="eyebrow">EIP-712 ORDER</p><Metric label="Venue" value={short(previewOrder.venue)} /><Metric label="Max repay" value={previewOrder.maxRepayAssets.toString(10)} /><Metric label="Expiry" value={previewOrder.expiry.toString(10)} /><Metric label="Fill mode" value="single RFQ" /></div> : <p className="empty-copy">Connect on Base Sepolia and configure an adapter to derive the order.</p>}
        <ActionButton testId="bid-sign" disabled={!canLiquidate || busy || !previewOrder || !adapter || !config.deployment.settlement || selected.status !== 'open'} onClick={signBid}>Sign and submit bid</ActionButton>
        {!wallet ? <WalletHint onConnect={connectWallet} /> : walletState.status === 'wrong-chain' ? <WrongChainHint expected={walletState.expectedChainId} onSwitch={switchNetwork} /> : null}
      </section><section className="panel" aria-labelledby="route-heading"><PanelHeader eyebrow="WINNER-ONLY ROUTE" title="Settlement review" />
        {selected.status !== 'finalized' ? <p className="empty-copy">A route appears only after this RFQ is finalized.</p> : !winnerConnected ? <p className="empty-copy">Connect the finalized winner account to request its unsigned route.</p> : <>
          <ActionButton variant="secondary" disabled={!canLiquidate || busy} onClick={loadRoute}>Refresh route availability</ActionButton>
          {route ? <RouteReview route={route} config={config} canSubmit={canLiquidate && !busy} onSubmit={submitRoute} /> : <p className="helper">The desk polls the authenticated route endpoint. No bearer token is placed in a WebSocket URL.</p>}
        </>}
      </section></section> : null}
    </div>
  );
}

function RouteReview({ route, config, canSubmit, onSubmit }: { readonly route: RouteDto; readonly config: BaseRuntimeConfig; readonly canSubmit: boolean; readonly onSubmit: () => Promise<void> }): ReactElement {
  return <div className="quote-review" data-testid="route-review"><p className="eyebrow">UNSIGNED ROUTE</p><Metric label="Pair" value={pairLabel({ debtAsset: route.debtAsset, collateralAsset: route.collateralAsset }, config)} /><Metric label="Size" value={`${formatUsdc(route.repayAssets)} USDC`} /><Metric label="RFQ minimum" value={formatCollateral(route.minCollateralOutRfq, route.collateralAsset, config)} /><Metric label="Funder minimum" value={formatCollateral(route.minCollateralOutFunder, route.collateralAsset, config)} /><Metric label="Deadline" value={route.deadline} /><Metric label="Winner / source" value={`${short(route.winner)} · ${route.source}`} /><Metric label="Target" value={short(route.target)} /><Metric label="Payload hash" value={short(route.payloadHash)} /><Metric label="Decision block" value={route.decisionBlock} /><ActionButton testId="route-submit" disabled={!canSubmit} onClick={onSubmit}>{route.source === 'LP' ? 'Approve exact USDC + submit' : 'Submit facility route'}</ActionButton></div>;
}

function PageHeading({ eyebrow, title, description, config }: { readonly eyebrow: string; readonly title: string; readonly description: string; readonly config: BaseRuntimeConfig }): ReactElement {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="lede">{description}</p></div><span className="network-pill"><span className={`status-dot ${config.status === 'ready' ? 'status-dot--green' : 'status-dot--amber'}`} />{config.networkName}</span></div>;
}

function PanelHeader({ eyebrow, title, action }: { readonly eyebrow: string; readonly title: string; readonly action?: ReactElement }): ReactElement {
  return <div className="panel__header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{action}</div>;
}

function FacilitySummary({ facility }: { readonly facility: FacilityDashboardDto }): ReactElement {
  return <div className="facility-summary"><div className="summary-title"><strong>{short(facility.address)}</strong><StatusTag tone={facility.paused ? 'red' : 'green'}>{facility.paused ? 'Paused' : 'Live'}</StatusTag></div><Metric label="Post-haircut capacity" value={`${formatUsdc(facility.quoteUsdcCapacity)} USDC`} /><Metric label="Idle assets" value={`${formatUsdc(facility.idleAssets)} USDC`} /><Metric label="Haircut" value={`${formatWad(facility.haircutWad)}×`} /></div>;
}

function PublicRfqTable({ liquidations, config, onSelect, selectedId }: { readonly liquidations: readonly PublicLiquidationDto[]; readonly config: BaseRuntimeConfig; readonly onSelect?: (item: PublicLiquidationDto) => void; readonly selectedId?: string }): ReactElement {
  if (liquidations.length === 0) return <p className="empty-copy">No public RFQs are available.</p>;
  return <div className="table-wrap"><table><thead><tr><th>Pair</th><th>Repay size</th><th>Min out</th><th>Deadline</th><th>Status</th><th>Bids</th><th>Winner</th></tr></thead><tbody>{liquidations.map((item) => {
    const select = (): void => onSelect?.(item);
    return <tr key={item.id} className={item.id === selectedId ? 'row-selected' : ''} tabIndex={onSelect ? 0 : undefined} aria-selected={onSelect ? item.id === selectedId : undefined} onClick={select} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } }}><td>{pairLabel(item, config)}</td><td className="mono">{formatUsdc(item.repayAssets)}</td><td className="mono">{formatCollateral(item.minCollateralOut, item.collateralAsset, config)}</td><td className="mono">{item.deadline}</td><td><StatusTag tone={item.status === 'open' ? 'blue' : item.status === 'finalized' ? 'green' : item.status === 'expired' ? 'gray' : 'red'}>{item.status}</StatusTag></td><td className="mono">{item.bidCount ?? 0}</td><td>{item.winner ? <span className="winner-cell">{short(item.winner.identity)} · {item.winner.source}</span> : <span className="muted">—</span>}</td></tr>;
  })}</tbody></table></div>;
}

function Metric({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function ActionButton({ children, onClick, disabled, variant = 'primary', testId }: { readonly children: string; readonly onClick: () => void | Promise<void>; readonly disabled?: boolean; readonly variant?: 'primary' | 'secondary'; readonly testId?: string }): ReactElement {
  return <button className={`button button--${variant}`} type="button" disabled={disabled} data-testid={testId} onClick={() => { void onClick(); }}>{children}</button>;
}

function WalletHint({ onConnect }: { readonly onConnect: () => Promise<void> }): ReactElement {
  return <div className="state-card"><StatusTag tone="amber">Wallet required</StatusTag><p>Connect the browser wallet to sign a Base transaction.</p><ActionButton variant="secondary" onClick={onConnect}>Connect wallet</ActionButton></div>;
}

function WrongChainHint({ expected, onSwitch }: { readonly expected: number; readonly onSwitch: () => Promise<void> }): ReactElement {
  return <div className="state-card" data-testid="wrong-chain"><StatusTag tone="red">Wrong chain</StatusTag><p>Signatures and transactions are blocked until the wallet is on chain {expected}.</p><ActionButton variant="secondary" onClick={onSwitch}>Switch to Base</ActionButton></div>;
}

function UnavailableNotice({ reason }: { readonly reason: string }): ReactElement {
  return <div className="state-card state-card--unavailable" data-testid="dashboard-unavailable"><StatusTag tone="amber">Dashboard unavailable</StatusTag><p>{reason}. Reads may be incomplete, so fund-moving actions remain disabled.</p></div>;
}

function LiquidationUnavailableNotice({ reason }: { readonly reason: 'PRODUCT_DISABLED' | 'VENUE_MANIFEST_UNAVAILABLE' }): ReactElement {
  const message = reason === 'PRODUCT_DISABLED'
    ? 'The B20 lending route is reserved for a later rollout after an official market and price-bearing adapter are verified.'
    : 'No pinned lending venue adapter is present.';
  return <div className="state-card state-card--unavailable" data-testid="liquidation-unavailable" role="status"><StatusTag tone="amber">Liquidation unavailable</StatusTag><p><span className="mono">{reason}</span>. {message} Facility deposits remain available.</p></div>;
}

function InlineError({ message }: { readonly message: string }): ReactElement { return <div className="inline-message inline-message--error" role="alert">{message}</div>; }
function InlineSuccess({ message }: { readonly message: string }): ReactElement { return <div className="inline-message inline-message--success" role="status">{message}</div>; }
function StatusTag({ children, tone }: { readonly children: ReactNode; readonly tone: 'blue' | 'green' | 'gray' | 'amber' | 'red' }): ReactElement { return <span className={`tag tag--${tone}`}>{children}</span>; }

function exactAmount(value: string, decimals: number): bigint | null {
  if (!value.trim()) return null;
  try { return parseUnitsExact(value, decimals); } catch { return null; }
}

function formatUsdc(value: string): string {
  try { return formatUnitsExact(BigInt(value), USDC_DECIMALS); } catch { return '—'; }
}

function formatCollateral(value: string, asset: string, config: BaseRuntimeConfig): string {
  const decimals = config.b20Assets[asset.toLowerCase()]?.decimals;
  if (decimals === undefined) return 'B20 metadata unavailable';
  try { return `${formatUnitsExact(BigInt(value), decimals)} ${config.b20Assets[asset.toLowerCase()]?.ticker ?? short(asset)}`; } catch { return '—'; }
}

function formatWad(value: string): string {
  try { return formatUnitsExact(BigInt(value), 18); } catch { return '—'; }
}

function pairLabel(value: { readonly debtAsset: Address; readonly collateralAsset: Address }, config: BaseRuntimeConfig): string {
  const debt = value.debtAsset.toLowerCase() === config.usdc.toLowerCase() ? 'USDC' : short(value.debtAsset);
  const collateral = config.b20Assets[value.collateralAsset.toLowerCase()]?.ticker ?? short(value.collateralAsset);
  return `${debt} → ${collateral}`;
}

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function errorCode(reason: unknown): string {
  if (reason instanceof BaseApiError) return reason.code;
  if (reason instanceof Error && reason.message) return reason.message;
  return 'ACTION_FAILED';
}
