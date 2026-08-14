import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ActivityRow, AuctionRow, FacilityReadModel, StandingBidRow } from '../../../packages/flare-sdk/src/api';
import type { BlindRelaySnapshot, RelayKeyRegistrySnapshot } from './blindRelay';
import type { ApiBotCredentialSnapshot } from './session';

export interface ApiStoreSnapshot {
  readonly auctions: readonly AuctionRow[];
  readonly standingBids: readonly StandingBidRow[];
  readonly activity: readonly ActivityRow[];
  readonly facilities: Readonly<Record<string, FacilityReadModel>>;
  readonly relay?: BlindRelaySnapshot;
  readonly relayKeys?: RelayKeyRegistrySnapshot;
  readonly botCredentials?: ApiBotCredentialSnapshot;
}

export interface ApiStorePersistence {
  load(): Promise<ApiStoreSnapshot | undefined>;
  save(snapshot: ApiStoreSnapshot): Promise<void>;
  close?(): Promise<void>;
}

const EMPTY: ApiStoreSnapshot = { auctions: [], standingBids: [], activity: [], facilities: {} };

export class ApiStore {
  private snapshot: ApiStoreSnapshot;
  private pending = Promise.resolve();
  private persistenceReady = false;
  private persistenceError?: string;

  constructor(private readonly filePath?: string, private readonly persistence?: ApiStorePersistence) {
    this.snapshot = filePath ? readSnapshot(filePath) : EMPTY;
  }

  async hydrate(): Promise<void> {
    if (!this.persistence) {
      this.persistenceReady = true;
      return;
    }
    try {
      const snapshot = await this.persistence.load();
      if (snapshot) this.snapshot = validateSnapshot(snapshot);
      this.persistenceReady = true;
      this.persistenceError = undefined;
    } catch (error) {
      this.persistenceReady = false;
      this.persistenceError = error instanceof Error ? error.message : 'API_PERSISTENCE_UNAVAILABLE';
      throw error;
    }
  }

  persistenceStatus(): { readonly configured: boolean; readonly ready: boolean; readonly error?: string } {
    return {
      configured: Boolean(this.persistence),
      ready: this.persistence ? this.persistenceReady : true,
      ...(this.persistenceError ? { error: this.persistenceError } : {}),
    };
  }

  get auctions(): AuctionRow[] { return [...this.snapshot.auctions]; }
  get standingBids(): StandingBidRow[] { return [...this.snapshot.standingBids]; }
  get activity(): ActivityRow[] { return [...this.snapshot.activity]; }

  facility(wallet: string): FacilityReadModel {
    return this.snapshot.facilities[wallet] ?? { shares: '0', nav: '0', queuedWithdrawals: 0 };
  }

  relaySnapshot(): BlindRelaySnapshot | undefined {
    return this.snapshot.relay;
  }

  relayKeySnapshot(): RelayKeyRegistrySnapshot | undefined {
    return this.snapshot.relayKeys;
  }

  botCredentialSnapshot(): ApiStoreSnapshot['botCredentials'] {
    return this.snapshot.botCredentials;
  }

  setRelaySnapshot(relay: BlindRelaySnapshot): void {
    this.commit({ ...this.snapshot, relay });
  }

  setRelayKeySnapshot(relayKeys: RelayKeyRegistrySnapshot): void {
    this.commit({ ...this.snapshot, relayKeys });
  }

  setBotCredentialSnapshot(botCredentials: NonNullable<ApiStoreSnapshot['botCredentials']>): void {
    this.commit({ ...this.snapshot, botCredentials });
  }

  appendAuction(row: AuctionRow): void {
    this.commit({ ...this.snapshot, auctions: [...this.snapshot.auctions, row] });
  }

  appendStandingBid(row: StandingBidRow): void {
    this.commit({ ...this.snapshot, standingBids: [...this.snapshot.standingBids, row] });
  }

  appendActivity(row: ActivityRow): void {
    this.commit({ ...this.snapshot, activity: [...this.snapshot.activity, row] });
  }

  setFacility(wallet: string, facility: FacilityReadModel): void {
    this.commit({ ...this.snapshot, facilities: { ...this.snapshot.facilities, [wallet]: facility } });
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.persistence?.close?.();
  }

  private commit(next: ApiStoreSnapshot): void {
    this.snapshot = next;
    if (this.persistence) {
      this.pending = this.pending.catch(() => undefined)
        .then(() => this.persistence!.save(next))
        .then(() => {
          this.persistenceReady = true;
          this.persistenceError = undefined;
        }, (error: unknown) => {
          this.persistenceReady = false;
          this.persistenceError = error instanceof Error ? error.message : 'API_PERSISTENCE_UNAVAILABLE';
          throw error;
        });
    }
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}

function readSnapshot(filePath: string): ApiStoreSnapshot {
  if (!existsSync(filePath)) return EMPTY;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ApiStoreSnapshot>;
    return validateSnapshot(parsed as ApiStoreSnapshot);
  } catch {
    throw new Error('API_STORE_INVALID');
  }
}

function validateSnapshot(snapshot: ApiStoreSnapshot): ApiStoreSnapshot {
  if (
    !Array.isArray(snapshot.auctions)
    || !Array.isArray(snapshot.standingBids)
    || !Array.isArray(snapshot.activity)
    || snapshot.facilities === null
    || typeof snapshot.facilities !== 'object'
    || Array.isArray(snapshot.facilities)
  ) throw new Error('API_STORE_INVALID');
  if (snapshot.relay !== undefined && (snapshot.relay === null || typeof snapshot.relay !== 'object')) {
    throw new Error('API_STORE_INVALID');
  }
  if (snapshot.relayKeys !== undefined && (snapshot.relayKeys === null || typeof snapshot.relayKeys !== 'object')) {
    throw new Error('API_STORE_INVALID');
  }
  return snapshot;
}
