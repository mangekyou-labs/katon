import { describe, expect, it } from 'vitest';

import { BlindRelay, RelayKeyRegistry, toPublicRelayError } from '../apps/flare-api/src/blindRelay';
import { plaintextWorkflowError } from '../apps/flare-api/src/plaintextWorkflow';
import { createSimFinalizeMatch } from '../apps/flare-api/src/simFinalizeMatch';
import { matchAuction } from '../packages/flare-core/src/matcher';
import { hashSwapRoute, type SwapRoutePlan } from '../packages/flare-core/src/routeHash';

const envelope = {
  version: 1 as const,
  keyId: 'tee-key',
  commitment: '0xauction',
  expiresAt: 20_000_000,
  nonce: 'opaque-nonce',
  ciphertext: 'opaque-ciphertext',
};

describe('blind relay API boundary', () => {
  it('stores ciphertext and non-sensitive metadata only, with idempotent bid intake', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'auction-1', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    expect(relay.submitBid({ auctionId: 'auction-1', lpId: 'lp-1', idempotencyKey: 'retry-1', envelope })).toEqual({ accepted: true });
    expect(relay.submitBid({ auctionId: 'auction-1', lpId: 'lp-1', idempotencyKey: 'retry-1', envelope })).toEqual({ accepted: true });
    const read = relay.readAuction('auction-1', 'seller');
    expect(read).toMatchObject({ id: 'auction-1', bidCount: 1 });
    expect(JSON.stringify(read)).not.toContain('plaintext');
  });

  it('does not deliver an auction envelope to an ineligible LP', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'auction-1', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    expect(() => relay.readAuction('auction-1', 'lp-2')).toThrow('RFQ_NOT_ELIGIBLE');
  });

  it('supports only scheduled durations and seller-authorized early finalization', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'auction-2', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '1w', openedAt: 1_000 });
    expect(relay.readAuction('auction-2', 'seller', 1_001)).toMatchObject({ duration: '1w', status: 'open', earlyCloseAllowed: false, expiresAt: 1_000 + 7 * 24 * 60 * 60 });
    expect(() => relay.finalizeAuction('auction-2', 'lp-1', 1_001)).toThrow('AUCTION_FINALIZE_AUTH');
    expect(() => relay.finalizeAuction('auction-2', 'seller', 1_001)).toThrow('AUCTION_EARLY_CLOSE_DISABLED');
    relay.openAuction({ id: 'auction-2-allowed', seller: 'seller', envelope: { ...envelope, commitment: '0xallowed' }, eligibleLps: ['lp-1'], duration: '1w', openedAt: 1_000, earlyCloseAllowed: true });
    expect(relay.finalizeAuction('auction-2-allowed', 'seller', 1_001)).toMatchObject({ status: 'finalized', earlyCloseAllowed: true });
  });

  it('expires an unfinalized auction at its deterministic deadline', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'auction-3', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    expect(relay.readAuction('auction-3', 'seller', 1_000 + 24 * 60 * 60)).toMatchObject({ status: 'expired' });
    expect(() => relay.submitBid({ auctionId: 'auction-3', lpId: 'lp-1', idempotencyKey: 'late', envelope, now: 1_000 + 24 * 60 * 60 })).toThrow('AUCTION_CLOSED');
  });

  it('resumes role-scoped lifecycle events from a cursor without duplicates', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'auction-4', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    relay.submitBid({ auctionId: 'auction-4', lpId: 'lp-1', idempotencyKey: 'bid-1', envelope });
    const first = relay.readEvents('seller');
    expect(first.events.map((event) => event.kind)).toEqual(['auction.opened', 'bid.accepted']);
    relay.submitBid({ auctionId: 'auction-4', lpId: 'lp-1', idempotencyKey: 'bid-1', envelope });
    relay.cancelAuction('auction-4', 'seller', 1_001);
    const resumed = relay.readEvents('seller', first.cursor);
    expect(resumed.events.map((event) => event.kind)).toEqual(['auction.cancelled']);
    expect(relay.readEvents('lp-2').events).toEqual([]);
  });

  it('publishes only role-scoped events to an active resumable subscriber', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'auction-live', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    const received: string[] = [];
    const unsubscribe = relay.subscribe('lp-1', 0, (event) => received.push(event.kind));
    relay.submitBid({ auctionId: 'auction-live', lpId: 'lp-1', idempotencyKey: 'live-1', envelope });
    relay.cancelAuction('auction-live', 'seller', 1_001);
    unsubscribe();
    expect(received).toEqual(['auction.opened', 'bid.accepted', 'auction.cancelled']);
  });

  it('serializes only stable public error codes', () => {
    expect(toPublicRelayError(new Error('RFQ_NOT_ELIGIBLE'))).toEqual({
      code: 'RFQ_NOT_ELIGIBLE',
      message: 'RFQ_NOT_ELIGIBLE',
    });
    expect(toPublicRelayError(new Error('private stack and payload'))).toEqual({
      code: 'RFQ_REQUEST_FAILED',
      message: 'RFQ_REQUEST_FAILED',
    });
  });

  it('does not allow cancellation after the scheduled deadline', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'auction-5', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    expect(() => relay.cancelAuction('auction-5', 'seller', 1_000 + 24 * 60 * 60)).toThrow('AUCTION_CLOSED');
  });

  it('restores opaque relay state and cursors after a process restart', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'durable', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    relay.submitBid({ auctionId: 'durable', lpId: 'lp-1', idempotencyKey: 'bid-1', envelope });
    const restored = new BlindRelay();
    restored.restore(relay.snapshot());
    expect(restored.readAuction('durable', 'lp-1')).toMatchObject({ id: 'durable', bidCount: 1 });
    expect(restored.readEvents('seller').events.map((event) => event.kind)).toEqual(['auction.opened', 'bid.accepted']);
    expect(JSON.stringify(restored.snapshot())).toContain('opaque-ciphertext');
  });

  it('lists only role-authorized relay metadata without exposing envelope contents', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'seller-auction', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    relay.openAuction({ id: 'lp-auction', seller: 'other-seller', envelope: { ...envelope, commitment: '0xother' }, eligibleLps: ['lp-1'], duration: '1w', openedAt: 1_000 });
    expect(relay.listAuctions('lp-1')).toEqual([
      expect.objectContaining({ id: 'seller-auction', commitment: '0xauction', bidCount: 0 }),
      expect.objectContaining({ id: 'lp-auction', commitment: '0xother', duration: '1w' }),
    ]);
    expect(JSON.stringify(relay.listAuctions('lp-1'))).not.toContain('opaque-ciphertext');
    expect(relay.listAuctions('ineligible')).toEqual([]);
  });

  it('pages role-authorized relay metadata with a stable opaque cursor', () => {
    const relay = new BlindRelay();
    for (const id of ['page-1', 'page-2', 'page-3']) {
      relay.openAuction({ id, seller: 'seller', envelope: { ...envelope, commitment: `0x${id}` }, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    }
    const first = relay.listAuctionPage('lp-1', undefined, 2);
    expect(first.auctions.map((auction) => auction.id)).toEqual(['page-1', 'page-2']);
    expect(first.nextCursor).toBe('page-2');
    const second = relay.listAuctionPage('lp-1', first.nextCursor, 2);
    expect(second.auctions.map((auction) => auction.id)).toEqual(['page-3']);
    expect(second.nextCursor).toBeUndefined();
    expect(() => relay.listAuctionPage('lp-1', 'missing', 2)).toThrow('CURSOR_INVALID');
  });

  it('scopes LP encryption keys and makes rotation/revocation time-bound', () => {
    const keys = new RelayKeyRegistry();
    keys.register({ lpId: 'lp-1', keyId: 'key-a', publicKey: 'pub-a', activatedAt: 100, expiresAt: 200 });
    expect(keys.resolve('lp-1', 'key-a', 150)).toBe('pub-a');
    expect(() => keys.resolve('lp-2', 'key-a', 150)).toThrow('RFQ_KEY_SCOPE');
    expect(() => keys.resolve('lp-1', 'key-a', 200)).toThrow('RFQ_KEY_EXPIRED');

    keys.rotate({ lpId: 'lp-1', keyId: 'key-b', publicKey: 'pub-b', activatedAt: 180, expiresAt: 300 });
    expect(keys.resolve('lp-1', 'key-a', 179)).toBe('pub-a');
    expect(() => keys.resolve('lp-1', 'key-a', 180)).toThrow('RFQ_KEY_REVOKED');
    expect(keys.resolve('lp-1', 'key-b', 200)).toBe('pub-b');
    keys.revoke('lp-1', 'key-b', 220);
    expect(() => keys.resolve('lp-1', 'key-b', 220)).toThrow('RFQ_KEY_REVOKED');
  });

  it('restores the active LP encryption-key registry without private material', () => {
    const keys = new RelayKeyRegistry();
    keys.register({ lpId: 'lp-1', keyId: 'key-a', publicKey: 'pub-a', activatedAt: 100, expiresAt: 200 });
    keys.rotate({ lpId: 'lp-1', keyId: 'key-b', publicKey: 'pub-b', activatedAt: 180, expiresAt: 300 });
    const restored = new RelayKeyRegistry();
    restored.restore(keys.snapshot());
    expect(restored.resolve('lp-1', 'key-b', 200)).toBe('pub-b');
    expect(() => restored.resolve('lp-1', 'key-a', 180)).toThrow('RFQ_KEY_REVOKED');
    expect(JSON.stringify(restored.snapshot())).not.toContain('private');
  });

  it('bounds opaque payload size, eligibility fanout, and bid intake', () => {
    expect(() => new BlindRelay({ maxEnvelopeBytes: 10 }).openAuction({
      id: 'oversized', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000,
    })).toThrow('RFQ_PAYLOAD_TOO_LARGE');

    expect(() => new BlindRelay({ maxEligibleLps: 1 }).openAuction({
      id: 'too-many-lps', seller: 'seller', envelope, eligibleLps: ['lp-1', 'lp-2'], duration: '24h', openedAt: 1_000,
    })).toThrow('RFQ_ELIGIBILITY');

    const relay = new BlindRelay({ maxBidsPerAuction: 1 });
    relay.openAuction({ id: 'limited', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    relay.submitBid({ auctionId: 'limited', lpId: 'lp-1', idempotencyKey: 'bid-1', envelope });
    expect(() => relay.submitBid({ auctionId: 'limited', lpId: 'lp-1', idempotencyKey: 'bid-2', envelope })).toThrow(
      'RFQ_RATE_LIMIT',
    );
    expect(() => relay.submitBid({ auctionId: 'limited', lpId: 'lp-1', idempotencyKey: '', envelope })).toThrow('RFQ_INPUT');
  });

  it('persists bid envelopes and restores them after a process restart', () => {
    const relay = new BlindRelay();
    relay.openAuction({ id: 'book', seller: 'seller', envelope, eligibleLps: ['lp-1'], duration: '24h', openedAt: 1_000 });
    relay.submitBid({
      auctionId: 'book',
      lpId: 'lp-1',
      idempotencyKey: 'bid-1',
      envelope: { ...envelope, ciphertext: 'opaque-bid-ciphertext' },
    });
    const snapshot = relay.snapshot();
    expect(JSON.stringify(snapshot)).toContain('opaque-bid-ciphertext');
    expect(relay.readBids('book', 'seller')).toEqual([
      expect.objectContaining({
        lpId: 'lp-1',
        idempotencyKey: 'bid-1',
        envelope: expect.objectContaining({ ciphertext: 'opaque-bid-ciphertext' }),
      }),
    ]);
    expect(() => relay.readBids('book', 'stranger')).toThrow('RFQ_NOT_ELIGIBLE');

    const restored = new BlindRelay();
    restored.restore(snapshot);
    expect(restored.readBids('book', 'lp-1')[0]?.envelope.ciphertext).toBe('opaque-bid-ciphertext');
    expect(JSON.stringify(restored.readAuction('book', 'seller'))).not.toContain('plaintext');
  });

  it('finalizes by ranking persisted bids through the shared matcher hash', () => {
    const routePlan: SwapRoutePlan = {
      chainId: 114n,
      router: '0x00000000000000000000000000000000000000aa',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000011',
      fccActionId: '0x0000000000000000000000000000000000000000000000000000000000000022',
      decisionBlock: 1n,
      decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000033',
      deadline: 2_000_000_000n,
      seller: '0x00000000000000000000000000000000000000c1',
      recipient: '0x00000000000000000000000000000000000000c2',
      sellToken: '0x0000000000000000000000000000000000000010',
      buyToken: '0x0000000000000000000000000000000000000020',
      sellAmount: 100n,
      minOutput: 90n,
      protocolFeeBps: 50,
      eligibilityPolicyId: '0x0000000000000000000000000000000000000000000000000000000000000044',
      eligibilityRevocationEpoch: 0n,
      eligibilityRole: 1n,
      eligibilityIssuerReference: '0x0000000000000000000000000000000000000000000000000000000000000055',
      legs: [{
        source: '0x00000000000000000000000000000000000000b1',
        sellAmount: 100n,
        minOutput: 90n,
        sourceData: '0x010203',
      }],
    };
    const relay = new BlindRelay({
      matchOnFinalize: ({ bids }) => {
        expect(bids).toHaveLength(1);
        expect(bids[0]?.envelope.ciphertext).toBe('opaque-bid-ciphertext');
        return matchAuction(
          {
            commitment: routePlan.commitment,
            chainId: 114,
            router: routePlan.router,
            sellToken: routePlan.sellToken,
            buyToken: routePlan.buyToken,
            sellAmount: 100n,
            minOutput: 90n,
            decisionDeadline: 2_000,
          },
          [{
            commitment: '0x00000000000000000000000000000000000000000000000000000000000000aa',
            bidder: 'lp-1',
            sellToken: routePlan.sellToken,
            buyToken: routePlan.buyToken,
            sellAmount: 100n,
            quotedOutput: 100n,
            sequence: 1n,
            expiresAt: 2_100,
          }],
          1_000,
          routePlan,
        );
      },
    });
    relay.openAuction({
      id: 'matchable',
      seller: 'seller',
      envelope: { ...envelope, commitment: routePlan.commitment },
      eligibleLps: ['lp-1'],
      duration: '24h',
      openedAt: 1_000,
      earlyCloseAllowed: true,
    });
    relay.submitBid({
      auctionId: 'matchable',
      lpId: 'lp-1',
      idempotencyKey: 'bid-1',
      envelope: { ...envelope, commitment: routePlan.commitment, ciphertext: 'opaque-bid-ciphertext' },
    });
    const finalized = relay.finalizeAuction('matchable', 'seller', 1_001);
    expect(finalized.status).toBe('finalized');
    expect(finalized.matchResult?.resultHash).toBe(hashSwapRoute(routePlan));
    expect(finalized.matchResult?.winnerLpId).toBe('lp-1');
  });

  it('simulated finalize match hashes a JSON sim payload through hashSwapRoute', () => {
    const routePlan: SwapRoutePlan = {
      chainId: 114n,
      router: '0x00000000000000000000000000000000000000aa',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000011',
      fccActionId: '0x0000000000000000000000000000000000000000000000000000000000000022',
      decisionBlock: 1n,
      decisionBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000033',
      deadline: 2_000_000_000n,
      seller: '0x00000000000000000000000000000000000000c1',
      recipient: '0x00000000000000000000000000000000000000c2',
      sellToken: '0x0000000000000000000000000000000000000010',
      buyToken: '0x0000000000000000000000000000000000000020',
      sellAmount: 100n,
      minOutput: 90n,
      protocolFeeBps: 50,
      eligibilityPolicyId: '0x0000000000000000000000000000000000000000000000000000000000000044',
      eligibilityRevocationEpoch: 0n,
      eligibilityRole: 1n,
      eligibilityIssuerReference: '0x0000000000000000000000000000000000000000000000000000000000000055',
      legs: [{
        source: '0x00000000000000000000000000000000000000b1',
        sellAmount: 100n,
        minOutput: 90n,
        sourceData: '0x010203',
      }],
    };
    const auctionCiphertext = JSON.stringify({
      auction: {
        commitment: routePlan.commitment,
        chainId: 114,
        router: routePlan.router,
        sellToken: routePlan.sellToken,
        buyToken: routePlan.buyToken,
        sellAmount: '100',
        minOutput: '90',
        decisionDeadline: 2_000,
      },
      routePlan: {
        ...routePlan,
        chainId: routePlan.chainId.toString(),
        decisionBlock: routePlan.decisionBlock.toString(),
        deadline: routePlan.deadline.toString(),
        sellAmount: routePlan.sellAmount.toString(),
        minOutput: routePlan.minOutput.toString(),
        eligibilityRevocationEpoch: routePlan.eligibilityRevocationEpoch.toString(),
        eligibilityRole: routePlan.eligibilityRole.toString(),
        legs: routePlan.legs.map((leg) => ({
          ...leg,
          sellAmount: leg.sellAmount.toString(),
          minOutput: leg.minOutput.toString(),
        })),
      },
    });
    const bidCiphertext = JSON.stringify({
      commitment: '0x00000000000000000000000000000000000000000000000000000000000000aa',
      bidder: 'lp-1',
      sellToken: routePlan.sellToken,
      buyToken: routePlan.buyToken,
      sellAmount: '100',
      quotedOutput: '100',
      sequence: '1',
      expiresAt: 2_100,
    });
    const relay = new BlindRelay({ matchOnFinalize: createSimFinalizeMatch({ fccMode: 'simulated' }) });
    relay.openAuction({
      id: 'sim-match',
      seller: 'seller',
      envelope: { ...envelope, commitment: routePlan.commitment, ciphertext: auctionCiphertext },
      eligibleLps: ['lp-1'],
      duration: '24h',
      openedAt: 1_000,
      earlyCloseAllowed: true,
    });
    relay.submitBid({
      auctionId: 'sim-match',
      lpId: 'lp-1',
      idempotencyKey: 'bid-1',
      envelope: { ...envelope, commitment: routePlan.commitment, ciphertext: bidCiphertext },
    });
    const finalized = relay.finalizeAuction('sim-match', 'seller', 1_001);
    expect(finalized.matchResult?.resultHash).toBe(hashSwapRoute(routePlan));
    expect(finalized.matchResult?.winnerLpId).toBe('lp-1');
  });

  it('fails closed when FCC mode is real without a dedicated extension', () => {
    expect(() => createSimFinalizeMatch({ fccMode: 'real' })({
      auctionId: 'x',
      seller: 'seller',
      auctionEnvelope: envelope,
      bids: [],
      now: 1,
    })).toThrow('DEDICATED_EXTENSION_REQUIRED');
  });

  it('fails closed on plaintext auction and standing-bid workflow routes', () => {
    expect(plaintextWorkflowError('POST', '/v1/auctions')).toBe('PLAINTEXT_WORKFLOW_DISABLED');
    expect(plaintextWorkflowError('POST', '/v1/standing-bids')).toBe('PLAINTEXT_WORKFLOW_DISABLED');
    expect(plaintextWorkflowError('POST', '/v1/relay/auctions')).toBeUndefined();
    expect(plaintextWorkflowError('GET', '/v1/auctions')).toBeUndefined();
  });
});
