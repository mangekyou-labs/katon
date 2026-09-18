import type { Address, Hex } from 'viem';
import type { LiquidationRankInput } from '../../../packages/base-core/src/index';
import type { BaseSnapshotPort, StoredLiquidation } from './types';

const ORACLE_GUARD_ABI = [
  {
    type: 'function', name: 'snapshot', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'answer', type: 'int256' }, { name: 'updatedAt', type: 'uint256' },
      { name: 'decimals', type: 'uint8' }, { name: 'sequencerUp', type: 'bool' },
      { name: 'sequencerStartedAt', type: 'uint256' }, { name: 'registryPaused', type: 'bool' },
    ],
  },
  { type: 'function', name: 'requireFresh', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
] as const;

const B20_GUARD_ABI = [
  { type: 'function', name: 'multiplierWad', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'requireTransferAndSeizeLive', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [] },
  {
    type: 'function', name: 'requireTransferAuthorized', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'sender', type: 'address' }, { name: 'recipient', type: 'address' }], outputs: [],
  },
] as const;

export interface BaseForkQaSnapshotConfig {
  readonly chainId: 8453;
  readonly nativeUsdc: Address;
  readonly b20: Address;
  readonly adapter: Address;
  readonly marketId: Hex;
  readonly oracleGuard: Address;
  readonly b20Guard: Address;
  readonly router: Address;
  readonly settlement: Address;
  readonly lp: Address;
  readonly feed: Address;
  readonly ticker: string;
  readonly decimals: number;
  readonly classification: 'BASE_MAINNET_FORK_QA';
  readonly venueEvidence: false;
  readonly forkBlock: number;
  readonly forkBlockHash: Hex;
}

interface BaseForkQaReadClient {
  getBlock(): Promise<{ readonly number: bigint | null; readonly timestamp: bigint; readonly hash: Hex | null }>;
  readContract(input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * An explicit, local-only snapshot bridge for the Base-mainnet fork QA stack.
 * Its classification is intentionally carried in process configuration so it can
 * never be mistaken for independent venue evidence.
 */
export class BaseForkQaSnapshotPort implements BaseSnapshotPort {
  constructor(
    private readonly client: BaseForkQaReadClient,
    private readonly config: BaseForkQaSnapshotConfig,
  ) {}

  async getForRfq(liquidation: StoredLiquidation, now: bigint): Promise<LiquidationRankInput> {
    if (liquidation.debtAsset.toLowerCase() !== this.config.nativeUsdc.toLowerCase()) throw new Error('BASE_QA_SNAPSHOT_DEBT_ASSET');
    if (liquidation.collateralAsset.toLowerCase() !== this.config.b20.toLowerCase()) throw new Error('BASE_QA_SNAPSHOT_COLLATERAL_ASSET');
    if (liquidation.marketId.toLowerCase() !== this.config.marketId.toLowerCase()) throw new Error('BASE_QA_SNAPSHOT_MARKET');

    const block = await this.client.getBlock();
    if (block.number === null || block.hash === null) throw new Error('BASE_QA_SNAPSHOT_BLOCK');
    const [snapshotResult, multiplierResult] = await Promise.all([
      this.client.readContract({
        address: this.config.oracleGuard,
        abi: ORACLE_GUARD_ABI,
        functionName: 'snapshot',
        args: [this.config.b20],
        blockNumber: block.number,
      }),
      this.client.readContract({
        address: this.config.b20Guard,
        abi: B20_GUARD_ABI,
        functionName: 'multiplierWad',
        args: [this.config.b20],
        blockNumber: block.number,
      }),
      this.client.readContract({
        address: this.config.oracleGuard,
        abi: ORACLE_GUARD_ABI,
        functionName: 'requireFresh',
        args: [this.config.b20],
        blockNumber: block.number,
      }),
      this.client.readContract({
        address: this.config.b20Guard,
        abi: B20_GUARD_ABI,
        functionName: 'requireTransferAndSeizeLive',
        args: [this.config.b20],
        blockNumber: block.number,
      }),
      this.client.readContract({
        address: this.config.b20Guard,
        abi: B20_GUARD_ABI,
        functionName: 'requireTransferAuthorized',
        args: [this.config.b20, this.config.adapter, this.config.router],
        blockNumber: block.number,
      }),
      this.client.readContract({
        address: this.config.b20Guard,
        abi: B20_GUARD_ABI,
        functionName: 'requireTransferAuthorized',
        args: [this.config.b20, this.config.router, this.config.lp],
        blockNumber: block.number,
      }),
    ]);
    if (!Array.isArray(snapshotResult) || snapshotResult.length !== 6) throw new Error('BASE_QA_SNAPSHOT_ORACLE');
    const [answer, , decimals, sequencerUp, , registryPaused] = snapshotResult as [bigint, bigint, number, boolean, bigint, boolean];
    if (answer <= 0n || decimals > 18 || !sequencerUp || registryPaused) throw new Error('BASE_QA_SNAPSHOT_ORACLE');
    const multiplier = multiplierResult as bigint;
    if (typeof multiplier !== 'bigint' || multiplier <= 0n) throw new Error('BASE_QA_SNAPSHOT_MULTIPLIER');
    const repayAssets = BigInt(liquidation.repayAssets);

    return {
      now,
      nativeUsdc: this.config.nativeUsdc,
      rfq: {
        rfqId: liquidation.rfqId,
        debtAsset: liquidation.debtAsset,
        collateralAsset: liquidation.collateralAsset,
        repayAssets,
        minCollateralOut: BigInt(liquidation.minCollateralOut),
        deadline: BigInt(liquidation.deadline),
        venue: this.config.adapter,
        marketId: liquidation.marketId,
      },
      venue: {
        closeFactorWad: 1_000_000_000_000_000_000n,
        liquidationBonusWad: 1_100_000_000_000_000_000n,
        chainlinkAnswerWad: answer * 10n ** BigInt(18 - decimals),
        b20MultiplierWad: multiplier,
      },
      feeBps: 0n,
      aerodrome: {
        impliedCollateral: repayAssets * 11n / 10n,
        // The pinned fork block is a historical snapshot whose timestamp can
        // be ahead of the QA host clock.  This floor is a local synthetic
        // quote, so freshness is measured at the observer clock while the
        // decision block remains bound to the pinned live fork read.
        updatedAt: now,
        maxAge: 60n,
      },
      oracleAvailable: true,
      sequencerUp: true,
      b20TransferEnabled: true,
      b20SeizeEnabled: true,
      recipientAuthorized: true,
      candidateAuthorizations: [{
        source: 'LP',
        identity: this.config.lp,
        executorAuthorized: true,
        recipientAuthorized: true,
      }],
      decisionBlock: block.number,
      decisionBlockHash: block.hash,
      domain: {
        name: 'KatonRFQSettlement',
        version: '1',
        chainId: this.config.chainId,
        verifyingContract: this.config.settlement,
      },
      adapterSlot: this.config.adapter,
      bids: [],
      facilityQuotes: [],
    };
  }
}

export function parseBaseForkQaSnapshotConfig(value: string | undefined): BaseForkQaSnapshotConfig {
  if (!value) throw new Error('BASE_FORK_QA_SNAPSHOT_CONFIG');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('BASE_FORK_QA_SNAPSHOT_CONFIG'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('BASE_FORK_QA_SNAPSHOT_CONFIG');
  const record = parsed as Record<string, unknown>;
  if (record.chainId !== 8_453) throw new Error('BASE_FORK_QA_SNAPSHOT_CHAIN');
  if (record.classification !== 'BASE_MAINNET_FORK_QA' || record.venueEvidence !== false) throw new Error('BASE_FORK_QA_SNAPSHOT_CLASSIFICATION');
  if (record.forkBlock !== 51_068_301 || typeof record.forkBlockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(record.forkBlockHash) || record.forkBlockHash.toLowerCase() !== '0x81ceda4cb39bf70b057c08dc2d70b201b5190ecb8ebb79ccdca3e12b1d73ea41') throw new Error('BASE_FORK_QA_SNAPSHOT_PIN');
  if (typeof record.ticker !== 'string' || !/^[A-Z0-9]{2,12}$/.test(record.ticker)) throw new Error('BASE_FORK_QA_SNAPSHOT_ASSET');
  if (!Number.isInteger(record.decimals) || Number(record.decimals) < 0 || Number(record.decimals) > 36) throw new Error('BASE_FORK_QA_SNAPSHOT_ASSET');
  return {
    chainId: 8_453,
    nativeUsdc: requiredAddress(record.nativeUsdc, 'nativeUsdc'),
    b20: requiredAddress(record.b20, 'b20'),
    adapter: requiredAddress(record.adapter, 'adapter'),
    marketId: requiredHash(record.marketId, 'marketId'),
    oracleGuard: requiredAddress(record.oracleGuard, 'oracleGuard'),
    b20Guard: requiredAddress(record.b20Guard, 'b20Guard'),
    router: requiredAddress(record.router, 'router'),
    settlement: requiredAddress(record.settlement, 'settlement'),
    lp: requiredAddress(record.lp, 'lp'),
    feed: requiredAddress(record.feed, 'feed'),
    ticker: record.ticker,
    decimals: Number(record.decimals),
    classification: 'BASE_MAINNET_FORK_QA',
    venueEvidence: false,
    forkBlock: Number(record.forkBlock),
    forkBlockHash: requiredHash(record.forkBlockHash, 'forkBlockHash'),
  };
}

export function assertBaseForkQaSnapshotEnvironment(chainId: number, rpcUrl: string): void {
  if (chainId !== 8_453) throw new Error('BASE_FORK_QA_SNAPSHOT_CHAIN');
  let url: URL;
  try { url = new URL(rpcUrl); } catch { throw new Error('BASE_QA_SNAPSHOT_LOOPBACK'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !['http:', 'ws:'].includes(url.protocol)) {
    throw new Error('BASE_FORK_QA_SNAPSHOT_LOOPBACK');
  }
}

function requiredAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`BASE_QA_SNAPSHOT_ADDRESS:${field}`);
  return value.toLowerCase() as Address;
}

function requiredHash(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`BASE_QA_SNAPSHOT_HASH:${field}`);
  return value.toLowerCase() as Hex;
}
