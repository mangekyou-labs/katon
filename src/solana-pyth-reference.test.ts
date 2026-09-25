import { describe, expect, it, vi } from 'vitest';
import {
  LiveReferencePolicyProvider,
  PythProAaplSource,
  parsePythProAaplPayload,
  type ReferenceObservationSource,
} from '../apps/solana-api/src/live-reference-policy';
import type { ReferenceObservation } from '../apps/solana-api/src/reference-policy';
import { encodeBase58, localSellerPublicKey } from '@katon/solana-core';
import { demoAssets } from '../apps/solana-api/src/registry';
import { HeadlessPrivateMakerSource, MemorySourceBalanceProvider, type QuoteSource } from '../apps/solana-api/src/sources';
import { MemoryAssetProvider, QuoteDeskService } from '../apps/solana-api/src/service';

const updateUs = '1700000000123456';

function pythPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'streamUpdated',
    parsed: {
      timestampUs: '1700000000123456',
      priceFeeds: [{
        priceFeedId: 42,
        price: '17234567890',
        exponent: -8,
        feedUpdateTimestamp: updateUs,
        marketSession: 'regular',
        ...overrides,
      }],
    },
  };
}

describe('Pyth Pro AAPL reference observation', () => {
  it('converts the mantissa to six decimal USD atomic units and uses feedUpdateTimestamp', () => {
    expect(parsePythProAaplPayload(pythPayload())).toMatchObject({
      provider: 'pyth-pro:Equity.US.AAPL/USD',
      symbol: 'Equity.US.AAPL/USD',
      licensedPrimary: true,
      priceAtomic: '172345679',
      observedAtMs: 1_700_000_000_123,
      sessionOpen: true,
      marketSession: 'regular',
    });
  });

  it('rejects malformed feed identity or price data', () => {
    expect(() => parsePythProAaplPayload(pythPayload({ priceFeedId: 'not-an-id' }))).toThrow(/priceFeedId/i);
    expect(() => parsePythProAaplPayload(pythPayload({ price: 'not-a-number' }))).toThrow(/price/i);
  });

  it('requests the feed with the server-side bearer token and offchain format', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(pythPayload()), { status: 200 }));
    const source = new PythProAaplSource({ apiKey: 'server-only-key', fetcher: fetcher as typeof fetch });

    await expect(source.read()).resolves.toMatchObject({ priceAtomic: '172345679', marketSession: 'regular' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://pyth-lazer.dourolabs.app/v1/latest_price');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-only-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      symbols: ['Equity.US.AAPL/USD'],
      properties: ['price', 'exponent', 'feedUpdateTimestamp', 'marketSession'],
      formats: ['leUnsigned'],
      parsed: true,
    });
  });
});

describe('live dual-source reference policy', () => {
  const crossCheck: ReferenceObservation = {
    provider: 'licensed-independent-vendor',
    symbol: 'AAPL/USD',
    licensedPrimary: false,
    priceAtomic: '172345700',
    observedAtMs: 1_700_000_000_123,
    sessionOpen: true,
    marketSession: 'regular',
    corporateActionPending: false,
  };

  function source(id: string, observation: ReferenceObservation): ReferenceObservationSource {
    return { id, read: async () => observation };
  }

  it('requires a distinct independent observation and makes Pyth stale or out-of-session data ineligible', async () => {
    const pyth = parsePythProAaplPayload(pythPayload());
    const independent = source('cross-check', crossCheck);
    const good = new LiveReferencePolicyProvider([source('pyth-primary', pyth), independent]);
    await good.refresh();
    expect(good.snapshot(1_700_000_000_124).status).toBe('ready');
    expect(good.snapshot(1_700_000_015_124).status).toBe('stale');

    const closedPyth = { ...pyth, sessionOpen: false, marketSession: 'closed' };
    const closed = new LiveReferencePolicyProvider([source('pyth-primary', closedPyth), independent]);
    await closed.refresh();
    expect(closed.snapshot(1_700_000_000_124)).toMatchObject({ status: 'market_closed', pyth: { marketSession: 'closed' } });

    const withoutIndependent = new LiveReferencePolicyProvider([source('pyth-primary', pyth)]);
    await withoutIndependent.refresh();
    expect(withoutIndependent.snapshot(1_700_000_000_124)).toMatchObject({ status: 'unavailable', pyth: { symbol: 'Equity.US.AAPL/USD' } });
  });

  it('fails unavailable after a source refresh error instead of reusing a cached fresh observation', async () => {
    const pyth = parsePythProAaplPayload(pythPayload());
    const brokenCrossCheck: ReferenceObservationSource = { id: 'cross-check', read: async () => { throw new Error('vendor offline'); } };
    const policy = new LiveReferencePolicyProvider([source('pyth-primary', pyth), brokenCrossCheck]);
    await policy.refresh();
    expect(policy.snapshot(1_700_000_000_124)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('vendor offline') });
  });
});

describe('Seller Desk Pyth quote gates', () => {
  const crossCheckObservation = (nowMs: number): ReferenceObservation => ({
    provider: 'licensed-independent-vendor',
    symbol: 'AAPL/USD',
    licensedPrimary: false,
    priceAtomic: '172345679',
    observedAtMs: nowMs,
    sessionOpen: true,
    marketSession: 'regular',
    corporateActionPending: false,
  });

  it('rejects quote eligibility and does not call a venue when Pyth is stale', async () => {
    const nowMs = Date.now();
    const pyth = {
      provider: 'pyth-pro:Equity.US.AAPL/USD',
      symbol: 'Equity.US.AAPL/USD',
      licensedPrimary: true,
      priceAtomic: '172345679',
      observedAtMs: nowMs - 15_001,
      sessionOpen: true,
      marketSession: 'regular',
      corporateActionPending: false,
    } satisfies ReferenceObservation;
    const policy = new LiveReferencePolicyProvider([
      { id: 'pyth-primary', read: async () => pyth },
      { id: 'cross-check', read: async () => crossCheckObservation(nowMs) },
    ]);
    const asset = demoAssets[0]!;
    const wallet = encodeBase58(localSellerPublicKey());
    const assets = new MemoryAssetProvider(demoAssets);
    assets.setBalance(wallet, asset.mint, '2500000');
    let quoteCalls = 0;
    const source: QuoteSource = {
      id: 'should-not-be-quoted',
      kind: 'jupiter',
      settlementRoute: 'generic-spl',
      reliabilityBps: 9_900,
      quote: async () => { quoteCalls += 1; throw new Error('stale Pyth data reached the quote source'); },
    };
    const desk = new QuoteDeskService(assets, [source], {} as never, {} as never, () => nowMs,
      undefined, undefined, undefined, policy);

    const session = await desk.createQuoteSprint({
      wallet,
      inputMint: asset.mint,
      outputMint: asset.supportedOutputs[0]!,
      inputAmountAtomic: '100000',
    }, nowMs);

    expect(session).toMatchObject({ state: 'unknown', eligibility: { code: 'capability_unavailable', message: expect.stringContaining('reference policy stale') } });
    expect(session.referencePolicy).toMatchObject({ status: 'stale', pyth: { symbol: 'Equity.US.AAPL/USD' } });
    expect(quoteCalls).toBe(0);
  });

  it('clears an issued transaction when Pyth becomes stale before review', async () => {
    const nowMs = Date.now();
    let pythReads = 0;
    const freshPyth: ReferenceObservation = {
      provider: 'pyth-pro:Equity.US.AAPL/USD',
      symbol: 'Equity.US.AAPL/USD',
      licensedPrimary: true,
      priceAtomic: '172345679',
      observedAtMs: nowMs,
      sessionOpen: true,
      marketSession: 'regular',
      corporateActionPending: false,
    };
    let pythBecameStale = false;
    const policy = new LiveReferencePolicyProvider([
      {
        id: 'pyth-primary',
        read: async () => {
          pythReads += 1;
          return pythBecameStale ? { ...freshPyth, observedAtMs: nowMs - 15_001 } : freshPyth;
        },
      },
      { id: 'cross-check', read: async () => crossCheckObservation(nowMs) },
    ]);
    const asset = demoAssets[0]!;
    const wallet = encodeBase58(localSellerPublicKey());
    const assets = new MemoryAssetProvider(demoAssets);
    assets.setBalance(wallet, asset.mint, '2500000');
    const maker = new HeadlessPrivateMakerSource();
    const balances = new MemorySourceBalanceProvider();
    balances.setBalance(maker.id, asset.supportedOutputs[0]!, '1000000000000');
    let simulationCalls = 0;
    const desk = new QuoteDeskService(
      assets,
      [maker],
      {} as never,
      {} as never,
      () => nowMs,
      { simulate: async (_candidate, simulatedAtMs) => {
        simulationCalls += 1;
        if (simulationCalls > 1) pythBecameStale = true;
        return { ok: true, unitsConsumed: 145_000, simulatedAtMs };
      } },
      balances,
      undefined,
      policy,
    );
    desk.observeGovernedMaker(maker.id, encodeBase58(maker.makerPublicKey), true);
    const created = await desk.createQuoteSprint({
      wallet,
      inputMint: asset.mint,
      outputMint: asset.supportedOutputs[0]!,
      inputAmountAtomic: '100000',
    }, nowMs);
    const issued = await desk.collectNow(created.id, nowMs);
    expect(issued).toMatchObject({ state: 'winner_ready', winner: { sourceKind: 'private-maker', transactionBase64: expect.any(String) } });

    await expect(desk.review(created.id, wallet, nowMs)).rejects.toThrow('reference policy stale before review');
    const blocked = desk.getSession(created.id, nowMs);
    expect(blocked).toMatchObject({ state: 'failed', referencePolicy: { status: 'stale' }, winner: { transactionBase64: undefined } });
    expect(simulationCalls).toBe(2);
  });
});
