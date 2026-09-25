# Seller Desk human review — 2026-09-25

## Decision

Human UX decision: **ACCEPT**, as provided by the reviewer after the Backpack
walkthrough. This review covers only offline `solana:localnet` test assets. It
does not approve Devnet, Mainnet, or production release gates.

## Walkthrough result

The reviewer supplied a screenshot of the completed Seller settlement receipt.
The screenshot shows AAPLx TEST stock exchanged for local test USDC and a
confirmed localnet result. The landed transaction has the fixture Seller and
Maker as signers. No private key is included in this evidence.

The walkthrough amount was **1 AAPLx TEST**, while the requested plan amount
was **0.1 AAPLx TEST**.

## Independent Surfpool RPC evidence

- Cluster: `solana:localnet` on offline Surfpool (`127.0.0.1:8899`)
- Transaction: `3VHtt1cWu6oV3TF3UtYmPic8y6QZEjiaHvuYSqcgmcKxREF7VDRBDwSkkLxCq9qVKTGYphGtUfMn2cDXDh1V9Ls2`
- Slot/status: `107351`, finalized, `meta.err: null`
- Instruction: RFQ program `J32rnah2cKSL1nrMw3HQS8A8Lx17JvjY6WNn5qQSyGib`,
  `settle_private_quote`
- Quote ID: `0a5fdb4fbdd9c0b3b0394fe08edd518854457e6a180f3ee2dd30535d4b58c803`
- FillReceipt: `5RjY48hszWppEPTUHmxVJfAHNj3F1Be5etCEgyD3b8rc`, owned by the RFQ
  program and matching the quote, Seller, Maker, gross amount, and fee
- Encoded settlement: 1.0 stock; gross stablecoin 100.08; net Seller minimum
  99.97992; governed fee 10 bps / 0.10008

RPC transaction pre/post token balances:

| Account | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Seller AAPLx TEST | 2.5 | 1.5 | -1.0 |
| Maker AAPLx TEST | 0 | 1.0 | +1.0 |
| Maker test USDC | 1,000,000 | 999,899.92 | -100.08 |
| Seller test USDC | 0 | 99.97992 | +99.97992 |
| Fee account test USDC | 0 | 0.10008 | +0.10008 |

## Receipt differences visible in the screenshot

The receipt correctly shows the stock debit, Maker inventory, Maker stablecoin
debit, Seller stablecoin credit, slot, quote, FillReceipt, and transaction
signature. It shows **0.1008 USDC · 0 bps** for the fee, but the landed
instruction and RPC balances show **0.10008 USDC · 10 bps**. The receipt fee
amount and fee rate therefore do not match independent RPC evidence.

The reviewer chose ACCEPT with these differences recorded. They remain visible
UX discrepancies and are not represented here as passing the receipt-match
check. All assets and balances above are offline local test assets with no
issuer backing.

## Evidence limitations

The screenshot supplied in chat is not embedded in this text artifact. It
shows the completed receipt; it does not show the frozen pre-sign Review panel.
RPC evidence independently confirms the landed transaction and token deltas.

## Posted issue updates

- [Issue #23 acceptance comment](https://github.com/mangekyou-labs/katon/issues/23#issuecomment-5829403973)
- [Issue #9 evidence comment](https://github.com/mangekyou-labs/katon/issues/9#issuecomment-5829405455)
- Issue #23 was closed with the completed acceptance outcome.
