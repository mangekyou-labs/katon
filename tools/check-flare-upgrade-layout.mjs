import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, stringToHex } from 'viem';

const root = resolve(import.meta.dirname, '..');
const manifestPath = process.env.FLARE_DEPLOYMENT_MANIFEST
  ? resolve(process.env.FLARE_DEPLOYMENT_MANIFEST)
  : existsSync(resolve(root, 'contracts/flare/deployments/coston2-proxy-candidate.json'))
    ? resolve(root, 'contracts/flare/deployments/coston2-proxy-candidate.json')
    : resolve(root, 'contracts/flare/deployments/coston2.json');
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

if (!manifest.bytecodeHashes || (manifest.candidate === 'transparent-proxy-v1' ? !manifest.implementationStorageLayoutHashes : !manifest.storageLayoutHashes)) {
  throw new Error('UPGRADE_LAYOUT_MANIFEST_MISSING');
}

let checked = 0;
for (const name of Object.keys(manifest.contracts)) {
  const source = sourceByName[name];
  if (!source) throw new Error(`UPGRADE_LAYOUT_CONTRACT:${name}`);
  const artifactPath = resolve(root, 'contracts/flare/out', source[0], `${source[1]}.json`);
  if (!existsSync(artifactPath)) throw new Error(`UPGRADE_LAYOUT_ARTIFACT:${name}`);
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!artifact.storageLayout) throw new Error(`UPGRADE_LAYOUT_MISSING:${name}`);
  const layoutHash = keccak256(stringToHex(JSON.stringify(artifact.storageLayout)));
  const expectedLayout = manifest.candidate === 'transparent-proxy-v1' ? manifest.implementationStorageLayoutHashes[name] : manifest.storageLayoutHashes[name];
  const proposedLayout = manifest.proposedImplementationStorageLayoutHashes?.[name];
  if (layoutHash !== expectedLayout && layoutHash !== proposedLayout) throw new Error(`UPGRADE_LAYOUT_CHANGED:${name}`);
  if (manifest.candidate === 'transparent-proxy-v1' && manifest.implementationBytecodeHashes?.[name]) {
    const bytecode = JSON.parse(readFileSync(artifactPath, 'utf8')).deployedBytecode?.object;
    if (!bytecode) throw new Error(`UPGRADE_BYTECODE_MISSING:${name}`);
    const actualBytecode = keccak256(bytecode);
    const proposedBytecode = manifest.proposedImplementationBytecodeHashes?.[name];
    if (actualBytecode !== manifest.implementationBytecodeHashes[name] && actualBytecode !== proposedBytecode) throw new Error(`UPGRADE_IMPLEMENTATION_CHANGED:${name}`);
  }
  checked += 1;
}

console.log(`upgrade-layout=PASS contracts=${checked} mode=${manifest.candidate === 'transparent-proxy-v1' ? 'transparent-proxy-candidate' : 'immutable-manifest'}`);
