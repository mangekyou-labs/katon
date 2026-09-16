const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?:\.[0-9]*)?$/;

export function assertAtomicString(value: unknown, field = 'amount'): asserts value is string {
  if (typeof value !== 'string' || !INTEGER_PATTERN.test(value)) {
    throw new Error(`${field} must be a base-10 atomic string`);
  }
}

export function parseAtomic(value: string, field = 'amount'): bigint {
  assertAtomicString(value, field);
  return BigInt(value);
}

/** Convert a human decimal to an exact atomic integer without floating point. */
export function decimalToAtomic(value: string, decimals: number, field = 'amount'): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('decimals must be an integer between 0 and 255');
  }
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`${field} must be a decimal string without exponent notation`);
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new Error(`${field} has more than ${decimals} decimal places`);
  }
  const padded = fraction.padEnd(decimals, '0');
  return BigInt(whole + padded || '0');
}

export function atomicToDecimal(value: bigint | string, decimals: number): string {
  const amount = typeof value === 'string' ? parseAtomic(value) : value;
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('invalid decimals');
  if (decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function atomicToFixed(value: bigint | string, decimals: number): string {
  const amount = typeof value === 'string' ? parseAtomic(value) : value;
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('invalid decimals');
  if (decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

export function floorFee(grossAtomic: bigint | string, feeBps: number): bigint {
  const gross = typeof grossAtomic === 'string' ? parseAtomic(grossAtomic, 'gross output') : grossAtomic;
  if (gross < 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 25) {
    throw new Error('fee bps must be an integer from 0 through 25');
  }
  return (gross * BigInt(feeBps)) / 10_000n;
}

export function compareAtomic(left: string, right: string): number {
  const a = parseAtomic(left);
  const b = parseAtomic(right);
  return a === b ? 0 : a > b ? 1 : -1;
}
