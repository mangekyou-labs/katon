import { B20_ASSETS_BY_ADDRESS } from './assets';
import { DEFAULT_SEQUENCER_GRACE_PERIOD_SECONDS, type Address } from './network';

export const SEQUENCER_UPTIME_FEED: Address = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433';
export const SEQUENCER_GRACE_PERIOD_SECONDS = DEFAULT_SEQUENCER_GRACE_PERIOD_SECONDS;

/** Base's published Chainlink feed policy for tokenized-stock settlement. */
export const CHAINLINK_FEED_HEARTBEAT_SECONDS = 86_400;
export const CHAINLINK_FEED_DEVIATION_BPS = 50;

export interface ChainlinkFeedPolicy {
  readonly heartbeatSeconds: number;
  readonly deviationBps: number;
}

export const CHAINLINK_FEED_POLICY: ChainlinkFeedPolicy = {
  heartbeatSeconds: CHAINLINK_FEED_HEARTBEAT_SECONDS,
  deviationBps: CHAINLINK_FEED_DEVIATION_BPS,
};

export const CHAINLINK_FEED_POLICY_BY_TOKEN = Object.fromEntries(
  Object.keys(B20_ASSETS_BY_ADDRESS).map((token) => [token, CHAINLINK_FEED_POLICY]),
) as Record<Address, ChainlinkFeedPolicy>;

export const CHAINLINK_TOTAL_RETURN_FEEDS_BY_TOKEN = Object.fromEntries(
  Object.entries(B20_ASSETS_BY_ADDRESS).map(([token, asset]) => [token, asset.feed]),
) as Record<Address, Address>;

/** Convert a positive integer Chainlink answer with the required 8 decimals into WAD. */
export function chainlinkAnswerToWad(answer: bigint, decimals: number): bigint {
  if (typeof answer !== 'bigint') throw new Error('INTEGER_ONLY: answer');
  if (!Number.isInteger(decimals)) throw new Error('INTEGER_ONLY: decimals');
  if (answer <= 0n) throw new Error('ORACLE_NON_POSITIVE');
  if (decimals !== 8) throw new Error('ORACLE_DECIMALS');
  return answer * 10_000_000_000n;
}
