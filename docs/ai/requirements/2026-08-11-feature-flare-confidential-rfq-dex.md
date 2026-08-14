---
phase: requirements
title: Flare Confidential RFQ DEX Requirements
description: Product and acceptance requirements for an institutional RWA RFQ and facility-liquidity protocol on Flare
feature: flare-confidential-rfq-dex
status: approved
---

# Flare Confidential RFQ DEX Requirements

## Problem Statement

Institutional holders of tokenized real-world assets often cannot exit positions without fragmented bilateral outreach, information leakage, uncertain settlement, or shallow public AMM liquidity. Market makers also need a controlled way to quote these assets without exposing every losing price or operating a custodial account with the platform.

TrustRFQ must provide two complementary paths on Flare:

1. immediate execution against pre-committed standing bids, live liquidity-facility quotes, or an atomic blend of both; and
2. scheduled price discovery through confidential RFQ auctions when no immediate route is acceptable.

Negotiation and bid ranking happen off-chain for speed and privacy. Funds remain in user wallets or governed facility contracts, and the selected route settles atomically on Flare. Flare Confidential Compute (FCC) is the differentiator: eligible RFQ terms and signed LP bids are processed inside attested code so relay and infrastructure operators cannot inspect the plaintext order book.

## Target Users

- **RWA seller / taker:** an institution or qualified wallet seeking stablecoin liquidity for a supported RWA.
- **Liquidity provider / market maker:** an approved institution submitting signed one-off or standing bids through the UI, SDK, or bot API.
- **Facility depositor:** a user allocating stablecoins to a curated facility in return for vault shares and yield exposure.
- **Facility curator:** a risk manager configuring markets, haircuts, caps, adapters, allocations, and pause controls.
- **Compliance operator:** an authorized operator administering participant eligibility and reviewing audit evidence without gaining custody.
- **Protocol operator / guardian:** the multisig and timelock roles responsible for upgrades, configuration, emergency pauses, and incident response.

## Goals and Objectives

### Primary goals

- Deliver a production-capable, noncustodial RWA RFQ DEX on Flare with atomic settlement.
- Preserve the six-part protocol shape: settlement, RFQ coordination backend, liquidity facilities, venue adapters, RFQ router, and facility aggregator.
- Keep pre-trade RFQ terms confidential from relays, infrastructure operators, the public, and ineligible participants; disclose only the minimum quoting view to eligible LPs. Keep each LP's bid confidential from every competing LP.
- Aggregate signed LP liquidity and on-chain facility liquidity into a best-price route that enforces the taker's minimum output.
- Support institutional order controls: RFQ orders, limit orders, partial fills, fill-or-kill, expirations, delegated signers, cancellations, and pair-level salt invalidation.
- Provide a complete role-based production frontend matching the approved light, institutional DEX direction.
- Integrate Flare-native data systems for pricing guardrails, issuer NAV evidence, and verifiable off-chain redemption state.
- Make facilities capital-efficient through narrowly scoped adapters to relevant Flare lending and yield venues.

### Secondary goals

- Provide a typed TypeScript LP SDK and a documented example market-maker bot.
- Support keeper-driven liquidation RFQs, redemption settlement, indexing, and risk monitoring.
- Provide a clear path from local simulation to Coston2 and then to gated Flare mainnet production.
- Keep the existing Stellar application operational while implementing the Flare product in a parallel monorepo structure.

### Non-goals

- A general-purpose AMM, spot aggregator, perpetual exchange, bridge aggregator, or retail meme-token DEX.
- Custody of user, LP, or curator keys by the API, FCC relay, or protocol operator.
- Concealing the final winning trade from the public Flare ledger; post-trade settlement data is necessarily observable.
- Publishing a public stream of plaintext RFQs or a public losing-bid order book.
- Treating FXRP as the initial RWA being liquidated by the protocol.
- Requiring FAssets minting or redemption for MVP completion.
- Supporting unreviewed facility adapters or arbitrary delegate calls from facilities.
- Mainnet use with real funds before the security, FCC availability, and operational gates are satisfied.

## Functional Requirements

### FR-1: Immediate and scheduled execution

- The Swap page must first request executable quotes from active standing bids and registered facilities.
- An immediate route may use one LP source, one facility source, or multiple sources in a single atomic blended execution.
- If no acceptable immediate route exists, the seller may create a scheduled confidential auction lasting exactly `24 hours`, `1 week`, `1 month`, or `3 months`.
- Auction creation must declare whether policy-bound early close is allowed. Early close must finalize against the deterministic best eligible route at a pinned decision block; the seller cannot inspect and cherry-pick an individual sealed bid.
- There is no separate 3-30-second auction mode. “Instant” means execution against already committed liquidity.
- The seller must set a minimum output or maximum slippage bound before signing.
- If any leg fails or aggregate output is below the minimum, the entire settlement must revert.

### FR-2: Order and bid semantics

- Signed orders must use EIP-712 domain separation including chain ID and verifying contract.
- EOA and ERC-1271 contract-wallet signatures must be supported.
- Makers may register and revoke delegated signing keys with explicit scope and expiry.
- Orders must support RFQ and limit variants, partial-fill and fill-or-kill behavior, absolute expiry, unique nonce/salt, and pair-level cancellation.
- Filled amounts and order hashes must prevent overfill and replay.
- Amounts must remain integer base units using each ERC-20 token's actual decimals; floating-point arithmetic is forbidden at trust boundaries.
- Standing bids must define pair, capacity, spread or price rule, fill mode, expiry, and optional per-fill and aggregate limits.
- Confidential one-off and auction bids must bind the originating seller, auction commitment, router, chain ID, and expiry so another wallet cannot consume a revealed winning quote.
- Standing bids are the reusable limit-order surface. They may remain open to any eligible taker, but only within their signed pair, capacity, price, fill-mode, expiry, and aggregate-limit constraints.

### FR-3: Confidential auction coordination

- RFQ and LP-bid plaintext must be encrypted to an attested FCC extension before it reaches the coordination API.
- The API and message broker must act as blind relays and store ciphertext plus non-sensitive operational metadata only.
- Only eligible LPs may receive the role-scoped auction payload needed to quote.
- LP bids must be signed before encryption and validated inside FCC.
- FCC must reject malformed, expired, unauthorized, replayed, or pair-incompatible bids.
- FCC must rank eligible LP bids together with deadline-bound public facility quotes using deterministic rules.
- Losing bids must not be published on-chain or exposed to competing LPs or infrastructure operators.
- The seller UI may show bid count and a seller-authorized best-price indication without exposing bidder identity or the losing bid ladder.
- The winning signed bid and route become public only when needed for execution or post-trade verification.
- Private auctions fail closed when FCC is unavailable. A facility-only public quote path may be used only after explicit user opt-in.

### FR-4: Router and settlement

- The RFQ Router must accept a typed route plan bound to the seller, recipient, chain, router, auction/order commitment, and decision context; enforce its deadline and minimum output; execute every leg atomically; and emit route-level events.
- The Settlement contract must validate signed LP orders, transfer assets, track fills, and enforce cancellations. It must not assess a second TrustRFQ protocol fee on routed fills.
- The router must support one or more LP legs and facility legs without taking custody between transactions.
- The router must assess at most one TrustRFQ protocol fee on aggregate route output across LP, facility, and liquidation legs. The seller's or liquidation recipient's minimum output is enforced after this fee; source spreads, venue fees, and facility haircuts remain quote inputs rather than additional TrustRFQ protocol fees.
- Protocol fees are zero for pilot deployments. Governance may enable the aggregate router fee on mainnet, capped at 50 basis points by immutable or timelocked contract bounds.
- Permit-based approvals may be used when supported; ordinary ERC-20 allowances remain available as fallback.

### FR-5: Facility aggregator and facilities

- Governance may register, pause, unpause, and revoke facilities through the Facility Aggregator.
- Each facility must be an ERC-4626-compatible share vault where synchronous behavior is safe, extended with ERC-7540-inspired queued withdrawal handling when liquidity is deployed or redemption is pending.
- Facilities must support deposit, withdrawal request, withdrawal settlement, quote, RFQ fill, allocation, deallocation, acquired-RWA booking, issuer-redemption request, and redemption settlement.
- Facility NAV must include idle base assets, adapter balances, receivables, acquired RWA inventory, realized loss, and accrued fees.
- Facility quotes must use verified issuer NAV less curator-configured haircut and must enforce staleness, exposure caps, minimum liquidity, and quote expiry.
- Facility policy must be granular by asset, pair, adapter, allocation cap, concentration cap, haircut range, and redemption SLA.
- Insufficient liquid base assets must queue a withdrawal rather than misrepresenting it as immediately redeemable.

### FR-6: Venue adapters

- All venue integrations must implement the fixed adapter surface `deposit`, `withdraw`, `totalAssets`, and `maxWithdraw`, plus narrowly scoped venue-specific health methods where required.
- Initial adapters are limited to protocol categories used by liquidity facilities:
  - Morpho markets and curated vaults exposed through the Flare deployment and its primary interface;
  - Kinetic overcollateralized lending markets; and
  - Clearpool T-Pool for USDX facilities.
- A facility must only call adapters explicitly whitelisted by governance and enabled by its curator policy.
- Adapter failures must not allow partial RFQ settlement.
- Liquidation monitoring may open an RFQ to sell seized collateral or acquired RWA inventory, but must not silently route through an unrelated AMM.
- Integration addresses and supported assets must be verified per network at deployment time; they must not be copied from search results or hardcoded as universal constants.

### FR-7: FDC and issuer NAV

- Issuer NAV updates must be represented as typed, scaled-integer records with asset ID, value, decimals, as-of time, source identity, and validity window.
- FDC proofs must be verified before a NAV record or issuer-redemption receipt can affect contract state.
- A stale, invalid, mismatched, or replayed proof must halt affected facility quotes or redemption settlement.
- FDC Web2Json may be used only for allowlisted public endpoints with a fixed response schema; external content must never be interpreted as instructions.
- Facility settlement must support asynchronous issuer redemption: book inventory, submit/request evidence, verify the resulting proof, then account for proceeds or loss.

### FR-8: FTSO risk guardrails

- FTSO must provide stablecoin depeg and supported market-price guardrails; it must not be treated as the issuer NAV source for an RWA.
- FTSO contracts must be resolved through Flare's registry for the active network.
- Feed values must be checked for timestamp freshness, decimals, configured deviation, and supported feed ID.
- A stale or out-of-bound guardrail must pause the affected quote path without blocking unrelated pairs.
- Scaling-feed proofs must be verified when anchor-grade evidence is required.

### FR-9: Optional FAssets funding rail

- FAssets support is a post-MVP, separately gated extension and may be dropped or deferred whenever it threatens core DEX completion.
- The extension may guide an LP through standard FXRP Core Vault minting and amount-based or destination-tag redemption.
- FXRP may be deposited into a supported lending market as collateral to borrow stablecoin bid capital.
- FAssets contract addresses must be resolved through Flare's registry and all XRPL payment/proof state must remain typed and human-confirmed.
- FAssets operations must never be triggered autonomously by the matching service or require the protocol to custody XRPL or Flare keys.

### FR-10: Frontend product

- Production routes must include Swap/Redeem, Auctions, Auction Detail, Standing Bids, Dashboard, facility deposit/withdraw, and curator management.
- The desktop experience must follow the approved reference direction: cool-gray canvas, white panels, thin borders, restrained shadow, compact data tables, tabular numeric typography, deep-green execution actions, and semantic status tags.
- The application must be responsive at 375 px, 768 px, and 1280 px widths.
- Wallet flows must support Flare and Coston2 through wagmi/viem-compatible EVM wallets and clearly distinguish disconnected, wrong-network, awaiting-signature, submitted, confirmed, and reverted states.
- Token selection must support search, verified symbols, contract-address display/copy, network identity, and role/eligibility filtering.
- Transaction forms must include visible labels, decimal input modes, balance shortcuts, approval state, slippage/minimum output, expiry, fee, route summary, and explicit confirmation.
- Auction tables must provide filters, refresh/freshness indicators, pagination, accessible sorting, bid counts, expiry, route/source status, and role-appropriate actions.
- Every data-driven surface must implement loading, empty, error, success, offline, and stale-data behavior with recovery actions.
- The product must support keyboard navigation, visible focus, 40x40 px minimum touch targets, WCAG 2.2 AA contrast, reduced motion, and screen-reader labels.
- The supplied screenshots' recording controls and support-chat bubbles are not product elements.

### FR-11: Authentication, eligibility, and compliance

- Human sessions must use Sign-In with Ethereum-style wallet authentication with nonce, domain, chain, expiry, and replay checks.
- LP bots must use scoped API credentials bound to an institution and optionally mTLS; credentials must be revocable and must never authorize on-chain custody.
- Eligibility must be enforced at onboarding, RFQ distribution, bid acceptance, and settlement.
- Sanctions/KYC providers must remain replaceable behind an interface; only minimal status and audit references may be retained.
- Contract-level allowlists must provide defense in depth for permissioned RWA transfers.
- Logs must avoid plaintext RFQ terms, losing bids, credentials, wallet signatures, and sensitive compliance payloads.

### FR-12: Operations and governance

- Upgrade authority must be a multisig behind a timelock; a narrowly scoped guardian may pause but not upgrade or transfer funds.
- Keepers must be permissionless where safe, idempotent, and compensated only through explicit contract rules. Operator-run instances provide baseline reliability.
- Required keepers include liquidation detection, auction expiry/finalization, FDC proof progression, issuer-redemption settlement, and event indexing.
- The API, FCC extension, indexer, and keepers must expose health and freshness metrics without leaking confidential payloads.
- Production deployment must separate the public frontend, coordination/API infrastructure, and GCP Confidential Space FCC machines.

### FR-13: Atomic lending-market liquidation

- The router must support a typed liquidation route for approved lending venues. In one reverting transaction, the winning LP or facility supplies the debt asset, a venue-specific liquidation adapter repays an eligible unhealthy position, the venue releases collateral, and the router transfers the net collateral output to the bound winner or facility.
- Liquidation routes must bind the lending venue, market, borrower or position identifier, debt asset, collateral asset, maximum repay amount, minimum net collateral output, decision context, deadline, winner, and recipient. User-supplied arbitrary calls or delegate calls are forbidden.
- Morpho and Kinetic liquidation adapters must be implemented where their verified Flare interfaces and deployed markets support third-party liquidation. Clearpool T-Pool remains a yield adapter and is not treated as a lending-liquidation venue.
- A liquidation adapter must verify the configured market and token pair, enforce venue close-factor and health rules, minimize and clear approvals where possible, account by observed balance deltas, and revert the entire route if repayment, collateral receipt, fee assessment, or delivery fails.
- Liquidation detection may be permissionless. A keeper may identify an opportunity and request an RFQ, but it cannot custody bid capital, select an arbitrary execution target, or bypass the signed/FCC route policy.
- Selling collateral after it has already been seized is a separate post-seizure inventory RFQ. It must not be represented as satisfying the atomic lending-liquidation requirement.

## User Stories and Key Flows

### Seller

- As an eligible RWA holder, I can request immediate liquidity and compare standing-bid and facility routes before signing.
- As a seller without an acceptable immediate quote, I can create a scheduled confidential auction and monitor its status.
- As an auction owner whose creation policy allows early close, I can request early finalization and receive the deterministic best eligible route at that pinned decision context without viewing or cherry-picking individual sealed bids.
- As a seller, I receive no partial result when an atomic route fails or violates my minimum output.

### Liquidity provider

- As an institutional LP, I can receive eligible RFQs, sign and encrypt bids, and learn whether I won without seeing competitors' bids.
- As an LP, I can create, replace, pause, and cancel standing bids through the UI or SDK.
- As an LP using a delegated bot signer, I can restrict its pair, notional, and expiry scope and revoke it immediately.
- As a winning liquidator, I can atomically provide an approved venue's debt asset and receive at least my required net collateral output without trusting a keeper or intermediate custodian.

### Depositor and curator

- As a depositor, I can deposit base assets, see shares and NAV, request a withdrawal, and understand whether it is immediate or queued.
- As a curator, I can configure quote haircuts, caps, approved RWAs, and whitelisted venue allocations within governance bounds.
- As a curator, I can allocate idle funds to approved lending/yield adapters and retrieve available liquidity for an RFQ.
- As a curator, I can permit a facility to compete for approved atomic liquidation opportunities within separate market, asset, notional, and concentration caps.
- As a curator, I can monitor acquired RWA redemption and realized loss through settlement.

### Operator

- As a guardian, I can pause the affected contract, facility, pair, adapter, or oracle path without taking user funds.
- As an auditor/operator, I can correlate commitments, TEE attestations, route results, and on-chain settlement without accessing losing-bid plaintext.

## Success Criteria

### Product acceptance

- **SC-1:** A Coston2 seller can complete an immediate atomic RWA-for-stablecoin swap against a signed LP standing bid.
- **SC-2:** A Coston2 seller can complete the same swap against a registered facility quote.
- **SC-3:** A blended LP/facility route settles completely or reverts completely when one leg fails or output is insufficient.
- **SC-4:** A scheduled auction supports all four approved durations and produces a deterministic best eligible route after applying expiry, eligibility, capacity, and min-output rules.
- **SC-5:** Relay/API/database inspection reveals ciphertext and operational metadata but not RFQ plaintext or losing bid plaintext.
- **SC-6:** Invalid TEE attestation, code hash, result signature, quorum, route deadline, bid signature, order nonce, or eligibility status prevents settlement.
- **SC-7:** A facility can deposit, allocate, quote, fill, book an acquired RWA, process verified issuer-redemption evidence, and satisfy or queue a withdrawal.
- **SC-8:** FDC-invalid or stale NAV data and FTSO-invalid or stale guardrails disable only affected quote paths.
- **SC-9:** Morpho, Kinetic, and Clearpool adapters pass the common adapter conformance suite using mainnet-fork tests where contracts are available and Coston2 mocks otherwise.
- **SC-10:** All role-based frontend routes work end-to-end with realistic loading, empty, error, signing, FCC matching, settlement, cancellation, expiry, and queued-redemption states.

### Security and quality gates

- **SC-11:** New trust-boundary logic has unit, fuzz, invariant, integration, and negative-path coverage; changed TypeScript/Go business logic targets 100% statement and branch coverage unless an exception is documented.
- **SC-12:** Static analysis, dependency scanning, secret scanning, contract fuzz/invariant tests, and an independent smart-contract/FCC review report no unresolved critical or high-severity findings before mainnet.
- **SC-13:** Mainnet deployment is blocked unless production FCC attestation is available, reproducible code hashes are verified, and the configured 2-of-3 TEE result quorum passes failure tests.
- **SC-14:** Under the pilot load profile of 100 concurrent auctions and 50 bids per auction, bid ingestion remains below 500 ms p95 excluding client encryption, and route calculation completes below 2 seconds p95 after the decision deadline.
- **SC-15:** The production frontend achieves WCAG 2.2 AA for tested flows and meets p75 Core Web Vitals targets of LCP <= 2.5 s, INP <= 200 ms, and CLS <= 0.1 on representative devices.
- **SC-16:** On a pinned Flare fork where supported, or an interface-faithful local/Coston2 venue mock otherwise, an approved Morpho or Kinetic liquidation route repays an eligible unhealthy position, receives collateral, charges exactly one router-level protocol fee, and delivers at least the bound winner's minimum net collateral output in one transaction; every injected leg failure reverts the complete route.

## Constraints and Assumptions

- Flare Mainnet chain ID is `14`; Coston2 chain ID is `114`.
- Solidity compilation must target Cancun-compatible EVM behavior.
- Flare system contracts are resolved through network-specific registry interfaces rather than copied addresses.
- FCC is still availability-gated. Local simulation and Coston2 may use a reduced topology, but simulated attestation is never represented as production security.
- The production confidentiality claim covers pre-trade data and losing bids. Winning execution details and transfers are public on Flare.
- The blind relay cannot promise availability; fail-closed semantics, encrypted durable queues, retries, and explicit facility-only fallback are required.
- Facilities accept the smart-contract, liquidity, oracle, issuer, and redemption risks of their allowlisted adapters and assets; the UI must disclose these risks.
- A mock permissioned RWA and Coston2 stablecoin are acceptable for testnet validation. Production token addresses and issuer policies require deployment-time verification.
- Existing Stellar code, tests, and deployment behavior remain intact until an explicit migration or retirement decision is made.

## Rollout

1. **Local:** deterministic contracts, mock tokens, simulated FCC, mock FDC/FTSO, interface-faithful lending-liquidation mocks, and complete UI state coverage.
2. **Coston2:** real wallet/RPC integration, real FCC extension when available, FDC/FTSO integration, mock permissioned RWA, stablecoin, and venue-interface or liquidation mocks as needed.
3. **Security gate:** reproducible FCC build, TEE attestation verification, 2-of-3 quorum test, contract audit, operational runbooks, load test, and incident exercise.
4. **Flare mainnet:** verified token/protocol addresses, conservative caps, zero or timelocked fee activation, monitored pilot facilities, and a production-hosted frontend.
5. **Post-MVP:** optional FAssets mint/redeem and FXRP-backed LP funding only if it does not delay or weaken the core protocol.

## Questions and Open Items

No material product or architecture questions remain open for requirements approval. The requirements review resolved the following decisions:

- the expanded Flare product is authoritative and is not restricted to a strict one-for-one chain port;
- early auction close is allowed only when declared at creation and always selects the deterministic best eligible route at the pinned early-close decision context;
- the router charges the single TrustRFQ protocol fee and enforces minimum output after that fee;
- confidential RFQ bids are bound to their originating seller and auction, while reusable standing/limit bids may serve any eligible taker within signed constraints; and
- atomic approved-venue liquidation is a core route, distinct from a post-seizure inventory RFQ.

The following items are explicitly deferred to deployment planning rather than unresolved requirements:

- production issuer and RWA onboarding agreements;
- final per-asset risk limits and quote haircuts;
- deployment-time verified addresses for external protocols and assets; and
- whether the optional FAssets funding rail ships after the core mainnet pilot.
