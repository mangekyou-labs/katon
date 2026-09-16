import { generateKeyPairSync, sign as signManifest } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  atomicToDecimal,
  decimalToAtomic,
  evaluateEligibility,
  floorFee,
  effectivePriceAtomic,
  assertJupiterPayloadUnchanged,
  rankExecutableCandidates,
  SOLANA_USDC_MINT,
  SOLANA_USDT_MINT,
  type AssetRegistryEntry,
  type MintAccountSnapshot,
  type QuoteCandidate,
} from '../packages/solana-core/src/index';
import { LiquidationCircuitBreaker, LiquidationSolver, chooseFundingSource, requiresZeroResidualStock } from '../services/solana-liquidator/src/index';
import { deploymentManifestPayload, DeploymentManifestGate, verifyDeploymentManifest, MAINNET_PROGRAM_IDS, KaminoLendAdapter, verifyDiscoveredMarkets, type DeploymentManifest, type RuntimeProgramState, type DiscoveredMarket, type LendingPosition } from '../services/solana-liquidator/src/index';
import { MemoryAssetProvider, MockQuoteSimulationProvider, QuoteDeskService } from '../apps/solana-api/src/service';
import { MemorySourceBalanceProvider, MockJupiterSource, MockPrivateMakerSource, MockSender } from '../apps/solana-api/src/sources';
import { demoAssets } from '../apps/solana-api/src/registry';
import { base64FromBytes, transactionHash, validateSignedTransaction, WalletStandardAdapter } from '../packages/solana-sdk/src/index';

const asset: AssetRegistryEntry = {
  mint: 'stock-mint', issuer: 'xstocks', ticker: 'AAPLx', underlyingTicker: 'AAPL', tokenProgram: 'token-2022', decimals: 6,
  extensionFingerprint: 'metadata-pointer|active|scaled|none|none|no-memo', capabilities: { transferHook: false, pausable: true, scaledUiAmount: true, transferFee: false, permanentDelegate: false, memoTransfer: false, confidentialTransfer: false }, supportedOutputs: [SOLANA_USDC_MINT, SOLANA_USDT_MINT], referenceState: 'open', referencePriceAtomic: '100000000', referencePriceDecimals: 6, maxDeviationBps: 150, enabled: true, registryVersion: 1,
};
const mint: MintAccountSnapshot = { mint: asset.mint, ownerProgram: asset.tokenProgram, decimals: asset.decimals, extensionFingerprint: asset.extensionFingerprint, extensions: ['metadata-pointer', 'pausable', 'scaled-ui-amount'], paused: false, metadataPointer: asset.mint, scaledUiAmountEnabled: true, memoTransferRequired: false };

function candidate(sourceId: string, net: string, expiresAtMs = 20_000): QuoteCandidate {
  return { quoteId: sourceId, sourceId, sourceKind: sourceId.startsWith('maker') ? 'private-maker' : 'jupiter', router: sourceId, wallet: 'wallet', inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', grossOutputAtomic: net, katonFeeAtomic: '0', venueFeeAtomic: '0', netOutputAtomic: net, createdAtMs: 0, expiresAtMs, reliabilityBps: 9_000, transactionVersion: 'v0', transactionBase64: 'AQ==', simulation: { ok: true, simulatedAtMs: 0 } };
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

  it('fails closed on unsupported or changed mint state', () => {
    expect(evaluateEligibility({ entry: asset, mint: { ...mint, extensions: ['metadata-pointer', 'confidential-transfer'] }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('unknown');
    expect(evaluateEligibility({ entry: asset, mint: { ...mint, paused: true }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('ineligible');
    expect(evaluateEligibility({ entry: asset, mint: { ...mint, metadataPointer: undefined }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('unknown');
    expect(evaluateEligibility({ entry: asset, mint: { ...mint, memoTransferRequired: true }, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('unknown');
    expect(evaluateEligibility({ entry: asset, mint, walletBalanceAtomic: '100', outputMint: 'fake-stable' }).code).toBe('unsupported_output');
    const classicAsset: AssetRegistryEntry = { ...asset, mint: 'classic-stock', tokenProgram: 'spl-token', extensionFingerprint: 'active|unscaled|none|none|no-memo', capabilities: { ...asset.capabilities, pausable: false, scaledUiAmount: false } };
    const classicMint: MintAccountSnapshot = { ...mint, mint: classicAsset.mint, ownerProgram: 'spl-token', extensionFingerprint: classicAsset.extensionFingerprint, extensions: [], metadataPointer: undefined, scaledUiAmountEnabled: false, memoTransferRequired: false };
    expect(evaluateEligibility({ entry: classicAsset, mint: classicMint, walletBalanceAtomic: '100', outputMint: SOLANA_USDC_MINT }).status).toBe('eligible');
    const classicProvider = new MemoryAssetProvider([classicAsset]);
    expect(classicProvider.mintSnapshot(classicAsset).extensions).toEqual([]);
    expect(classicProvider.mintSnapshot(classicAsset).metadataPointer).toBeUndefined();
  });

  it('ranks net output, validity, reliability and source id deterministically', () => {
    const verifiedSourceBalances = { 'maker-a': verifiedSourceBalance('maker-a', '1000'), 'maker-b': verifiedSourceBalance('maker-b', '1000') };
    const result = rankExecutableCandidates({ candidates: [candidate('maker-b', '1000'), candidate('maker-a', '1000', 30_000), candidate('jupiter', '9999')], nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', verifiedSourceBalances });
    expect(result.winner?.sourceId).toBe('jupiter');
    expect(result.audit).toHaveLength(3);
    expect(rankExecutableCandidates({ candidates: [candidate('maker-b', '1000'), candidate('maker-a', '1000')], nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', verifiedSourceBalances }).winner?.sourceId).toBe('maker-a');
    expect(rankExecutableCandidates({ candidates: [{ ...candidate('bad-sim', '5000'), simulation: { ok: false, errorCode: 'slippage', simulatedAtMs: 0 } }, { ...candidate('bad-fee', '5000'), grossOutputAtomic: '4', katonFeeAtomic: '3', venueFeeAtomic: '3' }, { ...candidate('bad-band', '9000'), deviationBps: 999 }, candidate('too-long', '8000', 31_000)], nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', maxDeviationBps: 150 }).audit.map((row) => row.rejectionCode)).toEqual(['failed_simulation', 'malformed_quote', 'price_band', 'malformed_quote']);
  });

  it('fails closed when a private maker lacks independently verified liquidity', () => {
    const quote = candidate('maker-unverified', '1000');
    expect(rankExecutableCandidates({ candidates: [quote], nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' })).toMatchObject({ winner: undefined, audit: [{ rejectionCode: 'insufficient_liquidity', status: 'rejected' }] });
    expect(rankExecutableCandidates({ candidates: [quote], nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', verifiedSourceBalances: { 'maker-unverified': verifiedSourceBalance('maker-unverified', '999') } })).toMatchObject({ winner: undefined, audit: [{ rejectionCode: 'insufficient_liquidity', status: 'rejected' }] });
    expect(rankExecutableCandidates({ candidates: [quote], nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', verifiedSourceBalances: { 'maker-unverified': verifiedSourceBalance('maker-unverified', '1000', 4_000) } })).toMatchObject({ winner: undefined, audit: [{ rejectionCode: 'source_error', status: 'rejected' }] });
    expect(rankExecutableCandidates({ candidates: [quote], nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', verifiedSourceBalances: { 'maker-unverified': { ...verifiedSourceBalance('maker-unverified', '1000'), outputMint: SOLANA_USDT_MINT } } })).toMatchObject({ winner: undefined, audit: [{ rejectionCode: 'insufficient_liquidity', status: 'rejected' }] });
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
    expect(() => rankExecutableCandidates({ candidates: malformed, nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', maxDeviationBps: 150 })).not.toThrow();
    expect(rankExecutableCandidates({ candidates: malformed, nowMs: 0, inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000', maxDeviationBps: 150 }).audit.map((row) => row.rejectionCode)).toEqual([
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
    provider.setBalance('wallet', asset.mint, '2500000');
    const sender = new MockSender();
    const delayedSource = {
      id: 'jupiter-delayed',
      kind: 'jupiter' as const,
      reliabilityBps: 9_900,
      quote: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return candidate('jupiter-delayed', '1000', 4_000);
      },
    };
    const desk = new QuoteDeskService(provider, [delayedSource], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: 'wallet', inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const collected = await desk.collectNow(created.id, 2_500);
    expect(collected.state).toBe('no_quote');
    expect(collected.audit.some((row) => row.rejectionCode === 'expired')).toBe(true);
  });

  it('refreshes the clock after collection when collectNow has no pinned time', async () => {
    let nowMs = 1_000;
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance('wallet', asset.mint, '2500000');
    const sender = new MockSender();
    const delayedSource = {
      id: 'jupiter-clock-refresh',
      kind: 'jupiter' as const,
      reliabilityBps: 9_900,
      quote: async () => {
        await Promise.resolve();
        nowMs = 2_500;
        return candidate('jupiter-clock-refresh', '1000', 4_000);
      },
    };
    const desk = new QuoteDeskService(provider, [delayedSource], sender, sender, () => nowMs, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: 'wallet', inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' });
    const collected = await desk.collectNow(created.id);
    expect(collected.state).toBe('no_quote');
    expect(collected.audit.some((row) => row.rejectionCode === 'expired')).toBe(true);
  });

  it('binds the Solana message while allowing wallet signatures to change', async () => {
    const issued = new Uint8Array(1 + 64 + 3);
    issued[0] = 1;
    issued[65] = 0x80;
    issued[66] = 1;
    issued[67] = 2;
    const signed = issued.slice();
    signed[1] = 9;
    const issuedBase64 = base64FromBytes(issued);
    const signedBase64 = base64FromBytes(signed);
    const hash = await transactionHash(issuedBase64);
    expect(await transactionHash(signedBase64)).toBe(hash);
    expect(await validateSignedTransaction(signedBase64, { wallet: 'wallet', issuedTransactionHash: hash, issuedQuoteId: 'quote', expiresAtMs: 10_000 }, 1_000)).toMatchObject({ ok: true });
    expect(() => assertJupiterPayloadUnchanged(issuedBase64, signedBase64)).not.toThrow();
    const changed = signed.slice(); changed[67] = 3;
    expect(await validateSignedTransaction(base64FromBytes(changed), { wallet: 'wallet', issuedTransactionHash: hash, issuedQuoteId: 'quote', expiresAtMs: 10_000 }, 1_000)).toMatchObject({ ok: false, code: 'hash_mismatch' });
  });

  it('prefers flashloan, caps prefunded fallback, and trips after three landing failures', () => {
    const base = { id: 'opp', collateralMint: asset.mint, debtMint: 'native-usdc', debtAtomic: '100000000', collateralAtomic: '1000000', expectedGrossOutputAtomic: '110000000', expectedCostsAtomic: '5000000', expectedProfitAtomic: '10500000', expectedProfitBps: 105, healthFreshAtMs: Date.now(), atomicUnwind: true, computeUnits: 500_000, route: candidate('jupiter', '110000000') };
    expect(chooseFundingSource(base, '100000000', { nowMs: () => Date.now() }).funding).toBe('jupiter-flashloan');
    expect(chooseFundingSource(base, '0', { nowMs: () => Date.now() }).funding).toBe('prefunded-usdc');
    expect(requiresZeroResidualStock('100', '0')).toBe(true);
    const breaker = new LiquidationCircuitBreaker(); breaker.recordLandingFailure(); breaker.recordLandingFailure(); expect(breaker.snapshot().halted).toBe(false); breaker.recordLandingFailure(); expect(breaker.snapshot().halted).toBe(true);
    expect(breaker.recordAdverseExecution(26).halted).toBe(true);
    expect(chooseFundingSource({ ...base, route: { ...base.route!, router: 'jupiterz-managed' } }, '100000000', { nowMs: () => Date.now() }).reason).toBe('managed_transaction');
  });

  it('keeps the liquidation solver dormant until a deployment manifest gate passes', async () => {
    const opportunity = { id: 'opp', collateralMint: asset.mint, debtMint: 'native-usdc', debtAtomic: '100000000', collateralAtomic: '1000000', expectedGrossOutputAtomic: '110000000', expectedCostsAtomic: '5000000', expectedProfitAtomic: '10500000', expectedProfitBps: 105, healthFreshAtMs: 1_000, atomicUnwind: true, computeUnits: 500_000, route: candidate('jupiter', '110000000') };
    const solver = new LiquidationSolver(new LiquidationCircuitBreaker(), { nowMs: () => 1_000 });
    const result = await solver.prepare(opportunity, '100000000', {
      build: async () => ({ transactionBase64: 'AQ==', messageHash: 'hash' }),
    }, {
      simulate: async () => ({ ok: true }),
    });
    expect(result.decision).toEqual({ executable: false, reason: 'manifest_mismatch' });
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
  });

  it('exposes a startup gate that the solver can require before preparation', async () => {
    const gate = new DeploymentManifestGate(manifest, runtime, [asset.mint], 'mainnet-beta', trustedSignerPublicKeys);
    expect(gate.check()).toEqual({ ok: true, message: 'runtime matches signed deployment manifest' });
    const opportunity = { id: 'opp', collateralMint: asset.mint, debtMint: 'native-usdc', debtAtomic: '100000000', collateralAtomic: '1000000', expectedGrossOutputAtomic: '110000000', expectedCostsAtomic: '5000000', expectedProfitAtomic: '10500000', expectedProfitBps: 105, healthFreshAtMs: 1_000, atomicUnwind: true, computeUnits: 500_000, route: candidate('jupiter', '110000000') };
    const result = await new LiquidationSolver(new LiquidationCircuitBreaker(), { nowMs: () => 1_000 }, gate).prepare(opportunity, '100000000', {
      build: async () => ({ transactionBase64: 'AQ==', messageHash: 'hash' }),
    }, {
      simulate: async () => ({ ok: true }),
    });
    expect(result.decision).toEqual({ executable: true, funding: 'jupiter-flashloan' });
  });
});

describe('lending adapters and registry discovery', () => {
  const market: DiscoveredMarket = { lender: 'kamino', programId: MAINNET_PROGRAM_IDS.kamino, marketAddress: 'market', reserveAddress: 'reserve', collateralMint: asset.mint, debtMint: SOLANA_USDC_MINT, oracleAddress: 'oracle', idlSha256: 'idl', upgradeAuthority: 'authority', observedAtMs: 1_000 };
  const position: LendingPosition = { obligationAddress: 'obligation', owner: 'owner', collateralMint: asset.mint, collateralAtomic: '100', debtMint: SOLANA_USDC_MINT, debtAtomic: '50', healthFactorBps: 9_900, observedAtMs: 1_000 };

  it('pins lender discovery and builds opaque authoritative instructions', async () => {
    const adapter = new KaminoLendAdapter(async () => [market]);
    expect(await adapter.discoverMarkets()).toEqual([market]);
    expect((await adapter.buildLiquidationInstruction(position, market)).authoritative).toBe(true);
    expect(verifyDiscoveredMarkets([market], [asset], 1_500).ok).toBe(true);
    expect(verifyDiscoveredMarkets([{ ...market, programId: 'unreviewed' }], [asset], 1_500).reason).toBe('unreviewed lender program');
    await expect(new KaminoLendAdapter(async () => [{ ...market, programId: 'unreviewed' }]).discoverMarkets()).rejects.toThrow('unreviewed');
  });
});

describe('Wallet Standard signer boundary', () => {
  it('maps connection state and signs only through signTransaction', async () => {
    const wallet = { name: 'Test', accounts: [{ address: 'wallet', chains: ['solana:mainnet'] }], connect: async () => undefined, signTransaction: async (bytes: Uint8Array) => { const signed = bytes.slice(); signed[0] = 7; return signed; } };
    const adapter = new WalletStandardAdapter(wallet);
    expect(await adapter.connect()).toBe('connected');
    expect(await adapter.sign('AQ==')).toBe('Bw==');
    await adapter.disconnect();
    expect(adapter.state).toBe('disconnected');
    const wrongCluster = new WalletStandardAdapter({ ...wallet, accounts: [{ address: 'wallet', chains: ['solana:devnet'] }] });
    expect(await wrongCluster.connect()).toBe('wrong-cluster');
  });
});

describe('local coordination seam', () => {
  it('replaces source simulation evidence with an independent transaction simulation', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance('wallet', asset.mint, '2500000');
    const sender = new MockSender();
    const source = {
      id: 'jupiter-untrusted-simulation',
      kind: 'jupiter' as const,
      reliabilityBps: 9_000,
      quote: async () => ({
        ...candidate('jupiter-untrusted-simulation', '1000'),
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
    const created = await desk.createSession({ wallet: 'wallet', inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_100);
    expect(ready.state).toBe('ready');
    expect(ready.winner?.simulation).toEqual({ ok: true, unitsConsumed: 123_000, simulatedAtMs: 1_000 });
    const reviewed = await desk.review(created.id, 'wallet', 1_200);
    expect(reviewed.winner?.simulation).toEqual({ ok: true, unitsConsumed: 123_000, simulatedAtMs: 1_200 });
  });

  it('bounds source collection, independent simulation, and balance checks to one sprint', async () => {
    let monotonicMs = 0;
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance('wallet', asset.mint, '2500000');
    const sender = new MockSender();
    const source = {
      id: 'maker-sprint-boundary',
      kind: 'private-maker' as const,
      reliabilityBps: 9_000,
      quote: async () => {
        monotonicMs = 2_500;
        return candidate('maker-sprint-boundary', '1000');
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
    const created = await desk.createSession({ wallet: 'wallet', inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const result = await desk.collectNow(created.id, 1_000);
    expect(result.state).toBe('no_quote');
    expect(result.audit).toMatchObject([{ rejectionCode: 'insufficient_liquidity', status: 'rejected' }]);
  });

  it('refreshes live timestamps between source collection and independent simulation', async () => {
    let nowMs = 1_000;
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance('wallet', asset.mint, '2500000');
    const sender = new MockSender();
    const source = {
      id: 'jupiter-live-clock',
      kind: 'jupiter' as const,
      reliabilityBps: 9_000,
      quote: async (_request: unknown, _asset: unknown, sourceNowMs: number) => {
        expect(sourceNowMs).toBe(1_000);
        nowMs = 1_100;
        return candidate('jupiter-live-clock', '1000');
      },
    };
    const independentSimulator = {
      simulate: async (_issuedCandidate: QuoteCandidate, simulationNowMs: number) => {
        expect(simulationNowMs).toBe(1_100);
        return { ok: true, unitsConsumed: 123_000, simulatedAtMs: simulationNowMs };
      },
    };
    const desk = new QuoteDeskService(provider, [source], sender, sender, () => nowMs, independentSimulator);
    const created = await desk.createSession({ wallet: 'wallet', inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' });
    const result = await desk.collectNow(created.id);
    expect(result.state).toBe('ready');
    expect(result.winner?.simulation.simulatedAtMs).toBe(1_100);
  });

  it('rejects source identity spoofing and ranks by adapter reliability', async () => {
    const provider = new MemoryAssetProvider([asset]);
    provider.setBalance('wallet', asset.mint, '2500000');
    const sender = new MockSender();
    const lowReliability = {
      id: 'jupiter-low',
      kind: 'jupiter' as const,
      reliabilityBps: 100,
      quote: async () => ({ ...candidate('jupiter-low', '1000'), reliabilityBps: 10_000 }),
    };
    const highReliability = {
      id: 'jupiter-high',
      kind: 'jupiter' as const,
      reliabilityBps: 9_000,
      quote: async () => ({ ...candidate('jupiter-high', '1000'), reliabilityBps: 0 }),
    };
    const spoofing = {
      id: 'jupiter-spoofing',
      kind: 'jupiter' as const,
      reliabilityBps: 9_000,
      quote: async () => candidate('jupiter-high', '1000'),
    };
    const desk = new QuoteDeskService(provider, [lowReliability, highReliability, spoofing], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: 'wallet', inputMint: asset.mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const result = await desk.collectNow(created.id, 1_100);
    expect(result.winner?.sourceId).toBe('jupiter-high');
    expect(result.audit.filter((row) => row.rejectionCode === 'source_error')).toHaveLength(1);
  });

  it('collects a winner, keeps losing payloads out of audit, and settles only the winner', async () => {
    const provider = new MemoryAssetProvider(demoAssets);
    provider.setBalance('wallet', demoAssets[0].mint, '2500000');
    const sender = new MockSender();
    const sourceBalances = new MemorySourceBalanceProvider();
    sourceBalances.setBalance('maker-sandbox-01', SOLANA_USDC_MINT, '1000000000');
    const desk = new QuoteDeskService(provider, [new MockJupiterSource(), new MockPrivateMakerSource()], sender, sender, Date.now, new MockQuoteSimulationProvider(), sourceBalances);
    const created = await desk.createSession({ wallet: 'wallet', inputMint: demoAssets[0].mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_500);
    expect(ready.state).toBe('ready');
    expect(ready.winner?.sourceKind).toBe('private-maker');
    expect(ready.winner?.effectivePriceAtomic).toBeDefined();
    expect(ready.winner?.priceImpactBps).toBe(1);
    expect(ready.audit.every((row) => !('sourceId' in row))).toBe(true);
    const reviewed = await desk.review(created.id, 'wallet', 1_600);
    expect(reviewed.state).toBe('reviewing');
    const receipt = await desk.execute(created.id, 'wallet', reviewed.winner!.transactionBase64!, 2_000);
    expect(receipt.sourceKind).toBe('private-maker');
    expect(desk.listTrades('wallet')).toHaveLength(1);
    expect(desk.getSession(created.id, 2_000).winner?.transactionBase64).toBeUndefined();
  });

  it('requires final review and expires the issued payload at the safety margin', async () => {
    const provider = new MemoryAssetProvider(demoAssets);
    provider.setBalance('wallet', demoAssets[0].mint, '2500000');
    const sender = new MockSender();
    const desk = new QuoteDeskService(provider, [new MockJupiterSource()], sender, sender, Date.now, new MockQuoteSimulationProvider());
    const created = await desk.createSession({ wallet: 'wallet', inputMint: demoAssets[0].mint, outputMint: SOLANA_USDC_MINT, inputAmountAtomic: '1000000' }, 1_000);
    const ready = await desk.collectNow(created.id, 1_100);
    await expect(desk.execute(created.id, 'wallet', ready.winner!.transactionBase64!, 1_200)).rejects.toThrow('final review');
    const expired = desk.getSession(created.id, ready.winner!.expiresAtMs - 2_000);
    expect(expired.state).toBe('expired');
    expect(expired.winner?.transactionBase64).toBeUndefined();
  });
});
