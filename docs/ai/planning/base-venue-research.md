# Base venue research — 2026-09-09

**Decision: pin protocol-level contracts only.** First-wave v1 lending markets remain an empty array until an official market-level deployment is documented and pinned.

## Sources checked

| Protocol | Official source | What exists | Base result |
|---|---|---|---|
| Aave | [AaveV3Base.sol](https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol) | Aave V3 Base core contracts and the native-USDC aToken deployment | Mainnet pool, provider, and native-USDC aToken pinned. Sepolia pool and provider pinned; the listed testnet USDC reserve is not Circle native USDC and is omitted. |
| Morpho | [Morpho addresses](https://docs.morpho.org/get-started/resources/addresses/) | Blue singleton, AdaptiveCurveIRM, and Chainlink Oracle V2 factory addresses | Mainnet and Sepolia protocol contracts pinned. GraphQL market results for B20 assets are not the static addresses page, so MarketParams, oracles, and LLTV are not pinned. |
| Euler | [EulerChains.json](https://github.com/euler-xyz/euler-interfaces/blob/master/EulerChains.json) | Base production EVC, eVault factory, and implementation | Mainnet protocol contracts pinned. There is no chain 84532 deployment in the official chain table; no Sepolia pin is added. App vault metadata has no official B20 first-wave market. |
| Aerodrome | [contracts README](https://github.com/aerodrome-finance/contracts/blob/main/README.md) | Router and pool factory | Mainnet router and pool factory pinned. The source does not publish an official per-B20 pool table, so no pair pool is invented; Aerodrome remains a read-only quote floor. |

## First-wave result

The 13 official Coinbase B20 stocks remain address-keyed in `packages/base-core/src/assets.ts` and have Chainlink feeds. The intersection with at least one pinned v1 lending market is empty, so `packages/base-core/src/venues.ts` exports `firstWaveMarkets = []`. This is an explicit machine-checked product state, not a market omission hidden behind ticker-only lookup.

## What we will not do

- Treat GraphQL market listings as the static Morpho address source.
- Pin Morpho MarketParams, market oracles, or LLTV from GraphQL alone.
- Treat `wtCOIN`, `wtMSTR`, or `wtSPYM` as official B20 assets.
- Pin Euler or Aerodrome contracts on Sepolia without an official deployment source.
- Pin the non-native Aave Sepolia USDC reserve as Circle native USDC.
- Add any USDbC reserve, aToken, market, vault, or pair.
- Invent per-B20 Aerodrome pools or market-level addresses.

## Local path

- `fixtures/base/venues-mainnet.json` contains the 11 required protocol-level mainnet pins.
- `fixtures/base/venues-sepolia.json` contains the five official Sepolia pins.
- `BASE_FORK_RPC` is saved only in the ignored worktree `.env` for the later T3.4 fork harness.
- Live `eth_getCode` equality is not T3.3 evidence and remains pending for T3.4.
