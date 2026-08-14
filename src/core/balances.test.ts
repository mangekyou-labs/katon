import { describe, expect, it } from 'vitest';
import {
  balanceOf, canAfford, emptyBalances, fmtBalance, parseAccountBalances,
} from './balances';
import { TOKENS } from './tokens';

const USDC = TOKENS[1].value; // 'USDC:GBBD…' — the real allow-listed issuer
const [USDC_CODE, USDC_ISSUER] = USDC.split(':');

// Realistic Horizon GET /accounts/{id} shape (only the fields we read, plus
// the noise a real response carries): native + the allow-listed USDC line +
// a same-code attacker-issuer line that must be excluded + an LP share entry.
const account = {
  id: 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR',
  sequence: '4113023891406848',
  subentry_count: 3, // reserve = (2 + 3) × 0.5 = 2.5 XLM
  balances: [
    {
      balance: '25.5000000',
      selling_liabilities: '0.5000000',
      buying_liabilities: '0.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: USDC_CODE,
      asset_issuer: USDC_ISSUER,
    },
    {
      // same code, attacker issuer — the spoof the quarantine exists for
      balance: '999.0000000',
      selling_liabilities: '0.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GATTACKERATTACKERATTACKERATTACKERATTACKERATTACKERATTA',
    },
    {
      balance: '5.0000000',
      asset_type: 'liquidity_pool_shares',
      liquidity_pool_id: 'a468d41d8e9b8f3c7209651608b74b7db7ac9952dcae0cdf24871d1d9c7b0088',
    },
    {
      balance: '100.0000000',
      selling_liabilities: '10.0000000',
      buying_liabilities: '0.0000000',
      asset_type: 'native',
    },
  ],
};

describe('parseAccountBalances', () => {
  it('maps allow-listed entries only, spendable = balance − liabilities (− reserve for XLM)', () => {
    // XLM: 100 − 10 selling − 2.5 reserve; USDC: 25.5 − 0.5.
    // Attacker-issuer USDC and LP shares must NOT appear (toEqual is exact).
    expect(parseAccountBalances(account)).toEqual({ XLM: '87.5', [USDC]: '25' });
  });

  it('reserve scales with subentry_count and defaults to (2 + 0) when absent', () => {
    const native = (balance: string, extra: Record<string, unknown> = {}) => ({
      balances: [{ balance, selling_liabilities: '0.0000000', asset_type: 'native' }],
      ...extra,
    });
    expect(parseAccountBalances(native('100.0000000', { subentry_count: 0 }))).toEqual({ XLM: '99' });
    expect(parseAccountBalances(native('100.0000000', { subentry_count: 6 }))).toEqual({ XLM: '96' });
    expect(parseAccountBalances(native('100.0000000'))).toEqual({ XLM: '99' });
  });

  it('clamps spendable at zero (balance below the reserve, or eaten by liabilities)', () => {
    expect(parseAccountBalances({
      subentry_count: 2,
      balances: [{ balance: '2.0000000', selling_liabilities: '0.0000000', asset_type: 'native' }],
    })).toEqual({ XLM: '0' }); // 2 − (2+2)×0.5 = 0 → clamped, not negative
    expect(parseAccountBalances({
      subentry_count: 0,
      balances: [
        { balance: '0.5000000', selling_liabilities: '0.0000000', asset_type: 'native' },
        {
          balance: '1.0000000', selling_liabilities: '3.0000000',
          asset_type: 'credit_alphanum4', asset_code: USDC_CODE, asset_issuer: USDC_ISSUER,
        },
      ],
    })).toEqual({ XLM: '0', [USDC]: '0' });
  });

  it('omits allow-listed tokens with no trustline (absent, not 0)', () => {
    const map = parseAccountBalances({
      subentry_count: 0,
      balances: [{ balance: '10.0000000', selling_liabilities: '0.0000000', asset_type: 'native' }],
    });
    expect(map).toEqual({ XLM: '9' });
    expect(USDC in map).toBe(false);
  });

  it('rounds float noise back to 7dp plain decimal (no exponent)', () => {
    const map = parseAccountBalances({
      subentry_count: 0,
      balances: [{
        // 0.3 − 0.1 = 0.19999999999999998 in doubles — must come out '0.2'
        balance: '0.3000000', selling_liabilities: '0.1000000',
        asset_type: 'credit_alphanum4', asset_code: USDC_CODE, asset_issuer: USDC_ISSUER,
      }],
    });
    expect(map[USDC]).toBe('0.2');
  });

  it('is defensive about garbage input and malformed entries', () => {
    expect(parseAccountBalances(null)).toEqual({});
    expect(parseAccountBalances(undefined)).toEqual({});
    expect(parseAccountBalances(42)).toEqual({});
    expect(parseAccountBalances('not json')).toEqual({});
    expect(parseAccountBalances({})).toEqual({});
    expect(parseAccountBalances({ balances: 'nope' })).toEqual({});
    expect(parseAccountBalances({
      balances: [
        null,
        {},
        { asset_type: 'native' },                                   // missing balance
        { asset_type: 'native', balance: 'abc' },                   // garbage balance
        { asset_type: 'credit_alphanum4', balance: '1.0000000' },   // missing code/issuer
      ],
    })).toEqual({});
  });
});

describe('balanceOf / emptyBalances', () => {
  it('emptyBalances is the unfunded-account map: everything reads 0', () => {
    expect(emptyBalances()).toEqual({});
    expect(balanceOf(emptyBalances(), 'XLM')).toBe('0');
  });

  it('reads the entry, "0" for absent trustline, "0" for a null map', () => {
    expect(balanceOf({ XLM: '87.5' }, 'XLM')).toBe('87.5');
    expect(balanceOf({ XLM: '87.5' }, USDC)).toBe('0');
    expect(balanceOf(null, 'XLM')).toBe('0');
  });
});

describe('canAfford', () => {
  const map = { XLM: '87.5', [USDC]: '25' };

  it('fails closed on a null map (not loaded / fetch failed ≠ zero)', () => {
    expect(canAfford(null, 'XLM', '1')).toBe(false);
  });

  it('absent trustline affords nothing, but an unfunded map is a valid zero', () => {
    expect(canAfford(map, 'USDC:GFAKE', '0.0000001')).toBe(false);
    expect(canAfford(emptyBalances(), 'XLM', '0.0000001')).toBe(false);
  });

  it('compares amount ≤ spendable; exact-equal affords', () => {
    expect(canAfford(map, 'XLM', '87.4999999')).toBe(true);
    expect(canAfford(map, 'XLM', '87.5')).toBe(true);
    expect(canAfford(map, 'XLM', '87.5000001')).toBe(false);
    expect(canAfford(map, USDC, '25')).toBe(true);
    expect(canAfford(map, USDC, '25.0000001')).toBe(false);
  });

  it.each(['0', '', '.5', '1e3', '-1', '1.12345678', 'abc'])(
    'rejects invalid amount %j regardless of balance', (amount) => {
      expect(canAfford(map, 'XLM', amount)).toBe(false);
    },
  );
});

describe('fmtBalance', () => {
  it.each([
    ['25.5000000', '25.5'],
    ['25.0000000', '25'],
    ['87.5', '87.5'],
    ['0.1234567', '0.1234567'],
    ['0.0000001', '0.0000001'],
    ['0.0000000', '0'],
    ['0', '0'],
    ['', '0'],
    ['abc', '0'],
  ])('%j -> %j', (input, expected) => {
    expect(fmtBalance(input)).toBe(expected);
  });
});
