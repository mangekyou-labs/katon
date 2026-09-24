import { generateKeyPairSync, sign as signManifest } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_SELLER_SEED,
  atomicToDecimal,
  buildQuoteBoundV0Transaction,
  decimalToAtomic,
  encodeBase58,
  evaluateEligibility,
  floorFee,
  effectivePriceAtomic,
  assertJupiterPayloadUnchanged,
  localMakerPublicKey,
  parseSolanaTransaction,
  partiallySignV0Transaction,
  publicKeyFromSeed,
  rankExecutableCandidates,
  SOLANA_USDC_MINT,
  SOLANA_USDT_MINT,
  withComputedPrivateFee,
  type AssetRegistryEntry,
  type MintAccountSnapshot,
  type QuoteCandidate,
  type RankInput,
} from '../packages/solana-core/src/index';
import { InMemoryLiquidationSafetyStateStore, LiquidationCircuitBreaker, LiquidationSolver, chooseFundingSource, requiresZeroResidualStock } from '../services/solana-liquidator/src/index';
import { compareDeploymentIdentity, deploymentManifestPayload, DeploymentManifestGate, initializeLiquidationStartup, startLiquidationSolver, verifyDeploymentManifest, MAINNET_PROGRAM_IDS, KaminoLendAdapter, verifyDiscoveredMarkets, type DeploymentManifest, type RuntimeProgramState, type DiscoveredMarket, type LendingPosition } from '../services/solana-liquidator/src/index';
import { MemoryAssetProvider, MockQuoteSimulationProvider, QuoteDeskService } from '../apps/solana-api/src/service';
import { DEMO_WALLET, HeadlessPrivateMakerSource, JupiterStubSource, MemorySourceBalanceProvider, RecordingSender } from '../apps/solana-api/src/sources';
import { demoAssets } from '../apps/solana-api/src/registry';
import { base64FromBytes, transactionHash, validateSignedTransaction, WalletStandardAdapter } from '../packages/solana-sdk/src/index';

const asset: AssetRegistryEntry = {
  mint: 'stock-mint', issuer: 'xstocks', ticker: 'AAPLx', underlyingTicker: 'AAPL', tokenProgram: 'token-2022', decimals: 6,
  issuerAuthorityFingerprint: 'xstocks-authority', expectedMetadataPointer: 'stock-metadata-pointer', extensionFingerprint: 'metadata-pointer|active|scaled|none|none|no-memo', capabilities: { transferHook: false, pausable: true, scaledUiAmount: true, transferFee: false, permanentDelegate: false, memoTransfer: false, confidentialTransfer: false }, supportedOutputs: [SOLANA_USDC_MINT, SOLANA_USDT_MINT], referenceState: 'open', referencePriceAtomic: '100000000', referencePriceDecimals: 6, maxDeviationBps: 150, enabled: true, registryVersion: 1,
};
const mint: MintAccountSnapshot = { mint: asset.mint, ownerProgram: asset.tokenProgram, decimals: asset.decimals, extensionFingerprint: asset.extensionFingerprint, extensions: ['metadata-pointer', 'pausable', 'scaled-ui-amount'], paused: false, metadataPointer: asset.expectedMetadataPointer, issuerAuthorityFingerprint: asset.issuerAuthorityFingerprint, scaledUiAmountEnabled: true, memoTransferRequired: false };
const liquidationMarket: DiscoveredMarket = { lender: 'kamino', programId: MAINNET_PROGRAM_IDS.kamino, marketAddress: 'market', reserveAddress: 'reserve', vaultAddress: 'vault', collateralMint: asset.mint, debtMint: SOLANA_USDC_MINT, oracleAddress: 'oracle', idlSha256: 'idl', bytecodeSha256: 'byte', upgradeAuthority: 'auth', observedAtMs: 1_000 };

const testPublicKey = publicKeyFromSeed(Uint8Array.from(LOCAL_SELLER_SEED));
const TEST_WALLET = DEMO_WALLET;
const base58FromBytes = encodeBase58;

function observeGovernedLocalMakers(desk: QuoteDeskService, makers: readonly HeadlessPrivateMakerSource[]): void {
  for (const maker of makers) desk.observeGovernedMaker(maker.id, encodeBase58(maker.makerPublicKey), true);
}

function testSolanaTransactionBase64(signTransaction = true): string {
  const built = buildQuoteBoundV0Transaction({
    sellerPubkey: testPublicKey,
    quoteId: 'test-quote',
    inputAmountAtomic: '1000000',
    outputAtomic: '100000000',
  });
  if (!signTransaction) return built.transactionBase64;
  const signed = partiallySignV0Transaction({
    message: built.message,
    signatures: built.signatures,
    signerIndex: 0,
    privateKey: Uint8Array.from(LOCAL_SELLER_SEED),
  });
  return base64FromBytes(signed.transaction);
}

function sellerSignTransaction(transactionBase64: string): string {
  const parsed = parseSolanaTransaction(Uint8Array.from(Buffer.from(transactionBase64, 'base64')));
  if (!parsed || parsed.version !== 'v0') throw new Error('expected v0 transaction');
  const signed = partiallySignV0Transaction({
    message: parsed.message,
    signatures: parsed.signatures.map((signature) => Uint8Array.from(signature)),
    signerIndex: 0,
    privateKey: Uint8Array.from(LOCAL_SELLER_SEED),
  });
  return base64FromBytes(signed.transaction);
}

async function reviewAuthorizeExecute(
  desk: QuoteDeskService,
  id: string,
  wallet: string,
  nowMs: number,
  idempotencyKey = `idem-${id}`,
) {
  const before = desk.getSession(id, nowMs);
  await desk.review(id, wallet, nowMs);
  const signed = sellerSignTransaction(before.winner!.transactionBase64!);
  await desk.authorize(id, wallet, before.winner!.transactionHash!, signed, nowMs);
  return desk.createExecutionAttempt({ quoteSprintId: id, idempotencyKey }, nowMs);
}

const TEST_TRANSACTION_BASE64 = testSolanaTransactionBase64();

function candidate(sourceId: string, net: string, expiresAtMs = 20_000): QuoteCandidate {
  const sourceKind = sourceId.startsWith('maker') || sourceId.startsWith('ondo') ? 'private-maker' as const : 'jupiter' as const;
  return { quoteId: sourceId, sourceId, sourceKind, settlementRoute: sourceId.startsWith('ondo') ? 'ondo-managed' : 'generic-spl', router: sourceId, wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', grossOutputAtomic: net, katonFeeAtomic: '0', ...(sourceKind === 'private-maker' ? { katonFeeBps: 0 } : {}), venueFeeAtomic: '0', netOutputAtomic: net, referencePriceAtomic: asset.referencePriceAtomic, referencePriceDecimals: asset.referencePriceDecimals, createdAtMs: 0, expiresAtMs, reliabilityBps: 9_000, transactionVersion: 'v0', transactionBase64: TEST_TRANSACTION_BASE64, simulation: { ok: true, simulatedAtMs: 0 } };
}

function rank(candidates: readonly QuoteCandidate[], overrides: Partial<Omit<RankInput, 'candidates'>> = {}) {
  return rankExecutableCandidates({
    nowMs: 0,
    inputMint: asset.mint,
    outputMint: SOLANA_USDC_MINT,
    inputAmountAtomic: '1000000',
    issuer: asset.issuer,
    inputDecimals: asset.decimals,
    outputDecimals: 6,
    referencePriceAtomic: asset.referencePriceAtomic,
    referencePriceDecimals: asset.referencePriceDecimals,
    ...overrides,
    candidates,
  });
}

function verifiedSourceBalance(sourceId: string, balanceAtomic: string, checkedAtMs = 0) {
  return { sourceId, outputMint: SOLANA_USDC_MINT, balanceAtomic, checkedAtMs };
}

describe('Solana exit desk core', () => {
  it('keeps decimal conversion exact and fees rounded down', () => {
    expect(decimalToAtomic('1.230001', 6).toString()).toBe('1230001');
    expect(atomicToDecimal('1230001', 6)).toBe('1.230001');
    expect(floorFee('101', 10)).toBe(0n);
    expect(floorFee('10000', 10)).toBe(10n);
    expect(() => decimalToAtomic('1e-6', 6)).toThrow();
    expect(() => floorFee('100', 26)).toThrow();
    expect(effectivePriceAtomic('1000000', '1234567', 6)).toBe('1234567');
  });

  it('applies the private-maker fee default and hard cap at the quote boundary', () => {
    const feeBase: Omit<QuoteCandidate, 'katonFeeAtomic' | 'netOutputAtomic' | 'katonFeeBps'> & { readonly feeBps?: number } = {
      quoteId: 'maker-fee', sourceId: 'maker-fee', sourceKind: 'private-maker', settlementRoute: 'generic-spl', router: 'maker', wallet: TEST_WALLET,
      inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', grossOutputAtomic: '1000', venueFeeAtomic: '0',
      createdAtMs: 0, expiresAtMs: 20_000, reliabilityBps: 9_000, transactionVersion: 'v0', transactionBase64: TEST_TRANSACTION_BASE64,
      simulation: { ok: true, simulatedAtMs: 0 },
    };
    expect(withComputedPrivateFee(feeBase)).toMatchObject({ katonFeeBps: 10, katonFeeAtomic: '1', netOutputAtomic: '999' });
    expect(() => withComputedPrivateFee({ ...feeBase, feeBps: 26 })).toThrow('private-maker fee exceeds policy');

    const defaultFeeQuote = { ...candidate('maker-default-fee', '1000'), katonFeeAtomic: '1', netOutputAtomic: '999', katonFeeBps: undefined };
    expect(rank([defaultFeeQuote], { verifiedSourceBalances: { [defaultFeeQuote.sourceId]: verifiedSourceBalance(defaultFeeQuote.sourceId, '1000') } }).winner?.katonFeeBps).toBe(10);
    const overCap = { ...candidate('maker-over-cap', '1000'), katonFeeBps: 26 };
    expect(rank([overCap], { verifiedSourceBalances: { [overCap.sourceId]: verifiedSourceBalance(overCap.sourceId, '1000') } }).audit[0]?.rejectionCode).toBe('policy_failure');
  });

  it('uses one strict parser for legacy and v0 transaction payloads', () => {
    const v0Bytes = Uint8Array.from(Buffer.from(TEST_TRANSACTION_BASE64, 'base64'));
    expect(parseSolanaTransaction(v0Bytes)?.version).toBe('v0');
    expect(v0Bytes[1 + 64]).toBe(0x80);

    const systemProgram = new Uint8Array(32); systemProgram[31] = 1;
    const recentBlockhash = new Uint8Array(32).fill(3);
    const legacyMessage = Uint8Array.from([
      1, 0, 1, 2, ...testPublicKey, ...systemProgram, ...recentBlockhash, 1, 1, 1, 1, 3, 1, 2, 3,
    ]);
    const legacySignature = new Uint8Array(64).fill(9);
    const legacy = Uint8Array.from([1, ...legacySignature, ...legacyMessage]);
    expect(parseSolanaTransaction(legacy)?.version).toBe('legacy');

    const addressTable = new Uint8Array(32).fill(9);
    const v0WithLookupMessage = Uint8Array.from([
      0x80, 1, 0, 0, 1,
      ...testPublicKey,
      ...new Uint8Array(32).fill(3),
      1, 1, 1, 1, 0,
      1, ...addressTable, 1, 0, 0,
    ]);
    expect(parseSolanaTransaction(Uint8Array.from([1, ...legacySignature, ...v0WithLookupMessage]))?.version).toBe('v0');
    expect(parseSolanaTransaction(Uint8Array.from([1, ...legacySignature, ...v0WithLookupMessage.slice(0, -1), 1]))).toBeUndefined();
    expect(parseSolanaTransaction(Uint8Array.from([0x81, 0, ...legacy.slice(1)]))).toBeUndefined();
    expect(parseSolanaTransaction(Uint8Array.from([...legacy, 0]))).toBeUndefined();
    const invalidHeader = legacy.slice();
    invalidHeader[67] = 2;
    expect(parseSolanaTransaction(invalidHeader)).toBeUndefined();
  });

  it('fails closed on unsupported or changed mint state', () => {
    expect(evaluateEligibility({ entry: asset, mint: { ...mint, extensions: ['metadata-pointer', 'confidential-transfer'] }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('unknown');
    expect(evaluateEligibility({ entry: asset, mint: { ...mint, paused: true }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('ineligible');
    expect(evaluateEligibility({ entry: asset, mint: { ...mint, metadataPointer: undefined }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('unknown');
    expect(evaluateEligibility({ entry: { ...asset, expectedMetadataPointer: 'different-pointer' }, mint, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).code).toBe('changed_extension');
    expect(evaluateEligibility({ entry: asset, mint: { ...mint, memoTransferRequired: true }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('unknown');
    const ondoAsset = demoAssets[1];
    const ondoProvider = new MemoryAssetProvider([ondoAsset]);
    const ondoMint = ondoProvider.mintSnapshot(ondoAsset);
    expect(evaluateEligibility({ entry: ondoAsset, mint: { ...ondoMint, issuerProgram: 'changed-program' }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).code).toBe('issuer_mismatch');
    expect(evaluateEligibility({ entry: asset, mint, walletBalanceAtomic: '100', outputMint: 'fake-stable' }).code).toBe('unsupported_output');
    const classicAsset: AssetRegistryEntry = { ...asset, mint: 'classic-stock', tokenProgram: 'spl-token', extensionFingerprint: 'active|unscaled|none|none|no-memo', capabilities: { ...asset.capabilities, pausable: false, scaledUiAmount: false } };
    const classicMint: MintAccountSnapshot = { ...mint, mint: classicAsset.mint, ownerProgram: 'spl-token', extensionFingerprint: classicAsset.extensionFingerprint, extensions: [], metadataPointer: undefined, scaledUiAmountEnabled: false, memoTransferRequired: false };
    expect(evaluateEligibility({ entry: classicAsset, mint: classicMint, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('unknown');
    const verifiedClassicMint = { ...classicMint, metadataPointer: classicAsset.expectedMetadataPointer };
    expect(evaluateEligibility({ entry: classicAsset, mint: verifiedClassicMint, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('eligible');
    const classicProvider = new MemoryAssetProvider([classicAsset]);
    expect(classicProvider.mintSnapshot(classicAsset).extensions).toEqual([]);
    expect(classicProvider.mintSnapshot(classicAsset).metadataPointer).toBe(classicAsset.expectedMetadataPointer);
  });

  it('ranks net output, validity, reliability and source id deterministically', () => {
    const verifiedSourceBalances = { 'maker-a': verifiedSourceBalance('maker-a', '1000'), 'maker-b': verifiedSourceBalance('maker-b', '1000') };
    const result = rank([candidate('maker-b', '1000'), candidate('maker-a', '1000', 30_000), candidate('jupiter', '9999')], { verifiedSourceBalances });
    expect(result.winner?.sourceId).toBe('jupiter');
    expect(result.audit).toHaveLength(3);
    expect(rank([candidate('maker-b', '1000'), candidate('maker-a', '1000')], { verifiedSourceBalances }).winner?.sourceId).toBe('maker-a');
    expect(rank([{ ...candidate('bad-sim', '5000'), simulation: { ok: false, errorCode: 'slippage', simulatedAtMs: 0 } }, { ...candidate('bad-fee', '5000'), grossOutputAtomic: '4', katonFeeAtomic: '3', venueFeeAtomic: '3' }, { ...candidate('bad-band', '9000'), deviationBps: 999 }, candidate('too-long', '8000', 31_000)], { maxDeviationBps: 150 }).audit.map((row) => row.rejectionCode)).toEqual(['failed_simulation', 'malformed_quote', 'price_band', 'malformed_quote']);
  });

  it('fails closed when a private maker lacks independently verified liquidity', () => {
    const quote = candidate('maker-unverified', '1000');
    expect(rank([quote])).toMatchObject({ winner: undefined, audit: [{ rejectionCode: 'insufficient_liquidity', status: 'rejected' }] });
    expect(rank([quote], { verifiedSourceBalances: { 'maker-unverified': verifiedSourceBalance('maker-unverified', '999') } })).toMatchObject({ winner: undefined, audit: [{ rejectionCode: 'insufficient_liquidity', status: 'rejected' }] });
    expect(rank([quote], { verifiedSourceBalances: { 'maker-unverified': verifiedSourceBalance('maker-unverified', '1000', 4_000) } })).toMatchObject({ winner: undefined, audit: [{ rejectionCode: 'source_error', status: 'rejected' }] });
    expect(rank([quote], { verifiedSourceBalances: { 'maker-unverified': { ...verifiedSourceBalance('maker-unverified', '1000'), outputMint: SOLANA_USDT_MINT } } })).toMatchObject({ winner: undefined, audit: [{ rejectionCode: 'insufficient_liquidity', status: 'rejected' }] });
  });

  it('keeps Ondo managed route out of executable seller inventory', () => {
    const spoofedDeviation = { ...candidate('jupiter-spoofed-deviation', '98000000'), deviationBps: 0 };
    expect(rank([spoofedDeviation], { maxDeviationBps: 150 })).toMatchObject({
      winner: undefined,
      audit: [{ rejectionCode: 'price_band', status: 'rejected' }],
    });

    const ondoAsset = demoAssets[1];
    expect(ondoAsset.enabled).toBe(false);
    const provider = new MemoryAssetProvider(demoAssets);
    provider.setBalance(TEST_WALLET, ondoAsset.mint, '2500000');
    provider.setBalance(TEST_WALLET, demoAssets[0].mint, '2500000');
    const sender = new RecordingSender();
    const desk = new QuoteDeskService(provider, [new JupiterStubSource()], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const listed = desk.listAssets(TEST_WALLET, SOLANA_USDC_MINT);
    const ondoView = listed.find((entry) => entry.mint === ondoAsset.mint);
    const xstocksView = listed.find((entry) => entry.mint === demoAssets[0].mint);
    expect(ondoView?.capability).toBe('informational');
    expect(ondoView?.eligibility.message).toBe('Managed Route not enabled');
    expect(xstocksView?.capability).toBe('executable');

    const genericRoute = {
      ...candidate('ondo-generic-route', '100000000'),
      inputMint: ondoAsset.mint,
      referencePriceAtomic: ondoAsset.referencePriceAtomic,
      referencePriceDecimals: ondoAsset.referencePriceDecimals,
      settlementRoute: 'generic-spl' as const,
      sourceKind: 'jupiter' as const,
    };
    expect(rank([genericRoute], {
      issuer: ondoAsset.issuer,
      inputMint: ondoAsset.mint,
      inputDecimals: ondoAsset.decimals,
      referencePriceAtomic: ondoAsset.referencePriceAtomic,
      referencePriceDecimals: ondoAsset.referencePriceDecimals,
      maxDeviationBps: ondoAsset.maxDeviationBps,
    }).audit[0]?.rejectionCode).toBe('policy_failure');
  });

  it('rejects non-finite or unsafe quote metadata before sorting', () => {
    const malformed = [
      { ...candidate('bad-created-at', '1000'), createdAtMs: Number.NaN },
      { ...candidate('bad-reliability', '1000'), reliabilityBps: Number.POSITIVE_INFINITY },
      { ...candidate('bad-deviation', '1000'), deviationBps: Number.NaN },
      { ...candidate('bad-simulation-time', '1000'), simulation: { ok: true, simulatedAtMs: Number.POSITIVE_INFINITY } },
      { ...candidate('future-created-at', '1000', 30_000), createdAtMs: 1 },
      undefined as unknown as QuoteCandidate,
      { ...candidate('missing-simulation', '1000'), simulation: undefined as unknown as QuoteCandidate['simulation'] },
    ];
    expect(() => rank(malformed, { maxDeviationBps: 150 })).not.toThrow();
    expect(rank(malformed, { maxDeviationBps: 150 }).audit.map((row) => row.rejectionCode)).toEqual([
      'malformed_quote',
      'malformed_quote',
      'malformed_quote',
      'malformed_quote',
      'malformed_quote',
      'malformed_quote',
      'malformed_quote',
    ]);
  });

  it('uses the post-collection clock when expiring a delayed quote sprint', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const delayedSource = {
      id: 'jupiter-delayed',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_900,
      quote: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return candidate('jupiter-delayed', '1000', 4_000);
      },
    };
    const desk = new QuoteDeskService(provider, [delayedSource], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const collected = await desk.collectNow(created.id, 2_500);
    expect(collected.state).toBe('no_quote');
    expect(collected.audit.some((row) => row.rejectionCode === 'expired')).toBe(true);
  });

  it('refreshes the clock after collection when collectNow has no pinned time', async () => {
    let nowMs = 1_000;
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const delayedSource = {
      id: 'jupiter-clock-refresh',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_900,
      quote: async () => {
        await Promise.resolve();
        nowMs = 2_500;
        return candidate('jupiter-clock-refresh', '1000', 4_000);
      },
    };
    const desk = new QuoteDeskService(provider, [delayedSource], sender, sender, () => nowMs, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' });
    const collected = await desk.collectNow(created.id);
    expect(collected.state).toBe('no_quote');
    expect(collected.audit.some((row) => row.rejectionCode === 'expired')).toBe(true);
  });

  it('expires a quote when final review simulation crosses the safety margin', async () => {
    let nowMs = 1_000;
    let simulationCalls = 0;
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const source = {
      id: 'jupiter-review-expiry',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async () => candidate('jupiter-review-expiry', '100000000', 5_000),
    };
    const simulator = {
      simulate: async (_quote: QuoteCandidate, simulationNowMs: number) => {
        if (simulationCalls++ === 1) nowMs = 3_500;
        return { ok: true, simulatedAtMs: simulationNowMs };
      },
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, () => nowMs, simulator);
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' });
    await expect(desk.collectNow(created.id)).resolves.toMatchObject({ state: 'winner_ready' });
    await expect(desk.review(created.id, TEST_WALLET)).rejects.toThrow('quote expired');
    expect(desk.getSession(created.id).state).toBe('expired');
    expect(desk.getSession(created.id).winner?.transactionBase64).toBeUndefined();
  });

  it('rechecks the live clock after signed-transaction validation', async () => {
    let nowMs = 1_000;
    let authorizePhase = false;
    let authorizeClockCalls = 0;
    const clock = () => {
      // liveClock authorize evaluates default nowMs, authorizeNowMs, then post-validate.
      if (authorizePhase && ++authorizeClockCalls >= 3) nowMs = 8_000;
      return nowMs;
    };
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const source = {
      id: 'jupiter-execute-expiry',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async () => candidate('jupiter-execute-expiry', '100000000', 10_000),
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, clock, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' });
    await desk.collectNow(created.id);
    const reviewed = await desk.review(created.id, TEST_WALLET);
    const signed = sellerSignTransaction(reviewed.winner!.transactionBase64!);
    authorizePhase = true;
    await expect(desk.authorize(created.id, TEST_WALLET, reviewed.winner!.transactionHash!, signed)).rejects.toThrow('quote expired');
    expect(desk.getSession(created.id).state).toBe('expired');
  });

  it('binds the Solana message while allowing wallet signatures to change', async () => {
    const issued = Uint8Array.from(Buffer.from(testSolanaTransactionBase64(false), 'base64'));
    const signed = Uint8Array.from(Buffer.from(TEST_TRANSACTION_BASE64, 'base64'));
    const issuedBase64 = base64FromBytes(issued);
    const signedBase64 = base64FromBytes(signed);
    const hash = await transactionHash(issuedBase64);
    expect(await transactionHash(signedBase64)).toBe(hash);
    expect(await validateSignedTransaction(signedBase64, { wallet: TEST_WALLET, issuedTransactionHash: hash, issuedQuoteId: 'quote', expiresAtMs: 10_000 }, 1_000)).toMatchObject({ ok: true });
    expect(() => assertJupiterPayloadUnchanged(issuedBase64, signedBase64)).not.toThrow();
    const changed = signed.slice(); changed[1] ^= 1;
    expect(await validateSignedTransaction(base64FromBytes(changed), { wallet: TEST_WALLET, issuedTransactionHash: hash, issuedQuoteId: 'quote', expiresAtMs: 10_000 }, 1_000)).toMatchObject({ ok: false, code: 'signature_invalid' });
    // Flip instruction-data content, not the trailing address-table lookup shortvec (last byte),
    // so the transaction remains structurally parseable and fails on message hash binding.
    const changedMessage = signed.slice(); changedMessage[changedMessage.length - 2] ^= 1;
    expect(await validateSignedTransaction(base64FromBytes(changedMessage), { wallet: TEST_WALLET, issuedTransactionHash: hash, issuedQuoteId: 'quote', expiresAtMs: 10_000 }, 1_000)).toMatchObject({ ok: false, code: 'hash_mismatch' });
    expect(await validateSignedTransaction(signedBase64, { wallet: base58FromBytes(new Uint8Array(32).fill(7)), issuedTransactionHash: hash, issuedQuoteId: 'quote', expiresAtMs: 10_000 }, 1_000)).toMatchObject({ ok: false, code: 'wallet_mismatch' });
    const malformed = 'AQ==';
    expect(await validateSignedTransaction(malformed, { wallet: TEST_WALLET, issuedTransactionHash: hash, issuedQuoteId: 'quote', expiresAtMs: 10_000 }, 1_000)).toMatchObject({ ok: false, code: 'malformed' });
    expect(await validateSignedTransaction('AB==', { wallet: TEST_WALLET, issuedTransactionHash: hash, issuedQuoteId: 'quote', expiresAtMs: 10_000 }, 1_000)).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('prefers flashloan, caps prefunded fallback, and trips after three landing failures', () => {
    const base = { id: 'opp', collateralMint: asset.mint, debtMint: 'native-usdc', debtAtomic: '100000000', collateralAtomic: '1000000', expectedGrossOutputAtomic: '120000000', expectedCostsAtomic: '5000000', expectedProfitAtomic: '15000000', expectedProfitBps: 1500, healthFreshAtMs: Date.now(), atomicUnwind: true, computeUnits: 500_000, market: liquidationMarket, route: candidate('jupiter', '120000000') };
    expect(chooseFundingSource(base, '100000000', { nowMs: () => Date.now() }).funding).toBe('jupiter-flashloan');
    expect(chooseFundingSource(base, '0', { nowMs: () => Date.now() }).funding).toBe('prefunded-usdc');
    expect(requiresZeroResidualStock('100', '0')).toBe(true);
    expect(requiresZeroResidualStock('0', '0')).toBe(false);
    expect(requiresZeroResidualStock('0', '1')).toBe(false);
    expect(requiresZeroResidualStock('100', '1')).toBe(false);
    expect(chooseFundingSource({ ...base, expectedProfitAtomic: '15000001' }, '100000000', { nowMs: () => Date.now() }).reason).toBe('malformed_opportunity');
    expect(chooseFundingSource({ ...base, expectedProfitBps: 1499 }, '100000000', { nowMs: () => Date.now() }).reason).toBe('malformed_opportunity');
    expect(chooseFundingSource({ ...base, expectedGrossOutputAtomic: '105000000', expectedProfitAtomic: '0', expectedProfitBps: 0 }, '100000000', { nowMs: () => Date.now() }).reason).toBe('insufficient_profit');
    const breaker = new LiquidationCircuitBreaker(); breaker.recordLandingFailure(); breaker.recordLandingFailure(); expect(breaker.snapshot().halted).toBe(false); breaker.recordLandingFailure(); expect(breaker.snapshot().halted).toBe(true);
    expect(breaker.recordAdverseExecution(26).halted).toBe(true);
    const residualBreaker = new LiquidationCircuitBreaker();
    expect(residualBreaker.enforceZeroResidualTransition('100', '0').halted).toBe(false);
    expect(residualBreaker.enforceZeroResidualTransition('100', '1').reason).toBe('zero-residual transition invariant violated');
    expect(residualBreaker.snapshot().halted).toBe(true);
    expect(chooseFundingSource({ ...base, route: { ...base.route!, router: 'jupiterz-managed' } }, '100000000', { nowMs: () => Date.now() }).reason).toBe('managed_transaction');
  });

  it('restores breaker history and arbitrates opportunity leases durably', async () => {
    const store = new InMemoryLiquidationSafetyStateStore();
    const breaker = await LiquidationCircuitBreaker.restore(store);
    breaker.recordLandingFailure();
    breaker.recordLandingFailure();
    breaker.recordLandingFailure();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await LiquidationCircuitBreaker.restore(store)).snapshot().halted).toBe(true);
    expect(await store.acquireOpportunityLease('opp', 'worker-a', 1_000, 100)).toBe(true);
    expect(await store.acquireOpportunityLease('opp', 'worker-b', 1_001, 100)).toBe(false);
    expect(await store.acquireOpportunityLease('opp', 'worker-b', 1_100, 100)).toBe(true);
    await store.releaseOpportunityLease('opp', 'worker-b');
    expect(await store.acquireOpportunityLease('opp', 'worker-c', 1_101, 100)).toBe(true);
  });

  it('does not construct the liquidation solver before startup validation passes', async () => {
    const invalidManifest: DeploymentManifest = { cluster: 'mainnet-beta', generatedAt: '2026-09-15', programs: [], enabledStockMints: [], signatureAlgorithm: 'ed25519', signerPublicKey: '', signature: '' };
    const manifestGate = new DeploymentManifestGate(invalidManifest, [], [], 'mainnet-beta', []);
    const started = await startLiquidationSolver(manifestGate, [], [asset], 1_000, { nowMs: () => 1_000 });
    expect(started.startupGate.check()).toMatchObject({ ok: false, reason: 'manifest_unsigned' });
    expect(started.solver).toBeUndefined();

    // @ts-expect-error A solver must receive the opaque result of startup validation.
    new LiquidationSolver(new LiquidationCircuitBreaker(), { nowMs: () => 1_000 }, { check: () => ({ ok: true, message: 'forged' }), matchesMarket: () => true });
  });
});

describe('Solana deployment manifest', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const unsignedManifest = { cluster: 'mainnet-beta' as const, generatedAt: '2026-09-15', programs: [{ name: 'kamino' as const, programId: MAINNET_PROGRAM_IDS.kamino, idlSha256: 'idl', bytecodeSha256: 'byte', upgradeAuthority: 'auth' }, { name: 'jupiter-lend' as const, programId: MAINNET_PROGRAM_IDS.jupiterLend, idlSha256: 'idl', bytecodeSha256: 'byte', upgradeAuthority: 'auth' }, { name: 'jupiter-flashloan' as const, programId: MAINNET_PROGRAM_IDS.jupiterFlashloan, idlSha256: 'idl', bytecodeSha256: 'byte', upgradeAuthority: 'auth' }], enabledStockMints: [asset.mint] };
  const manifest: DeploymentManifest = { ...unsignedManifest, signatureAlgorithm: 'ed25519', signerPublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), signature: signManifest(null, Buffer.from(deploymentManifestPayload(unsignedManifest), 'utf8'), privateKey).toString('base64') };
  const runtime: readonly RuntimeProgramState[] = manifest.programs;
  const trustedSignerPublicKeys = [manifest.signerPublicKey];
  it('halts on any deployment or mint drift', () => {
    expect(verifyDeploymentManifest(manifest, runtime, [asset.mint], 'mainnet-beta', trustedSignerPublicKeys).ok).toBe(true);
    expect(verifyDeploymentManifest(manifest, runtime, ['unreviewed'], 'mainnet-beta', trustedSignerPublicKeys).reason).toBe('stock_mint_unreviewed');
    expect(verifyDeploymentManifest(manifest, runtime.map((entry) => entry.name === 'kamino' ? { ...entry, bytecodeSha256: 'changed' } : entry), [asset.mint], 'mainnet-beta', trustedSignerPublicKeys).reason).toBe('bytecode_mismatch');
    expect(verifyDeploymentManifest({ ...manifest, signature: 'REPLACE_WITH_SQUADS_SIGNATURE' }, runtime, [asset.mint], 'mainnet-beta', trustedSignerPublicKeys).reason).toBe('manifest_unsigned');
    expect(verifyDeploymentManifest({ ...manifest, signature: Buffer.alloc(64).toString('base64') }, runtime, [asset.mint], 'mainnet-beta', trustedSignerPublicKeys).reason).toBe('manifest_signature_invalid');
    expect(verifyDeploymentManifest({ ...manifest, enabledStockMints: ['changed-mint'] }, runtime, [asset.mint], 'mainnet-beta', trustedSignerPublicKeys).reason).toBe('manifest_signature_invalid');
    expect(verifyDeploymentManifest({ ...manifest, signerPublicKey: Buffer.alloc(32, 7).toString('base64') }, runtime, [asset.mint], 'mainnet-beta', trustedSignerPublicKeys).reason).toBe('manifest_signer_untrusted');
    expect(verifyDeploymentManifest(manifest, [...runtime, { ...runtime[0], name: 'kamino', programId: 'unreviewed' }], [asset.mint], 'mainnet-beta', trustedSignerPublicKeys).reason).toBe('program_unreviewed');
    expect(compareDeploymentIdentity(manifest.programs[0], runtime[0])).toBeUndefined();
    expect(compareDeploymentIdentity(manifest.programs[0], { ...runtime[0], upgradeAuthority: 'changed' })).toBe('upgradeAuthority');
  });

  it('exposes a startup gate that the solver can require before preparation', async () => {
    const gate = new DeploymentManifestGate(manifest, runtime, [asset.mint], 'mainnet-beta', trustedSignerPublicKeys);
    expect(gate.check()).toEqual({ ok: true, message: 'runtime matches signed deployment manifest' });
    const market: DiscoveredMarket = { lender: 'kamino', programId: MAINNET_PROGRAM_IDS.kamino, marketAddress: 'market', reserveAddress: 'reserve', vaultAddress: 'vault', collateralMint: asset.mint, debtMint: SOLANA_USDC_MINT, oracleAddress: 'oracle', idlSha256: 'idl', bytecodeSha256: 'byte', upgradeAuthority: 'auth', observedAtMs: 1_000 };
    const mismatchedMarketGate = await initializeLiquidationStartup(gate, [new KaminoLendAdapter(async () => [{ ...market, idlSha256: 'changed' }])], [asset], 1_000);
    expect(mismatchedMarketGate.check()).toMatchObject({ ok: false, reason: 'market_discovery_invalid' });
    expect(gate.verifyMarket(market)).toEqual({ ok: true, message: 'kamino market matches the signed deployment manifest' });
    expect(gate.verifyMarket({ ...market, bytecodeSha256: 'changed' })).toMatchObject({ ok: false, reason: 'market_manifest_mismatch' });
    const opportunity = { id: 'opp', collateralMint: asset.mint, debtMint: 'native-usdc', debtAtomic: '100000000', collateralAtomic: '1000000', expectedGrossOutputAtomic: '120000000', expectedCostsAtomic: '5000000', expectedProfitAtomic: '15000000', expectedProfitBps: 1500, healthFreshAtMs: 1_000, atomicUnwind: true, computeUnits: 500_000, market, route: candidate('jupiter', '120000000') };
    const safetyStore = new InMemoryLiquidationSafetyStateStore();
    const enablement = { verifyAppliedEnablement: async () => ({ vaultAuthorized: true, solverIdentity: 'solver-a', evidenceHash: 'a'.repeat(64), applyAfterMs: 900, appliedAtMs: 950 }) };
    const started = await startLiquidationSolver(gate, [new KaminoLendAdapter(async () => [market])], [asset], 1_000, { nowMs: () => 1_000, solverIdentity: 'solver-a' }, undefined, safetyStore, enablement);
    expect(started.solver).toBeInstanceOf(LiquidationSolver);
    const result = await started.solver!.prepare(opportunity, '100000000', {
      build: async () => ({ transactionBase64: 'AQ==', messageHash: 'hash' }),
    }, {
      simulate: async () => ({ ok: true }),
    });
    expect(result.decision).toEqual({ executable: true, funding: 'jupiter-flashloan' });
    const noLiquidationEnablement = await startLiquidationSolver(gate, [new KaminoLendAdapter(async () => [market])], [asset], 1_000, { nowMs: () => 1_000, solverIdentity: 'solver-a' }, undefined, new InMemoryLiquidationSafetyStateStore());
    expect(noLiquidationEnablement.startupGate.check()).toMatchObject({ ok: false, reason: 'liquidation_enablement_unavailable' });
    expect(noLiquidationEnablement.solver).toBeUndefined();
    const missingSafetyState = await startLiquidationSolver(gate, [new KaminoLendAdapter(async () => [market])], [asset], 1_000, { nowMs: () => 1_000, solverIdentity: 'solver-a' }, undefined, undefined, enablement);
    expect(missingSafetyState.startupGate.check()).toMatchObject({ ok: false, reason: 'safety_state_unavailable' });
    expect(missingSafetyState.solver).toBeUndefined();
    const blocked = await startLiquidationSolver(gate, [new KaminoLendAdapter(async () => [{ ...market, bytecodeSha256: 'changed' }])], [asset], 1_000, { nowMs: () => 1_000, solverIdentity: 'solver-a' }, undefined, undefined, enablement);
    expect(blocked.solver).toBeUndefined();
  });

  it('keeps the solver dormant until authoritative lender discovery also passes', async () => {
    const market: DiscoveredMarket = { lender: 'kamino', programId: MAINNET_PROGRAM_IDS.kamino, marketAddress: 'market', reserveAddress: 'reserve', vaultAddress: 'vault', collateralMint: asset.mint, debtMint: SOLANA_USDC_MINT, oracleAddress: 'oracle', idlSha256: 'idl', bytecodeSha256: 'byte', upgradeAuthority: 'auth', observedAtMs: 1_000 };
    const manifestGate = new DeploymentManifestGate(manifest, runtime, [asset.mint], 'mainnet-beta', trustedSignerPublicKeys);
    const readyGate = await initializeLiquidationStartup(manifestGate, [new KaminoLendAdapter(async () => [market])], [asset], 1_000);
    expect(readyGate.check()).toEqual({ ok: true, message: 'runtime and reviewed lender markets match deployment manifest' });

    const dormantGate = await initializeLiquidationStartup(manifestGate, [new KaminoLendAdapter(async () => [])], [asset], 1_000);
    expect(dormantGate.check()).toMatchObject({ ok: false, reason: 'market_discovery_invalid' });

    const unavailableGate = await initializeLiquidationStartup(manifestGate, [new KaminoLendAdapter()], [asset], 1_000);
    expect(unavailableGate.check()).toMatchObject({ ok: false, reason: 'market_discovery_unavailable' });
  });
});

describe('lending adapters and registry discovery', () => {
  const market: DiscoveredMarket = { lender: 'kamino', programId: MAINNET_PROGRAM_IDS.kamino, marketAddress: 'market', reserveAddress: 'reserve', vaultAddress: 'vault', collateralMint: asset.mint, debtMint: SOLANA_USDC_MINT, oracleAddress: 'oracle', idlSha256: 'idl', bytecodeSha256: 'byte', upgradeAuthority: 'auth', observedAtMs: 1_000 };
  const position: LendingPosition = { obligationAddress: 'obligation', owner: 'owner', collateralMint: asset.mint, collateralAtomic: '100', debtMint: SOLANA_USDC_MINT, debtAtomic: '50', healthFactorBps: 9_900, observedAtMs: 1_000 };

  it('pins lender discovery and accepts only injected authoritative instructions', async () => {
    const instruction = { programId: MAINNET_PROGRAM_IDS.kamino, accounts: ['market', 'reserve', 'vault', 'obligation', 'owner'], dataBase64: 'AQ==', authoritative: true as const };
    const adapter = new KaminoLendAdapter(async () => [market], async () => instruction);
    expect(await adapter.discoverMarkets()).toEqual([market]);
    expect(await adapter.buildLiquidationInstruction(position, market)).toEqual(instruction);
    await expect(new KaminoLendAdapter(async () => [market]).buildLiquidationInstruction(position, market)).rejects.toThrow('authoritative');
    await expect(new KaminoLendAdapter(async () => [market], async () => ({ ...instruction, dataBase64: 'AQ' })).buildLiquidationInstruction(position, market)).rejects.toThrow('authoritative');
    expect(verifyDiscoveredMarkets([market], [asset], 1_500).ok).toBe(true);
    expect(verifyDiscoveredMarkets([{ ...market, lender: 'unreviewed' as DiscoveredMarket['lender'] }], [asset], 1_500).reason).toBe('unreviewed lender');
    expect(verifyDiscoveredMarkets([{ ...market, programId: 'unreviewed' }], [asset], 1_500).reason).toBe('unreviewed lender program');
    expect(verifyDiscoveredMarkets([{ ...market, observedAtMs: Number.NaN }], [asset], 1_500).reason).toBe('market discovery timestamp is invalid');
    expect(verifyDiscoveredMarkets([], [asset], 1_500).reason).toBe('no reviewed lender markets discovered');
    await expect(new KaminoLendAdapter(async () => [{ ...market, programId: 'unreviewed' }]).discoverMarkets()).rejects.toThrow('unreviewed');
  });
});

describe('Wallet Standard signer boundary', () => {
  it('maps connection state and signs only through signTransaction', async () => {
    const wallet = { name: 'Test', accounts: [{ address: TEST_WALLET, chains: ['solana:localnet'] }], connect: async () => undefined, signTransaction: async (bytes: Uint8Array) => { const signed = bytes.slice(); signed[0] = 7; return signed; } };
    const adapter = new WalletStandardAdapter(wallet, 'solana:localnet');
    expect(await adapter.connect()).toBe('connected');
    expect(await adapter.sign('AQ==')).toBe('Bw==');
    await adapter.disconnect();
    expect(adapter.state).toBe('disconnected');
    const wrongCluster = new WalletStandardAdapter({ ...wallet, accounts: [{ address: TEST_WALLET, chains: ['solana:devnet'] }] }, 'solana:localnet');
    expect(await wrongCluster.connect()).toBe('wrong-cluster');
    await expect(adapter.sign('AQ==')).rejects.toThrow('wallet is not connected to solana:localnet');
  });

  it('accepts solana:localnet when expectedChain is set', async () => {
    const wallet = { name: 'Test', accounts: [{ address: TEST_WALLET, chains: ['solana:localnet'] }], connect: async () => undefined, signTransaction: async (bytes: Uint8Array) => bytes };
    const adapter = new WalletStandardAdapter(wallet, 'solana:localnet');
    expect(await adapter.connect()).toBe('connected');
    const mainnetOnly = new WalletStandardAdapter(wallet, 'solana:mainnet');
    expect(await mainnetOnly.connect()).toBe('wrong-cluster');
  });
});

describe('local coordination seam', () => {
  it('replaces source simulation evidence with an independent transaction simulation', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const source = {
      id: 'jupiter-untrusted-simulation',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async () => ({
        ...candidate('jupiter-untrusted-simulation', '100000000'),
        simulation: { ok: false, errorCode: 'source-claimed-failure', simulatedAtMs: 0 },
      }),
    };
    let simulationCalls = 0;
    const independentSimulator = {
      simulate: async (issuedCandidate: QuoteCandidate, nowMs: number) => {
        if (simulationCalls++ === 0) expect(issuedCandidate.simulation.ok).toBe(false);
        else expect(issuedCandidate.simulation.ok).toBe(true);
        return { ok: true, unitsConsumed: 123_000, simulatedAtMs: nowMs };
      },
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, Date.now, independentSimulator);
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_100);
    expect(ready.state).toBe('winner_ready');
    expect(ready.winner?.simulation).toEqual({ ok: true, unitsConsumed: 123_000, simulatedAtMs: 1_000 });
    const reviewed = await desk.review(created.id, TEST_WALLET, 1_200);
    expect(reviewed.winner?.simulation).toEqual({ ok: true, unitsConsumed: 123_000, simulatedAtMs: 1_200 });
  });

  it('bounds source collection, independent simulation, and balance checks to one sprint', async () => {
    let monotonicMs = 0;
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const source = {
      id: 'maker-sprint-boundary',
      kind: 'private-maker' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      makerPublicKey: localMakerPublicKey(),
      quote: async () => {
        monotonicMs = 2_500;
        return candidate('maker-sprint-boundary', '100000000');
      },
    };
    const independentSimulator = {
      simulate: async () => {
        monotonicMs = 2_900;
        return { ok: true, unitsConsumed: 123_000, simulatedAtMs: 1_000 };
      },
    };
    const sourceBalances = {
      verify: async () => {
        monotonicMs = 3_100;
        return verifiedSourceBalance('maker-sprint-boundary', '1000', 1_000);
      },
    };
    const desk = new QuoteDeskService(
      provider,
      [source],
      sender,
      sender,
      Date.now,
      independentSimulator,
      sourceBalances,
      () => monotonicMs,
    );
    desk.observeGovernedMaker(source.id, encodeBase58(source.makerPublicKey), true);
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const result = await desk.collectNow(created.id, 1_000);
    expect(result.state).toBe('no_quote');
    expect(result.audit).toMatchObject([{ rejectionCode: 'insufficient_liquidity', status: 'rejected' }]);
  });

  it('refreshes live timestamps between source collection and independent simulation', async () => {
    let nowMs = 1_000;
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const source = {
      id: 'jupiter-live-clock',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async (_request: unknown, _asset: unknown, sourceNowMs: number) => {
        expect(sourceNowMs).toBe(1_000);
        nowMs = 1_100;
        return candidate('jupiter-live-clock', '100000000');
      },
    };
    const independentSimulator = {
      simulate: async (_issuedCandidate: QuoteCandidate, simulationNowMs: number) => {
        expect(simulationNowMs).toBe(1_100);
        return { ok: true, unitsConsumed: 123_000, simulatedAtMs: simulationNowMs };
      },
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, () => nowMs, independentSimulator);
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' });
    const result = await desk.collectNow(created.id);
    expect(result.state).toBe('winner_ready');
    expect(result.winner?.simulation.simulatedAtMs).toBe(1_100);
  });

  it('rejects source identity spoofing and ranks by adapter reliability', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const lowReliability = {
      id: 'jupiter-low',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 100,
      quote: async () => ({ ...candidate('jupiter-low', '100000000'), reliabilityBps: 10_000 }),
    };
    const highReliability = {
      id: 'jupiter-high',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async () => ({ ...candidate('jupiter-high', '100000000'), reliabilityBps: 0 }),
    };
    const spoofing = {
      id: 'jupiter-spoofing',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async () => candidate('jupiter-high', '100000000'),
    };
    const desk = new QuoteDeskService(provider, [lowReliability, highReliability, spoofing], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const result = await desk.collectNow(created.id, 1_100);
    expect(result.winner?.sourceId).toBe('jupiter-high');
    expect(result.audit.filter((row) => row.rejectionCode === 'source_error')).toHaveLength(1);
  });

  it('collects a winner, keeps losing payloads out of audit, and settles only the winner', async () => {
    const provider = new MemoryAssetProvider(demoAssets);
    provider.setBalance(TEST_WALLET, demoAssets[0].mint, '2500000');
    const sender = new RecordingSender();
    const sourceBalances = new MemorySourceBalanceProvider();
    sourceBalances.setBalance('maker-sandbox-01', SOLANA_USDC_MINT, '1000000000');
    const maker = new HeadlessPrivateMakerSource();
    const desk = new QuoteDeskService(provider, [new JupiterStubSource(), maker], sender, sender, Date.now, new MockQuoteSimulationProvider(), sourceBalances);
    observeGovernedLocalMakers(desk, [maker]);
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: demoAssets[0].mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_500);
    expect(ready.state).toBe('winner_ready');
    expect(ready.winner?.sourceKind).toBe('private-maker');
    expect(ready.winner?.effectivePriceAtomic).toBeDefined();
    expect(ready.winner?.priceImpactBps).toBe(1);
    expect(ready.audit.every((row) => !('sourceId' in row))).toBe(true);
    const parsed = parseSolanaTransaction(Uint8Array.from(Buffer.from(ready.winner!.transactionBase64!, 'base64')));
    expect(parsed?.version).toBe('v0');
    expect(parsed?.signatures[1]?.some((byte) => byte !== 0)).toBe(true);
    const reviewed = await desk.review(created.id, TEST_WALLET, 1_600);
    expect(reviewed.state).toBe('winner_ready');
    const result = await reviewAuthorizeExecute(desk, created.id, TEST_WALLET, 2_000);
    expect(result.receipt?.sourceKind).toBe('private-maker');
    expect(result.attempt.state).toBe('finalized');
    expect(result.receipt?.signature.startsWith('mock-')).toBe(false);
    expect(desk.listTrades(TEST_WALLET)).toHaveLength(1);
    expect(desk.getSession(created.id, 2_000).winner?.transactionBase64).toBeUndefined();
  });

  it('explains when a quote expires while the seller is in the wallet approval flow', async () => {
    const provider = new MemoryAssetProvider(demoAssets);
    provider.setBalance(TEST_WALLET, demoAssets[0].mint, '2500000');
    const sender = new RecordingSender();
    const sourceBalances = new MemorySourceBalanceProvider();
    sourceBalances.setBalance('maker-sandbox-01', SOLANA_USDC_MINT, '1000000000');
    const maker = new HeadlessPrivateMakerSource();
    const desk = new QuoteDeskService(provider, [maker], sender, sender, () => 1_500, new MockQuoteSimulationProvider(), sourceBalances);
    observeGovernedLocalMakers(desk, [maker]);
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: demoAssets[0].mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_500);
    const winner = ready.winner!;
    expect(winner.expiresAtMs - winner.createdAtMs).toBe(30_000);
    const walletApprovalNow = winner.expiresAtMs - 2_000;

    await expect(desk.authorize(created.id, TEST_WALLET, winner.transactionHash!, '', walletApprovalNow))
      .rejects.toThrow('quote expired; request a fresh quote');
    expect(desk.getSession(created.id, walletApprovalNow).state).toBe('expired');
  });

  it('emits exactly one terminal event to a subscriber that is present during collection', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const source = {
      id: 'jupiter-sse-terminal',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async (_request: unknown, _asset: unknown, nowMs: number) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ...candidate('jupiter-sse-terminal', '100000000', nowMs + 10_000), createdAtMs: nowMs, expiresAtMs: nowMs + 10_000 };
      },
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, () => 1_000, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const events: string[] = [];
    const unsubscribe = desk.subscribe(created.id, (session) => events.push(session.state));
    await desk.collectNow(created.id, 1_100);
    unsubscribe();
    const terminal = events.filter((state) => ['winner_ready', 'no_quote', 'expired', 'failed'].includes(state));
    expect(terminal).toEqual(['winner_ready']);
  });

  it('emits a failed terminal event when finalization rejects malformed payload bytes', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = new RecordingSender();
    const source = {
      id: 'jupiter-malformed-terminal',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async (_request: unknown, _asset: unknown, nowMs: number) => ({
        ...candidate('jupiter-malformed-terminal', '100000000', nowMs + 10_000),
        transactionBase64: '%%%%',
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 10_000,
      }),
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, () => 1_000, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const events: string[] = [];
    const unsubscribe = desk.subscribe(created.id, (session) => events.push(session.state));
    const failed = await desk.collectNow(created.id, 1_100);
    unsubscribe();
    expect(failed.state).toBe('failed');
    expect(events.filter((state) => ['winner_ready', 'no_quote', 'expired', 'failed'].includes(state))).toEqual(['failed']);
  });

  it('uses sender commitment evidence verbatim in receipts', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const evidence = { signature: 'chain-signature', submittedAtMs: 1_310, confirmedAtMs: 1_322, finalizedAtMs: 1_344, commitment: 'finalized' as const };
    const sender = { execute: async () => evidence, send: async () => evidence };
    const source = {
      id: 'jupiter-chain-evidence',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async () => ({ ...candidate('jupiter-chain-evidence', '100000000', 10_000), createdAtMs: 1_000 }),
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    await desk.collectNow(created.id, 1_100);
    const result = await reviewAuthorizeExecute(desk, created.id, TEST_WALLET, 1_300);
    expect(result.receipt).toMatchObject({ signature: 'chain-signature', submittedAtMs: 1_310, confirmedAtMs: 1_322, finalizedAtMs: 1_344, commitment: 'finalized' });
  });

  it('rejects contradictory sender commitment evidence', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance(TEST_WALLET, asset.mint, '2500000');
    const sender = {
      execute: async () => ({ signature: 'contradictory-signature', submittedAtMs: 1_310, confirmedAtMs: 1_322, finalizedAtMs: 1_344, commitment: 'confirmed' as const }),
      send: async () => ({ signature: 'contradictory-signature', submittedAtMs: 1_310, confirmedAtMs: 1_322, finalizedAtMs: 1_344, commitment: 'confirmed' as const }),
    };
    const source = {
      id: 'jupiter-contradictory-evidence',
      kind: 'jupiter' as const,
      settlementRoute: 'generic-spl' as const,
      reliabilityBps: 9_000,
      quote: async () => ({ ...candidate('jupiter-contradictory-evidence', '100000000', 10_000), createdAtMs: 1_000 }),
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    await desk.collectNow(created.id, 1_100);
    await expect(reviewAuthorizeExecute(desk, created.id, TEST_WALLET, 1_300)).rejects.toThrow('finalization evidence with confirmed commitment');
    expect(desk.getSession(created.id, 1_300).state).toBe('failed');
  });

  it('purges executable bytes at expiry without a follow-up request', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const provider = new MemoryAssetProvider([asset]);
      provider.setBalance(TEST_WALLET, asset.mint, '2500000');
      const sender = new RecordingSender();
      const source = {
        id: 'jupiter-expiry-purge',
        kind: 'jupiter' as const,
        settlementRoute: 'generic-spl' as const,
        reliabilityBps: 9_000,
        quote: async (_request: unknown, _asset: unknown, nowMs: number) => ({ ...candidate('jupiter-expiry-purge', '100000000', nowMs + 5_000), createdAtMs: nowMs, expiresAtMs: nowMs + 5_000 }),
      };
      const desk = new QuoteDeskService(provider, [source], sender, sender, Date.now, new MockQuoteSimulationProvider());
      const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' });
      const ready = await desk.collectNow(created.id);
      expect(ready.state).toBe('winner_ready');
      expect(ready.winner?.transactionBase64).toBeDefined();
      vi.advanceTimersByTime(3_001);
      const expired = desk.getSession(created.id);
      expect(expired.state).toBe('expired');
      expect(expired.winner?.transactionBase64).toBeUndefined();
      expect(expired.winner?.transactionHash).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires authorization before execution and expires the issued payload at the safety margin', async () => {
    const provider = new MemoryAssetProvider(demoAssets);
    provider.setBalance(TEST_WALLET, demoAssets[0].mint, '2500000');
    const sender = new RecordingSender();
    const desk = new QuoteDeskService(provider, [new JupiterStubSource()], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: demoAssets[0].mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_100);
    await expect(desk.createExecutionAttempt({ quoteSprintId: created.id, idempotencyKey: 'early' }, 1_200)).rejects.toThrow('authorization');
    const mutated = Buffer.from(ready.winner!.transactionBase64!, 'base64');
    mutated[mutated.length - 1] ^= 1;
    await expect(desk.authorize(created.id, TEST_WALLET, ready.winner!.transactionHash!, base64FromBytes(Uint8Array.from(mutated)), 1_200)).rejects.toThrow();
    const expired = desk.getSession(created.id, ready.winner!.expiresAtMs - 2_000);
    expect(expired.state).toBe('expired');
    expect(expired.winner?.transactionBase64).toBeUndefined();
  });

  it('authorizes identical frozen v0 private-maker bytes and rejects mock sender evidence', async () => {
    const provider = new MemoryAssetProvider([demoAssets[0]]);
    provider.setBalance(TEST_WALLET, demoAssets[0].mint, '2500000');
    const sourceBalances = new MemorySourceBalanceProvider();
    sourceBalances.setBalance('maker-sandbox-01', SOLANA_USDC_MINT, '1000000000');
    const maker = new HeadlessPrivateMakerSource();
    const rejectMock = {
      execute: async () => ({ signature: 'mock-private-maker-x', submittedAtMs: 2_000, confirmedAtMs: 2_001, finalizedAtMs: 2_002, commitment: 'finalized' as const }),
      send: async () => ({ signature: 'mock-private-maker-x', submittedAtMs: 2_000, confirmedAtMs: 2_001, finalizedAtMs: 2_002, commitment: 'finalized' as const }),
    };
    const desk = new QuoteDeskService(provider, [maker], rejectMock, rejectMock, Date.now, new MockQuoteSimulationProvider(), sourceBalances);
    observeGovernedLocalMakers(desk, [maker]);
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: demoAssets[0].mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_100);
    expect(ready.state).toBe('winner_ready');
    const signed = sellerSignTransaction(ready.winner!.transactionBase64!);
    const authorized = await desk.authorize(created.id, TEST_WALLET, ready.winner!.transactionHash!, signed, 1_200);
    expect(authorized.state).toBe('authorized');
    await expect(desk.createExecutionAttempt({ quoteSprintId: created.id, idempotencyKey: 'mock-guard' }, 1_300)).rejects.toThrow('mock signature');

    const honest = new RecordingSender();
    const maker2 = new HeadlessPrivateMakerSource();
    const desk2 = new QuoteDeskService(provider, [maker2], honest, honest, Date.now, new MockQuoteSimulationProvider(), sourceBalances);
    observeGovernedLocalMakers(desk2, [maker2]);
    const created2 = await desk2.createSession({ wallet: TEST_WALLET, inputMint: demoAssets[0].mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    await desk2.collectNow(created2.id, 1_100);
    const result = await reviewAuthorizeExecute(desk2, created2.id, TEST_WALLET, 1_300, 'honest');
    expect(result.receipt?.signature.startsWith('mock-')).toBe(false);
    expect(encodeBase58(localMakerPublicKey()).length).toBeGreaterThan(30);
  });

  it('keeps Jupiter stub fee at zero with unchanged message bytes', async () => {
    const provider = new MemoryAssetProvider([demoAssets[0]]);
    provider.setBalance(TEST_WALLET, demoAssets[0].mint, '2500000');
    const sender = new RecordingSender();
    const desk = new QuoteDeskService(provider, [new JupiterStubSource()], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: TEST_WALLET, inputMint: demoAssets[0].mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_100);
    expect(ready.winner?.sourceKind).toBe('jupiter');
    expect(ready.winner?.katonFeeBps).toBe(0);
    expect(ready.winner?.katonFeeAtomic).toBe('0');
    const issued = ready.winner!.transactionBase64!;
    const signed = sellerSignTransaction(issued);
    expect(() => assertJupiterPayloadUnchanged(issued, signed)).not.toThrow();
    await desk.authorize(created.id, TEST_WALLET, ready.winner!.transactionHash!, signed, 1_200);
    const result = await desk.createExecutionAttempt({ quoteSprintId: created.id, idempotencyKey: 'jup' }, 1_300);
    expect(result.receipt?.katonFeeAtomic).toBe('0');
  });
});
