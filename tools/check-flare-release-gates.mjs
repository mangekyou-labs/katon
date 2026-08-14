import { existsSync, readFileSync } from 'node:fs';
import { validateFccArtifactManifest, validateGovernanceManifest, validateProductionServiceConfig, validateVenueVerificationManifest } from './release-evidence.mjs';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const hex = (value, bytes) => typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value.trim());
const address = (value) => hex(value, 20) && !/^0x0{40}$/i.test(value.trim());
const url = (value) => {
  if (!nonEmpty(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const required = [
  ['FLARE_FDC_VERIFIER_URL', 'credentialed FDC verifier URL'],
  ['FLARE_FDC_DA_URL', 'credentialed FDC data-availability URL'],
  ['FLARE_FDC_API_KEY', 'FDC verifier API key'],
  ['FCC_MATCHER_CODE_HASH', 'attested FCC code hash'],
  ['FCC_MATCHER_OWNER', 'attested FCC owner'],
  ['FCC_MATCHER_PLATFORM_MEASUREMENT', 'attested FCC platform measurement'],
  ['FCC_MATCHER_ARTIFACT_SHA256', 'reproducible FCC artifact hash'],
  ['FLARE_TEE_EXTENSION_REGISTRY', 'FCC TEE extension registry'],
  ['FLARE_TEE_MACHINE_REGISTRY', 'FCC TEE machine registry'],
  ['FLARE_FCC_EXTENSION_ID', 'FCC registered extension id'],
  ['FLARE_EXTERNAL_REVIEW_ID', 'independent security review record'],
  ['FLARE_MULTISIG_ADDRESS', 'release multisig'],
  ['FLARE_GUARDIAN_ADDRESS', 'pause-only guardian'],
];
const validators = new Map([
  ['FLARE_FDC_VERIFIER_URL', url], ['FLARE_FDC_DA_URL', url], ['FLARE_FDC_API_KEY', nonEmpty],
  ['FCC_MATCHER_CODE_HASH', (value) => hex(value, 32)], ['FCC_MATCHER_OWNER', address],
  ['FCC_MATCHER_PLATFORM_MEASUREMENT', nonEmpty], ['FCC_MATCHER_ARTIFACT_SHA256', (value) => hex(value, 32)],
  ['FLARE_TEE_EXTENSION_REGISTRY', address], ['FLARE_TEE_MACHINE_REGISTRY', address],
  ['FLARE_FCC_EXTENSION_ID', (value) => nonEmpty(value) && /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value.trim())],
  ['FLARE_EXTERNAL_REVIEW_ID', nonEmpty], ['FLARE_MULTISIG_ADDRESS', address], ['FLARE_GUARDIAN_ADDRESS', address],
]);
const missing = required.filter(([name]) => !(validators.get(name) ?? nonEmpty)(process.env[name])).map(([name, description]) => `${name} (${description})`);
if (process.env.FLARE_GOVERNANCE_STATUS !== 'production-approved') missing.push('FLARE_GOVERNANCE_STATUS=production-approved (multisig/guardian governance handoff)');
const attestationEndpoints = (process.env.FCC_MATCHER_ATTESTATION_URLS ?? process.env.FCC_MATCHER_ATTESTATION_URL ?? '').split(',').map((value) => value.trim()).filter(Boolean);
if (attestationEndpoints.length !== 3 || new Set(attestationEndpoints.map((endpoint) => endpoint.toLowerCase())).size !== 3 || attestationEndpoints.some((endpoint) => !url(endpoint))) missing.push('FCC_MATCHER_ATTESTATION_URLS (exactly three distinct HTTPS FCC /info endpoints)');
if (process.env.FCC_MATCHER_MODE !== 'real') missing.push('FCC_MATCHER_MODE=real (simulated matcher is not a release candidate)');
const teeIds = (process.env.FCC_MATCHER_REQUIRED_TEE_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
if (teeIds.length !== 3 || new Set(teeIds.map((id) => id.toLowerCase())).size !== 3 || teeIds.some((id) => !nonEmpty(id))) missing.push('FCC_MATCHER_REQUIRED_TEE_IDS (exactly three distinct independently registered TEE identities)');
const venueManifest = process.env.FLARE_VENUE_MANIFEST;
if (!venueManifest || !existsSync(venueManifest)) {
  missing.push('FLARE_VENUE_MANIFEST (verified Coston2 venue deployment manifest)');
} else {
  try {
    const parsed = JSON.parse(readFileSync(venueManifest, 'utf8'));
    missing.push(...validateVenueVerificationManifest(parsed, parsed.chainId).map((error) => `FLARE_VENUE_MANIFEST (${error})`));
  } catch {
    missing.push('FLARE_VENUE_MANIFEST (invalid JSON)');
  }
}
const artifactManifest = process.env.FCC_MATCHER_ARTIFACT_MANIFEST ?? 'services/fcc-matcher/dist/manifest.json';
if (!existsSync(artifactManifest)) missing.push('FCC_MATCHER_ARTIFACT_MANIFEST (reproducible artifact manifest)');
else {
  try {
    const parsed = JSON.parse(readFileSync(artifactManifest, 'utf8'));
    missing.push(...validateFccArtifactManifest(parsed, process.env.FCC_MATCHER_ARTIFACT_SHA256).map((error) => `FCC_MATCHER_ARTIFACT_MANIFEST (${error})`));
  } catch {
    missing.push('FCC_MATCHER_ARTIFACT_MANIFEST (invalid JSON)');
  }
}
const governanceManifest = process.env.FLARE_GOVERNANCE_MANIFEST;
if (!governanceManifest || !existsSync(governanceManifest)) missing.push('FLARE_GOVERNANCE_MANIFEST (verified governance manifest path)');
else {
  try {
    const parsed = JSON.parse(readFileSync(governanceManifest, 'utf8'));
    missing.push(...validateGovernanceManifest(parsed).map((error) => `FLARE_GOVERNANCE_MANIFEST (${error})`));
  } catch {
    missing.push('FLARE_GOVERNANCE_MANIFEST (invalid JSON)');
  }
}
if (process.env.FLARE_RELEASE_PROFILE === 'production') {
  missing.push(...validateProductionServiceConfig(process.env).map((error) => `PRODUCTION_SERVICE_CONFIG (${error})`));
}

if (missing.length > 0) {
  console.error(`release-gate=BLOCKED missing=${missing.join('; ')}`);
  process.exitCode = 2;
} else {
  console.log('release-gate=CONFIGURED external evidence references present');
}
