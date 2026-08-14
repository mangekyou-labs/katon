import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { keccak256, stringToHex, type Hex } from 'viem';

import type { EncryptedEnvelope } from '../../../packages/flare-core/src/envelope';
import { bytes32Identifier, encryptFccEnvelope, fetchFccEncryptionRecipients } from '../../../packages/flare-core/src/fccEnvelope';
import { liveFccProofRows, resolveSettlementRouter, type LiveFccE2eEvidence } from '../../../packages/flare-core/src/fccE2e';
import { COSTON2_DEPLOYMENT, COSTON2_MOCK_ASSETS } from '../../../packages/flare-contracts/src/index';
import { buildDispatchConfidentialTransaction, buildUnsignedSwapRouteTransaction } from '../../../packages/flare-sdk/src/index';
import {
  createStandingBid,
  fetchFlareReadModel,
  requestImmediateQuote,
  requestWithdrawal,
  requestAuthChallenge,
  openRelayAuction,
  listRelayAuctions,
  submitRelayBid,
  finalizeRelayAuction,
  subscribeRelayEvents,
  verifyAuthChallenge,
  type FlareReadModel,
} from '../../../packages/flare-sdk/src/api';
import {
  connectFlareWallet,
  watchFlareWallet,
  submitWalletTransaction,
  waitForIndexedConfirmation,
  type Eip1193Provider,
  type FlareWalletConnection,
  type UnsignedWalletTransaction,
} from '../../../packages/flare-sdk/src/wallet';

import {
  currentRoute,
  buildImmediateQuote,
  buildLiquidationRouteReview,
  deriveReadModelState,
  indexedOpportunityRows,
  DEMO_ASSETS,
  formatTokenAmount,
  assetOptionFor,
  assetAddressLabel,
  balanceShortcutWithReserve,
  sortTableRows,
  NAVIGATION,
  readModelStateLabel,
  transactionStateLabel,
  curatorAdapterSummary,
  auctionActionStatusLabel,
  buildSimAuctionEnvelopePayload,
  buildSimBidEnvelopePayload,
  SIM_ASSET_DECIMALS,
  parseDisplayAmount,
  type AuctionActionStatus,
  type AppRoute,
  type ImmediateQuote,
  type ReadModelState,
  type TransactionState,
} from './model';

const demoState: TransactionState = 'ready';
const DEMO_ROUTER = resolveSettlementRouter(
  window as Window & { __FLARE_ROUTER__?: string },
  COSTON2_DEPLOYMENT.router,
) as Hex;
const DEMO_SOURCE = COSTON2_MOCK_ASSETS.source;
const DEMO_POLICY = COSTON2_MOCK_ASSETS.policyId;
const DEMO_ISSUER = COSTON2_MOCK_ASSETS.issuerReference;
const DEMO_SELL_BALANCE = 5n * 10n ** 18n;
const DEMO_GAS_RESERVE = 1n * 10n ** 16n;
const API_BASE_URL = (window as Window & { __FLARE_API_URL__?: string }).__FLARE_API_URL__ ?? 'http://127.0.0.1:8787';
const RUNTIME = window as Window & {
  __FLARE_API_URL__?: string;
  __FLARE_FCC_MODE__?: 'simulated' | 'real';
  __FLARE_FCC_KEY_ID__?: string;
  __FLARE_FCC_PUBLIC_KEY__?: string;
  __FLARE_FCC_INSTRUCTION_SENDER__?: string;
  __FLARE_FCC_EXTENSION_ID__?: string;
  __FLARE_FCC_PROXY_URLS__?: string[];
  __FLARE_FCC_PROXY_TEE_IDS__?: string[];
  __FLARE_ELIGIBLE_LPS__?: string[];
  __FLARE_ROUTER__?: string;
  __FLARE_LIVE_PROOF__?: LiveFccE2eEvidence;
};

interface ReceiptResult {
  readonly status: 'success' | 'reverted';
}

interface BrowserAuctionBid {
  readonly role: 'lp-a' | 'lp-b';
  readonly bidPayload: {
    readonly commitment: Hex;
    readonly bidder: string;
    readonly sellToken: string;
    readonly buyToken: string;
    readonly sellAmount: string;
    readonly quotedOutput: string;
    readonly sequence: string;
    readonly expiresAt: number;
  };
  readonly envelope: Hex;
  readonly signature: string;
  readonly commitment: Hex;
}

interface BrowserAuctionState {
  readonly auctionPayload: {
    readonly commitment: Hex;
    readonly chainId: 114;
    readonly router: string;
    readonly sellToken: string;
    readonly buyToken: string;
    readonly sellAmount: string;
    readonly minOutput: string;
    readonly decisionDeadline: number;
  };
  readonly auctionEnvelope: Hex;
  readonly bids: readonly BrowserAuctionBid[];
  readonly routePlan: {
    readonly version: 1;
    readonly auctionId: Hex;
    readonly bidCommitments: readonly Hex[];
    readonly tieBreak: 'commitment-lexicographic-v1';
    readonly chainId: 114;
    readonly router: string;
    readonly commitment: Hex;
    readonly fccActionId: Hex;
    readonly decisionBlock: string;
    readonly decisionBlockHash: Hex;
    readonly deadline: string;
    readonly seller: string;
    readonly recipient: string;
    readonly sellToken: string;
    readonly buyToken: string;
    readonly sellAmount: string;
    readonly minOutput: string;
    readonly protocolFeeBps: number;
    readonly eligibilityPolicyId: Hex;
    readonly eligibilityRevocationEpoch: string;
    readonly eligibilityRole: string;
    readonly eligibilityIssuerReference: Hex;
    readonly legs: readonly [{ readonly source: string; readonly sellAmount: string; readonly minOutput: string; readonly sourceData: Hex }];
  };
}

const BROWSER_AUCTION_STATE_KEY = 'trustrfq:fcc:auction-state:v1';

function loadBrowserAuctionStates(): Record<string, BrowserAuctionState> {
  try {
    const raw = window.localStorage.getItem(BROWSER_AUCTION_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, BrowserAuctionState>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveBrowserAuctionState(auctionId: string, state: BrowserAuctionState): void {
  try {
    const states = loadBrowserAuctionStates();
    states[auctionId] = state;
    window.localStorage.setItem(BROWSER_AUCTION_STATE_KEY, JSON.stringify(states));
  } catch {
    // Browser storage is an optimization; the encrypted payload remains in memory.
  }
}

function browserRoutePlan(actionId: Hex, auction: BrowserAuctionState['auctionPayload'], seller: string, bidCommitments: readonly Hex[]): BrowserAuctionState['routePlan'] {
  return {
    version: 1,
    auctionId: actionId,
    bidCommitments,
    tieBreak: 'commitment-lexicographic-v1',
    chainId: 114,
    router: auction.router,
    commitment: auction.commitment,
    fccActionId: actionId,
    decisionBlock: '0',
    decisionBlockHash: `0x${'00'.repeat(32)}`,
    deadline: String(auction.decisionDeadline),
    seller,
    recipient: seller,
    sellToken: auction.sellToken,
    buyToken: auction.buyToken,
    sellAmount: auction.sellAmount,
    minOutput: auction.minOutput,
    protocolFeeBps: 50,
    eligibilityPolicyId: DEMO_POLICY as Hex,
    eligibilityRevocationEpoch: '0',
    eligibilityRole: '1',
    eligibilityIssuerReference: DEMO_ISSUER as Hex,
    legs: [{ source: DEMO_SOURCE, sellAmount: auction.sellAmount, minOutput: auction.minOutput, sourceData: '0x' }],
  };
}

export function App(): ReactElement {
  const [path, setPath] = useState<AppRoute>(() => currentRoute(window.location.pathname));
  const [wallet, setWallet] = useState<FlareWalletConnection | null>(null);
  const [apiToken, setApiToken] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [quote, setQuote] = useState<ImmediateQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [sellAsset, setSellAsset] = useState('RWA');
  const [receiveAsset, setReceiveAsset] = useState('USDX');
  const [amount, setAmount] = useState('');
  const [minimumReceive, setMinimumReceive] = useState('');
  const [transactionState, setTransactionState] = useState<TransactionState>(demoState);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const [transactionBusy, setTransactionBusy] = useState(false);
  const [readModel, setReadModel] = useState<FlareReadModel | null>(null);
  const [readModelState, setReadModelState] = useState<ReadModelState>('loading');
  const [readModelError, setReadModelError] = useState<string | null>(null);
  const [relayStatus, setRelayStatus] = useState<'idle' | 'connecting' | 'connected' | 'offline'>('idle');
  const [activeAuctionId, setActiveAuctionId] = useState('');
  const [auctionActionStatus, setAuctionActionStatus] = useState<AuctionActionStatus>({ state: 'idle' });
  const relayCursor = useRef(0);
  const active = useMemo(() => NAVIGATION.find((item) => item.href === path) ?? NAVIGATION[0], [path]);

  async function refreshReadModel(): Promise<void> {
    setReadModelState('loading');
    setReadModelError(null);
    try {
      const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
      const auth = wallet && provider ? await apiAuth(provider, wallet) : undefined;
      const next = await fetchFlareReadModel(API_BASE_URL, wallet?.address, auth);
      setReadModel(next);
      setReadModelState(deriveReadModelState(next, Date.now()));
    } catch (error) {
      setReadModelState('offline');
      setReadModelError(error instanceof Error ? error.message : 'Read model unavailable.');
    }
  }

  useEffect(() => { void refreshReadModel(); }, [wallet?.address]);

  useEffect(() => {
    if (!wallet?.address) {
      setRelayStatus('idle');
      return undefined;
    }
    setRelayStatus('connecting');
    let cancelled = false;
    let socket: WebSocket | undefined;
    void (async () => {
      const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
      const auth = provider ? await apiAuth(provider, wallet) : undefined;
      if (cancelled) return;
      socket = await subscribeRelayEvents(API_BASE_URL, wallet.address, relayCursor.current, (message) => {
        relayCursor.current = message.cursor;
        setRelayStatus('connected');
        void refreshReadModel();
      }, () => {
        setRelayStatus('offline');
      }, auth);
      const handleOpen = () => setRelayStatus('connected');
      socket.addEventListener('open', handleOpen);
    })().catch(() => setRelayStatus('offline'));
    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [wallet?.address]);

  useEffect(() => {
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    if (!provider) return undefined;
    return watchFlareWallet(provider, 'coston2', (next) => {
      setWallet(next);
      if (!next) setApiToken(null);
    }, (error) => {
      setWalletError(error instanceof Error ? error.message : 'Wallet state changed.');
    });
  }, []);

  async function apiAuth(provider: Eip1193Provider, connection: FlareWalletConnection): Promise<{ readonly token?: string }> {
    const runtime = window as Window & { __FLARE_API_AUTH_REQUIRED__?: boolean };
    if (!runtime.__FLARE_API_AUTH_REQUIRED__) return {};
    if (apiToken) return { token: apiToken };
    const challenge = await requestAuthChallenge(API_BASE_URL, connection.address);
    const signature = await provider.request({ method: 'personal_sign', params: [challenge.message, connection.address] });
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('AUTH_SIGNATURE_INVALID');
    const session = await verifyAuthChallenge(API_BASE_URL, challenge.message, signature as `0x${string}`);
    setApiToken(session.token);
    return { token: session.token };
  }

  function navigate(nextPath: AppRoute): void {
    window.history.pushState({}, '', nextPath);
    setPath(nextPath);
  }

  async function connectWallet(): Promise<void> {
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    setWalletError(null);
    if (!provider) {
      setWalletError('No EVM wallet detected. Install a wallet before connecting.');
      return;
    }
    setWalletBusy(true);
    try {
      setWallet(await connectFlareWallet(provider, 'coston2'));
    } catch (error) {
      setWallet(null);
      setWalletError(error instanceof Error ? error.message : 'Wallet connection failed.');
    } finally {
      setWalletBusy(false);
    }
  }

  async function requestQuote(): Promise<void> {
    setQuoteError(null);
    setTransactionHash(null);
    setTransactionState('ready');
    try {
      const localQuote = buildImmediateQuote({ sellAsset, receiveAsset, amount, minimumReceive });
      const liveQuote = await requestImmediateQuote(API_BASE_URL, { sellAsset, receiveAsset, amount, minimumReceive });
      setQuote({
        ...localQuote,
        grossOutput: BigInt(liveQuote.grossOutput),
        protocolFee: BigInt(liveQuote.protocolFee),
        netOutput: BigInt(liveQuote.netOutput),
        minimumReceive: BigInt(liveQuote.minimumReceive),
        protocolFeeBps: liveQuote.protocolFeeBps,
      });
    } catch (error) {
      setQuote(null);
      setQuoteError(error instanceof Error ? quoteErrorLabel(error.message) : 'Quote could not be prepared.');
    }
  }

  async function reviewOrSubmitQuote(): Promise<void> {
    if (!quote) return;
    if (!wallet) {
      await connectWallet();
      return;
    }
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    if (!provider) {
      setWalletError('No EVM wallet detected. Install a wallet before signing.');
      return;
    }
    setQuoteError(null);
    setWalletError(null);
    setTransactionBusy(true);
    try {
      const unsigned = await buildDemoSwapTransaction(provider, wallet, quote);
      const result = await submitWalletTransaction(provider, {
        from: wallet.address,
        to: unsigned.to,
        data: unsigned.data,
        value: unsigned.value,
        chainId: unsigned.chainId,
      }, {
        waitForReceipt: (hash) => waitForReceipt(provider, hash),
        waitForIndexed: (hash) => waitForIndexer(hash),
        onState: setTransactionState,
      });
      setTransactionHash(result.hash);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Wallet submission failed.';
      setQuoteError(message === 'INDEXER_NOT_CONFIGURED' ? 'Confirmed on Flare, but indexed confirmation did not complete.' : message);
    } finally {
      setTransactionBusy(false);
    }
  }

  async function createAuctionFromUi(input: { readonly pair: string; readonly duration: '24h' | '1w' | '1m' | '3m'; readonly minOutput: string; readonly earlyCloseAllowed: boolean }): Promise<void> {
    if (!wallet) { await connectWallet(); return; }
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    if (!provider) { setWalletError('No EVM wallet detected.'); return; }
    try {
      const runtimeMode = RUNTIME.__FLARE_FCC_MODE__ ?? (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' ? 'simulated' : undefined);
      if (!runtimeMode) throw new Error('FCC_MODE_REQUIRED');
      if (runtimeMode === 'real') {
        const actionId = keccak256(stringToHex(`trustrfq:auction:${wallet.address}:${input.pair}:${input.duration}:${input.minOutput}:${Date.now()}`));
        const expiresAt = Math.floor(Date.now() / 1_000) + auctionDurationSeconds(input.duration) + 60;
        const auctionPayload = {
          commitment: actionId,
          chainId: 114 as const,
          router: DEMO_ROUTER,
          sellToken: COSTON2_MOCK_ASSETS.rwa,
          buyToken: COSTON2_MOCK_ASSETS.usdx,
          sellAmount: '1',
          minOutput: input.minOutput,
          decisionDeadline: expiresAt,
        } as const;
        const dispatched = await dispatchFccBrowserAction(provider, wallet, {
          actionId,
          opType: 'RFQ',
          command: 'CREATE',
          payload: { auction: auctionPayload, pair: input.pair, duration: input.duration, seller: wallet.address, earlyCloseAllowed: input.earlyCloseAllowed },
          expiresAt,
          onState: setTransactionState,
        });
        saveBrowserAuctionState(actionId, {
          auctionPayload,
          auctionEnvelope: dispatched.envelope,
          bids: [],
          routePlan: browserRoutePlan(actionId, auctionPayload, wallet.address, []),
        });
        setActiveAuctionId(actionId);
        setAuctionActionStatus({ state: 'created', auctionId: actionId, transactionHash: dispatched.hash });
        return;
      }
      const commitment = keccak256(stringToHex(`trustrfq:auction:${wallet.address}:${input.pair}:${input.duration}:${input.minOutput}:${Date.now()}`));
      const expiresAt = Math.floor(Date.now() / 1_000) + auctionDurationSeconds(input.duration) + 60;
      const auctionPayload = {
        commitment,
        chainId: 114 as const,
        router: DEMO_ROUTER,
        sellToken: COSTON2_MOCK_ASSETS.rwa,
        buyToken: COSTON2_MOCK_ASSETS.usdx,
        sellAmount: '1',
        minOutput: parseDisplayAmount(input.minOutput, SIM_ASSET_DECIMALS).toString(),
        decisionDeadline: expiresAt,
      } as const;
      // Simulated-lane contract (see tools/sim-rfq-payload.mjs): the relay envelope carries the
      // matcher payload as JSON ciphertext; real encryption belongs to the FCC/TEE lane.
      const envelope: EncryptedEnvelope = {
        version: 1,
        keyId: RUNTIME.__FLARE_FCC_KEY_ID__ ?? 'simulated-fcc-demo-v1',
        commitment,
        expiresAt,
        nonce: `sim-auction-${Date.now().toString(36)}`,
        ciphertext: JSON.stringify(buildSimAuctionEnvelopePayload({
          commitment,
          router: DEMO_ROUTER,
          sellToken: COSTON2_MOCK_ASSETS.rwa,
          buyToken: COSTON2_MOCK_ASSETS.usdx,
          sellAmount: '1',
          minOutput: input.minOutput,
          decisionDeadline: expiresAt,
          routePlan: browserRoutePlan(commitment, auctionPayload, wallet.address, []),
          seller: wallet.address,
          pair: input.pair,
          duration: input.duration,
        })),
      };
      const auction = await openRelayAuction(API_BASE_URL, {
        wallet: wallet.address,
        eligibleLps: RUNTIME.__FLARE_ELIGIBLE_LPS__ ?? [wallet.address],
        duration: input.duration,
        earlyCloseAllowed: input.earlyCloseAllowed,
        envelope,
      }, await apiAuth(provider, wallet));
      setActiveAuctionId(auction.id);
      setAuctionActionStatus({ state: 'created', auctionId: auction.id });
      await refreshReadModel();
    } catch (error) {
      setReadModelError(error instanceof Error ? error.message : 'Auction could not be created.');
    }
  }

  async function runAuctionAction(input: AuctionActionInput): Promise<void> {
    if (!wallet) { await connectWallet(); return; }
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    if (!provider) { setWalletError('No EVM wallet detected.'); return; }
    const auctionId = input.auctionId.trim() || activeAuctionId;
    if (!auctionId) { setAuctionActionStatus({ state: 'error', message: 'AUCTION_ID_REQUIRED' }); return; }
    setAuctionActionStatus({ state: 'submitting', auctionId });
    try {
      const runtimeMode = RUNTIME.__FLARE_FCC_MODE__ ?? (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' ? 'simulated' : undefined);
      if (runtimeMode === 'real') {
        if (input.action === 'relay') throw new Error('FCC_RESULT_RELAY_REQUIRES_SIGNED_TEE_RESULT');
        const command = input.action === 'bid' ? 'BID' : 'FINALIZE';
        const opType = input.action === 'bid' ? 'BID' : 'MATCH';
        const actionId = /^0x[0-9a-fA-F]{64}$/.test(auctionId) ? auctionId as Hex : keccak256(stringToHex(auctionId));
        const existing = loadBrowserAuctionStates()[auctionId] ?? loadBrowserAuctionStates()[actionId];
        if (input.action === 'bid' && !existing) throw new Error('FCC_AUCTION_STATE_REQUIRED');
        const payload: Record<string, unknown> = { auctionId, role: input.role, bidAmount: input.bidAmount ?? null };
        if (input.action === 'bid') {
          const typedData = {
            domain: {
              name: 'TrustRFQ FCC Bid',
              version: '1',
              chainId: 114,
              verifyingContract: RUNTIME.__FLARE_FCC_INSTRUCTION_SENDER__,
            },
            types: {
              Bid: [
                { name: 'auctionId', type: 'bytes32' },
                { name: 'quotedOutput', type: 'string' },
                { name: 'expiry', type: 'uint64' },
              ],
            },
            primaryType: 'Bid',
            message: {
              auctionId: actionId,
              quotedOutput: input.bidAmount ?? '',
              expiry: Math.floor(Date.now() / 1_000) + 900,
            },
          } as const;
          const signature = await provider.request({
            method: 'eth_signTypedData_v4',
            params: [wallet.address, JSON.stringify(typedData)],
          });
          if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('FCC_BID_SIGNATURE_INVALID');
          payload.signature = signature;
          const bidExpiresAt = Math.floor(Date.now() / 1_000) + 900;
          const dispatched = await dispatchFccBrowserAction(provider, wallet, {
            actionId,
            opType,
            command,
            payload,
            expiresAt: bidExpiresAt,
            onState: setTransactionState,
          });
          const bidPayload = {
            commitment: dispatched.plaintextCommitment,
            bidder: wallet.address,
            sellToken: COSTON2_MOCK_ASSETS.rwa,
            buyToken: COSTON2_MOCK_ASSETS.usdx,
            sellAmount: '1',
            quotedOutput: input.bidAmount ?? '',
            sequence: String((existing?.bids.length ?? 0) + 1),
            expiresAt: bidExpiresAt,
          } as const;
          const bid: BrowserAuctionBid = { role: input.role as 'lp-a' | 'lp-b', bidPayload, envelope: dispatched.envelope, signature, commitment: dispatched.plaintextCommitment };
          const nextBids = [...(existing?.bids ?? []), bid];
          saveBrowserAuctionState(auctionId, {
            auctionPayload: existing!.auctionPayload,
            auctionEnvelope: existing!.auctionEnvelope,
            bids: nextBids,
            routePlan: { ...existing!.routePlan, bidCommitments: nextBids.map((entry) => entry.commitment).sort() },
          });
          setAuctionActionStatus({ state: 'bid-submitted', auctionId, transactionHash: dispatched.hash });
          setActiveAuctionId(auctionId);
          return;
        }
        if (!existing || existing.bids.length < 2) throw new Error('FCC_FINALIZE_PAYLOAD_REQUIRED');
        payload.auction = existing.auctionPayload;
        payload.bids = existing.bids.map(({ bidPayload }) => bidPayload);
        payload.now = Math.floor(Date.now() / 1_000);
        payload.auctionEnvelope = existing.auctionEnvelope;
        payload.signedBids = existing.bids.map(({ role, envelope, signature, commitment }) => ({ role, envelope, signature, commitment }));
        payload.routePlan = existing.routePlan;
        const dispatched = await dispatchFccBrowserAction(provider, wallet, {
          actionId,
          opType,
          command,
          payload,
          expiresAt: Math.floor(Date.now() / 1_000) + 900,
          onState: setTransactionState,
        });
        setAuctionActionStatus({ state: 'finalized', auctionId, quorum: 'pending FCC result relay', transactionHash: dispatched.hash });
        setActiveAuctionId(auctionId);
        return;
      }
      const auth = await apiAuth(provider, wallet);
      if (input.action === 'bid') {
        // The blind relay correlates bids to the auction by envelope commitment; bids must
        // reuse the auction's commitment, never mint a content-derived one (ENVELOPE_COMMITMENT).
        const relayRow = (await listRelayAuctions(API_BASE_URL, wallet.address, auth)).find((row) => row.id === auctionId);
        if (!relayRow) throw new Error('RFQ_NOT_FOUND');
        const commitment = relayRow.commitment as Hex;
        const bidCommitment = keccak256(stringToHex(`trustrfq:bid:${auctionId}:${wallet.address}:${input.role}:${input.bidAmount ?? ''}`));
        const envelope: EncryptedEnvelope = {
          version: 1,
          keyId: `simulated-${input.role}`,
          commitment,
          expiresAt: Math.floor(Date.now() / 1_000) + 900,
          nonce: `sim-bid-${Date.now().toString(36)}`,
          ciphertext: JSON.stringify(buildSimBidEnvelopePayload({
            commitment: bidCommitment,
            bidder: wallet.address,
            sellToken: COSTON2_MOCK_ASSETS.rwa,
            buyToken: COSTON2_MOCK_ASSETS.usdx,
            sellAmount: '1',
            bidAmount: input.bidAmount ?? '0',
            sequence: input.role === 'lp-a' ? 1 : 2,
            expiresAt: relayRow.expiresAt + 3_600,
          })),
        };
        const auction = await submitRelayBid(API_BASE_URL, auctionId, { wallet: wallet.address, idempotencyKey: `ui-${auctionId}-${wallet.address}-${input.role}`, envelope }, auth);
        setAuctionActionStatus({ state: 'bid-submitted', auctionId: auction.id });
      } else if (input.action === 'finalize') {
        const auction = await finalizeRelayAuction(API_BASE_URL, auctionId, wallet.address, auth);
        setAuctionActionStatus({ state: 'finalized', auctionId: auction.id, quorum: 'pending FCC result relay' });
      } else {
        setAuctionActionStatus({ state: 'error', auctionId, message: 'FCC_RESULT_RELAY_REQUIRES_SIGNED_TEE_RESULT' });
      }
      setActiveAuctionId(auctionId);
      await refreshReadModel();
    } catch (error) {
      setAuctionActionStatus({ state: 'error', auctionId, message: error instanceof Error ? error.message : 'AUCTION_ACTION_FAILED' });
    }
  }

  async function createStandingBidFromUi(input: { readonly pair: string; readonly capacity: string; readonly mode: 'instant' | 'partial' | 'fok'; readonly expiry: number }): Promise<void> {
    if (!wallet) { await connectWallet(); return; }
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    if (!provider) { setWalletError('No EVM wallet detected.'); return; }
    try {
      await createStandingBid(API_BASE_URL, { ...input, wallet: wallet.address }, await apiAuth(provider, wallet));
      await refreshReadModel();
    } catch (error) {
      setReadModelError(error instanceof Error ? error.message : 'Standing bid could not be created.');
    }
  }

  async function requestFacilityWithdrawalFromUi(input: { readonly shares: string; readonly minAssets: string }): Promise<void> {
    if (!wallet) { await connectWallet(); return; }
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    if (!provider) { setWalletError('No EVM wallet detected.'); return; }
    try {
      await requestWithdrawal(API_BASE_URL, { ...input, wallet: wallet.address }, await apiAuth(provider, wallet));
      await refreshReadModel();
    } catch (error) {
      setReadModelError(error instanceof Error ? error.message : 'Withdrawal could not be queued.');
    }
  }

  const walletLabel = wallet ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'Connect wallet';

  return (
    <div className="flare-app">
      <header className="topbar">
        <a className="wordmark" href="/swap" onClick={(event) => { event.preventDefault(); navigate('/swap'); }}>
          <span className="wordmark__mark">K</span>
          <span>Katon</span>
          <span className="wordmark__network">FLARE</span>
        </a>
        <nav aria-label="Primary navigation" className="topnav">
          {NAVIGATION.map((item) => (
            <a
              aria-current={item.href === path ? 'page' : undefined}
              className={item.href === path ? 'topnav__link topnav__link--active' : 'topnav__link'}
              href={item.href}
              key={item.href}
              onClick={(event) => { event.preventDefault(); navigate(item.href); }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <button aria-busy={walletBusy} className="wallet-button" disabled={walletBusy} type="button" onClick={() => { void connectWallet(); }}>
          <span className={wallet ? 'wallet-button__dot wallet-button__dot--connected' : 'wallet-button__dot'} />
          {walletLabel}
        </button>
      </header>

      <main className="content">
        <section className="page-heading">
          <div>
            <p className="eyebrow">FLARE CONFIDENTIAL LIQUIDITY</p>
            <h1>{active.label}</h1>
            <p className="lede">{active.eyebrow}. Noncustodial settlement with explicit review at every wallet boundary.</p>
          </div>
          <div className="network-pill"><span className="status-dot status-dot--green" /> Coston2 · 114</div>
        </section>

        {walletError ? <p aria-live="polite" className="wallet-error" role="alert">{walletError}</p> : null}
        {readModelError ? <p aria-live="polite" className="read-model-error" role="alert">Read model: {readModelError}</p> : null}

        {quoteError ? <p aria-live="polite" className="quote-error" role="alert">{quoteError}</p> : null}

        <RouteContent
          route={path}
          amount={amount}
          receiveAsset={receiveAsset}
          minimumReceive={minimumReceive}
          sellAsset={sellAsset}
          quote={quote}
          walletConnected={Boolean(wallet)}
          transactionBusy={transactionBusy}
          transactionHash={transactionHash}
          transactionState={quote ? transactionState : demoState}
          onAmountChange={setAmount}
          onMinimumReceiveChange={setMinimumReceive}
          onReceiveAssetChange={setReceiveAsset}
          onSellAssetChange={setSellAsset}
          onRequestQuote={requestQuote}
          onReviewOrSubmit={reviewOrSubmitQuote}
          onConnect={connectWallet}
          readModel={readModel}
          readModelState={readModelState}
          onRefreshReadModel={refreshReadModel}
          onCreateAuction={createAuctionFromUi}
          activeAuctionId={activeAuctionId}
          auctionActionStatus={auctionActionStatus}
          onAuctionAction={runAuctionAction}
          onCreateStandingBid={createStandingBidFromUi}
          onRequestFacilityWithdrawal={requestFacilityWithdrawalFromUi}
        />

        <footer className="status-footer">
          <span><span className="status-dot status-dot--amber" /> FCC assurance: simulated local/testnet mode</span>
          <span aria-live="polite"><span className={relayStatus === 'connected' ? 'status-dot status-dot--green' : 'status-dot status-dot--amber'} /> Relay: {relayStatusLabel(relayStatus)}</span>
        </footer>
      </main>
    </div>
  );
}

async function dispatchFccBrowserAction(provider: Eip1193Provider, wallet: FlareWalletConnection, input: { readonly actionId: Hex; readonly opType: string; readonly command: string; readonly payload: unknown; readonly expiresAt: number; readonly onState: (state: TransactionState) => void }): Promise<{ readonly hash: string; readonly envelope: Hex; readonly plaintextCommitment: Hex }> {
  const sender = RUNTIME.__FLARE_FCC_INSTRUCTION_SENDER__;
  const extensionId = RUNTIME.__FLARE_FCC_EXTENSION_ID__;
  const proxyUrls = RUNTIME.__FLARE_FCC_PROXY_URLS__;
  if (!sender || !extensionId || !proxyUrls || proxyUrls.length !== 3) throw new Error('FCC_NOT_CONFIGURED');
  const sources = proxyUrls.map((url, index) => ({ url, teeId: RUNTIME.__FLARE_FCC_PROXY_TEE_IDS__?.[index] })) as [{ readonly url: string; readonly teeId?: string }, { readonly url: string; readonly teeId?: string }, { readonly url: string; readonly teeId?: string }];
  const recipients = await fetchFccEncryptionRecipients(sources, extensionId, { allowHttpLocalhost: proxyUrls.every((url) => new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost') });
  const payloadObject = input.payload !== null && typeof input.payload === 'object' && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : { value: input.payload };
  const plaintext = new TextEncoder().encode(JSON.stringify({ ...payloadObject, chainId: 114, actionId: input.actionId, command: input.command }));
  const wireCommand = input.command === 'BID' ? 'SUBMIT' : input.command;
  const envelope = await encryptFccEnvelope(plaintext, { chainId: 114, extensionId: bytes32Identifier(extensionId), actionId: input.actionId, opType: input.opType, command: wireCommand, expiry: input.expiresAt }, recipients);
  const unsigned = buildDispatchConfidentialTransaction({ from: wallet.address, instructionSender: sender, opType: input.opType, command: wireCommand, actionId: input.actionId, envelope: envelope.encoded, expiry: input.expiresAt });
  const result = await submitWalletTransaction(provider, unsigned, {
    waitForReceipt: (hash) => waitForReceipt(provider, hash),
    // The supported Coston2 indexer path is intentionally gated on operator-provided
    // ext-proxy credentials. Chain confirmation is still reported without claiming
    // that an instruction has been indexed.
    waitForIndexed: async () => undefined,
    onState: input.onState,
  });
  return { hash: result.hash, envelope: envelope.encoded, plaintextCommitment: envelope.plaintextCommitment };
}

function auctionDurationSeconds(duration: '24h' | '1w' | '1m' | '3m'): number {
  return duration === '24h' ? 86_400 : duration === '1w' ? 604_800 : duration === '1m' ? 2_592_000 : 7_776_000;
}

function relayStatusLabel(status: 'idle' | 'connecting' | 'connected' | 'offline'): string {
  return {
    idle: 'connect wallet to subscribe',
    connecting: 'connecting',
    connected: 'live · cursor resumable',
    offline: 'offline · refresh to retry',
  }[status];
}

function AssetSelector({
  ariaLabel,
  listId,
  value,
  onChange,
  placeholder,
}: {
  readonly ariaLabel: string;
  readonly listId: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const query = value.trim().toLowerCase();
  const options = DEMO_ASSETS.filter((asset) => (
    query.length === 0 || asset.symbol.toLowerCase().includes(query) || asset.address.toLowerCase().includes(query)
  ));
  const selected = assetOptionFor(value);
  async function copyAddress(): Promise<void> {
    if (!selected) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(selected.address);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = selected.address;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
    } catch {
      // The address remains visible and selected even when a browser blocks
      // clipboard writes (for example in an isolated HTTP test context).
    }
  }
  return <label>{ariaLabel}<input aria-label={ariaLabel} list={listId} value={value} onChange={(event) => { setCopied(false); onChange(event.target.value); }} placeholder={placeholder} /><datalist id={listId}>{options.map((asset) => <option key={asset.address} value={asset.symbol} label={`${asset.symbol} · ${asset.address}`} />)}</datalist><span className="field-hint">Verified on Coston2 · {options.length} eligible asset{options.length === 1 ? '' : 's'}</span>{selected ? <span className="asset-address"><code>{assetAddressLabel(selected.address)}</code><button className="copy-button" type="button" onClick={() => { void copyAddress(); }}>{copied ? 'Copied' : 'Copy address'}</button></span> : null}</label>;
}

interface RouteContentProps {
  readonly route: AppRoute;
  readonly amount: string;
  readonly receiveAsset: string;
  readonly minimumReceive: string;
  readonly sellAsset: string;
  readonly quote: ImmediateQuote | null;
  readonly walletConnected: boolean;
  readonly transactionBusy: boolean;
  readonly transactionHash: string | null;
  readonly transactionState: TransactionState;
  readonly onAmountChange: (value: string) => void;
  readonly onMinimumReceiveChange: (value: string) => void;
  readonly onReceiveAssetChange: (value: string) => void;
  readonly onSellAssetChange: (value: string) => void;
  readonly onRequestQuote: () => Promise<void>;
  readonly onReviewOrSubmit: () => Promise<void>;
  readonly onConnect: () => Promise<void>;
  readonly readModel: FlareReadModel | null;
  readonly readModelState: ReadModelState;
  readonly onRefreshReadModel: () => Promise<void>;
  readonly onCreateAuction: (input: { readonly pair: string; readonly duration: '24h' | '1w' | '1m' | '3m'; readonly minOutput: string; readonly earlyCloseAllowed: boolean }) => Promise<void>;
  readonly activeAuctionId: string;
  readonly auctionActionStatus: AuctionActionStatus;
  readonly onAuctionAction: (input: AuctionActionInput) => Promise<void>;
  readonly onCreateStandingBid: (input: { readonly pair: string; readonly capacity: string; readonly mode: 'instant' | 'partial' | 'fok'; readonly expiry: number }) => Promise<void>;
  readonly onRequestFacilityWithdrawal: (input: { readonly shares: string; readonly minAssets: string }) => Promise<void>;
}

type AuctionRole = 'seller' | 'lp-a' | 'lp-b';
type AuctionAction = 'bid' | 'finalize' | 'relay';
interface AuctionActionInput { readonly action: AuctionAction; readonly role: AuctionRole; readonly auctionId: string; readonly bidAmount?: string; }

function RouteContent(props: RouteContentProps): ReactElement {
  const { route } = props;
  if (route === '/swap') {
    return (
      <div className="grid grid--swap">
        <section className="panel panel--hero">
          <div className="panel__header"><div><p className="eyebrow">SELL RWA · RECEIVE STABLECOIN</p><h2>Request liquidity</h2></div><span className="tag tag--blue">Private by default</span></div>
          <div className="form-grid">
            <AssetSelector ariaLabel="Sell asset" listId="flare-sell-assets" value={props.sellAsset} onChange={props.onSellAssetChange} placeholder="Search verified RWA" />
            <AssetSelector ariaLabel="Receive asset" listId="flare-receive-assets" value={props.receiveAsset} onChange={props.onReceiveAssetChange} placeholder="Search verified stablecoin" />
            <label>Amount<input aria-label="Amount" inputMode="decimal" value={props.amount} onChange={(event) => props.onAmountChange(event.target.value)} placeholder="1.00" /><span className="balance-shortcuts" aria-label="Balance shortcuts"><span className="field-hint">Available 4.99 RWA after 0.01 RWA reserve</span>{([25, 50, 100] as const).map((percent) => <button className="shortcut-button" key={percent} type="button" onClick={() => props.onAmountChange(formatTokenAmount(balanceShortcutWithReserve(DEMO_SELL_BALANCE, DEMO_GAS_RESERVE, percent), 18))}>{percent === 100 ? 'Max' : `${percent}%`}</button>)}</span></label>
            <label>Minimum receive<input aria-label="Minimum receive" inputMode="decimal" value={props.minimumReceive} onChange={(event) => props.onMinimumReceiveChange(event.target.value)} placeholder="995" /></label>
          </div>
          <div className="review-row"><span>Route</span><strong>{props.quote ? 'Standing LP · quoted' : 'Standing LP → facility fallback'}</strong></div>
          <div className="review-row"><span>Settlement</span><strong>Atomic on Flare · no API custody</strong></div>
          {props.quote ? <QuoteReview quote={props.quote} transactionHash={props.transactionHash} transactionState={props.transactionState} /> : null}
          <LiveFccProofPanel />
          <button className="button button--primary" disabled={props.transactionBusy} type="button" onClick={() => { void props.onRequestQuote(); }}>{props.quote ? 'Refresh quote' : 'Request immediate quote'}</button>
          {props.quote ? <button className="button button--secondary button--full" disabled={props.transactionBusy} type="button" onClick={() => { void props.onReviewOrSubmit(); }}>{props.walletConnected ? 'Sign and submit' : 'Connect wallet to sign'}</button> : null}
          <p className="helper">Demo Coston2 quote: exactly 1 RWA → 1,000 USDX gross, less one 50 bps protocol fee. Live quote readers are the next integration gate.</p>
        </section>
        <aside className="panel panel--side"><p className="eyebrow">TRANSACTION STATE</p><div className="state-card"><span className="tag tag--green">{transactionStateLabel(props.quote ? props.transactionState : demoState)}</span><p>Wallet signature, submission, confirmation, and indexed state remain separate.</p></div><div className="metric"><span>Available sources</span><strong>{props.quote ? '1 standing LP' : '—'}</strong></div><div className="metric"><span>FTSO guardrail</span><strong className="muted">Connect wallet</strong></div><div className="metric"><span>NAV freshness</span><strong className="muted">Not available</strong></div></aside>
      </div>
    );
  }
  if (route === '/auctions') return <AuctionPanel state={props.readModelState} rows={props.readModel?.auctions ?? []} onCreate={props.onCreateAuction} onRefresh={props.onRefreshReadModel} activeAuctionId={props.activeAuctionId} auctionActionStatus={props.auctionActionStatus} onAuctionAction={props.onAuctionAction} />;
  if (route === '/standing-bids') return <StandingBidPanel state={props.readModelState} rows={props.readModel?.standingBids ?? []} onCreate={props.onCreateStandingBid} onRefresh={props.onRefreshReadModel} />;
  if (route === '/dashboard') return <DataTable state={props.readModelState} title="Portfolio activity" columns={['Activity', 'Asset', 'Amount', 'State', 'Transaction']} statusColumn={3} rows={props.readModel?.activity.map((row) => [row.id, row.asset, row.amount, row.state, row.transaction]) ?? [['—', 'No activity yet', '—', 'Ready', '—']]} onRefresh={props.onRefreshReadModel} />;
  if (route === '/facility') return <FacilityPanel onConnect={props.onConnect} state={props.readModelState} facility={props.readModel?.facility} onRefresh={props.onRefreshReadModel} onWithdraw={props.onRequestFacilityWithdrawal} />;
  if (route === '/liquidations') return <LiquidationPanel onConnect={props.onConnect} state={props.readModelState} opportunities={props.readModel?.opportunities ?? []} onRefresh={props.onRefreshReadModel} />;
  return <CuratorPanel onConnect={props.onConnect} />;
}

function LiveFccProofPanel(): ReactElement | null {
  const proof = RUNTIME.__FLARE_LIVE_PROOF__;
  if (!proof) return null;
  return (
    <div className="quote-review" aria-label="Live FCC settlement proof">
      <div className="quote-review__header"><span className="eyebrow">LIVE COSTON2 FCC</span><span className="tag tag--green">66283 isolated router</span></div>
      {liveFccProofRows(proof).map(([label, value]) => (
        <div className="review-row" key={label}><span>{label}</span><strong>{value}</strong></div>
      ))}
    </div>
  );
}

function QuoteReview({ quote, transactionHash, transactionState }: { readonly quote: ImmediateQuote; readonly transactionHash: string | null; readonly transactionState: TransactionState }): ReactElement {
  return <div className="quote-review" aria-label="Quote review"><div className="quote-review__header"><span className="eyebrow">QUOTE REVIEW</span><span className="tag tag--green">{transactionStateLabel(transactionState)}</span></div><div className="review-row"><span>Gross receive</span><strong>{formatTokenAmount(quote.grossOutput, quote.receiveAsset.decimals)} {quote.receiveAsset.symbol}</strong></div><div className="review-row"><span>Protocol fee · {quote.protocolFeeBps} bps</span><strong>− {formatTokenAmount(quote.protocolFee, quote.receiveAsset.decimals)} {quote.receiveAsset.symbol}</strong></div><div className="review-row"><span>Minimum net receive</span><strong>{formatTokenAmount(quote.minimumReceive, quote.receiveAsset.decimals)} {quote.receiveAsset.symbol}</strong></div>{transactionHash ? <a className="transaction-link" href={`https://coston2-explorer.flare.network/tx/${transactionHash}`} target="_blank" rel="noreferrer">View transaction {transactionHash.slice(0, 10)}…</a> : null}</div>;
}

function AuctionPanel({ state, rows, onCreate, onRefresh, activeAuctionId, auctionActionStatus, onAuctionAction }: { readonly state: ReadModelState; readonly rows: readonly FlareReadModel['auctions'][number][]; readonly onCreate: RouteContentProps['onCreateAuction']; readonly onRefresh: () => Promise<void>; readonly activeAuctionId: string; readonly auctionActionStatus: AuctionActionStatus; readonly onAuctionAction: RouteContentProps['onAuctionAction'] }): ReactElement {
  const [pair, setPair] = useState('RWA / USDX');
  const [duration, setDuration] = useState<'24h' | '1w' | '1m' | '3m'>('24h');
  const [minOutput, setMinOutput] = useState('995');
  const [earlyCloseAllowed, setEarlyCloseAllowed] = useState(false);
  const [role, setRole] = useState<AuctionRole>('seller');
  const [auctionId, setAuctionId] = useState(activeAuctionId);
  const [bidAmount, setBidAmount] = useState('1000');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (activeAuctionId) setAuctionId(activeAuctionId); }, [activeAuctionId]);
  async function submit(): Promise<void> {
    setBusy(true);
    try { await onCreate({ pair, duration, minOutput, earlyCloseAllowed }); } finally { setBusy(false); }
  }
  const tableRows = rows.length ? rows.map((row) => [row.id, row.pair, row.status, String(row.bids), new Date(row.expiry * 1_000).toLocaleString()]) : [['—', 'No auctions loaded', 'Connect wallet', '—', '—']];
  const actionBusy = auctionActionStatus.state === 'submitting';
  const actionLabel = auctionActionStatusLabel(auctionActionStatus);
  const transactionHash = 'transactionHash' in auctionActionStatus ? auctionActionStatus.transactionHash : undefined;
  return <div className="grid grid--two"><section className="panel"><div className="panel__header"><div><p className="eyebrow">CONFIDENTIAL PRICE DISCOVERY</p><h2>Open an auction</h2></div><span className="tag tag--blue">Ciphertext-only relay</span></div><label>Pair<input aria-label="Auction pair" value={pair} onChange={(event) => setPair(event.target.value)} /></label><label className="field-spaced">Minimum output<input aria-label="Auction minimum output" inputMode="decimal" value={minOutput} onChange={(event) => setMinOutput(event.target.value)} /></label><label className="field-spaced">Duration<select aria-label="Auction duration" value={duration} onChange={(event) => setDuration(event.target.value as typeof duration)}><option value="24h">24 hours</option><option value="1w">1 week</option><option value="1m">1 month</option><option value="3m">3 months</option></select></label><label className="check-row field-spaced"><input aria-label="Allow early close" type="checkbox" checked={earlyCloseAllowed} onChange={(event) => setEarlyCloseAllowed(event.target.checked)} /> Allow policy-bound early close</label><button className="button button--primary" disabled={busy} type="button" onClick={() => { void submit(); }}>{busy ? 'Opening…' : 'Open confidential auction'}</button><p className="helper">Pair, duration, minimum output, and early-close policy are encrypted before the blind relay receives them. Only commitment metadata and bid count enter the read model.</p><div className="subsection"><p className="eyebrow">ROLE CHECKPOINTS</p><label>Act as<select aria-label="Auction role" value={role} onChange={(event) => setRole(event.target.value as AuctionRole)}><option value="seller">Seller</option><option value="lp-a">LP-A</option><option value="lp-b">LP-B</option></select></label><label className="field-spaced">Auction ID<input aria-label="Auction ID" value={auctionId} onChange={(event) => setAuctionId(event.target.value)} placeholder="Created auction ID" /></label>{role !== 'seller' ? <label className="field-spaced">Bid amount<input aria-label="Bid amount" inputMode="decimal" value={bidAmount} onChange={(event) => setBidAmount(event.target.value)} /></label> : null}<div className="button-row field-spaced">{role !== 'seller' ? <button className="button button--secondary" disabled={actionBusy} type="button" onClick={() => { void onAuctionAction({ action: 'bid', role, auctionId, bidAmount }); }}>{actionBusy ? 'Encrypting…' : `Submit encrypted ${role.toUpperCase()} bid`}</button> : <button className="button button--secondary" disabled={actionBusy} type="button" onClick={() => { void onAuctionAction({ action: 'finalize', role, auctionId }); }}>{actionBusy ? 'Finalizing…' : 'Finalize auction'}</button>}<button className="button button--secondary" disabled={actionBusy || !auctionId} type="button" onClick={() => { void onAuctionAction({ action: 'relay', role: 'seller', auctionId }); }}>Relay FCC result</button></div><p aria-live="polite" className="helper">{actionLabel}</p><div className="metric-list"><div className="metric"><span>Instruction ID</span><strong>Awaiting Coston2 indexer</strong></div><div className="metric"><span>Transaction</span><strong>{transactionHash ? <a className="transaction-link" href={`https://coston2-explorer.flare.network/tx/${transactionHash}`} target="_blank" rel="noreferrer">{transactionHash.slice(0, 12)}…</a> : 'Awaiting wallet confirmation'}</strong></div><div className="metric"><span>Quorum</span><strong>{auctionActionStatus.state === 'finalized' ? auctionActionStatus.quorum ?? '2-of-3 pending' : '—'}</strong></div><div className="metric"><span>Route hash</span><strong>Hidden until matching</strong></div></div></div></section><DataTable state={state} title="Confidential auctions" columns={['Auction', 'Pair', 'Status', 'Bids', 'Expiry']} statusColumn={2} rows={tableRows} onRefresh={onRefresh} /></div>;
}

function StandingBidPanel({ state, rows, onCreate, onRefresh }: { readonly state: ReadModelState; readonly rows: readonly FlareReadModel['standingBids'][number][]; readonly onCreate: RouteContentProps['onCreateStandingBid']; readonly onRefresh: () => Promise<void> }): ReactElement {
  const [pair, setPair] = useState('RWA / USDX');
  const [capacity, setCapacity] = useState('1');
  const [mode, setMode] = useState<'instant' | 'partial' | 'fok'>('instant');
  const [busy, setBusy] = useState(false);
  async function submit(): Promise<void> {
    setBusy(true);
    try { await onCreate({ pair, capacity, mode, expiry: Math.floor(Date.now() / 1_000) + 86_400 }); } finally { setBusy(false); }
  }
  const tableRows = rows.length ? rows.map((row) => [row.pair, row.capacity, row.mode, new Date(row.expiry * 1_000).toLocaleString(), row.status]) : [['—', 'Create a scoped bid', 'Instant', '—', 'Ready']];
  return <div className="grid grid--two"><section className="panel"><div className="panel__header"><div><p className="eyebrow">COMMITTED LP CAPACITY</p><h2>Create a standing bid</h2></div><span className="tag tag--green">Wallet-owned</span></div><label>Pair<input aria-label="Standing bid pair" value={pair} onChange={(event) => setPair(event.target.value)} /></label><label className="field-spaced">Capacity<input aria-label="Standing bid capacity" inputMode="decimal" value={capacity} onChange={(event) => setCapacity(event.target.value)} /></label><label className="field-spaced">Fill mode<select aria-label="Standing bid mode" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="instant">Instant</option><option value="partial">Partial</option><option value="fok">Fill-or-kill</option></select></label><button className="button button--primary" disabled={busy} type="button" onClick={() => { void submit(); }}>{busy ? 'Creating…' : 'Create standing bid'}</button><p className="helper">The API stores public scope only. Transaction signatures stay in the connected wallet.</p></section><DataTable state={state} title="Standing bid book" columns={['Pair', 'Capacity', 'Mode', 'Expiry', 'Status']} statusColumn={4} rows={tableRows} onRefresh={onRefresh} /></div>;
}

function DataTable({ state = 'empty', title, columns, statusColumn, rows, onRefresh }: { state?: ReadModelState; title: string; columns: readonly string[]; statusColumn?: number; rows: readonly (readonly string[])[]; onRefresh?: () => Promise<void> }): ReactElement {
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<{ readonly column: number; readonly direction: 'asc' | 'desc' } | null>(null);
  const visibleState: ReadModelState = refreshing ? 'loading' : state;
  const stateLabel = readModelStateLabel(visibleState);
  const sortedRows = sort ? sortTableRows(rows, sort.column, sort.direction) : rows;

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      if (onRefresh) await onRefresh();
      else await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    } finally {
      setRefreshing(false);
    }
  }

  return <section aria-busy={visibleState === 'loading'} className="panel"><div className="panel__header"><div><p className="eyebrow">READ MODEL</p><h2>{title}</h2></div><div className="panel__actions"><span aria-label={`${title}: ${stateLabel}`} className="tag tag--gray" role="status">{stateLabel}</span><button aria-label={`Refresh ${title}`} className="button button--secondary" disabled={refreshing} type="button" onClick={() => { void refresh(); }}>{refreshing ? 'Refreshing…' : 'Refresh'}</button></div></div><div className="table-wrap" tabIndex={0}><table><thead><tr>{columns.map((column, columnIndex) => { const direction = sort?.column === columnIndex ? sort.direction : undefined; return <th key={column} aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}><button className="table-sort" type="button" aria-label={`Sort by ${column}`} onClick={() => setSort({ column: columnIndex, direction: direction === 'asc' ? 'desc' : 'asc' })}>{column}{direction === 'asc' ? ' ↑' : direction === 'desc' ? ' ↓' : ''}</button></th>; })}</tr></thead><tbody>{sortedRows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cellIndex === statusColumn ? <span className="tag tag--gray">{cell}</span> : cell}</td>)}</tr>)}</tbody></table></div><p className="empty-copy">{stateLabel}. Sensitive RFQ and losing-bid plaintext never appears in this read model.</p></section>;
}

function FacilityPanel({ onConnect, state, facility, onRefresh, onWithdraw }: { readonly onConnect: () => Promise<void>; readonly state: ReadModelState; readonly facility?: FlareReadModel['facility']; readonly onRefresh: () => Promise<void>; readonly onWithdraw: RouteContentProps['onRequestFacilityWithdrawal'] }): ReactElement {
  const [shares, setShares] = useState('');
  const [minAssets, setMinAssets] = useState('');
  const [busy, setBusy] = useState(false);
  async function submitWithdrawal(): Promise<void> {
    setBusy(true);
    try { await onWithdraw({ shares, minAssets }); setShares(''); setMinAssets(''); } finally { setBusy(false); }
  }
  return <div className="grid grid--two"><section className="panel"><p className="eyebrow">DEPOSITOR</p><h2>Facility position</h2><div className="metric-list"><div className="metric"><span>Shares</span><strong>{facility?.shares ?? '—'}</strong></div><div className="metric"><span>Verified NAV</span><strong>{facility?.nav ?? '—'}</strong></div><div className="metric"><span>Withdrawal queue</span><strong>{facility?.queuedWithdrawals ?? 0} requests</strong></div></div><button className="button button--primary" type="button" onClick={() => { void onConnect(); }}>Connect to deposit</button><div className="subsection"><p className="eyebrow">QUEUED WITHDRAWAL</p><label>Shares<input aria-label="Withdrawal shares" inputMode="decimal" value={shares} onChange={(event) => setShares(event.target.value)} placeholder="0.00" /></label><label className="field-spaced">Minimum assets<input aria-label="Withdrawal minimum assets" inputMode="decimal" value={minAssets} onChange={(event) => setMinAssets(event.target.value)} placeholder="0.00" /></label><button className="button button--secondary button--full" disabled={busy} type="button" onClick={() => { void submitWithdrawal(); }}>{busy ? 'Queueing…' : 'Queue withdrawal'}</button></div></section><section className="panel"><div className="panel__header"><div><p className="eyebrow">RISK DISCLOSURE</p><h2>Liquidity is explicit</h2></div><button aria-label="Refresh facility read model" className="button button--secondary" type="button" onClick={() => { void onRefresh(); }}>{state === 'loading' ? 'Refreshing…' : 'Refresh'}</button></div><p className="body-copy">Synchronous withdrawal is available only when idle or immediately withdrawable liquidity exists. Otherwise shares lock in a queued request with a minimum-assets bound.</p><span className="tag tag--amber">FDC / FTSO freshness required</span></section></div>;
}

function CuratorPanel({ onConnect, adapters }: { readonly onConnect: () => Promise<void>; readonly adapters?: readonly import('./model').CuratorAdapterEntry[] }): ReactElement {
  const summary = curatorAdapterSummary(adapters);
  return <div className="grid grid--two"><section className="panel"><p className="eyebrow">CURATOR CONTROLS</p><h2>Approved policy</h2><div className="metric-list"><div className="metric"><span>Adapters</span><strong>{summary.enabledLabel}</strong></div><div className="metric"><span>Haircut range</span><strong>{summary.haircutLabel}</strong></div><div className="metric"><span>Guardian</span><strong>{summary.guardianLabel}</strong></div></div><button className="button button--secondary" type="button" onClick={() => { void onConnect(); }}>Connect authorized wallet</button></section><section className="panel"><p className="eyebrow">SAFETY BOUNDARY</p><h2>No arbitrary calls</h2><p className="body-copy">Facilities can allocate only through governance-whitelisted adapters. Curators cannot upgrade contracts, withdraw user assets, or redirect settlement. Enabled venues: {summary.enabledVenues.length ? summary.enabledVenues.join(', ') : 'none'}.</p><span className="tag tag--red">Review before enabling exposure</span></section></div>;
}

function LiquidationPanel({ onConnect, state, opportunities, onRefresh }: { readonly onConnect: () => Promise<void>; readonly state: ReadModelState; readonly opportunities: readonly NonNullable<FlareReadModel['opportunities']>[number][]; readonly onRefresh: () => Promise<void> }): ReactElement {
  const [venue, setVenue] = useState('');
  const [market, setMarket] = useState('');
  const [position, setPosition] = useState('');
  const [maxRepay, setMaxRepay] = useState('');
  const [grossCollateral, setGrossCollateral] = useState('');
  const [minimumCollateral, setMinimumCollateral] = useState('');
  const [review, setReview] = useState<ReturnType<typeof buildLiquidationRouteReview> | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reviewRoute(): void {
    setError(null);
    try {
      const gross = BigInt(grossCollateral);
      const fee = (gross * 50n) / 10_000n;
      setReview(buildLiquidationRouteReview({
        venue,
        market,
        position,
        debtAsset: 'USDX',
        collateralAsset: 'RWA',
        maxRepay: BigInt(maxRepay),
        grossCollateral: gross,
        protocolFee: fee,
        minNetCollateral: BigInt(minimumCollateral),
        recipient: 'connected-wallet',
      }));
    } catch (nextError) {
      setReview(null);
      setError(nextError instanceof Error ? nextError.message : 'LIQUIDATION_REVIEW');
    }
  }

  return <div className="grid grid--two">
    <section className="panel">
      <div className="panel__header"><div><p className="eyebrow">ATOMIC LIQUIDATION</p><h2>Review a venue route</h2></div><span className="tag tag--amber">Verified venue required</span></div>
      <p className="body-copy">A keeper may discover an opportunity, but execution requires a verified venue, market, position, debt asset, collateral asset, and recipient-bound route. Arbitrary targets are never accepted.</p>
      <label>Venue address<input aria-label="Liquidation venue" value={venue} onChange={(event) => setVenue(event.target.value)} placeholder="Verified deployment address" /></label>
      <label className="field-spaced">Market address<input aria-label="Liquidation market" value={market} onChange={(event) => setMarket(event.target.value)} placeholder="Verified market address" /></label>
      <label className="field-spaced">Position identifier<input aria-label="Liquidation position" value={position} onChange={(event) => setPosition(event.target.value)} placeholder="bytes32 position" /></label>
      <div className="form-grid field-spaced"><label>Maximum repay<input aria-label="Maximum repay" inputMode="numeric" value={maxRepay} onChange={(event) => setMaxRepay(event.target.value)} placeholder="0" /></label><label>Gross collateral<input aria-label="Gross collateral" inputMode="numeric" value={grossCollateral} onChange={(event) => setGrossCollateral(event.target.value)} placeholder="0" /></label></div>
      <label className="field-spaced">Minimum net collateral<input aria-label="Minimum net collateral" inputMode="numeric" value={minimumCollateral} onChange={(event) => setMinimumCollateral(event.target.value)} placeholder="0" /></label>
      {error ? <p className="quote-error" role="alert">Route review: {error}</p> : null}
      <button className="button button--primary" type="button" onClick={reviewRoute}>Review atomic route</button>
      <button className="button button--secondary button--full" type="button" onClick={() => { void onConnect(); }}>Connect authorized liquidator</button>
    </section>
    <section className="panel">
      <div className="panel__header"><div><p className="eyebrow">ROUTE RESULT</p><h2>Winner-bound delivery</h2></div><span className="tag tag--gray">{opportunities.length ? `${opportunities.length} indexed` : 'No live opportunity'}</span></div>
      {review ? <div className="quote-review" aria-label="Liquidation route review"><div className="review-row"><span>Gross collateral</span><strong>{review.grossCollateral.toString()}</strong></div><div className="review-row"><span>Protocol fee · 50 bps</span><strong>− {review.protocolFee.toString()}</strong></div><div className="review-row"><span>Net collateral</span><strong>{review.netCollateral.toString()}</strong></div><div className="review-row"><span>Minimum net collateral</span><strong>{review.minNetCollateral.toString()}</strong></div><span className="tag tag--green">Ready for verified route binding</span></div> : <p className="empty-copy">No verified Morpho, Kinetic, or other venue opportunity is connected. Indexed public routes appear below when the local indexer snapshot has finalized events. This screen will not construct a transaction from unverified addresses.</p>}
      <DataTable state={state} title="Indexed opportunities" columns={['Id', 'Kind', 'Pair', 'Status', 'Amount', 'Transaction', 'Venue', 'Market']} statusColumn={3} rows={indexedOpportunityRows(opportunities).length ? indexedOpportunityRows(opportunities) : [['—', '—', 'No indexed opportunity', 'Ready', '—', '—', '—', '—']]} onRefresh={onRefresh} />
    </section>
  </div>;
}

function quoteErrorLabel(code: string): string {
  const labels: Record<string, string> = {
    ASSET_NOT_ELIGIBLE: 'Choose eligible RWA and USDX assets on Coston2.',
    ASSET_PAIR: 'Sell and receive assets must be different.',
    AMOUNT_FORMAT: 'Enter an amount using digits and an optional decimal point.',
    AMOUNT_PRECISION: 'The amount has more decimals than the asset supports.',
    QUOTE_AMOUNT: 'Enter a positive amount and minimum receive.',
    DEMO_ROUTE_EXACT_AMOUNT: 'The deployed demo source supports exactly 1 RWA per quote.',
    MINIMUM_RECEIVE_TOO_HIGH: 'Minimum receive exceeds the quoted net output.',
  };
  return labels[code] ?? code;
}

async function buildDemoSwapTransaction(
  provider: Eip1193Provider,
  wallet: FlareWalletConnection,
  quote: ImmediateQuote,
): Promise<UnsignedWalletTransaction> {
  const latestValue = await provider.request({ method: 'eth_blockNumber' });
  if (typeof latestValue !== 'string') throw new Error('BLOCK_NUMBER_INVALID');
  const latest = BigInt(latestValue);
  if (latest < 1n) throw new Error('BLOCK_SNAPSHOT');
  const decisionBlock = latest - 1n;
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: [`0x${decisionBlock.toString(16)}`, false] });
  const decisionBlockHash = typeof block === 'object' && block !== null && 'hash' in block && typeof block.hash === 'string'
    ? block.hash as Hex
    : null;
  if (!decisionBlockHash) throw new Error('DECISION_BLOCK_HASH');
  const commitment = keccak256(stringToHex(`trustrfq:coston2:${wallet.address}:${Date.now()}`));
  const route = buildUnsignedSwapRouteTransaction({
    router: DEMO_ROUTER,
    chainId: 114,
    commitment,
    fccActionId: commitment,
    decisionBlock,
    decisionBlockHash,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    seller: wallet.address,
    recipient: wallet.address,
    sellToken: quote.sellAsset.address as `0x${string}`,
    buyToken: quote.receiveAsset.address as `0x${string}`,
    sellAmount: quote.sellAmount,
    minOutput: quote.minimumReceive,
    protocolFeeBps: quote.protocolFeeBps,
    eligibilityPolicyId: DEMO_POLICY,
    eligibilityRevocationEpoch: 0n,
    eligibilityRole: COSTON2_MOCK_ASSETS.policyRole,
    eligibilityIssuerReference: DEMO_ISSUER,
    legs: [{ source: DEMO_SOURCE, sellAmount: quote.sellAmount, minOutput: quote.grossOutput, sourceData: '0x' }],
  });
  return { from: wallet.address, ...route };
}

async function waitForReceipt(provider: Eip1193Provider, hash: Hex): Promise<ReceiptResult> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (typeof receipt === 'object' && receipt !== null && 'status' in receipt && typeof receipt.status === 'string') {
      return { status: receipt.status === '0x1' ? 'success' : 'reverted' };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('RECEIPT_TIMEOUT');
}

async function waitForIndexer(hash: Hex): Promise<void> {
  const indexerUrl = (window as Window & { __FLARE_INDEXER_URL__?: string }).__FLARE_INDEXER_URL__ ?? API_BASE_URL;
  await waitForIndexedConfirmation(async (candidate) => {
    const response = await fetch(`${indexerUrl}/v1/transactions/${candidate}`);
    if (!response.ok) return false;
    const body = await response.json() as { indexed?: unknown };
    return body.indexed === true;
  }, hash, { intervalMs: 1_000, maxAttempts: 60 });
}
