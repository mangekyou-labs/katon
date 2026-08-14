// Read-only Reflector price read. The one new network surface for the fair-price
// suggestion. Simulates `lastprice(Asset::Other(symbol))` on the oracle contract
// and returns the USD price + timestamp, or null on any failure.
//
// Read-only: never signed, never submitted, never on the settlement path. A
// contract-call SIMULATION does not require the source account to exist, so a
// synthetic source is used — the price is independent of wallet connection.

import * as Stellar from '@stellar/stellar-sdk';
import { PASSPHRASE, REFLECTOR_ORACLE_ID, RPC_URL, fairPriceEnabled } from '../config';

export interface PriceData {
  /** i128 USD price scaled by the oracle's decimals (14 on this feed) */
  price: bigint;
  /** unix seconds of the last update */
  timestamp: number;
}

// A valid strkey that need not exist on-chain — simulation ignores the source
// account's ledger state for a read-only contract call (verified on testnet).
const SIM_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Reflector's `Asset::Other(Symbol)` as an ScVal vec ["Other", <symbol>]. */
function assetOther(symbol: string): Stellar.xdr.ScVal {
  return Stellar.xdr.ScVal.scvVec([
    Stellar.xdr.ScVal.scvSymbol('Other'),
    Stellar.xdr.ScVal.scvSymbol(symbol),
  ]);
}

export async function fetchLastPrice(symbol: string): Promise<PriceData | null> {
  if (!fairPriceEnabled) return null;
  try {
    const server = new Stellar.rpc.Server(RPC_URL);
    const source = new Stellar.Account(SIM_SOURCE, '0');
    const tx = new Stellar.TransactionBuilder(source, {
      fee: Stellar.BASE_FEE, networkPassphrase: PASSPHRASE,
    })
      .addOperation(new Stellar.Contract(REFLECTOR_ORACLE_ID).call('lastprice', assetOther(symbol)))
      .setTimeout(30).build();

    const sim = await server.simulateTransaction(tx);
    if (Stellar.rpc.Api.isSimulationError(sim) || !sim.result) return null;

    // Option<PriceData>: null when the asset has no price
    const val = Stellar.scValToNative(sim.result.retval) as
      | { price: bigint; timestamp: bigint } | null;
    if (!val || typeof val.price !== 'bigint') return null;
    return { price: val.price, timestamp: Number(val.timestamp) };
  } catch {
    return null;
  }
}
