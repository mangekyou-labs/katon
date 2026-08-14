const HEX = (value, bytes) => typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value.trim());
const ADDRESS = (value) => HEX(value, 20) && !/^0x0{40}$/i.test(value.trim());
const NON_EMPTY = (value) => typeof value === 'string' && value.trim().length > 0;

export function validateFccArtifactManifest(manifest, expectedHash) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['FCC_ARTIFACT_MANIFEST_INVALID'];
  if (manifest.artifact !== 'fcc-matcher') errors.push('FCC_ARTIFACT_NAME');
  if (!HEX(manifest.sha256, 32)) errors.push('FCC_ARTIFACT_HASH');
  if (expectedHash && manifest.sha256?.toLowerCase() !== expectedHash.trim().toLowerCase()) errors.push('FCC_ARTIFACT_HASH_MISMATCH');
  if (!HEX(manifest.sourceSha256, 32)) errors.push('FCC_ARTIFACT_SOURCE_HASH');
  if (!Number.isSafeInteger(manifest.sourceDateEpoch) || manifest.sourceDateEpoch < 0) errors.push('FCC_ARTIFACT_SOURCE_DATE');
  if (manifest.reproducibleBuild !== true) errors.push('FCC_ARTIFACT_NOT_REPRODUCIBLE');
  if (manifest.cgoEnabled !== false) errors.push('FCC_ARTIFACT_CGO_ENABLED');
  if (manifest.mode !== 'simulated-until-real-attestation' && manifest.mode !== 'real-attested') errors.push('FCC_ARTIFACT_MODE');
  return errors;
}

export function validateVenueVerificationManifest(manifest, expectedChainId = manifest?.chainId) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || !Number.isInteger(manifest.chainId) || !Array.isArray(manifest.venues) || manifest.venues.length === 0) return ['VENUE_MANIFEST_INVALID'];
  if (manifest.chainId !== expectedChainId) errors.push('VENUE_MANIFEST_CHAIN');
  if (typeof manifest.verifiedAt !== 'string' || Number.isNaN(Date.parse(manifest.verifiedAt))) errors.push('VENUE_VERIFIED_AT');
  if (manifest.verificationMethod !== 'rpc-bytecode-keccak256') errors.push('VENUE_VERIFICATION_METHOD');
  for (const venue of manifest.venues) {
    if (!venue || !NON_EMPTY(venue.venue) || !ADDRESS(venue.address) || !HEX(venue.bytecodeHash, 32) || !NON_EMPTY(venue.verifiedReference)) {
      errors.push(`VENUE_ENTRY_INVALID:${venue?.venue ?? 'unknown'}`);
    }
    if (venue?.verifiedAtChainId !== manifest.chainId) errors.push(`VENUE_VERIFICATION_CHAIN:${venue?.venue ?? 'unknown'}`);
  }
  return errors;
}

const VENUE_CONFORMANCE_COMMON_CASES = [
  'deposit',
  'accrual-read',
  'withdrawal',
  'pause',
  'zero-liquidity',
  'revert',
  'rounding-loss',
  'binding-rejection',
];
const VENUE_CONFORMANCE_LIQUIDATION_CASES = [
  'liquidation-success',
  'healthy-rejection',
  'close-factor-rejection',
  'shortfall-rejection',
  'approval-residue',
  'recipient-mismatch',
  'atomic-rollback',
];

export function validateVenueConformanceManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return ['VENUE_CONFORMANCE_MANIFEST_INVALID'];
  const errors = [];
  const venues = new Set(['Morpho', 'Kinetic', 'Clearpool']);
  if (!venues.has(manifest.venue)) errors.push('VENUE_CONFORMANCE_VENUE');
  if (!Number.isInteger(manifest.chainId)) errors.push('VENUE_CONFORMANCE_CHAIN_ID');
  if (!Number.isInteger(manifest.forkBlock) || manifest.forkBlock < 0) errors.push('VENUE_CONFORMANCE_FORK_BLOCK');
  if (!NON_EMPTY(manifest.authoritativeReference)) errors.push('VENUE_CONFORMANCE_REFERENCE');
  if (manifest.execution !== 'fork' && manifest.execution !== 'interface-mock') errors.push('VENUE_CONFORMANCE_EXECUTION');
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    errors.push('VENUE_CONFORMANCE_CASES');
    return errors;
  }

  if (manifest.execution === 'fork') {
    if (manifest.chainId !== 14) errors.push('VENUE_CONFORMANCE_MAINNET_CHAIN');
    if (!Number.isInteger(manifest.forkBlock) || manifest.forkBlock <= 0) errors.push('VENUE_CONFORMANCE_FORK_BLOCK');
    if (!httpsUrl(manifest.rpcUrl)) errors.push('VENUE_CONFORMANCE_RPC');
    if (!NON_EMPTY(manifest.executedAt) || Number.isNaN(Date.parse(manifest.executedAt))) errors.push('VENUE_CONFORMANCE_EXECUTED_AT');
    if (!NON_EMPTY(manifest.testCommand)) errors.push('VENUE_CONFORMANCE_TEST_COMMAND');
  }

  const cases = new Map();
  for (const entry of manifest.cases) {
    if (!entry || !NON_EMPTY(entry.name)) {
      errors.push('VENUE_CONFORMANCE_CASE_INVALID');
      continue;
    }
    if (cases.has(entry.name)) errors.push(`VENUE_CONFORMANCE_CASE_DUPLICATE:${entry.name}`);
    cases.set(entry.name, entry);
  }
  const required = [
    ...VENUE_CONFORMANCE_COMMON_CASES,
    ...(manifest.execution === 'fork' && manifest.venue !== 'Clearpool' ? VENUE_CONFORMANCE_LIQUIDATION_CASES : []),
  ];
  for (const name of required) {
    const entry = cases.get(name);
    if (!entry) {
      errors.push(`VENUE_CONFORMANCE_CASE_MISSING:${name}`);
      continue;
    }
    if (entry.result !== 'pass') errors.push(`VENUE_CONFORMANCE_CASE_NOT_PASS:${name}`);
    if (manifest.execution === 'fork' && (!Number.isFinite(entry.elapsedMs) || entry.elapsedMs < 0)) {
      errors.push(`VENUE_CONFORMANCE_CASE_ELAPSED:${name}`);
    }
  }
  return [...new Set(errors)];
}

const KEEPER_KINDS = ['AUCTION_EXPIRY', 'LIQUIDATION_DETECTION', 'FDC_PROGRESSION', 'REDEMPTION_SETTLEMENT', 'WITHDRAWAL_QUEUE'];
const httpsUrl = (value) => typeof value === 'string' && value.startsWith('https://') && value.length > 8;

export function validateProductionServiceConfig(environment) {
  return [
    ...validateProductionApiConfig(environment),
    ...validateProductionIndexerConfig(environment),
    ...validateProductionKeeperConfig(environment),
    ...validateProductionFccConfig(environment),
  ];
}

/** Production must use real FCC attestation and a non-zero quorum verifier. */
export function validateProductionFccConfig(environment) {
  const errors = [];
  if (environment.FLARE_FCC_MODE !== 'real') errors.push('FCC_MODE_REAL_REQUIRED');
  if (!ADDRESS(environment.FLARE_FCC_QUORUM_VERIFIER)) errors.push('FCC_QUORUM_VERIFIER_REQUIRED');
  const verifier = typeof environment.FLARE_FCC_QUORUM_VERIFIER === 'string'
    ? environment.FLARE_FCC_QUORUM_VERIFIER.trim().toLowerCase()
    : '';
  if (verifier.includes('dummy') || verifier === '0x0000000000000000000000000000000000000001') {
    errors.push('FCC_QUORUM_VERIFIER_DUMMY');
  }
  if (environment.FLARE_FCC_ALLOW_SIMULATED === 'true') errors.push('FCC_SIMULATED_FORBIDDEN');
  return errors;
}

export function validateProductionApiConfig(environment) {
  const errors = [];
  if (environment.FLARE_API_AUTH_REQUIRED !== 'true') errors.push('API_AUTH_REQUIRED');
  if (environment.FLARE_BOT_MTLS_REQUIRED !== 'true') errors.push('API_MTLS_REQUIRED');
  if (!NON_EMPTY(environment.FLARE_API_TLS_CERT_FILE) || !NON_EMPTY(environment.FLARE_API_TLS_KEY_FILE)) errors.push('API_TLS_CERT_KEY_REQUIRED');
  if (!NON_EMPTY(environment.FLARE_API_TLS_CA_FILE)) errors.push('API_MTLS_CA_REQUIRED');
  if (!NON_EMPTY(environment.FLARE_MONGO_URL)) errors.push('API_MONGO_REQUIRED');
  return errors;
}

export function validateProductionIndexerConfig(environment) {
  const errors = [];
  if (!NON_EMPTY(environment.FLARE_INDEXER_MONGO_URL)) errors.push('INDEXER_MONGO_REQUIRED');
  if (!NON_EMPTY(environment.FLARE_INDEXER_REDIS_URL) || !environment.FLARE_INDEXER_REDIS_URL.startsWith('rediss://')) errors.push('INDEXER_REDIS_TLS_REQUIRED');
  return errors;
}

export function validateProductionKeeperConfig(environment) {
  const errors = [];
  if (!NON_EMPTY(environment.FLARE_KEEPER_REDIS_URL) || !environment.FLARE_KEEPER_REDIS_URL.startsWith('rediss://')) errors.push('KEEPER_REDIS_TLS_REQUIRED');
  if (environment.FLARE_KEEPER_REQUIRE_JOB_SOURCES !== 'true') errors.push('KEEPER_JOB_SOURCES_REQUIRED');
  for (const kind of KEEPER_KINDS) {
    if (!httpsUrl(environment[`FLARE_KEEPER_${kind}_DUE_URL`]) || !httpsUrl(environment[`FLARE_KEEPER_${kind}_RUN_URL`])) errors.push(`KEEPER_JOB_SOURCE_MISSING:${kind}`);
  }
  return errors;
}

export function validateGovernanceManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || !Number.isInteger(manifest.chainId) || !ADDRESS(manifest.multisig) || !ADDRESS(manifest.guardian) || !Number.isInteger(manifest.timelockDelaySeconds) || manifest.timelockDelaySeconds < 172_800) return ['GOVERNANCE_MANIFEST_CORE_INVALID'];
  if (!Array.isArray(manifest.upgradeable) || manifest.upgradeable.length === 0 || manifest.upgradeable.some((entry) => !entry?.name || !ADDRESS(entry.proxy) || !ADDRESS(entry.implementation) || !ADDRESS(entry.proxyAdmin) || !HEX(entry.storageLayoutHash, 32))) errors.push('GOVERNANCE_MANIFEST_UPGRADEABLE_INVALID');
  if (!Array.isArray(manifest.immutable) || manifest.immutable.length === 0 || manifest.immutable.some((entry) => !entry?.name || !ADDRESS(entry.address) || !HEX(entry.bytecodeHash, 32) || !Number.isInteger(entry.version) || entry.version < 1)) errors.push('GOVERNANCE_MANIFEST_IMMUTABLE_INVALID');
  if (!Array.isArray(manifest.migrations) || manifest.migrations.some((entry) => !entry?.fromVersion || !entry?.toVersion || entry.voluntary !== true)) errors.push('GOVERNANCE_MANIFEST_MIGRATION_INVALID');
  if (manifest.bootstrap === true && manifest.governanceStatus !== 'production-approved') errors.push('GOVERNANCE_BOOTSTRAP_NOT_PRODUCTION');
  return errors;
}
