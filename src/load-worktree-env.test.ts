import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyEnvFile, loadWorktreeEnv } from '../tools/load-worktree-env.mjs';

const original = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('worktree .env loader', () => {
  it('loads KEY=VALUE lines without overriding existing process.env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trustrfq-env-'));
    const path = join(dir, '.env');
    writeFileSync(
      path,
      [
        '# comment',
        '',
        'FLARE_FDC_API_KEY=from-file',
        'FLARE_FDC_VERIFIER_URL="https://fdc.example"',
        'ALREADY_SET=file-must-not-win',
      ].join('\n'),
    );
    process.env.ALREADY_SET = 'from-process';

    const applied = applyEnvFile(path);

    expect(process.env.FLARE_FDC_API_KEY).toBe('from-file');
    expect(process.env.FLARE_FDC_VERIFIER_URL).toBe('https://fdc.example');
    expect(process.env.ALREADY_SET).toBe('from-process');
    expect(applied).toEqual(['FLARE_FDC_API_KEY', 'FLARE_FDC_VERIFIER_URL']);
  });

  it('is a no-op when the file is missing', () => {
    expect(() => applyEnvFile(join(tmpdir(), 'missing-trustrfq.env'))).not.toThrow();
  });

  it('loads the worktree .env next to package.json by default', () => {
    loadWorktreeEnv();
    expect(process.env.FLARE_FDC_API_KEY).toBeTruthy();
  });
});
