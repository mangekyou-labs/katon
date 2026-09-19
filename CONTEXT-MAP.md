# Context Map

## Contexts

- [Solana Tokenized-Stock Exit Desk](./docs/domain/solana-tokenized-stock-desk/CONTEXT.md): coordinates private, exact-input sales of verified tokenized stocks into approved native stablecoins.

## Relationships

- **Exit Desk → Solana settlement**: the Exit Desk selects one executable quote and submits one immutable, maker-then-seller co-signed transaction to the settlement program.
- **Exit Desk → Liquidation Execution**: both reuse verified asset and venue policy, but each has an independent release gate and execution enablement.
