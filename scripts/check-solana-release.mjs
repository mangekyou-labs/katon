import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const required = [
  'docs/ai/requirements/2026-09-15-feature-solana-tokenized-stock-desk.md',
  'docs/ai/design/2026-09-15-feature-solana-tokenized-stock-desk.md',
  'contracts/solana-rfq/programs/solana-rfq/src/lib.rs',
  'services/solana-liquidator/src/manifest.ts',
];
const missing = [];
for (const file of required) {
  try { await readFile(new URL(file, root)); } catch { missing.push(file); }
}
if (missing.length > 0) {
  console.error(`missing Solana release files: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('Solana release scaffold present; runtime manifests, audits, fork evidence, and multisig approval remain gated.');
}
