import { describe, expect, it } from 'vitest';
import { formatUnitsExact, parseUnitsExact } from '../packages/base-core/src/index';

describe('M5 exact amount boundaries', () => {
  it('parses USDC and B20 display values without floating point', () => {
    expect(parseUnitsExact('1,234.567890', 6)).toBe(1_234_567_890n);
    expect(parseUnitsExact('0.000000', 6)).toBe(0n);
    expect(parseUnitsExact('12.345678901', 9)).toBe(12_345_678_901n);
  });

  it('rejects exponent, negative, malformed grouping, and excess precision', () => {
    expect(() => parseUnitsExact('1e-6', 6)).toThrow('AMOUNT_INVALID');
    expect(() => parseUnitsExact('-1', 6)).toThrow('AMOUNT_INVALID');
    expect(() => parseUnitsExact('12,34.00', 6)).toThrow('AMOUNT_INVALID');
    expect(() => parseUnitsExact('1.0000001', 6)).toThrow('AMOUNT_PRECISION');
  });

  it('formats bigint values canonically and never emits a float', () => {
    expect(formatUnitsExact(1_234_567_890n, 6)).toBe('1,234.56789');
    expect(formatUnitsExact(1n, 18)).toBe('0.000000000000000001');
    expect(formatUnitsExact(0n, 6)).toBe('0');
  });
});
