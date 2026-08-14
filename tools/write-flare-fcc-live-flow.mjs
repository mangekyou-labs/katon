import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertLiveFccE2eEvidence } from '../packages/flare-core/src/fccE2e.ts';

const evidence = assertLiveFccE2eEvidence(JSON.parse(readFileSync(resolve(process.env.EVIDENCE ?? 'output/playwright/fcc-live-e2e.json'), 'utf8')));
const dappUrl = process.env.DAPP_URL || 'http://localhost:5173';
const proofJson = JSON.stringify(evidence);
const out = resolve(process.env.FLARE_FCC_LIVE_FLOW ?? 'output/playwright/fcc-live-flow.generated.js');

writeFileSync(out, `async page => {
  const evidence = ${proofJson};
  const dappUrl = ${JSON.stringify(dappUrl)};
  await page.context().addInitScript((proof) => {
    window.__FLARE_ROUTER__ = proof.router;
    window.__FLARE_LIVE_PROOF__ = proof;
    window.__FLARE_FCC_MODE__ = 'real';
    window.__FLARE_FCC_INSTRUCTION_SENDER__ = proof.instructionSender;
    window.__FLARE_FCC_EXTENSION_ID__ = String(proof.extensionId);
  }, evidence);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dappUrl + '/swap', { waitUntil: 'domcontentloaded' });
  const panel = page.getByLabel('Live FCC settlement proof');
  await panel.waitFor();
  const text = await panel.innerText();
  if (!text.includes(evidence.router)) throw new Error('PROOF_ROUTER_MISSING');
  if (!text.includes(evidence.swapHash)) throw new Error('PROOF_SWAP_MISSING');
  if (!text.includes(evidence.routeHash)) throw new Error('PROOF_ROUTE_MISSING');
  if (!text.includes(evidence.actionId)) throw new Error('PROOF_ACTION_MISSING');
  if (!text.includes('66283')) throw new Error('PROOF_EXTENSION_MISSING');
  if (text.toLowerCase().indexOf('d9d9d9d9') !== -1) throw new Error('FAKE_D9_VISIBLE');
  if (text.toLowerCase().indexOf('72661810cd0161f1') !== -1) throw new Error('DUMMY_GOLDEN_VISIBLE');
  if (text.toLowerCase().indexOf('0x7fa1817951de405a') !== -1) throw new Error('BROWSER_PROXY_VISIBLE');
  await page.screenshot({ path: 'output/playwright/flare-fcc-live-cli.png', fullPage: true });
  return { liveProof: true, router: evidence.router, swapHash: evidence.swapHash, routeHash: evidence.routeHash };
}
`);
console.log('live-flow=' + out);
