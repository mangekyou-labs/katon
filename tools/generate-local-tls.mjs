import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'infra/tls-local');
const force = process.argv.includes('--force');
const cert = resolve(dir, 'server.crt');
const key = resolve(dir, 'server.key');
const ca = resolve(dir, 'client-ca.crt');
const notice = resolve(dir, 'NOT-PRODUCTION.txt');

if (!force && existsSync(cert) && existsSync(key) && existsSync(ca)) {
  console.log('local-tls=EXISTS dir=infra/tls-local label=NOT-PRODUCTION');
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', key, '-out', cert, '-days', '30',
  '-subj', '/CN=localhost/O=TrustRFQ local TLS/OU=NOT-PRODUCTION',
], { stdio: 'pipe' });
execFileSync('cp', [cert, ca]);
writeFileSync(
  notice,
  [
    'These files are local self-signed certificates.',
    'They are NOT production, NOT Let’s Encrypt, and do NOT satisfy release gates.',
    'Gitignored. Do not set FLARE_GOVERNANCE_STATUS=production-approved because of this directory.',
    '',
  ].join('\n'),
);
console.log('local-tls=GENERATED dir=infra/tls-local label=NOT-PRODUCTION days=30');
