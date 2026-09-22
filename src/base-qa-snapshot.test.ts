import { describe, expect, it, vi } from 'vitest';
import {
  BaseForkQaSnapshotPort,
  assertBaseForkQaSnapshotEnvironment,
  parseBaseForkQaSnapshotConfig,
} from '../apps/base-api/src/qa';
import { BASE_FORK_BLOCK, BASE_FORK_BLOCK_HASH, BASE_MAINNET_CHAIN_ID, BASE_MAINNET_NATIVE_USDC } from '../tools/base-deployment-lib.mjs';

const address = (digit: string): `0x${string}` => `0x${digit.repeat(40)}`;
const hash = (digit: string): `0x${string}` => `0x${digit.repeat(64)}`;

const raw = {
  chainId: BASE_MAINNET_CHAIN_ID,
  nativeUsdc: BASE_MAINNET_NATIVE_USDC.toLowerCase(),
  b20: address('2'),
  adapter: address('3'),
  marketId: hash('4'),
  oracleGuard: address('5'),
  b20Guard: address('6'),
  router: address('7'),
  settlement: address('9'),
  lp: address('8'),
  feed: address('a'),
  ticker: 'MOCKB20',
  decimals: 18,
  classification: 'BASE_MAINNET_FORK_QA',
  venueEvidence: false,
  forkBlock: BASE_FORK_BLOCK,
  forkBlockHash: BASE_FORK_BLOCK_HASH,
};

describe('Base mainnet fork QA live snapshot adapter', () => {
  it('accepts only the isolated loopback 8453 fork classification', () => {
    expect(parseBaseForkQaSnapshotConfig(JSON.stringify(raw))).toMatchObject(raw);
    expect(() => parseBaseForkQaSnapshotConfig(JSON.stringify({ ...raw, venueEvidence: true }))).toThrow('BASE_FORK_QA_SNAPSHOT_CLASSIFICATION');
    expect(() => assertBaseForkQaSnapshotEnvironment(BASE_MAINNET_CHAIN_ID, 'http://127.0.0.1:8545')).not.toThrow();
    expect(() => assertBaseForkQaSnapshotEnvironment(BASE_MAINNET_CHAIN_ID, 'https://sepolia.base.org')).toThrow('BASE_FORK_QA_SNAPSHOT_LOOPBACK');
    expect(() => assertBaseForkQaSnapshotEnvironment(84_532, 'http://127.0.0.1:8545')).toThrow('BASE_FORK_QA_SNAPSHOT_CHAIN');
  });

  it('builds a fresh floor from a pinned live block and live mock guard reads', async () => {
    const readContract = vi.fn(async ({ functionName }: { readonly functionName: string }) => {
      if (functionName === 'snapshot') return [100_000_000n, 1_999n, 8, true, 1n, false];
      if (functionName === 'multiplierWad') return 1_000_000_000_000_000_000n;
      return undefined;
    });
    const port = new BaseForkQaSnapshotPort({
      getBlock: vi.fn(async () => ({ number: 42n, timestamp: 2_000n, hash: hash('e') })),
      readContract,
    }, parseBaseForkQaSnapshotConfig(JSON.stringify(raw)));

    const result = await port.getForRfq({
      id: hash('a'), opportunityKey: 'qa', rfqId: hash('a'), poster: address('0'), borrower: address('0'),
      debtAsset: raw.nativeUsdc, collateralAsset: raw.b20, marketId: raw.marketId,
      repayAssets: '1000000', minCollateralOut: '1000000', deadline: '3000', createdAt: '2000', status: 'open',
    }, 2_000n);

    expect(result.decisionBlock).toBe(42n);
    expect(result.decisionBlockHash).toBe(hash('e'));
    expect(result.venue.chainlinkAnswerWad).toBe(1_000_000_000_000_000_000n);
    expect(result.venue.b20MultiplierWad).toBe(1_000_000_000_000_000_000n);
    expect(result.aerodrome).toEqual({ impliedCollateral: 1_100_000n, updatedAt: 2_000n, maxAge: 60n });
    expect(result.adapterSlot).toBe(raw.adapter);
    expect(result.candidateAuthorizations).toEqual([{ source: 'LP', identity: raw.lp, executorAuthorized: true, recipientAuthorized: true }]);
    expect(readContract.mock.calls.map(([call]) => call.functionName)).toEqual(expect.arrayContaining([
      'snapshot', 'requireFresh', 'multiplierWad', 'requireTransferAndSeizeLive', 'requireTransferAuthorized',
    ]));
  });

  it('rejects an RFQ outside the manifest-pinned mock market', async () => {
    const port = new BaseForkQaSnapshotPort({
      getBlock: vi.fn(),
      readContract: vi.fn(),
    }, parseBaseForkQaSnapshotConfig(JSON.stringify(raw)));
    await expect(port.getForRfq({
      id: hash('a'), opportunityKey: 'qa', rfqId: hash('a'), poster: address('0'), borrower: address('0'),
      debtAsset: raw.nativeUsdc, collateralAsset: raw.b20, marketId: hash('f'),
      repayAssets: '1', minCollateralOut: '1', deadline: '3', createdAt: '1', status: 'open',
    }, 2n)).rejects.toThrow('BASE_QA_SNAPSHOT_MARKET');
  });
});
