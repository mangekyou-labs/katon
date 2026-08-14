// The ticket's counterparty gate. The important case is `checksum`: a mistyped
// character inside an otherwise well-shaped address passes ADDR_RE, and an
// order sent to a non-existent account is signed, stored, and unfillable.

import { describe, expect, it } from 'vitest';
import { checkAddress, normalizeAddress } from './address';
import { ADDR_RE } from './tokens';

// Two real, distinct Testnet-shaped public keys.
const A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const B = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('checkAddress', () => {
  it('accepts a valid address', () => {
    expect(checkAddress(A)).toBe('ok');
    expect(checkAddress(B)).toBe('ok');
  });

  it('grades what is wrong', () => {
    expect(checkAddress('')).toBe('empty');
    expect(checkAddress('MA5ZSEJY')).toBe('start');
    expect(checkAddress(`G${'1'.repeat(55)}`)).toBe('charset'); // 1 is not in base32
    expect(checkAddress('GA5ZSEJY')).toBe('length');
  });

  it('rejects your own address', () => {
    expect(checkAddress(A, A)).toBe('self');
    expect(checkAddress(A, B)).toBe('ok');
  });

  // The whole reason this module exists.
  it('catches a one-character typo that ADDR_RE lets through', () => {
    const typo = `${A.slice(0, 30)}${A[30] === 'X' ? 'Y' : 'X'}${A.slice(31)}`;
    expect(typo).not.toBe(A);
    expect(ADDR_RE.test(typo)).toBe(true); // shape is fine…
    expect(checkAddress(typo)).toBe('checksum'); // …the CRC is not
  });
});

describe('normalizeAddress', () => {
  it('uppercases, strips whitespace, and caps the length', () => {
    expect(normalizeAddress(' ga5z sejy \n')).toBe('GA5ZSEJY');
    expect(normalizeAddress('G'.repeat(80)).length).toBe(64);
  });
});
