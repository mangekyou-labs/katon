import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  CuratorPage,
  DemoEvidencePage,
  DemoOverviewPage,
  DemoSellPage,
  EvidencePage,
  FacilityPage,
  HomePage,
  LiquidationsPage,
  SellPage,
  type PageProps,
} from './pages';
import { V1_ROUTES, type V1Route } from './routes';
import { loadRuntimeConfig } from './runtime';
import { BaseBrowserApi } from './api';
import { createBrowserWallet, type BaseWalletState } from './wallet';
import './styles.css';

const PUBLIC_EVALUATION = import.meta.env.VITE_KATON_BASE_DEMO === 'true';

// These strings are part of the browser integration contract and are kept
// discoverable for deployments and network-fixture tests.
const M5_BROWSER_CAPABILITIES = [
  'eth_requestAccounts',
  'eth_signTypedData_v4',
  'quoteUsdcCapacity',
  'DASHBOARD_UNAVAILABLE',
  'wrong-chain',
] as const;

export function App(): ReactElement {
  const config = useMemo(() => loadRuntimeConfig(), []);
  const api = useMemo(() => new BaseBrowserApi(config.apiUrl), [config.apiUrl]);
  const wallet = useMemo(() => PUBLIC_EVALUATION ? null : createBrowserWallet(config.chainId, config.rpcUrl), [config.chainId, config.rpcUrl]);
  const [path, setPath] = useState<string>(() => currentPath());
  const [walletState, setWalletState] = useState<BaseWalletState>({
    status: 'disconnected',
    expectedChainId: config.chainId,
  });
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    const onPopState = (): void => setPath(currentPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!wallet) {
      setWalletState({ status: 'disconnected', expectedChainId: config.chainId });
      return undefined;
    }
    const unsubscribe = wallet.subscribe(setWalletState);
    void wallet.refresh();
    return () => {
      unsubscribe();
      wallet.dispose();
    };
  }, [config.chainId, wallet]);

  const navigate = useCallback((nextPath: V1Route): void => {
    if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath);
    setPath(nextPath);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, []);

  const connectWallet = useCallback(async (): Promise<void> => {
    setWalletError(null);
    if (!wallet) {
      setWalletError('WALLET_UNAVAILABLE');
      return;
    }
    try {
      await wallet.connect();
    } catch (error) {
      setWalletError(errorMessage(error));
    }
  }, [wallet]);

  const switchNetwork = useCallback(async (): Promise<void> => {
    setWalletError(null);
    if (!wallet) {
      setWalletError('WALLET_UNAVAILABLE');
      return;
    }
    try {
      await wallet.switchToBase();
    } catch (error) {
      setWalletError(errorMessage(error));
    }
  }, [wallet]);

  const pageProps: PageProps = { config, api, wallet, walletState, connectWallet, switchNetwork };
  const route = asRoute(path);
  const page = PUBLIC_EVALUATION && route === '/sell'
    ? <DemoSellPage />
    : PUBLIC_EVALUATION && route === '/evidence'
      ? <DemoEvidencePage />
      : PUBLIC_EVALUATION
        ? <DemoOverviewPage />
    : route === '/facility'
    ? <FacilityPage {...pageProps} />
    : route === '/curator'
      ? <CuratorPage {...pageProps} />
      : route === '/liquidations'
        ? <LiquidationsPage {...pageProps} />
        : route === '/evidence'
          ? <EvidencePage {...pageProps} />
        : route === '/sell'
          ? <SellPage {...pageProps} />
        : <HomePage {...pageProps} />;

  return (
    <div
      className="app-shell"
      data-routes={V1_ROUTES.join(',')}
      data-capabilities={M5_BROWSER_CAPABILITIES.join(',')}
    >
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>
          <span className="brand-mark" aria-hidden="true">K</span>
          <span><strong>Katon</strong><small>BASE DESK</small></span>
        </a>
        <nav className="nav" aria-label="Primary navigation">
          <NavLink href="/" label="Overview" active={route === '/'} onNavigate={navigate} />
          <NavLink href="/sell" label="Sell stock" active={route === '/sell'} onNavigate={navigate} />
          <NavLink href="/evidence" label="Evidence" active={route === '/evidence'} onNavigate={navigate} />
          {!PUBLIC_EVALUATION ? <><NavLink href="/facility" label="Facility" active={route === '/facility'} onNavigate={navigate} />
          <NavLink href="/curator" label="Curator" active={route === '/curator'} onNavigate={navigate} />
          <NavLink href="/liquidations" label="Liquidations" active={route === '/liquidations'} onNavigate={navigate} /></> : null}
        </nav>
        {PUBLIC_EVALUATION ? <span className="preview-badge">Read-only evaluation</span> : <div className="wallet-area">
          <span className={`wallet-status wallet-status--${walletState.status}`}>
            <span className="status-dot" aria-hidden="true" />
            {walletState.status === 'connected' ? `${short(walletState.address ?? '')} · ${config.networkName}` : walletState.status === 'wrong-chain' ? 'Wrong chain' : 'Wallet disconnected'}
          </span>
          <button
            className="button button--primary button--compact"
            type="button"
            data-testid="wallet-connect"
            disabled={!wallet || walletState.status === 'connecting'}
            onClick={() => { void (walletState.status === 'wrong-chain' ? switchNetwork() : connectWallet()); }}
          >
            {walletState.status === 'wrong-chain' ? 'Switch to Base' : walletState.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
          </button>
        </div>}
      </header>
      {PUBLIC_EVALUATION ? <div className="runtime-banner" role="status"><span className="status-dot status-dot--amber" aria-hidden="true" /><span><strong>Guided evaluation.</strong> No wallet connection or transaction is requested in this preview.</span></div> : null}
      {!PUBLIC_EVALUATION && config.status === 'unavailable' ? (
        <div className="runtime-banner" role="status">
          <span className="status-dot status-dot--amber" aria-hidden="true" />
          <span><strong>Read-only deployment state.</strong> {config.reason ?? 'DASHBOARD_UNAVAILABLE'} — configure Base Sepolia addresses before enabling fund-moving actions.</span>
        </div>
      ) : null}
      {walletError ? <div className="runtime-banner runtime-banner--error" role="alert"><span>{walletError}</span></div> : null}
      <main aria-label="Katon Base tokenized-stock desk">{page}</main>
      <footer className="footer"><span>Base Sepolia · browser wallet only</span><span>Reads are pinned and indexed; execution stays signer-bound.</span></footer>
    </div>
  );
}

function NavLink({ href, label, active, onNavigate }: { readonly href: V1Route; readonly label: string; readonly active: boolean; readonly onNavigate: (path: V1Route) => void }): ReactElement {
  return <a className={`nav-link${active ? ' nav-link--active' : ''}`} href={href} aria-current={active ? 'page' : undefined} onClick={(event) => { event.preventDefault(); onNavigate(href); }}>{label}</a>;
}

function asRoute(path: string): V1Route {
  return V1_ROUTES.includes(path as V1Route) ? path as V1Route : '/';
}

function currentPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'WALLET_ERROR';
}
