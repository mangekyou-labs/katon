# Katon Base B20 stock-to-USDC architecture

Katon is a retail B20 stock-sale desk. An eligible holder sells a Coinbase B20
token for native Circle USDC through a one-second private best-price auction.
Institutional makers and redemption-capable facilities compete with approved
external venues. The seller submits the chosen internal route; the backend is
keyless and never holds stock or a funded signing key.

This document is the stakeholder architecture. The editable implementation
seams are under `packages/base-*`, `apps/base-api`, `apps/base-web`,
`contracts/base`, and `services/indexer/src/base`.

## System shape

```text
Seller wallet ── SIWE + quote request ──> keyless Base API
       │                                  ├─ maker/facility/provider fan-out
       │                                  ├─ 1,000 ms deterministic ranker
       │                                  └─ private route bundle
       │
       └─ EIP-712/transaction ──> RFQRouter
                                  ├─ RFQSettlement (LP maker orders)
                                  └─ LiquidityFacility (AP-backed inventory)
```

External 0x/1inch/Aerodrome packets are alternatives at the quote layer. They
execute through their own venue contracts and are never blended with Katon
legs. CoW is a separate asynchronous protected-order flow. Rave is gated on
authenticated Coinbase-B20/native-USDC discovery and executable simulation.

## On-chain contracts

### RFQSettlement

`SwapOrder` uses EIP-712 domain version `2` and binds maker, signer, stock,
native USDC, capacity, total USDC, fill mode, expiry, salt, fee cap, allowed
taker, and optional request ID. The contract supports EOA/ERC-1271 and
delegated signers, proportional/FOK fills, cancellation, pair-salt
invalidation, and fill accounting. Stock moves from the taker to the maker;
USDC moves from the maker to the router.

The old liquidation order remains on its version `1` domain. It is retained as
an isolated, non-production compatibility seam only; swap execution is the v2
route below and never accepts a liquidation signature.

### RFQRouter

`executeSwapRoute(SwapRoutePlan, SwapRouteLeg[])` is taker-only and
non-reentrant. The plan binds request ID, taker, recipient, exact pair and
amount, minimum net output, fee cap, deadline, decision block/hash, and the
allowlisted settlement address. The settlement address is separate from each
LP maker identity, then checked to use the plan's native USDC.

LP legs carry a signed order payload and identify the maker. Facility legs
carry a quote ID, expected amount, and expiry and identify the facility. The
router checks B20/oracle guards, allowlists, leg minimums, exact stock total,
aggregate minimum output, one fee at most (≤50 bps), and no residual token
dust before transferring net USDC to the recipient.

The existing v1 liquidation route remains separate and product-disabled. Its
legacy funding-race ABI is not exposed by the Base product. A future verified
B20 lending adapter must introduce and review the price-bearing max-seize bid
and explicit borrower/surplus-return semantics before any liquidation route is
enabled; an adapter manifest alone is not sufficient.

### LiquidityFacility

The facility is ERC-4626-like native-USDC vault infrastructure with synchronous
and FIFO queued withdrawals. A quote requires a fresh approved stock reference,
current B20 multiplier, curator haircut, exposure cap, and an enabled AP or
contractual vested-holder redemption path. Acquiring stock pays USDC, books a
redemption lot automatically, and updates exposure. AP settlement transfers
the lot for actual USDC proceeds and realizes profit/loss into NAV.

## Off-chain services

`POST /v1/swaps/quote` accepts stock token, native-USDC token, raw sell amount,
minimum buy amount, taker, recipient, and deadline. The response includes the
recommended route and executable alternatives with normalized amounts, fee,
gas, expiry, simulation block, and either Katon calldata or an unchanged
external transaction packet. For an internal route, the transaction target is
the router while the stock approval spender is the settlement contract;
external packets retain the provider-supplied allowance target. Responses are
seller-private.

The collector fans out concurrently to approved maker, facility, 0x, 1inch,
and Aerodrome adapters. The cutoff is exactly opening + 1,000 ms. Stored
standing orders are revalidated for v2 digest, signature/delegation,
cancellation, expiry, pair/request, capacity, and on-chain fill state. Bad
packets, timeouts, late responses, absent eligibility, and failed simulations
are unavailable rather than downgraded into executable routes.

`POST /v1/swap-orders` registers or revokes standing maker orders. Mongo and
memory repositories retain signed order data and operational state only; no
identity documents are required.

## Base-specific policy

- First release is Base Sepolia (`84532`), B20 stock → native Circle USDC only.
- Base mainnet (`8453`) is disabled unless explicit production and mainnet
  gates, SIWE, wallet-bound eligibility, canonical addresses, and monitoring
  are configured.
- B20 `isAuthorized`, transfer/seize pause state, multiplier, recipient
  eligibility, oracle freshness, and simulation are preflight/settlement gates.
- Facilities may not advertise redemption-backed liquidity without a documented
  AP or vested-holder path. Coinbase redemption is conditional and primarily
  institutional; ordinary secondary holders are not assumed to redeem.
- Amounts are integer token base units. External provider transactions carry
  chain, pair, recipient, exact sell/minimum amounts, allowance spender, and
  successful simulation attestations; the adapter/ranker checks these before
  returning the unchanged packet and never rewrites provider calldata.

## Invariant traceability

| Reference invariant | Base implementation | Substitution or boundary |
| --- | --- | --- |
| Keyless coordination | `BaseApiService`, config secret guard | HTTPS/SIWE replaces chain-native auth; API never signs settlement. |
| Private signed bids | v2 `SwapOrder`, standing-order repository | EIP-712 replaces Soroban signature payloads. |
| Unified price competition | `rankSwapQuotes`, source fan-out | USDC effective-output comparator; external execution remains separate. |
| Taker-submitted atomic settlement | `RFQRouter.executeSwapRoute` + `RFQSettlement` | EVM `msg.sender`, ERC-20 allowances, and revert replace Soroban auth/transaction envelopes. |
| Partial and blended routes | `buildInternalRoute`, `SwapRouteLeg[]` | Greedy linear capacity; only Katon legs can be atomic. |
| Facility liquidity | `LiquidityFacility.quote/buyStock` | ERC-4626 shares, AP redemption lots, Base token transfers. |
| Liquidation support | Explicit API/UI product gate; isolated v1 contract seam | Disabled by default. A future verified B20 adapter must add the reviewed price-bearing max-seize/surplus route before enablement. |
| Policy/corporate actions | B20/oracle guards and facility multiplier | `isAuthorized`, pause vectors, multiplier, and feed freshness are explicit. |
| Deterministic ranking | quote ID/expiry/output tie breaks | Millisecond receive time is captured at API boundary. |
| Replay protection | chain ID, verifying contract, v2 domain, salt, fill state | Existing v1 liquidation signatures cannot replay. |

## Rollout gates

1. Sepolia native maker auction and seller UI.
2. 0x/1inch alternatives plus Aerodrome benchmark with measured p95 ≤1,500 ms.
3. CoW protected orders.
4. Facilities after AP/redemption, NAV loss, and queued-withdraw procedures.
5. A reviewed price-bearing liquidation adapter after an official eligible B20
   lending market; the current legacy funding route remains disabled.
6. Mainnet only after compliance, canonical address and bytecode review,
   multisig controls, monitoring, full simulation evidence, and small-value
   canary fills.
