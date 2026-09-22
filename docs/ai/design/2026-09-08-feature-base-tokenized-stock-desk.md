---
phase: design
title: Katon Base B20 Stock-to-USDC RFQ Design
feature: base-tokenized-stock-desk
status: rebaselined
---

# Design decision

Katon is a keyless, taker-submitted stock-sale desk. A seller opens a private
1,000 ms auction for an exact B20/native-USDC pair. Institutional makers and
approved facilities provide signed or attested firm prices; 0x, 1inch, and an
Aerodrome benchmark provide venue-native alternatives. The backend ranks and
packages routes but never submits a transaction.

The design preserves the reference RFQ invariants—private losing bids, unified
price competition, atomic taker settlement, partial/blended internal routes,
facilities, and a later liquidation route—while using Base EVM primitives.

## Component map

```text
wallet ── SIWE/quote ──> Base API (keyless)
  │                         ├─ 1,000 ms collector
  │                         ├─ maker/facility/provider adapters
  │                         ├─ deterministic ranker
  │                         └─ seller-private quote bundle
  │
  └─ EIP-712/tx ──> RFQRouter ──> RFQSettlement (LP orders)
                               └─> LiquidityFacility (facility legs)
```

The route plan carries the allowlisted settlement contract separately from
the leg's `liquidity` identity. For an LP leg, `liquidity` is the maker; for a
facility leg it is the facility. This prevents an EOA maker from being
mistaken for a settlement contract and binds the native-USDC asset at the
router.

## Domain model

### Swap order

```solidity
struct SwapOrder {
    address maker;
    address signer;
    address stockToken;
    address usdcToken;
    uint256 stockAmount;
    uint256 usdcAmount;
    uint8 fillMode;       // 0 = fill-or-kill, 1 = proportional
    uint256 expiry;
    uint256 salt;
    uint16 feeCapBps;
    address allowedTaker;
    bytes32 rfqId;        // zero for a standing order
}
```

The EIP-712 domain is `KatonRFQSettlement`, version `2`, the active chain ID,
and the settlement address. The old liquidation domain remains version `1`
and cannot replay as a swap order.

### Route plan and legs

`SwapRoutePlan` binds request ID, taker, recipient, stock token, native USDC,
the allowlisted settlement address, exact sell amount, minimum net output, fee
cap, deadline, decision block, and decision block hash. Each `SwapRouteLeg`
contains source (`LP` or `FACILITY`), maker/facility identity, stock amount,
minimum USDC output, and a payload:

- LP: ABI-encoded `SwapOrder` plus signature.
- Facility: quote ID, expected USDC, expected stock, and expiry.

The router requires `msg.sender == plan.taker`, fresh guards, exact total stock,
per-leg minimums, aggregate minimum output, and zero token dust. It transfers
only the net USDC to the recipient after one protocol fee.

## Auction algorithm

1. Authenticate the taker and validate exact addresses, positive amounts,
   native-USDC, deadline, and (on mainnet) a non-expired eligibility
   attestation.
2. Record opening time and set the cutoff to opening + 1,000 ms.
3. Fan out to configured maker, facility, 0x, 1inch, and Aerodrome sources with
   bounded timeouts. Malformed/late/HTTP-error responses are unavailable.
4. Revalidate stored standing orders: v2 digest, delegated signer, cancellation,
   expiry, pair/request binding, capacity, and on-chain fill state.
5. Sort internal candidates by linear price and deterministic quote ID. Greedily
   consume capacity, skipping an LP FOK order unless its full capacity is the
   remaining amount. Compute gross output, fee, conservative gas, guaranteed
   output, and the earliest expiry.
6. Build external alternatives only for exact sell amount. Rank all executable
   routes by effective USDC, then guaranteed output, longer expiry, and route ID.
7. Return only the recommended route and executable alternatives. Maker losing
   prices and raw collection details stay private.

## API contract

`POST /v1/swaps/quote` accepts:

```json
{
  "stockToken": "0x…",
  "usdcToken": "0x…",
  "sellAmount": "1000000000000000000",
  "minBuyAmount": "9500000",
  "taker": "0x…",
  "recipient": "0x…",
  "deadline": "1750000000"
}
```

The response is seller-private and contains decimal strings for normalized
amounts, fee, gas, guaranteed/effective output, expiry, simulation block,
approval spender and transaction target, and either router calldata or an
unchanged external packet. Internal stock approval targets settlement because
the settlement contract pulls stock from the taker; the transaction itself
still targets the router. External packets preserve the venue allowance target.
They also carry independently checked chain/pair/recipient, exact amount, and
simulation attestations before they are executable. No endpoint returns a
losing maker price.

`POST /v1/swap-orders` registers/revokes a standing maker order. Registration
requires a v2 signature, exact remaining capacity, and revalidation on every
auction. Storage keeps only the signed order, signature, hash, capacity, and
operational timestamps—not identity documents.

## Facility design

`LiquidityFacility.quote` is a price-bearing quote, not merely funding
capacity. It uses a fresh approved feed, the current B20 multiplier, curator
haircut, exposure cap, and redemption-path flag. `buyStock` transfers USDC,
increments exposure, and automatically books a redemption lot. An AP or
contractual vested-holder operator calls `settleRedemption`; actual proceeds
reduce inventory cost and realize signed profit/loss into NAV. Queued FIFO
withdrawals reserve assets and are honored before new acquisitions.

## Security and failure behavior

- Backend is keyless by configuration and startup checks.
- Mainnet quotes fail closed without SIWE, eligibility, fresh oracle/policy
  state, canonical native USDC, and a successful full simulation.
- Router rejects stale decision blocks, changed pair/amount/taker/recipient,
  unauthorized makers, invalid settlement/facility allowlists, stale facility
  quotes, and over-capacity legs.
- Settlement checks EIP-712 signatures, delegated signer state, cancellation,
  pair salt, expiry, FOK/proportional fill, and exact token approvals.
- External transaction packets are not executed by Katon contracts and are not
  mixed with internal legs.
- Liquidation support remains separate and product-disabled for B20. The
  current v1 funding-race interface is retained only as an isolated migration
  seam; a future official lending adapter must add the price-bearing
  max-seize bid and borrower/surplus-return policy before enablement.

## Migration and compatibility

This is a breaking v2 swap schema. Existing liquidation signatures continue to
use their v1 domain and interfaces only for isolated migration/test coverage;
they are not exposed by the production Base API/UI and a liquidation signature
is never accepted by the swap path. Pre-production Base deployments are
replaced with fresh Sepolia deployments after contract/API review. Enabling a
future liquidation market requires a new reviewed price-bearing route with
explicit surplus return rather than treating the legacy funding route as
compatible.

## Traceability

| Invariant | Implementation seam |
| --- | --- |
| Private signed bids | `packages/base-core/src/swap.ts`, `apps/base-api/src/service.ts` |
| One-second cutoff | `SWAP_AUCTION_WINDOW_MS`, `BaseApiService.quoteSwap` |
| Unified ranking | `rankSwapQuotes` and HTTP source fan-out |
| Taker atomic settlement | `RFQRouter.executeSwapRoute`, `RFQSettlement.fillSwapOrder` |
| Partial/blended internal liquidity | `buildInternalRoute`, route legs |
| Facility redemption risk | `LiquidityFacility.quote/buyStock/settleRedemption` |
| Policy/eligibility gates | `EligibilityPort`, B20/oracle guards, preflight |
| External separation | `RankedExternalSwapRoute`, unchanged provider packet |
