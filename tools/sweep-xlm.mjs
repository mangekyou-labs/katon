// sweep-xlm.mjs — TESTNET-ONLY. Sweep friendbot-funded temp accounts into a
// target account via accountMerge until it holds TARGET_XLM native XLM.
//
// account-merge is signed by the temp source, so the DESTINATION needs no
// signature — this works against any public key (e.g. a Freighter wallet).
//
//   TARGET_G=<G...> TARGET_XLM=3100000 node tools/sweep-xlm.mjs

import { Keypair, Networks, Operation, TransactionBuilder, Horizon } from '@stellar/stellar-sdk';
import { setTimeout as sleep } from 'node:timers/promises';

const HORIZON = 'https://horizon-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const NETWORK = Networks.TESTNET;
const FEE = '1000';
const TIMEOUT = 60;

const TARGET_G = process.env.TARGET_G;
const TARGET_XLM = parseFloat(process.env.TARGET_XLM || '3100000');
if (!TARGET_G) throw new Error('set TARGET_G');

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
    } catch (e) {
      log(`  friendbot error ${e.message} (try ${i + 1}/${retries})`);
    }
    await sleep(8000);
  }
  return false;
}

function nativeBalance(acct) {
  const b = acct.balances.find((x) => x.asset_type === 'native');
  return b ? parseFloat(b.balance) : 0;
}

async function main() {
  let taker = await server.loadAccount(TARGET_G);   // 404s if the target does not exist — that's a real error
  let bal = nativeBalance(taker);
  log(`sweep -> ${TARGET_G.slice(0, 6)}… start XLM = ${bal} (target ${TARGET_XLM})`);

  let round = 0;
  let failures = 0;
  while (bal < TARGET_XLM) {
    round++;
    try {
      const temp = Keypair.random();
      if (!(await friendbotFund(temp.publicKey()))) {
        failures++;
        log(`round ${round}: friendbot hard-failed`);
        if (failures >= 10) { log('friendbot hard-failed too many times — stopping.'); break; }
        await sleep(8000);
        continue;
      }
      const src = await server.loadAccount(temp.publicKey());
      const tx = new TransactionBuilder(src, { fee: FEE, networkPassphrase: NETWORK })
        .addOperation(Operation.accountMerge({ destination: TARGET_G }))
        .setTimeout(TIMEOUT).build();
      tx.sign(temp);
      await server.submitTransaction(tx);
    } catch (e) {
      failures++;
      const codes = e?.response?.data?.extras?.result_codes;
      log(`round ${round}: failed (${codes ? JSON.stringify(codes) : e.message}) — continuing`);
    }
    await sleep(1500);
    if (round % 10 === 0) {
      taker = await server.loadAccount(TARGET_G);
      bal = nativeBalance(taker);
      log(`round ${round}: XLM = ${bal} / ${TARGET_XLM} (${((bal / TARGET_XLM) * 100).toFixed(1)}%)`);
    }
  }

  taker = await server.loadAccount(TARGET_G);
  bal = nativeBalance(taker);
  log(`sweep done at round ${round}: XLM = ${bal} (target ${TARGET_XLM}, reached=${bal >= TARGET_XLM})`);
}

main().catch((e) => {
  console.error('FATAL:', e?.response?.data?.extras?.result_codes ?? e);
  process.exit(1);
});
