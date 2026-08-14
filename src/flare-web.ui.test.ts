import { describe, expect, it } from 'vitest';

import { COSTON2_DEPLOYMENT, COSTON2_MOCK_ASSETS } from '../packages/flare-contracts/src/index';

import {
  NAVIGATION,
  balanceShortcut,
  buildImmediateQuote,
  buildLiquidationRouteReview,
  buildSimAuctionEnvelopePayload,
  buildSimBidEnvelopePayload,
  filterAssetOptions,
  formatTokenAmount,
  parseDisplayAmount,
  readModelStateLabel,
  spendableBalance,
  balanceShortcutWithReserve,
  deriveReadModelState,
  indexedOpportunityRows,
  assetOptionFor,
  assetAddressLabel,
  sortTableRows,
  transactionStateLabel,
  curatorAdapterSummary,
  DEFAULT_CURATOR_ADAPTERS,
  type AssetOption,
  type CuratorAdapterEntry,
  type ReadModelState,
  auctionActionStatusLabel,
} from '../apps/flare-web/src/model';
import { createSimFinalizeMatch } from '../apps/flare-api/src/simFinalizeMatch';

describe('Flare application shell', () => {
  it('exposes the approved role-based routes', () => {
    expect(NAVIGATION.map((item) => item.href)).toEqual([
      '/swap',
      '/auctions',
      '/standing-bids',
      '/dashboard',
      '/facility',
      '/liquidations',
      '/curator',
    ]);
  });

  it('keeps financial transaction states explicit and non-optimistic', () => {
    expect(transactionStateLabel('awaiting-signature')).toBe('Awaiting wallet signature');
    expect(transactionStateLabel('submitted')).toBe('Submitted — awaiting confirmation');
    expect(transactionStateLabel('indexed')).toBe('Indexed in the read model');
    expect(transactionStateLabel('reverted')).toBe('Reverted — no settlement applied');
  });

  it('keeps FCC role checkpoints explicit instead of implying quorum', () => {
    expect(auctionActionStatusLabel({ state: 'created', auctionId: 'a' })).toBe('CREATE ready for FCC dispatch');
    expect(auctionActionStatusLabel({ state: 'bid-submitted', auctionId: 'a' })).toBe('Encrypted bid submitted');
    expect(auctionActionStatusLabel({ state: 'finalized', auctionId: 'a', quorum: 'pending FCC result relay' })).toContain('pending FCC result relay');
    expect(auctionActionStatusLabel({ state: 'error', message: 'FCC_RESULT_RELAY_REQUIRES_SIGNED_TEE_RESULT' })).toContain('SIGNED_TEE_RESULT');
  });

  it('keeps read-model freshness and confidential execution states explicit', () => {
    const states: ReadModelState[] = [
      'loading',
      'empty',
      'ready',
      'stale',
      'offline',
      'error',
      'fcc-matching',
      'queued-redemption',
    ];

    expect(states.map(readModelStateLabel)).toEqual([
      'Loading',
      'No data yet',
      'Ready',
      'Stale — refresh required',
      'Offline — retry when connected',
      'Unable to load — retry',
      'FCC matching in progress',
      'Redemption queued',
    ]);
  });

  it('derives stale and queued states from read-model freshness without hiding API errors', () => {
    const now = 1_000_000;
    expect(deriveReadModelState({ state: 'ready', updatedAt: now - 61_000, facility: { shares: '0', nav: '0', queuedWithdrawals: 0 } }, now)).toBe('stale');
    expect(deriveReadModelState({ state: 'ready', updatedAt: now, facility: { shares: '0', nav: '0', queuedWithdrawals: 1 } }, now)).toBe('queued-redemption');
    expect(deriveReadModelState({ state: 'offline', updatedAt: now, facility: { shares: '0', nav: '0', queuedWithdrawals: 0 } }, now)).toBe('offline');
    expect(deriveReadModelState({ state: 'error', updatedAt: now, facility: { shares: '0', nav: '0', queuedWithdrawals: 0 } }, now)).toBe('error');
  });

  it('filters eligible assets and parses display amounts without floating point', () => {
    const assets: AssetOption[] = [
      { address: '0xAAA', symbol: 'RWA', decimals: 6, chainId: 114, eligible: true },
      { address: '0xBBB', symbol: 'USDX', decimals: 6, chainId: 114, eligible: false },
      { address: '0xCCC', symbol: 'RWA', decimals: 6, chainId: 14, eligible: true },
    ];

    expect(filterAssetOptions(assets, 'rwa', 114)).toEqual([assets[0]]);
    expect(filterAssetOptions(assets, '0xaaa', 114)).toEqual([assets[0]]);
    expect(parseDisplayAmount('12.34', 6)).toBe(12_340_000n);
    expect(balanceShortcut(1_000_001n, 25)).toBe(250_000n);
    expect(() => parseDisplayAmount('12.3456789', 6)).toThrow('AMOUNT_PRECISION');
  });

  it('reserves constraints before calculating balance shortcuts', () => {
    expect(spendableBalance(1_000_001n, 1n)).toBe(1_000_000n);
    expect(balanceShortcutWithReserve(1_000_001n, 1n, 25)).toBe(250_000n);
    expect(balanceShortcutWithReserve(50n, 100n, 100)).toBe(0n);
    expect(formatTokenAmount(balanceShortcutWithReserve(5n * 10n ** 18n, 10n ** 16n, 100), 18)).toBe('4.99');
  });

  it('uses the current Coston2 proxy fixture and mock asset deployment', () => {
    expect(COSTON2_DEPLOYMENT.router).toBe('0x7fA1817951dE405a0c466696052cF50Eba409333');
    expect(COSTON2_MOCK_ASSETS).toMatchObject({
      chainId: 114,
      rwa: '0xdeca491298a0e9f00d87d0390565cc33b3ac336f',
      usdx: '0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0',
      source: '0x29713643c62c6743a5bf68e39ac1de8eaec0bc97',
    });
  });

  it('resolves verified assets by symbol or address and presents a copy-safe address label', () => {
    expect(assetOptionFor('RWA')?.address).toBe(COSTON2_MOCK_ASSETS.rwa);
    expect(assetOptionFor(COSTON2_MOCK_ASSETS.usdx.toUpperCase())?.symbol).toBe('USDX');
    expect(assetOptionFor('unknown')).toBeUndefined();
    expect(assetAddressLabel(COSTON2_MOCK_ASSETS.rwa)).toBe('0xdeca4…b3ac336f');
  });

  it('sorts read-model rows deterministically without mutating the source rows', () => {
    const rows = [['b', '2'], ['a', '3'], ['c', '1']] as const;
    expect(sortTableRows(rows, 0, 'asc')).toEqual([['a', '3'], ['b', '2'], ['c', '1']]);
    expect(sortTableRows(rows, 1, 'desc')).toEqual([['a', '3'], ['b', '2'], ['c', '1']]);
    expect(rows).toEqual([['b', '2'], ['a', '3'], ['c', '1']]);
  });

  it('renders indexed liquidation opportunities as table rows without inventing venues', () => {
    expect(indexedOpportunityRows(undefined)).toEqual([]);
    expect(indexedOpportunityRows([])).toEqual([]);
    expect(indexedOpportunityRows([{
      id: '0xliq-1',
      kind: 'liquidation',
      pair: '0xvenue / 0xmarket',
      status: 'executed',
      amount: '149',
      transaction: '0xliq',
      venue: '0xvenue',
      market: '0xmarket',
    }])).toEqual([
      ['0xliq-1', 'liquidation', '0xvenue / 0xmarket', 'executed', '149', '0xliq', '0xvenue', '0xmarket'],
    ]);
  });

  it('reviews liquidation output as gross, one fee, net minimum, and bound recipient', () => {
    expect(buildLiquidationRouteReview({
      venue: 'Morpho',
      market: 'RWA/USD',
      position: 'position-1',
      debtAsset: 'USDX',
      collateralAsset: 'RWA',
      maxRepay: 100n,
      grossCollateral: 150n,
      protocolFee: 1n,
      minNetCollateral: 149n,
      recipient: '0x0000000000000000000000000000000000000001',
    })).toEqual({
      venue: 'Morpho', market: 'RWA/USD', position: 'position-1', debtAsset: 'USDX',
      collateralAsset: 'RWA', maxRepay: 100n, grossCollateral: 150n, protocolFee: 1n,
      netCollateral: 149n, minNetCollateral: 149n,
      recipient: '0x0000000000000000000000000000000000000001', status: 'ready',
    });
    expect(() => buildLiquidationRouteReview({
      venue: 'Kinetic', market: 'market', position: 'position', debtAsset: 'USDX', collateralAsset: 'RWA',
      maxRepay: 1n, grossCollateral: 10n, protocolFee: 1n, minNetCollateral: 10n, recipient: 'recipient',
    })).toThrow('LIQUIDATION_MIN_OUTPUT');
  });

  it('builds an explicit demo quote with one fee and net minimum protection', () => {
    const quote = buildImmediateQuote({
      sellAsset: 'RWA',
      receiveAsset: 'USDX',
      amount: '1',
      minimumReceive: '995',
    });
    expect(quote.grossOutput).toBe(1_000n * 10n ** 18n);
    expect(quote.protocolFee).toBe(5n * 10n ** 18n);
    expect(quote.netOutput).toBe(995n * 10n ** 18n);
    expect(formatTokenAmount(quote.netOutput, 18)).toBe('995');
    expect(() => buildImmediateQuote({
      sellAsset: 'RWA', receiveAsset: 'USDX', amount: '1', minimumReceive: '996',
    })).toThrow('MINIMUM_RECEIVE_TOO_HIGH');
  });

  it('summarizes curator adapters from the governance registry without inventing live venues', () => {
    expect(DEFAULT_CURATOR_ADAPTERS.every((entry) => !entry.enabled)).toBe(true);
    expect(curatorAdapterSummary()).toEqual({
      enabledCount: 0,
      enabledLabel: '0 enabled',
      enabledVenues: [],
      haircutLabel: 'Governance bounded',
      guardianLabel: 'Pause only',
    });
    const enabled: CuratorAdapterEntry[] = [
      { id: 'morpho-yield', venue: 'morpho', role: 'yield', enabled: true },
      { id: 'kinetic-liquidation', venue: 'kinetic', role: 'liquidation', enabled: true },
      { id: 'clearpool-yield', venue: 'clearpool', role: 'yield', enabled: false },
    ];
    expect(curatorAdapterSummary(enabled)).toEqual({
      enabledCount: 2,
      enabledLabel: '2 enabled',
      enabledVenues: ['morpho', 'kinetic'],
      haircutLabel: 'Governance bounded',
      guardianLabel: 'Pause only',
    });
  });
});

describe('simulated relay envelope payloads round-trip through the finalize matcher', () => {
  const commitment = '0x' + 'ab'.repeat(32);
  const routePlan = {
    version: 1,
    auctionId: commitment,
    bidCommitments: [],
    tieBreak: 'commitment-lexicographic-v1',
    chainId: 114,
    router: '0xb136b8a100000000000000000000000000000001',
    commitment,
    fccActionId: commitment,
    decisionBlock: '0',
    decisionBlockHash: '0x' + '00'.repeat(32),
    deadline: '4102444800',
    seller: '0xcc1bc072595a4964e000247eb311e72e5d20088a',
    recipient: '0xcc1bc072595a4964e000247eb311e72e5d20088a',
    sellToken: '0xdeca491298a0e9f00d87d0390565cc33b3ac336f',
    buyToken: '0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0',
    sellAmount: '1',
    minOutput: '995000000000000000000',
    protocolFeeBps: 50,
    eligibilityPolicyId: '0x' + 'cd'.repeat(32),
    eligibilityRevocationEpoch: '0',
    eligibilityRole: '1',
    eligibilityIssuerReference: '0x' + 'ef'.repeat(32),
    legs: [{ source: '0x29713643c62c6743a5bf68e39ac1de8eaec0bc97', sellAmount: '1', minOutput: '995000000000000000000', sourceData: '0x' }],
  };
  const auctionEnvelopePayload = buildSimAuctionEnvelopePayload({
    commitment,
    router: '0xb136b8a100000000000000000000000000000001',
    sellToken: '0xdeca491298a0e9f00d87d0390565cc33b3ac336f',
    buyToken: '0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0',
    sellAmount: '1',
    minOutput: '995',
    decisionDeadline: 4102444800,
    routePlan,
    seller: '0xcc1bc072595a4964e000247eb311e72e5d20088a',
    pair: 'RWA / USDX',
    duration: '24h',
  });

  it('carries a matcher-compatible auction and route plan under the commitment', () => {
    expect(auctionEnvelopePayload.auction).toMatchObject({
      commitment,
      chainId: 114,
      minOutput: '995000000000000000000',
      decisionDeadline: 4102444800,
    });
    expect(auctionEnvelopePayload.routePlan).toEqual(routePlan);
  });

  it('round-trips through createSimFinalizeMatch and selects the best bid', () => {
    const envelope = { ciphertext: JSON.stringify(auctionEnvelopePayload), commitment, keyId: 'simulated-fcc-demo-v1', expiresAt: 4102444800 } as never;
    const bidA = { envelope: { ciphertext: JSON.stringify(buildSimBidEnvelopePayload({ commitment: '0x' + '11'.repeat(32), bidder: '0xlpA', sellToken: '0xdeca491298a0e9f00d87d0390565cc33b3ac336f', buyToken: '0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0', sellAmount: '1', bidAmount: '1000.5', sequence: 1, expiresAt: 4102444800 })), commitment, keyId: 'simulated-lp-a', expiresAt: 4102444800 } as never, lpId: '0xlpA' };
    const bidB = { envelope: { ciphertext: JSON.stringify(buildSimBidEnvelopePayload({ commitment: '0x' + '22'.repeat(32), bidder: '0xlpB', sellToken: '0xdeca491298a0e9f00d87d0390565cc33b3ac336f', buyToken: '0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0', sellAmount: '1', bidAmount: '1234.5', sequence: 2, expiresAt: 4102444800 })), commitment, keyId: 'simulated-lp-b', expiresAt: 4102444800 } as never, lpId: '0xlpB' };
    const result = createSimFinalizeMatch()({ auctionEnvelope: envelope, bids: [bidA, bidB], now: 1_800_000_000 });
    expect(result.winner.bidder).toBe('0xlpB');
    expect(result.routeCommitment).toBe(commitment);
    expect(result.resultHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('normalizes quoted output to base units so display bids beat display minimums', () => {
    const payload = buildSimBidEnvelopePayload({ commitment: '0x' + '33'.repeat(32), bidder: '0xlpA', sellToken: '0xdeca491298a0e9f00d87d0390565cc33b3ac336f', buyToken: '0xa8bcb4cb087a7f1abc1ba2083e3f5b518e124ef0', sellAmount: '1', bidAmount: '0.000000000000000001', sequence: 1, expiresAt: 4102444800 });
    expect(payload.quotedOutput).toBe('1');
  });
});

