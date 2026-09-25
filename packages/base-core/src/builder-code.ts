import type { Hex } from 'viem';

/**
 * ERC-8021 attribution suffix (Base Builder Codes).
 *
 * Layout: `[schema-0 data][uint8 dataLength][uint8 schemaId][16-byte marker]`.
 * Schema 0 data is the comma-joined builder-code list. The marker is sixteen
 * bytes of `0x8021`, a tail no real calldata selector relies on.
 *
 * This module is intentionally dependency-free and Buffer-free: the same code
 * runs in the browser wallet boundary and in Node tooling.
 */
export const ERC8021_MARKER = '0x80218021802180218021802180218021' as const;
export const ERC8021_SCHEMA_ID = 0 as const;
/** Schema 0 payload is encoded with a single byte length, so at most 255 bytes. */
export const ERC8021_MAX_DATA_BYTES = 255;
/** Builder Codes are short opaque identifiers from base.dev. */
export const ERC8021_CODE_MAX_BYTES = 63;

const MARKER_HEX = ERC8021_MARKER.slice(2).toLowerCase();

function assertHex(value: unknown, code: string): asserts value is Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(code);
}

/**
 * Validate one builder code. Codes are joined with `,`, so a comma inside a code
 * would corrupt the suffix; non-printable bytes are rejected outright. Because
 * only printable ASCII survives, byte length equals string length.
 */
export function assertBuilderCode(code: string): string {
  if (typeof code !== 'string' || code.length === 0) throw new Error('BUILDER_CODE_INVALID');
  if (code.includes(',')) throw new Error('BUILDER_CODE_SEPARATOR');
  if (code.length > ERC8021_CODE_MAX_BYTES) throw new Error('BUILDER_CODE_TOO_LONG');
  for (let index = 0; index < code.length; index += 1) {
    const point = code.charCodeAt(index);
    if (point < 0x21 || point > 0x7e) throw new Error('BUILDER_CODE_NON_PRINTABLE');
  }
  return code;
}

function asciiToHex(value: string): string {
  let hex = '';
  for (let index = 0; index < value.length; index += 1) {
    hex += value.charCodeAt(index).toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToAscii(value: string): string {
  let text = '';
  for (let index = 0; index < value.length; index += 2) {
    text += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return text;
}

/** Encode one or more builder codes into the exact ERC-8021 suffix. */
export function encodeBuilderCodeSuffix(codes: readonly string[]): Hex {
  if (!Array.isArray(codes) || codes.length === 0) throw new Error('BUILDER_CODE_REQUIRED');
  const unique = [...new Set(codes.map((code) => assertBuilderCode(code)))];
  const data = unique.join(',');
  if (data.length > ERC8021_MAX_DATA_BYTES) throw new Error('BUILDER_CODE_DATA_TOO_LONG');
  const trailer = `${data.length.toString(16).padStart(2, '0')}${ERC8021_SCHEMA_ID.toString(16).padStart(2, '0')}`;
  return `0x${asciiToHex(data)}${trailer}${MARKER_HEX}` as Hex;
}

/** True when calldata already carries an ERC-8021 attribution suffix. */
export function hasBuilderCodeSuffix(data: Hex): boolean {
  assertHex(data, 'BUILDER_CODE_DATA_INVALID');
  return data.length >= ERC8021_MARKER.length && data.slice(2).toLowerCase().endsWith(MARKER_HEX);
}

export interface DecodedAttribution {
  readonly schemaId: number;
  readonly codes: readonly string[];
}

/** Decode an attribution suffix for verification and duplicate detection. */
export function decodeBuilderCodeSuffix(data: Hex): DecodedAttribution | undefined {
  assertHex(data, 'BUILDER_CODE_DATA_INVALID');
  if (!hasBuilderCodeSuffix(data)) return undefined;
  const payload = data.slice(2, -MARKER_HEX.length);
  const trailerHex = payload.slice(-4);
  const dataLength = Number.parseInt(trailerHex.slice(0, 2), 16);
  const schemaId = Number.parseInt(trailerHex.slice(2, 4), 16);
  if (schemaId !== ERC8021_SCHEMA_ID) throw new Error('BUILDER_CODE_SCHEMA_UNSUPPORTED');
  const dataHex = payload.slice(0, payload.length - 4);
  if (dataHex.length / 2 !== dataLength) throw new Error('BUILDER_CODE_LENGTH_MISMATCH');
  const text = hexToAscii(dataHex);
  const codes = text.length === 0 ? [] : text.split(',');
  if (codes.some((code) => code.length === 0)) throw new Error('BUILDER_CODE_INVALID');
  return { schemaId, codes };
}

/**
 * Append the attribution suffix to calldata. A duplicate suffix is a hard
 * error: silently stacking markers would double-count attribution and inflate
 * every attributed call. Value-only transfers (`0x`) stay untouched so a plain
 * ETH send never becomes a contract call.
 */
export function appendBuilderCodeSuffix(data: Hex | undefined, suffix: Hex): Hex {
  assertHex(suffix, 'BUILDER_CODE_SUFFIX_INVALID');
  const callerData = data === undefined || data === '0x' ? '0x' : data;
  assertHex(callerData, 'BUILDER_CODE_DATA_INVALID');
  if (callerData === '0x') return '0x';
  if (hasBuilderCodeSuffix(callerData)) throw new Error('BUILDER_CODE_DUPLICATE_SUFFIX');
  return `${callerData}${suffix.slice(2)}` as Hex;
}
