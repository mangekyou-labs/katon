#!/bin/sh
# One-container free-tier entrypoint: Redis + official tee-proxy + simulated TEE.
# Secrets come from the process environment. Never echo them.
set -eu

PORT="${PORT:-6664}"
CHAIN_ID="${CHAIN_ID:-114}"
SIMULATED_TEE="${SIMULATED_TEE:-true}"
INDEXER_HOST="${FCC_INDEXER_MYSQL_HOST:-34.38.42.208}"
INDEXER_PORT="${FCC_INDEXER_MYSQL_PORT:-3306}"
INDEXER_DB="${FCC_INDEXER_MYSQL_DATABASE:-indexer}"
INDEXER_USER="${FCC_INDEXER_MYSQL_USER:-}"
INDEXER_PASSWORD="${FCC_INDEXER_MYSQL_PASSWORD:-}"

if [ -z "${PROXY_PRIVATE_KEY:-}" ]; then
  echo "fcc-render=BLOCKED reason=PROXY_PRIVATE_KEY_REQUIRED" >&2
  exit 1
fi
if [ -z "$INDEXER_USER" ] || [ -z "$INDEXER_PASSWORD" ]; then
  echo "fcc-render=BLOCKED reason=FCC_INDEXER_CREDENTIALS_REQUIRED" >&2
  exit 1
fi

umask 077
mkdir -p /app/config
cat > /app/config/config.toml <<EOF
redis_port = "127.0.0.1:6379"
private_key_variable = "PROXY_PRIVATE_KEY"
initial_signing_policy_offset = 2
signing_policy_fetch_interval = "20s"
chain_id = ${CHAIN_ID}

[db]
host = "${INDEXER_HOST}"
port = ${INDEXER_PORT}
database = "${INDEXER_DB}"
username = "${INDEXER_USER}"
password = "${INDEXER_PASSWORD}"
log_queries = false

[addresses]
flare_systems_manager = "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52"
relay = "0xa10B672D1c62e5457b17af63d4302add6A99d7dE"
voter_registry = "0x6a0AF07b7972177B176d3D422555cbc98DfDe914"

[ports]
internal = "6663"
external = "${PORT}"

[info_timing]
cycle_internal = "10s"
cycle_queue_response_wait = "2s"

[voting]
proposal_expiration = "12s"
max_pending_request = 10000
EOF

redis-server --daemonize yes --save "" --appendonly no --bind 127.0.0.1 --port 6379
export MODE=1
export SIMULATED_TEE
export CHAIN_ID
export CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
export PROXY_URL="http://127.0.0.1:6663"
export CONFIG_PORT=5501
export SIGN_PORT=7701
export EXTENSION_PORT=7702
export LOG_LEVEL="${LOG_LEVEL:-INFO}"

/app/extension-tee &
TEE_PID=$!
/app/proxy &
PROXY_PID=$!

term() {
  kill "$PROXY_PID" "$TEE_PID" 2>/dev/null || true
}
trap term INT TERM

while kill -0 "$PROXY_PID" 2>/dev/null && kill -0 "$TEE_PID" 2>/dev/null; do
  sleep 2
done
echo "fcc-render=BLOCKED reason=PROCESS_EXIT" >&2
term
exit 1
