# Coinnibal brand kit

The social and web art of Coinnibal, drawn in the **Ring Storybook** language: confident ink outlines
(`#04181C`), flat cel fills with one shade tone, hard offset shadows (never blurred), cream die-cut
stickers, Fraunces for display, DM Sans for reading and Geist Mono for every number and kicker. The
source of truth is the spec (`docs/specs/2026-10-29-elymum-on-elysium.md`, section 6) and the
reference page `docs/design/storybook-reference.html`; the drawings here are copied from it.

Everything is generated from code. Change a template, run the generator, look at the PNGs.

```bash
node brand/generate.mjs            # everything (a few seconds)
node brand/generate.mjs og post-mint   # only some jobs
node brand/generate.mjs --list     # the jobs and their files
```

It needs only what the repository already installs: Playwright and the `@fontsource-variable`
fonts of `apps/web` (fonts are inlined as data URIs; when they are missing the templates fall back
to Google Fonts). Chromium comes from `CHROME_PATH` or Playwright's own browser
(`pnpm -F @coinnibal/web exec playwright install chromium` if you have none).

## Outputs (`brand/out/`)

| File | Size | Use |
|---|---|---|
| `x/x-avatar-400.png`, `x/x-avatar-1000.png` | 400, 1000 square | X profile picture (circle-safe): the sun coin on the ring at dusk |
| `x/x-banner-1500x500.png`, `x/x-banner-3000x1000.png` | 1500x500, @2x | X header: the ring scene, the hunter chasing a snack, the wordmark sticker on the right (the avatar covers the lower left) |
| `x/x2-avatar-1000.png`, `x/x2-banner-3000x1000.png` | 1000 square, 3000x1000 | The second X set (`lib/x2.mjs`): the coin that took a bite out of the ring, and a night chase with a "Coming soon" sticker naming `BRAND_SITE` |
| `x/coinnibal-avatar-1000.png`, `-2000.png`; `x/coinnibal-banner-1500x500.png`, `-3000x1000.png`, `-4500x1500.png` | square; 1500x500, @2x, @3x | The Coinnibal X set (`lib/x3.mjs`): the chomp mark, and the food chain under the ring with an "On Robinhood Chain" sticker naming `BRAND_SITE` |
| `web/og-coinnibal.png` | 1200x630 | Open Graph / Twitter card. **Also written to `apps/web/public/og-coinnibal.png`** (index.html points at it) |
| `web/favicon-32.png` | 32 | The CoinMark (a cyan coin with a bite out of it, fat cream C). **Also `apps/web/public/favicon-32.png`** |
| `web/apple-touch-icon.png` | 180 | CoinMark on the night trench with seigaiha. **Also `apps/web/public/apple-touch-icon.png`** |
| `web/coin-mark-512.png` | 512 | The mark alone, transparent, for anything else. **Also `apps/web/public/icon-512.png`** (web manifest) |
| `web/icon-192.png` | 192 | The mark for the web manifest. **Also `apps/web/public/icon-192.png`** |
| `web/icon-512-maskable.png` | 512 | The mark on the night trench, inside the maskable safe zone. **Also `apps/web/public/icon-512-maskable.png`** |
| `posts/post-wl-open.png` | 1600x900 | "The WL is open." with the three steps as stickers |
| `posts/post-mint.png` | 1600x900 | Night plate: "Get the Coinnibal NFT." and the mint card (paid in ETH, no price in the art) |
| `posts/post-game-live.png` | 1600x900 | "The game is open.": HUD stickers, leaderboard, coins with name tags |
| `stickers/sticker-sheet.png` | 1800x1200 | The cast of coins, the mark and the die-cut wordmark |
| `stickers/sticker-<name>.png` | 500 square, transparent | One die-cut sticker per character: hunter, snack, smug, happy, smile, open, sleepy |
| `posters/poster-<id>-<slug>.png` | 572x800 | One poster per room ($1, $3, $5, $10; the $10 Room NFT holders only) |

The PNGs are not committed (`brand/out/` is gitignored): run `node brand/generate.mjs`. The web copies in
`apps/web/public` are committed.

## Rules the templates follow

- Copy is plain, short English a beginner reads at a glance ("simple is the best"); the product is
  "Coinnibal", played with the game token (never a ticker in the art: amounts say "tokens"), the chain "Robinhood
  Chain", the gas token ETH, the handle `BRAND_X_HANDLE` (default `@coinnibalfun`). The one brand line is "Eat or be
  eaten." No domain is written into the art but the X banners' site stickers ("Coming soon" on the second set, "On
  Robinhood Chain" on the Coinnibal set; `BRAND_SITE`, default coinnibal.fun): the site lives at whatever `PUBLIC_URL`
  says. Nothing in the art says the testnet is open: the game stays closed until the owner opens it.
- The logo: the COINNIBAL brush letters (the web app's `Wordmark`) with a gold coin with a bite out of it as the
  "O"; the mark is a cyan coin with a bite out of its upper right edge and a fat cream C. The shapes live in
  `apps/web/src/design/motifs/brandShapes.ts` (repeated in `lib/art.mjs` and `apps/web/public/favicon.svg`).
- The art never shows a mint price: the mint page reads it from the contract.
- No gradients except the sky, no soft shadows, no purple, no emoji; one sun (primary) button per image.
- Shadows always go down and right.

## Files

- `generate.mjs`: the job list and the Playwright renderer (copies the web files into `apps/web/public`).
- `lib/art.mjs`: palette, fonts, base CSS, the coin character (`coin(paint, { mood, look, size, diecut })`),
  `wordmark()`, `coinMark()`, `seigaiha()`, `cloud()`, `terraces()`, stars, food bits, scene props.
- `lib/scene.mjs`: the ring habitat at dawn, copied from the reference's hero plate.
- `lib/templates.mjs`: one function per image.
