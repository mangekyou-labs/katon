import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, keccak256, http } from 'viem';
import { flareTestnet } from 'viem/chains';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'contracts/flare/deployments/coston2.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const client = createPublicClient({ chain: { ...flareTestnet, id: 114, rpcUrls: { default: { http: [rpcUrl] } } }, transport: http(rpcUrl) });

manifest.bytecodeHashes = {};
for (const [name, address] of Object.entries(manifest.contracts)) {
  const bytecode = await client.getBytecode({ address });
  if (!bytecode || bytecode === '0x') throw new Error(`NO_BYTECODE:${name}`);
  manifest.bytecodeHashes[name] = keccak256(bytecode);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`recorded=${Object.keys(manifest.bytecodeHashes).length}`);
