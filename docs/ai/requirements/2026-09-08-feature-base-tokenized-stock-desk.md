---
phase: requirements
title: Katon Base B20 Stock-to-USDC RFQ Requirements
description: Product and acceptance requirements for a retail B20 stock sale desk on Base
feature: base-tokenized-stock-desk
status: rebaselined
---

# Problem and product thesis

Eligible retail holders need a reliable way to sell Coinbase B20 tokenized
stocks for native Circle USDC. A thin public AMM is not sufficient for a
large or policy-sensitive stock sale: it exposes inventory, has no committed
price, and cannot prove best execution. Katon therefore opens each
authenticated sale request for exactly 1,000 ms and privately collects firm
quotes from approved institutional makers, redemption-capable facilities, and
approved external venues.

The first retail product is **B20 stock → native USDC**. It is a taker-led,
price-bearing auction. The seller signs and submits the final atomic route;
the backend coordinates but never holds a funded key or stock inventory.

## Goals

- Rank eligible maker, facility, 0x, 1inch, and direct Aerodrome quotes using
  effective USDC after the protocol fee and a conservative gas charge.
- Exclude every response received after the one-second cutoff and keep losing
  maker prices private.
- Build the best Katon-native route greedily from linear-price capacity. LP and
  facility legs may be partial and blended; all internal legs settle atomically.
- Return executable external alternatives without blending them with Katon
  legs. The seller can inspect source, guaranteed output, gas, expiry, target,
  and allowance before signing.
- Enforce B20 authorization, pause, multiplier, oracle freshness, native-USDC
  pair binding, minimum output, fee caps, deadline, and simulation checks.
- Give facilities a conservative quote only when they have a fresh reference
  price, current B20 multiplier, capacity/exposure headroom, and an AP or
  contractual vested-holder redemption path.
- Retain liquidation as a later price-bearing route type, disabled until an
  official B20 lending market and its adapter are verified.

## Non-goals

- Buying B20 stock with USDC in the first retail release.
- A generic Base router, unrestricted user calldata, or a public losing-price
  ladder.
- Assuming ordinary secondary holders can redeem directly with Coinbase.
- Advertising facility liquidity without documented AP/vested-holder exit
  rights.
- Mainnet retail execution before compliance, canonical-address, monitoring,
  multisig, simulation, and canary-fill gates are complete.

## Actors and boundaries

| Actor | Responsibility |
| --- | --- |
| Seller/taker | Supplies B20, chooses recipient and `minBuyAmount`, reviews and submits the route. |
| Institutional maker | Signs a v2 price-bearing `SwapOrder`, approves stock settlement and native USDC. |
| Facility | Quotes current capacity and pays USDC; books acquired stock into a redemption lot. |
| Eligibility provider | Returns a wallet-bound attestation and expiry; absence or failure is not eligibility. |
| Backend | Runs the 1,000 ms auction, validates packets, ranks routes, and returns unsigned calldata. |
| Router/settlement | Revalidates all bindings and performs atomic internal settlement. |
| External venue | Returns a venue-native transaction packet; Katon does not mutate or blend it. |

## Functional requirements

### Auction and ranking

1. Every accepted request has `auctionOpenedAtMs` and
   `auctionCutoffAtMs = auctionOpenedAtMs + 1000`.
2. The collector fans out concurrently to approved makers, facilities, 0x,
   1inch, and the direct Aerodrome benchmark. CoW is an asynchronous protected
   order flow outside this auction. Rave remains discovery-gated.
3. A firm quote must match the exact stock/USDC pair, taker binding (when
   present), capacity, expiry, signature, and request binding. A response with
   an invalid packet, negative bound, stale state, or missing signature is
   unavailable.
4. Internal candidates are sorted by linear USDC price, then deterministic
   quote ID. The resulting route is ranked by effective net output (gross
   output minus fee and conservative gas). Ties break by guaranteed output,
   longer expiry, then deterministic route ID.
5. A route is executable only when total stock equals the requested sell
   amount and net output is at least `minBuyAmount`. LP fill-or-kill orders are
   used only at their full remaining capacity.
6. External packets compete at the quote layer but remain venue-native and
   cannot be blended with Katon legs.

### Settlement

1. `SwapOrder` is EIP-712 domain version `2` and includes maker, signer, stock
   token, native USDC token, stock capacity, USDC amount, fill mode, expiry,
   salt, fee cap, allowed taker, and optional RFQ binding.
2. `executeSwapRoute(SwapRoutePlan, SwapRouteLeg[])` binds request ID, taker,
   recipient, exact pair/amount, minimum net output, fee cap, deadline,
   decision block/hash, and the allowlisted settlement contract.
3. LP legs identify the maker and carry the signed order payload. Facility legs
   identify the facility and carry quote ID, expected output, amount, and
   expiry. All internal legs must succeed or the transaction reverts.
4. Settlement supports proportional fills, fill-or-kill, cancellation,
   delegated signers, pair-salt invalidation, and per-order fill accounting.
   `msg.sender` at the router must equal the signed taker.
5. The router measures USDC balance deltas, charges at most one fee (≤50 bps),
   transfers the net amount to the recipient, and leaves no token dust.

### Facility policy

- `quote(stock, amount)` returns price, capacity, and expiry only when the
  reference price is fresh, the B20 multiplier is current, the curator
  haircut/exposure cap permits the amount, and a redemption path is enabled.
- Acquisition books a redemption lot automatically. AP settlement transfers
  stock and actual USDC proceeds, realizing profit or loss into facility NAV.
- ERC-4626 deposits and queued FIFO withdrawals remain available. Reserved
  withdrawal assets may not be spent on a quote.

### Eligibility and preflight

- Mainnet retail requests require SIWE and a fail-closed wallet-bound
  `EligibilityPort`. Only the attestation ID and expiry are stored.
- Preflight checks B20 pause/policy state, multiplier, recipient eligibility,
  oracle freshness, native-USDC address, exact approval spender (settlement for
  internal routes and the provider target for external packets), full calldata,
  and simulation at a pinned decision block. External packets must attest chain,
  pair, recipient, exact sell/minimum amounts, allowance spender, and successful
  simulation before they are executable.
- Base Sepolia is the first rollout network. Mainnet remains disabled until
  explicit operational gates are true.

## Acceptance criteria

- A 1,000 ms auction returns a seller-private quote bundle with a recommended
  route and executable alternatives; late quotes never affect ranking.
- LP-only, facility-only, blended, external-winner, provider-timeout, expired,
  insufficient-allowance, minimum-output, stale-oracle, changed-multiplier,
  B20-policy, redemption-loss, queued-withdrawal, and cancellation paths are
  tested.
- EIP-712 v1 liquidation signatures cannot replay against v2 swap orders.
- A taker-submitted LP route and a facility route conserve stock and USDC or
  revert atomically.
- The API has no funded signing key and returns no losing maker price.
- Base Sepolia canary execution is complete before any Base mainnet enablement.

## Rollout

1. Native maker auction and retail sell UI on Base Sepolia.
2. 0x, 1inch, and Aerodrome alternatives with measured quote latency.
3. CoW asynchronous protected orders.
4. Facilities after AP/redemption and operational-loss procedures are proven.
5. Liquidations only after an eligible B20 lending market is verified.

## Assumptions and evidence

- “Exact” means economic and functional parity with the reference RFQ model,
  expressed using EIP-712, ERC-20/B20, ERC-4626, and Base transaction
  semantics.
- Coinbase redemption is institutional/conditional; no facility may infer an
  immediate retail redemption right.
- Canonical Base token, native-USDC, provider, oracle, and settlement addresses
  are deployment inputs and must be independently verified before mainnet.
