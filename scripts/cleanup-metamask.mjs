import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const disposableRoot = path.join(rootDir, '.playwright');
const targets = [
  path.join(disposableRoot, 'metamask-local'),
  path.join(disposableRoot, 'metamask-extension')
];

for (const target of targets) {
  if (!target.startsWith(`${disposableRoot}${path.sep}`)) throw new Error(`Refusing unsafe cleanup target: ${target}`);
  await fs.rm(target, { recursive: true, force: true });
  console.log(`Removed disposable QA data: ${path.relative(rootDir, target)}`);
}
