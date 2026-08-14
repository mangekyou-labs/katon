#!/usr/bin/env bash
set -euo pipefail

DAPP_URL="${DAPP_URL:-http://127.0.0.1:5173}"
FLARE_API_URL="${FLARE_API_URL:-http://127.0.0.1:8787}"
SESSION="confidential-rfq-proof"

if [[ "$DAPP_URL" != "http://127.0.0.1:5173" || "$FLARE_API_URL" != "http://127.0.0.1:8787" ]]; then
  echo "This verifier currently binds the injected browser runtime to http://127.0.0.1:5173 and http://127.0.0.1:8787." >&2
  exit 2
fi

# Preserve independently measured matcher evidence even when a listener or
# browser preflight fails. This remains simulated FCC evidence only.
npm run test:e2e:flare:in-process
curl -fsS "$DAPP_URL/swap" >/dev/null
curl -fsS "$FLARE_API_URL/v1/health" >/dev/null
node tools/local-rfq-e2e.mjs
mkdir -p output/playwright

close_session() {
  npm run qa:cli -- "-s=$SESSION" close >/dev/null 2>&1 || true
}
trap close_session EXIT

npm run qa:cli -- "-s=$SESSION" open about:blank --browser chromium
npm run qa:cli -- "-s=$SESSION" snapshot
npm run qa:cli -- "-s=$SESSION" run-code --filename=tools/flare-playwright-cli-flow.js
npm run qa:cli -- "-s=$SESSION" snapshot
npm run qa:cli -- "-s=$SESSION" console error

echo "playwright-cli=PASS flow=confidential-rfq screenshot=output/playwright/flare-confidential-rfq-cli.png"
