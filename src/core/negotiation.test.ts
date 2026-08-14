import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT,
  amountTooLarge,
  composeBroadcastPayload,
  composeRoundPayload,
  currentTerms,
  latestPendingRound,
  nextRoundN,
  responderOf,
} from './negotiation';
import type { Order, RoundRow } from './types';

const USDC = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MAKER = 'G'.padEnd(56, 'A');
const TAKER = 'G'.padEnd(56, 'B');

const order = (over: Partial<Order> = {}): Order => ({
  id: 'ord-1',
  created_at: '2026-07-10T00:00:00Z',
  maker_address: MAKER,
  maker_amount: '100',
  maker_token: 'XLM',
  taker_address: TAKER,
  taker_amount: '25',
  taker_token: USDC,
  expiration: '2026-07-12T00:00:00Z',
  nonce: 'n-1',
  signature: 'sig',
  signed_payload: '{}',
  status: 'pending',
  ...over,
});

const round = (over: Partial<RoundRow> = {}): RoundRow => ({
  id: `rnd-${over.n ?? 1}`,
  order_id: 'ord-1',
  n: 1,
  proposer: 'taker',
  maker_amount: '110',
  taker_amount: '25',
  resolution: 'pending',
  created_at: '2026-07-10T01:00:00Z',
  ...over,
});

describe('composeBroadcastPayload / composeRoundPayload', () => {
  const b = {
    broadcast_id: 'bc-1',
    maker_address: MAKER,
    pair_key: `${USDC}|XLM`,
    maker_amount: '100',
    maker_token: 'XLM',
    taker_amount: '25',
    taker_token: USDC,
    expiration: '2026-07-12T00:00:00Z',
  };

  it('broadcast payload has a fixed field order (pinned bytes)', () => {
    // exact-string pin: any reorder/rename breaks stored signatures' meaning
    expect(composeBroadcastPayload(b)).toBe(
      `{"kind":"broadcast","broadcast_id":"bc-1","maker_address":"${MAKER}",` +
      `"pair_key":"${USDC}|XLM","maker_amount":"100","maker_token":"XLM",` +
      `"taker_amount":"25","taker_token":"${USDC}","expiration":"2026-07-12T00:00:00Z"}`,
    );
  });

  it('round payload has a fixed field order (pinned bytes)', () => {
    const r = {
      kind: 'round' as const,
      order_id: 'ord-1',
      n: 2,
      proposer: 'maker' as const,
      maker_amount: '105',
      maker_token: 'XLM',
      taker_amount: '26',
      taker_token: USDC,
      expiration: '2026-07-12T00:00:00Z',
    };
    expect(composeRoundPayload(r)).toBe(
      `{"kind":"round","order_id":"ord-1","n":2,"proposer":"maker",` +
      `"maker_amount":"105","maker_token":"XLM","taker_amount":"26",` +
      `"taker_token":"${USDC}","expiration":"2026-07-12T00:00:00Z"}`,
    );
  });

  it('is deterministic across calls and independent of input property order', () => {
    const shuffled = {
      expiration: b.expiration, taker_token: b.taker_token, taker_amount: b.taker_amount,
      maker_token: b.maker_token, maker_amount: b.maker_amount, pair_key: b.pair_key,
      maker_address: b.maker_address, broadcast_id: b.broadcast_id,
    };
    expect(composeBroadcastPayload(shuffled)).toBe(composeBroadcastPayload(b));
  });

  it('the kind discriminator keeps the two payloads distinct', () => {
    expect(composeBroadcastPayload(b)).toContain('"kind":"broadcast"');
    expect(composeBroadcastPayload(b)).not.toContain('"kind":"round"');
  });
});

describe('amountTooLarge', () => {
  it('accepts amounts at or below MAX_AMOUNT', () => {
    expect(amountTooLarge('10000000000000')).toBe(false); // exactly 1e13
    expect(amountTooLarge('0.0000001')).toBe(false);
    expect(amountTooLarge('100')).toBe(false);
  });

  it('rejects amounts above MAX_AMOUNT, incl. exponential input', () => {
    expect(amountTooLarge('10000000000001')).toBe(true);
    expect(amountTooLarge('1e21')).toBe(true);
  });

  it('caps within the String()-round-trippable range (the 1e+21 → BigInt trap)', () => {
    // why the bound exists: PostgREST numerics come back as JS numbers, and…
    expect(String(1e21)).toBe('1e+21');            // …String() goes exponential…
    expect(() => BigInt('1e+21')).toThrow();       // …which BigInt throws on at settlement
    expect(String(MAX_AMOUNT)).toBe('10000000000000'); // capped range stays plain digits
  });
});

describe('nextRoundN', () => {
  it('is 1 on an empty thread', () => {
    expect(nextRoundN([])).toBe(1);
  });

  it('is max(n)+1, regardless of array order', () => {
    expect(nextRoundN([round({ n: 3 }), round({ n: 1 }), round({ n: 2 })])).toBe(4);
  });
});

describe('latestPendingRound', () => {
  it('is null with no rounds or no pending rounds', () => {
    expect(latestPendingRound([])).toBeNull();
    expect(latestPendingRound([round({ n: 1, resolution: 'superseded' })])).toBeNull();
  });

  it('picks the highest-n pending round in a superseded chain', () => {
    const rounds = [
      round({ n: 1, resolution: 'superseded' }),
      round({ n: 3, resolution: 'pending', proposer: 'taker' }),
      round({ n: 2, resolution: 'superseded' }),
    ];
    expect(latestPendingRound(rounds)?.n).toBe(3);
  });
});

describe('responderOf', () => {
  it('flips sides', () => {
    expect(responderOf('maker')).toBe('taker');
    expect(responderOf('taker')).toBe('maker');
  });
});

describe('currentTerms', () => {
  it('no rounds + pending order → round 0, maker proposed, awaiting taker', () => {
    const t = currentTerms(order(), []);
    expect(t).toEqual({
      maker_amount: '100', taker_amount: '25',
      n: 0, proposer: 'maker', awaiting: 'taker', latestPending: null,
    });
  });

  it('a pending counter overrides the order amounts and flips awaiting', () => {
    const r = round({ n: 1, proposer: 'taker', maker_amount: '110', taker_amount: '25' });
    const t = currentTerms(order({ status: 'countered' }), [r]);
    expect(t.maker_amount).toBe('110');
    expect(t.n).toBe(1);
    expect(t.proposer).toBe('taker');
    expect(t.awaiting).toBe('maker');
    expect(t.latestPending).toBe(r);
  });

  it('a superseded chain surfaces only the latest pending round', () => {
    const rounds = [
      round({ n: 1, proposer: 'taker', maker_amount: '110', resolution: 'superseded' }),
      round({ n: 2, proposer: 'maker', maker_amount: '105', resolution: 'pending' }),
    ];
    const t = currentTerms(order({ status: 'countered' }), rounds);
    expect(t.maker_amount).toBe('105');
    expect(t.n).toBe(2);
    expect(t.awaiting).toBe('taker');
  });

  it('accepted order → awaiting null (thread closed)', () => {
    // accept writes final amounts back onto the order row and resolves the round
    const t = currentTerms(order({ status: 'accepted', maker_amount: '110' }), [
      round({ n: 1, resolution: 'accepted', maker_amount: '110' }),
    ]);
    expect(t).toMatchObject({ maker_amount: '110', n: 0, awaiting: null, latestPending: null });
  });

  it('declined order → awaiting null even with a stale pending round', () => {
    // lost resolution write (no transactions on anon PostgREST) must not reopen the thread
    const t = currentTerms(order({ status: 'declined' }), [
      round({ n: 1, proposer: 'taker', resolution: 'pending' }),
    ]);
    expect(t.n).toBe(1);
    expect(t.awaiting).toBeNull();
  });

  it('normalizes PostgREST numeric amounts back to strings', () => {
    const raw = round({ n: 1 });
    // simulate supabase-js parsing numeric columns as JSON numbers
    (raw as unknown as { maker_amount: number }).maker_amount = 110.5;
    const t = currentTerms(order({ status: 'countered' }), [raw]);
    expect(t.maker_amount).toBe('110.5');
  });
});
