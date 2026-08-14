#!/usr/bin/env node

// Static preflight for the three local FCC stacks. It intentionally does not
// read secrets: identities, ports, URLs, and state volumes must be unique
// before compose is allowed to start.
const stacks = [
  { name: 'tee-a', identity: process.env.FCC_TEE_ID_A ?? 'tee-a', encryptionKey: process.env.FCC_TEE_A_ENCRYPTION_KEY_ID ?? 'tee-a-key', port: Number(process.env.FCC_TEE_A_HOST_PORT ?? 8664), url: process.env.FCC_TEE_A_PUBLIC_URL ?? 'http://127.0.0.1:8664', volume: 'fcc-redis-a' },
  { name: 'tee-b', identity: process.env.FCC_TEE_ID_B ?? 'tee-b', encryptionKey: process.env.FCC_TEE_B_ENCRYPTION_KEY_ID ?? 'tee-b-key', port: Number(process.env.FCC_TEE_B_HOST_PORT ?? 8764), url: process.env.FCC_TEE_B_PUBLIC_URL ?? 'http://127.0.0.1:8764', volume: 'fcc-redis-b' },
  { name: 'tee-c', identity: process.env.FCC_TEE_ID_C ?? 'tee-c', encryptionKey: process.env.FCC_TEE_C_ENCRYPTION_KEY_ID ?? 'tee-c-key', port: Number(process.env.FCC_TEE_C_HOST_PORT ?? 8864), url: process.env.FCC_TEE_C_PUBLIC_URL ?? 'http://127.0.0.1:8864', volume: 'fcc-redis-c' },
];

for (const field of ['identity', 'encryptionKey', 'port', 'url', 'volume']) {
  const values = stacks.map((stack) => stack[field]);
  if (new Set(values).size !== values.length) throw new Error(`FCC_DUPLICATE_${field.toUpperCase()}`);
}
if (new Set(stacks.map((stack) => stack.name)).size !== 3) throw new Error('FCC_TEE_COUNT');
const extensionId = process.env.FCC_EXTENSION_ID ?? '65537';
if (!/^\d+$/.test(extensionId) || Number(extensionId) < 65536) throw new Error('FCC_EXTENSION_ID');
const chainId = Number(process.env.FLARE_CHAIN_ID ?? 114);
if (chainId !== 114) throw new Error('FCC_CHAIN_ID');
const codeHash = process.env.FCC_MATCHER_CODE_HASH?.trim();
if (codeHash && !/^0x[0-9a-fA-F]{64}$/.test(codeHash)) throw new Error('FCC_CODE_HASH');
const publicMode = stacks.every((stack) => stack.url.startsWith('https://'));

if (process.env.FCC_VALIDATE_LIVE === 'true') {
  for (const stack of stacks) {
    const info = await fetch(`${stack.url.replace(/\/$/u, '')}/info`);
    if (!info.ok) throw new Error(`FCC_PROXY_UNAVAILABLE:${stack.name}`);
    const body = await info.json();
    const machine = body?.machineData ?? body?.teeInfo ?? body;
    if (String(machine?.extensionId ?? '') !== extensionId) throw new Error(`FCC_EXTENSION_MISMATCH:${stack.name}`);
    if (String(machine?.teeId ?? machine?.teeID ?? '') !== stack.identity) throw new Error(`FCC_IDENTITY_MISMATCH:${stack.name}`);
  }
  const rpcUrl = process.env.FLARE_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
  const payload = await response.json();
  if (payload?.result !== '0x72') throw new Error('FCC_RPC_CHAIN_ID');
}

console.log(JSON.stringify({ ok: true, chainId, extensionId, codeHashConfigured: Boolean(codeHash), publicHttps: publicMode, live: process.env.FCC_VALIDATE_LIVE === 'true', stacks }, null, 2));
