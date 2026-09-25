# Katon Solana Tokenized-Stock Desk

Katon is a non-custodial Seller Desk for private, exact-input exits from verified tokenized-stock balances into approved Solana stablecoins. A Private Maker signs the frozen settlement first; the Seller reviews and signs those same transaction bytes.

The active implementation targets Solana localnet for the Seller walkthrough. Local test assets have no issuer backing and are not Devnet or Mainnet assets. Mainnet execution, managed issuer routes, and Liquidation Execution remain separate release-gated surfaces.

## Quick start

Requirements: Node.js 20.19+ and npm. For the local Seller walkthrough, install Solana CLI and Surfpool as described in [the localnet guide](tools/solana-seller-localnet.md).

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run seller:localnet
```

The browser desk runs at `http://localhost:5173`; the API runs at `http://localhost:8787`. The walkthrough provisions disposable local test accounts and a validator ledger under `.local/`, which is ignored by Git.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Solana Seller Desk web app |
| `npm run dev:solana-api` | Start the Seller Desk API |
| `npm run dev:solana-api:localnet` | Start the API with local settlement enabled |
| `npm run seller:localnet` | Run the end-to-end localnet Seller walkthrough |
| `npm run seller:loop` | Run the local Seller loop |
| `npm run typecheck` | Check web, API, and Solana package types |
| `npm test` | Run the Solana test suites |
| `npm run build` | Typecheck and build the web desk |
| `npm run check:solana:release` | Validate release evidence and configuration |

Copy `.env.example` to `.env` for local settings. Keep wallet keys and RPC credentials out of Git; the credentials wizard writes local configuration under `.local/`.

## Repository map

- `apps/solana-web/` — Seller Desk and frozen transaction review
- `apps/solana-api/` — Quote Sprint, Private Maker, settlement validation, and localnet runtime
- `packages/solana-core/` — Solana domain rules and transaction types
- `packages/solana-sdk/` — Seller Desk client and wallet adapters
- `contracts/solana-rfq/` — RFQ settlement program and contract tests
- `services/solana-liquidator/` — independently gated Liquidation Execution
- `docs/domain/solana-tokenized-stock-desk/` — domain language and architecture decisions
