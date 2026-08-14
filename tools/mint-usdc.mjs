// mint-usdc.mjs — TESTNET-ONLY one-off: fund a target with a custom USDC amount
// from the repo's existing demo issuer.
//   - friendbot-funds TARGET if it doesn't exist
//   - opens a USDC trustline from TARGET -> issuer (signed by TARGET's secret)
//   - mints AMOUNT USDC issuer -> TARGET
// Idempotent from live Horizon state. Never touches mainnet.
//
//   TARGET_S=<S...> AMOUNT=570000 node mint-usdc.mjs

import { Keypair, Networks, Asset, Operation, TransactionBuilder, Horizon } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const HORIZON = 'https://horizon-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const NETWORK = Networks.TESTNET;
const FEE = '1000';
const TIMEOUT = 60;
const TRUST_LIMIT = '100000000';

const TARGET_S = process.env.TARGET_S;
const AMOUNT = process.env.AMOUNT || '570000';
if (!TARGET_S) throw new Error('set TARGET_S');

// Reuse the repo's demo issuer so it's the SAME USDC asset as prior demos.
const keys = JSON.parse(readFileSync('/Users/acakbin1881/Projects/TrustRFQ/demo-keys.json', 'utf8'));
const issuerKp = Keypair.fromSecret(keys.issuer_secret);
const ISSUER = issuerKp.publicKey();
const USDC = new Asset('USDC', ISSUER);

const targetKp = Keypair.fromSecret(TARGET_S);
const TARGET = targetKp.publicKey();

const server = new Horizon.Server(HORIZON);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function friendbotFund(pub, retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
      if (res.ok) return true;
      const body = await res.text();
      if (res.status === 400 && /already.?exist|op_already_exists/i.test(body)) return true;
      log(`  friendbot ${res.status} (try ${i + 1}/${retries})`);
    } catch (e) { log(`  friendbot error ${e.message} (try ${i + 1}/${retries})`); }
    await sleep(8000);
  }
  return false;
}
async function loadOrNull(pub) {
  try { return await server.loadAccount(pub); }
  catch (e) { if (e?.response?.status === 404) return null; throw e; }
}
function assetBalance(acct, code, issuer) {
  const b = acct.balances.find((x) => x.asset_code === code && x.asset_issuer === issuer);
  return b ? parseFloat(b.balance) : 0;
}
function hasTrustline(acct, code, issuer) {
  return acct.balances.some((x) => x.asset_code === code && x.asset_issuer === issuer);
}
async function submit(sourceKp, ops) {
  const acct = await server.loadAccount(sourceKp.publicKey());
  const b = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: NETWORK });
  for (const op of ops) b.addOperation(op);
  const tx = b.setTimeout(TIMEOUT).build();
  tx.sign(sourceKp);
  try { return await server.submitTransaction(tx); }
  catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    if (codes) log('  tx rejected:', JSON.stringify(codes));
    throw e;
  }
}

async function main() {
  log(`TESTNET mint ${AMOUNT} USDC (${ISSUER.slice(0, 6)}…) -> ${TARGET.slice(0, 6)}…`);

  if (!(await loadOrNull(TARGET))) {
    log('target not on-chain, friendbot funding…');
    if (!(await friendbotFund(TARGET))) throw new Error('friendbot failed');
  }

  let acct = await server.loadAccount(TARGET);
  if (hasTrustline(acct, 'USDC', ISSUER)) {
    log('trustline already present, skipping');
  } else {
    log('opening USDC trustline…');
    await submit(targetKp, [Operation.changeTrust({ asset: USDC, limit: TRUST_LIMIT })]);
    log('trustline opened');
  }

  acct = await server.loadAccount(TARGET);
  const held = assetBalance(acct, 'USDC', ISSUER);
  if (held >= parseFloat(AMOUNT)) {
    log(`already holds ${held} USDC (>= ${AMOUNT}), skipping mint`);
  } else {
    log(`minting ${AMOUNT} USDC…`);
    await submit(issuerKp, [Operation.payment({ destination: TARGET, asset: USDC, amount: AMOUNT })]);
    log('mint complete');
  }

  acct = await server.loadAccount(TARGET);
  log(`DONE. ${TARGET} holds ${assetBalance(acct, 'USDC', ISSUER)} USDC`);
  console.log(`ISSUER_G=${ISSUER}`);
}

main().catch((e) => { console.error('FATAL:', e?.response?.data?.extras?.result_codes ?? e); process.exit(1); });
