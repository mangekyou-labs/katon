import { getAddress, keccak256, toHex, type Hex } from 'viem';

import { type MatcherAuction, type MatcherBid } from './matcher';
import { hashSwapRoute, type SwapRoutePlan } from './routeHash';

export interface ConfidentialMatchRequest {
  readonly auction: MatcherAuction;
  readonly bids: readonly MatcherBid[];
  readonly now: number;
  readonly routePlan: SwapRoutePlan;
}

export interface ConfidentialMatchEnvelope {
  readonly actionId: Hex;
  readonly expectedHash: Hex;
  readonly envelope: Hex;
  readonly request: ConfidentialMatchRequest;
}

function hex32(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('ROUTE_PLAN_REQUIRED');
  return value.toLowerCase() as Hex;
}

function dec(value: bigint): string {
  return value.toString();
}

/** MATCH/FINALIZE plaintext whose hashed routePlan is the dispatch action's result. */
export function buildConfidentialMatchEnvelope(route: SwapRoutePlan): ConfidentialMatchEnvelope {
  if (route.chainId !== 114n) throw new Error('FCC_CHAIN_ID');
  if (route.legs.length === 0) throw new Error('ROUTE_LEGS');
  const actionId = hex32(route.fccActionId);
  const expectedHash = hashSwapRoute(route);
  const auction: MatcherAuction = {
    commitment: hex32(route.commitment),
    chainId: Number(route.chainId),
    router: getAddress(route.router),
    sellToken: getAddress(route.sellToken),
    buyToken: getAddress(route.buyToken),
    sellAmount: route.sellAmount,
    minOutput: route.minOutput,
    decisionDeadline: 2_000,
  };
  const bid: MatcherBid = {
    commitment: keccak256(route.commitment),
    bidder: getAddress(route.legs[0].source),
    sellToken: getAddress(route.sellToken),
    buyToken: getAddress(route.buyToken),
    sellAmount: route.sellAmount,
    quotedOutput: route.legs[0].minOutput,
    sequence: 1n,
    expiresAt: 2_100,
  };
  const request: ConfidentialMatchRequest = { auction, bids: [bid], now: 1_000, routePlan: route };
  const payload = {
    auction: {
      commitment: auction.commitment,
      chainId: auction.chainId,
      router: auction.router,
      sellToken: auction.sellToken,
      buyToken: auction.buyToken,
      sellAmount: dec(auction.sellAmount),
      minOutput: dec(auction.minOutput),
      decisionDeadline: auction.decisionDeadline,
    },
    bids: [{
      commitment: bid.commitment,
      bidder: bid.bidder,
      sellToken: bid.sellToken,
      buyToken: bid.buyToken,
      sellAmount: dec(bid.sellAmount),
      quotedOutput: dec(bid.quotedOutput),
      sequence: bid.sequence.toString(),
      expiresAt: bid.expiresAt,
    }],
    now: request.now,
    routePlan: {
      chainId: Number(route.chainId),
      router: getAddress(route.router),
      commitment: hex32(route.commitment),
      fccActionId: actionId,
      decisionBlock: dec(route.decisionBlock),
      decisionBlockHash: hex32(route.decisionBlockHash),
      deadline: dec(route.deadline),
      seller: getAddress(route.seller),
      recipient: getAddress(route.recipient),
      sellToken: getAddress(route.sellToken),
      buyToken: getAddress(route.buyToken),
      sellAmount: dec(route.sellAmount),
      minOutput: dec(route.minOutput),
      protocolFeeBps: route.protocolFeeBps,
      eligibilityPolicyId: hex32(route.eligibilityPolicyId),
      eligibilityRevocationEpoch: dec(route.eligibilityRevocationEpoch),
      eligibilityRole: dec(route.eligibilityRole),
      eligibilityIssuerReference: hex32(route.eligibilityIssuerReference),
      legs: route.legs.map((leg) => ({
        source: getAddress(leg.source),
        sellAmount: dec(leg.sellAmount),
        minOutput: dec(leg.minOutput),
        sourceData: leg.sourceData,
      })),
    },
  };
  return { actionId, expectedHash, envelope: toHex(JSON.stringify(payload)), request };
}
