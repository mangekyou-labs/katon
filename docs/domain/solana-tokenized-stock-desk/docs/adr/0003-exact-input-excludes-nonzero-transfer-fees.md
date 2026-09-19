# Exact input excludes nonzero transfer fees

V1 rejects stock transfers with a nonzero Token-2022 transfer fee because the seller debit and Private Maker receipt must be the same atomic amount. A zero-fee configuration is accepted only when settlement binds the expected fee to zero with `transfer_checked_with_fee`; grossing up the seller debit or silently reducing maker receipt would violate Exact Input.
