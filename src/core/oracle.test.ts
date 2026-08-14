import { describe, expect, it } from 'vitest';
import { crossRate, isStale, oracleSymbol, suggestedAmount } from './oracle';
import { TOKENS } from './tokens';

const USDC = TOKENS[1].value; // 'USDC:GBBD…'

describe('oracleSymbol (TOKENS value → Reflector symbol)', () => {
  it('maps the two live tokens to their Reflector symbols', () => {
    expect(oracleSymbol('XLM')).toBe('XLM');
    expect(oracleSymbol(USDC)).toBe('USDC'); // drops the issuer
  });

  it('returns null for anything the oracle does not carry', () => {
    // a token not in the supported allow-list degrades to "no suggestion"
    expect(oracleSymbol('DOGE:GWHATEVER')).toBeNull();
    expect(oracleSymbol('')).toBeNull();
  });
});

describe('crossRate (takerPrice per makerPrice, decimals cancel)', () => {
  // real probe values (14-decimal USD prices), 2026-07-15
  const XLM = 18596592764727n; // ≈ 0.18596 USD
  const USDC_P = 100032143647577n; // ≈ 1.00032 USD

  it('computes 1 XLM in USDC from the two USD prices', () => {
    const r = crossRate(XLM, USDC_P);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.18590, 4); // 0.18596 / 1.00032
  });

  it('is the reciprocal the other way round', () => {
    const r = crossRate(USDC_P, XLM);
    expect(r!).toBeCloseTo(5.3792, 3); // 1.00032 / 0.18596
  });

  it('does not overflow on large i128 prices (BTC ≈ 6.5e18 scaled)', () => {
    const BTC = 6506204441506260531n;
    const r = crossRate(BTC, USDC_P);
    expect(r!).toBeCloseTo(65041.14, 1); // 6.506e18 / 1.00032e14 USDC per BTC
    expect(Number.isFinite(r!)).toBe(true);
  });

  it('returns null for non-positive inputs', () => {
    expect(crossRate(0n, USDC_P)).toBeNull();
    expect(crossRate(XLM, 0n)).toBeNull();
    expect(crossRate(-1n, USDC_P)).toBeNull();
  });
});

describe('isStale (price older than ~2 update intervals)', () => {
  const now = 1_784_132_700_000; // ms
  it('accepts a fresh price', () => {
    expect(isStale(1_784_132_700, now)).toBe(false); // same instant
    expect(isStale(1_784_132_700 - 300, now)).toBe(false); // 5 min old
  });
  it('rejects a price older than the 10-minute window', () => {
    expect(isStale(1_784_132_700 - 601, now)).toBe(true); // >10 min old
  });
});

describe('suggestedAmount (base × rate, rounded to SAC precision)', () => {
  it('multiplies and keeps at most 7 decimals', () => {
    expect(suggestedAmount(777, 0.18590)).toBeCloseTo(144.4443, 4);
  });

  it('never emits more than 7 decimal places (must pass validAmount)', () => {
    const s = String(suggestedAmount(1, 0.185901234567));
    const decimals = s.includes('.') ? s.split('.')[1].length : 0;
    expect(decimals).toBeLessThanOrEqual(7);
  });

  it('returns 0 for a zero base', () => {
    expect(suggestedAmount(0, 0.1859)).toBe(0);
  });
});
