// derive-keys.mjs — TESTNET demo helper. Derive Stellar keypairs from a BIP39
// recovery phrase (SEP-0005: m/44'/148'/i') and match two target public keys.
//
// The mnemonic is read from env (MNEMONIC) so no seed is written into a tracked
// file. Matched SECRETS are written only to OUT (a gitignored scratchpad path);
// stdout prints public keys + matched indices only, never secrets.
//
//   MNEMONIC="w1 w2 …" TARGETS="G...,G..." OUT=/abs/derived.json node tools/derive-keys.mjs

import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@stellar/stellar-sdk';
import { writeFileSync } from 'node:fs';

const MNEMONIC = (process.env.MNEMONIC || '').trim();
const TARGETS = (process.env.TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = process.env.OUT;
if (!MNEMONIC) throw new Error('set MNEMONIC');
if (!TARGETS.length) throw new Error('set TARGETS');
if (!OUT) throw new Error('set OUT');

if (!bip39.validateMnemonic(MNEMONIC)) throw new Error('invalid BIP39 mnemonic');
const seed = bip39.mnemonicToSeedSync(MNEMONIC, ''); // empty passphrase (Freighter default)

const found = {}; // pubkey -> secret
const SCAN = 30;
for (let i = 0; i < SCAN; i++) {
  const { key } = derivePath(`m/44'/148'/${i}'`, seed.toString('hex'));
  const kp = Keypair.fromRawEd25519Seed(key);
  const pub = kp.publicKey();
  if (TARGETS.includes(pub)) {
    found[pub] = kp.secret();
    console.log(`matched ${pub} at m/44'/148'/${i}'`);
  }
}

const missing = TARGETS.filter((t) => !found[t]);
if (missing.length) {
  console.log(`NOT FOUND within first ${SCAN} accounts:`, missing.join(', '));
}

writeFileSync(OUT, JSON.stringify(found, null, 2) + '\n');
console.log(`wrote ${Object.keys(found).length} secret(s) to ${OUT}`);
