import { describe, expect, it } from 'vitest';
import {
  validateFccArtifactManifest,
  validateProductionServiceConfig,
  validateVenueConformanceManifest,
  validateVenueVerificationManifest,
} from '../tools/release-evidence.mjs';

describe('Flare release gate input contracts', () => {
  it('documents the critical value formats enforced by the release validator', () => {
    expect(/^https:\/\//.test('https://fdc.example')).toBe(true);
    expect(/^https:\/\//.test('http://fdc.example')).toBe(false);
    expect(/^0x[0-9a-fA-F]{40}$/.test(`0x${'1'.repeat(40)}`)).toBe(true);
    expect(/^0x[0-9a-fA-F]{64}$/.test(`0x${'2'.repeat(64)}`)).toBe(true);
  });

  it('requires a reproducible FCC artifact manifest to match the attested hash', () => {
    const valid = {
      artifact: 'fcc-matcher',
      sha256: `0x${'a'.repeat(64)}`,
      sourceSha256: `0x${'b'.repeat(64)}`,
      sourceDateEpoch: 1_700_000_000,
      reproducibleBuild: true,
      cgoEnabled: false,
      mode: 'simulated-until-real-attestation',
    };
    expect(validateFccArtifactManifest(valid, valid.sha256)).toEqual([]);
    expect(validateFccArtifactManifest({ ...valid, sha256: `0x${'c'.repeat(64)}` }, valid.sha256)).toContain('FCC_ARTIFACT_HASH_MISMATCH');
    expect(validateFccArtifactManifest({ ...valid, cgoEnabled: true }, valid.sha256)).toContain('FCC_ARTIFACT_CGO_ENABLED');
  });

  it('requires RPC-verified provenance on venue manifests', () => {
    const valid = {
      chainId: 114,
      verifiedAt: '2026-08-13T00:00:00.000Z',
      verificationMethod: 'rpc-bytecode-keccak256',
      venues: [{
        venue: 'Kinetic',
        address: `0x${'1'.repeat(40)}`,
        bytecodeHash: `0x${'2'.repeat(64)}`,
        supportedAssets: ['USDX'],
        verifiedReference: 'fixture',
        verifiedAtChainId: 114,
      }],
    };
    expect(validateVenueVerificationManifest(valid)).toEqual([]);
    expect(validateVenueVerificationManifest({ ...valid, verificationMethod: 'manual' })).toContain('VENUE_VERIFICATION_METHOD');
    expect(validateVenueVerificationManifest({ ...valid, venues: [{ ...valid.venues[0], verifiedAtChainId: 14 }] }).some((error) => error.startsWith('VENUE_VERIFICATION_CHAIN'))).toBe(true);
  });

  it('only accepts mainnet-fork venue conformance after every required case actually passed', () => {
    const baseCases = [
      'deposit', 'accrual-read', 'withdrawal', 'pause', 'zero-liquidity', 'revert',
      'rounding-loss', 'binding-rejection', 'liquidation-success', 'healthy-rejection',
      'close-factor-rejection', 'shortfall-rejection', 'approval-residue',
      'recipient-mismatch', 'atomic-rollback',
    ].map((name) => ({ name, result: 'pass', elapsedMs: 1 }));
    const valid = {
      venue: 'Kinetic',
      chainId: 14,
      forkBlock: 63_000_000,
      execution: 'fork',
      rpcUrl: 'https://flare-api.flare.network/ext/C/rpc',
      authoritativeReference: 'https://docs.kinetic.market/contracts-and-api-documentation',
      executedAt: '2026-08-13T00:00:00.000Z',
      testCommand: 'forge test --match-contract KineticMainnetForkTest',
      cases: baseCases,
    };

    expect(validateVenueConformanceManifest(valid)).toEqual([]);
    expect(validateVenueConformanceManifest({ ...valid, forkBlock: 0 })).toContain('VENUE_CONFORMANCE_FORK_BLOCK');
    expect(validateVenueConformanceManifest({
      ...valid,
      cases: baseCases.map((entry) => entry.name === 'withdrawal' ? { ...entry, result: 'fail' } : entry),
    })).toContain('VENUE_CONFORMANCE_CASE_NOT_PASS:withdrawal');
    expect(validateVenueConformanceManifest({
      ...valid,
      cases: baseCases.filter((entry) => entry.name !== 'atomic-rollback'),
    })).toContain('VENUE_CONFORMANCE_CASE_MISSING:atomic-rollback');
    expect(validateVenueConformanceManifest({ ...valid, venue: 'Clearpool' }).some((error) => error.includes('liquidation'))).toBe(false);
  });

  it('requires production persistence, TLS, auth, and all keeper sources', () => {
    const valid = {
      FLARE_API_AUTH_REQUIRED: 'true',
      FLARE_BOT_MTLS_REQUIRED: 'true',
      FLARE_API_TLS_CERT_FILE: '/run/secrets/api.crt',
      FLARE_API_TLS_KEY_FILE: '/run/secrets/api.key',
      FLARE_API_TLS_CA_FILE: '/run/secrets/ca.crt',
      FLARE_MONGO_URL: 'mongodb+srv://managed.example/trustrfq',
      FLARE_INDEXER_MONGO_URL: 'mongodb+srv://managed.example/trustrfq',
      FLARE_INDEXER_REDIS_URL: 'rediss://managed.example',
      FLARE_KEEPER_REDIS_URL: 'rediss://managed.example',
      FLARE_KEEPER_REQUIRE_JOB_SOURCES: 'true',
      FLARE_FCC_MODE: 'real',
      FLARE_FCC_QUORUM_VERIFIER: '0x1111111111111111111111111111111111111111',
      ...Object.fromEntries(['AUCTION_EXPIRY', 'LIQUIDATION_DETECTION', 'FDC_PROGRESSION', 'REDEMPTION_SETTLEMENT', 'WITHDRAWAL_QUEUE'].flatMap((kind) => [
        [`FLARE_KEEPER_${kind}_DUE_URL`, `https://keeper.example/${kind}/due`],
        [`FLARE_KEEPER_${kind}_RUN_URL`, `https://keeper.example/${kind}/run`],
      ])),
    };
    expect(validateProductionServiceConfig(valid)).toEqual([]);
    expect(validateProductionServiceConfig({ ...valid, FLARE_KEEPER_REQUIRE_JOB_SOURCES: 'false' })).toContain('KEEPER_JOB_SOURCES_REQUIRED');
    expect(validateProductionServiceConfig({ ...valid, FLARE_API_TLS_CA_FILE: undefined })).toContain('API_MTLS_CA_REQUIRED');
    expect(validateProductionServiceConfig({ ...valid, FLARE_FCC_MODE: 'simulated' })).toContain('FCC_MODE_REAL_REQUIRED');
    expect(validateProductionServiceConfig({ ...valid, FLARE_FCC_QUORUM_VERIFIER: undefined })).toContain('FCC_QUORUM_VERIFIER_REQUIRED');
    expect(validateProductionServiceConfig({
      ...valid,
      FLARE_FCC_QUORUM_VERIFIER: '0x0000000000000000000000000000000000000001',
    })).toContain('FCC_QUORUM_VERIFIER_DUMMY');
  });

  it('keeps local/demo release checks separate from the production profile', () => {
    expect(process.env.FLARE_RELEASE_PROFILE ?? 'local').not.toBe('production');
  });
});
