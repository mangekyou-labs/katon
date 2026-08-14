async page => {
  const raw = process.env.FLARE_FCC_E2E_JSON;
  if (!raw) throw new Error('LIVE_E2E_JSON_MISSING');
  const evidence = JSON.parse(raw);
  const fakeD9 = '0x' + 'd9'.repeat(32);
  const dummyGolden = '0x72661810cd0161f16bf2e4335a226171bd4eb6e6386058108dbb43e118acd975';
  const proxy = '0x7fa1817951de405a0c466696052cf50eba409333';
  const isolated = '0xb136b8a143bf358ae7976ed558bbb054fd13fae9';
  if (String(evidence.swapHash).toLowerCase() === fakeD9) throw new Error('FAKE_D9_HASH');
  if (String(evidence.routeHash).toLowerCase() === dummyGolden) throw new Error('DUMMY_GOLDEN_ROUTE');
  if (String(evidence.router).toLowerCase() === proxy) throw new Error('BROWSER_PROXY_ROUTER');
  if (String(evidence.router).toLowerCase() !== isolated) throw new Error('WRONG_ROUTER');
  if (Number(evidence.extensionId) !== 66283) throw new Error('WRONG_EXTENSION');
  const dappUrl = process.env.DAPP_URL || 'http://localhost:5173';

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

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (viewport.scrollWidth > viewport.clientWidth) throw new Error('HORIZONTAL_OVERFLOW');
  await page.screenshot({ path: 'output/playwright/flare-fcc-live-cli.png', fullPage: true });
  return {
    liveProof: true,
    router: evidence.router,
    swapHash: evidence.swapHash,
    routeHash: evidence.routeHash,
  };
}
