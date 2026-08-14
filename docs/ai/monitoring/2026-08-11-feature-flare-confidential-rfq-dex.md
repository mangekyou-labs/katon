---
phase: monitoring
title: Flare Confidential RFQ DEX Monitoring & Observability
description: Privacy-safe metrics, alerts, and incident response
feature: flare-confidential-rfq-dex
status: in-progress
---

# Monitoring & Observability

## Metrics

Track auction lifecycle latency, encrypted delivery lag, API/broker health,
TEE availability and code hash, quorum agreement, route reverts, FDC proof age,
FTSO age/deviation, adapter liquidity, NAV drift, withdrawal queue age,
redemption SLA, and indexer cursor lag. Labels use commitments and safe error
codes, never RFQ/bid plaintext, credentials, signatures, or proof bytes.

## Alerts

- Critical: quorum mismatch/loss, unexpected simulated-attestation mode,
  contract pause, proof verification failures, indexer divergence, or repeated
  atomic route reverts.
- Warning: stale FDC/FTSO data, adapter liquidity collapse, redemption SLA
  growth, queue growth, broker backpressure, RPC failover, or keeper retries.

## Health checks

Every service should expose liveness/readiness separately. Readiness checks RPC
chain ID, registry resolution, database/broker connectivity, indexer freshness,
and (for FCC) attestation/code-hash policy. A healthy relay must not imply that
confidential matching is available; the UI must show FCC assurance explicitly.

The indexer exposes `fresh`, `stale`, and `unknown` freshness states, the age and
configured threshold in JSON health responses, and the
`trustrfq_indexer_fresh` Prometheus gauge. `/readyz` remains unavailable until a
successful poll is recent; `/healthz` still distinguishes process liveness from
fresh read-model readiness.

## Incident response

1. Pause only the affected pair, adapter, facility, or proof path where safe;
   use global pause for suspected fund-safety or confidentiality compromise.
2. Preserve commitment IDs, safe error codes, block/cursor context, and attested
   hashes. Do not export plaintext payloads for debugging.
3. Reconcile chain events against a rebuilt read model, rotate/revoke affected
   encryption keys or bot credentials, and require security review before
   resuming.
4. Record post-incident actions and any new release-gate test.

## Production status

The current worktree has local unit/contract tests plus Redis-backed indexer and
keeper readiness endpoints, including indexer freshness classification, but no production telemetry deployment. Production
keeper mode now fails closed unless all five typed job source pairs are
configured; local compose explicitly runs with that requirement disabled. Real
dashboards, alerts, FCC machine health, backup/restore evidence, and 24-hour
soak tests are release tasks, not claims made by local verification.
