# Brand — Katon Base Desk

**One-line description:** Seller-first flow for exchanging tokenized stock for
native Base USDC.

**Category:** DeFi  
**Mood:** Technical · premium  
**Reference:** Coinbase — use as a reference for clear wallet and network state,
not as a source for logos, product copy, or visual assets.

## Palette: Vault Blue

Restrained blue surfaces give the desk a technical, premium feel without
obscuring transaction state. The Vite app maps these semantic colors through
CSS variables in `apps/base-web/src/styles.css`.

| Seed | Dark | Light |
|---|---|---|
| Background | `#0B1220` | `#F4F7FA` |
| Elevated surface | `#141E30` | `#FFFFFF` |
| Primary | `#5B8BB8` | `#38698E` |
| Primary soft | `#91B3D0` | `#E0EDF5` |
| Foreground | `#EFF1F5` | `#1A2735` |

### Semantic tokens

| Token | Light | Dark |
|---|---|---|
| background / foreground | `#F4F7FA` / `#1A2735` | `#0B1220` / `#EFF1F5` |
| card / card-foreground | `#FFFFFF` / `#1A2735` | `#141E30` / `#EFF1F5` |
| popover / popover-foreground | `#FFFFFF` / `#1A2735` | `#18243A` / `#EFF1F5` |
| primary / primary-foreground | `#38698E` / `#FFFFFF` | `#5B8BB8` / `#08111C` |
| secondary / secondary-foreground | `#EBF0F5` / `#1A2735` | `#1D2B40` / `#EFF1F5` |
| muted / muted-foreground | `#EDF1F4` / `#526778` | `#182538` / `#AAB6C7` |
| accent / accent-foreground | `#E6EEF5` / `#1A2735` | `#26354B` / `#EFF1F5` |
| destructive / destructive-foreground | `#B03E32` / `#FFFFFF` | `#D95042` / `#FFFFFF` |
| border / input / ring | `#D1DCE5` / `#FFFFFF` / `#38698E` | `#2B394F` / `#141E30` / `#5B8BB8` |

Contrast was checked on the selected palette: light foreground on background
is above 13:1, light primary with white text is above 5:1, and dark primary
with `#08111C` text is above 4.5:1. Recheck after changing any token.

## Typography

- **UI and headings:** Geist
- **Amounts, hashes, and code:** Geist Mono
- **Stack fallback:** Inter/system UI and SFMono/monospace if web fonts are
  unavailable.

The app loads these fonts from Google Fonts with `display=swap`; the separate
Flare application does not load them.

## Gradients

- **Background:** `linear-gradient(145deg, #FFFFFF 2%, #F1F6FA 58%, #E9F1F7 100%)`
- **Accent:** `linear-gradient(110deg, #38698E 0%, #5B8BB8 100%)`

Use the background gradient only for a top-level hero surface. Use the accent
gradient on small brand marks or emphasis, not on status tags or transaction
controls.

## Voice

Use concise, precise language. Name the asset, network, amount, and next wallet
step instead of asking users to infer what a control will do.

Keep evidence separate by source and confidence. Label mock assets as mock,
quotes as unverified when appropriate, and completed transactions with their
network and receipt.

Use a calm tone around transaction states. State why a route is unavailable
and what evidence or action could change that state; do not imply liquidity or
execution that has not been proven.

## Use

- Keep token, amount, network, route, allowance, and status labels readable.
- Use blue for primary actions and confirmed product navigation.
- Reserve amber and red for actual route gaps, warnings, and failures.
- Keep amount and address values tabular and monospaced.
- Do not use the palette to imply that an unverified route is executable.
- Do not copy Coinbase branding, logos, or proprietary assets.
