# Katon Base Desk — grant evidence brief

**Decision: no-go for a live pilot or grant request at this stage.** The public
demo and controlled Base Sepolia lifecycle are useful product evidence, but no
credible executable route has been established for canonical AAPLc to native
USDC. Revisit this decision when a provider authorizes AAPLc for execution or a
maker commits inventory, size, and settlement terms for a real holder.

## Completed proof

- A separate Base evaluation preview is being prepared for guided, read-only
  product review. It will clearly label simulated and canonical assets.
- The controlled Base Sepolia QA lifecycle used an 8-decimal mock AAPLc and
  native USDC. It purchased `1.00000000` stock for `0.900000` USDC and settled
  for `1.000000` USDC, recording `0.100000` USDC realized profit. This was
  operator-controlled QA, not Coinbase/AP redemption or a live user pilot.
- [Mock stock purchase receipt](https://sepolia.basescan.org/tx/0x65fd21250094adfc2798b4afa3e138a8d0804587201a6db456e98b1ba55e1dcc)
  and [settlement receipt](https://sepolia.basescan.org/tx/0x73670be1969b23caa0d51728137386012dcdeeb3a1a307ffd230cd177a67e4cc).
- The canonical B20 registry validates 13 assets at Base block `51,068,301`
  (`0x81ceda4cb39bf70b057c08dc2d70b201b5190ecb8ebb79ccdca3e12b1d73ea41`);
  canonical stock decimals are 8. The pinned fork suite passed 8 cases.
  [Pinned Base block](https://basescan.org/block/51068301).

## Live route check

- 0x previously returned HTTP 422 with `SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`
  for AAPLc and no route. A fresh request using a placeholder taker returned
  `INPUT_INVALID`; that response does not establish eligibility for an actual
  holder.
- CoW returned an HTTP 200 quote, but the provider marked it unverified. The
  integration classifies this as a signed intent only; no order was signed or
  submitted, so it is not executable liquidity.
- 1inch has no configured API key, and no committed internal maker is
  configured. Available executable size is therefore **none established**.
- No provider onboarding or holder execution path has been verified.

## Proposed pilot (not completed)

If a credible route becomes available, the next pilot should confirm provider
eligibility and onboarding, quote and execute with a consenting AAPLc holder,
record the executable size and settlement, and publish receipts and failure
states. This remains proposed work and is not included in the evidence above.

## Evidence that changes the decision

Proceed only after one of these is documented: (1) 0x authorizes canonical
AAPLc and an actual holder can execute a tested route; (2) 1inch is onboarded
and returns a verified executable route for a stated size; or (3) an internal
maker commits inventory, capacity, price/expiry, and settlement terms, with an
end-to-end holder transaction. Until then, stop expanding the product beyond
the read-only evaluation demo and evidence upkeep.
