// fund-demo.mjs — TESTNET-ONLY demo funding for TrustRFQ.
//
// Becomes our own USDC issuer (Circle's testnet USDC cannot be minted), then:
//   - resolves maker/taker (from PARAMETERS secrets, or generates + friendbot-funds fresh ones)
//   - opens USDC trustlines from maker AND taker to the new issuer
//   - mints the preset USDC amount from issuer -> maker
//   - sweeps friendbot-funded temp accounts into taker until it holds the preset XLM target
//
// Idempotent: every skip decision is made from live Horizon state, not local assumptions.
// Never touches mainnet. Secrets are written to demo-keys.json (gitignored) and printed at the end.

import {
  Keypair, Networks, Asset, Operation, TransactionBuilder, Horizon, BASE_FEE,
} from '@stellar/stellar-sdk';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// PARAMETERS (edit before running if needed)
// ---------------------------------------------------------------------------
const PRESETS = {
  '1M':   { usdc: '1050000', xlm: 3100000 },
  '100k': { usdc: '105000',  xlm: 320000 },
};
// Env overrides let us drive real (Freighter-held) wallets without editing the file:
//   SIZE_PRESET, MAKER_S, TAKER_S, and SKIP_SWEEP=1 (do trustlines+mint only).
const SIZE_PRESET = process.env.SIZE_PRESET || '1M';   // '1M' or '100k'
const MAKER_S = process.env.MAKER_S || '';             // empty -> generate + friendbot-fund a fresh maker
const TAKER_S = process.env.TAKER_S || '';             // empty -> generate + friendbot-fund a fresh taker
const SKIP_SWEEP = process.env.SKIP_SWEEP === '1';     // skip the XLM sweep (handled separately)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HORIZON = 'https://horizon-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const NETWORK = Networks.TESTNET;
const FEE = '1000';              // stroops per op
const TIMEOUT = 60;
const TRUST_LIMIT = '100000000';
const KEYS_FILE = new URL('../demo-keys.json', import.meta.url);

const preset = PRESETS[SIZE_PRESET];
if (!preset) throw new Error(`unknown SIZE_PRESET ${SIZE_PRESET}`);

const server = new Horizon.Server(HORIZON);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function friendbotFund(pub, { retries = 10 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
      if (res.ok) return true;
      const body = await res.text();
      // A 400 "createAccountAlreadyExist" means the account is already funded — fine.
      if (res.status === 400 && /already.?exist|op_already_exists/i.test(body)) return true;
      log(`  friendbot ${res.status} for ${pub.slice(0, 6)} (try ${i + 1}/${retries})`);
    } catch (e) {
      log(`  friendbot error ${e.message} (try ${i + 1}/${retries})`);
    }
    await sleep(8000);
  }
  return false;
}

async function loadAccountOrNull(pub) {
  try {
    return await server.loadAccount(pub);
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

function nativeBalance(acct) {
  const b = acct.balances.find((x) => x.asset_type === 'native');
  return b ? parseFloat(b.balance) : 0;
}

function assetBalance(acct, code, issuer) {
  const b = acct.balances.find(
    (x) => x.asset_code === code && x.asset_issuer === issuer,
  );
  return b ? parseFloat(b.balance) : 0;
}

function hasTrustline(acct, code, issuer) {
  return acct.balances.some((x) => x.asset_code === code && x.asset_issuer === issuer);
}

async function submit(sourceKp, buildOps, { source } = {}) {
  const acct = await server.loadAccount(source ?? sourceKp.publicKey());
  const builder = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: NETWORK });
  for (const op of buildOps) builder.addOperation(op);
  const tx = builder.setTimeout(TIMEOUT).build();
  tx.sign(sourceKp);
  try {
    return await server.submitTransaction(tx);
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    if (codes) log('  tx rejected result_codes:', JSON.stringify(codes));
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Persisted keys
// ---------------------------------------------------------------------------
function loadKeys() {
  if (existsSync(KEYS_FILE)) {
    try { return JSON.parse(readFileSync(KEYS_FILE, 'utf8')); } catch { /* ignore */ }
  }
  return {};
}
function saveKeys(keys) {
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`TESTNET demo funding — preset ${SIZE_PRESET} (mint ${preset.usdc} USDC, sweep to ${preset.xlm} XLM)`);
  const keys = loadKeys();

  // a. Resolve maker / taker ------------------------------------------------
  let makerKp;
  if (MAKER_S) {
    makerKp = Keypair.fromSecret(MAKER_S);
    keys.maker_generated = false;   // supplied (user-owned) — never store/print this secret
    delete keys.maker_secret;
    log(`maker: using supplied ${makerKp.publicKey()}`);
  } else if (keys.maker_secret) {
    makerKp = Keypair.fromSecret(keys.maker_secret);
    log(`maker: reusing ${makerKp.publicKey()}`);
  } else {
    makerKp = Keypair.random();
    keys.maker_secret = makerKp.secret();
    keys.maker_generated = true;
    log(`maker: generated ${makerKp.publicKey()}`);
  }
  keys.maker_public = makerKp.publicKey();

  let takerKp;
  if (TAKER_S) {
    takerKp = Keypair.fromSecret(TAKER_S);
    keys.taker_generated = false;   // supplied (user-owned) — never store/print this secret
    delete keys.taker_secret;
    log(`taker: using supplied ${takerKp.publicKey()}`);
  } else if (keys.taker_secret) {
    takerKp = Keypair.fromSecret(keys.taker_secret);
    log(`taker: reusing ${takerKp.publicKey()}`);
  } else {
    takerKp = Keypair.random();
    keys.taker_secret = takerKp.secret();
    keys.taker_generated = true;
    log(`taker: generated ${takerKp.publicKey()}`);
  }
  keys.taker_public = takerKp.publicKey();
  saveKeys(keys);

  // Ensure maker/taker exist on-chain (fund fresh/generated ones).
  for (const [role, kp] of [['maker', makerKp], ['taker', takerKp]]) {
    if (!(await loadAccountOrNull(kp.publicKey()))) {
      log(`${role}: not on-chain, friendbot funding…`);
      if (!(await friendbotFund(kp.publicKey()))) throw new Error(`friendbot failed to fund ${role}`);
    }
  }

  // b. Issuer keypair -------------------------------------------------------
  let issuerKp;
  if (keys.issuer_secret) {
    issuerKp = Keypair.fromSecret(keys.issuer_secret);
    log(`issuer: reusing ${issuerKp.publicKey()}`);
  } else {
    issuerKp = Keypair.random();
    keys.issuer_secret = issuerKp.secret();
    keys.issuer_public = issuerKp.publicKey();
    saveKeys(keys);
    log(`issuer: generated ${issuerKp.publicKey()}`);
  }
  keys.issuer_public = issuerKp.publicKey();
  saveKeys(keys);
  if (!(await loadAccountOrNull(issuerKp.publicKey()))) {
    log('issuer: not on-chain, friendbot funding…');
    if (!(await friendbotFund(issuerKp.publicKey()))) throw new Error('friendbot failed to fund issuer');
  }

  const USDC = new Asset('USDC', issuerKp.publicKey());
  const ISSUER = issuerKp.publicKey();

  // c. Trustlines maker & taker -> USDC ------------------------------------
  for (const [role, kp] of [['maker', makerKp], ['taker', takerKp]]) {
    const acct = await server.loadAccount(kp.publicKey());
    if (hasTrustline(acct, 'USDC', ISSUER)) {
      log(`${role}: USDC trustline already present, skipping`);
    } else {
      log(`${role}: opening USDC trustline (limit ${TRUST_LIMIT})…`);
      await submit(kp, [Operation.changeTrust({ asset: USDC, limit: TRUST_LIMIT })]);
      log(`${role}: trustline opened`);
    }
  }

  // d. Mint USDC issuer -> maker -------------------------------------------
  {
    const makerAcct = await server.loadAccount(makerKp.publicKey());
    const held = assetBalance(makerAcct, 'USDC', ISSUER);
    if (held >= parseFloat(preset.usdc)) {
      log(`maker: already holds ${held} USDC (>= ${preset.usdc}), skipping mint`);
    } else {
      log(`maker: minting ${preset.usdc} USDC from issuer…`);
      await submit(issuerKp, [
        Operation.payment({ destination: makerKp.publicKey(), asset: USDC, amount: preset.usdc }),
      ]);
      log('maker: mint complete');
    }
  }

  // e. Sweep XLM into taker until target -----------------------------------
  const target = preset.xlm;
  let round = 0;
  let failures = 0;
  let taker = await server.loadAccount(takerKp.publicKey());
  let bal = nativeBalance(taker);
  log(`taker: starting XLM balance ${bal} (target ${target})`);

  while (!SKIP_SWEEP && bal < target) {
    round++;
    try {
      const temp = Keypair.random();
      const funded = await friendbotFund(temp.publicKey());
      if (!funded) {
        failures++;
        log(`round ${round}: friendbot hard-failed`);
        if (failures >= 10) {
          log('friendbot hard-failed too many times — stopping sweep and reporting.');
          break;
        }
        await sleep(8000);
        continue;
      }
      // Merge the temp account's whole balance into taker.
      await submit(temp, [Operation.accountMerge({ destination: takerKp.publicKey() })]);
    } catch (e) {
      failures++;
      log(`round ${round}: failed (${e.message}) — continuing`);
    }
    await sleep(1500);

    if (round % 10 === 0) {
      taker = await server.loadAccount(takerKp.publicKey());
      bal = nativeBalance(taker);
      log(`round ${round}: taker XLM = ${bal} / ${target} (${((bal / target) * 100).toFixed(1)}%)`);
    }
  }

  // Final read of taker balance.
  taker = await server.loadAccount(takerKp.publicKey());
  bal = nativeBalance(taker);
  log(`sweep done at round ${round}: taker XLM = ${bal} (target ${target})`);

  // Final summary block -----------------------------------------------------
  const makerAcct = await server.loadAccount(makerKp.publicKey());
  const takerAcct = await server.loadAccount(takerKp.publicKey());
  const summary = {
    preset: SIZE_PRESET,
    issuer_public: ISSUER,
    maker_public: makerKp.publicKey(),
    maker_secret: keys.maker_generated ? makerKp.secret() : '(supplied — not printed)',
    taker_public: takerKp.publicKey(),
    taker_secret: keys.taker_generated ? takerKp.secret() : '(supplied — not printed)',
    maker_usdc: assetBalance(makerAcct, 'USDC', ISSUER),
    maker_xlm: nativeBalance(makerAcct),
    taker_xlm: nativeBalance(takerAcct),
    maker_trustline: hasTrustline(makerAcct, 'USDC', ISSUER),
    taker_trustline: hasTrustline(takerAcct, 'USDC', ISSUER),
    target_xlm_reached: bal >= target,
  };
  saveKeys({ ...keys, summary });

  console.log('\n===== FUND-DEMO SUMMARY (TESTNET) =====');
  console.log(JSON.stringify(summary, null, 2));
  console.log('=======================================\n');
  console.log(`ISSUER_G=${ISSUER}`);
}

main().catch((e) => {
  console.error('FATAL:', e?.response?.data?.extras?.result_codes ?? e);
  process.exit(1);
});
