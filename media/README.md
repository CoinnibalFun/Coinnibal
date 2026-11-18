# Coinnibal films

Video pipelines for Coinnibal. Every film is code: scenes are drawn per frame (canvas or DOM) or
captured from the real web app with Playwright, then mixed and encoded with ffmpeg. Nothing here is
rendered in the repository; the outputs go to `out/videos/` (gitignored).

| Folder | Film |
|---|---|
| `promo/` | The 30 s Coinnibal launch film (re-made for the new brand: scenes in `promo/scenes`, the shared canvas kit with the Coinnibal marks in `promo/scenes/lib.js`; see `promo/README.md`) |
| `gameplay/` | Video A: a real paid round, captured from the app (`gameplay/capture`), cut by `gameplay/edit.mjs` |
| `how-to-play/` | Video B: the narrated guide, built on the gameplay kit |
| `gameplay-film/` | The narrated gameplay film (about 120 s, home page into a live round): script, voice-actor page, cue timeline, Kokoro or human voice with a humanising post chain, synthesised storybook score and sfx, mixer |
| `mint-film/` | The NFT announcement, WL → Mint → Play (it also holds the NFT kit `scenes/nft.js` and the short-film mixer) |
| `roadmap-chomp/` | 14 s music-only loop: the coin eats WL OPEN, MINT, GAME LIVE |

## Before the next render (the films of the Elysium build)

The films rendered so far (`out/videos/`, not in the repository) say Elymum, the project's name before the rename
(November 2026); the scripts and scenes here say Coinnibal, so a new render names Coinnibal. The voice's reading of
"Coinnibal" is a guess to check before a new take (`gameplay-film/audio/voice.py`).

Only the promo is current (Robinhood Chain, the $1 to $10 Rooms, no ticker, no price; `promo/README.md`). The
scripts of `mint-film`, `roadmap-chomp`, `how-to-play`, `gameplay` and `gameplay-film` still carry facts of the
Elysium build: Elysium and HYPE, a $1 mint, the old arena names and ladder, a flat 5 % fee and house bots in the paid
arena. Rewrite their voice lines, captions and scenes to the current game (Robinhood Chain, ETH gas, no mint price, the
$1 / $3 / $5 / $10 Rooms, 20 % of profit: 15 % burned + 5 % to the team wallet, holders 10 %, no bots in official
arenas) before any re-render. The hand-drawn scenes
use the Ring Storybook palette (`#04181C` ink, cream, sun, cyan, teal, trench night) and type
(Fraunces, DM Sans, Geist Mono, from `apps/web`'s `@fontsource-variable` packages). The captured
films (gameplay, how-to-play, the promo's footage) record the real UI, so they pick up the new
interface on their own, but only once it has landed:

1. Wait until the new web UI (spec section 6) is in `apps/web`, then re-take the captures
   (`media/gameplay/capture/take-all.sh` against `pnpm demo`). The capture kit's selectors and the
   `window.__coinnibal*` dev globals must match the new UI; fix them in `gameplay/capture/lib.mjs` first.
2. Re-synthesise every voice line (the scripts changed; the old takes in `cache/` are stale) and check
   the VO cue times in each `timeline.json` / edit script against the new takes.
3. Rebuild the art bundles (`node media/promo/render/build-art.mjs`, `node media/gameplay/motion/build-art.mjs`).
4. Render with `SITE_HOST` set to the host of the site's `PUBLIC_URL` (no domain is written into the
   films; the default is `coinnibal.fun`), for example `SITE_HOST=coinnibal.fun node media/promo/render/render.mjs`.
5. Look at the stills (`--preview`) before the full renders: the Storybook palette replaced the old
   Paper Ticket colours by name, so a few layouts (the wider "coinnibal" wordmark, longer lines) may need
   nudges.

The arena posters the promo pins up come from the brand kit (`brand/out/posters`, `node brand/generate.mjs`).
