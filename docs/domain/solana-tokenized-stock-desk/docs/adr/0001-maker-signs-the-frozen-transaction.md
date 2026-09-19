# Maker signs the frozen transaction

A Private Maker partially signs the exact frozen v0 transaction before seller review, and the seller signs the same message afterward. This avoids standing token delegations and inventory vaults while making both asset transfers rely on ordinary Solana transaction authorization; an expired quote or blockhash requires a new quote and new signatures.
