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

## Receipt discrepancy in the human-reviewed screenshot

The receipt correctly shows the stock debit, Maker inventory, Maker stablecoin
debit, Seller stablecoin credit, slot, quote, FillReceipt, and transaction
signature. It shows **0.1008 USDC · 0 bps** for the fee, but the landed
instruction and RPC balances show **0.10008 USDC · 10 bps**. The receipt fee
amount and fee rate therefore do not match independent RPC evidence.

The reviewer chose ACCEPT with the discrepancy recorded. That screenshot did
not pass the receipt-match check. The fee display was corrected afterward and
the fresh 0.1 walkthrough below confirms that the current Review and receipt
show the single 10 bps fee. All assets and balances above are offline local
test assets with no issuer backing.

## Corrected 0.1 technical follow-up — no new human decision

On 2026-09-25, the automated Wallet Standard browser journey was repeated with
0.1 AAPLx TEST after correcting the local quote's fee breakdown. It showed
`0.010008 USDC · 10 bps` and `9.997992 USDC` net in both pre-sign Review and
the confirmed receipt. RPC confirmed signature
`3wEdfZomdhtUuQsU69ScYhhEmJZQSFFrBymh6vv6ZQAojszyXZ6XdDYEsMCiadexY5NbeGX4HKjRz23qcnhT3ugx`
at slot `798`, with `10008` fee atomic units and `9997992` Seller USDC atomic
units. The full new evidence is linked from the [settlement testing note](2026-09-25-feature-solana-seller-settlement.md):
[pre-sign Review screenshot](evidence/2026-09-25-seller-review-0.1.png) and
[confirmed receipt screenshot](evidence/2026-09-25-seller-receipt-0.1.png).

This follow-up establishes the corrected technical behavior. It does not
claim that the human reviewer separately inspected or approved these new
screenshots; the existing ACCEPT remains the decision recorded on issue #23.

## Evidence limitations

The original screenshot supplied in chat is not embedded in this text artifact.
It showed the completed receipt but not the frozen pre-sign Review panel. The
corrected automated follow-up has both Review and receipt screenshots in the
repository. RPC evidence independently confirms its landed transaction and
token deltas; those new screenshots have not received a separate human review.

## Posted issue updates

- [Issue #23 acceptance comment](https://github.com/mangekyou-labs/katon/issues/23#issuecomment-5829403973)
- [Issue #9 evidence comment](https://github.com/mangekyou-labs/katon/issues/9#issuecomment-5829405455)
- Issue #23 was closed with the completed acceptance outcome.
