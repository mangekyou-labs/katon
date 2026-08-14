# Flare infrastructure boundary

`docker-compose.yml` provides local MongoDB, the Mongo-backed Flare API,
Redis-compatible broker, Anvil, the Mongo-backed API, the Redis-checkpointed
indexer worker, and the strict Go FCC matcher HTTP boundary.
The API waits for Mongo persistence flushes before acknowledging workflow
mutations. The indexer, keeper, and web processes still run from workspace
commands while their production container/deployment definitions remain gated
work.

Cloudflare static hosting, Azure coordination workers, and GCP Confidential
Space images remain separate deployment concerns. Production secrets belong in
managed KMS/secret stores and never in the frontend bundle.

## Coston2 FCC indexer preflight

The official `ext-proxy` path requires read-only MySQL credentials issued by
Flare support. Keep them, together with the disposable three-stack identities,
in the ignored `.env.fcc.local` file. Generate the identity file first, then
add `FCC_INDEXER_MYSQL_USER` and `FCC_INDEXER_MYSQL_PASSWORD` without copying
them into source control:

```bash
npm run generate:flare:fcc:identities
npm run check:flare:fcc:indexer
docker compose --env-file .env.fcc.local -f infra/docker-compose.fcc.yml config --quiet
```

The preflight checks the documented Coston2 endpoint (`34.38.42.208:3306`,
database `indexer`) and reports only endpoint, database, and reachability; it
never prints credentials. A successful TCP check does not replace the FCC
deployment checks: each selected machine still needs status `2`, a fresh
availability check, a registered `teeId`, and a stable public HTTPS URL.

The compose file is deliberately non-production: it uses local HTTP, simulated
FCC, optional keeper sources, and replaceable host ports. A managed release must
pass `FLARE_RELEASE_PROFILE=production npm run check:flare:release-gates` with
HTTPS+mTLS, durable Mongo/Redis, all keeper source pairs, verified FCC/FDC/venue
evidence, and governance manifests supplied through its secret/configuration
system.

The proxy containers listen on the official FCC provider port `6664` inside
their isolated networks and expose local rehearsal ports `8664`, `8764`, and
`8864` by default. The extension containers listen on `6674`. Providers must
POST cosigned instructions to `/instruction`; they must not rely on indexer
polling to deliver work. These local HTTP endpoints are not valid Coston2
machine registrations; Coston2 requires fixed public HTTPS hostnames.
