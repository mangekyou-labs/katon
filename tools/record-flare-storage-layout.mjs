import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, stringToHex } from 'viem';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'contracts/flare/deployments/coston2.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sourceByName = {
  eligibilityRegistry: ['EligibilityRegistry.sol', 'EligibilityRegistry'],
  router: ['RFQRouter.sol', 'RFQRouter'],
  settlement: ['RFQSettlement.sol', 'RFQSettlement'],
  instructionSender: ['ConfidentialRFQInstructionSender.sol', 'ConfidentialRFQInstructionSender'],
  facilityAggregator: ['FacilityAggregator.sol', 'FacilityAggregator'],
  navProofRegistry: ['ProofGuards.sol', 'NavProofRegistry'],
  ftsoRiskGuard: ['ProofGuards.sol', 'FtsoRiskGuard'],
};

manifest.storageLayoutHashes = {};
for (const name of Object.keys(manifest.contracts)) {
  const source = sourceByName[name];
  if (!source) throw new Error(`STORAGE_LAYOUT_CONTRACT:${name}`);
  const artifactPath = resolve(root, 'contracts/flare/out', source[0], `${source[1]}.json`);
  if (!existsSync(artifactPath)) throw new Error(`STORAGE_LAYOUT_ARTIFACT:${name}`);
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!artifact.storageLayout) throw new Error(`STORAGE_LAYOUT_MISSING:${name}`);
  manifest.storageLayoutHashes[name] = keccak256(stringToHex(JSON.stringify(artifact.storageLayout)));
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`recorded-storage-layouts=${Object.keys(manifest.storageLayoutHashes).length}`);
