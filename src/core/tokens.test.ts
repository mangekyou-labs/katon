import { describe, expect, it } from 'vitest';
import {
  ADDR_RE, fmtRemaining, isExpired, isKnownToken, isTxHash, orderTokensKnown,
  TOKENS, tokenIssuer, tokenLabel, trunc, validAmount,
} from './tokens';

const USDC = TOKENS[1].value;

describe('token allow-list (quarantine boundary)', () => {
  it('recognizes exactly the allow-listed values', () => {
    expect(isKnownToken('XLM')).toBe(true);
    expect(isKnownToken(USDC)).toBe(true);
    // same code, attacker issuer — the spoof the quarantine exists for
    expect(isKnownToken('USDC:GATTACKERATTACKERATTACKERATTACKERATTACKERATTACKERATTA')).toBe(false);
    expect(isKnownToken('USDC')).toBe(false); // bare code without issuer is NOT the real USDC
    expect(isKnownToken('')).toBe(false);
  });

  it('quarantines an order if either leg is unknown', () => {
    expect(orderTokensKnown({ maker_token: 'XLM', taker_token: USDC })).toBe(true);
    expect(orderTokensKnown({ maker_token: 'XLM', taker_token: 'USDC:GFAKE' })).toBe(false);
    expect(orderTokensKnown({ maker_token: 'USDC:GFAKE', taker_token: 'XLM' })).toBe(false);
  });

  it('label/issuer split', () => {
    expect(tokenLabel(USDC)).toBe('USDC');
    expect(tokenLabel('XLM')).toBe('XLM');
    expect(tokenIssuer(USDC)).toBe('GBJH2XCGKRMFKCBYPFJHHGISZGLOYZ3TM3IMFQPQSK7NT2L7JUARLC26');
    expect(tokenIssuer('XLM')).toBeUndefined();
  });
});

describe('validAmount', () => {
  it.each([
    ['1', true], ['0.0000001', true], ['123.4567891', true], ['9999999.9999999', true],
    ['0', false], ['0.0', false],         // must be > 0
    ['1.12345678', false],                // 8 dp > 7-decimal precision
    ['.5', false], ['1.', false], ['1e3', false], ['-1', false], ['abc', false], ['', false],
  ])('%s -> %s', (input, expected) => {
    expect(validAmount(input)).toBe(expected);
  });
});

describe('ADDR_RE / isTxHash / trunc', () => {
  it('accepts a well-formed G address and rejects near-misses', () => {
    const g = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
    expect(ADDR_RE.test(g)).toBe(true);
    expect(ADDR_RE.test(g.slice(0, -1))).toBe(false);
    expect(ADDR_RE.test('C' + g.slice(1))).toBe(false);
    expect(ADDR_RE.test(g.toLowerCase())).toBe(false);
  });

  it('isTxHash: 64 hex chars, case-insensitive, nothing else', () => {
    expect(isTxHash('a'.repeat(64))).toBe(true);
    expect(isTxHash('A0'.repeat(32))).toBe(true);
    expect(isTxHash('a'.repeat(63))).toBe(false);
    expect(isTxHash('g'.repeat(64))).toBe(false);
    expect(isTxHash(null)).toBe(false);
    expect(isTxHash(undefined)).toBe(false);
  });

  it('trunc keeps 5+5 around an ellipsis and never throws on empties', () => {
    expect(trunc('GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR')).toBe('GCFIR…VYOJR');
    expect(trunc('GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR').length).toBe(11);
    expect(trunc(null)).toBe('');
    expect(trunc('')).toBe('');
  });
});

describe('time helpers (deterministic via injected now)', () => {
  const T0 = Date.parse('2026-07-10T12:00:00.000Z');

  it('isExpired compares against the injected clock', () => {
    expect(isExpired({ expiration: '2026-07-10T11:59:59.000Z' }, T0)).toBe(true);
    expect(isExpired({ expiration: '2026-07-10T12:00:01.000Z' }, T0)).toBe(false);
  });

  it('fmtRemaining buckets: days, hours, minutes, expired', () => {
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    expect(fmtRemaining(at(-1), T0)).toBe('expired');
    expect(fmtRemaining(at(0), T0)).toBe('expired');
    expect(fmtRemaining(at(2 * 86400000 + 3 * 3600000), T0)).toBe('2d 3h');
    expect(fmtRemaining(at(3 * 3600000 + 5 * 60000), T0)).toBe('3h 5m');
    expect(fmtRemaining(at(7 * 60000), T0)).toBe('7m');
    expect(fmtRemaining(at(30000), T0)).toBe('0m');
  });
});
