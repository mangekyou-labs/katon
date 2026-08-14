// Katon Finance — Flare Summer Signal pitch deck
// node docs/hackathon/katon-deck.js
// Produces: docs/hackathon/Katon-Finance-Flare-Summer-Signal.pptx

const path = require("path");
const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333" x 7.5"
pres.title = "Katon Finance — Flare Summer Signal";
pres.author = "Katon Finance";
pres.subject = "Confidential RFQ exchange for RWA issuers on Flare";

const SW = 13.333;
const SH = 7.5;
const TOTAL = 10;

const BG = "0E1513";
const INK = "EDE9DE";
const INK_DIM = "8A8F86";
const INK_DIMMER = "5E635B";
const GREEN = "A8D95E";
const AMBER = "E8A54A";
const HAIRLINE = "2A322E";
const CARD = "141C19";

const FONT_MONO = "Consolas";
const FONT_SERIF = "Georgia";
const FONT_BODY = "Calibri";

const MARGIN_L = 0.6;
const MARGIN_R = 0.6;
const HEADER_Y = 0.35;

function addCornerMarks(slide) {
  const len = 0.2;
  const pad = 0.22;
  const col = INK_DIMMER;
  slide.addShape(pres.shapes.LINE, { x: pad, y: pad, w: len, h: 0, line: { color: col, width: 0.75 } });
  slide.addShape(pres.shapes.LINE, { x: pad, y: pad, w: 0, h: len, line: { color: col, width: 0.75 } });
  slide.addShape(pres.shapes.LINE, { x: SW - pad - len, y: pad, w: len, h: 0, line: { color: col, width: 0.75 } });
  slide.addShape(pres.shapes.LINE, { x: SW - pad, y: pad, w: 0, h: len, line: { color: col, width: 0.75 } });
  slide.addShape(pres.shapes.LINE, { x: pad, y: SH - pad, w: len, h: 0, line: { color: col, width: 0.75 } });
  slide.addShape(pres.shapes.LINE, { x: pad, y: SH - pad - len, w: 0, h: len, line: { color: col, width: 0.75 } });
  slide.addShape(pres.shapes.LINE, { x: SW - pad - len, y: SH - pad, w: len, h: 0, line: { color: col, width: 0.75 } });
  slide.addShape(pres.shapes.LINE, { x: SW - pad, y: SH - pad - len, w: 0, h: len, line: { color: col, width: 0.75 } });
}

function addTopBar(slide, sectionName, pageNum) {
  slide.addText(
    [
      { text: "KATON_FINANCE ", options: { color: INK } },
      { text: "// ", options: { color: INK_DIM } },
      { text: "FLARE_SUMMER_SIGNAL", options: { color: INK } },
    ],
    {
      x: MARGIN_L, y: HEADER_Y, w: 7.2, h: 0.35,
      fontFace: FONT_MONO, fontSize: 11, charSpacing: 2, margin: 0,
    }
  );
  slide.addText(
    [
      { text: "§ ", options: { color: INK_DIM } },
      { text: sectionName.toUpperCase() + "   ", options: { color: INK_DIM } },
      { text: String(pageNum).padStart(2, "0"), options: { color: GREEN } },
      { text: " / ", options: { color: INK_DIM } },
      { text: String(TOTAL), options: { color: INK_DIM } },
    ],
    {
      x: SW - 4.5 - MARGIN_R, y: HEADER_Y, w: 4.5, h: 0.35,
      fontFace: FONT_MONO, fontSize: 11, charSpacing: 2,
      align: "right", margin: 0,
    }
  );
}

function addEyebrow(slide, text, x, y, w, color = GREEN) {
  slide.addText(text, {
    x, y, w, h: 0.3,
    fontFace: FONT_MONO, fontSize: 11, color, charSpacing: 2.5,
    margin: 0,
  });
}

function addHairline(slide, x, y, w, color = HAIRLINE) {
  slide.addShape(pres.shapes.LINE, {
    x, y, w, h: 0, line: { color, width: 0.75 },
  });
}

function addCard(slide, x, y, w, h) {
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w, h,
    fill: { color: CARD },
    line: { color: HAIRLINE, width: 0.75 },
  });
}

// ------------------------------------------------------------------
// SLIDE 1 — Cover
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);

  slide.addShape(pres.shapes.OVAL, {
    x: MARGIN_L, y: HEADER_Y + 0.09, w: 0.14, h: 0.14,
    fill: { color: GREEN }, line: { color: GREEN, width: 0 },
  });
  slide.addText("COSTON2  ·  EXTENSION 66283", {
    x: MARGIN_L + 0.25, y: HEADER_Y, w: 5.5, h: 0.35,
    fontFace: FONT_MONO, fontSize: 11, color: INK_DIM, charSpacing: 2, margin: 0,
  });
  slide.addText("AUG 2026  ·  DEMO", {
    x: SW - 4 - MARGIN_R, y: HEADER_Y, w: 4, h: 0.35,
    fontFace: FONT_MONO, fontSize: 11, color: INK_DIM,
    align: "right", charSpacing: 2, margin: 0,
  });

  addEyebrow(slide, "KATON FINANCE  /  FLARE SUMMER SIGNAL", MARGIN_L, 1.55, 11);

  slide.addText("Sealed size.\nAtomic settlement.", {
    x: MARGIN_L, y: 2.05, w: 11.5, h: 2.3,
    fontFace: FONT_SERIF, fontSize: 52, color: INK, margin: 0,
  });

  slide.addText("A confidential RFQ exchange for RWA issuers. Bids stay inside Flare Confidential Compute. One typed route clears on Coston2.", {
    x: MARGIN_L, y: 4.55, w: 9.2, h: 0.85,
    fontFace: FONT_BODY, fontSize: 16, color: INK_DIM, margin: 0,
  });

  slide.addText("PREPARED FOR", {
    x: MARGIN_L, y: SH - 1.25, w: 3.6, h: 0.25,
    fontFace: FONT_MONO, fontSize: 10, color: INK_DIM, charSpacing: 2, margin: 0,
  });
  slide.addText("Flare judges", {
    x: MARGIN_L, y: SH - 0.95, w: 3.6, h: 0.4,
    fontFace: FONT_SERIF, fontSize: 22, color: INK, margin: 0,
  });
  slide.addText("BOUNTIES", {
    x: 7.4, y: SH - 1.25, w: 5.3, h: 0.25,
    fontFace: FONT_MONO, fontSize: 10, color: INK_DIM,
    align: "right", charSpacing: 2, margin: 0,
  });
  slide.addText("FCC  +  Interoperable Assets", {
    x: 7.4, y: SH - 0.95, w: 5.3, h: 0.4,
    fontFace: FONT_BODY, fontSize: 16, color: GREEN,
    align: "right", margin: 0,
  });
}

// ------------------------------------------------------------------
// SLIDE 2 — Problem
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "PROBLEM", 2);

  addEyebrow(slide, "WHY ISSUERS CANNOT USE A PUBLIC BOOK", MARGIN_L, 1.05, 10);
  slide.addText("Block-sized RWA flow does not belong on an AMM.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.7,
    fontFace: FONT_SERIF, fontSize: 28, color: INK, margin: 0,
  });

  const problems = [
    { k: "01", t: "Slippage", d: "A large redeem walks the pool. The last fill is not the first quote." },
    { k: "02", t: "Leaked intent", d: "A resting order advertises inventory. The rest of the market trades first." },
    { k: "03", t: "Broken settlement", d: "A handshake plus two transfers is not atomic. One side can walk." },
  ];
  problems.forEach((p, i) => {
    const x = MARGIN_L + i * 4.05;
    addCard(slide, x, 2.4, 3.85, 3.6);
    slide.addText(p.k, {
      x: x + 0.28, y: 2.6, w: 3.3, h: 0.4,
      fontFace: FONT_MONO, fontSize: 14, color: GREEN, margin: 0,
    });
    slide.addText(p.t, {
      x: x + 0.28, y: 3.15, w: 3.3, h: 0.55,
      fontFace: FONT_SERIF, fontSize: 24, color: INK, margin: 0,
    });
    slide.addText(p.d, {
      x: x + 0.28, y: 3.85, w: 3.3, h: 1.7,
      fontFace: FONT_BODY, fontSize: 15, color: INK_DIM, margin: 0,
    });
  });
}

// ------------------------------------------------------------------
// SLIDE 3 — Product
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "PRODUCT", 3);

  addEyebrow(slide, "KATON IN ONE PASS", MARGIN_L, 1.05, 8);
  slide.addText("Request privately. Bid inside FCC. Settle once.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.6,
    fontFace: FONT_SERIF, fontSize: 26, color: INK, margin: 0,
  });

  const steps = [
    { n: "1", t: "Issuer RFQ", d: "Size, pair, expiry. No public book." },
    { n: "2", t: "Sealed bids", d: "LPs encrypt to three FCC machines." },
    { n: "3", t: "2-of-3 quorum", d: "submitFccResult unlocks the route hash." },
    { n: "4", t: "Atomic fill", d: "executeSwapRoute + 50 bps fee." },
  ];
  steps.forEach((s, i) => {
    const x = MARGIN_L + i * 3.05;
    addCard(slide, x, 2.25, 2.9, 2.55);
    slide.addText(s.n, {
      x: x + 0.22, y: 2.4, w: 2.45, h: 0.35,
      fontFace: FONT_MONO, fontSize: 14, color: GREEN, margin: 0,
    });
    slide.addText(s.t, {
      x: x + 0.22, y: 2.85, w: 2.45, h: 0.45,
      fontFace: FONT_SERIF, fontSize: 18, color: INK, margin: 0,
    });
    slide.addText(s.d, {
      x: x + 0.22, y: 3.4, w: 2.45, h: 1.1,
      fontFace: FONT_BODY, fontSize: 14, color: INK_DIM, margin: 0,
    });
  });

  slide.addText("Target user: RWA issuers and tokenized-fund managers who need block liquidity without advertising inventory. LPs quote sealed. Curators set eligibility.", {
    x: MARGIN_L, y: 5.15, w: 12.1, h: 0.85,
    fontFace: FONT_BODY, fontSize: 15, color: INK_DIM, margin: 0,
  });
  slide.addText("Product name is Katon. EIP-712 domain stays TrustRFQ / 1 so signed typehashes do not move.", {
    x: MARGIN_L, y: 6.05, w: 12.1, h: 0.45,
    fontFace: FONT_BODY, fontSize: 14, color: AMBER, margin: 0,
  });
}

// ------------------------------------------------------------------
// SLIDE 4 — Flare
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "FLARE", 4);

  addEyebrow(slide, "NOT A GENERIC EVM PORT", MARGIN_L, 1.05, 8);
  slide.addText("Every settlement gate is a Flare primitive.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.55,
    fontFace: FONT_SERIF, fontSize: 26, color: INK, margin: 0,
  });

  const rows = [
    ["FCC 66283", "dispatchConfidential + 2-of-3 submitFccResult. Router will not fill without the quorum verifier."],
    ["FTSO", "FtsoRiskGuard requires a fresh snapshot (max age 256) before executeSwapRoute."],
    ["FDC NAV", "NavProofRegistry wired to official Coston2 FDC verification 0x906507E0…"],
    ["Registry", "TEE manager 0x1a9C4A0f…. Three machines registered. FAsset adapters stay off until official addresses exist."],
  ];
  rows.forEach((r, i) => {
    const y = 2.15 + i * 1.05;
    addCard(slide, MARGIN_L, y, 12.1, 0.95);
    slide.addText(r[0], {
      x: MARGIN_L + 0.28, y: y + 0.22, w: 2.6, h: 0.5,
      fontFace: FONT_MONO, fontSize: 14, color: GREEN, margin: 0, valign: "middle",
    });
    slide.addText(r[1], {
      x: MARGIN_L + 3.0, y: y + 0.18, w: 8.8, h: 0.6,
      fontFace: FONT_BODY, fontSize: 15, color: INK, margin: 0, valign: "middle",
    });
  });
}

// ------------------------------------------------------------------
// SLIDE 5 — Architecture
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "STACK", 5);

  addEyebrow(slide, "WHAT THE REPO IS", MARGIN_L, 1.05, 8);
  slide.addText("A desk, a blind relay, a matcher, and Cancun contracts.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.55,
    fontFace: FONT_SERIF, fontSize: 24, color: INK, margin: 0,
  });

  const boxes = [
    { t: "flare-web", d: "React 19 desk. Seven routes. Reads /runtime-config.js." },
    { t: "flare-api", d: "Blind relay. Ciphertext only. Plaintext workflow disabled." },
    { t: "fcc-matcher", d: "Go handler inside the official FCC extension (RFQ / BID / MATCH)." },
    { t: "contracts", d: "Router, settlement, sender, FTSO guard, FDC NAV, facility." },
  ];
  boxes.forEach((b, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN_L + col * 6.15;
    const y = 2.2 + row * 2.0;
    addCard(slide, x, y, 5.95, 1.8);
    slide.addText(b.t, {
      x: x + 0.3, y: y + 0.28, w: 5.35, h: 0.4,
      fontFace: FONT_MONO, fontSize: 16, color: GREEN, margin: 0,
    });
    slide.addText(b.d, {
      x: x + 0.3, y: y + 0.8, w: 5.35, h: 0.7,
      fontFace: FONT_BODY, fontSize: 16, color: INK, margin: 0,
    });
  });
}

// ------------------------------------------------------------------
// SLIDE 6 — Live evidence
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "COSTON2", 6);

  addEyebrow(slide, "DEPLOYED. NOT MAINNET.", MARGIN_L, 1.05, 8);
  slide.addText("Isolated FCC path judges should open.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.5,
    fontFace: FONT_SERIF, fontSize: 26, color: INK, margin: 0,
  });

  const facts = [
    { l: "RFQRouter", v: "0xb136b8a143bF358Ae7976ED558BBB054fd13faE9" },
    { l: "FCC sender", v: "0x55aA4F400f3819498eD4Cbe120839E609f0897F3" },
    { l: "Settlement", v: "0x6dc51b3ef4eea9d7b0609381491e00abf3720674" },
    { l: "Extension", v: "66283   ·   quorum 2 of 3" },
    { l: "Swap tx", v: "0x927fc6be…   ·   block 34063162" },
  ];
  facts.forEach((f, i) => {
    const y = 2.1 + i * 0.78;
    slide.addText(f.l, {
      x: MARGIN_L, y, w: 2.4, h: 0.65,
      fontFace: FONT_MONO, fontSize: 13, color: INK_DIM, margin: 0, valign: "middle",
    });
    addCard(slide, MARGIN_L + 2.5, y, 9.6, 0.65);
    slide.addText(f.v, {
      x: MARGIN_L + 2.7, y, w: 9.2, h: 0.65,
      fontFace: FONT_MONO, fontSize: 14, color: INK, margin: 0, valign: "middle",
    });
  });
}

// ------------------------------------------------------------------
// SLIDE 7 — Judge walk
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "DEMO", 7);

  addEyebrow(slide, "TEN MINUTES", MARGIN_L, 1.05, 8);
  slide.addText("What to click. What not to infer.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.5,
    fontFace: FONT_SERIF, fontSize: 26, color: INK, margin: 0,
  });

  const left = [
    "Open katon-azure.vercel.app. MetaMask → Coston2.",
    "Walk /swap, /auctions, /standing-bids, /facility.",
    "Read /runtime-config.js — unbundled addresses.",
    "Open the swap tx on coston2-explorer.",
  ];
  const right = [
    "Hosted demo is the SPA only.",
    "Full auction loop needs local flare-api.",
    "Browser Sign-and-submit is the demo-router path.",
    "Live FCC settle is script-signed, then displayed.",
  ];

  addCard(slide, MARGIN_L, 2.15, 5.95, 4.2);
  slide.addText("DO", {
    x: MARGIN_L + 0.3, y: 2.35, w: 5.3, h: 0.35,
    fontFace: FONT_MONO, fontSize: 14, color: GREEN, margin: 0,
  });
  left.forEach((line, i) => {
    slide.addText((i + 1).toString().padStart(2, "0") + "   " + line, {
      x: MARGIN_L + 0.3, y: 2.85 + i * 0.75, w: 5.35, h: 0.65,
      fontFace: FONT_BODY, fontSize: 15, color: INK, margin: 0,
    });
  });

  addCard(slide, MARGIN_L + 6.15, 2.15, 5.95, 4.2);
  slide.addText("DO NOT CLAIM", {
    x: MARGIN_L + 6.45, y: 2.35, w: 5.3, h: 0.35,
    fontFace: FONT_MONO, fontSize: 14, color: AMBER, margin: 0,
  });
  right.forEach((line, i) => {
    slide.addText((i + 1).toString().padStart(2, "0") + "   " + line, {
      x: MARGIN_L + 6.45, y: 2.85 + i * 0.75, w: 5.35, h: 0.65,
      fontFace: FONT_BODY, fontSize: 15, color: INK, margin: 0,
    });
  });
}

// ------------------------------------------------------------------
// SLIDE 8 — Built during the program
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "BUILT", 8);

  addEyebrow(slide, "STELLAR DESK  →  FLARE PROTOCOL", MARGIN_L, 1.05, 10);
  slide.addText("Ported the RFQ idea. Rebuilt settlement on Flare.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.55,
    fontFace: FONT_SERIF, fontSize: 24, color: INK, margin: 0,
  });

  const built = [
    { t: "Before", d: "TrustRFQ on Stellar: off-chain RFQ thread, dual-signed Soroban fill." },
    { t: "Contracts", d: "New Cancun router, settlement, FCC sender, FTSO guard, FDC NAV, facility." },
    { t: "FCC matcher", d: "Go handler in the official extension. Live 2-of-3 on extension 66283." },
    { t: "Desk", d: "Issuer / LP / curator UI plus a relay that never stores plaintext bids." },
  ];
  built.forEach((b, i) => {
    const y = 2.15 + i * 1.05;
    addHairline(slide, MARGIN_L, y, 12.1);
    slide.addText(b.t, {
      x: MARGIN_L, y: y + 0.18, w: 2.6, h: 0.7,
      fontFace: FONT_MONO, fontSize: 14, color: GREEN, margin: 0, valign: "middle",
    });
    slide.addText(b.d, {
      x: MARGIN_L + 2.8, y: y + 0.18, w: 9.3, h: 0.7,
      fontFace: FONT_BODY, fontSize: 16, color: INK, margin: 0, valign: "middle",
    });
  });
}

// ------------------------------------------------------------------
// SLIDE 9 — Honesty
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "STATUS", 9);

  addEyebrow(slide, "SAY ONLY WHAT THE CHAIN SHOWS", MARGIN_L, 1.05, 10);
  slide.addText("Protocol-complete on Coston2. Not production.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.55,
    fontFace: FONT_SERIF, fontSize: 26, color: INK, margin: 0,
  });

  const yes = ["Isolated router + sender on Coston2", "Extension 66283, three machines, quorum 2", "Live executeSwapRoute after FCC results", "FTSO guard + FDC NAV wiring"];
  const no = ["Confidential Space / hardware attestation", "Browser-signed confidential fill", "Official venue / FAsset addresses", "Users, pilots, Songbird, mainnet"];

  addCard(slide, MARGIN_L, 2.2, 5.95, 4.15);
  slide.addText("SHIPPED", {
    x: MARGIN_L + 0.3, y: 2.4, w: 5.3, h: 0.35,
    fontFace: FONT_MONO, fontSize: 13, color: GREEN, margin: 0,
  });
  yes.forEach((line, i) => {
    slide.addText(line, {
      x: MARGIN_L + 0.3, y: 2.95 + i * 0.75, w: 5.35, h: 0.65,
      fontFace: FONT_BODY, fontSize: 16, color: INK, margin: 0,
    });
  });

  addCard(slide, MARGIN_L + 6.15, 2.2, 5.95, 4.15);
  slide.addText("NOT CLAIMED", {
    x: MARGIN_L + 6.45, y: 2.4, w: 5.3, h: 0.35,
    fontFace: FONT_MONO, fontSize: 13, color: AMBER, margin: 0,
  });
  no.forEach((line, i) => {
    slide.addText(line, {
      x: MARGIN_L + 6.45, y: 2.95 + i * 0.75, w: 5.35, h: 0.65,
      fontFace: FONT_BODY, fontSize: 16, color: INK, margin: 0,
    });
  });
}

// ------------------------------------------------------------------
// SLIDE 10 — Roadmap
// ------------------------------------------------------------------
{
  const slide = pres.addSlide();
  slide.background = { color: BG };
  addCornerMarks(slide);
  addTopBar(slide, "NEXT", 10);

  addEyebrow(slide, "AFTER THE HACKATHON", MARGIN_L, 1.05, 8);
  slide.addText("Attest the TEEs. Sign from the wallet. Find one issuer.", {
    x: MARGIN_L, y: 1.4, w: 12, h: 0.6,
    fontFace: FONT_SERIF, fontSize: 24, color: INK, margin: 0,
  });

  const next = [
    { n: "01", t: "Confidential Space", d: "Replace SIMULATED_TEE=true with hardware attestation." },
    { n: "02", t: "Wallet settle", d: "MetaMask-signed executeSwapRoute from the dApp." },
    { n: "03", t: "Venues", d: "Turn on official Coston2 / FAsset adapters when addresses exist." },
    { n: "04", t: "Pilot → mainnet", d: "One issuer desk, then Songbird, then Flare Mainnet." },
  ];
  next.forEach((s, i) => {
    const x = MARGIN_L + i * 3.05;
    addCard(slide, x, 2.25, 2.9, 3.0);
    slide.addText(s.n, {
      x: x + 0.22, y: 2.45, w: 2.45, h: 0.35,
      fontFace: FONT_MONO, fontSize: 13, color: GREEN, margin: 0,
    });
    slide.addText(s.t, {
      x: x + 0.22, y: 2.9, w: 2.45, h: 0.7,
      fontFace: FONT_SERIF, fontSize: 18, color: INK, margin: 0,
    });
    slide.addText(s.d, {
      x: x + 0.22, y: 3.7, w: 2.45, h: 1.25,
      fontFace: FONT_BODY, fontSize: 14, color: INK_DIM, margin: 0,
    });
  });

  slide.addText("katon-azure.vercel.app     ·     github.com/mangekyou-labs/katon     ·     Coston2     ·     Not audited", {
    x: MARGIN_L, y: 5.6, w: 12.1, h: 0.4,
    fontFace: FONT_MONO, fontSize: 13, color: INK_DIM, margin: 0,
  });
}

const out = path.join(__dirname, "Katon-Finance-Flare-Summer-Signal.pptx");
pres.writeFile({ fileName: out }).then(() => {
  console.log("wrote", out);
});
