# Reference policy never falls back to a DEX price

Quote eligibility uses a licensed equities market-data authority for price, session state, calendar, and corporate actions, with an independent source used only as a fail-closed cross-check. A stale or conflicting source halts quoting because substituting a Solana DEX price would turn the safety bound into a value derived from the venue being evaluated.
