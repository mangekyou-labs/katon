# Venue research — Coston2 (2026-08-13)

**Decision: stay on mock adapters.** Do not set `FLARE_VENUE_MANIFEST`. Do not invent addresses.

This is a written **negative** result. Official Coston2 Morpho / Kinetic / Clearpool venue addresses + bytecode hashes were **not** found.

## Sources checked

| Protocol | Official source | What exists | Coston2 (chain 114) |
|---|---|---|---|
| Morpho | [docs.morpho.org/developers/contracts/addresses](https://docs.morpho.org/developers/contracts/addresses/) | **Flare mainnet** Morpho `0xF4346F5132e810f80a28487a79c7559d9797E8B0` (explorer is `flare-explorer.flare.network`) | **No Coston2 tab.** Testnet tabs are Base Sepolia and Sepolia only. |
| Kinetic | [Flare news 2023-12-14](https://flare.network/news/kinetic-to-introduce-lending-and-borrowing-to-flare-ecosystem), [kinetic.market](https://kinetic.market/), Medium/litepaper | Announced a Coston2 launch; mainnet product is Flare | **No official Coston2 address list** in protocol docs or a published `deployments/` registry we can cite. Explorer hits are not a registry. |
| Clearpool | [Hex Trust / Clearpool USDX on Flare](https://www.hextrust.com/resources-collection/hex-trusts-usdx-launches-with-clearpool-on-flare-network), [clearpool.finance/lending/tpool](https://clearpool.finance/lending/tpool) | USDX T-Pool / cUSDX is a **Flare mainnet-era** product. Address `0xFE2907DFa8DB6e320cDbF45f0aa888F6135ec4f8` is **not** a verified Coston2 venue. | **No official Coston2 pool manifest.** |

## What we will not do

- Copy Flare **mainnet** Morpho/Clearpool addresses onto chain 114.
- Treat explorer search results as `verifiedReference`.
- Write `fixtures/flare/venues-coston2.json` until a protocol publishes Coston2 addresses we can hash on Coston2 RPC.

## Local path (keep)

- Adapters + `fixtures/flare/venue-conformance-interface-mock.json` (`authoritativeReference: local-interface-mock-only`).
- `node tools/verify-flare-venues.mjs` without a manifest still fails closed (`VENUE_MANIFEST_REQUIRED`).

## If a protocol later publishes Coston2

1. Put official URL + checksum address + `bytecodeHash` in `fixtures/flare/venues-coston2.json`.
2. `FLARE_VENUE_MANIFEST=fixtures/flare/venues-coston2.json node tools/verify-flare-venues.mjs`
3. Empty code, zero address, or hash mismatch = fail.
