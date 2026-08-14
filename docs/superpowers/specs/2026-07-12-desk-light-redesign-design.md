# TrustRFQ desk redesign — "milky swap" light theme + section sheet

**Date:** 2026-07-12
**Status:** approved (plan session, user-approved via AskUserQuestion round + plan approval)
**Branch:** `design`

## Context

The user supplied a mobile reference mockup — a light "swap app" screen (milky white cards on a
gray-lavender canvas, SF-Pro-like type, black pill CTA) — and asked for the OTC desk (`otc.html`)
to be redesigned to match it **start to finish**: colors, type, layout feel, simplicity. The dark +
gold "private desk" theme goes away entirely. Separately, the three tab buttons (New order /
Incoming / Sent) collapse into a single control.

This replaces the "redesign the desk to match the landing" roadmap note: the desk now follows the
supplied reference, not the landing's electric indigo.

## Locked decisions (user-chosen)

1. **Single control = floating pill button** fixed at bottom-center (active section name + pending
   count + menu glyph). Clicking opens a **centered modal sheet** (dimmed backdrop) with three
   large options; choosing one switches the panel and closes the sheet. The `.tabs` bar leaves the
   desk (but its CSS survives for the intent page).
2. **Desktop layout: centered single column** (~560–640px of content), generous whitespace.
3. **Intent page gets a harmony pass**: `intent.css`'s hardcoded gold/red/white-wash literals are
   recolored to the new palette. No selector, spacing, or layout changes there.
4. **Gold is gone.** Neutral palette: white cards, near-black ink accent/CTA, light gray-lavender
   canvas. Functional green/red stay, retuned for a light ground. Logo SVGs switch to
   `currentColor` (ink).
5. **Type: Inter** (display + body; Google Fonts — already CSP-allowed). IBM Plex Mono stays for
   addresses/hashes/utility labels. Amounts get `font-variant-numeric: tabular-nums`.
6. **CTA look = the reference's "Slide to Swap" pill** (white orb left, "›››" right) but a normal
   click button. Copy stays "Sign & send order".
7. **(added mid-implementation, 2026-07-12)** The counterparty/expiry/signing-as fields do NOT get
   their own card — they live INSIDE the bottom notched card, below a hairline, so the whole form
   reads as one card unit ("ilk kartta olsun her şey"). And the canvas is the reference's cooler
   lavender: `--bg #E2E5F3`, gradient `#EBEDF8 → #D5D9EE`.

## The reference, tokenized

- Canvas: vertical gradient `#EBEDF8 → #D5D9EE` (flat fallback `#E2E5F3`) — cool lavender.
- Cards: pure white, large radii (32px), soft lavender diffuse shadows — no borders.
- Ink ramp: `#111218` primary; alphas .78/.66/.58 for secondary tiers (the .58 tier ≈ 4.7:1 on
  white — verified against rendered pixels; bump to .62 if any surface fails).
- Accent (CTA/active states): near-black ink `#16171D` (gradient `#2E3038 → #16171D → #000`),
  white text on it.
- Functional: green `#0E7C4A`, red `#C93838` (≥ 4.5:1 on white).
- Signature element: the swap legs are **two white cards with a scalloped notch** — a circular
  swap button sits in the gap and the card edges curve around it. Technique: CSS `mask` on the
  card; `filter: drop-shadow` on a plain `.ticket__card-shadow` wrapper (a mask clips its own
  element's shadows/filter output — filter runs before mask — so the shadow must live one level
  up, where it traces the notched silhouette). Everything else stays quiet.

## Compatibility contract (hard constraint)

`intent.html` loads `styles.css` + `intent.css`; the intent JSX hardcodes styles.css classes
(`.tabs/.tab/.tab__count` — src/intent/App.tsx:110-126 — plus `btn*`, `order*`, `legbox*`,
`field*`, `ticket*`, `badge`, `topbar*`, `wallet-chip*`, `wrap`, `panel`, `empty`, `backdrop`,
`starfield`, `eyebrow`, `settle__err`, `maker-addr`, `hint`, `input--num`, `leg`, `row2`,
`form-actions`, `legs*`, `sig`). intent.css consumes tokens `--r-*`, `--font-*`, `--gold(-hi)`,
`--green`, `--red`, `--text-1..4`, `--line-1..3`, `--bg-raised`, `--bg-sunken`, `--shadow-card`.

**Rule: no class name and no token NAME is removed or renamed — only values change.** The
`--gold` family becomes the ink-accent family (`--gold #16171D`, `--gold-hi #2E3038`,
`--gold-lo #000000`, `--gold-ink #FFFFFF`); everywhere "gold" was the primary accent it now reads
as ink, which is exactly the reference's semantics. New tokens are additive only
(`--bg-grad-a/b`, `--shadow-pop`, `--shadow-float`).

Desk-only looks ride on **new modifier classes** so intent is untouched structurally:
`.wrap--desk` (narrow column), `.ticket--swap` + `.field--card(-top/-bottom)` + `.field--details`
(split-card form), `.section-fab` + `.sheet*` (trigger + modal).

## Changes by file

- `public/styles.css` — wholesale rewrite, same 7-section skeleton, every selector preserved
  (inventory-checked). `color-scheme: light`. `.starfield` keeps its selector, loses its dots.
  `.tabs` restyled as a light segmented pill (intent-only surface now). `#toast` inverts to a dark
  ink pill and moves to `bottom: 96px` (clears the fab). New sections: `.ticket--swap` split-card
  + notch, `.section-fab`, `.sheet`.
- `src/ui/SectionSheet.tsx` — new. Floating trigger (`aria-haspopup="dialog"`, `aria-expanded`) +
  centered `role="dialog" aria-modal="true"` sheet. Escape / backdrop click close; focus moves to
  the active option on open and returns to the trigger on close; minimal Tab cycle; body scroll
  locked while open.
- `src/App.tsx` — drop `tabBtn` + `.tabs`; render `<SectionSheet>` inside `#app` (hides with the
  gate); `<main className="wrap wrap--desk">`; logo SVG → `currentColor`.
- `src/ui/Gate.tsx`, `src/intent/App.tsx` — logo SVG → `currentColor` (color-only).
- `src/ui/Ticket.tsx` — `ticket ticket--swap`; the two legs become `field--card-top/-bottom`;
  `<select>` moves before `<input>` inside `.leg` (chip left, amount right — visual order = tab
  order); counterparty/expiry/maker wrapped in `.field--details`; submit button gains
  presentational `.btn__orb` / `.btn__chevs` spans. Ids, validation order, copy unchanged. No new
  data is invented — the reference's fee/rate rows map to the existing hints.
- `otc.html` + `intent.html` — `theme-color` → `#E7E9F2`; fonts → Inter 400–800 + IBM Plex Mono
  400–600 (Space Grotesk / Hanken Grotesk dropped). No CSP change (Google Fonts already allowed).
- `public/intent.css` — value-only recolor of the gold/red/white-wash literals (badges, round
  chips, counter-form border, toggle-on state, direction picker, broadcast chips/banner, balance
  chips, panel wash).
- `public/favicon.svg` — deliberately untouched (shared with the landing); optional follow-up.

## Out of scope

Landing (`hero.*`), `src/core/*`, data layer, contract, intent layout, favicon.

## Verification

1. `npm run dev` visual pass (1440px + 375px): gate, all three sections via the sheet; Escape,
   backdrop click, focus return, scroll lock; notch in Chrome **and** Safari; reduced-motion.
2. Draft survives section switches (panels stay mounted).
3. `npm test` (89 tests) green; `npm run build` clean; `dist/*.html` has zero inline scripts;
   `grep -r esm.sh dist/` empty; `node tools/dev-smoke.mjs` passes.
4. **WCAG AA measured on rendered pixels** (headless Chrome screenshots, backdrop sampling —
   CSSOM walking is not sufficient per CLAUDE.md). Risky tiers: `--text-4` on white and on
   `--bg-grad-b`; green/red chips; white-on-ink surfaces; toast.
5. Intent smoke: theme coherent, layout unchanged (before/after screenshots).
6. `git diff --stat` shows no `public/hero.*` changes. CLAUDE.md status updated. Commit only on
   request.
