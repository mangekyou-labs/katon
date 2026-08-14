    import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
    // NOTE: must use esm.sh's ?bundle-deps — the default build leaves a CJS dep
    // (tweetnacl-util) with broken named-export interop, which throws on import
    // and stops the whole app from wiring up (Connect button does nothing).
    import {
      StellarWalletsKit,
      WalletNetwork,
      allowAllModules,
      FREIGHTER_ID,
    } from 'https://esm.sh/@creit.tech/stellar-wallets-kit@1.9.5?bundle-deps';
    import * as Stellar from 'https://esm.sh/@stellar/stellar-sdk@16?bundle-deps';
    import { Buffer } from 'https://esm.sh/buffer@6';
    // The signature boundary: the exact bytes both parties sign. Never re-derive
    // these here — see the header of canonical.js.
    import { assetFor, fillCanonicalArgs, canonicalPayload } from './canonical.js';
    globalThis.Buffer = globalThis.Buffer || Buffer;

    // --- config -----------------------------------------------------------
    const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

    const kit = new StellarWalletsKit({
      network: WalletNetwork.TESTNET,
      selectedWalletId: localStorage.getItem('otc_wallet_id') || FREIGHTER_ID,
      modules: allowAllModules(),
    });

    // token value stored on the order = code, or `CODE:ISSUER` for non-native
    const TOKENS = [
      { value: 'XLM', label: 'XLM' },
      { value: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', label: 'USDC' },
    ];
    const tokenLabel = (v) => (v || '').split(':')[0] || v;

    const ADDR_RE = /^G[A-Z2-7]{55}$/;

    const state = {
      address: localStorage.getItem('otc_address') || null,
      channels: [],
      incoming: [],
      sent: [],
    };

    // --- dom ---------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const gate = $('gate'), app = $('app');

    // --- helpers -----------------------------------------------------------
    // Escape any DB-sourced string before it enters innerHTML. Order rows are
    // writable by anyone holding the anon key (integrity is enforced on-chain,
    // not in the DB), so treat every stored field as attacker-controlled. The
    // CSP blocks injected <script>, but not injected markup/links — escape anyway.
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const trunc = (a) => a ? esc(`${a.slice(0, 5)}…${a.slice(-5)}`) : '';
    const isExpired = (o) => new Date(o.expiration).getTime() < Date.now();
    const isTxHash = (h) => /^[0-9a-f]{64}$/i.test(h || '');

    // Only these tokens are recognized. `tokenLabel` drops the issuer, so a
    // look-alike asset with an attacker-controlled issuer (e.g. USDC:GATTACKER…)
    // renders identically to the real one. Orders referencing an unknown token
    // are quarantined — no Accept, no Sign — and shown with a warning plus the
    // raw issuer so the user can see something is off.
    const TOKEN_VALUES = new Set(TOKENS.map((t) => t.value));
    const isKnownToken = (v) => TOKEN_VALUES.has(v);
    const orderTokensKnown = (o) => isKnownToken(o.maker_token) && isKnownToken(o.taker_token);
    function renderToken(v) {
      if (isKnownToken(v)) return esc(tokenLabel(v));
      const issuer = (v || '').split(':')[1];
      return `<span class="tok-warn" title="Unrecognized asset — verify the issuer before trading">⚠ ${esc(tokenLabel(v))}`
        + (issuer ? ` <span class="tok-iss">${trunc(issuer)}</span>` : '') + `</span>`;
    }

    function fmtRemaining(iso) {
      let ms = new Date(iso).getTime() - Date.now();
      if (ms <= 0) return 'expired';
      const d = Math.floor(ms / 86400000); ms -= d * 86400000;
      const h = Math.floor(ms / 3600000); ms -= h * 3600000;
      const m = Math.floor(ms / 60000);
      if (d) return `${d}d ${h}h`;
      if (h) return `${h}h ${m}m`;
      return `${m}m`;
    }

    let toastTimer;
    function toast(msg, kind = '') {
      const t = $('toast');
      t.textContent = msg;
      t.className = `show ${kind}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (t.className = ''), 4200);
    }

    // sign a UTF-8 message with the connected wallet. signMessage support is
    // wallet-dependent in Stellar Wallets Kit, and the return shape varies by
    // version, so feature-detect and normalise to a string.
    async function walletSign(message) {
      if (typeof kit.signMessage !== 'function') {
        throw new Error('This wallet does not support message signing.');
      }
      const res = await kit.signMessage(message, { address: state.address });
      let sig = res?.signedMessage ?? res?.signature ?? res;
      if (sig && typeof sig !== 'string') {
        // Buffer / Uint8Array -> base64
        const bytes = sig instanceof Uint8Array ? sig : new Uint8Array(sig.data ?? sig);
        sig = btoa(String.fromCharCode(...bytes));
      }
      if (!sig || typeof sig !== 'string') throw new Error('Wallet returned no signature.');
      return sig;
    }

    // --- wallet ------------------------------------------------------------
    function renderWalletChip() {
      const chip = $('walletChip');
      if (state.address) {
        chip.innerHTML = `
          <span class="wallet-chip__addr"><span class="wallet-chip__dot"></span>${trunc(state.address)}</span>
          <button class="btn btn--ghost btn--sm" id="disconnectBtn">Disconnect</button>`;
        $('disconnectBtn').onclick = disconnect;
      } else {
        chip.innerHTML = '';
      }
    }

    async function connect() {
      try {
        await kit.openModal({
          onWalletSelected: async (option) => {
            kit.setWallet(option.id);
            const { address } = await kit.getAddress();
            state.address = address;
            localStorage.setItem('otc_address', address);
            localStorage.setItem('otc_wallet_id', option.id);
            await onConnected();
          },
        });
      } catch (e) {
        toast(e?.message || 'Wallet connection cancelled.', 'err');
      }
    }

    function disconnect() {
      teardownRealtime();
      state.address = null;
      state.incoming = []; state.sent = [];
      localStorage.removeItem('otc_address');
      localStorage.removeItem('otc_wallet_id');
      gate.style.display = '';
      app.style.display = 'none';
      renderWalletChip();
    }

    async function onConnected() {
      renderWalletChip();
      $('makerAddrBox').textContent = state.address;
      gate.style.display = 'none';
      app.style.display = '';
      await Promise.all([loadIncoming(), loadSent()]);
      setupRealtime();
    }

    // --- create order ------------------------------------------------------
    function validAmount(v) { return /^\d+(\.\d{1,7})?$/.test(v) && parseFloat(v) > 0; }

    async function submitOrder(e) {
      e.preventDefault();
      const maker_amount = $('makerAmount').value.trim();
      const taker_amount = $('takerAmount').value.trim();
      const maker_token = $('makerToken').value;
      const taker_token = $('takerToken').value;
      const taker_address = $('takerAddress').value.trim();
      const expValue = parseInt($('expValue').value, 10);
      const expUnit = parseInt($('expUnit').value, 10);

      if (!validAmount(maker_amount)) return toast('Enter a valid "send" amount (max 7 decimals).', 'err');
      if (!validAmount(taker_amount)) return toast('Enter a valid "receive" amount (max 7 decimals).', 'err');
      if (!ADDR_RE.test(taker_address)) return toast('Counterparty address is not a valid Stellar address.', 'err');
      if (taker_address === state.address) return toast('Counterparty cannot be your own address.', 'err');
      if (!(expValue > 0)) return toast('Expiry must be greater than zero.', 'err');

      const order = {
        maker_address: state.address,
        maker_amount, maker_token,
        taker_address, taker_amount, taker_token,
        expiration: new Date(Date.now() + expValue * expUnit).toISOString(),
        nonce: crypto.randomUUID(),
      };

      const btn = $('sendBtn');
      btn.disabled = true; btn.textContent = 'Waiting for signature…';
      try {
        const signed_payload = canonicalPayload(order);
        const signature = await walletSign(signed_payload);

        const { error } = await supabase.from('orders').insert({
          ...order, signature, signed_payload, status: 'pending',
        });
        if (error) throw error;

        $('orderForm').reset();
        $('makerAddrBox').textContent = state.address;
        toast('Order signed and sent.', 'ok');
        await loadSent();
        switchTab('sent');
      } catch (err) {
        toast(err?.message || 'Could not send order.', 'err');
      } finally {
        btn.disabled = false; btn.textContent = 'Sign & send order';
      }
    }

    // --- load / render -----------------------------------------------------
    async function loadIncoming() {
      const { data, error } = await supabase.from('orders')
        .select('*').eq('taker_address', state.address)
        .order('created_at', { ascending: false });
      if (error) return toast('Failed to load incoming orders.', 'err');
      state.incoming = data || [];
      renderIncoming();
    }

    async function loadSent() {
      const { data, error } = await supabase.from('orders')
        .select('*').eq('maker_address', state.address)
        .order('created_at', { ascending: false });
      if (error) return toast('Failed to load sent orders.', 'err');
      state.sent = data || [];
      renderSent();
    }

    function statusBadge(o) {
      const expired = o.status === 'pending' && isExpired(o);
      const s = expired ? 'expired' : o.status;
      return `<span class="badge badge--${s}">${s}</span>`;
    }

    function renderIncoming() {
      const pending = state.incoming.filter((o) => o.status === 'pending' && !isExpired(o)).length;
      $('incCount').textContent = pending;
      const el = $('incomingList');
      if (!state.incoming.length) {
        el.innerHTML = `<div class="empty">No orders addressed to your wallet yet.</div>`;
        return;
      }
      el.innerHTML = state.incoming.map((o) => {
        const expired = o.status === 'pending' && isExpired(o);
        const known = orderTokensKnown(o);
        const canAct = o.status === 'pending' && !expired;
        return `
          <div class="order">
            <div class="order__top">
              <div class="order__party">From maker <b>${trunc(o.maker_address)}</b></div>
              ${statusBadge(o)}
            </div>
            <div class="legs">
              <div class="legbox legbox--in">
                <div class="legbox__k">You receive</div>
                <div class="legbox__v">${esc(o.maker_amount)}<span class="legbox__t">${renderToken(o.maker_token)}</span></div>
              </div>
              <div class="legs__swap" aria-hidden="true">⇄</div>
              <div class="legbox legbox--out">
                <div class="legbox__k">You send</div>
                <div class="legbox__v">${esc(o.taker_amount)}<span class="legbox__t">${renderToken(o.taker_token)}</span></div>
              </div>
            </div>
            <div class="order__meta">
              <span>${o.status === 'pending' ? (expired ? 'Expired' : `Expires in ${fmtRemaining(o.expiration)}`) : ''}</span>
              <span class="sig">✎ maker signed</span>
            </div>
            ${canAct && !known ? `
              <div class="settle__err">⚠ Unrecognized asset — verify the issuer shown above before trading. Accept is disabled.</div>` : ''}
            ${canAct ? `
              <div class="order__actions">
                ${known ? `<button class="btn btn--gold btn--sm" data-accept="${o.id}">Accept</button>` : ''}
                <button class="btn btn--danger btn--sm" data-decline="${o.id}">Decline</button>
              </div>` : ''}
            ${o.status === 'accepted' ? settlementStrip(o, 'taker') : ''}
          </div>`;
      }).join('');

      el.querySelectorAll('[data-accept]').forEach((b) =>
        (b.onclick = () => takerAction(b.getAttribute('data-accept'), 'accept')));
      el.querySelectorAll('[data-decline]').forEach((b) =>
        (b.onclick = () => takerAction(b.getAttribute('data-decline'), 'decline')));
      wireSettlement(el);
    }

    function renderSent() {
      $('sentCount').textContent = state.sent.filter((o) => o.status === 'pending' && !isExpired(o)).length;
      const el = $('sentList');
      if (!state.sent.length) {
        el.innerHTML = `<div class="empty">You haven't sent any orders yet.</div>`;
        return;
      }
      el.innerHTML = state.sent.map((o) => {
        const expired = o.status === 'pending' && isExpired(o);
        const canCancel = o.status === 'pending' && !expired;
        return `
          <div class="order">
            <div class="order__top">
              <div class="order__party">To taker <b>${trunc(o.taker_address)}</b></div>
              ${statusBadge(o)}
            </div>
            <div class="legs">
              <div class="legbox legbox--out">
                <div class="legbox__k">You send</div>
                <div class="legbox__v">${esc(o.maker_amount)}<span class="legbox__t">${renderToken(o.maker_token)}</span></div>
              </div>
              <div class="legs__swap" aria-hidden="true">⇄</div>
              <div class="legbox legbox--in">
                <div class="legbox__k">You receive</div>
                <div class="legbox__v">${esc(o.taker_amount)}<span class="legbox__t">${renderToken(o.taker_token)}</span></div>
              </div>
            </div>
            <div class="order__meta">
              <span>${o.status === 'pending' ? (expired ? 'Expired' : `Expires in ${fmtRemaining(o.expiration)}`) : ''}</span>
              ${o.taker_signature ? '<span class="sig is-done">✓ taker signed</span>' : ''}
            </div>
            ${canCancel ? `
              <div class="order__actions">
                <button class="btn btn--danger btn--sm" data-cancel="${o.id}">Cancel order</button>
              </div>` : ''}
            ${o.status === 'accepted' ? settlementStrip(o, 'maker') : ''}
          </div>`;
      }).join('');

      el.querySelectorAll('[data-cancel]').forEach((b) =>
        (b.onclick = () => cancelOrder(b.getAttribute('data-cancel'))));
      wireSettlement(el);
    }

    // --- taker / maker actions --------------------------------------------
    async function takerAction(orderId, action) {
      const order = state.incoming.find((o) => o.id === orderId);
      if (!order) return;
      if (isExpired(order)) return toast('This order has expired.', 'err');
      if (action === 'accept' && !orderTokensKnown(order))
        return toast('Unrecognized asset — verify the issuer before accepting.', 'err');
      try {
        const taker_signature = await walletSign(JSON.stringify({ order_id: orderId, action }));
        const status = action === 'accept' ? 'accepted' : 'declined';
        const { error } = await supabase.from('orders')
          .update({ status, taker_signature, updated_at: new Date().toISOString() })
          .eq('id', orderId).eq('status', 'pending');
        if (error) throw error;
        toast(action === 'accept' ? 'Order accepted.' : 'Order declined.', 'ok');
        await loadIncoming();
      } catch (err) {
        toast(err?.message || 'Action failed.', 'err');
      }
    }

    async function cancelOrder(orderId) {
      try {
        const { error } = await supabase.from('orders')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', orderId).eq('status', 'pending');
        if (error) throw error;
        toast('Order cancelled.', 'ok');
        await loadSent();
      } catch (err) {
        toast(err?.message || 'Could not cancel order.', 'err');
      }
    }

    // --- on-chain settlement (approve + fill) -----------------------------
    const RPC_URL = window.RPC_URL || 'https://soroban-testnet.stellar.org';
    const HORIZON_URL = window.HORIZON_URL || 'https://horizon-testnet.stellar.org';
    const PASSPHRASE = window.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
    const OTC_CONTRACT_ID = (window.OTC_CONTRACT_ID || '').trim();
    const settlementEnabled = /^C[A-Z2-7]{55}$/.test(OTC_CONTRACT_ID);
    const EXPLORER = 'https://stellar.expert/explorer/testnet';

    const rpc = () => new Stellar.rpc.Server(RPC_URL);
    const horizon = () => new Stellar.Horizon.Server(HORIZON_URL);
    let txBusy = false;

    const findOrder = (id) =>
      state.incoming.find((o) => o.id === id) || state.sent.find((o) => o.id === id);
    const refreshLists = () => Promise.all([loadIncoming(), loadSent()]);

    // address ('G…'/'C…') behind an address-credential auth entry, else null
    function entryAddr(e) {
      try { return Stellar.Address.fromScAddress(e.credentials().address().address()).toString(); }
      catch { return null; }
    }

    const fillHostFn = (args) =>
      new Stellar.Contract(OTC_CONTRACT_ID).call('fill', ...args).body().invokeHostFunctionOp().hostFunction();

    async function waitForTx(server, hash) {
      for (let i = 0; i < 30; i++) {
        const r = await server.getTransaction(hash);
        if (r.status === 'SUCCESS') return hash;
        if (r.status === 'FAILED') throw new Error('Transaction failed on-chain.');
        await new Promise((res) => setTimeout(res, 1500));
      }
      throw new Error('Timed out waiting for confirmation.');
    }

    // make sure `address` can receive the (non-native) asset they're owed
    async function ensureTrustline(tokenStr, address) {
      const { asset, native } = assetFor(tokenStr);
      if (native) return;
      const h = horizon();
      const acct = await h.loadAccount(address);
      if (acct.balances.some((b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer)) return;
      const tx = new Stellar.TransactionBuilder(acct, { fee: Stellar.BASE_FEE, networkPassphrase: PASSPHRASE })
        .addOperation(Stellar.Operation.changeTrust({ asset })).setTimeout(180).build();
      const { signedTxXdr } = await kit.signTransaction(tx.toXDR(), { address, networkPassphrase: PASSPHRASE });
      await h.submitTransaction(Stellar.TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE));
    }

    // ledger until which a signed auth entry stays valid (≈ order expiry + buffer)
    async function authValidUntil(order) {
      const { sequence } = await rpc().getLatestLedger();
      const remainMs = Math.max(0, new Date(order.expiration).getTime() - Date.now());
      return sequence + Math.min(Math.ceil(remainMs / 5000) + 120, 535670);
    }

    // side: 'maker' | 'taker'. Off-chain sign THIS party's authorization over the
    // exact order terms (replaces the old SAC `approve`). Simulated with the
    // counterparty as source so our own auth comes back as a signable address
    // credential; the signed entry (base64) is stored for a permissionless fill.
    async function signOrderAuth(order, side) {
      if (!settlementEnabled) return toast('Settlement contract not configured (otc-config.js).', 'err');
      if (txBusy) return;
      const isMaker = side === 'maker';
      const myAddr = isMaker ? order.maker_address : order.taker_address;
      const otherAddr = isMaker ? order.taker_address : order.maker_address;
      if (myAddr !== state.address) return toast('Connect the wallet for this leg first.', 'err');
      if (!orderTokensKnown(order)) return toast('This order references an unrecognized asset — refusing to sign.', 'err');
      const recvToken = isMaker ? order.taker_token : order.maker_token;

      txBusy = true;
      try {
        toast('Preparing your signature — check your wallet…');
        await ensureTrustline(recvToken, myAddr);

        const server = rpc();
        const args = await fillCanonicalArgs(order, PASSPHRASE);
        // counterparty as source → our require_auth surfaces as a signable entry
        const src = await server.getAccount(otherAddr);
        const tx = new Stellar.TransactionBuilder(src, { fee: Stellar.BASE_FEE, networkPassphrase: PASSPHRASE })
          .addOperation(new Stellar.Contract(OTC_CONTRACT_ID).call('fill', ...args)).setTimeout(180).build();
        const sim = await server.simulateTransaction(tx);
        if (Stellar.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
        const mine = (sim.result?.auth || []).find((e) => entryAddr(e) === myAddr);
        if (!mine) throw new Error('No authorization entry for your address in the simulation.');

        const validUntil = await authValidUntil(order);
        const signed = await Stellar.authorizeEntry(
          mine,
          async (preimage) => {
            const { signedAuthEntry } = await kit.signAuthEntry(preimage.toXDR('base64'),
              { address: myAddr, networkPassphrase: PASSPHRASE });
            return Buffer.from(signedAuthEntry, 'base64');
          },
          validUntil, PASSPHRASE,
        );

        const col = isMaker ? 'maker_auth' : 'taker_auth';
        const otherSigned = isMaker ? order.taker_auth : order.maker_auth;
        const { error } = await supabase.from('orders').update({
          [col]: signed.toXDR('base64'),
          settlement_status: otherSigned ? 'ready' : 'signing',
          updated_at: new Date().toISOString(),
        }).eq('id', order.id);
        if (error) throw error;
        toast('Your authorization is signed.', 'ok');
        await refreshLists();
      } catch (err) {
        toast(err?.message || 'Signing failed.', 'err');
      } finally {
        txBusy = false;
      }
    }

    // settle: assemble both signed auth entries into one permissionless `fill`.
    // Whoever holds both signatures can submit; the signatures fix every term.
    async function fillOrder(order) {
      if (!settlementEnabled) return toast('Settlement contract not configured (otc-config.js).', 'err');
      if (txBusy) return;
      if (!order.maker_auth || !order.taker_auth) return toast('Both parties must sign first.', 'err');
      if (order.settlement_status === 'settled') return toast('This order is already settled.', 'ok');
      txBusy = true;
      try {
        await supabase.from('orders').update({ settlement_status: 'settling', updated_at: new Date().toISOString() }).eq('id', order.id);
        await refreshLists();
        toast('Submitting settlement — check your wallet…');

        const server = rpc();
        const hostFn = fillHostFn(await fillCanonicalArgs(order, PASSPHRASE));
        const auth = [
          Stellar.xdr.SorobanAuthorizationEntry.fromXDR(order.maker_auth, 'base64'),
          Stellar.xdr.SorobanAuthorizationEntry.fromXDR(order.taker_auth, 'base64'),
        ];
        const mkOp = () => Stellar.Operation.invokeHostFunction({ func: hostFn, auth });

        // enforcing-mode simulation (auth pre-attached) → footprint + resource fee
        const probe = new Stellar.TransactionBuilder(await server.getAccount(state.address),
          { fee: Stellar.BASE_FEE, networkPassphrase: PASSPHRASE })
          .addOperation(mkOp()).setTimeout(180).build();
        const sim = await server.simulateTransaction(probe);
        if (Stellar.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);

        const fee = (BigInt(Stellar.BASE_FEE) + BigInt(sim.minResourceFee)).toString();
        const finalTx = new Stellar.TransactionBuilder(await server.getAccount(state.address),
          { fee, networkPassphrase: PASSPHRASE })
          .addOperation(mkOp()).setSorobanData(sim.transactionData.build()).setTimeout(180).build();
        const { signedTxXdr } = await kit.signTransaction(finalTx.toXDR(), { address: state.address, networkPassphrase: PASSPHRASE });
        const sent = await server.sendTransaction(Stellar.TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE));
        if (sent.status === 'ERROR') throw new Error('Submit rejected: ' + JSON.stringify(sent.errorResult ?? sent.status));
        const hash = await waitForTx(server, sent.hash);

        await supabase.from('orders').update({
          settlement_status: 'settled', settle_tx_hash: hash, settle_error: null,
          settled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', order.id);
        toast('Settled on-chain 🎉', 'ok');
        await refreshLists();
      } catch (err) {
        // A concurrent submitter (either party can settle) may have already filled
        // this order — our fill then reverts (contract `AlreadyFilled`, or a
        // waitForTx timeout while it lands). Never downgrade a settled order to
        // failed: re-check first, and scope the failure write to a still-'settling'
        // row so the winner's 'settled' is never clobbered.
        const { data: fresh } = await supabase.from('orders')
          .select('settlement_status').eq('id', order.id).single();
        if (fresh?.settlement_status === 'settled') {
          toast('Already settled on-chain 🎉', 'ok');
        } else {
          await supabase.from('orders').update({
            settlement_status: 'failed', settle_error: String(err?.message || err).slice(0, 400),
            updated_at: new Date().toISOString(),
          }).eq('id', order.id).eq('settlement_status', 'settling');
          toast(err?.message || 'Settlement failed.', 'err');
        }
        await refreshLists();
      } finally {
        txBusy = false;
      }
    }

    // settlement UI for an accepted order. side = my role in this list.
    function settlementStrip(o, side) {
      if (!settlementEnabled) {
        return `<div class="settle"><div class="settle__msg">On-chain settlement isn't configured yet — set <b>OTC_CONTRACT_ID</b> in otc-config.js.</div></div>`;
      }
      const st = o.settlement_status || 'idle';
      const makerOk = !!o.maker_auth, takerOk = !!o.taker_auth;
      const myOk = side === 'maker' ? makerOk : takerOk;
      const otherOk = side === 'maker' ? takerOk : makerOk;
      const settled = st === 'settled';

      const step = (done, current, label, extra = '') =>
        `<div class="stepper__step${done ? ' is-done' : ''}${current ? ' is-current' : ''}${extra}">
            <span class="stepper__dot">${done ? '✓' : ''}</span><span class="stepper__label">${label}</span>
          </div>`;
      const bar = (done) => `<div class="stepper__bar${done ? ' is-done' : ''}"></div>`;
      const stepper = `<div class="stepper">
          ${step(makerOk || settled, !makerOk && !settled, 'Maker signed')}
          ${bar((makerOk && takerOk) || settled)}
          ${step(takerOk || settled, !takerOk && !settled, 'Taker signed')}
          ${bar(settled)}
          ${step(settled, makerOk && takerOk && !settled, 'Settled', ' is-final')}
        </div>`;

      let actions;
      if (settled) actions = isTxHash(o.settle_tx_hash) ? `<div class="settle__msg"><a href="${EXPLORER}/tx/${esc(o.settle_tx_hash)}" target="_blank" rel="noopener">View transaction ↗</a></div>` : '';
      else if (st === 'settling') actions = `<div class="settle__msg">Submitting settlement…</div>`;
      else if (!myOk) actions = `<div class="order__actions"><button class="btn btn--gold btn--sm" data-sign="${o.id}" data-side="${side}">Sign order</button></div>`;
      else if (!otherOk) actions = `<div class="settle__msg">Waiting for the counterparty to sign…</div>`;
      else actions = `<div class="order__actions"><button class="btn btn--gold btn--sm" data-fill="${o.id}">Settle now</button></div>`;
      const err = st === 'failed' && o.settle_error ? `<div class="settle__err">Last attempt failed: ${esc(o.settle_error)}</div>` : '';
      return `<div class="settle"><div class="settle__title">On-chain settlement</div>${stepper}${actions}${err}</div>`;
    }

    function wireSettlement(el) {
      el.querySelectorAll('[data-sign]').forEach((b) => (b.onclick = () => {
        const o = findOrder(b.getAttribute('data-sign'));
        if (o) signOrderAuth(o, b.getAttribute('data-side'));
      }));
      el.querySelectorAll('[data-fill]').forEach((b) => (b.onclick = () => {
        const o = findOrder(b.getAttribute('data-fill'));
        if (o) fillOrder(o);
      }));
    }

    // --- realtime ----------------------------------------------------------
    function setupRealtime() {
      teardownRealtime();
      const inc = supabase.channel('otc-incoming')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'orders', filter: `taker_address=eq.${state.address}` },
          () => loadIncoming())
        .subscribe();
      const sent = supabase.channel('otc-sent')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'orders', filter: `maker_address=eq.${state.address}` },
          () => loadSent())
        .subscribe();
      state.channels = [inc, sent];
    }
    function teardownRealtime() {
      state.channels.forEach((c) => supabase.removeChannel(c));
      state.channels = [];
    }

    // --- tabs --------------------------------------------------------------
    function switchTab(name) {
      document.querySelectorAll('.tab').forEach((t) =>
        t.classList.toggle('is-active', t.dataset.tab === name));
      document.querySelectorAll('.panel').forEach((p) =>
        p.classList.toggle('is-active', p.dataset.panel === name));
    }

    // --- init --------------------------------------------------------------
    function fillTokenSelect(sel, defaultValue) {
      sel.innerHTML = TOKENS.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');
      sel.value = defaultValue;
    }

    function init() {
      fillTokenSelect($('makerToken'), 'XLM');
      fillTokenSelect($('takerToken'), TOKENS[1].value); // USDC
      $('connectBtn').onclick = connect;
      $('orderForm').onsubmit = submitOrder;
      document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

      // refresh countdowns each minute
      setInterval(() => { renderIncoming(); renderSent(); }, 60000);

      if (state.address) {
        kit.setWallet(localStorage.getItem('otc_wallet_id') || FREIGHTER_ID);
        onConnected();
      } else {
        renderWalletChip();
      }
    }

    init();
