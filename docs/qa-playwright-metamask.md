# Playwright CLI + MetaMask QA (Flare)

This repository contains a disposable QA harness for the Flare dApp. The ongoing browser workflow is `playwright-cli`; dAppwright is used once to initialize MetaMask and save a reusable Chromium profile. Do not use Playwright MCP (`@playwright/mcp` / `playwright__*` tools).

This layer is **extension-backed**. It complements injected-provider smokes (`npm run test:e2e:flare`, `test:e2e:flare:extension`) and must not be reported as Flare mainnet or production-custody evidence.

## Setup

Prerequisites:

- Node.js 22+ and `npx`. `@tenkeylabs/dappwright` requires Node 22 even if the app `engines` field remains `>=20.19`. Keep `@playwright/test` as a direct dependency; dAppwright imports it and will fail at load if it is only a transitive peer.
- A Flare-compatible EVM RPC (default: Coston2).
- A disposable BIP-39 seed phrase and password. Never use a funded or production wallet.
- The dApp running at `DAPP_URL` (`npm run dev:flare` for the Flare web app). Vite 8 default-listens on `[::1]:5173` only. If `DAPP_URL` is `http://127.0.0.1:5173`, start with `npm run dev:flare -- --host 127.0.0.1 --port 5173` or `qa:wallet:setup` fails with `net::ERR_CONNECTION_REFUSED`.

Copy `.env.example` to `.env` and set `METAMASK_PASSWORD` and `METAMASK_SEED_PHRASE`. Adjust the RPC, chain, network, symbol, and dApp URL if needed. `.env` is ignored by git.

Install dependencies and validate secrets before launching a browser:

```bash
npm install
npm run qa:browser:install
npm run qa:cli:install-browser
npm run qa:wallet:validate
```

Initialize a fresh MetaMask profile:

```bash
npm run qa:wallet:setup
```

The setup downloads MetaMask through dAppwright, imports the disposable wallet, derives accounts 0–2 as seller, LP-A, and LP-B, preflights their C2FLR balances, adds/selects the configured Flare network, checks `window.ethereum` and the expected chain ID at `DAPP_URL`, then persists the profile under `.playwright/metamask-local/`. It also records the stable Chromium executable used by dAppwright in `.playwright/cli.config.json`; this avoids loading the wallet with the CLI package’s different prerelease browser revision. The public account/balance preflight is written to ignored `.playwright/qa-accounts.json`; mnemonics and private keys are never written or printed. The extension files are kept under `.playwright/metamask-extension/`; both state paths are ignored.

Coston2 is chain ID `114` (`0x72`), native `C2FLR`, RPC `https://coston2-api.flare.network/ext/C/rpc`. Test C2FLR is available from https://faucet.flare.network/coston2. Mainnet is chain ID `14` (`0xe`, `FLR`) and is a separate approval-gated lane.

The injected-provider CLI flow remains the fast simulated smoke (`npm run
test:e2e:flare:cli`). The Coston2 FCC lane must set `FLARE_FCC_MODE=real`, provide
one dedicated instruction sender, extension ID, and exactly three HTTPS proxy
`/info` URLs, then use explicit account checkpoints: seller CREATE, LP-A BID,
LP-B BID, and seller FINALIZE/result relay. It is intentionally fail-closed
until the support-provided ext-proxy indexer credentials, registered simulated
machines, and operator-approved deployment manifest are present; simulated
results must not be reported as production confidentiality or attestation
evidence.

## CLI workflow

From the repository root, use the local CLI through the npm script:

```bash
npm run qa:cli -- --config .playwright/cli.config.json open "$DAPP_URL" --headed
npm run qa:cli -- snapshot
npm run qa:cli -- screenshot
npm run qa:cli -- close
```

If `playwright-cli` is installed globally, the equivalent direct commands are:

```bash
playwright-cli --config .playwright/cli.config.json open "$DAPP_URL" --headed
playwright-cli snapshot
playwright-cli screenshot
playwright-cli close
```

Chromium profiles lock MetaMask again when the browser restarts. After opening a new CLI session, use `tab-list`, select the MetaMask tab, snapshot it, and fill/click its current `Password` and `Unlock` controls. Then select the dApp tab and continue QA. The element refs are intentionally omitted here because they must come from the latest snapshot.

The config uses a persistent Chromium context and loads the MetaMask extension. Separate named sessions are isolated; use a different profile for a truly separate wallet:

```bash
playwright-cli -s=isolated open "$DAPP_URL" --profile=.playwright/metamask-isolated --headed
playwright-cli -s=isolated snapshot
playwright-cli -s=isolated close
```

For connect-wallet QA, start the dApp with the CLI, snapshot it, activate its connect button, then snapshot again and approve the MetaMask popup. Re-snapshot after navigation or modal changes because element refs are not stable across snapshots.

Screenshots and CLI logs belong in `output/playwright/`, which is ignored.

## Cleanup

Close the CLI session, then remove only the disposable wallet profile and extension:

```bash
npm run qa:cli -- close
npm run qa:wallet:cleanup
```

The cleanup script has fixed targets under `.playwright/` and does not touch source files, `.env`, or unrelated browser profiles. Run setup again only after cleanup.
