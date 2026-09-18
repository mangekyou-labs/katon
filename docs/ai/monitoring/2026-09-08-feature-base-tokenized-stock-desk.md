---
phase: monitoring
title: Katon Base Tokenized Stock Desk Monitoring
description: Metrics, alerts, and incident response for the private B20 stock-sale desk
feature: base-tokenized-stock-desk
status: draft
---

# Monitoring & Observability

Labels use RFQ ids, route hashes, and stable fail-closed strings. Never log losing LP prices, signatures, seeds, or raw oracle registry credentials.

## Key Metrics

### Performance Metrics

- Auction collection and rank latency excluding RPC, and RPC snapshot latency
- API POST `/v1/swaps/quote` latency, cutoff misses, and error rate
- Provider response timeout, malformed-packet, simulation, and late-response counts
- Internal route execution success/revert rate and external-route selection rate
- Indexer cursor lag versus head
- Qualified soak report: duration, concurrency, request count, request/schema
  failures, elapsed time, post-GC retained heap growth, OLS heap slope, heap
  sample count, qualification status, and a credential-redacted URL

The API soak qualifies only a managed child run at exactly 600 seconds and
concurrency 4, with zero request/schema failures, retained growth no greater
than 32 MiB, and heap slope no greater than 1 MiB/minute. Short or externally
hosted runs remain useful diagnostics but must report `qualified=false`.

### Business Metrics

- Open, quoted, expired, and `MIN_OUT`/`NO_ROUTE` swap requests
- Facility TVL (idle vs allocated) in native USDC
- Facility acquisition/redemption P/L and queued-withdrawal reserve
- Liquidation API calls rejected by the product gate (must remain zero in normal retail operation)

### Error Metrics

- Revert reasons: `MIN_OUT`, `UNAUTHORIZED`, `ORACLE_UNAVAILABLE`, `B20_PAUSED`, `SEQUENCER_DOWN`, `EXPIRED`
- Provider adapter and facility quote failures
- Adapter deposit/withdraw/redemption failures
- Unexpected liquidation enablement or a non-empty liquidation venue manifest
- Unexpected presence of a configured settlement key (boot must fail)

## Monitoring Tools

- Structured JSON logs from `apps/base-api`, indexer, keepers
- Host metrics for CPU/memory on API and Mongo
- On-chain event tail for swap route, fill, pause, `MultiplierUpdated`, redemption, and P/L
- No third-party analytics that ingest bid prices

## Logging Strategy

- Levels: info for RFQ ingest/rank/finalize, warn for fail-closed, error for unexpected reverts
- Redact bid prices, signatures, and authorization headers
- Retain Sepolia logs 14 days, mainnet per operator policy
- Playwright artifacts scanned for seed/password/private key

## Alerts & Notifications

### Critical Alerts

- Oracle or sequencer fail-open (a settlement succeeded while the guard should have reverted)
- B20 `isAuthorized` miss on a mined fill
- API process with a settlement private key configured
- Venue bytecode hash drift versus manifest
- Repeated atomic swap-route reverts after a passing smoke
- Any successful liquidation route while `KATON_BASE_LIQUIDATIONS_ENABLED` is false

### Warning Alerts

- Chainlink answer older than heartbeat
- Sequencer down inside grace period
- Facility withdrawable USDC below curator threshold
- Indexer lag above the configured block threshold
- Rank latency above 200 ms in-process excluding RPC

## Dashboards

- Desk health: open swaps, auction cutoff p95, provider availability, revert mix, oracle age, sequencer
- Facility: TVL, allocations per adapter, queue depth
- Compliance: B20 pause bits, multiplier, unauthorized revert count, eligibility denials
- Release gates: mainnet/deployment/liquidation flags and canonical-address manifest status

## Incident Response

### On-Call Rotation

- Operator-defined. Pause keys are the guardian/timelock, not the API.

### Incident Process

1. Detect via alert or smoke
2. Pause router/facilities if funds are at risk
3. Diagnose with logs and on-chain events (no bid-price dumps)
4. Patch, re-run the swap settlement, facility, and release-gate tests, unpause
5. Write a short post-mortem in the monitoring doc

## Health Checks

- API `/healthz` process liveness; `/readyz` needs Mongo, RPC chain ID, and manifest load
- Readiness must not imply that oracle feeds are fresh; the UI shows oracle/sequencer/B20 status separately
- Keepers expose last-successful detection timestamp
- Automated Sepolia smoke after deploy (planning T6.3)
