# Solana Tokenized-Stock Exit Desk

This context coordinates private, exact-input exits from verified tokenized stocks into approved native Solana stablecoins without taking custody of inventory.

## Language

**Quote Sprint**:
A time-bounded collection of executable quotes for one seller, stock mint, stablecoin mint, and exact atomic input.
_Avoid_: Auction, order book, fallback routing

**Private Maker**:
An approved liquidity provider that commits inventory by partially signing the exact settlement transaction before seller review.
_Avoid_: Relayer, custodian

**Maker Provisioning**:
Operator-assisted creation of a Private Maker identity. Provisioning alone does not permit the source to receive Quote Sprints.
_Avoid_: Maker enablement

**Maker Source Enablement**:
The delayed Squads-governed permission for a provisioned Private Maker source to receive Quote Sprints. The maker's advertised availability is a separate condition.
_Avoid_: Provisioning, availability

**Exact Input**:
The atomic stock amount debited from the seller and credited to the Private Maker without a transfer-fee deduction.
_Avoid_: Nominal input, approximate amount

**Managed Route**:
An issuer- or venue-controlled execution path whose transaction and authorization semantics cannot be treated as a generic token transfer.
_Avoid_: Generic SPL route

**Reference Policy**:
The authoritative equities price, session calendar, freshness, cross-check, and corporate-action evidence that bounds quote eligibility.
_Avoid_: DEX oracle, fallback price

**Execution Surface**:
An independently enabled transaction-producing subsystem, currently the Seller Desk or Liquidation Execution.
_Avoid_: Global launch switch

**Seller**:
A non-custodial holder of a verified tokenized-stock balance who requests a Quote Sprint and co-signs settlement on the Seller Desk.
_Avoid_: Trader, user, customer

**Seller Desk**:
The seller-facing Quote Sprint and settlement flow.
_Avoid_: Liquidator, exchange

**Frozen Settlement Review**:
The shared review of the base64 transaction a Private Maker partially signs and the Seller reviews. It binds the exact two-instruction transaction, quote terms, signer slots, and account privileges before server-owned account derivation and signature validation.
_Avoid_: Transaction preview

**Liquidation Execution**:
The independently gated service that liquidates supported lending positions and atomically unwinds approved stock collateral.
_Avoid_: Seller Desk, automatic fallback
