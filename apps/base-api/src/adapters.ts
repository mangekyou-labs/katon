import { verifyTypedData, type Address, type Hex, type PublicClient } from 'viem';
import {
  hashLiquidationFundingOrder,
  LIQUIDATION_FUNDING_ORDER_TYPES,
  hashSwapOrder,
  SWAP_ORDER_TYPES,
  type LiquidationFundingDomain,
  type LiquidationFundingOrder,
  type SwapOrder,
  type SwapOrderDomain,
  type LiquidationRankInput,
} from '../../../packages/base-core/src/index';
import type {
  BaseClock,
  BaseFacilitySnapshot,
  BaseOracleSnapshot,
  BaseSignaturePort,
  BaseSnapshotPort,
  BaseSignatureVerificationResult,
  BaseSwapInternalSimulationRequest,
  BaseSwapPreflightPort,
  BaseSwapPreflightRequest,
  BaseSwapPreflightResult,
  BaseSwapPreflightSnapshot,
  StoredLiquidation,
} from './types';
import type { BaseRepository } from './ports';

const SETTLEMENT_READ_ABI = [
  {
    type: 'function',
    name: 'filled',
    stateMutability: 'view',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'cancelled',
    stateMutability: 'view',
    inputs: [{ name: 'maker', type: 'address' }, { name: 'orderHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'orderSigners',
    stateMutability: 'view',
    inputs: [{ name: 'maker', type: 'address' }, { name: 'signer', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'swapFilled',
    stateMutability: 'view',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ERC1271_ABI = [{
  type: 'function',
  name: 'isValidSignature',
  stateMutability: 'view',
  inputs: [{ name: 'digest', type: 'bytes32' }, { name: 'signature', type: 'bytes' }],
  outputs: [{ name: 'magicValue', type: 'bytes4' }],
}] as const;

const ERC1271_MAGIC_VALUE = '0x1626ba7e';

const ERC20_ALLOWANCE_ABI = [{
  type: 'function',
  name: 'allowance',
  stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

function validBlockHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value);
}

function validAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
}

/**
 * Read-only viem adapter for the swap execution preflight. The adapter owns
 * both block selection and simulation; quote providers only return liquidity
 * packets and cannot inject decision/simulation metadata.
 */
export class ViemBaseSwapPreflightPort implements BaseSwapPreflightPort {
  constructor(
    private readonly client: PublicClient,
    private readonly maxDecisionBlockAge: bigint,
    private readonly routerAddress?: Address,
    private readonly settlementAddress?: Address,
  ) {}

  async captureSnapshot(): Promise<BaseSwapPreflightSnapshot> {
    if (this.maxDecisionBlockAge < 1n) throw new Error('PREFLIGHT_BLOCK_AGE_INVALID');
    const latest = await this.readBlock('latest');
    if (latest.number === undefined || !validBlockHash(latest.hash) || latest.number < 1n) {
      throw new Error('PREFLIGHT_BLOCK_UNAVAILABLE');
    }
    const decisionNumber = latest.number - 1n;
    const decision = await this.readBlock(decisionNumber);
    const simulation = await this.readBlock(latest.number);
    if (decision.number !== decisionNumber || simulation.number !== latest.number) throw new Error('PREFLIGHT_BLOCK_MISMATCH');
    if (!validBlockHash(decision.hash) || !validBlockHash(simulation.hash)) throw new Error('PREFLIGHT_HASH_INVALID');
    if (simulation.number < decision.number || simulation.number - decision.number > this.maxDecisionBlockAge) throw new Error('PREFLIGHT_BLOCK_STALE');
    return {
      decisionBlock: decision.number,
      decisionBlockHash: decision.hash,
      simulationBlock: simulation.number,
      simulationBlockHash: simulation.hash,
    };
  }

  async simulateInternalRoute(input: BaseSwapInternalSimulationRequest): Promise<BaseSwapPreflightResult> {
    if (input.route.kind !== 'INTERNAL') throw new Error('PREFLIGHT_ROUTE_INVALID');
    if (!validAddress(input.request.taker) || !validAddress(input.request.stockToken) || !validAddress(input.allowanceTarget)) {
      throw new Error('PREFLIGHT_INPUT_INVALID');
    }
    if (this.maxDecisionBlockAge < 1n) throw new Error('PREFLIGHT_BLOCK_AGE_INVALID');
    if (this.settlementAddress && input.allowanceTarget.toLowerCase() !== this.settlementAddress.toLowerCase()) {
      throw new Error('PREFLIGHT_ALLOWANCE_TARGET_INVALID');
    }
    if (this.routerAddress && input.transaction.to.toLowerCase() !== this.routerAddress.toLowerCase()) {
      throw new Error('PREFLIGHT_ROUTER_TARGET_INVALID');
    }
    const snapshot = input.snapshot;
    if (snapshot.decisionBlock <= 0n || snapshot.simulationBlock < snapshot.decisionBlock) throw new Error('PREFLIGHT_BLOCK_INVALID');
    if (snapshot.simulationBlock - snapshot.decisionBlock > this.maxDecisionBlockAge) throw new Error('PREFLIGHT_BLOCK_STALE');
    if (!validBlockHash(snapshot.decisionBlockHash) || !validBlockHash(snapshot.simulationBlockHash)) throw new Error('PREFLIGHT_HASH_INVALID');
    if (input.request.decisionBlock !== snapshot.decisionBlock || input.request.decisionBlockHash.toLowerCase() !== snapshot.decisionBlockHash.toLowerCase()) {
      throw new Error('PREFLIGHT_DECISION_MISMATCH');
    }
    if (input.route.stockAmount !== input.request.sellAmount) throw new Error('PREFLIGHT_AMOUNT_MISMATCH');
    this.validateTransaction(input.transaction);
    const allowance = await this.readAllowance(input.request.stockToken, input.request.taker, input.allowanceTarget, snapshot.simulationBlock);
    if (allowance !== input.request.sellAmount) throw new Error('PREFLIGHT_ALLOWANCE_FAILURE');
    await this.simulateTransaction(input.request.taker, input.transaction, snapshot.simulationBlock);
    await this.assertSnapshotStillCurrent(snapshot);
    return { ...snapshot, allowanceTarget: input.allowanceTarget };
  }

  /** Compatibility adapter for pre-M5 in-memory callers. */
  async preflight(input: BaseSwapPreflightRequest): Promise<BaseSwapPreflightResult> {
    if (!validAddress(input.request.taker) || !validAddress(input.request.stockToken) || !validAddress(input.allowanceTarget)) {
      throw new Error('PREFLIGHT_INPUT_INVALID');
    }
    const snapshot = await this.captureSnapshot();
    const transaction = input.buildTransaction({ decisionBlock: snapshot.decisionBlock, decisionBlockHash: snapshot.decisionBlockHash });
    this.validateTransaction(transaction);
    const allowance = await this.readAllowance(input.request.stockToken, input.request.taker, input.allowanceTarget, snapshot.simulationBlock);
    if (allowance !== input.request.sellAmount) throw new Error('PREFLIGHT_ALLOWANCE_FAILURE');
    await this.simulateTransaction(input.request.taker, transaction, snapshot.simulationBlock);
    await this.assertSnapshotStillCurrent(snapshot);
    return { ...snapshot, allowanceTarget: input.allowanceTarget };
  }

  private async readAllowance(stockToken: Address, owner: Address, spender: Address, blockNumber: bigint): Promise<bigint> {
    try {
      const allowance = await this.client.readContract({
        address: stockToken,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'allowance',
        args: [owner, spender],
        blockNumber,
      });
      if (typeof allowance !== 'bigint') throw new Error('PREFLIGHT_ALLOWANCE_UNAVAILABLE');
      return allowance;
    } catch (error) {
      if (error instanceof Error && error.message === 'PREFLIGHT_ALLOWANCE_UNAVAILABLE') throw error;
      throw new Error('PREFLIGHT_ALLOWANCE_UNAVAILABLE');
    }
  }

  private validateTransaction(transaction: { readonly to: Address; readonly data: Hex; readonly value: bigint }): void {
    if (!validAddress(transaction.to) || typeof transaction.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(transaction.data) || transaction.data === '0x' || typeof transaction.value !== 'bigint' || transaction.value < 0n) {
      throw new Error('PREFLIGHT_TRANSACTION_INVALID');
    }
  }

  private async simulateTransaction(account: Address, transaction: { readonly to: Address; readonly data: Hex; readonly value: bigint }, blockNumber: bigint): Promise<void> {
    try {
      await this.client.call({
        account,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
        blockNumber,
      });
    } catch {
      throw new Error('PREFLIGHT_SIMULATION_FAILED');
    }
  }

  private async assertSnapshotStillCurrent(snapshot: BaseSwapPreflightSnapshot): Promise<void> {
    const after = await this.readBlock('latest');
    if (after.number !== snapshot.simulationBlock || after.hash?.toLowerCase() !== snapshot.simulationBlockHash.toLowerCase()) {
      throw new Error('PREFLIGHT_BLOCK_STALE');
    }
  }

  private async readBlock(blockNumber: bigint | 'latest'): Promise<{ readonly number: bigint | undefined; readonly hash: Hex | null | undefined }> {
    try {
      const block = blockNumber === 'latest'
        ? await this.client.getBlock({ blockTag: 'latest' })
        : await this.client.getBlock({ blockNumber });
      return { number: block.number, hash: block.hash };
    } catch {
      throw new Error('PREFLIGHT_BLOCK_UNAVAILABLE');
    }
  }
}

/** Compatibility alias used by read-only integration tests. */
export const ReadOnlyViemSwapPreflightPort = ViemBaseSwapPreflightPort;

export class SystemClock implements BaseClock {
  nowSeconds(): bigint {
    return BigInt(Math.floor(Date.now() / 1000));
  }

  nowMilliseconds(): number {
    return Date.now();
  }
}

/** Signature/state adapter backed only by a viem PublicClient. It never creates a wallet client. */
export class ReadOnlyViemSignaturePort implements BaseSignaturePort {
  constructor(
    private readonly client: PublicClient,
    private readonly settlementAddress: Address,
  ) {}

  async verifyOrder(
    order: LiquidationFundingOrder,
    signature: Hex,
    domain: LiquidationFundingDomain,
  ): Promise<BaseSignatureVerificationResult> {
    const orderHash = hashLiquidationFundingOrder(order, domain);
    if (!(await this.isDelegatedSigner(order.maker, order.signer))) return { valid: false, reason: 'SIGNER_NOT_DELEGATED' };
    const code = await this.client.getBytecode({ address: order.signer });
    if (code && code !== '0x') {
      const magicValue = await this.client.readContract({
        address: order.signer,
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [orderHash, signature],
      }) as string;
      return magicValue.toLowerCase() === ERC1271_MAGIC_VALUE ? { valid: true } : { valid: false, reason: 'SIGNATURE_INVALID' };
    }
    const valid = await verifyTypedData({
      address: order.signer,
      domain,
      types: LIQUIDATION_FUNDING_ORDER_TYPES,
      primaryType: 'LiquidationFundingOrder',
      message: order,
      signature,
    });
    return valid ? { valid: true } : { valid: false, reason: 'SIGNATURE_INVALID' };
  }

  async getState(orderHash: Hex, maker?: Address): Promise<{ readonly cancelled: boolean; readonly filled: bigint }> {
    if (!maker) throw new Error('MAKER_REQUIRED');
    const [filled, cancelled] = await Promise.all([
      this.client.readContract({ address: this.settlementAddress, abi: SETTLEMENT_READ_ABI, functionName: 'filled', args: [orderHash] }),
      this.client.readContract({ address: this.settlementAddress, abi: SETTLEMENT_READ_ABI, functionName: 'cancelled', args: [maker, orderHash] }),
    ]);
    return { filled: filled as bigint, cancelled: Boolean(cancelled) };
  }

  async isDelegatedSigner(maker: Address, signer: Address): Promise<boolean> {
    if (maker === signer) return true;
    return Boolean(await this.client.readContract({
      address: this.settlementAddress,
      abi: SETTLEMENT_READ_ABI,
      functionName: 'orderSigners',
      args: [maker, signer],
    }));
  }

  async verifySwapOrder(
    order: SwapOrder,
    signature: Hex,
    domain: SwapOrderDomain,
  ): Promise<BaseSignatureVerificationResult> {
    const orderHash = hashSwapOrder(order, domain);
    if (!(await this.isDelegatedSigner(order.maker, order.signer))) return { valid: false, reason: 'SIGNER_NOT_DELEGATED' };
    const code = await this.client.getBytecode({ address: order.signer });
    if (code && code !== '0x') {
      const magicValue = await this.client.readContract({
        address: order.signer,
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [orderHash, signature],
      }) as string;
      return magicValue.toLowerCase() === ERC1271_MAGIC_VALUE ? { valid: true } : { valid: false, reason: 'SIGNATURE_INVALID' };
    }
    const valid = await verifyTypedData({
      address: order.signer,
      domain,
      types: SWAP_ORDER_TYPES,
      primaryType: 'SwapOrder',
      message: order,
      signature,
    });
    return valid ? { valid: true } : { valid: false, reason: 'SIGNATURE_INVALID' };
  }

  async getSwapState(orderHash: Hex, maker?: Address): Promise<{ readonly cancelled: boolean; readonly filled: bigint }> {
    if (!maker) throw new Error('MAKER_REQUIRED');
    const [filled, cancelled] = await Promise.all([
      this.client.readContract({ address: this.settlementAddress, abi: SETTLEMENT_READ_ABI, functionName: 'swapFilled', args: [orderHash] }),
      this.client.readContract({ address: this.settlementAddress, abi: SETTLEMENT_READ_ABI, functionName: 'cancelled', args: [maker, orderHash] }),
    ]);
    return { filled: filled as bigint, cancelled: Boolean(cancelled) };
  }
}

export type BaseSnapshotResolver = (liquidation: StoredLiquidation, now: bigint) => Promise<LiquidationRankInput>;

/**
 * Read-only snapshot boundary. A resolver is supplied by the indexer/read-model
 * integration; missing market or pool addresses are never synthesized here.
 */
export class ReadOnlySnapshotPort implements BaseSnapshotPort {
  constructor(
    private readonly resolver?: BaseSnapshotResolver,
    private readonly repository?: Pick<BaseRepository, 'getFacilitySnapshot' | 'getOracleSnapshot'>,
  ) {}

  async getForRfq(liquidation: StoredLiquidation, now: bigint): Promise<LiquidationRankInput> {
    if (!this.resolver) throw new Error('SNAPSHOT_UNAVAILABLE');
    return this.resolver(liquidation, now);
  }

  getFacilitySnapshot(facility: Address): Promise<BaseFacilitySnapshot | undefined> {
    return this.repository?.getFacilitySnapshot?.(facility) ?? Promise.resolve(undefined);
  }

  getOracleSnapshot(token: Address): Promise<BaseOracleSnapshot | undefined> {
    return this.repository?.getOracleSnapshot?.(token) ?? Promise.resolve(undefined);
  }
}
