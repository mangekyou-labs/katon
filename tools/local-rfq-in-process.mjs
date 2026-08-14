import { pathToFileURL } from 'node:url';

import { BlindRelay } from '../apps/flare-api/src/blindRelay.ts';
import { createSimFinalizeMatch } from '../apps/flare-api/src/simFinalizeMatch.ts';
import { measureAsyncOperation } from './elapsed-evidence.mjs';
import { buildSimRelayEnvelopes } from './sim-rfq-payload.mjs';

const WALLET = '0x00000000000000000000000000000000000000aa';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runInProcessConfidentialRfq({
  nowSeconds = 1_700_000_000,
  now,
} = {}) {
  const auctionId = 'in-process-rfq';
  const { auctionEnvelope, bidEnvelope } = buildSimRelayEnvelopes({
    wallet: WALLET,
    now: nowSeconds,
  });
  const relay = new BlindRelay({
    matchOnFinalize: createSimFinalizeMatch({ fccMode: 'simulated' }),
  });
  relay.openAuction({
    id: auctionId,
    seller: WALLET,
    envelope: auctionEnvelope,
    eligibleLps: [WALLET],
    duration: '24h',
    openedAt: nowSeconds,
    earlyCloseAllowed: true,
  });
  relay.submitBid({
    auctionId,
    lpId: WALLET,
    idempotencyKey: 'in-process-bid',
    envelope: bidEnvelope,
    now: nowSeconds,
  });

  const beforeFinalize = relay.readAuction(auctionId, WALLET, nowSeconds);
  const relayOpaqueEnvelopeOnly = !('sellToken' in beforeFinalize)
    && !('buyToken' in beforeFinalize)
    && !('sellAmount' in beforeFinalize)
    && !('routePlan' in beforeFinalize)
    && typeof beforeFinalize.envelope.ciphertext === 'string';
  assert(relayOpaqueEnvelopeOnly, 'RELAY_PLAINTEXT_STATE_EXPOSED');

  const measured = await measureAsyncOperation(
    () => relay.finalizeAuction(auctionId, WALLET, nowSeconds + 1),
    now,
  );
  const finalized = measured.value;
  assert(finalized.status === 'finalized', 'SIM_FINALIZE_STATUS');
  assert(finalized.bidCount === 1, 'SIM_FINALIZE_BID_COUNT');
  assert(finalized.matchResult?.winnerLpId === WALLET, 'SIM_FINALIZE_WINNER');
  assert(/^0x[0-9a-f]{64}$/.test(finalized.matchResult?.resultHash ?? ''), 'SIM_FINALIZE_RESULT_HASH');

  let realModeError = '';
  try {
    createSimFinalizeMatch({ fccMode: 'real' })({
      auctionId,
      seller: WALLET,
      auctionEnvelope,
      bids: [],
      now: nowSeconds,
    });
  } catch (error) {
    realModeError = error instanceof Error ? error.message : String(error);
  }
  assert(realModeError === 'DEDICATED_EXTENSION_REQUIRED', 'REAL_MODE_DID_NOT_FAIL_CLOSED');

  return {
    mode: 'simulated',
    scenarioNow: nowSeconds,
    auctionId,
    status: finalized.status,
    bidCount: finalized.bidCount,
    winnerLpId: finalized.matchResult.winnerLpId,
    resultHash: finalized.matchResult.resultHash,
    matcherElapsedMs: measured.elapsedMs,
    relayOpaqueEnvelopeOnly,
    realModeFailClosed: true,
    realModeError,
    notProductionFcc: true,
  };
}

async function main() {
  const result = await runInProcessConfidentialRfq();
  console.log([
    'local-rfq-in-process=PASS',
    `mode=${result.mode}`,
    `scenarioNow=${result.scenarioNow}`,
    `auction=${result.auctionId}`,
    `resultHash=${result.resultHash}`,
    `winnerLpId=${result.winnerLpId}`,
    `matcherElapsedMs=${result.matcherElapsedMs.toFixed(3)}`,
    `relayOpaqueEnvelopeOnly=${result.relayOpaqueEnvelopeOnly}`,
    `realModeFailClosed=${result.realModeFailClosed}`,
    `realModeError=${result.realModeError}`,
    `notProductionFcc=${result.notProductionFcc}`,
  ].join(' '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
