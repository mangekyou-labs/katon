import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, process.env.FLARE_FCC_MANIFEST ?? 'fixtures/flare/fcc-coston2-weather-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];

function required(value, name) {
  if (value === null || value === undefined || value === '') errors.push(`${name}_REQUIRED`);
}

function address(value, name) {
  required(value, name);
  if (value !== null && !/^0x[0-9a-fA-F]{40}$/.test(value)) errors.push(`${name}_ADDRESS`);
}

function hash(value, name) {
  required(value, name);
  if (value !== null && !/^0x[0-9a-fA-F]{64}$/.test(value)) errors.push(`${name}_HASH`);
}

if (manifest.network !== 'coston2' || manifest.chainId !== 114) errors.push('COSTON2_CHAIN');
if (manifest.simulatedTEE !== true) errors.push('SIMULATED_TEE_REQUIRED');
if (manifest.deployment?.deploy !== false) errors.push('DRY_RUN_MUST_NOT_DEPLOY');
if (manifest.deployment?.operatorApprovalRequired !== true) errors.push('OPERATOR_APPROVAL_REQUIRED');
address(manifest.registries?.teeManager, 'TEE_MANAGER');
address(manifest.registries?.extensionRegistry, 'EXTENSION_REGISTRY');
address(manifest.registries?.machineRegistry, 'MACHINE_REGISTRY');
required(manifest.deployment?.instructionSender, 'INSTRUCTION_SENDER');
address(manifest.deployment?.instructionSender, 'INSTRUCTION_SENDER');
required(manifest.deployment?.extensionId, 'EXTENSION_ID');
required(manifest.extension?.codeVersion, 'EXTENSION_CODE_VERSION');
hash(manifest.extension?.simulatedCodeHash, 'SIMULATED_CODE_HASH');

const machines = Array.isArray(manifest.machines) ? manifest.machines : [];
if (machines.length !== 3) errors.push('TEE_COUNT');
const identities = new Set();
const encryptionKeys = new Set();
const urls = new Set();
for (const machine of machines) {
  required(machine.identity, `${machine.name ?? 'TEE'}_IDENTITY`);
  required(machine.encryptionKeyId, `${machine.name ?? 'TEE'}_ENCRYPTION_KEY`);
  required(machine.url, `${machine.name ?? 'TEE'}_URL`);
  if (machine.identity && identities.has(machine.identity)) errors.push('TEE_IDENTITY_DUPLICATE');
  if (machine.encryptionKeyId && encryptionKeys.has(machine.encryptionKeyId)) errors.push('TEE_KEY_DUPLICATE');
  if (machine.url && urls.has(machine.url)) errors.push('TEE_URL_DUPLICATE');
  if (machine.identity) identities.add(machine.identity);
  if (machine.encryptionKeyId) encryptionKeys.add(machine.encryptionKeyId);
  if (machine.url) {
    if (!/^https:\/\//.test(machine.url)) errors.push('TEE_URL_HTTPS');
    urls.add(machine.url);
  }
  if (machine.simulated !== true) errors.push('TEE_SIMULATED_REQUIRED');
}
if (manifest.acceptance?.requiredSelectedMachines !== 3 || manifest.acceptance?.quorum !== 2) errors.push('QUORUM_TOPOLOGY');

const artifact = manifest.extension?.artifact ? resolve(root, manifest.extension.artifact) : null;
if (artifact && existsSync(artifact)) {
  const artifactManifest = JSON.parse(readFileSync(artifact, 'utf8'));
  if (manifest.extension.simulatedCodeHash && artifactManifest.sha256 && manifest.extension.simulatedCodeHash.toLowerCase() !== artifactManifest.sha256.toLowerCase()) errors.push('SIMULATED_CODE_HASH_MISMATCH');
}

const result = {
  manifest: manifestPath.slice(root.length + 1),
  chainId: manifest.chainId,
  status: errors.length ? 'BLOCKED' : 'READY_FOR_OPERATOR_APPROVAL',
  errors,
  deployPerformed: false,
  productionClaim: false,
};
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 2;
