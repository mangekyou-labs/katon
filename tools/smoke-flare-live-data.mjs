import { createPublicClient, http } from 'viem';
import { flareTestnet } from 'viem/chains';

import { readFdcRoundFinality, readLiveFtsoFeed } from '../packages/flare-sdk/src/data.ts';
import { loadWorktreeEnv } from './load-worktree-env.mjs';

loadWorktreeEnv();

const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const registryAddress = process.env.FLARE_CONTRACT_REGISTRY_ADDRESS ?? '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
const feedId = process.env.FLARE_FTSO_FEED_ID ?? '0x01464c522f55534400000000000000000000000000';
const votingRoundId = Number(process.env.FLARE_FDC_VOTING_ROUND ?? 0);
const client = createPublicClient({ chain: flareTestnet, transport: http(rpcUrl) });
const feed = await readLiveFtsoFeed(client, { network: 'coston2', registryAddress, feedId });
const finality = await readFdcRoundFinality(client, { network: 'coston2', registryAddress, votingRoundId });
console.log(JSON.stringify({
  liveData: 'PASS',
  network: 'coston2',
  feed: { id: feed.feedId, value: feed.value.toString(), decimals: feed.decimals, timestamp: feed.timestamp },
  fdc: { votingRoundId, ...finality },
}));
