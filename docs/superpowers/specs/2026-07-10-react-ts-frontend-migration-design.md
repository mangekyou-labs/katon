# TrustRFQ frontend migration — vanilla → React + TypeScript

**Date:** 2026-07-10
**Status:** implemented (same day) — full port + verification battery green; adversarial
multi-agent review run post-implementation. Remaining gate to go-live: the two-wallet E2E.
**Branch:** `frontend/react-ts-migration`

## Context

The live TrustRFQ desk is a no-build static site: `otc.html` (markup), `otc.js` (692 lines, one ES
module), `hero.html` + `hero.js` (landing), `styles.css` (shared design system). Browser deps are
ES-module imports from esm.sh. It works, and on-chain settlement is deployed.

Two roadmap features — an **intent/private-offer layer** and an **institutional RFQ protocol** —
are too complex to grow inside a single 692-line module that renders through `innerHTML` string
templates and wires events by hand. CLAUDE.md records the decision (2026-07-10) to rebuild on
React + TypeScript and deferred the framework choice to this design session.

The intended outcome is a like-for-like port: identical features, identical look, identical flows,
on a stack that can host the roadmap. No new capability lands with the migration.

## The hazard this design is built around

`fillCanonicalArgs` (`otc.js:424-437`) derives the eight `ScVal` arguments that **both parties'
Soroban auth entries are signed over**. Per STELLAR.md invariant #2 it must be deterministic. It
depends on `globalThis.Buffer`, assigned from esm.sh's `buffer@6` at `otc.js:12-13`, and on
`toStroops` / `sacIdFor` / `sha256Bytes`.

A bundler substituting a different `Buffer` shim, or any reordering of the args, produces terms
that simulate cleanly for the submitter but do not match what the counterparty signed. The failure
is silent until a real `fill` reverts on-chain. This is the one thing a migration can wreck without
an error message.

## Decisions

### Stack: Vite + React + TypeScript, static output

Decided by looking at AirSwap's actual engineering, since TrustRFQ is modeled on their peer
protocol:

| Finding | Source | Consequence |
|---|---|---|
| Their app is a client-only SPA; the entire prod server is `express.static('./build')` | [airswap-web/index.js](https://github.com/airswap/airswap-web/blob/develop/index.js) | No SSR/SSG is needed to run this protocol |
| The RFQ quote server is a **separate repo** | [airswap-ref-server](https://github.com/airswap/airswap-ref-server) | Peer-to-server RFQ does not justify Next.js API routes |
| Explanatory/marketing content is a **separate repo** | [airswap-about](https://github.com/airswap/airswap-about) | Keep the landing out of the app build |
| Signature canonicalization lives in a published, unit-tested package, not the app | [`tools/utils/src/swap-erc20.ts`](https://github.com/airswap/airswap-protocols/blob/main/tools/utils/src/swap-erc20.ts) | Defend `fillCanonicalArgs` with a module boundary + tests |
| They ship **no CSP and no security headers** | `airswap-web` root has no `vercel.json`/`netlify.toml` | Their stack choice offers no guidance on our CSP; we are ahead of them |

Not copied: their build is CRA + Craco, React 17, TypeScript 4.4, Node 18 — CRA was formally sunset
by the React team. Their `craco.config.js` carries browserify fallbacks and no `ProvidePlugin` for
Buffer, so they would hit our exact Buffer trap.

**Next.js is rejected.** Its App Router static export emits inline hydration scripts
(`self.__next_f.push(...)`), forcing `'unsafe-inline'` into `script-src` — the directive that
STELLAR.md §11 identifies as the control against transaction tampering, the marquee threat for a
wallet-signing dApp. Nonces would fix it but require middleware, i.e. a server runtime that this
app has never had and that the reference implementation of this protocol has never needed.

Vite emits no inline script once `build.modulePreload.polyfill = false`, so it drops into the
existing CSP unchanged.

### Scope: desk only

`otc.html` + `otc.js` become the React app. `hero.html`, `hero.js`, and `styles.css` stay
hand-written, mirroring AirSwap's separation. Accepted cost: the topbar/brand markup stays
duplicated between the built app and the static landing, and `styles.css` is consumed by both.

### Baseline: golden vectors, no E2E

Vectors are captured from the live vanilla stack and become the port's regression tripwire. The
pending two-wallet browser E2E is **not** run first. Accepted risk below.

## Architecture

```
otc.html                  Vite entry, repo root
vite.config.ts  tsconfig.json  package.json
public/                   copied verbatim, never bundled
  hero.html  hero.js  styles.css  favicon.svg
  supabase-config.js  otc-config.js
src/
  core/     canonical.ts  canonical.test.ts  fill.ts  tokens.ts  types.ts
  data/     supabase.ts  useOrders.ts
  wallet/   kit.ts  WalletContext.tsx
  ui/       Gate.tsx  Ticket.tsx  OrderCard.tsx  SettlementStrip.tsx  Toast.tsx
  App.tsx   main.tsx
fixtures/   canonical-args.json
```

Vercel builds to `dist/`, which holds the untouched landing beside the compiled desk. `cleanUrls`
and the `/` → `/hero` rewrite keep working unchanged.

### `src/core/` — the boundary

Everything the signatures depend on, and nothing else. Pure functions, no network, no wallet, no
React. `canonical.ts` holds `assetFor`, `sacIdFor`, `toStroops`, `sha256Bytes`, `fillCanonicalArgs`,
`canonicalPayload`. `fill.ts` holds `signOrderAuth` / `fillOrder` with the signer injected rather
than reaching for the wallet kit directly. `tokens.ts` holds the allow-list and `isKnownToken` —
business logic that survives the move, unlike `esc()`, which JSX makes redundant.

`canonical.ts` imports `Buffer` explicitly (`import { Buffer } from 'buffer'`) instead of relying on
the ambient global. Vite resolves that to the same npm `buffer` package esm.sh serves today, and it
resolves identically under Vitest in Node — so the golden-vector test actually tests the bytes the
browser will produce.

### Golden vectors

`canonical.test.ts` runs a hand-written fixed order through `fillCanonicalArgs` and asserts the
eight `ScVal`s serialize to the base64 XDR recorded in `fixtures/canonical-args.json`, plus that
`canonicalPayload` reproduces its recorded string. A Buffer or BigInt substitution fails a unit test
instead of a real fill.

This mirrors AirSwap's Mocha suite over `@airswap/utils`, and the `test_snapshots/` tripwire
STELLAR.md §10 already recommends for the contract.

### CSP after the migration

Bundling removes the runtime CDN, so `esm.sh` leaves both directives:

```
script-src  'self' 'wasm-unsafe-eval'
connect-src 'self' https://soroban-testnet.stellar.org
                   https://horizon-testnet.stellar.org
                   https://zaflldqvenbgfaxtzbjc.supabase.co
                   wss://zaflldqvenbgfaxtzbjc.supabase.co
```

`'unsafe-inline'` never appears. The `?bundle-deps` gotcha in CLAUDE.md disappears permanently — it
was an esm.sh artifact.

## Deliberate non-changes

- **`styles.css` is not rewritten.** It stays a plain asset in `public/`, linked from `otc.html`,
  serving both pages. No CSS Modules, no styled-components, no Tailwind. Rewriting 1265 lines of a
  just-shipped design system is not a like-for-like port.
- **Runtime config stays un-bundled.** `otc-config.js` and `supabase-config.js` remain `window.*`
  scripts in `public/`, typed via a `declare global` block. A Testnet reset therefore stays a
  one-file edit, not a rebuild-and-redeploy — preserving the workflow CLAUDE.md and README document.
- **No Redux.** State is `address`, `incoming[]`, `sent[]` (`otc.js:33-38`). A wallet context plus a
  `useOrders` hook covers it. The `txBusy` mutex (`otc.js:386`) becomes a `useRef`. AirSwap runs RTK
  across token lists, balances, NFTs, limit orders and multiple protocols; we have three fields.
- **No router.** Three tabs and a wallet gate, driven by `useState`, as today.
- **Pinned deps carry over exactly:** `@creit.tech/stellar-wallets-kit@1.9.5`,
  `@stellar/stellar-sdk@16`, `@supabase/supabase-js@2`, `buffer@6`.

## Sequence

1. **Extract `canonical.js` in vanilla.** Move the pure functions out of `otc.js`; `otc.js` imports
   them. No behavior change. Required because `otc.js` is an ES module, so `fillCanonicalArgs` never
   reaches `window` and cannot otherwise be captured.
2. **Capture vectors.** `tools/capture.html` imports `canonical.js` from the same esm.sh URLs the
   live app uses, runs a fixed order through it, prints base64 XDR. Commit `fixtures/`.
3. **Scaffold Vite** alongside the existing files.
4. **Port `src/core/` first**, turn the vectors into a passing Vitest run.
5. **Port `data/`, `wallet/`, `ui/`.**
6. **Switch `vercel.json`** to the build command and the tightened CSP, last.

## Verification

- `npx vitest run` — `canonical.test.ts` reproduces `fixtures/canonical-args.json` byte-for-byte.
- `npm run build && npx serve dist` — desk loads at `/otc.html`, landing at `/hero.html`.
- Browser console shows **zero CSP violations** on both pages (CLAUDE.md requires this after any
  change touching the allow-list).
- `grep -r "esm.sh" dist/` returns nothing.
- Manual: connect wallet, create an order, accept it from a second wallet, both sign. The stepper
  reaches "Settled".
- `cargo test --manifest-path contracts/otc_swap/Cargo.toml` still green (untouched, but the args
  the contract sees must not have moved).

## Post-implementation review (adversarial, multi-agent)

A 7-lens review (settlement parity, RFQ/data parity, React correctness, security/CSP, markup/CSS
parity, build/deploy, completeness), each finding judged by 3 perspective-diverse verifiers.
Confirmed findings, both fixed:

1. **False-failed settlement on a successful fill (confirmed 3/3, found independently by two
   lenses).** The port routed the success-path `settled` write through `updateOrder`, which throws
   on DB errors — vanilla ignored errors on that exact write. A transient Supabase failure *after*
   an on-chain-confirmed fill fell into the concurrent-submitter recovery, marked the executed
   trade `failed`, lost the tx hash, and every retry reverted with `AlreadyFilled`. **Fix:** in
   `useSettlement.settle()`, the confirmed fill is the point of no return — the bookkeeping write
   is attempted once and swallowed on failure (row stays `settling`; on-chain state is the truth),
   and success is always toasted.
2. **RFQ draft destroyed on disconnect.** The port unmounted the desk behind the gate; vanilla
   toggled `display`. **Fix:** Gate and desk are both always mounted, visibility-toggled — drafts
   and the active tab now survive disconnect/reconnect (this also removes the earlier
   "tab resets to create" deviation).

### Second adversarial pass (post-fix closeout)

After both fixes landed, a fresh 6-lens review (settlement parity, RFQ/data parity, React
correctness, security/CSP, build/deploy, completeness) was run over the corrected code, each raw
finding gated by three perspective-diverse verifiers — one dedicated to checking whether the
flagged behavior is *identical to vanilla* and therefore not a port regression. The lenses read
8–31 files apiece and ran the build/tests directly. Result: **zero raw findings, zero survivors**
— no lens surfaced a defensible defect. The two fixes above are the complete confirmed-findings
set for this migration.

Final verification battery re-run green: Vitest 34/34 (golden vectors byte-identical + token
suites), contract `cargo test` 6/6, `npm run build` clean, `dist/` has zero inline script bodies
and no `esm.sh`, all `public/` statics copied, and the live `.mcp.json` Supabase token is absent
from both git and `dist/` (the public anon key ships only in the verbatim `dist/supabase-config.js`,
as designed).

## Accepted risks

- **`kit.signAuthEntry` remains unproven end-to-end.** The two-wallet browser E2E has never been
  run, so if a `fill` reverts after the port, "the port broke it" and "it never worked" stay
  indistinguishable. The golden vectors cover the likelier failure (Buffer/BigInt drift in the
  bundler) but not the wallet's signing behavior. Mitigation: run the E2E before going live, as
  CLAUDE.md already requires.
- **`styles.css` is shared across a build boundary.** The static landing and the compiled desk both
  depend on one hand-maintained file. Acceptable while the landing stays static; revisit if the
  landing is ever ported.
- **Topbar/brand markup stays duplicated** between `hero.html` and the React shell.
