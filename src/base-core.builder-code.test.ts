import { describe, expect, it } from 'vitest';

import {
  ERC8021_MARKER,
  appendBuilderCodeSuffix,
  assertBuilderCode,
  decodeBuilderCodeSuffix,
  encodeBuilderCodeSuffix,
  hasBuilderCodeSuffix,
} from '../packages/base-core/src/builder-code';

// Vectors cross-checked against `Attribution.toDataSuffix` from `ox/erc8021`.
const ONE_CODE = '0x62635f616263313233090080218021802180218021802180218021';
const TWO_CODES = '0x62635f6162633132332c62635f646566343536130080218021802180218021802180218021';

describe('ERC-8021 builder code attribution', () => {
  it('encodes the canonical spec vectors exactly', () => {
    expect(encodeBuilderCodeSuffix(['bc_abc123'])).toBe(ONE_CODE);
    expect(encodeBuilderCodeSuffix(['bc_abc123', 'bc_def456'])).toBe(TWO_CODES);
    expect(ERC8021_MARKER).toBe('0x80218021802180218021802180218021');
  });

  it('round-trips suffixes and detects the marker', () => {
    const suffix = encodeBuilderCodeSuffix(['bc_abc123', 'bc_def456']);
    expect(decodeBuilderCodeSuffix(suffix)).toEqual({ schemaId: 0, codes: ['bc_abc123', 'bc_def456'] });
    expect(hasBuilderCodeSuffix(suffix)).toBe(true);
    expect(hasBuilderCodeSuffix('0xdeadbeef')).toBe(false);
    expect(decodeBuilderCodeSuffix('0xdeadbeef')).toBeUndefined();
  });

  it('rejects empty, comma-bearing, oversized, and non-printable codes', () => {
    expect(() => encodeBuilderCodeSuffix([])).toThrow('BUILDER_CODE_REQUIRED');
    expect(() => assertBuilderCode('')).toThrow('BUILDER_CODE_INVALID');
    expect(() => assertBuilderCode('bc_one,bc_two')).toThrow('BUILDER_CODE_SEPARATOR');
    expect(() => assertBuilderCode('a'.repeat(64))).toThrow('BUILDER_CODE_TOO_LONG');
    expect(() => assertBuilderCode('bc_\u00e9')).toThrow('BUILDER_CODE_NON_PRINTABLE');
    expect(() => assertBuilderCode('bc_\n')).toThrow('BUILDER_CODE_NON_PRINTABLE');
    expect(() => encodeBuilderCodeSuffix(['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63), 'e'.repeat(63)])).toThrow('BUILDER_CODE_DATA_TOO_LONG');
  });

  it('de-duplicates repeated codes instead of double counting attribution', () => {
    expect(encodeBuilderCodeSuffix(['bc_abc123', 'bc_abc123'])).toBe(ONE_CODE);
  });

  it('appends once and refuses to stack a second suffix', () => {
    const suffix = encodeBuilderCodeSuffix(['bc_abc123']);
    const call = '0x095ea7b3000000000000000000000000' as const;
    const attributed = appendBuilderCodeSuffix(call, suffix);
    expect(attributed).toBe(`${call}${ONE_CODE.slice(2)}`);
    expect(hasBuilderCodeSuffix(attributed)).toBe(true);
    expect(() => appendBuilderCodeSuffix(attributed, suffix)).toThrow('BUILDER_CODE_DUPLICATE_SUFFIX');
  });

  it('leaves value-only transfers untouched so ETH sends stay plain', () => {
    const suffix = encodeBuilderCodeSuffix(['bc_abc123']);
    expect(appendBuilderCodeSuffix(undefined, suffix)).toBe('0x');
    expect(appendBuilderCodeSuffix('0x', suffix)).toBe('0x');
  });

  it('fails closed on malformed suffix or calldata hex', () => {
    expect(() => appendBuilderCodeSuffix('0xzz', encodeBuilderCodeSuffix(['bc_abc123']))).toThrow('BUILDER_CODE_DATA_INVALID');
    expect(() => appendBuilderCodeSuffix('0xdeadbeef', '0x123' as never)).toThrow('BUILDER_CODE_SUFFIX_INVALID');
    expect(() => decodeBuilderCodeSuffix('0x80218021802180218021802180218021')).toThrow();
    expect(() => decodeBuilderCodeSuffix('0x010280218021802180218021802180218021')).toThrow('BUILDER_CODE_SCHEMA_UNSUPPORTED');
  });
});
