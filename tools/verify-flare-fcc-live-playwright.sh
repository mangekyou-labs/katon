#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DAPP_URL="${DAPP_URL:-http://localhost:5173}"
export EVIDENCE="${FLARE_FCC_E2E_EVIDENCE:-output/playwright/fcc-live-e2e.json}"
SESSION="fcc-live-66283"

if [[ "${FLARE_FCC_E2E_REUSE:-}" != "1" ]]; then
  npm run settle:flare:fcc:coston2
fi

if [[ ! -f "$EVIDENCE" ]]; then
  echo "LIVE_E2E_EVIDENCE_MISSING path=$EVIDENCE" >&2
  exit 2
fi

EVIDENCE="$EVIDENCE" node --import tsx --input-type=module -e "
import { readFileSync } from 'node:fs';
import { assertLiveFccE2eEvidence } from './packages/flare-core/src/fccE2e.ts';
assertLiveFccE2eEvidence(JSON.parse(readFileSync(process.env.EVIDENCE, 'utf8')));
console.log('live-evidence=PASS');
" 

curl -fsS "$DAPP_URL/swap" >/dev/null

close_session() {
  npm run qa:cli -- "-s=$SESSION" close >/dev/null 2>&1 || true
}
trap close_session EXIT

mkdir -p output/playwright
export DAPP_URL
node --import tsx tools/write-flare-fcc-live-flow.mjs
npm run qa:cli -- "-s=$SESSION" open about:blank --browser chromium
npm run qa:cli -- "-s=$SESSION" run-code --filename=output/playwright/fcc-live-flow.generated.js
npm run qa:cli -- "-s=$SESSION" snapshot
npm run qa:cli -- "-s=$SESSION" console error

echo "playwright-cli=PASS flow=fcc-live-66283 screenshot=output/playwright/flare-fcc-live-cli.png"
