import type { Address, Hex } from 'viem';
import {
  ERC20_ABI,
  LIQUIDITY_FACILITY_ABI,
} from '../../../packages/base-contracts/src/index';
import type { BaseRuntimeConfig } from './runtime';
import type { BaseWallet } from './wallet';
import type { StockSaleRouteDto } from './api';

export interface TransactionResult {
  readonly hash: Hex;
  readonly receiptStatus: 'success';
}

export interface WinnerRouteTransaction {
  readonly source: 'LP' | 'FACILITY';
  readonly target: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly repayAssets: bigint;
}

export interface StockSaleTransaction {
  readonly route: StockSaleRouteDto;
  readonly stockToken: Address;
  readonly stockAmount: bigint;
}

/** Ensure the seller's exact B20 allowance to settlement before quoting. */
export async function approveStockSale(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  stockToken: Address,
  stockAmount: bigint,
): Promise<TransactionResult | undefined> {
  const settlement = configured(config.deployment.settlement, 'SETTLEMENT_ADDRESS_UNAVAILABLE');
  if (!config.b20Assets[stockToken.toLowerCase()]) throw new Error('B20_METADATA_UNAVAILABLE');
  if (stockAmount <= 0n) throw new Error('STOCK_AMOUNT_INVALID');
  const hash = await wallet.approveExactAllowance(stockToken, settlement, stockAmount);
  if (!hash) return undefined;
  const receipt = await wallet.waitForReceipt(hash);
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
  return { hash, receiptStatus: 'success' };
}

/** @deprecated Use approveStockSale; retained for older browser integrations. */
export const approveExactStockAllowance = approveStockSale;

/** Submit only the server-returned router transaction after a fresh-block check. */
export async function submitStockSaleRoute(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  input: StockSaleTransaction,
): Promise<TransactionResult> {
  const route = input.route;
  if (route.kind !== 'INTERNAL' || !route.transaction) throw new Error('EXTERNAL_ROUTE_NOT_EXECUTABLE_HERE');
  const router = configured(config.deployment.router, 'ROUTER_ADDRESS_UNAVAILABLE');
  if (route.transaction.to.toLowerCase() !== router.toLowerCase()) throw new Error('ROUTE_TARGET_MISMATCH');
  if (input.stockAmount <= 0n || BigInt(route.stockAmount) !== input.stockAmount) throw new Error('STOCK_AMOUNT_INVALID');
  if (!route.decisionBlock || !route.decisionBlockHash) throw new Error('SWAP_QUOTE_STALE');
  const hash = await wallet.sendRouteOnly({
    to: route.transaction.to,
    data: route.transaction.data,
    value: BigInt(route.transaction.value),
  }, { decisionBlock: route.decisionBlock, decisionBlockHash: route.decisionBlockHash, maxAge: config.decisionBlockMaxAge ?? 3n });
  const receipt = await wallet.waitForReceipt(hash);
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
  return { hash, receiptStatus: 'success' };
}

export async function approveAndDeposit(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  assets: bigint,
): Promise<readonly TransactionResult[]> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  const usdc = config.usdc;
  const approval = await submit(wallet, () => wallet.writeContract({ address: usdc, abi: ERC20_ABI, functionName: 'approve', args: [facility, assets] }));
  const deposit = await submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'deposit', args: [assets, wallet.assertWritable()] }));
  return [approval, deposit];
}

export async function withdraw(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  assets: bigint,
): Promise<TransactionResult> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  const owner = wallet.assertWritable();
  return submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'withdraw', args: [assets, owner, owner] }));
}

export async function requestQueuedWithdraw(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  assets: bigint,
): Promise<TransactionResult> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  return submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'requestWithdraw', args: [assets] }));
}

export async function claimQueuedWithdraw(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  requestId: bigint,
): Promise<TransactionResult> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  return submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'claimWithdraw', args: [requestId] }));
}

export async function setAdapterAllowed(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  adapter: Address,
  allowed: boolean,
): Promise<TransactionResult> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  return submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'setAdapterAllowed', args: [adapter, allowed] }));
}

export async function allocateAdapter(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  adapter: Address,
  assets: bigint,
): Promise<TransactionResult> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  return submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'allocate', args: [adapter, assets] }));
}

export async function deallocateAdapter(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  adapter: Address,
  assets: bigint,
): Promise<TransactionResult> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  return submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'deallocate', args: [adapter, assets] }));
}

export async function setHaircut(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  haircutWad: bigint,
): Promise<TransactionResult> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  return submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'setHaircutWad', args: [haircutWad] }));
}

export async function setQuotePaused(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  paused: boolean,
): Promise<TransactionResult> {
  const facility = configured(config.deployment.facility, 'FACILITY_ADDRESS_UNAVAILABLE');
  return submit(wallet, () => wallet.writeContract({ address: facility, abi: LIQUIDITY_FACILITY_ABI, functionName: 'setQuotePaused', args: [paused] }));
}

/**
 * Winner-only route submission. LP routes approve only the exact repayment
 * amount to settlement; facility routes go directly to the router and never
 * request an LP approval.
 */
export async function submitWinnerRoute(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  route: WinnerRouteTransaction,
): Promise<readonly TransactionResult[]> {
  const results: TransactionResult[] = [];
  if (route.source === 'LP') {
    const settlement = configured(config.deployment.settlement, 'SETTLEMENT_ADDRESS_UNAVAILABLE');
    results.push(await submit(wallet, () => wallet.writeContract({ address: config.usdc, abi: ERC20_ABI, functionName: 'approve', args: [settlement, route.repayAssets] })));
  }
  results.push(await submit(wallet, () => wallet.sendTransaction({ to: route.target, data: route.data, value: route.value })));
  return results;
}

/**
 * @deprecated Use approveStockSale followed by submitStockSaleRoute. This
 * compatibility wrapper preserves the old return shape while enforcing the
 * split approval/route sequence and fresh decision-block check.
 */
export async function submitStockSale(
  wallet: BaseWallet,
  config: BaseRuntimeConfig,
  input: StockSaleTransaction,
): Promise<readonly TransactionResult[]> {
  const approval = await approveStockSale(wallet, config, input.stockToken, input.stockAmount);
  const routeResult = await submitStockSaleRoute(wallet, config, input);
  return approval ? [approval, routeResult] : [routeResult];
}

function configured(value: Address | undefined, code: string): Address {
  if (!value) throw new Error(code);
  return value;
}

async function submit(wallet: BaseWallet, send: () => Promise<Hex>): Promise<TransactionResult> {
  const hash = await send();
  const receipt = await wallet.waitForReceipt(hash);
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${hash}`);
  return { hash, receiptStatus: 'success' };
}
