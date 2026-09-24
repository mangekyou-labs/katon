import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { RoleSessionService, type ProvisionedRoleIdentity } from '../apps/solana-api/src/roles';
import { encodeBase58, localSellerPublicKey } from '@katon/solana-core';
import { evaluateReferencePolicy, localReferencePolicySnapshot } from '../apps/solana-api/src/reference-policy';
import { HeadlessPrivateMakerSource, JupiterStubSource, MemorySourceBalanceProvider, StreamedMakerSource, type QuoteSource } from '../apps/solana-api/src/sources';
import { demoAssets } from '../apps/solana-api/src/registry';
import { MemoryAssetProvider, QuoteDeskService } from '../apps/solana-api/src/service';

const identities: ProvisionedRoleIdentity[] = [];
const keys: Array<{ publicKey: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] }> = [];
function identity(role: ProvisionedRoleIdentity['role'], makerId?: string): ProvisionedRoleIdentity {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = encodeBase58(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  identities.push({ publicKey, role, ...(makerId ? { makerId } : {}) });
  keys.push({ publicKey, privateKey: pair.privateKey });
  return identities.at(-1)!;
}

afterEach(() => { identities.length = 0; keys.length = 0; });

describe('maker and operator role sessions', () => {
  it('issues a short-lived session only for a signed challenge from the provisioned role key', () => {
    const maker = identity('maker', 'maker-7');
    const auth = new RoleSessionService(identities, 'x'.repeat(32), 60_000);
    const challenge = auth.createChallenge(maker.publicKey, 'maker');
    const key = keys[0]!;
    const signature = sign(null, Buffer.from(challenge.message), key.privateKey).toString('base64url');
    const session = auth.createSession(maker.publicKey, 'maker', challenge.challengeId, signature);

    expect(auth.authenticate(session.token, 'maker')).toMatchObject({ role: 'maker', makerId: 'maker-7' });
    expect(() => auth.authenticate(session.token, 'operator')).toThrow('wrong role');
  });

  it('rejects expired, revoked, and replayed challenges', () => {
    const operator = identity('operator');
    let now = 10_000;
    const auth = new RoleSessionService(identities, 'x'.repeat(32), 1000, () => now);
    const challenge = auth.createChallenge(operator.publicKey, 'operator');
    const signature = sign(null, Buffer.from(challenge.message), keys[0]!.privateKey).toString('base64url');
    const session = auth.createSession(operator.publicKey, 'operator', challenge.challengeId, signature);
    expect(() => auth.createSession(operator.publicKey, 'operator', challenge.challengeId, signature)).toThrow('challenge');
    now += 1001;
    expect(() => auth.authenticate(session.token, 'operator')).toThrow('expired');
    auth.revokeIdentity(operator.publicKey);
    expect(() => auth.createChallenge(operator.publicKey, 'operator')).toThrow('provisioned');
  });

  it('prunes expired challenges and caps pending challenge storage', () => {
    const operator = identity('operator');
    let now = 10_000;
    const auth = new RoleSessionService(identities, 'x'.repeat(32), 60_000, () => now);
    const pendingChallenges = (auth as unknown as { challenges: Map<string, unknown> }).challenges;
    auth.createChallenge(operator.publicKey, 'operator');
    now += 60_000;
    const first = auth.createChallenge(operator.publicKey, 'operator');
    expect(pendingChallenges.size).toBe(1);
    let latest = first;
    for (let index = 0; index < 10_000; index += 1) latest = auth.createChallenge(operator.publicKey, 'operator');

    expect(pendingChallenges.size).toBe(10_000);
    const firstSignature = sign(null, Buffer.from(first.message), keys[0]!.privateKey).toString('base64url');
    expect(() => auth.createSession(operator.publicKey, 'operator', first.challengeId, firstSignature))
      .toThrow('challenge is missing, expired, or already used');
    const signature = sign(null, Buffer.from(latest.message), keys[0]!.privateKey).toString('base64url');
    expect(auth.createSession(operator.publicKey, 'operator', latest.challengeId, signature).role).toBe('operator');
  });

  it('does not bind two provisioned keys to the same maker ID', () => {
    const maker = identity('maker', 'maker-7');
    const duplicate = identity('maker', 'maker-7');
    expect(() => new RoleSessionService([maker, duplicate], 'x'.repeat(32))).toThrow('duplicate provisioned maker ID');
    const auth = new RoleSessionService([maker], 'x'.repeat(32));
    expect(() => auth.provisionMaker(duplicate.publicKey, 'maker-7')).toThrow('already provisioned');
  });

  it('lets operators disable makers or stop sprints, and lets makers disable themselves', async () => {
    const { DeskOperatorControls } = await import('../apps/solana-api/src/roles');
    const controls = new DeskOperatorControls(['maker-7']);
    const capability = { inputMint: demoAssets[0]!.mint, outputMint: demoAssets[0]!.supportedOutputs[0]!, minInputAtomic: '1', maxInputAtomic: '1000000' };
    controls.updateAdvertisement('maker-7', [capability], 'available');
    expect(controls.makerStatus('maker-7')).toMatchObject({ enabled: false, governanceEnabled: false, availability: 'unavailable' });
    controls.observeGovernedEnablement('maker-7', true);
    expect(controls.makerStatus('maker-7')).toMatchObject({ enabled: true, governanceEnabled: true, availability: 'unavailable' });
    // An advertisement sent before the observed governance action cannot
    // activate the source; the maker must advertise after enablement.
    controls.updateAdvertisement('maker-7', [capability], 'available');
    expect(controls.makerStatus('maker-7').availability).toBe('available');
    controls.observeGovernedEnablement('maker-7', true);
    expect(controls.makerStatus('maker-7').availability).toBe('available');
    controls.updateAdvertisement('maker-7', [capability], 'unavailable');
    controls.heartbeat('maker-7');
    expect(controls.makerStatus('maker-7').availability).toBe('unavailable');
    controls.updateAdvertisement('maker-7', [capability], 'available');
    controls.updateAdvertisement('maker-7', [], 'available');
    expect(controls.makerStatus('maker-7').availability).toBe('unavailable');
    controls.updateAdvertisement('maker-7', [capability], 'available');
    controls.selfDisable('maker-7');
    expect(controls.makerStatus('maker-7').enabled).toBe(false);
    controls.observeGovernedEnablement('maker-7', true);
    controls.updateAdvertisement('maker-7', [capability], 'available');
    expect(controls.makerStatus('maker-7').availability).toBe('unavailable');
    controls.disableMaker('maker-7');
    expect(controls.makerStatus('maker-7').availability).toBe('unavailable');
    expect(() => controls.updateAdvertisement('maker-7', [capability], 'available')).not.toThrow();
    expect(controls.makerStatus('maker-7').availability).toBe('unavailable');
    controls.stopSprints();
    expect(controls.isSprintStopped()).toBe(true);
    expect(controls.operatorStatus().sellerDesk).toEqual({ mode: 'local_proof', quoteSprintIntake: 'stopped', governanceEnablement: 'read-only per-maker observation', productionReady: false });
    expect(controls.operatorStatus().liquidationExecution).toEqual({ mode: 'disabled', enabled: false, evidence: 'not configured', health: 'dormant' });
  });
});

describe('independent Reference Policy observations', () => {
  const primary = { provider: 'licensed-a', licensedPrimary: true, priceAtomic: '100000000', observedAtMs: 1000, sessionOpen: true, corporateActionPending: false };
  const check = { provider: 'independent-b', licensedPrimary: false, priceAtomic: '100100000', observedAtMs: 1000, sessionOpen: true, corporateActionPending: false };
  it('accepts only fresh agreeing dual observations and exposes the six fail-closed states', () => {
    expect(evaluateReferencePolicy([primary, check], 1100).status).toBe('ready');
    expect(localReferencePolicySnapshot(1100).status).toBe('ready');
    expect(evaluateReferencePolicy([], 1100).status).toBe('unavailable');
    expect(evaluateReferencePolicy([primary, { ...check, sessionOpen: false }], 1100).status).toBe('market_closed');
    expect(evaluateReferencePolicy([primary, { ...check, observedAtMs: 0 }], 20_000).status).toBe('stale');
    expect(evaluateReferencePolicy([primary, { ...check, priceAtomic: '102000000' }], 1100).status).toBe('conflicting');
    expect(evaluateReferencePolicy([primary, { ...check, corporateActionPending: true }], 1100).status).toBe('corporate_action_pending');
  });

  it('keeps production quote collection unavailable until licensed reference providers exist', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let quoteCalls = 0;
    const source: QuoteSource = {
      id: 'maker-production-gate',
      kind: 'private-maker',
      settlementRoute: 'generic-spl',
      reliabilityBps: 9_000,
      quote: async () => { quoteCalls += 1; throw new Error('quote source must not run'); },
    };
    try {
      const desk = new QuoteDeskService(new MemoryAssetProvider(demoAssets), [source], {} as never, {} as never);
      expect(desk.referencePolicyStatus().status).toBe('unavailable');
      const session = await desk.createSession({
        wallet: 'seller-wallet', inputMint: demoAssets[0]!.mint, outputMint: demoAssets[0]!.supportedOutputs[0]!, inputAmountAtomic: '1000000',
      });
      expect(session).toMatchObject({ state: 'unknown', eligibility: { status: 'unknown', code: 'capability_unavailable' } });
      expect(quoteCalls).toBe(0);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

describe('operator source disablement', () => {
  it('keeps provisioned Private Makers unavailable until exact governed enablement is observed', async () => {
    const asset = demoAssets[0]!;
    const wallet = encodeBase58(localSellerPublicKey());
    const assets = new MemoryAssetProvider(demoAssets);
    assets.setBalance(wallet, asset.mint, '2500000');
    const maker = new HeadlessPrivateMakerSource();
    const balances = new MemorySourceBalanceProvider();
    balances.setBalance(maker.id, asset.supportedOutputs[0]!, '1000000000000');
    const desk = new QuoteDeskService(assets, [maker], {} as never, {} as never, Date.now,
      { simulate: async (_candidate, nowMs) => ({ ok: true, unitsConsumed: 145_000, simulatedAtMs: nowMs }) }, balances);

    expect(desk.operatorSourceStatus()).toContainEqual({ sourceId: maker.id, sourceKind: 'private-maker', enabled: false, governanceEnabled: false, operatorDisabled: false });
    const blocked = await desk.createQuoteSprint({ wallet, inputMint: asset.mint, outputMint: asset.supportedOutputs[0]!, inputAmountAtomic: '100000' });
    expect((await desk.collectNow(blocked.id)).state).toBe('no_quote');
    expect(() => desk.observeGovernedMaker(maker.id, 'wrong-maker-key', true)).toThrow('identity');

    desk.observeGovernedMaker(maker.id, encodeBase58(maker.makerPublicKey), true);
    const enabled = await desk.createQuoteSprint({ wallet, inputMint: asset.mint, outputMint: asset.supportedOutputs[0]!, inputAmountAtomic: '100000' });
    expect((await desk.collectNow(enabled.id)).state).toBe('winner_ready');
  });

  it('excludes a disabled Jupiter source from collection', async () => {
    const asset = demoAssets[0]!;
    const wallet = 'seller-wallet';
    const assets = new MemoryAssetProvider(demoAssets);
    assets.setBalance(wallet, asset.mint, '1000000');
    let quoteCalls = 0;
    const source: QuoteSource = {
      id: 'jupiter-gate', kind: 'jupiter', settlementRoute: 'generic-spl', reliabilityBps: 9000,
      quote: async () => { quoteCalls += 1; throw new Error('disabled source was called'); },
    };
    const desk = new QuoteDeskService(assets, [source], {} as never, {} as never);
    desk.disableSource('jupiter-gate');
    expect(desk.operatorSourceStatus()).toContainEqual({ sourceId: 'jupiter-gate', sourceKind: 'jupiter', enabled: false, governanceEnabled: true, operatorDisabled: true });
    await desk.createSession({ wallet, inputMint: asset.mint, outputMint: asset.supportedOutputs[0]!, inputAmountAtomic: '1000000' });
    expect(quoteCalls).toBe(0);
  });

  it('blocks an already-issued Jupiter winner after the operator disables its source', async () => {
    const asset = demoAssets[0]!;
    const wallet = identity('operator').publicKey;
    const assets = new MemoryAssetProvider(demoAssets);
    assets.setBalance(wallet, asset.mint, '2500000');
    const balances = new MemorySourceBalanceProvider();
    balances.setBalance('jupiter-meta-aggregator', asset.supportedOutputs[0]!, '1000000000000');
    const desk = new QuoteDeskService(
      assets,
      [new JupiterStubSource()],
      {} as never,
      {} as never,
      Date.now,
      { simulate: async (_candidate, nowMs) => ({ ok: true, unitsConsumed: 145_000, simulatedAtMs: nowMs }) },
      balances,
    );
    const created = await desk.createQuoteSprint({
      wallet,
      inputMint: asset.mint,
      outputMint: asset.supportedOutputs[0]!,
      inputAmountAtomic: '100000',
    });
    const issued = await desk.collectNow(created.id);
    expect(issued.state).toBe('winner_ready');
    expect(issued.winner?.sourceId).toBe('jupiter-meta-aggregator');

    desk.disableSource(issued.winner!.sourceId);
    await expect(desk.authorize(created.id, wallet, issued.winner!.transactionHash!, 'AQ=='))
      .rejects.toThrow('source was disabled before authorization');
  });

  it('blocks an already-issued Private Maker winner after the operator disables its source', async () => {
    const asset = demoAssets[0]!;
    const wallet = encodeBase58(localSellerPublicKey());
    const assets = new MemoryAssetProvider(demoAssets);
    assets.setBalance(wallet, asset.mint, '2500000');
    const balances = new MemorySourceBalanceProvider();
    balances.setBalance('maker-sandbox-01', asset.supportedOutputs[0]!, '1000000000000');
    const maker = new HeadlessPrivateMakerSource();
    const desk = new QuoteDeskService(
      assets,
      [maker],
      {} as never,
      {} as never,
      Date.now,
      { simulate: async (_candidate, nowMs) => ({ ok: true, unitsConsumed: 145_000, simulatedAtMs: nowMs }) },
      balances,
    );
    desk.observeGovernedMaker(maker.id, encodeBase58(maker.makerPublicKey), true);
    const created = await desk.createQuoteSprint({
      wallet,
      inputMint: asset.mint,
      outputMint: asset.supportedOutputs[0]!,
      inputAmountAtomic: '100000',
    });
    const issued = await desk.collectNow(created.id);
    expect(issued.state).toBe('winner_ready');
    expect(issued.winner?.sourceKind).toBe('private-maker');

    desk.disableSource(issued.winner!.sourceId);
    await expect(desk.authorize(created.id, wallet, issued.winner!.transactionHash!, 'AQ=='))
      .rejects.toThrow('source was disabled before authorization');
  });
});

describe('authenticated maker quote intake', () => {
  it('returns a streamed quote to the exact active sprint terms', async () => {
    const now = Date.now();
    const asset = demoAssets[0]!;
    const request = { wallet: 'seller', inputMint: asset.mint, outputMint: asset.supportedOutputs[0]!, inputAmountAtomic: '1000000' };
    let requested = false;
    let requestId = '';
    const source = new StreamedMakerSource('maker-7', 'maker-public-key', (_request, _expiresAtMs, id) => { requested = true; requestId = id; });
    source.setGovernanceEnabled(true);
    source.setAvailable(true);
    source.setCapabilities([{ inputMint: asset.mint, outputMint: request.outputMint, minInputAtomic: '1000000', maxInputAtomic: '1000000' }]);
    const pending = source.quote(request, asset, now);
    expect(requested).toBe(true);
    source.submitQuote({ requestId, quoteId: 'maker-q1', ...request, outputAmountAtomic: '101000000', feeBps: 4, expiresAtMs: now + 800, transactionBase64: 'AQ==' });
    await expect(pending).resolves.toMatchObject({
      sourceId: 'maker-7', sourceKind: 'private-maker', quoteId: 'maker-q1',
      wallet: 'seller', inputAmountAtomic: '1000000', grossOutputAtomic: '101000000',
      venueFeeAtomic: '40400', transactionBase64: 'AQ==',
    });
  });

  it('does not request quotes outside the advertised registry asset, output, or size', async () => {
    const asset = demoAssets[0]!;
    let requests = 0;
    const source = new StreamedMakerSource('maker-7', 'maker-public-key', () => { requests += 1; });
    source.setGovernanceEnabled(true);
    source.setAvailable(true);
    const request = { wallet: 'seller', inputMint: asset.mint, outputMint: asset.supportedOutputs[0]!, inputAmountAtomic: '1000000' };
    await expect(source.quote(request, asset, Date.now())).rejects.toThrow('unavailable');
    source.setCapabilities([{ inputMint: asset.mint, outputMint: request.outputMint, minInputAtomic: '1000001', maxInputAtomic: '2000000' }]);
    await expect(source.quote(request, asset, Date.now())).rejects.toThrow('unavailable');
    await expect(source.quote({ ...request, outputMint: asset.supportedOutputs[1]! }, asset, Date.now())).rejects.toThrow('unavailable');
    await expect(source.quote(request, { ...asset, enabled: false }, Date.now())).rejects.toThrow('unavailable');
    expect(requests).toBe(0);
  });

  it('rejects a pending request if the maker withdraws its advertised capability', async () => {
    const asset = demoAssets[0]!;
    const request = { wallet: 'seller', inputMint: asset.mint, outputMint: asset.supportedOutputs[0]!, inputAmountAtomic: '1000000' };
    const source = new StreamedMakerSource('maker-7', 'maker-public-key', () => undefined);
    source.setGovernanceEnabled(true);
    source.setCapabilities([{ inputMint: asset.mint, outputMint: request.outputMint, minInputAtomic: '1', maxInputAtomic: '1000000' }]);
    source.setAvailable(true);
    const pending = source.quote(request, asset, Date.now());
    source.setCapabilities([]);
    await expect(pending).rejects.toThrow('withdrew');
  });
});
