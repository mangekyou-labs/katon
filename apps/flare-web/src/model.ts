import { COSTON2_MOCK_ASSETS } from '../../../packages/flare-contracts/src/index';

export const NAVIGATION = [
  { href: '/swap', label: 'Swap / Redeem', eyebrow: 'Immediate and scheduled liquidity' },
  { href: '/auctions', label: 'Auctions', eyebrow: 'Confidential price discovery' },
  { href: '/standing-bids', label: 'Standing Bids', eyebrow: 'Committed LP capacity' },
  { href: '/dashboard', label: 'Dashboard', eyebrow: 'Wallet and activity' },
  { href: '/facility', label: 'Facility', eyebrow: 'Positions and withdrawals' },
  { href: '/liquidations', label: 'Liquidations', eyebrow: 'Typed atomic venue routes' },
  { href: '/curator', label: 'Curator', eyebrow: 'Policy and adapters' },
] as const;

export type AuctionActionStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'submitting'; readonly auctionId: string }
  | { readonly state: 'created' | 'bid-submitted' | 'finalized'; readonly auctionId: string; readonly quorum?: string; readonly transactionHash?: string }
  | { readonly state: 'error'; readonly auctionId?: string; readonly message: string };

export function auctionActionStatusLabel(status: AuctionActionStatus): string {
  if (status.state === 'error') return status.message;
  if (status.state === 'finalized') return `Finalized · ${status.quorum ?? 'quorum pending'}`;
  if (status.state === 'bid-submitted') return 'Encrypted bid submitted';
  if (status.state === 'created') return 'CREATE ready for FCC dispatch';
  if (status.state === 'submitting') return 'Submitting encrypted action…';
  return 'No FCC action yet';
}

export interface AssetOption {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly chainId: number;
  readonly eligible: boolean;
}

export const DEMO_ASSETS: readonly AssetOption[] = [
  {
    address: COSTON2_MOCK_ASSETS.rwa,
    symbol: 'RWA',
    decimals: 18,
    chainId: 114,
    eligible: true,
  },
  {
    address: COSTON2_MOCK_ASSETS.usdx,
    symbol: 'USDX',
    decimals: 18,
    chainId: 114,
    eligible: true,
  },
];

export function assetOptionFor(value: string, assets: readonly AssetOption[] = DEMO_ASSETS): AssetOption | undefined {
  const needle = value.trim().toLowerCase();
  return assets.find((asset) => asset.chainId === 114 && asset.eligible && (asset.symbol.toLowerCase() === needle || asset.address.toLowerCase() === needle));
}

export function assetAddressLabel(address: string): string {
  const normalized = address.trim();
  if (normalized.length <= 14) return normalized;
  return `${normalized.slice(0, 7)}…${normalized.slice(-8)}`;
}

export function sortTableRows<T extends readonly string[]>(rows: readonly T[], column: number, direction: 'asc' | 'desc'): T[] {
  if (!Number.isInteger(column) || column < 0) throw new Error('TABLE_SORT_COLUMN');
  return [...rows].sort((left, right) => {
    const a = left[column] ?? '';
    const b = right[column] ?? '';
    const result = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'asc' ? result : -result;
  });
}

export interface ImmediateQuoteInput {
  readonly sellAsset: string;
  readonly receiveAsset: string;
  readonly amount: string;
  readonly minimumReceive: string;
  readonly assets?: readonly AssetOption[];
}

export interface ImmediateQuote {
  readonly sellAsset: AssetOption;
  readonly receiveAsset: AssetOption;
  readonly sellAmount: bigint;
  readonly grossOutput: bigint;
  readonly protocolFee: bigint;
  readonly netOutput: bigint;
  readonly minimumReceive: bigint;
  readonly protocolFeeBps: number;
  readonly route: 'standing-lp';
  readonly status: 'ready';
}

export function buildImmediateQuote(input: ImmediateQuoteInput): ImmediateQuote {
  const assets = input.assets ?? DEMO_ASSETS;
  const sellAsset = findEligibleAsset(assets, input.sellAsset);
  const receiveAsset = findEligibleAsset(assets, input.receiveAsset);
  if (!sellAsset || !receiveAsset) throw new Error('ASSET_NOT_ELIGIBLE');
  if (sellAsset.address.toLowerCase() === receiveAsset.address.toLowerCase()) throw new Error('ASSET_PAIR');

  const sellAmount = parseDisplayAmount(input.amount, sellAsset.decimals);
  const minimumReceive = parseDisplayAmount(input.minimumReceive, receiveAsset.decimals);
  if (sellAmount <= 0n || minimumReceive <= 0n) throw new Error('QUOTE_AMOUNT');

  // The deployed Coston2 fixture uses a deterministic 1 RWA -> 1,000 USDX
  // source. Keep this quote deliberately explicit until a live quote reader is wired.
  if (sellAsset.symbol !== 'RWA' || receiveAsset.symbol !== 'USDX' || sellAmount !== 10n ** 18n) {
    throw new Error('DEMO_ROUTE_EXACT_AMOUNT');
  }
  const grossOutput = 1_000n * 10n ** BigInt(receiveAsset.decimals);
  const protocolFeeBps = 50;
  const protocolFee = (grossOutput * BigInt(protocolFeeBps)) / 10_000n;
  const netOutput = grossOutput - protocolFee;
  if (minimumReceive > netOutput) throw new Error('MINIMUM_RECEIVE_TOO_HIGH');

  return {
    sellAsset,
    receiveAsset,
    sellAmount,
    grossOutput,
    protocolFee,
    netOutput,
    minimumReceive,
    protocolFeeBps,
    route: 'standing-lp',
    status: 'ready',
  };
}

function findEligibleAsset(assets: readonly AssetOption[], value: string): AssetOption | undefined {
  const needle = value.trim().toLowerCase();
  return assets.find((asset) => asset.chainId === 114 && asset.eligible && (
    asset.symbol.toLowerCase() === needle || asset.address.toLowerCase() === needle
  ));
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals < 0 || !Number.isInteger(decimals)) throw new Error('AMOUNT_DECIMALS');
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function filterAssetOptions(
  options: readonly AssetOption[],
  query: string,
  chainId: number,
): AssetOption[] {
  const needle = query.trim().toLowerCase();
  return options.filter((option) => (
    option.chainId === chainId
    && option.eligible
    && (needle.length === 0
      || option.symbol.toLowerCase().includes(needle)
      || option.address.toLowerCase().includes(needle))
  ));
}

export function parseDisplayAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('AMOUNT_DECIMALS');
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) throw new Error('AMOUNT_FORMAT');

  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new Error('AMOUNT_PRECISION');
  const scale = 10n ** BigInt(decimals);
  const paddedFraction = fraction.padEnd(decimals, '0');
  return BigInt(whole) * scale + BigInt(paddedFraction || '0');
}

export function balanceShortcut(spendableBalance: bigint, percent: 25 | 50 | 100): bigint {
  if (spendableBalance < 0n) throw new Error('BALANCE_NEGATIVE');
  if (percent !== 25 && percent !== 50 && percent !== 100) throw new Error('BALANCE_PERCENT');
  return (spendableBalance * BigInt(percent)) / 100n;
}

export function spendableBalance(balance: bigint, reserved: bigint): bigint {
  if (balance < 0n || reserved < 0n) throw new Error('BALANCE_NEGATIVE');
  return balance > reserved ? balance - reserved : 0n;
}

export function balanceShortcutWithReserve(
  balance: bigint,
  reserved: bigint,
  percent: 25 | 50 | 100,
): bigint {
  return balanceShortcut(spendableBalance(balance, reserved), percent);
}

export interface LiquidationRouteReviewInput {
  readonly venue: string;
  readonly market: string;
  readonly position: string;
  readonly debtAsset: string;
  readonly collateralAsset: string;
  readonly maxRepay: bigint;
  readonly grossCollateral: bigint;
  readonly protocolFee: bigint;
  readonly minNetCollateral: bigint;
  readonly recipient: string;
}

export interface LiquidationRouteReview extends LiquidationRouteReviewInput {
  readonly netCollateral: bigint;
  readonly status: 'ready';
}

export function buildLiquidationRouteReview(input: LiquidationRouteReviewInput): LiquidationRouteReview {
  if (
    !input.venue || !input.market || !input.position || !input.debtAsset || !input.collateralAsset
    || !input.recipient || input.maxRepay <= 0n || input.grossCollateral <= 0n
    || input.protocolFee < 0n || input.protocolFee > input.grossCollateral
  ) throw new Error('LIQUIDATION_REVIEW');
  const netCollateral = input.grossCollateral - input.protocolFee;
  if (netCollateral < input.minNetCollateral) throw new Error('LIQUIDATION_MIN_OUTPUT');
  return { ...input, netCollateral, status: 'ready' };
}

export type TransactionState =
  | 'ready'
  | 'awaiting-signature'
  | 'submitted'
  | 'confirmed'
  | 'indexed'
  | 'reverted'
  | 'cancelled'
  | 'expired';

export function transactionStateLabel(state: TransactionState): string {
  const labels: Record<TransactionState, string> = {
    ready: 'Ready for review',
    'awaiting-signature': 'Awaiting wallet signature',
    submitted: 'Submitted — awaiting confirmation',
    confirmed: 'Confirmed on Flare',
    indexed: 'Indexed in the read model',
    reverted: 'Reverted — no settlement applied',
    cancelled: 'Cancelled',
    expired: 'Expired',
  };
  return labels[state];
}

export type ReadModelState =
  | 'loading'
  | 'empty'
  | 'ready'
  | 'stale'
  | 'offline'
  | 'error'
  | 'fcc-matching'
  | 'queued-redemption';

export interface ReadModelStateInput {
  readonly state: 'ready' | 'empty' | 'offline' | 'error';
  readonly updatedAt: number;
  readonly facility: { readonly queuedWithdrawals: number };
}

export interface IndexedOpportunity {
  readonly id: string;
  readonly kind: 'swap' | 'liquidation' | 'fill';
  readonly pair: string;
  readonly status: string;
  readonly amount: string;
  readonly transaction: string;
  readonly venue?: string;
  readonly market?: string;
}

export function indexedOpportunityRows(opportunities: readonly IndexedOpportunity[] | undefined): string[][] {
  if (!opportunities?.length) return [];
  return opportunities.map((row) => [
    row.id,
    row.kind,
    row.pair,
    row.status,
    row.amount,
    row.transaction,
    row.venue ?? '—',
    row.market ?? '—',
  ]);
}

export function deriveReadModelState(input: ReadModelStateInput, now = Date.now()): ReadModelState {
  if (input.state === 'offline' || input.state === 'error' || input.state === 'empty') return input.state;
  if (input.facility.queuedWithdrawals > 0) return 'queued-redemption';
  return now - input.updatedAt > 60_000 ? 'stale' : 'ready';
}

export function readModelStateLabel(state: ReadModelState): string {
  const labels: Record<ReadModelState, string> = {
    loading: 'Loading',
    empty: 'No data yet',
    ready: 'Ready',
    stale: 'Stale — refresh required',
    offline: 'Offline — retry when connected',
    error: 'Unable to load — retry',
    'fcc-matching': 'FCC matching in progress',
    'queued-redemption': 'Redemption queued',
  };
  return labels[state];
}

export type AppRoute = (typeof NAVIGATION)[number]['href'];

export function currentRoute(pathname: string): AppRoute {
  return NAVIGATION.find((item) => item.href === pathname)?.href ?? '/swap';
}

/** Curator adapter registry entry (governance-configured; never invents live venues). */
export interface CuratorAdapterEntry {
  readonly id: string;
  readonly venue: 'morpho' | 'kinetic' | 'clearpool';
  readonly role: 'yield' | 'liquidation';
  readonly enabled: boolean;
}

/**
 * Default local registry: adapter kinds are known, none are enabled until
 * governance registers a verified deployment. Clearpool is yield-only.
 */
export const DEFAULT_CURATOR_ADAPTERS: readonly CuratorAdapterEntry[] = [
  { id: 'morpho-yield', venue: 'morpho', role: 'yield', enabled: false },
  { id: 'kinetic-yield', venue: 'kinetic', role: 'yield', enabled: false },
  { id: 'clearpool-yield', venue: 'clearpool', role: 'yield', enabled: false },
  { id: 'morpho-liquidation', venue: 'morpho', role: 'liquidation', enabled: false },
  { id: 'kinetic-liquidation', venue: 'kinetic', role: 'liquidation', enabled: false },
];

export interface CuratorAdapterSummary {
  readonly enabledCount: number;
  readonly enabledLabel: string;
  readonly enabledVenues: readonly string[];
  readonly haircutLabel: string;
  readonly guardianLabel: string;
}

export function curatorAdapterSummary(
  adapters: readonly CuratorAdapterEntry[] = DEFAULT_CURATOR_ADAPTERS,
): CuratorAdapterSummary {
  const enabled = adapters.filter((entry) => entry.enabled);
  const venues = [...new Set(enabled.map((entry) => entry.venue))];
  return {
    enabledCount: enabled.length,
    enabledLabel: `${enabled.length} enabled`,
    enabledVenues: venues,
    haircutLabel: 'Governance bounded',
    guardianLabel: 'Pause only',
  };
}

/** Decimal precision used by the simulated confidential RFQ lane on Coston2. */
export const SIM_ASSET_DECIMALS = 18;

/**
 * Builds the plaintext for the simulated relay auction envelope. The blind relay's
 * simulated finalize matcher (createSimFinalizeMatch) revives exactly this shape, so the
 * UI must encrypt a matcher-compatible payload — display-only JSON would strand finalize.
 */
export function buildSimAuctionEnvelopePayload(input: {
  readonly commitment: string;
  readonly router: string;
  readonly sellToken: string;
  readonly buyToken: string;
  readonly sellAmount: string;
  readonly minOutput: string;
  readonly decisionDeadline: number;
  readonly routePlan: unknown;
  readonly seller: string;
  readonly pair: string;
  readonly duration: string;
}): {
  readonly auction: { readonly commitment: string; readonly chainId: number; readonly router: string; readonly sellToken: string; readonly buyToken: string; readonly sellAmount: string; readonly minOutput: string; readonly decisionDeadline: number };
  readonly routePlan: unknown;
  readonly pair: string;
  readonly duration: string;
  readonly seller: string;
} {
  return {
    auction: {
      commitment: input.commitment,
      chainId: 114,
      router: input.router,
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      sellAmount: input.sellAmount,
      minOutput: parseDisplayAmount(input.minOutput, SIM_ASSET_DECIMALS).toString(),
      decisionDeadline: input.decisionDeadline,
    },
    routePlan: input.routePlan,
    pair: input.pair,
    duration: input.duration,
    seller: input.seller,
  };
}

/**
 * Builds the plaintext for a simulated relay bid envelope: a MatcherBid whose quoted
 * output is normalized to base units so it compares against the auction minimum output.
 */
export function buildSimBidEnvelopePayload(input: {
  readonly commitment: string;
  readonly bidder: string;
  readonly sellToken: string;
  readonly buyToken: string;
  readonly sellAmount: string;
  readonly bidAmount: string;
  readonly sequence: number;
  readonly expiresAt: number;
}): { readonly commitment: string; readonly bidder: string; readonly sellToken: string; readonly buyToken: string; readonly sellAmount: string; readonly quotedOutput: string; readonly sequence: number; readonly expiresAt: number } {
  return {
    commitment: input.commitment,
    bidder: input.bidder,
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    sellAmount: input.sellAmount,
    quotedOutput: parseDisplayAmount(input.bidAmount, SIM_ASSET_DECIMALS).toString(),
    sequence: input.sequence,
    expiresAt: input.expiresAt,
  };
}
