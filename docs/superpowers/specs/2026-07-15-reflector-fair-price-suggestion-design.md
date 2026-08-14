# Reflector fair-price suggestion on the compose ticket

**Date:** 2026-07-15
**Branch target:** feature branch off `main`
**Status:** design approved (pending user spec review)

## Goal

On the New offer ticket (`src/ui/Ticket.tsx`), when the maker types an amount, fetch a
**reference "fair price"** for the token pair from the **Reflector** on-chain oracle and offer to
fill the opposite leg at that rate. A subtle, tap-to-fill chip — it must not disturb the ticket's
aesthetic, and must not touch the signature boundary.

## Decisions (locked)

- **Source:** Reflector oracle (Stellar-native, on-chain). No off-chain price API. No new CSP
  origin — the RPC origin is already allow-listed in `connect-src`.
- **UX:** a subtle suggestion chip on the readback line + tap-to-fill. Not auto-fill, not a passive
  label.
- **No deviation badge.** Just the suggestion chip ("Fair ≈ X · fill"). No "% above/below" text.
- **Fill only when the target leg is empty.** The chip never overwrites a value the maker typed.
- **Symmetric:** whichever leg has a value while the other is empty gets a suggestion for the empty
  leg (send→receive and receive→send).

## Feasibility (verified 2026-07-15 against live testnet)

Probed the **External CEXs & DEXs** Reflector oracle on testnet:
`CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63`.

- `decimals()` → **14**
- `base()` → `Other("USD")`
- `assets()` → includes `Other("XLM")` and `Other("USDC")` (plus BTC, ETH, EURC, …).
- `lastprice(Other("XLM"))` → `{ price, timestamp }`, e.g. `0.18596 USD`, fresh (5-min cadence).
- `lastprice(Other("USDC"))` → `≈ 1.00032 USD`.
- **`x_last_price` does NOT exist on this contract** (`WasmVm, MissingValue`). The cross rate must
  be computed client-side: `rate(maker→taker) = price(makerSymbol) / price(takerSymbol)`. Because
  both prices share the same 10^14 scale, the scale cancels and the ratio is unitless.
- **Simulation needs no funded/existing source account** — a synthetic `Account(G…, "0")` source
  simulates fine. So the oracle read is independent of wallet connection state.

## Architecture

Fits the existing layer split: pure math in `src/core/`, the network read in `src/data/`, config
through `src/config.ts`.

### `src/core/oracle.ts` (pure, unit-tested)

- `oracleSymbol(tokenValue: string): string | null` — maps a TOKENS `value` to its Reflector
  symbol. `tokenLabel()` already yields `XLM` / `USDC`, which ARE the Reflector symbols; return
  `null` for anything not in a small supported-symbol allow-list so an unsupported future token
  degrades to "no suggestion" rather than a bad lookup.
- `crossRate(makerPrice: bigint, takerPrice: bigint): number | null` — `makerPrice / takerPrice`
  via a scaled bigint division (`Number((makerPrice * 1_000_000n) / takerPrice) / 1e6`) to stay
  precise and avoid `Number` overflow on large i128 prices. Returns `null` on non-positive inputs.
- `isStale(timestampSec: number, nowMs: number, maxAgeMs = 600_000): boolean` — true when the
  price is older than ~2 update intervals (10 min). Stale → treated as no suggestion.
- `suggestedAmount(baseAmount: number, rate: number): number` — `baseAmount * rate`. Formatting for
  display reuses the ticket's existing number formatting; the value written into the input is
  rounded to ≤ 7 decimals (SAC precision) so it always passes `validAmount`.

`src/core/oracle.test.ts`: symbol mapping (known/unknown), cross-rate math (incl. the USDC≈1 case
and a large-price no-overflow case), staleness boundary, suggested-amount rounding to 7 decimals.

### `src/data/oracle.ts` (the one new network surface)

- `fetchLastPrice(symbol: string): Promise<{ price: bigint; timestamp: number } | null>` —
  builds `oracleContract.call("lastprice", Asset::Other(Symbol))`, runs `simulateTransaction`
  against `RPC_URL`, `scValToNative`s the `Option<PriceData>` result. Returns `null` on
  simulation error, missing price, or any throw. Uses a synthetic source account (no wallet).
- The `Asset` ScVal is `scvVec([scvSymbol("Other"), scvSymbol(symbol)])` (verified in the probe).
- Reads `REFLECTOR_ORACLE_ID`, `RPC_URL`, `PASSPHRASE` from `src/config.ts`. If the oracle id is
  unset/invalid, `fetchLastPrice` short-circuits to `null` (feature silently off).

### `src/data/useFairPrice.ts` (hook)

- Signature: `useFairPrice(makerToken: string, takerToken: string) → { rate: number | null;
  loading: boolean }` where `rate` is **takerToken per 1 makerToken**.
- Fetches **only when the token pair changes** (not on amount keystrokes): both symbols resolved
  via `oracleSymbol`, both `lastprice` reads in parallel, then `crossRate`. A short module-scope
  per-symbol cache (TTL ~60s) avoids refetching when the maker toggles tokens back and forth.
- Guards: if either token has no `oracleSymbol`, or either price is `null`/stale, `rate` is `null`
  (no suggestion). Same-token pair → `null` (unreachable in practice; the send guard covers it).
- Cancellation: ignore a resolved fetch if the token pair changed meanwhile (avoids a stale rate
  landing after a fast toggle).

### Config

- `public/otc-config.js`: add
  `window.REFLECTOR_ORACLE_ID = 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63';`
  with a comment (testnet External CEX/DEX feed; update on a Testnet reset, same as OTC id).
- `src/config.ts`: declare `REFLECTOR_ORACLE_ID?` on `Window`, export
  `REFLECTOR_ORACLE_ID = (w.REFLECTOR_ORACLE_ID || '').trim()`.
- **CSP: no change** (RPC origin already in `connect-src`).

### `src/ui/Ticket.tsx` integration

- Call `useFairPrice(makerToken, takerToken)` → `rate`.
- Derive, purely in the component:
  - if `makerAmount` valid and `takerAmount` empty and `rate` → suggest receive =
    `suggestedAmount(makerAmount, rate)`.
  - else if `takerAmount` valid and `makerAmount` empty and `rate` → suggest send =
    `suggestedAmount(takerAmount, 1/rate)`.
- Render a small chip **inside the relevant leg's existing `.readback` line** (the empty leg's
  line), e.g. `Fair ≈ 18.59 USDC` + a `fill` affordance + a muted `Reflector` marker. It is a
  `<button type="button">` so tapping fills the input via `setTakerAmount` / `setMakerAmount`.
- Visibility: only when a suggestion exists; otherwise render nothing extra (the readback line
  keeps its current idle/live states). No layout jump — the chip occupies the same line the
  readback already reserves.
- The chip stays **visually distinct** from the implied-rate readback so the existing invariant
  ("the readback is a local echo, never a quote") is preserved: the readback still echoes typed
  numbers; the fair chip is explicitly the oracle reference.

### CSS

- One small class family in `public/styles.css` next to `.readback` / `.readback__chip` (that is
  where `.readback` lives). Reuse existing tokens (`--gold*` ink family, existing radii/spacing);
  a ghost/subtle treatment. No new design tokens. Must clear WCAG AA against the light desk
  surface (measured on rendered pixels, per the CLAUDE.md landing/desk rule).

## Security & invariants (unchanged)

- **Signature boundary untouched.** `src/core/canonical.ts` and the golden vectors are not
  modified. The oracle value only pre-fills an input the maker continues to edit; the signature is
  always over the field's value at sign time. The oracle value is never auto-signed.
- `src/core/` stays pure (no window/network/wallet); the network read lives in `src/data/`.
- `useSettlement` is not involved; the "App must never call useSettlement" and the 3-call grep
  invariant are untouched.
- Failure is silent and non-blocking: oracle down / stale / unsupported token → no chip, form
  works exactly as today.

## Testing / verification

1. `npm test` green, including the new `src/core/oracle.test.ts` and all existing suites
   (golden vectors byte-identical — proves the signature path is untouched).
2. `npm run build` clean; `dist/*.html` zero inline scripts; `grep -r esm.sh dist/` empty.
3. Browser smoke: type a send amount → chip shows a plausible XLM/USDC rate → tap fills the
   receive leg with a ≤7-decimal amount that passes validation and can be signed. Toggle tokens →
   rate updates. Disconnect RPC / unset oracle id → chip silently absent, form still works.
4. Zero CSP violations in the console (no new origin was added).
5. WCAG AA on the new chip against rendered desk pixels.

## Out of scope (YAGNI)

- No deviation/% badge, no auto-fill, no mainnet feed, no caching to DB, no oracle for tokens
  outside the allow-list, no `x_last_price` (absent on this contract).
