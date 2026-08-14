import { describe, expect, it } from 'vitest';

import {
  assertLiveFccE2eEvidence,
  liveFccProofRows,
  resolveSettlementRouter,
} from '../packages/flare-core/src/fccE2e';

const ISOLATED_ROUTER = '0xb136b8a143bF358Ae7976ED558BBB054fd13faE9';
const BROWSER_PROXY = '0x7fA1817951dE405a0c466696052cF50Eba409333';
const FAKE_D9 = `0x${'d9'.repeat(32)}`;
const DUMMY_GOLDEN = '0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975';
const LIVE_SWAP = '0xf8542ac805c222617e916c4738761fb301e2ab4f80e7ef97e857eaf1441e96f9';
const LIVE_DISPATCH = '0xbe72307c388333c57463e66fecb95516679f25610005e8bfff9253288dabf063';
const LIVE_ACTION = '0xa179a2619ecc05db3f2599f1f94aa3c68c8a3ec56c5428dbbd3b7ea62e9c8b28';
const LIVE_ROUTE = '0xfa3c292e753018e65493ede84c7c362f8ac5315dfbf0c74d74d007f638540581';

const live = {
  router: ISOLATED_ROUTER,
  extensionId: 66283,
  instructionSender: '0x55aA4F400f3819498eD4Cbe120839E609f0897F3',
  dispatchHash: LIVE_DISPATCH,
  actionId: LIVE_ACTION,
  routeHash: LIVE_ROUTE,
  swapHash: LIVE_SWAP,
};

describe('live FCC e2e evidence', () => {
  it('rejects fake 0xd9 hashes, the dummy golden route, and the browser proxy router', () => {
    expect(() => assertLiveFccE2eEvidence({ ...live, swapHash: FAKE_D9 })).toThrow('FAKE_D9_HASH');
    expect(() => assertLiveFccE2eEvidence({ ...live, routeHash: DUMMY_GOLDEN })).toThrow('DUMMY_GOLDEN_ROUTE');
    expect(() => assertLiveFccE2eEvidence({ ...live, router: BROWSER_PROXY })).toThrow('BROWSER_PROXY_ROUTER');
    expect(() => assertLiveFccE2eEvidence({ ...live, extensionId: 66280 })).toThrow('WRONG_EXTENSION');
  });

  it('accepts the isolated 66283 router path and exposes copy-safe proof rows', () => {
    expect(assertLiveFccE2eEvidence(live)).toEqual(live);
    expect(resolveSettlementRouter({ __FLARE_ROUTER__: ISOLATED_ROUTER }, BROWSER_PROXY)).toBe(ISOLATED_ROUTER);
    expect(resolveSettlementRouter({}, BROWSER_PROXY)).toBe(BROWSER_PROXY);
    expect(liveFccProofRows(live)).toEqual([
      ['Router', ISOLATED_ROUTER],
      ['Extension', '66283'],
      ['Action', LIVE_ACTION],
      ['Route hash', LIVE_ROUTE],
      ['Dispatch', LIVE_DISPATCH],
      ['Swap', LIVE_SWAP],
    ]);
  });
});
