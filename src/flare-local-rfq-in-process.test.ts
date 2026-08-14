import { describe, expect, it } from 'vitest';

import { runInProcessConfidentialRfq } from '../tools/local-rfq-in-process.mjs';

describe('in-process confidential RFQ evidence', () => {
  it('measures the real simulated matcher lifecycle and proves real mode fails closed', async () => {
    const ticks = [10, 16.75];

    await expect(runInProcessConfidentialRfq({
      nowSeconds: 1_000,
      now: () => ticks.shift() ?? Number.NaN,
    })).resolves.toEqual({
      mode: 'simulated',
      scenarioNow: 1_000,
      auctionId: 'in-process-rfq',
      status: 'finalized',
      bidCount: 1,
      winnerLpId: '0x00000000000000000000000000000000000000aa',
      resultHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      matcherElapsedMs: 6.75,
      relayOpaqueEnvelopeOnly: true,
      realModeFailClosed: true,
      realModeError: 'DEDICATED_EXTENSION_REQUIRED',
      notProductionFcc: true,
    });
  });
});
