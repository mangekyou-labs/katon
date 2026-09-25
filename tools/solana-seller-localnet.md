# Seller localnet settlement harness

Operator notes for `tools/solana-seller-localnet.mjs` and the Seller Wallet
Standard walkthrough. This is an offline test fixture, not a production asset
or issuer integration.

## Safety and prerequisites

- Set `NO_DNA=1` for Surfpool and Anchor commands.
- The only supported cluster is offline Surfpool at
  `http://127.0.0.1:8899` (`solana:localnet`). Do not point the harness at
  Devnet or Mainnet.
- Surfpool must run with `--offline`; Surfpool's default fork mode is not used.
- The RFQ binary is built from `contracts/solana-rfq` and loaded into the
  local bank. Set `SURFPOOL_BIN` or `ANCHOR_BIN` only when the local binary is
  installed outside the defaults in the harness.

## Run the Seller walkthrough

From the repository root:

```bash
NO_DNA=1 node tools/solana-seller-browser-journey.mjs
```

The walkthrough prepares the offline bank, launches the Seller API and Vite,
and drives the trade page with a headless Wallet Standard test wallet. It
checks the signed message against the Maker-issued bytes, submits once, waits
for RPC confirmation, and independently reads the landed RFQ instruction,
FillReceipt, transaction token-balance metadata, and before/after token
accounts. The test process stops its API and web servers on completion.

The harness command can also be run by itself:

```bash
NO_DNA=1 npm run seller:localnet
```

It loads the `solana_rfq` program, initializes or validates the governed local
asset and Maker registry, and provisions Seller stock plus Maker, Seller, and
fee-recipient USDC/USDT accounts. The generated fixture, keys, and Surfpool
helpers live in ignored `.local/` files. Reusing an initialized governance
fixture resets test token balances before a new walkthrough; the browser test
also asserts the expected initial balances.

## Local assets

The `AAPLx TEST` stock mint is created for this offline bank. The stablecoin
fixtures use the familiar Solana USDC and USDT public-key identities, but their
mint state and balances are locally provisioned synthetic test state. They
have no issuer backing, do not prove a live stablecoin balance, and are not
Devnet or Mainnet assets. The UI labels the assets accordingly.

## Current evidence

The latest confirmed Seller-driven settlement and account identities are
recorded in
[`docs/ai/testing/2026-09-25-feature-solana-seller-settlement.md`](../docs/ai/testing/2026-09-25-feature-solana-seller-settlement.md).

`tools/solana-seller-loop.mjs` is a legacy API-only probe. Use the browser
walkthrough above for current acceptance evidence because it exercises the
Wallet Standard review and signature path.
