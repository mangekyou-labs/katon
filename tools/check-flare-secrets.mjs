import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scanRoots = ['apps', 'packages', 'services', 'contracts/flare/src', 'contracts/flare/test', 'infra', 'tools', 'public'];
const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'out', 'cache', 'target', '.superstack']);
const extensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.go', '.sol', '.rs', '.json', '.yml', '.yaml', '.toml', '.html', '.css']);
const patterns = [
  { name: 'PEM_PRIVATE_KEY', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { name: 'EVM_PRIVATE_KEY_LITERAL', expression: /(?:PRIVATE_KEY|privateKey|private_key)\s*[:=]\s*["']?0x[0-9a-f]{64}\b/i },
  { name: 'SERVICE_ACCOUNT_PRIVATE_KEY', expression: /"private_key"\s*:\s*"-----BEGIN/i },
  { name: 'AWS_ACCESS_KEY', expression: /\bAKIA[0-9A-Z]{16}\b/ },
];

const findings = [];
let countedFiles = 0;
for (const scanRoot of scanRoots) {
  const absolute = join(root, scanRoot);
  if (existsSync(absolute)) walk(absolute);
}

if (findings.length) {
  for (const finding of findings) console.error(`${finding.file}:${finding.pattern}`);
  process.exitCode = 1;
} else {
  console.log(`secret-scan=PASS files=${countedFiles}`);
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) walk(join(directory, entry.name));
      continue;
    }
    const file = join(directory, entry.name);
    if (!extensions.has(extension(file))) continue;
    countedFiles += 1;
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.expression.test(source)) findings.push({ file: relative(root, file), pattern: pattern.name });
    }
  }
}

function extension(file) {
  const lastDot = file.lastIndexOf('.');
  return lastDot < 0 ? '' : file.slice(lastDot).toLowerCase();
}
