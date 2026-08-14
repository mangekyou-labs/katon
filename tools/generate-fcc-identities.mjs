#!/usr/bin/env node

import { chmod, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const output = resolve(import.meta.dirname, '../.env.fcc.local');
if (!process.argv.includes('--force')) {
  try {
    await import('node:fs/promises').then(({ access }) => access(output));
    throw new Error('FCC_IDENTITY_FILE_EXISTS: use --force only after reviewing the old disposable file');
  } catch (error) {
    if (error?.message?.startsWith('FCC_IDENTITY_FILE_EXISTS')) throw error;
  }
}

function key() {
  return `0x${randomBytes(32).toString('hex')}`;
}

const lines = [
  '# Generated disposable simulated-FCC identities. Never commit or reuse these keys.',
  'FLARE_CHAIN_ID=114',
  'FCC_EXTENSION_ID=65537',
];
for (const suffix of ['A', 'B', 'C']) {
  const teeKey = key();
  const proxyKey = key();
  const proxyAddress = privateKeyToAccount(proxyKey).address;
  lines.push(`FCC_TEE_${suffix}_PRIVATE_KEY=${teeKey}`);
  lines.push(`FCC_TEE_${suffix}_PROXY_PRIVATE_KEY=${proxyKey}`);
  lines.push(`FCC_TEE_${suffix}_ENCRYPTION_KEY_ID=tee-${suffix.toLowerCase()}-${randomBytes(8).toString('hex')}`);
  lines.push(`FCC_TEE_${suffix}_PROXY_ENCRYPTION_KEY_ID=proxy-${suffix.toLowerCase()}-${randomBytes(8).toString('hex')}`);
  // The address is useful to an operator funding the disposable proxy, but no
  // private material is echoed to stdout.
  lines.push(`# FCC_TEE_${suffix}_PROXY_ADDRESS=${proxyAddress}`);
}
lines.push('FCC_INDEXER_MYSQL_HOST=34.38.42.208', 'FCC_INDEXER_MYSQL_PORT=3306', 'FCC_INDEXER_MYSQL_DATABASE=indexer');
await writeFile(output, `${lines.join('\n')}\n`, { mode: 0o600 });
await chmod(output, 0o600);
console.log(`fcc-identities=PASS generated=3 file=${output} secretsPrinted=false`);
