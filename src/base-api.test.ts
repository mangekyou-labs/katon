import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  assertKeylessConfiguration,
  BaseApiController,
  BaseApiExceptionFilter,
  BaseCorsMiddleware,
  BaseRfqTicker,
  BaseTransportMiddleware,
  canonicalBotSignature,
  createBaseApi,
  createHmacHeaders,
  InMemoryBaseRepository,
  InMemoryChainSnapshotPort,
  InMemoryClock,
  InMemoryNotificationPort,
  InMemorySignatureVerificationPort,
  loadBaseApiConfig,
  NonceService,
  SessionService,
  SiweAuthenticator,
  swapDomainFor,
  type BaseApiConfig,
  type BaseOracleDashboard,
} from '../apps/base-api/src/app';
import type { Address } from '../packages/base-core/src/network';

const MAKER = '0x0000000000000000000000000000000000000001' as Address;
const POSTER = '0x0000000000000000000000000000000000000002' as Address;
const USDC = '0x0000000000000000000000000000000000000010' as Address;
const B20 = '0x0000000000000000000000000000000000000020' as Address;
const ROUTER = '0x0000000000000000000000000000000000000030' as Address;
const SETTLEMENT = '0x0000000000000000000000000000000000000040' as Address;
const ADAPTER = '0x0000000000000000000000000000000000000050' as Address;
const RFQ_ID = `0x${'11'.repeat(32)}` as `0x${string}`;

const config: BaseApiConfig = {
  chainId: 84532,
  domainName: 'Katon RFQ Desk',
  domainVersion: '1',
  routerAddress: ROUTER,
  settlementAddress: SETTLEMENT,
  feeBps: 0n,
  decisionBlockMaxAge: 3n,
  sessionTtlSeconds: 900,
  clockToleranceSeconds: 300,
  trustProxyHops: 1,
  allowInsecureLocal: true,
  botCredentials: [
    { id: 'keeper-1', secret: 'keeper-secret', scopes: ['keeper'], identity: POSTER },
    { id: 'lp-1', secret: 'lp-secret', scopes: ['lp'], identity: MAKER },
  ],
};

function bodyHash(body: string): `0x${string}` {
  return canonicalBotSignature('HASH', '/', 0, body).bodyHash;
}

describe('T3.5 keyless API boundary', () => {
  it('does not allow swap signing to downgrade from the breaking v2 domain', () => {
    expect(swapDomainFor(config)).toMatchObject({ name: 'KatonRFQSettlement', version: '2', chainId: 84532, verifyingContract: SETTLEMENT });
    expect(() => swapDomainFor({ ...config, swapDomainVersion: '1' })).toThrow('SWAP_DOMAIN_VERSION_INVALID');
  });

  it('rejects funded-key and mnemonic configuration at boot', () => {
    expect(() => assertKeylessConfiguration({ KATON_SETTLEMENT_PRIVATE_KEY: '0xabc' })).toThrow('KEYLESS_CONFIGURATION');
    expect(() => assertKeylessConfiguration({ WALLET_MNEMONIC: 'never in api' })).toThrow('KEYLESS_CONFIGURATION');
    expect(() => assertKeylessConfiguration({ KATON_ROUTER_PRIVATE_KEY: '0xabc' })).toThrow('KEYLESS_CONFIGURATION');
    expect(() => assertKeylessConfiguration({ FACILITY_EXECUTOR_PRIVATE_KEY: '0xabc' })).toThrow('KEYLESS_CONFIGURATION');
    expect(() => assertKeylessConfiguration({ KATON_FACILITY_EXECUTOR_PRIVATE_KEY: '0xabc' })).toThrow('KEYLESS_CONFIGURATION');
    expect(() => assertKeylessConfiguration({ PRIVATE_KEY: '0xabc' })).toThrow('KEYLESS_CONFIGURATION');
    expect(() => assertKeylessConfiguration({ BASE_RPC_URL: 'https://example.test' })).not.toThrow();
  });

  it('canonicalizes HMAC scope, body digest, and timestamp', () => {
    const body = JSON.stringify({ rfqId: RFQ_ID });
    const canonical = canonicalBotSignature('POST', '/v1/bids', 1_700_000_000, body, 'lp-secret');
    const headers = createHmacHeaders('lp-1', 'lp-secret', 'POST', '/v1/bids', 1_700_000_000, body);
    expect(canonical.canonical).toBe(`POST\n/v1/bids\n1700000000\n${canonical.bodyHash.slice(2)}`);
    expect(headers.authorization).toMatch(/^Bearer katon_bot_lp-1\./);
    expect(headers['x-katon-body-sha256']).toBe(canonical.bodyHash);
    expect(headers['x-katon-signature']).toBe(canonical.signature);
  });

  it('finalizes only the first eligible bid and exposes unsigned calldata to the winner', async () => {
    const repository = new InMemoryBaseRepository();
    const clock = new InMemoryClock(1_000n);
    const snapshot = new InMemoryChainSnapshotPort();
    const signatures = new InMemorySignatureVerificationPort();
    const notifications = new InMemoryNotificationPort();
    snapshot.set(RFQ_ID, {
      now: 1_000n,
      nativeUsdc: USDC,
      rfq: {
        rfqId: RFQ_ID,
        debtAsset: USDC,
        collateralAsset: B20,
        repayAssets: 100n,
        minCollateralOut: 90n,
        deadline: 2_000n,
      },
      venue: {
        closeFactorWad: 1_000_000_000_000_000_000n,
        liquidationBonusWad: 1_100_000_000_000_000_000n,
        chainlinkAnswerWad: 1_000_000_000_000_000_000n,
        b20MultiplierWad: 1_000_000_000_000_000_000n,
      },
      feeBps: 0n,
      aerodrome: { impliedCollateral: 120n, updatedAt: 900n, maxAge: 200n },
      oracleAvailable: true,
      sequencerUp: true,
      b20TransferEnabled: true,
      b20SeizeEnabled: true,
      recipientAuthorized: true,
      decisionBlock: 100n,
      decisionBlockHash: `0x${'22'.repeat(32)}`,
      domain: {
        name: 'KatonRFQSettlement',
        version: '1',
        chainId: 84532,
        verifyingContract: SETTLEMENT,
      },
      adapterSlot: ADAPTER,
      bids: [],
      facilityQuotes: [],
    });
    const app = await createBaseApi({ config, repository, clock, snapshot, signatures, notifications });
    await app.init();

    const rfqBody = JSON.stringify({
      rfqId: RFQ_ID,
      borrower: '0x0000000000000000000000000000000000000009',
      debtAsset: USDC,
      collateralAsset: B20,
      marketId: `0x${'33'.repeat(32)}`,
      repayAssets: '100',
      minCollateralOut: '90',
      deadline: '2000',
      opportunityKey: 'base-market:borrower-9',
    });
    const keeperHeaders = createHmacHeaders('keeper-1', 'keeper-secret', 'POST', '/v1/liquidations', 1_000, rfqBody);
    const controller = app.get(BaseApiController);
    const createdResponse = await controller.createLiquidation(JSON.parse(rfqBody), httpRequest('POST', '/v1/liquidations', rfqBody, keeperHeaders));
    expect(createdResponse).toMatchObject({ rfqId: RFQ_ID, status: 'open', repayAssets: '100', deadline: '2000' });
    expect(createdResponse).not.toHaveProperty('borrower');
    const duplicateResponse = await controller.createLiquidation(JSON.parse(rfqBody), httpRequest('POST', '/v1/liquidations', rfqBody, keeperHeaders));
    expect(duplicateResponse).toMatchObject({ rfqId: RFQ_ID, status: 'open' });
    expect(await repository.listLiquidations()).toHaveLength(1);

    const bidBody = JSON.stringify({
      rfqId: RFQ_ID,
      order: {
        maker: MAKER,
        signer: MAKER,
        debtAsset: USDC,
        collateralAsset: B20,
        maxRepayAssets: '100',
        minCollateralOut: '90',
        fillMode: 0,
        expiry: '2000',
        salt: '1',
        feeLimitBps: 0,
        rfqId: RFQ_ID,
        venue: '0x0000000000000000000000000000000000000000',
        marketId: `0x${'00'.repeat(32)}`,
      },
      signature: '0x1234',
      remainingCapacity: '100',
      minCollateralOut: '90',
      adapter: ADAPTER,
    });
    const wrongAdapterBody = JSON.stringify({ ...JSON.parse(bidBody), adapter: '0x0000000000000000000000000000000000000051' });
    const wrongAdapterHeaders = createHmacHeaders('lp-1', 'lp-secret', 'POST', '/v1/bids', 1_000, wrongAdapterBody);
    await expect(controller.placeBid(JSON.parse(wrongAdapterBody), httpRequest('POST', '/v1/bids', wrongAdapterBody, wrongAdapterHeaders))).rejects.toThrow('VENUE_MISMATCH');
    const atDeadlineBody = JSON.stringify({ ...JSON.parse(bidBody), order: { ...JSON.parse(bidBody).order, expiry: '1000' } });
    const atDeadlineHeaders = createHmacHeaders('lp-1', 'lp-secret', 'POST', '/v1/bids', 1_000, atDeadlineBody);
    await expect(controller.placeBid(JSON.parse(atDeadlineBody), httpRequest('POST', '/v1/bids', atDeadlineBody, atDeadlineHeaders))).rejects.toThrow('ORDER_EXPIRED');
    const bidHeaders = createHmacHeaders('lp-1', 'lp-secret', 'POST', '/v1/bids', 1_000, bidBody);
    const bidResponse = await controller.placeBid(JSON.parse(bidBody), httpRequest('POST', '/v1/bids', bidBody, bidHeaders));
    expect(bidResponse).toMatchObject({ rfqId: RFQ_ID, status: 'finalized', winner: { identity: MAKER, source: 'LP' } });
    expect(bidResponse).not.toHaveProperty('signature');
    expect(bidResponse).not.toHaveProperty('route');

    const routePath = `/v1/liquidations/${RFQ_ID}/route`;
    const routeHeaders = createHmacHeaders('lp-1', 'lp-secret', 'GET', routePath, 1_000, '');
    const routeResponse = await controller.route(RFQ_ID, httpRequest('GET', routePath, '', routeHeaders));
    expect(routeResponse).toMatchObject({ chainId: '84532', to: ROUTER, deadline: '2000' });
    expect(routeResponse.payloadHash).toBe(keccak256(routeResponse.data));
    expect(routeResponse).not.toHaveProperty('signedTransaction');
    await app.close();
  });

  it('does not leak route data to a non-winner and rejects insecure mutation transport', async () => {
    const repository = new InMemoryBaseRepository();
    const app = await createBaseApi({
      config: { ...config, allowInsecureLocal: false, trustProxyHops: 0 },
      repository,
      clock: new InMemoryClock(1_000n),
      snapshot: new InMemoryChainSnapshotPort(),
      signatures: new InMemorySignatureVerificationPort(),
      notifications: new InMemoryNotificationPort(),
    });
    await app.init();
    const middleware = app.get(BaseTransportMiddleware);
    let status = 0;
    let payload: unknown;
    middleware.use({
      method: 'POST', path: '/v1/liquidations', protocol: 'http', headers: {},
      socket: { encrypted: false },
    } as never, {
      status(value: number) { status = value; return this; },
      json(value: unknown) { payload = value; return this; },
    } as never, () => { throw new Error('INSECURE_REQUEST_PASSED'); });
    expect(status).toBe(426);
    expect(payload).toEqual({ code: 'TLS_REQUIRED' });

    let preflightPassed = false;
    middleware.use({
      method: 'OPTIONS', path: '/v1/bids', protocol: 'http', headers: {},
      socket: { encrypted: false },
    } as never, {
      status(value: number) { status = value; return this; },
      json(value: unknown) { payload = value; return this; },
    } as never, () => { preflightPassed = true; });
    expect(preflightPassed).toBe(true);
    await app.close();
  });

  it('exposes public facility/oracle dashboard DTOs and validates address parameters', async () => {
    const oracle: BaseOracleDashboard = {
      asset: B20,
      ticker: 'AAPLx',
      feed: '0x0000000000000000000000000000000000000060',
      answer: '1000000000000000000',
      answerUpdatedAt: '990',
      answerAge: '10',
      heartbeat: '3600',
      fresh: true,
      registryPaused: false,
      sequencerUp: true,
      sequencerStartedAt: '1',
      sequencerInGrace: false,
      b20PausedFeatures: [],
      multiplierWad: '1000000000000000000',
      announcements: [],
      pinnedBlock: '42',
    };
    const dashboard = new (await import('../apps/base-api/src/dashboard')).InMemoryDashboardReadPort({ facilities: [
      {
        address: '0x0000000000000000000000000000000000000100',
        roles: { admin: POSTER, curator: MAKER, guardian: POSTER, executor: MAKER },
        registered: true,
        paused: false,
        quotePaused: false,
        asset: USDC,
        nav: '100000000',
        idleAssets: '50000000',
        shares: '100000000',
        haircutWad: '950000000000000000',
        quoteUsdcCapacity: '47500000',
        queue: { totalAssets: '0', totalShares: '0', requests: [] },
        adapterAllocations: { [ADAPTER]: '100' },
        b20Inventory: {},
        pinnedBlock: '42',
      },
    ], oracles: [oracle] });
    const app = await createBaseApi({
      config,
      repository: new InMemoryBaseRepository(),
      clock: new InMemoryClock(1_000n),
      snapshot: new InMemoryChainSnapshotPort(),
      signatures: new InMemorySignatureVerificationPort(),
      notifications: new InMemoryNotificationPort(),
      dashboard,
    });
    await app.init();
    const controller = app.get(BaseApiController);
    expect(await controller.facilities()).toHaveLength(1);
    expect(await controller.facility('0x0000000000000000000000000000000000000100')).toMatchObject({ quoteUsdcCapacity: '47500000' });
    expect(await controller.oracle(B20)).toMatchObject({ ticker: 'AAPLx', multiplierWad: '1000000000000000000' });
    await expect(controller.facility('not-an-address')).rejects.toThrow('ADDRESS_INVALID:facility');
    await expect(controller.oracle('not-an-address')).rejects.toThrow('ADDRESS_INVALID:asset');
    await app.close();
  });

  it('rejects wildcard credentialed CORS and invalid deployment addresses', () => {
    expect(() => loadBaseApiConfig({ KATON_BASE_BROWSER_ORIGINS: '*' })).toThrow('CORS_ORIGIN_INVALID');
    expect(() => loadBaseApiConfig({ KATON_BASE_FACILITY_ADDRESSES: 'not-an-address' })).toThrow('ADDRESS_INVALID:KATON_BASE_FACILITY_ADDRESSES');
    expect(() => loadBaseApiConfig({ KATON_BASE_ORACLE_GUARD_ADDRESS: 'not-an-address' })).toThrow('ADDRESS_INVALID:KATON_BASE_ORACLE_GUARD_ADDRESS');

    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const middleware = new BaseCorsMiddleware({ browserOrigins: ['https://desk.example'] } as BaseApiConfig);
    let passed = false;
    middleware.use({ method: 'GET', headers: { origin: 'https://desk.example' } } as never, response as never, () => { passed = true; });
    expect(passed).toBe(true);
    expect(response.header).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://desk.example');
    middleware.use({ method: 'GET', headers: { origin: 'https://evil.example' } } as never, response as never, () => { throw new Error('CORS_BYPASS'); });
    expect(response.status).toHaveBeenLastCalledWith(403);
  });

  it('maps infrastructure failures to server responses', () => {
    const filter = new BaseApiExceptionFilter();
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const host = { switchToHttp: () => ({ getResponse: () => response }) };
    filter.catch(new Error('SNAPSHOT_UNAVAILABLE'), host as never);
    expect(response.status).toHaveBeenLastCalledWith(503);
    filter.catch(new Error('unexpected failure'), host as never);
    expect(response.status).toHaveBeenLastCalledWith(500);
    filter.catch(new Error('BOT_SCOPE_DENIED'), host as never);
    expect(response.status).toHaveBeenLastCalledWith(403);
  });

  it('delivers private failures and route-ready events only to their audience', () => {
    const notifications = new InMemoryNotificationPort();
    notifications.publish({ type: 'route_ready', audience: [MAKER], payload: { rfqId: RFQ_ID, data: '0x1234' } });
    notifications.publish({ type: 'rank_failed', audience: [POSTER, MAKER], payload: { rfqId: RFQ_ID, reason: 'CAPACITY' } });
    expect(notifications.for(MAKER)).toHaveLength(2);
    expect(notifications.for(POSTER)).toHaveLength(1);
    expect(notifications.for('0x0000000000000000000000000000000000000008' as Address)).toHaveLength(0);
  });

  it('keeps helper output free of request bodies and private credentials', () => {
    const secret = 'lp-secret';
    const result = canonicalBotSignature('POST', '/v1/bids', 1_700_000_000, secret);
    expect(result.canonical).not.toContain(secret);
    expect(bodyHash(secret)).not.toContain(secret);
  });

  it('ticks open RFQs once per second and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn(async () => undefined);
      const ticker = new BaseRfqTicker({ tick } as never);
      ticker.onModuleInit();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(tick).toHaveBeenCalledTimes(1);
      ticker.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tick).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds SIWE to the configured domain, chain, expiry, and single-use nonce', async () => {
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a0c7adf1f4bdc3f5c2e');
    const nonces = new NonceService();
    const sessions = new SessionService(config);
    const authenticator = new SiweAuthenticator(nonces, sessions, config);
    const issued = nonces.issue(1_000n, config);
    const message = siweMessage(config, account.address, issued);
    const signature = await account.signMessage({ message });

    const verified = await authenticator.verify({ message, signature }, 1_001n);
    expect(verified.identity).toBe(account.address.toLowerCase());
    await expect(sessions.authenticate(verified.sessionToken, 1_001n)).resolves.toMatchObject({ kind: 'siwe', identity: account.address.toLowerCase(), scopes: ['keeper', 'lp'] });
    await expect(authenticator.verify({ message, signature }, 1_001n)).rejects.toThrow('SIWE_NONCE_REPLAY');

    const wrongDomain = message.replace(config.domainName, 'other.example');
    await expect(authenticator.verify({ message: wrongDomain, signature }, 1_001n)).rejects.toThrow('SIWE_DOMAIN_MISMATCH');

    const chainBound = message.replace(`Chain ID: ${config.chainId}`, 'Chain ID: 1');
    await expect(authenticator.verify({ message: chainBound, signature }, 1_001n)).rejects.toThrow('SIWE_CHAIN_MISMATCH');
  });

  it('rejects a valid SIWE message when its nonce was issued for another domain', async () => {
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a0c7adf1f4bdc3f5c2e');
    const issuedForOtherDomain = new NonceService();
    const otherConfig = { ...config, domainName: 'other.example' };
    const issued = issuedForOtherDomain.issue(1_000n, config);
    const message = siweMessage(otherConfig, account.address, issued);
    const signature = await account.signMessage({ message });
    const authenticator = new SiweAuthenticator(issuedForOtherDomain, new SessionService(otherConfig), otherConfig);

    await expect(authenticator.verify({ message, signature }, 1_001n)).rejects.toThrow('SIWE_DOMAIN_MISMATCH');
  });

  it('persists only hashed bearer sessions across service instances', async () => {
    const records = new Map<string, { readonly tokenHash: string; readonly identity: Address; readonly domain: string; readonly chainId: number; readonly expiresAt: bigint }>();
    const store = {
      async put(session: { readonly tokenHash: string; readonly identity: Address; readonly domain: string; readonly chainId: number; readonly expiresAt: bigint }) {
        records.set(session.tokenHash, session);
      },
      async get(tokenHash: string) { return records.get(tokenHash); },
    };
    const first = new SessionService(config, store);
    const token = await first.create(MAKER, 1_000n);
    const second = new SessionService(config, store);
    expect(await second.authenticate(token, 1_001n)).toMatchObject({ kind: 'siwe', identity: MAKER });
    expect(records.has(token)).toBe(false);
    expect(records.size).toBe(1);
  });

  it('keeps standing bids owner-scoped and supports explicit revocation', async () => {
    const repository = new InMemoryBaseRepository();
    const service = new (await import('../apps/base-api/src/service')).BaseApiService(
      config,
      repository,
      new InMemoryChainSnapshotPort(),
      new InMemorySignatureVerificationPort(),
      new InMemoryClock(1_000n),
      new InMemoryNotificationPort(),
    );
    const body = {
      action: 'register',
      rfqId: `0x${'00'.repeat(32)}`,
      order: {
        maker: MAKER,
        signer: MAKER,
        debtAsset: USDC,
        collateralAsset: B20,
        maxRepayAssets: '100',
        minCollateralOut: '90',
        fillMode: 1,
        expiry: '2000',
        salt: '7',
        feeLimitBps: 0,
        rfqId: `0x${'00'.repeat(32)}`,
        venue: '0x0000000000000000000000000000000000000000',
        marketId: `0x${'00'.repeat(32)}`,
      },
      signature: '0x1234',
      remainingCapacity: '100',
      minCollateralOut: '90',
      adapter: ADAPTER,
    };
    const makerAuth = { kind: 'siwe' as const, identity: MAKER, scopes: ['lp' as const] };
    const other = '0x0000000000000000000000000000000000000008' as Address;
    await expect(service.standingBid({ ...body, order: { ...body.order, expiry: '999' } }, makerAuth)).rejects.toThrow('ORDER_EXPIRED');
    await expect(service.standingBid({ ...body, order: { ...body.order, fillMode: 0 } }, makerAuth)).rejects.toThrow('STANDING_FILL_MODE_INVALID');
    await expect(service.standingBid(body, makerAuth)).resolves.toMatchObject({ orderHash: expect.any(String) });
    expect(await service.standingBidsMe({ kind: 'siwe', identity: other, scopes: ['lp'] })).toHaveLength(0);
    const own = await service.standingBidsMe(makerAuth);
    expect(own).toHaveLength(1);
    await service.standingBid({ action: 'revoke', orderHash: own[0]?.orderHash }, makerAuth);
    expect(await service.standingBidsMe(makerAuth)).toHaveLength(0);
    await expect(service.standingBid({ action: 'revoke', orderHash: own[0]?.orderHash }, { kind: 'siwe', identity: other, scopes: ['lp'] })).rejects.toThrow('STANDING_BID_NOT_FOUND');
  });

  it('uses a registered standing bid as a candidate on a later RFQ', async () => {
    const repository = new InMemoryBaseRepository();
    const clock = new InMemoryClock(1_000n);
    const snapshot = new InMemoryChainSnapshotPort();
    const signatures = new InMemorySignatureVerificationPort();
    const service = new (await import('../apps/base-api/src/service')).BaseApiService(
      config,
      repository,
      snapshot,
      signatures,
      clock,
      new InMemoryNotificationPort(),
    );
    const rfqId = `0x${'31'.repeat(32)}` as `0x${string}`;
    const marketId = `0x${'32'.repeat(32)}` as `0x${string}`;
    const standingBody = {
      action: 'register',
      rfqId: `0x${'00'.repeat(32)}` as `0x${string}`,
      order: {
        maker: MAKER,
        signer: MAKER,
        debtAsset: USDC,
        collateralAsset: B20,
        maxRepayAssets: '100',
        minCollateralOut: '90',
        fillMode: 1,
        expiry: '2000',
        salt: '19',
        feeLimitBps: 0,
        rfqId: `0x${'00'.repeat(32)}` as `0x${string}`,
        venue: '0x0000000000000000000000000000000000000000' as Address,
        marketId: `0x${'00'.repeat(32)}` as `0x${string}`,
      },
      signature: '0x1234' as `0x${string}`,
      remainingCapacity: '100',
      minCollateralOut: '90',
      adapter: ADAPTER,
    };
    await service.standingBid(standingBody, { kind: 'siwe', identity: MAKER, scopes: ['lp'] });
    snapshot.set(rfqId, {
      now: 1_000n,
      nativeUsdc: USDC,
      rfq: {
        rfqId,
        debtAsset: USDC,
        collateralAsset: B20,
        repayAssets: 100n,
        minCollateralOut: 90n,
        deadline: 2_000n,
      },
      venue: {
        closeFactorWad: 1_000_000_000_000_000_000n,
        liquidationBonusWad: 1_100_000_000_000_000_000n,
        chainlinkAnswerWad: 1_000_000_000_000_000_000n,
        b20MultiplierWad: 1_000_000_000_000_000_000n,
      },
      feeBps: 0n,
      aerodrome: { impliedCollateral: 120n, updatedAt: 900n, maxAge: 200n },
      oracleAvailable: true,
      sequencerUp: true,
      b20TransferEnabled: true,
      b20SeizeEnabled: true,
      recipientAuthorized: true,
      decisionBlock: 77n,
      decisionBlockHash: `0x${'77'.repeat(32)}`,
      domain: {
        name: 'KatonRFQSettlement',
        version: '1',
        chainId: 84532,
        verifyingContract: SETTLEMENT,
      },
      adapterSlot: ADAPTER,
      bids: [],
      facilityQuotes: [],
    });

    const result = await service.createLiquidation({
      rfqId,
      borrower: POSTER,
      debtAsset: USDC,
      collateralAsset: B20,
      marketId,
      repayAssets: '100',
      minCollateralOut: '90',
      deadline: '2000',
      opportunityKey: 'standing-rfq',
    }, { kind: 'bot', identity: POSTER, scopes: ['keeper'] });

    expect(result.status).toBe('finalized');
    expect(result.winner).toMatchObject({ identity: MAKER, source: 'LP' });
  });

  it('expires an open RFQ at the deadline and only one concurrent finalizer wins', async () => {
    const repository = new InMemoryBaseRepository();
    const clock = new InMemoryClock(1_000n);
    const notifications = new InMemoryNotificationPort();
    await repository.createLiquidation({
      id: 'rfq-expiry',
      opportunityKey: 'expiry-key',
      rfqId: RFQ_ID,
      poster: POSTER,
      borrower: POSTER,
      debtAsset: USDC,
      collateralAsset: B20,
      marketId: `0x${'33'.repeat(32)}`,
      repayAssets: '100',
      minCollateralOut: '90',
      deadline: '1001',
      createdAt: '1000',
      status: 'open',
    });
    const service = new (await import('../apps/base-api/src/service')).BaseApiService(
      config,
      repository,
      new InMemoryChainSnapshotPort(),
      new InMemorySignatureVerificationPort(),
      clock,
      notifications,
    );
    clock.advance(1n);
    await service.tick();
    expect((await repository.getLiquidation('rfq-expiry'))?.status).toBe('expired');
    expect(notifications.all()).toContainEqual(expect.objectContaining({ type: 'rfq_expired', audience: [POSTER] }));

    const route = {
      rfqId: RFQ_ID,
      chainId: config.chainId,
      to: ROUTER,
      data: '0x1234' as `0x${string}`,
      value: '0',
      payloadHash: keccak256('0x1234'),
      winner: MAKER,
      recipient: MAKER,
      source: 'LP' as const,
      orderHash: `0x${'44'.repeat(32)}` as `0x${string}`,
      decisionBlock: '100',
      decisionBlockHash: `0x${'55'.repeat(32)}` as `0x${string}`,
      deadline: '2000',
    };
    await repository.createLiquidation({
      id: 'rfq-finalize', opportunityKey: 'finalize-key', rfqId: `0x${'66'.repeat(32)}`,
      poster: POSTER, borrower: POSTER, debtAsset: USDC, collateralAsset: B20,
      marketId: `0x${'33'.repeat(32)}`, repayAssets: '100', minCollateralOut: '90',
      deadline: '2000', createdAt: '1000', status: 'open',
    });
    const first = await Promise.all([
      repository.finalizeIfOpen('rfq-finalize', { ...route, rfqId: `0x${'66'.repeat(32)}` }, 1),
      repository.finalizeIfOpen('rfq-finalize', { ...route, rfqId: `0x${'66'.repeat(32)}`, orderHash: `0x${'77'.repeat(32)}` }, 1),
    ]);
    expect(first.filter(Boolean)).toHaveLength(1);
  });
});

function httpRequest(method: string, path: string, body: string, headers: Readonly<Record<string, string>>): unknown {
  return { method, path, headers, body: body ? JSON.parse(body) : undefined, rawBody: Buffer.from(body) };
}

function siweMessage(
  apiConfig: BaseApiConfig,
  address: Address,
  issued: { readonly nonce: string; readonly issuedAt: string; readonly expirationTime: string },
): string {
  return `${apiConfig.domainName} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Katon.\n\nURI: https://katon.example/login\nVersion: 1\nChain ID: ${apiConfig.chainId}\nNonce: ${issued.nonce}\nIssued At: ${issued.issuedAt}\nExpiration Time: ${issued.expirationTime}`;
}
