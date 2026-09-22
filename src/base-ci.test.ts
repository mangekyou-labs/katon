import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Base CI skeleton', () => {
  it('adds a Base workflow with local-equivalent checks', () => {
    const workflowPath = join(root, '.github/workflows/base.yml');
    expect(existsSync(workflowPath)).toBe(true);
    expect(readFileSync(workflowPath, 'utf8')).toContain('npm run test:base');
    expect(readFileSync(workflowPath, 'utf8')).toContain('forge test --root contracts/base');
    expect(readFileSync(workflowPath, 'utf8')).toContain('node tools/check-base-secrets.mjs');
  });

  it('scans the Base contract tree and leaves the existing workflow untouched', () => {
    const scannerPath = join(root, 'tools/check-base-secrets.mjs');
    expect(existsSync(scannerPath)).toBe(true);
    expect(readFileSync(scannerPath, 'utf8')).toContain('contracts/base');
    expect(execFileSync('git', ['diff', '--name-only', 'main', '--', '.github/workflows/flare.yml'], {
      cwd: root,
      encoding: 'utf8',
    })).toBe('');
  });
});
