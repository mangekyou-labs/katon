// ---------------------------------------------------------------------------
// On-chain settlement — chain operations only.
// ---------------------------------------------------------------------------
// Ported line-for-line from otc.js. Two deliberate boundaries:
//
//   1. The wallet is INJECTED as a WalletSigner (the SEP-43 subset the flows
//      need) instead of importing the kit — so this module never touches UI
//      state and the signing dependency is visible in the signature.
//   2. No Supabase, no toasts: DB writes and user feedback live in the caller
//      (useSettlement). This module talks to the chain and nothing else.
//
// The security model (STELLAR.md §0/§3): both parties sign Address-credential
// auth entries over the exact fillCanonicalArgs; the submit is permissionless
// and uses an enforcing-mode simulation with both signed entries pre-attached,
// so tampered terms surface as a simulation error, never a signed tx.

import * as Stellar from '@stellar/stellar-sdk';
import { assetFor, fillCanonicalArgs } from './canonical';
import type { Order, Side } from './types';

/** The slice of SEP-43 these flows need; stellar-wallets-kit satisfies it. */
export interface WalletSigner {
  /** the connected wallet's address — every signature is requested for it */
  address: string;
  signTransaction(
    xdr: string,
    opts: { address: string; networkPassphrase: string },
  ): Promise<{ signedTxXdr: string }>;
  /**
   * Sign a Soroban auth-entry preimage. MUST resolve to the raw ed25519
   * signature bytes — normalising the wallet's own encoding is the adapter's
   * job (src/wallet/authSignature.ts), not this module's.
   */
  signAuthEntry(
    preimageXdr: string,
    opts: { address: string; networkPassphrase: string },
  ): Promise<Uint8Array>;
}

export interface ChainConfig {
  rpcUrl: string;
  horizonUrl: string;
  passphrase: string;
  contractId: string;
}

const rpc = (c: ChainConfig) => new Stellar.rpc.Server(c.rpcUrl);
const horizon = (c: ChainConfig) => new Stellar.Horizon.Server(c.horizonUrl);

/** address ('G…'/'C…') behind an address-credential auth entry, else null */
export function entryAddr(e: Stellar.xdr.SorobanAuthorizationEntry): string | null {
  try {
    return Stellar.Address.fromScAddress(e.credentials().address().address()).toString();
  } catch {
    return null;
  }
}

const fillHostFn = (c: ChainConfig, args: Stellar.xdr.ScVal[]) =>
  new Stellar.Contract(c.contractId).call('fill', ...args).body().invokeHostFunctionOp().hostFunction();

export async function waitForTx(server: Stellar.rpc.Server, hash: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const r = await server.getTransaction(hash);
    if (r.status === Stellar.rpc.Api.GetTransactionStatus.SUCCESS) return hash;
    if (r.status === Stellar.rpc.Api.GetTransactionStatus.FAILED) throw new Error('Transaction failed on-chain.');
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error('Timed out waiting for confirmation.');
}

/** make sure the signer can receive the (non-native) asset they're owed */
export async function ensureTrustline(c: ChainConfig, tokenStr: string, signer: WalletSigner): Promise<void> {
  const { asset, native } = assetFor(tokenStr);
  if (native) return;
  const h = horizon(c);
  const acct = await h.loadAccount(signer.address);
  if (acct.balances.some((b) => 'asset_code' in b && b.asset_code === asset.code && b.asset_issuer === asset.issuer)) return;
  const tx = new Stellar.TransactionBuilder(acct, { fee: Stellar.BASE_FEE, networkPassphrase: c.passphrase })
    .addOperation(Stellar.Operation.changeTrust({ asset })).setTimeout(180).build();
  const { signedTxXdr } = await signer.signTransaction(tx.toXDR(), {
    address: signer.address, networkPassphrase: c.passphrase,
  });
  await h.submitTransaction(Stellar.TransactionBuilder.fromXDR(signedTxXdr, c.passphrase) as Stellar.Transaction);
}

/** ledger until which a signed auth entry stays valid (≈ order expiry + buffer) */
export async function authValidUntil(c: ChainConfig, order: Pick<Order, 'expiration'>): Promise<number> {
  const { sequence } = await rpc(c).getLatestLedger();
  const remainMs = Math.max(0, new Date(order.expiration).getTime() - Date.now());
  return sequence + Math.min(Math.ceil(remainMs / 5000) + 120, 535670);
}

/**
 * Off-chain sign THIS party's authorization over the exact order terms
 * (replaces the old SAC `approve`). Simulated with the counterparty as source
 * so our own auth comes back as a signable address credential; returns the
 * signed entry as base64 XDR for the caller to store (maker_auth / taker_auth).
 */
export async function signFillAuth(c: ChainConfig, order: Order, side: Side, signer: WalletSigner): Promise<string> {
  const isMaker = side === 'maker';
  const myAddr = isMaker ? order.maker_address : order.taker_address;
  const otherAddr = isMaker ? order.taker_address : order.maker_address;
  const recvToken = isMaker ? order.taker_token : order.maker_token;

  await ensureTrustline(c, recvToken, signer);

  const server = rpc(c);
  const args = await fillCanonicalArgs(order, c.passphrase);
  // counterparty as source → our require_auth surfaces as a signable entry
  const src = await server.getAccount(otherAddr);
  const tx = new Stellar.TransactionBuilder(src, { fee: Stellar.BASE_FEE, networkPassphrase: c.passphrase })
    .addOperation(new Stellar.Contract(c.contractId).call('fill', ...args)).setTimeout(180).build();
  const sim = await server.simulateTransaction(tx);
  if (Stellar.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const mine = (sim.result?.auth || []).find((e) => entryAddr(e) === myAddr);
  if (!mine) throw new Error('No authorization entry for your address in the simulation.');

  const validUntil = await authValidUntil(c, order);
  const signed = await Stellar.authorizeEntry(
    mine,
    (preimage) => signer.signAuthEntry(preimage.toXDR('base64'), {
      address: myAddr, networkPassphrase: c.passphrase,
    }),
    validUntil, c.passphrase,
  );
  return signed.toXDR('base64');
}

/**
 * Settle: assemble both signed auth entries into one permissionless `fill`.
 * Whoever holds both signatures can submit; the signatures fix every term.
 * Returns the confirmed transaction hash.
 */
export async function submitFill(c: ChainConfig, order: Order, signer: WalletSigner): Promise<string> {
  if (!order.maker_auth || !order.taker_auth) throw new Error('Both parties must sign first.');

  const server = rpc(c);
  const hostFn = fillHostFn(c, await fillCanonicalArgs(order, c.passphrase));
  const auth = [
    Stellar.xdr.SorobanAuthorizationEntry.fromXDR(order.maker_auth, 'base64'),
    Stellar.xdr.SorobanAuthorizationEntry.fromXDR(order.taker_auth, 'base64'),
  ];
  const mkOp = () => Stellar.Operation.invokeHostFunction({ func: hostFn, auth });

  // enforcing-mode simulation (auth pre-attached) → footprint + resource fee
  const probe = new Stellar.TransactionBuilder(await server.getAccount(signer.address),
    { fee: Stellar.BASE_FEE, networkPassphrase: c.passphrase })
    .addOperation(mkOp()).setTimeout(180).build();
  const sim = await server.simulateTransaction(probe);
  if (Stellar.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);

  const fee = (BigInt(Stellar.BASE_FEE) + BigInt(sim.minResourceFee)).toString();
  const finalTx = new Stellar.TransactionBuilder(await server.getAccount(signer.address),
    { fee, networkPassphrase: c.passphrase })
    .addOperation(mkOp()).setSorobanData(sim.transactionData.build()).setTimeout(180).build();
  const { signedTxXdr } = await signer.signTransaction(finalTx.toXDR(), {
    address: signer.address, networkPassphrase: c.passphrase,
  });
  const sent = await server.sendTransaction(
    Stellar.TransactionBuilder.fromXDR(signedTxXdr, c.passphrase) as Stellar.Transaction,
  );
  if (sent.status === 'ERROR') throw new Error('Submit rejected: ' + JSON.stringify(sent.errorResult ?? sent.status));
  return waitForTx(server, sent.hash);
}
