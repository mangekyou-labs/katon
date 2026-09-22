import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const basePackages = [
  'apps/base-web',
  'apps/base-api',
  'packages/base-core',
  'packages/base-sdk',
  'packages/base-contracts',
] as const;

const readJson = (relativePath: string) =>
  JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>;

describe('Base workspace registration', () => {
  it('registers each Base TypeScript package as a private ESM workspace', () => {
    for (const packagePath of basePackages) {
      const packageJson = readJson(`${packagePath}/package.json`);
      expect(packageJson).toMatchObject({ private: true, type: 'module' });
      expect(packageJson.name).toMatch(/^@katon\/base-/);
    }
  });

  it('includes the Base TypeScript trees in the dedicated configs', () => {
    expect(readJson('tsconfig.base.json').include).toEqual(
      expect.arrayContaining(['apps/base-web', 'packages/base-core', 'packages/base-sdk', 'packages/base-contracts']),
    );
    expect(readJson('tsconfig.base-api.json').include).toEqual(expect.arrayContaining(['apps/base-api']));
  });

  it('keeps the Foundry root isolated from the existing contract tree', () => {
    expect(existsSync(join(root, 'contracts/base/foundry.toml'))).toBe(true);
    expect(existsSync(join(root, 'contracts/base/src'))).toBe(true);
    expect(existsSync(join(root, 'contracts/base/test'))).toBe(true);
    expect(readFileSync(join(root, 'contracts/base/foundry.toml'), 'utf8')).not.toContain('contracts/flare');
  });

  it('does not modify existing other-chain source or protected docs', () => {
    const changedFiles = execFileSync('git', ['diff', '--name-only', 'main'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

    expect(changedFiles).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^apps\/flare-/),
        expect.stringMatching(/^packages\/flare-/),
        expect.stringMatching(/^contracts\/flare(?:\/|$)/),
        expect.stringMatching(/^docs\/ai\/.*\/2026-08-11-/),
      ]),
    );
  });
});
