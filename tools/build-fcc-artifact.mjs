import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const outputDir = resolve(root, 'services/fcc-matcher/dist');
const output = resolve(outputDir, 'fcc-matcher');
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
if (!sourceDateEpoch || !/^\d+$/.test(sourceDateEpoch)) throw new Error('SOURCE_DATE_EPOCH_REQUIRED');
if (!existsSync(resolve(root, 'services/fcc-matcher/cmd/server/main.go'))) throw new Error('FCC_SOURCE_MISSING');
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(go|mod|sum)$/.test(entry.name) ? [path] : [];
  }).sort();
}
const sourceHash = createHash('sha256');
for (const path of sourceFiles(resolve(root, 'services/fcc-matcher'))) {
  sourceHash.update(path.slice(root.length));
  sourceHash.update(readFileSync(path));
}
mkdirSync(outputDir, { recursive: true });
execFileSync('go', ['build', '-trimpath', '-ldflags', '-buildid=', '-o', output, './services/fcc-matcher/cmd/server'], {
  cwd: root,
  env: { ...process.env, CGO_ENABLED: '0', SOURCE_DATE_EPOCH: sourceDateEpoch },
  stdio: 'inherit',
});
const bytes = readFileSync(output);
const artifactHash = `0x${createHash('sha256').update(bytes).digest('hex')}`;
const manifest = {
  artifact: 'fcc-matcher',
  sourceDateEpoch: Number(sourceDateEpoch),
  reproducibleBuild: true,
  cgoEnabled: false,
  binary: output,
  sha256: artifactHash,
  sourceSha256: `0x${sourceHash.digest('hex')}`,
  mode: 'simulated-until-real-attestation',
};
writeFileSync(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`fcc-artifact=PASS sha256=${artifactHash} sourceDateEpoch=${sourceDateEpoch} cgo=0`);
