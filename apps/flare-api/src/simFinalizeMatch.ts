import type { Address, Hex } from 'viem';

import { matchAuction, type MatcherAuction, type MatcherBid } from '../../../packages/flare-core/src/matcher';
import type { SwapRoutePlan } from '../../../packages/flare-core/src/routeHash';
import type { MatchOnFinalize } from './blindRelay';

interface SimAuctionPayload {
  readonly auction: MatcherAuction;
  readonly routePlan: SwapRoutePlan;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('SIM_MATCH_PAYLOAD_REQUIRED');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SIM_MATCH_PAYLOAD_REQUIRED');
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('SIM_MATCH_PAYLOAD_REQUIRED');
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new Error('SIM_MATCH_PAYLOAD_REQUIRED');
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value.trim() !== '') return BigInt(value);
  throw new Error('SIM_MATCH_PAYLOAD_REQUIRED');
}

function reviveAuction(value: unknown): MatcherAuction {
  const row = asRecord(value);
  return {
    commitment: asString(row.commitment),
    chainId: asNumber(row.chainId),
    router: asString(row.router),
    sellToken: asString(row.sellToken),
    buyToken: asString(row.buyToken),
    sellAmount: asBigInt(row.sellAmount),
    minOutput: asBigInt(row.minOutput),
    decisionDeadline: asNumber(row.decisionDeadline),
  };
}

function reviveRoutePlan(value: unknown): SwapRoutePlan {
  const row = asRecord(value);
  const legsRaw = row.legs;
  if (!Array.isArray(legsRaw) || legsRaw.length === 0) throw new Error('SIM_MATCH_PAYLOAD_REQUIRED');
  return {
    chainId: asBigInt(row.chainId),
    router: asString(row.router) as Address,
    commitment: asString(row.commitment) as Hex,
    fccActionId: asString(row.fccActionId) as Hex,
    decisionBlock: asBigInt(row.decisionBlock),
    decisionBlockHash: asString(row.decisionBlockHash) as Hex,
    deadline: asBigInt(row.deadline),
    seller: asString(row.seller) as Address,
    recipient: asString(row.recipient) as Address,
    sellToken: asString(row.sellToken) as Address,
    buyToken: asString(row.buyToken) as Address,
    sellAmount: asBigInt(row.sellAmount),
    minOutput: asBigInt(row.minOutput),
    protocolFeeBps: asNumber(row.protocolFeeBps),
    eligibilityPolicyId: asString(row.eligibilityPolicyId) as Hex,
    eligibilityRevocationEpoch: asBigInt(row.eligibilityRevocationEpoch),
    eligibilityRole: asBigInt(row.eligibilityRole),
    eligibilityIssuerReference: asString(row.eligibilityIssuerReference) as Hex,
    legs: legsRaw.map((leg) => {
      const item = asRecord(leg);
      return {
        source: asString(item.source) as Address,
        sellAmount: asBigInt(item.sellAmount),
        minOutput: asBigInt(item.minOutput),
        sourceData: asString(item.sourceData) as Hex,
      };
    }),
  };
}

function reviveBid(value: unknown, fallbackBidder: string): MatcherBid {
  const row = asRecord(value);
  return {
    commitment: asString(row.commitment),
    bidder: typeof row.bidder === 'string' && row.bidder.length > 0 ? row.bidder : fallbackBidder,
    sellToken: asString(row.sellToken),
    buyToken: asString(row.buyToken),
    sellAmount: asBigInt(row.sellAmount),
    quotedOutput: asBigInt(row.quotedOutput),
    sequence: asBigInt(row.sequence),
    expiresAt: asNumber(row.expiresAt),
  };
}

export function createSimFinalizeMatch(env: {
  readonly fccMode?: string;
} = {}): MatchOnFinalize {
  const mode = env.fccMode ?? 'simulated';
  if (mode === 'real') {
    return () => {
      throw new Error('DEDICATED_EXTENSION_REQUIRED');
    };
  }
  if (mode !== 'simulated') throw new Error('FCC_MODE_INVALID');

  return ({ auctionEnvelope, bids, now }) => {
    const payload = asRecord(parseJson(auctionEnvelope.ciphertext)) as unknown as SimAuctionPayload;
    const auction = reviveAuction(payload.auction);
    const routePlan = reviveRoutePlan(payload.routePlan);
    const matcherBids = bids.map((bid) => reviveBid(parseJson(bid.envelope.ciphertext), bid.lpId));
    return matchAuction(auction, matcherBids, now, routePlan);
  };
}
