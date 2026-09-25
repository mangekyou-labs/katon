# Katon Base Tokenized Stock Desk — demo walkthrough

Concise, reproducible walkthrough for the Base grant submission. It separates
what is **executed and verified** from what is **blocked on external inputs**, so
no claim mixes canonical fork execution, live provider data, and controlled QA
redemption.

## What this demo is

A seller brings canonical Coinbase B20 tokenized stock (13 assets, **8 decimals**)
and receives native Base USDC. Katon runs a one-second private auction across
internal makers, facilities, and external venues, then returns a
taker-submitted transaction. Facility inventory books automatic redemption lots
and realized P/L. Mainnet stays disabled behind explicit rollout gates.

## Precision model (verified)

| Asset | Decimals | Source |
| --- | --- | --- |
| Canonical B20 tokenized stock (AAPLc, NVDAc, … 13 assets) | 8 | `decimals()` at pinned Base block `51_068_301` |
| Native Base USDC | 6 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

Reproduce:

```sh
cp .env.example .env           # then set BASE_FORK_RPC to a dedicated Base RPC
npm run validate:base:b20
```

Expected:

```
base-b20-canonical=PASS assets=13 block=51068301 hash=0x81ceda…ea41 digest=sha256:7172826…
base-b20-stale-feeds=0 evidence=output/base-qa/evidence/b20-canonical.json
```

The command fails closed on any symbol, decimals, bytecode, or feed drift, and
writes the redacted evidence file listed above.

## Attribution (verified)

Every contract call leaving the browser wallet carries one ERC-8021 Builder Code
suffix, applied at the shared wallet boundary, covering approvals, router
submissions, and facility calls.

```sh
npx vitest run src/base-core.builder-code.test.ts src/base-wallet-attribution.test.ts
```

Set the code in the deployed browser config as `builderCode` or at build time as
`VITE_KATON_BASE_BUILDER_CODE=bc_…`. A missing code disables attribution; a
duplicate or malformed suffix fails closed instead of double counting.

## External venue routing (implemented, live gates open)

```sh
npx vitest run src/base-swap-providers.test.ts
```

- 0x via AllowanceHolder v2; the allowance target must be allowlisted.
- 1inch via Classic Swap 6.1; provider gas priced with
  `KATON_BASE_NATIVE_USDC_PER_ETH`. The executable adapter remains disabled
  unless `KATON_BASE_ENABLE_1INCH_EXECUTION=true`; no 1inch route is claimed.
- CoW as a separate asynchronous signed intent: the exact EIP-712 order is built,
  signed with a controlled QA key, and the signer is recovered locally. It is
  never submitted to mainnet solvers and never appears as executable calldata.

Provider evidence is captured at the canonical Base pin (`51068301`, hash
`0x81ceda…ea41`). The live 0x AllowanceHolder request returned HTTP 422 with
`SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE` for AAPLc; response hash
`0x80e6afc40804ee2f8143e33b18741f859fd5932eb949f30e28834f69506d92b9`.
There is no 0x route or execution. CoW returned a live quote (HTTP 200, 9 ms,
response hash `0xa9cd1c5c3d9596cdfdb5db5a206f764d05ca74e2e3d930c1c44e9696f9fb7713`).
The local EIP-712 digest and recovered signer matched the owner, but CoW reported
`verified=false`; no order was submitted, and this is not executable liquidity.
1inch remains deferred pending onboarding and a verified AAPLc route.

The seller UI re-quotes on execution, approves the exact 0x allowance, checks
chain, recipient, token pair, amount, quote expiry and pinned decision block,
simulates and submits only the provider packet, and verifies the receipt and
token balance deltas. This flow has not been exercised in a headed browser
against a live provider route because 0x rejected AAPLc.

## Controlled Sepolia QA redemption (verified)

A fresh Base Sepolia candidate uses an 8-decimal mock AAPLc and remains
`productionEligible=false`. The controlled QA lifecycle purchased 100,000,000
stock units for 900,000 native-USDC units, booked the redemption lot, settled
1,000,000 native-USDC units of proceeds, and verified zero remaining facility
stock, exposure, and inventory cost with 100,000 realized profit. This is
**CONTROLLED_QA_REDEMPTION**, not Coinbase/AP redemption. The purchase receipt
is `0x65fd21250094adfc2798b4afa3e138a8d0804587201a6db456e98b1ba55e1dcc`; the
settlement receipt is `0x73670be1969b23caa0d51728137386012dcdeeb3a1a307ffd230cd177a67e4cc`.
Rerun `npm run qa:base:redeem` to verify/resume the lifecycle and refresh the
ignored proof at `output/base-qa/sepolia/redemption-proof.json`.

## Local deterministic gate

```sh
npm run test:base
npm run typecheck:base
npx tsc -p tsconfig.base-api.json --noEmit
npm run build:base-web
FOUNDRY_OFFLINE=true forge test --root contracts/base --offline
node tools/check-base-secrets.mjs
git diff --check
```

## Deliberately not claimed

- A live 0x AAPLc route or execution; the provider explicitly rejected the token.
- Executable CoW liquidity or an order submission; the local quote/signature
  evidence is marked provider-unverified and remains local signed-intent
  evidence only.
- A headed external-route browser execution. The wallet flow is implemented,
  but no live route was available to exercise it.
- `/v1/evidence` has HTTP coverage for both an injected reader and the default
  file reader configured through `KATON_BASE_EVIDENCE_DIR`. The runtime tree
  contains `evidence/provider-gates.json` and
  `sepolia/redemption-proof.json`; deploy it as a mounted/copied artifact
  directory. The endpoint returns a fixed projection and omits raw provider
  bodies, signatures, and other source fields.
- Base mainnet activation. `productionEligible` remains `false`.
