import type { Address, PublicClient } from 'viem';
import {
  B20_GUARD_ABI,
  LIQUIDITY_FACILITY_ABI,
  ORACLE_GUARD_ABI,
} from '../../../packages/base-contracts/src/index';
import { getB20AssetByAddress } from '../../../packages/base-core/src/assets';
import type { BaseFacilitySnapshot, BaseOracleSnapshot } from './types';

export interface BaseWithdrawalDashboard {
  readonly requestId: string;
  readonly owner: Address;
  readonly assets: string;
  readonly shares: string;
  readonly claimedAssets?: string;
  readonly status: 'queued' | 'claimed';
  readonly queuedBlock?: string;
  readonly claimedBlock?: string;
}

export interface BaseFacilityDashboard {
  readonly address: Address;
  readonly roles: {
    readonly admin: Address;
    readonly curator: Address;
    readonly guardian: Address;
    readonly executor: Address;
    readonly router?: Address;
  };
  readonly registered: boolean;
  readonly paused: boolean;
  readonly quotePaused: boolean;
  readonly revoked?: boolean;
  readonly asset: Address;
  readonly nav: string;
  readonly idleAssets: string;
  readonly shares: string;
  readonly haircutWad: string;
  /** Current post-haircut operational funding-capacity ceiling. */
  readonly quoteUsdcCapacity: string;
  readonly queue: {
    readonly totalAssets: string;
    readonly totalShares: string;
    readonly requests: readonly BaseWithdrawalDashboard[];
  };
  readonly adapterAllocations: Readonly<Record<string, string>>;
  readonly b20Inventory: Readonly<Record<string, { readonly amount: string; readonly usdcPaid: string }>>;
  readonly pinnedBlock: string;
}

export interface BaseOracleDashboard {
  readonly asset: Address;
  readonly ticker: string;
  readonly feed: Address;
  readonly answer: string;
  readonly answerUpdatedAt: string;
  readonly answerAge: string;
  readonly heartbeat: string;
  readonly fresh: boolean;
  readonly registryPaused: boolean;
  readonly sequencerUp: boolean;
  readonly sequencerStartedAt: string;
  readonly sequencerInGrace: boolean;
  readonly b20PausedFeatures: readonly number[];
  readonly multiplierWad: string;
  readonly announcements: readonly BaseAnnouncementDashboard[];
  readonly pinnedBlock: string;
}

export interface BaseAnnouncementDashboard {
  readonly id: string;
  readonly description: string;
  readonly uri: string;
  readonly caller: Address;
  readonly open: boolean;
}

export interface BaseDashboardReadPort {
  getFacilities(): Promise<readonly BaseFacilityDashboard[]>;
  getFacility(address: Address): Promise<BaseFacilityDashboard>;
  getOracle(asset: Address): Promise<BaseOracleDashboard>;
  listFacilities(): Promise<readonly BaseFacilityDashboard[]>;
}

export interface InMemoryDashboardSeed {
  readonly facilities?: readonly BaseFacilityDashboard[];
  readonly oracles?: readonly BaseOracleDashboard[];
}

export class InMemoryDashboardReadPort implements BaseDashboardReadPort {
  private readonly facilities: ReadonlyMap<string, BaseFacilityDashboard>;
  private readonly oracles: ReadonlyMap<string, BaseOracleDashboard>;

  constructor(seed: InMemoryDashboardSeed = {}) {
    this.facilities = new Map((seed.facilities ?? []).map((value) => [value.address.toLowerCase(), value]));
    this.oracles = new Map((seed.oracles ?? []).map((value) => [value.asset.toLowerCase(), value]));
  }

  getFacilities(): Promise<readonly BaseFacilityDashboard[]> {
    return Promise.resolve([...this.facilities.values()]);
  }

  listFacilities(): Promise<readonly BaseFacilityDashboard[]> {
    return this.getFacilities();
  }

  getFacility(address: Address): Promise<BaseFacilityDashboard> {
    const value = this.facilities.get(address.toLowerCase());
    return value ? Promise.resolve(value) : Promise.reject(new Error('FACILITY_UNAVAILABLE'));
  }

  getOracle(asset: Address): Promise<BaseOracleDashboard> {
    const value = this.oracles.get(asset.toLowerCase());
    return value ? Promise.resolve(value) : Promise.reject(new Error('ORACLE_UNAVAILABLE'));
  }
}

export class UnavailableDashboardReadPort implements BaseDashboardReadPort {
  getFacilities(): Promise<readonly BaseFacilityDashboard[]> { return Promise.reject(new Error('DASHBOARD_UNAVAILABLE')); }
  listFacilities(): Promise<readonly BaseFacilityDashboard[]> { return this.getFacilities(); }
  getFacility(_address: Address): Promise<BaseFacilityDashboard> { return Promise.reject(new Error('DASHBOARD_UNAVAILABLE')); }
  getOracle(_asset: Address): Promise<BaseOracleDashboard> { return Promise.reject(new Error('DASHBOARD_UNAVAILABLE')); }
}

export interface ViemDashboardOptions {
  readonly facilityAddresses: readonly Address[];
  readonly oracleGuardAddress?: Address;
  readonly b20GuardAddress?: Address;
  readonly b20Assets?: Readonly<Record<string, { readonly ticker: string; readonly feed: Address; readonly decimals: number }>>;
  readonly indexed?: {
    readonly facilities?: Readonly<Record<string, BaseFacilitySnapshot>>;
    readonly facility?: BaseFacilitySnapshot;
    readonly oracles?: Readonly<Record<string, BaseOracleSnapshot>>;
    readonly oracle?: BaseOracleSnapshot;
  };
  readonly history?: {
    readonly getFacilitySnapshot?: (facility: Address) => Promise<BaseFacilitySnapshot | undefined>;
    readonly getOracleSnapshot?: (asset: Address) => Promise<BaseOracleSnapshot | undefined>;
  };
  readonly nowSeconds?: () => bigint;
}

type DashboardClient = Pick<PublicClient, 'getBlockNumber' | 'readContract'>;

/**
 * Read-only dashboard adapter. One block number is acquired per request and
 * passed to every contract read so the rendered snapshot is internally
 * consistent even while the chain advances.
 */
export class ViemDashboardReadPort implements BaseDashboardReadPort {
  constructor(private readonly client: DashboardClient, private readonly options: ViemDashboardOptions) {}

  async getFacilities(): Promise<readonly BaseFacilityDashboard[]> {
    if (this.options.facilityAddresses.length === 0) throw new Error('DASHBOARD_UNAVAILABLE');
    try {
      const block = await this.client.getBlockNumber();
      return await Promise.all(this.options.facilityAddresses.map((address) => this.getFacilityAtBlock(address, block)));
    } catch (error) {
      throw unavailable(error);
    }
  }

  listFacilities(): Promise<readonly BaseFacilityDashboard[]> {
    return this.getFacilities();
  }

  async getFacility(address: Address): Promise<BaseFacilityDashboard> {
    try {
      const block = await this.client.getBlockNumber();
      return await this.getFacilityAtBlock(address, block);
    } catch (error) {
      throw unavailable(error);
    }
  }

  private async getFacilityAtBlock(address: Address, block: bigint): Promise<BaseFacilityDashboard> {
    const read = (functionName: string, args?: readonly unknown[]) => this.client.readContract({
        address,
        abi: LIQUIDITY_FACILITY_ABI,
        functionName: functionName as never,
        ...(args ? { args: args as never } : {}),
        blockNumber: block,
      } as never) as Promise<unknown>;
    const [asset, admin, curator, guardian, executor, router, paused, quotePaused, nav, idleAssets, shares, haircutWad, quoteUsdcCapacity] = await Promise.all([
        read('asset'), read('admin'), read('curator'), read('guardian'), read('executor'), read('router'),
        read('paused'), read('quotePaused'), read('totalAssets'), read('idleAssets'), read('totalSupply'),
        read('haircutWad'), read('quoteUsdcCapacity'),
    ]);
    const indexed = await this.indexedFacility(address);
    const requests = Object.values(indexed?.withdrawalRequests ?? {}).sort((left, right) => Number(BigInt(left.requestId) - BigInt(right.requestId))).map((request) => ({
        requestId: request.requestId,
        owner: request.owner as Address,
        assets: request.assets,
        shares: request.shares,
        ...(request.claimedAssets ? { claimedAssets: request.claimedAssets } : {}),
        status: request.status,
        ...(request.queuedBlock ? { queuedBlock: request.queuedBlock } : {}),
        ...(request.claimedBlock ? { claimedBlock: request.claimedBlock } : {}),
    }));
    return {
        address,
        roles: {
          admin: asAddress(admin), curator: asAddress(curator), guardian: asAddress(guardian), executor: asAddress(executor),
          ...(router ? { router: asAddress(router) } : {}),
        },
        registered: indexed?.registered ?? true,
        paused: Boolean(paused),
        quotePaused: Boolean(quotePaused),
        ...(indexed?.revoked !== undefined ? { revoked: indexed.revoked } : {}),
        asset: asAddress(asset),
        nav: decimal(nav),
        idleAssets: decimal(idleAssets),
        shares: decimal(shares),
        haircutWad: decimal(haircutWad),
        quoteUsdcCapacity: decimal(quoteUsdcCapacity),
        queue: {
          totalAssets: indexed?.queuedWithdrawals ?? '0',
          totalShares: requests.reduce((total, request) => total + BigInt(request.status === 'queued' ? request.shares : '0'), 0n).toString(10),
          requests,
        },
        adapterAllocations: indexed?.allocatedByAdapter ?? {},
        b20Inventory: indexed?.inventoryByToken ?? {},
        pinnedBlock: block.toString(10),
    };
  }

  async getOracle(asset: Address): Promise<BaseOracleDashboard> {
    try {
      const guard = this.options.oracleGuardAddress;
      const b20Guard = this.options.b20GuardAddress;
      if (!guard || !b20Guard) throw new Error('DASHBOARD_UNAVAILABLE');
      const block = await this.client.getBlockNumber();
      const readGuard = (functionName: string, args?: readonly unknown[]) => this.client.readContract({
        address: guard,
        abi: ORACLE_GUARD_ABI,
        functionName: functionName as never,
        ...(args ? { args: args as never } : {}),
        blockNumber: block,
      } as never) as Promise<unknown>;
      const [feedConfig, snapshot, gracePeriod, multiplier, pausedFeatures] = await Promise.all([
        readGuard('feedConfigs', [asset]),
        readGuard('snapshot', [asset]),
        readGuard('gracePeriod'),
        this.client.readContract({ address: b20Guard, abi: B20_GUARD_ABI, functionName: 'multiplierWad', args: [asset], blockNumber: block } as never) as Promise<unknown>,
        this.client.readContract({ address: asset, abi: [{ type: 'function', name: 'pausedFeatures', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8[]' }] }] as const, functionName: 'pausedFeatures', blockNumber: block } as never) as Promise<unknown>,
      ]);
      const assetMeta = this.options.b20Assets?.[asset.toLowerCase()] ?? knownAsset(asset);
      const config = tuple(feedConfig);
      const observation = tuple(snapshot);
      const answer = signedDecimal(observation[0]);
      const updatedAt = decimal(observation[1]);
      const now = this.options.nowSeconds?.() ?? BigInt(Math.floor(Date.now() / 1_000));
      const age = now > BigInt(updatedAt) ? now - BigInt(updatedAt) : 0n;
      const sequencerUp = Boolean(observation[3]);
      const sequencerStartedAt = decimal(observation[4]);
      const heartbeat = decimal(config[1]);
      const registryPaused = Boolean(observation[5]);
      const sequencerInGrace = now >= BigInt(sequencerStartedAt) && now - BigInt(sequencerStartedAt) <= BigInt(gracePeriod as string | bigint | number);
      const b20PausedFeatures = arrayNumbers(pausedFeatures);
      return {
        asset,
        ticker: assetMeta.ticker,
        feed: assetMeta.feed,
        answer: answer,
        answerUpdatedAt: updatedAt,
        answerAge: age.toString(10),
        heartbeat,
        fresh: answer !== '0' && age <= BigInt(heartbeat) && sequencerUp && !sequencerInGrace && !registryPaused,
        registryPaused,
        sequencerUp,
        sequencerStartedAt,
        sequencerInGrace,
        b20PausedFeatures,
        multiplierWad: decimal(multiplier),
        announcements: Object.values((await this.indexedOracle(asset))?.announcements ?? {}).map((announcement) => ({
          id: announcement.id,
          description: announcement.description,
          uri: announcement.uri,
          caller: announcement.caller as Address,
          open: announcement.open,
        })),
        pinnedBlock: block.toString(10),
      };
    } catch (error) {
      throw unavailable(error);
    }
  }

  private async indexedFacility(address: Address): Promise<BaseFacilitySnapshot | undefined> {
    const staticValue = this.options.indexed?.facilities?.[address.toLowerCase()] ?? (this.options.indexed?.facility?.facility.toLowerCase() === address.toLowerCase() ? this.options.indexed.facility : undefined);
    if (staticValue) return staticValue;
    return this.options.history?.getFacilitySnapshot?.(address);
  }

  private async indexedOracle(asset: Address): Promise<BaseOracleSnapshot | undefined> {
    const staticValue = this.options.indexed?.oracles?.[asset.toLowerCase()] ?? (this.options.indexed?.oracle?.token.toLowerCase() === asset.toLowerCase() ? this.options.indexed.oracle : undefined);
    if (staticValue) return staticValue;
    return this.options.history?.getOracleSnapshot?.(asset);
  }
}

function knownAsset(address: Address): { readonly ticker: string; readonly feed: Address; readonly decimals: number } {
  const asset = getB20AssetByAddress(address);
  return asset;
}

function unavailable(error: unknown): Error {
  if (error instanceof Error && (error.message === 'DASHBOARD_UNAVAILABLE' || error.message.endsWith('_UNAVAILABLE'))) return error;
  return new Error('DASHBOARD_UNAVAILABLE');
}

function decimal(value: unknown): string {
  if (typeof value === 'bigint' && value >= 0n) return value.toString(10);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error('DASHBOARD_INTEGER_INVALID');
}

function signedDecimal(value: unknown): string {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value).toString(10);
  throw new Error('DASHBOARD_INTEGER_INVALID');
}

function asAddress(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('DASHBOARD_ADDRESS_INVALID');
  return value.toLowerCase() as Address;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new Error('DASHBOARD_INTEGER_INVALID');
}

function tuple(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .filter((key) => /^\d+$/.test(key))
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => (value as Record<string, unknown>)[key]);
  }
  throw new Error('DASHBOARD_TUPLE_INVALID');
}

function arrayNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asNumber(entry));
}
