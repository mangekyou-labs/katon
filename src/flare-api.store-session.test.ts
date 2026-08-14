import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiBotCredentialStore, ApiSessionStore } from '../apps/flare-api/src/session';
import { botBodyDigest, botRequestSignature, signaturesEqual } from '../apps/flare-api/src/botAuth';
import { ApiStore } from '../apps/flare-api/src/store';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Flare API durable store', () => {
  it('reloads workflow rows and facility state from its JSON file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trustrfq-api-'));
    tempDirectories.push(directory);
    const filePath = join(directory, 'store.json');
    const first = new ApiStore(filePath);

    first.appendAuction({ id: 'auction-1', pair: 'RWA / USDX', status: 'open', bids: 0, expiry: 2_000 });
    first.appendStandingBid({ id: 'bid-1', pair: 'RWA / USDX', capacity: '1000', mode: 'instant', expiry: 2_000, status: 'active' });
    first.appendActivity({ id: 'activity-1', asset: 'USDX', amount: '1000', state: 'Redemption queued', transaction: '—' });
    first.setFacility(account.address, { shares: '10', nav: '10000', queuedWithdrawals: 1 });

    const second = new ApiStore(filePath);
    expect(second.auctions).toHaveLength(1);
    expect(second.standingBids[0]?.capacity).toBe('1000');
    expect(second.activity[0]?.state).toBe('Redemption queued');
    expect(second.facility(account.address)).toEqual({ shares: '10', nav: '10000', queuedWithdrawals: 1 });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ auctions: [{ id: 'auction-1' }] });
  });

  it('fails closed on malformed persisted state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trustrfq-api-'));
    tempDirectories.push(directory);
    const filePath = join(directory, 'store.json');
    writeFileSync(filePath, '{not-json');
    expect(() => new ApiStore(filePath)).toThrow('API_STORE_INVALID');
    writeFileSync(filePath, JSON.stringify({ auctions: [] }));
    expect(() => new ApiStore(filePath)).toThrow('API_STORE_INVALID');
  });

  it('hydrates and flushes through an asynchronous production persistence adapter', async () => {
    const saved: Array<{ readonly auctions: readonly unknown[] }> = [];
    const store = new ApiStore(undefined, {
      async load() {
        return { auctions: [], standingBids: [], activity: [], facilities: {} };
      },
      async save(snapshot) {
        saved.push({ auctions: snapshot.auctions });
      },
    });
    await store.hydrate();
    store.appendAuction({ id: 'auction-2', pair: 'RWA / USDX', status: 'open', bids: 0, expiry: 2_000 });
    await store.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.auctions).toHaveLength(1);
  });

  it('surfaces persistence readiness failures instead of hiding them behind liveness', async () => {
    const store = new ApiStore(undefined, {
      async load() { throw new Error('MONGO_UNAVAILABLE'); },
      async save() {},
    });
    await expect(store.hydrate()).rejects.toThrow('MONGO_UNAVAILABLE');
    expect(store.persistenceStatus()).toEqual({ configured: true, ready: false, error: 'MONGO_UNAVAILABLE' });
  });
});

describe('Flare API SIWE sessions', () => {
  it('consumes a challenge once and authorizes the matching wallet', async () => {
    const sessions = new ApiSessionStore();
    const challenge = sessions.issueChallenge(account.address, 'api.example.test', 114, 1_000);
    const signature = await account.signMessage({ message: challenge.message });

    const session = await sessions.verify(challenge.message, signature, 'api.example.test', 114, 1_001);
    expect(session.address).toBe(account.address);
    expect(sessions.authorize(session.token, account.address, 1_001)).toBe(true);
    await expect(sessions.verify(challenge.message, signature, 'api.example.test', 114, 1_001)).rejects.toThrow('NONCE_REPLAY');
  });

  it('rejects a session token used by another wallet or after expiry', async () => {
    const sessions = new ApiSessionStore();
    const challenge = sessions.issueChallenge(account.address, 'api.example.test', 114, 1_000);
    const signature = await account.signMessage({ message: challenge.message });
    const session = await sessions.verify(challenge.message, signature, 'api.example.test', 114, 1_001);

    expect(() => sessions.authorize(session.token, `0x${'22'.repeat(20)}`, 1_001)).toThrow('AUTH_WALLET_MISMATCH');
    expect(() => sessions.authorize(session.token, account.address, session.expiresAt)).toThrow('AUTH_EXPIRED');
  });
});

describe('Flare API LP bot credentials', () => {
  it('issues wallet-bound scoped credentials without persisting the raw token', () => {
    const credentials = new ApiBotCredentialStore();
    const issued = credentials.issue({ wallet: account.address, institution: 'desk-a', scopes: ['bid:submit'], expiresAt: 2_000 }, 1_000);
    expect(issued.token).toMatch(/^trf_bot_/);
    expect(credentials.authorize(issued.token, account.address, 'bid:submit', 1_001)).toBe(true);
    expect(JSON.stringify(credentials.snapshot())).not.toContain(issued.token);
    expect(() => credentials.authorize(issued.token, `0x${'22'.repeat(20)}`, 'bid:submit', 1_001)).toThrow('CREDENTIAL_WALLET');
    expect(() => credentials.authorize(issued.token, account.address, 'bid:read', 1_001)).toThrow('CREDENTIAL_SCOPE');
  });

  it('supports durable restore, expiry, and immediate revocation', () => {
    const first = new ApiBotCredentialStore();
    const issued = first.issue({ wallet: account.address, institution: 'desk-a', scopes: ['bid:submit'], expiresAt: 2_000 }, 1_000);
    const restored = new ApiBotCredentialStore();
    restored.restore(first.snapshot());
    expect(restored.authorize(issued.token, account.address, 'bid:submit', 1_500)).toBe(true);
    expect(() => restored.authorize(issued.token, account.address, 'bid:submit', 2_000)).toThrow('CREDENTIAL_EXPIRED');
    restored.revoke(issued.id);
    expect(() => restored.authorize(issued.token, account.address, 'bid:submit', 1_500)).toThrow('CREDENTIAL_REVOKED');
  });

  it('builds a replay-bound request signature over method, path, timestamp, and body digest', () => {
    const digest = botBodyDigest('{"amount":"1"}');
    const signature = botRequestSignature('trf_bot_secret', 'post', '/v1/relay/auctions/a/bids', 1_700_000_000, digest);
    expect(signaturesEqual(signature, botRequestSignature('trf_bot_secret', 'POST', '/v1/relay/auctions/a/bids', 1_700_000_000, digest))).toBe(true);
    expect(signaturesEqual(signature, botRequestSignature('trf_bot_secret', 'POST', '/v1/relay/auctions/a/bids', 1_700_000_001, digest))).toBe(false);
  });
});
