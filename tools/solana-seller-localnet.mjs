#!/usr/bin/env node
/** Offline Surfpool fixture for the real Seller stock-for-stable settlement. */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONTRACT_DIR = join(ROOT, 'contracts/solana-rfq');
const LOCAL_DIR = join(ROOT, '.local');
const CONFIG_PATH = join(LOCAL_DIR, 'solana-seller-localnet.json');
const MAKER_KEY_PATH = join(LOCAL_DIR, 'maker-keypair.json');
const SELLER_KEY_PATH = join(LOCAL_DIR, 'seller-keypair.json');
const SURFPOOL_PID_PATH = join(LOCAL_DIR, 'surfpool.pid');
const SURFPOOL_LOG_PATH = join(LOCAL_DIR, 'surfpool.log');
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const SURFPOOL_BIN = process.env.SURFPOOL_BIN ?? '/Users/kyler/.local/bin/surfpool';
const ANCHOR_BIN = process.env.ANCHOR_BIN ?? '/Users/kyler/.cargo/bin/anchor';
const PROGRAM_ID = new PublicKey('J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM_PROGRAM = SystemProgram.programId;
const STABLE_MINTS = [
  new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
];
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SEEDS = {
  seller: Buffer.alloc(32, 7),
  maker: Buffer.alloc(32, 8),
  vault: Buffer.alloc(32, 9),
  guardian: Buffer.alloc(32, 10),
  feeRecipient: Buffer.alloc(32, 11),
  stockAuthority: Buffer.alloc(32, 12),
  stockMint: createHash('sha256').update('katon-localnet-test-stock-mint-v1').digest(),
};

const seller = Keypair.fromSeed(SEEDS.seller);
const maker = Keypair.fromSeed(SEEDS.maker);
const vault = Keypair.fromSeed(SEEDS.vault);
const guardian = Keypair.fromSeed(SEEDS.guardian);
const feeRecipient = Keypair.fromSeed(SEEDS.feeRecipient);
const stockAuthority = Keypair.fromSeed(SEEDS.stockAuthority);
const stockMint = Keypair.fromSeed(SEEDS.stockMint);

const u16 = (value) => { const data = Buffer.alloc(2); data.writeUInt16LE(value); return data; };
const u32 = (value) => { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data; };
const optionKey = (key) => key ? Buffer.concat([Buffer.from([1]), key.toBuffer()]) : Buffer.from([0]);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const digest = (data) => createHash('sha256').update(data).digest();

function encodeMintAccount(authority, decimals, supply) {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  authority.toBuffer().copy(data, 4);
  data.writeBigUInt64LE(BigInt(supply), 36);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(1, 45);
  data.writeUInt32LE(0, 46);
  return data;
}

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `RPC ${method} failed (${response.status})`);
  return body.result;
}

async function rpcUp() {
  try { return (await rpc('getHealth')) === 'ok'; } catch { return false; }
}

async function waitForRpc(timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await rpcUp()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Surfpool RPC did not become healthy at ${RPC_URL}`);
}

function startSurfpool() {
  if (!existsSync(SURFPOOL_BIN)) throw new Error(`Surfpool binary not found: ${SURFPOOL_BIN}`);
  mkdirSync(LOCAL_DIR, { recursive: true });
  writeFileSync(SURFPOOL_LOG_PATH, '', 'utf8');
  const child = spawn(SURFPOOL_BIN, [
    'start', '--offline', '--no-tui', '--no-studio', '--yes', '--no-deploy',
    ...(process.platform === 'linux' ? ['--daemon'] : []),
    '--airdrop', seller.publicKey.toBase58(), '--airdrop', maker.publicKey.toBase58(), '--airdrop-amount', '1000000000',
  ], { cwd: ROOT, env: { ...process.env, NO_DNA: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk) => writeFileSync(SURFPOOL_LOG_PATH, chunk, { flag: 'a' }));
  child.stderr?.on('data', (chunk) => writeFileSync(SURFPOOL_LOG_PATH, chunk, { flag: 'a' }));
  child.unref();
  writeFileSync(SURFPOOL_PID_PATH, String(child.pid ?? ''), 'utf8');
  console.log(`[harness] started offline Surfpool pid=${child.pid}`);
}

async function setAccount(address, lamports, owner, data, executable = false) {
  const account = { lamports, owner: owner.toBase58(), executable };
  // Surfpool's JSON-RPC cheatcode accepts account data as hex (unlike the
  // standard getAccountInfo response, which is base64). Keep fixture bytes
  // byte-for-byte stable across Surfpool versions.
  if (data) account.data = data.toString('hex');
  await rpc('surfnet_setAccount', [address.toBase58(), account]);
}

async function provisionTokenAccount(connection, owner, mint, amount) {
  const address = PublicKey.findProgramAddressSync([
    owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer(),
  ], ASSOCIATED_TOKEN_PROGRAM)[0];
  await rpc('surfnet_setTokenAccount', [
    owner.toBase58(), mint.toBase58(), { amount: Number(amount), state: 'initialized' }, TOKEN_PROGRAM.toBase58(),
  ]);
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info || !info.owner.equals(TOKEN_PROGRAM)) throw new Error(`Surfpool did not provision token account ${address}`);
  return address;
}

function buildProgram() {
  const bin = existsSync(ANCHOR_BIN) ? ANCHOR_BIN : 'anchor';
  const result = spawnSync(bin, ['build', '--skip-lint'], {
    cwd: CONTRACT_DIR, encoding: 'utf8',
    env: { ...process.env, NO_DNA: '1', SOLANA_SQUADS_VAULT_AUTHORITY: vault.publicKey.toBase58(), KATON_DEPLOYMENT_BUILD: '0' },
  });
  if (result.status !== 0) throw new Error(`Anchor build failed: ${result.stderr || result.stdout}`);
  const soPath = join(CONTRACT_DIR, 'target/deploy/solana_rfq.so');
  if (!existsSync(soPath)) throw new Error(`Anchor build did not produce ${soPath}`);
  return soPath;
}

async function deployProgram(soPath) {
  const bytes = readFileSync(soPath);
  const chunkSize = 512 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await rpc('surfnet_writeProgram', [PROGRAM_ID.toBase58(), bytes.subarray(offset, offset + chunkSize).toString('hex'), offset]);
  }
  const result = await rpc('getAccountInfo', [PROGRAM_ID.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
  if (!result.value?.executable) throw new Error('solana_rfq did not become executable on Surfpool');
  console.log(`[harness] deployed ${PROGRAM_ID.toBase58()} (${bytes.length} bytes)`);
}

function writeKeypair(path, key) {
  writeFileSync(path, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600 });
}

async function main() {
  mkdirSync(LOCAL_DIR, { recursive: true });
  const soPath = buildProgram();
  writeKeypair(SELLER_KEY_PATH, seller);
  writeKeypair(MAKER_KEY_PATH, maker);
  let startedHere = false;
  if (!(await rpcUp())) {
    startSurfpool();
    startedHere = true;
    await waitForRpc();
  }
  const connection = new Connection(RPC_URL, 'confirmed');
  for (const key of [seller, maker, vault, guardian, feeRecipient, stockAuthority]) {
    await setAccount(key.publicKey, 2_000_000_000, SYSTEM_PROGRAM);
  }
  await deployProgram(soPath);

  const stockFingerprint = digest(Buffer.alloc(0));
  const issuerFingerprint = digest(stockAuthority.publicKey.toBuffer());
  await setAccount(stockMint.publicKey, 1_000_000_000, TOKEN_PROGRAM,
    encodeMintAccount(stockAuthority.publicKey, 6, 2_500_000));
  for (const mint of STABLE_MINTS) {
    await setAccount(mint, 1_000_000_000, TOKEN_PROGRAM,
      encodeMintAccount(stockAuthority.publicKey, 6, 1_000_000_000_000n));
  }

  const sellerStock = await provisionTokenAccount(connection, seller.publicKey, stockMint.publicKey, 2_500_000);
  const makerStock = await provisionTokenAccount(connection, maker.publicKey, stockMint.publicKey, 0);
  const makerStableAccounts = {};
  const sellerStableAccounts = {};
  const feeStableAccounts = {};
  for (const mint of STABLE_MINTS) {
    const key = mint.toBase58();
    makerStableAccounts[key] = (await provisionTokenAccount(connection, maker.publicKey, mint, 1_000_000_000_000)).toBase58();
    sellerStableAccounts[key] = (await provisionTokenAccount(connection, seller.publicKey, mint, 0)).toBase58();
    feeStableAccounts[key] = (await provisionTokenAccount(connection, feeRecipient.publicKey, mint, 0)).toBase58();
  }

  const { default: idl } = await import('../contracts/solana-rfq/target/idl/solana_rfq.json', { with: { type: 'json' } });
  const governance = pda(Buffer.from('governance'));
  const makerRegistry = pda(Buffer.from('makers'));
  const assetRegistry = pda(Buffer.from('asset'), stockMint.publicKey.toBuffer());
  const instruction = (name, accounts, args = Buffer.alloc(0)) => {
    const definition = idl.instructions.find((entry) => entry.name === name);
    if (!definition) throw new Error(`solana_rfq IDL is missing ${name}`);
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: definition.accounts.map((account) => ({
        pubkey: accounts[account.name], isSigner: account.signer === true, isWritable: account.writable === true,
      })),
      data: Buffer.concat([Buffer.from(definition.discriminator), args]),
    });
  };
  const send = async (ix) => {
    const blockhash = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: vault.publicKey, ...blockhash }).add(ix);
    return sendAndConfirmTransaction(connection, tx, [vault], { commitment: 'confirmed' });
  };
  const policyAccounts = [governance, makerRegistry, assetRegistry];
  const existingPolicy = await Promise.all(policyAccounts.map((address) => connection.getAccountInfo(address, 'confirmed')));
  const existingCount = existingPolicy.filter(Boolean).length;
  if (existingCount === 0) {
    await send(instruction('initialize_governance', {
      governance, squads_vault: vault.publicKey, system_program: SYSTEM_PROGRAM,
    }, guardian.publicKey.toBuffer()));
    await send(instruction('initialize_maker_registry', {
      governance, squads_vault: vault.publicKey, maker_registry: makerRegistry, system_program: SYSTEM_PROGRAM,
    }, Buffer.concat([u32(1), maker.publicKey.toBuffer()])));
    await send(instruction('initialize_asset_registry', {
      governance, squads_vault: vault.publicKey, stock_mint: stockMint.publicKey,
      stock_token_program: TOKEN_PROGRAM, stable_token_program: TOKEN_PROGRAM,
      asset_registry: assetRegistry, system_program: SYSTEM_PROGRAM,
    }, Buffer.concat([
      Buffer.from([0]), STABLE_MINTS[0].toBuffer(), STABLE_MINTS[1].toBuffer(), stockFingerprint,
      optionKey(null), u32(0), stockAuthority.publicKey.toBuffer(), stockAuthority.publicKey.toBuffer(),
      issuerFingerprint, optionKey(null), Buffer.alloc(32),
    ])));
  } else if (existingCount !== policyAccounts.length || existingPolicy.some((account) => !account?.owner.equals(PROGRAM_ID))) {
    throw new Error('localnet policy fixture is only partially initialized or has an unexpected owner');
  } else {
    console.log('[harness] reusing the initialized local governance policy; resetting test token balances');
  }

  const stableStrings = STABLE_MINTS.map((mint) => mint.toBase58());
  const asset = {
    mint: stockMint.publicKey.toBase58(), issuer: 'xstocks', ticker: 'AAPLx TEST', underlyingTicker: 'AAPL',
    tokenProgram: 'spl-token', decimals: 6,
    issuerAuthorityFingerprint: issuerFingerprint.toString('hex'),
    expectedMetadataPointer: stockAuthority.publicKey.toBase58(),
    extensionFingerprint: stockFingerprint.toString('hex'),
    capabilities: {
      transferHook: false, pausable: false, scaledUiAmount: false, transferFee: false,
      permanentDelegate: false, memoTransfer: false, confidentialTransfer: false,
    },
    supportedOutputs: stableStrings, referenceState: 'open', referencePriceAtomic: '100000000',
    referencePriceDecimals: 6, referenceTimestampMs: Date.now(), maxDeviationBps: 150,
    enabled: true, registryVersion: 1,
  };
  const config = {
    rpcUrl: RPC_URL, chain: 'solana:localnet', programId: PROGRAM_ID.toBase58(), programLoaded: true,
    programArtifact: soPath, governance: governance.toBase58(), governanceVault: vault.publicKey.toBase58(),
    makerRegistry: makerRegistry.toBase58(), assetRegistry: assetRegistry.toBase58(), feeBps: 10,
    stockMint: stockMint.publicKey.toBase58(), stockTokenProgram: TOKEN_PROGRAM.toBase58(), stockDecimals: 6,
    stockExtensionFingerprint: stockFingerprint.toString('hex'), stockIssuerAuthority: stockAuthority.publicKey.toBase58(),
    sellerStockAccount: sellerStock.toBase58(), makerStockAccount: makerStock.toBase58(),
    stableMints: stableStrings, stableTokenProgram: TOKEN_PROGRAM.toBase58(),
    makerStableAccounts, sellerStableAccounts, feeStableAccounts,
    feeRecipient: feeRecipient.publicKey.toBase58(), makerPublicKey: maker.publicKey.toBase58(),
    sellerPublicKey: seller.publicKey.toBase58(), sellerPubkey: seller.publicKey.toBase58(),
    makerKeypairPath: MAKER_KEY_PATH, sellerKeypairPath: SELLER_KEY_PATH, asset,
    testAssets: true, testAssetLabel: 'LOCALNET TEST ASSETS ONLY — no mainnet issuer backing',
    apiPort: Number(process.env.SOLANA_API_PORT ?? 8787), startedSurfpoolHere: startedHere,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`[harness] wrote ${CONFIG_PATH}`);
  console.log(`[harness] Seller ${seller.publicKey.toBase58()} · stock ${sellerStock.toBase58()}`);
  console.log(`[harness] Maker ${maker.publicKey.toBase58()} · stable accounts ${Object.values(makerStableAccounts).join(', ')}`);
  console.log(`[harness] fee account ${Object.values(feeStableAccounts).join(', ')}`);
  console.log('[harness] local USDC and USDT identities are test fixtures; no Devnet or Mainnet transaction was sent');
  console.log('Start the Seller API with: KATON_LOCALNET=1 SOLANA_RPC_URL=' + RPC_URL + ' npm run dev:solana-api:localnet');
}

main().catch((error) => {
  console.error('[harness] FAILED', error);
  process.exitCode = 1;
});
