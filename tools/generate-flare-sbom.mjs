import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const components = [];

for (const [location, packageInfo] of Object.entries(lock.packages ?? {})) {
  if (!location || location === '' || !packageInfo || typeof packageInfo !== 'object') continue;
  const version = packageInfo.version;
  if (typeof version !== 'string' || !version) continue;
  const name = location.startsWith('node_modules/') ? location.slice('node_modules/'.length) : location;
  if (name.includes('node_modules/')) continue;
  components.push({
    type: 'library',
    name,
    version,
    purl: `pkg:npm/${encodeURIComponent(name).replaceAll('%40', '@')}@${encodeURIComponent(version)}`,
  });
}

components.sort((left, right) => left.purl.localeCompare(right.purl));
const digest = createHash('sha256').update(readFileSync(resolve(root, 'package-lock.json'))).digest('hex');
process.stdout.write(`${JSON.stringify({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  version: 1,
  metadata: { component: { type: 'application', name: lock.name ?? 'trustrfq', version: lock.version ?? '0.0.0' } },
  components,
}, null, 2)}\n`);
