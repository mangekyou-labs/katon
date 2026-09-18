/** Native USDC precision on Base. */
export const USDC_DECIMALS = 6 as const;

/**
 * Parse a human display amount without ever converting through Number.
 * Commas are accepted only as conventional three-digit grouping; callers at
 * API/transaction boundaries should send the resulting bigint as a decimal
 * string.
 */
export function parseUnitsExact(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (typeof value !== 'string') throw new Error('AMOUNT_INVALID');
  const input = value.trim();
  if (input.length === 0 || input.startsWith('-') || input.startsWith('+') || /[eE]/.test(input)) {
    throw new Error('AMOUNT_INVALID');
  }

  const match = input.match(/^(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?|\.(\d+))$/);
  if (!match) throw new Error('AMOUNT_INVALID');
  const whole = (match[1] ?? '0').replaceAll(',', '');
  const fraction = match[2] ?? match[3] ?? '';
  if (fraction.length > decimals) throw new Error('AMOUNT_PRECISION');
  const padded = fraction.padEnd(decimals, '0');
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return BigInt(digits || '0');
}

/** Format a non-negative bigint for a human display, grouped by thousands. */
export function formatUnitsExact(
  amount: bigint,
  decimals: number,
  options: { readonly group?: boolean; readonly trimTrailingZeros?: boolean } = {},
): string {
  assertDecimals(decimals);
  if (typeof amount !== 'bigint') throw new Error('AMOUNT_INVALID');
  if (amount < 0n) throw new Error('AMOUNT_NEGATIVE');
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const remainder = amount % scale;
  const group = options.group ?? true;
  const trim = options.trimTrailingZeros ?? true;
  const wholeText = group ? groupDigits(whole.toString(10)) : whole.toString(10);
  if (decimals === 0 || remainder === 0n) return wholeText;
  let fraction = remainder.toString(10).padStart(decimals, '0');
  if (trim) fraction = fraction.replace(/0+$/, '');
  return `${wholeText}.${fraction}`;
}

/** Canonical decimal serialization for API and transaction payloads. */
export function bigintToDecimal(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('INTEGER_INVALID');
  return value.toString(10);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('DECIMALS_INVALID');
}

function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
