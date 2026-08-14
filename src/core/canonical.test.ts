// Golden-vector regression for the signature boundary.
//
// fixtures/canonical-args.json was captured from the LIVE vanilla stack — the
// esm.sh module graph the deployed desk loads today (see tools/capture.html).
// These tests assert the TypeScript port reproduces those bytes exactly.
//
// This is the tripwire for the migration's one silent failure mode: a bundler
// substituting a different Buffer, or a reordered / re-encoded argument. Both
// simulate cleanly for the submitter and both invalidate the counterparty's
// signature, so the only symptom would be a real `fill` reverting on-chain.

import { describe, expect, it } from 'vitest';
import fixtures from '../../fixtures/canonical-args.json';
import { canonicalPayload, fillCanonicalArgs, sacIdFor, toStroops } from './canonical';

const PASSPHRASE = fixtures.networkPassphrase;

describe('sacIdFor', () => {
  for (const [token, expected] of Object.entries(fixtures.sacIds)) {
    it(`derives ${token.split(':')[0]} -> ${expected.slice(0, 8)}…`, () => {
      expect(sacIdFor(token, PASSPHRASE)).toBe(expected);
    });
  }
});

describe('toStroops', () => {
  it('scales by 10^7 without floating point', () => {
    expect(toStroops('123.4567891')).toBe(1234567891n);
    expect(toStroops('250')).toBe(2500000000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('9999999.9999999')).toBe(99999999999999n);
  });

  it('pads short fractions rather than truncating them', () => {
    // '0.1' is 1_000_000 stroops, not 1. A naive parseFloat port gets this right
    // by accident and 0.0000001 wrong; this pins both ends.
    expect(toStroops('0.1')).toBe(1000000n);
  });
});

describe('fillCanonicalArgs', () => {
  for (const v of fixtures.vectors) {
    it(`reproduces the captured XDR for ${v.name}`, async () => {
      const args = await fillCanonicalArgs(v.order, PASSPHRASE);
      expect(args.map((a) => a.toXDR('base64'))).toEqual(v.fillArgsXdr);
    });
  }

  it('is deterministic across calls', async () => {
    const [v] = fixtures.vectors;
    const a = await fillCanonicalArgs(v.order, PASSPHRASE);
    const b = await fillCanonicalArgs(v.order, PASSPHRASE);
    expect(a.map((x) => x.toXDR('base64'))).toEqual(b.map((x) => x.toXDR('base64')));
  });

  it('changes when an amount changes — the tamper guard', async () => {
    const [v] = fixtures.vectors;
    const tampered = { ...v.order, maker_amount: '123.4567892' };
    const args = await fillCanonicalArgs(tampered, PASSPHRASE);
    expect(args.map((a) => a.toXDR('base64'))).not.toEqual(v.fillArgsXdr);
  });
});

describe('canonicalPayload', () => {
  for (const v of fixtures.vectors) {
    it(`reproduces the captured payload for ${v.name}`, () => {
      expect(canonicalPayload(v.order)).toBe(v.canonicalPayload);
    });
  }

  it('pins key order — reordering the input must not change the output', () => {
    const [v] = fixtures.vectors;
    const shuffled = {
      nonce: v.order.nonce,
      taker_token: v.order.taker_token,
      maker_address: v.order.maker_address,
      expiration: v.order.expiration,
      taker_amount: v.order.taker_amount,
      maker_token: v.order.maker_token,
      taker_address: v.order.taker_address,
      maker_amount: v.order.maker_amount,
    };
    expect(canonicalPayload(shuffled)).toBe(v.canonicalPayload);
  });
});
