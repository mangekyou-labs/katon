import { rankSwapQuotes } from '../packages/base-core/src/swap.ts';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const B20 = '0xb200000000000000000000C2e324d24d7eEcd1fb';
const TAKER = '0x0000000000000000000000000000000000000a01';
const RFQ_ID = `0x${'11'.repeat(32)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;

const warmupSamples = 25;
const measuredSamples = 100;

function address(index) {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function buildInput() {
  const now = 1_800_000_000n;
  const request = {
    requestId: RFQ_ID,
    stockToken: B20,
    usdcToken: USDC,
    sellAmount: 1_000_000n,
    minBuyAmount: 9_000_000n,
    taker: TAKER,
    recipient: TAKER,
    deadline: now + 1_800n,
    now,
    auctionOpenedAtMs: 100_000,
    auctionCutoffAtMs: 101_000,
    feeBps: 5n,
    chainId: 84532,
    decisionBlock: 51_068_301n,
    decisionBlockHash: `0x${'81'.repeat(32)}`,
  };
  const order = (maker, salt) => ({
    maker,
    signer: maker,
    stockToken: B20,
    usdcToken: USDC,
    stockAmount: 1_000_000n,
    usdcAmount: 10_000_000n + BigInt(salt * 10_000),
    fillMode: 1,
    expiry: now + 3_600n,
    salt: BigInt(salt),
    feeCapBps: 50,
    allowedTaker: TAKER,
    rfqId: RFQ_ID,
  });
  return {
    request,
    makerQuotes: Array.from({ length: 8 }, (_, index) => {
      const maker = address(index + 1);
      return {
        source: 'LP',
        maker,
        order: order(maker, index + 1),
        quoteId: `0x${(index + 1).toString(16).padStart(2, '0').repeat(32)}`,
        signature: `0x${'11'.repeat(65)}`,
        capacity: 1_000_000n,
        receivedAtMs: 100_001 + index,
        gasEstimateUsdc: 1_000n,
      };
    }),
    facilityQuotes: [],
    externalQuotes: [],
  };
}

function percentile(samples, fraction) {
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * fraction) - 1));
  return samples[index] ?? 0;
}

function runSample(input) {
  const started = performance.now();
  const result = rankSwapQuotes(input);
  const elapsed = performance.now() - started;
  if (result.status !== 'WINNER' || !result.recommended) throw new Error('BASE_RANK_BENCHMARK_NO_WINNER');
  return elapsed;
}

try {
  const input = buildInput();
  for (let index = 0; index < warmupSamples; index += 1) runSample(input);
  const samples = [];
  const started = performance.now();
  for (let index = 0; index < measuredSamples; index += 1) samples.push(runSample(input));
  const totalMs = performance.now() - started;
  samples.sort((left, right) => left - right);
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const max = samples.at(-1) ?? 0;
  if (p95 >= 200) throw new Error(`BASE_RANK_BENCHMARK_SLOW:p95=${p95.toFixed(3)}`);
  console.log(
    `base-rank-benchmark=PASS warmup=${warmupSamples} samples=${measuredSamples} `
      + `totalMs=${totalMs.toFixed(3)} p50Ms=${p50.toFixed(3)} `
    + `p95Ms=${p95.toFixed(3)} maxMs=${max.toFixed(3)} thresholdMs=200 rpcExcluded=true`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
