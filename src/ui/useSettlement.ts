// Settlement orchestration: chain ops from core/fill.ts + DB state writes +
// user feedback. Ported from otc.js signOrderAuth/fillOrder — same guard
// order, same toast copy, same concurrent-submitter recovery.
//
// txBusy is a ref (the vanilla module-level mutex): one settlement action at a
// time across the whole desk, and it must not trigger re-renders.

import { useCallback, useRef } from 'react';
import { HORIZON_URL, OTC_CONTRACT_ID, PASSPHRASE, RPC_URL, settlementEnabled } from '../config';
import type { ChainConfig, WalletSigner } from '../core/fill';
import { signFillAuth, submitFill } from '../core/fill';
import { orderTokensKnown } from '../core/tokens';
import type { Order, Side } from '../core/types';
import { fetchSettlementStatus, updateOrder } from '../data/orders';
import { kit, walletSignAuthEntry } from '../wallet/kit';
import { errMsg, type ToastKind } from './Toast';

const chain: ChainConfig = {
  rpcUrl: RPC_URL,
  horizonUrl: HORIZON_URL,
  passphrase: PASSPHRASE,
  contractId: OTC_CONTRACT_ID,
};

const signerFor = (address: string): WalletSigner => ({
  address,
  signTransaction: (xdr, opts) => kit.signTransaction(xdr, opts),
  signAuthEntry: (preimage, opts) => walletSignAuthEntry(preimage, opts),
});

interface Deps {
  address: string | null;
  refresh: () => Promise<void>;
  toast: (msg: string, kind?: ToastKind) => void;
}

export function useSettlement({ address, refresh, toast }: Deps) {
  const txBusy = useRef(false);

  const signOrder = useCallback(async (order: Order, side: Side) => {
    if (!settlementEnabled) return toast('Settlement contract not configured (otc-config.js).', 'err');
    if (txBusy.current) return;
    const isMaker = side === 'maker';
    const myAddr = isMaker ? order.maker_address : order.taker_address;
    if (myAddr !== address) return toast('Connect the wallet for this leg first.', 'err');
    if (!orderTokensKnown(order)) return toast('This order references an unrecognized asset — refusing to sign.', 'err');

    txBusy.current = true;
    try {
      toast('Preparing your signature — check your wallet…');
      const signed = await signFillAuth(chain, order, side, signerFor(myAddr));
      const col = isMaker ? 'maker_auth' : 'taker_auth';
      const otherSigned = isMaker ? order.taker_auth : order.maker_auth;
      await updateOrder(order.id, {
        [col]: signed,
        settlement_status: otherSigned ? 'ready' : 'signing',
      });
      toast('Your authorization is signed.', 'ok');
      await refresh();
    } catch (err) {
      toast(errMsg(err, 'Signing failed.'), 'err');
    } finally {
      txBusy.current = false;
    }
  }, [address, refresh, toast]);

  const settle = useCallback(async (order: Order) => {
    if (!settlementEnabled) return toast('Settlement contract not configured (otc-config.js).', 'err');
    if (txBusy.current) return;
    if (!order.maker_auth || !order.taker_auth) return toast('Both parties must sign first.', 'err');
    if (order.settlement_status === 'settled') return toast('This order is already settled.', 'ok');
    if (!address) return;

    txBusy.current = true;
    try {
      let hash: string;
      try {
        await updateOrder(order.id, { settlement_status: 'settling' });
        await refresh();
        toast('Submitting settlement — check your wallet…');
        hash = await submitFill(chain, order, signerFor(address));
      } catch (err) {
        // A concurrent submitter (either party can settle) may have already filled
        // this order — our fill then reverts (contract `AlreadyFilled`, or a
        // waitForTx timeout while it lands). Never downgrade a settled order to
        // failed: re-check first, and scope the failure write to a still-'settling'
        // row so the winner's 'settled' is never clobbered.
        const fresh = await fetchSettlementStatus(order.id).catch(() => null);
        if (fresh === 'settled') {
          toast('Already settled on-chain 🎉', 'ok');
        } else {
          await updateOrder(order.id, {
            settlement_status: 'failed',
            settle_error: errMsg(err, 'Settlement failed.').slice(0, 400),
          }, { settlement_status: 'settling' }).catch(() => {});
          toast(errMsg(err, 'Settlement failed.'), 'err');
        }
        await refresh();
        return;
      }

      // Past this point the fill is CONFIRMED on-chain — the outcome is success
      // no matter what the database does. A failed bookkeeping write must never
      // fall into the recovery above (it would mark an executed trade 'failed'
      // and lose the tx hash); vanilla ignored errors on this exact write. On
      // failure the row simply stays 'settling' until a later reconcile.
      await updateOrder(order.id, {
        settlement_status: 'settled', settle_tx_hash: hash, settle_error: null,
        settled_at: new Date().toISOString(),
      }).catch(() => {});
      toast('Settled on-chain 🎉', 'ok');
      await refresh();
    } finally {
      txBusy.current = false;
    }
  }, [address, refresh, toast]);

  return { signOrder, settle };
}
