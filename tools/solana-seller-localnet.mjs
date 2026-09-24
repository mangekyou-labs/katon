#!/usr/bin/env node
/**
 * Ticket 13 — offline Surfpool Seller Desk localnet harness.
 *
 * Starts Surfpool if needed, funds seller+maker, provisions local Token-2022
 * QA mint + USDC stand-in (not cloned mainnet xStocks), optionally loads
 * solana_rfq.so via surfnet_writeProgram, writes .local config + maker key.
 *
 * Does NOT rewrite Squads vault PDA (ticket 14). Does NOT touch mainnet.
 */

import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LOCAL_DIR = join(ROOT, '.local');
const CONFIG_PATH = join(LOCAL_DIR, 'solana-seller-localnet.json');
const MAKER_KEY_PATH = join(LOCAL_DIR, 'maker-keypair.json');
const SELLER_KEY_PATH = join(LOCAL_DIR, 'seller-keypair.json');
const SURFPOOL_PID_PATH = join(LOCAL_DIR, 'surfpool.pid');
const SURFPOOL_LOG_PATH = join(LOCAL_DIR, 'surfpool.log');

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const SURFPOOL_BIN = process.env.SURFPOOL_BIN ?? '/Users/kyler/.local/bin/surfpool';
const PROGRAM_ID = 'J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Documented local-only seeds (must match @katon/solana-core wire.ts). */
const LOCAL_SELLER_SEED = Buffer.alloc(32, 7);
const LOCAL_MAKER_SEED = Buffer.alloc(32, 8);

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes) {
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) + BigInt(byte);
  let encoded = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = BASE58[remainder] + encoded;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function publicKeyFromSeed(seed) {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  return Uint8Array.from(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
}

function keypairFromSeed(seed) {
  const publicKey = publicKeyFromSeed(seed);
  const secretKey = Uint8Array.from([...seed, ...publicKey]);
  return { seed: Uint8Array.from(seed), publicKey, secretKey, publicKeyBase58: encodeBase58(publicKey) };
}

/** Deterministic mint keypair from a label (local-only, not mainnet). */
function mintKeypair(label) {
  const seed = createHash('sha256').update(`katon-localnet-mint:${label}`).digest();
  return keypairFromSeed(seed);
}

function encodeMintAccount({ mintAuthority, decimals, supply = 0n }) {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0); // COption::Some mint authority
  Buffer.from(mintAuthority).copy(data, 4);
  data.writeBigUInt64LE(BigInt(supply), 36);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(1, 45); // initialized
  data.writeUInt32LE(0, 46); // no freeze authority
  return data;
}

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `RPC ${method} failed (${response.status})`);
  }
  return body.result;
}

async function isRpcUp() {
  try {
    const health = await rpc('getHealth');
    return health === 'ok' || health == null;
  } catch {
    return false;
  }
}

async function waitForRpc(timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isRpcUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Surfpool RPC not healthy at ${RPC_URL} after ${timeoutMs}ms`);
}

function ensureLocalDir() {
  mkdirSync(LOCAL_DIR, { recursive: true });
}

function startSurfpoolBackground({ sellerPubkey, makerPubkey }) {
  if (!existsSync(SURFPOOL_BIN)) {
    throw new Error(`surfpool binary not found at ${SURFPOOL_BIN}; set SURFPOOL_BIN`);
  }
  ensureLocalDir();
  // --daemon is Linux-only in Surfpool 1.6; on macOS detach the process ourselves.
  const useDaemonFlag = process.platform === 'linux';
  const args = [
    'start',
    '--offline',
    '--no-tui',
    '--no-studio',
    '--yes',
    '--no-deploy',
    ...(useDaemonFlag ? ['--daemon'] : []),
    '--airdrop', sellerPubkey,
    '--airdrop', makerPubkey,
    '--airdrop-amount', '1000000000',
  ];
  const logStream = {
    write(chunk) {
      try {
        writeFileSync(SURFPOOL_LOG_PATH, chunk, { flag: 'a' });
      } catch {
        // best-effort
      }
    },
  };
  writeFileSync(SURFPOOL_LOG_PATH, '', 'utf8');
  const child = spawn(SURFPOOL_BIN, args, {
    cwd: ROOT,
    env: { ...process.env, NO_DNA: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c) => logStream.write(c));
  child.stderr?.on('data', (c) => logStream.write(c));
  child.unref();
  writeFileSync(SURFPOOL_PID_PATH, String(child.pid ?? ''), 'utf8');
  console.log(`[harness] started Surfpool pid=${child.pid} (NO_DNA=1 surfpool start --offline${useDaemonFlag ? ' --daemon' : ' [detached]'})`);
  console.log(`[harness] logs → ${SURFPOOL_LOG_PATH}`);
}

async function fundSol(pubkeyBase58, lamports = 2_000_000_000n) {
  await rpc('surfnet_setAccount', [
    pubkeyBase58,
    { lamports: Number(lamports), owner: SYSTEM_PROGRAM },
  ]);
}

async function provisionMint({ mint, authority, decimals, tokenProgram }) {
  const data = encodeMintAccount({ mintAuthority: authority, decimals });
  // Prefer byte array; some Surfpool builds accept base58/hex — fall back if needed.
  try {
    await rpc('surfnet_setAccount', [
      mint.publicKeyBase58,
      {
        lamports: 1_000_000_000,
        owner: tokenProgram,
        executable: false,
        data: Array.from(data),
      },
    ]);
  } catch (firstError) {
    await rpc('surfnet_setAccount', [
      mint.publicKeyBase58,
      {
        lamports: 1_000_000_000,
        owner: tokenProgram,
        executable: false,
        data: data.toString('hex'),
      },
    ]).catch(() => {
      throw firstError;
    });
  }
}

async function provisionTokenAccount({ owner, mint, amount, tokenProgram }) {
  await rpc('surfnet_setTokenAccount', [
    owner,
    mint,
    { amount: Number(amount), state: 'initialized' },
    tokenProgram,
  ]);
}

async function tryLoadProgram() {
  const candidates = [
    join(ROOT, 'contracts/solana-rfq/target/deploy/solana_rfq.so'),
    join(ROOT, 'contracts/solana-rfq/target/sbpf-solana-solana/release/solana_rfq.so'),
    join(ROOT, 'contracts/solana-rfq/target/deploy/solana_rfq.so'),
  ];
  const soPath = candidates.find((path) => existsSync(path));
  if (!soPath) {
    console.log('[harness] no solana_rfq.so found — skipping program load (settlement can still land via System transfer)');
    return { loaded: false, path: null };
  }
  const bytes = readFileSync(soPath);
  // surfnet_writeProgram expects data_chunk as a hex string (not a byte array).
  const chunkSize = 512 * 1024;
  try {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      await rpc('surfnet_writeProgram', [
        PROGRAM_ID,
        Buffer.from(chunk).toString('hex'),
        offset,
      ]);
    }
    console.log(`[harness] loaded program ${PROGRAM_ID} from ${soPath} (${bytes.length} bytes)`);
    return { loaded: true, path: soPath };
  } catch (error) {
    console.warn(`[harness] surfnet_writeProgram failed (governance/init may still be required): ${error instanceof Error ? error.message : error}`);
    console.warn('[harness] continuing without on-chain program — API local loop uses landable System transfer');
    return { loaded: false, path: soPath, error: String(error) };
  }
}

function writeKeypairFile(path, keypair) {
  // Solana CLI JSON format: 64-byte secret key as number array.
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
}

async function main() {
  ensureLocalDir();
  const seller = keypairFromSeed(LOCAL_SELLER_SEED);
  const maker = process.env.KATON_MAKER_SECRET_KEY
    ? (() => {
      const raw = process.env.KATON_MAKER_SECRET_KEY.trim();
      const parsed = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : null;
      if (parsed && (parsed.length === 32 || parsed.length === 64)) {
        const seed = parsed.length === 64 ? parsed.slice(0, 32) : parsed;
        return keypairFromSeed(seed);
      }
      return keypairFromSeed(LOCAL_MAKER_SEED);
    })()
    : keypairFromSeed(LOCAL_MAKER_SEED);

  writeKeypairFile(SELLER_KEY_PATH, seller);
  writeKeypairFile(MAKER_KEY_PATH, maker);

  let startedHere = false;
  if (!(await isRpcUp())) {
    startSurfpoolBackground({ sellerPubkey: seller.publicKeyBase58, makerPubkey: maker.publicKeyBase58 });
    startedHere = true;
    await waitForRpc();
  } else {
    console.log(`[harness] RPC already up at ${RPC_URL}`);
  }

  // Ensure fee SOL even if Surfpool was already running without --airdrop.
  await fundSol(seller.publicKeyBase58);
  await fundSol(maker.publicKeyBase58);

  const stockMint = mintKeypair('qa-aapl-xstock');
  const stableMint = mintKeypair('qa-usdc-standin');
  await provisionMint({
    mint: stockMint,
    authority: seller.publicKey,
    decimals: 6,
    tokenProgram: TOKEN_2022,
  });
  await provisionMint({
    mint: stableMint,
    authority: maker.publicKey,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM,
  });
  await provisionTokenAccount({
    owner: seller.publicKeyBase58,
    mint: stockMint.publicKeyBase58,
    amount: 2_500_000n,
    tokenProgram: TOKEN_2022,
  });
  await provisionTokenAccount({
    owner: maker.publicKeyBase58,
    mint: stableMint.publicKeyBase58,
    amount: 1_000_000_000_000n,
    tokenProgram: TOKEN_PROGRAM,
  });

  const program = await tryLoadProgram();

  const config = {
    rpcUrl: RPC_URL,
    chain: 'solana:localnet',
    programId: PROGRAM_ID,
    programLoaded: program.loaded,
    programArtifact: program.path,
    stockMint: stockMint.publicKeyBase58,
    stockTokenProgram: TOKEN_2022,
    stableMint: stableMint.publicKeyBase58,
    stableTokenProgram: TOKEN_PROGRAM,
    sellerPubkey: seller.publicKeyBase58,
    makerPubkey: maker.publicKeyBase58,
    makerKeypairPath: MAKER_KEY_PATH,
    sellerKeypairPath: SELLER_KEY_PATH,
    apiPort: Number(process.env.SOLANA_API_PORT ?? 8787),
    notes: [
      'Local-only Token-2022 QA mint + USDC stand-in — not cloned mainnet xStocks.',
      'Squads vault PDA rewrite is ticket 14 — not performed here.',
      'KATON_LOCALNET=1 makes the API emit landable System-transfer v0 bytes.',
    ],
    startedSurfpoolHere: startedHere,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  console.log('');
  console.log('[harness] wrote', CONFIG_PATH);
  console.log('[harness] maker key', MAKER_KEY_PATH);
  console.log('[harness] seller key', SELLER_KEY_PATH);
  console.log('');
  console.log('# Env for local Seller Desk API / loop:');
  console.log(`export SOLANA_RPC_URL=${RPC_URL}`);
  console.log('export KATON_LOCALNET=1');
  console.log(`export KATON_MAKER_SECRET_KEY=$(cat ${MAKER_KEY_PATH})`);
  console.log(`export SOLANA_API_PORT=${config.apiPort}`);
  console.log(`export SOLANA_API_AUTOSTART=true`);
  console.log(`# or: KATON_MAKER_SECRET_KEY path → ${MAKER_KEY_PATH}`);
  console.log('');
  console.log(`# Start API: npm run dev:solana-api:localnet`);
  console.log(`# Loop proof: npm run seller:loop`);
  console.log(JSON.stringify({
    rpcUrl: config.rpcUrl,
    chain: config.chain,
    programId: config.programId,
    stockMint: config.stockMint,
    stableMint: config.stableMint,
    makerPubkey: config.makerPubkey,
    sellerPubkey: config.sellerPubkey,
    programLoaded: config.programLoaded,
  }, null, 2));
}

main().catch((error) => {
  console.error('[harness] FAILED', error);
  process.exit(1);
});
