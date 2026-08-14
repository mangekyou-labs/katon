import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateGovernanceManifest } from './release-evidence.mjs';

const path = process.env.FLARE_GOVERNANCE_MANIFEST;
if (!path || !existsSync(path)) throw new Error('GOVERNANCE_MANIFEST_REQUIRED');
let manifest;
try { manifest = JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { throw new Error('GOVERNANCE_MANIFEST_INVALID'); }
const errors = validateGovernanceManifest(manifest);
if (errors.length > 0) throw new Error(errors[0]);
console.log(`governance-manifest=PASS chainId=${manifest.chainId} upgradeable=${manifest.upgradeable.length} immutable=${manifest.immutable.length} migrations=${manifest.migrations.length}`);
