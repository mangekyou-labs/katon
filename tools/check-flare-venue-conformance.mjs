import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateVenueConformanceManifest } from './release-evidence.mjs';

const path = process.env.FLARE_VENUE_CONFORMANCE_MANIFEST;
if (!path || !existsSync(path)) throw new Error('VENUE_CONFORMANCE_MANIFEST_REQUIRED');
let manifest;
try { manifest = JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { throw new Error('VENUE_CONFORMANCE_MANIFEST_INVALID'); }
const errors = validateVenueConformanceManifest(manifest);
if (errors.length > 0) throw new Error(errors.join(','));
const status = manifest.execution === 'fork' ? 'PASS_FORK' : 'PASS_LOCAL';
console.log(`venue-conformance=${status} venue=${manifest.venue} chainId=${manifest.chainId} forkBlock=${manifest.forkBlock} execution=${manifest.execution} cases=${manifest.cases.length}`);
