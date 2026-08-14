import { type Hex } from 'viem';

import { rankSources } from './canonical';
import { hashSwapRoute, type SwapRoutePlan } from './routeHash';

export interface MatcherAuction {
  readonly commitment: string;
  readonly chainId: number;
  readonly router: string;
  readonly sellToken: string;
  readonly buyToken: string;
  readonly sellAmount: bigint;
  readonly minOutput: bigint;
  readonly decisionDeadline: number;
}

export interface MatcherBid {
  readonly commitment: string;
  readonly bidder: string;
  readonly sellToken: string;
  readonly buyToken: string;
  readonly sellAmount: bigint;
  readonly quotedOutput: bigint;
  readonly sequence: bigint;
  readonly expiresAt: number;
}

export interface MatchResult {
  readonly winner: MatcherBid;
  readonly resultHash: Hex;
  readonly routeCommitment: string;
}

export interface TEEResult {
  readonly resultHash: string;
  readonly teeId: string;
  readonly attested: boolean;
}

export interface QuorumResult {
  readonly resultHash: string;
  readonly signers: string[];
}

export function matchAuction(
  auction: MatcherAuction,
  bids: readonly MatcherBid[],
  nowSeconds: number,
  routePlan?: SwapRoutePlan,
): MatchResult {
	if (
		!auction.commitment || auction.chainId <= 0 || !auction.router || !auction.sellToken || !auction.buyToken ||
		auction.sellToken === auction.buyToken || auction.sellAmount <= 0n || auction.minOutput < 0n || auction.decisionDeadline < 0
	) throw new Error('AUCTION_INPUT');
  if (nowSeconds > auction.decisionDeadline) throw new Error('AUCTION_CLOSED');
  const seen = new Set<string>();
  const valid = bids.filter((bid) => {
		if (!bid.commitment || !bid.bidder || bid.sequence < 0n || bid.quotedOutput < 0n || bid.expiresAt < 0) {
			throw new Error('BID_INPUT');
		}
    if (seen.has(bid.commitment)) throw new Error('DUPLICATE_BID');
    seen.add(bid.commitment);
    if (bid.sellToken !== auction.sellToken || bid.buyToken !== auction.buyToken) {
      throw new Error('BID_PAIR');
    }
    if (bid.sellAmount !== auction.sellAmount) throw new Error('BID_AMOUNT');
    if (bid.expiresAt < nowSeconds || bid.expiresAt < auction.decisionDeadline) {
      return false;
    }
    return bid.quotedOutput >= auction.minOutput;
  });
  if (valid.length === 0) throw new Error('NO_EXECUTABLE_ROUTE');
  const winner = rankSources(
    valid.map((bid) => ({
      kind: 'lp' as const,
      commitment: bid.commitment,
      quotedOutput: bid.quotedOutput,
      sequence: bid.sequence,
    })),
  )[0];
  const selected = valid.find((bid) => bid.commitment === winner.commitment);
  if (!selected) throw new Error('MATCHER_INTERNAL');
  if (!routePlan) throw new Error('ROUTE_PLAN_REQUIRED');
  if (
    routePlan.chainId !== BigInt(auction.chainId) ||
    routePlan.router.toLowerCase() !== auction.router.toLowerCase() ||
    routePlan.commitment.toLowerCase() !== auction.commitment.toLowerCase() ||
    routePlan.sellToken.toLowerCase() !== auction.sellToken.toLowerCase() ||
    routePlan.buyToken.toLowerCase() !== auction.buyToken.toLowerCase() ||
    routePlan.sellAmount !== auction.sellAmount ||
    routePlan.minOutput < auction.minOutput
  ) {
    throw new Error('ROUTE_PLAN_MISMATCH');
  }
  return {
    winner: selected,
    resultHash: hashSwapRoute(routePlan),
    routeCommitment: auction.commitment,
  };
}

export function verifyQuorum(results: readonly TEEResult[], threshold = 2): QuorumResult {
  if (threshold !== 2) throw new Error('QUORUM_UNAVAILABLE');
  const groups = new Map<string, string[]>();
  const seenTEE = new Set<string>();
  for (const result of results) {
    if (!result.attested || !result.resultHash || !result.teeId || seenTEE.has(result.teeId)) continue;
    seenTEE.add(result.teeId);
    const group = groups.get(result.resultHash) ?? [];
    group.push(result.teeId);
    groups.set(result.resultHash, group);
  }
  const matching = [...groups.entries()]
    .filter(([, signers]) => signers.length >= threshold)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (matching.length === 0) throw new Error('QUORUM_UNAVAILABLE');
  const [resultHash, signers] = matching[0];
  return { resultHash, signers: [...signers].sort() };
}
