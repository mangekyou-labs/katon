# Pyth Live Reference Integration

The Seller Desk API requests the Pyth Pro symbol `Equity.US.AAPL/USD` on the server. It converts the returned price mantissa and exponent to six decimal USD atomic units, and converts `feedUpdateTimestamp` from microseconds to milliseconds. The API displays the Pyth price, observation time, and market session in the Seller Desk and frozen review.

## Quote gate

Quotes require a Pyth observation and a separately sourced AAPL/USD cross-check. Both observations must be from the regular market session, no older than 15 seconds, and agree within 50 basis points. Pending corporate actions, an unavailable source, or a failed refresh blocks quote eligibility and review. The API does not reuse a cached sample after the current refresh fails.

Pyth and cross-check credentials are server-only. Configure `PYTH_PRO_API_KEY` and optionally `PYTH_PRO_CHANNEL`. The cross-check is a server-side adapter configured with `KATON_REFERENCE_CROSSCHECK_URL` and `KATON_REFERENCE_CROSSCHECK_PROVIDER`. Its JSON response must contain `symbol: "AAPL/USD"`, a positive `priceAtomic` decimal string at six USD decimals, a current Unix millisecond `observedAtMs`, `marketSession`, and `corporateActionPending`. The adapter URL must use HTTPS except for localhost development, and the configured provider name must not identify Pyth. This connection contract does not establish that a provider is licensed or independent; that evidence remains a production release gate.

## Evidence status and limits

This workspace has no Pyth Pro API key or independent cross-check configuration, and live network access was unavailable during implementation. No live Pyth observation has been received or validated here. Without both configured sources, the API reports the reference policy as unavailable and blocks quote eligibility. Offline unit tests cover parsing, timestamp conversion, stale and closed sessions, source failures, quote rejection, and transaction-byte removal when a feed becomes stale before review.

The current Seller Desk remains explicitly **localnet-only** and uses synthetic test stock and local test stablecoins. The reference feed does not make those assets issuer-backed, and it does not authorize Devnet or Mainnet execution. Mainnet still requires the independent licensed reference providers, production xStocks registry, operational controls, and Squads release evidence described by the production gates.

The Pyth Pro request uses an off-chain response format; the adapter does not verify an on-chain Pyth update or a cryptographic price attestation. Do not treat this demo path as sufficient for production settlement.

## Pyth API references

- [Pyth Pro REST API](https://docs.pyth.network/price-feeds/pro/api/rest)
- [Pyth Pro payload reference](https://docs.pyth.network/price-feeds/pro/payload-reference)
- [Pyth Pro symbology reference](https://docs.pyth.network/price-feeds/pro/symbology-reference)
