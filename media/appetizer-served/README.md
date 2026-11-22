# Coinnibal "Appetizers are served" (13 s, 1920x1080, 1080x1080 and 1080x1920, 60 fps)

The X launch film for **The Appetizer**, the free early card a visitor claims on the landing page (their handle,
their own coin on a plate, a numbered order, the SERVED stamp). One teal gingham table, music and sound only,
120 BPM:

| Time | Beat |
| --- | --- |
| 0.0 | **Order up.** A brass desk bell pops onto the table and rings twice (0.5, 0.75): DING! A menu slip drops in and is taped down: "Coinnibal kitchen · Now serving / The Appetizer / Your early Coinnibal card". |
| 2.0 | **The deal.** Real Appetizer cards are dealt onto the table, each with its own guest and coin: No. 0001 @coinnibalfun, 0002 @nibble_queen, 0003 @coin_chef (2.0, 2.75, 3.5), then faster (quarters from 4.0, eighths from 5.0) up to No. 0038, a pile of orders. A sun strip on top: "Early cards, coming right up". |
| 6.0 | **The cloche.** The pile is swept off; one more card slides in big: "Table for @you", No. 0042, its plate under a silver cloche ("Your table is ready" in the square and vertical cuts). The cloche rattles and lifts (7.0) with steam and sparkles: the coin in its gingham napkin looks up, blinks, beams; the SERVED stamp thumps onto the card (8.0) and the coin grins. |
| 9.5 | **End card.** The card steps aside for the menu panel: the wordmark, "Appetizers are served.", "Grab yours at" the site's host (`SITE_HOST`, the `PUBLIC_URL` host; default coinnibal.fun), @coinnibalfun. |

The handles are made up (apart from @coinnibalfun). Copy rules: no ticker, no prices, nothing the card gives.

Every card is the real one: `drawAppetizerCard` of `packages/art` (bundled with the coins by `build-art.mjs` into
`cache/art.js`), drawn with the card's own Fraunces cut (the wght file the server's share image uses). The dealt
cards are drawn once into bitmaps; the hero card is drawn as vectors each frame through a context proxy (the card
resets the transform on entry) and its coin is re-posed on top with the card's own napkin (ported from
`appetizer.ts`, where it is not exported). If the card's layout changes, check `PX`, `PY`, `CR` and the stamp
position in `scenes/scenes.js`.

| Path | What it is |
| --- | --- |
| `timeline.json` | Size, duration, stem levels and the SFX cues (the dings, each card's deal and slap, the cloche, the stamp). |
| `scenes/scenes.js` | The table, the bell, the menu slip, the deal, the hero card with its cloche and coin, the end card. |
| `scenes/art-entry.ts`, `build-art.mjs` | The art bundle and the card font (`cache/`). |
| `audio/sfx.py` | The desk bell, the card deal and slap, the cloche's rattle and lift, the bloop (the mixer asks it before the promo's SFX). |
| `audio/music.py` | The score (the promo's instruments). |

## Re-render

```bash
node media/appetizer-served/build-art.mjs
SITE_HOST=<your host> node media/promo/render/render.mjs --project media/appetizer-served --preview 0.9,3.6,5.9,7.15,8.3,11   # stills
SITE_HOST=<your host> media/mint-film/render.sh media/appetizer-served coinnibal-appetizers-served \
  1920x1080: 1080x1080:-square 1080x1920:-vertical
```

`render.sh` needs the Python venv at `media/gameplay/cache/venv` (numpy, scipy, soundfile, pyloudnorm) and writes
`out/videos/coinnibal-appetizers-served{,-square,-vertical}.mp4` (H.264 high, yuv420p, AAC 192k, -14 LUFS, under
30 MB: fit for X) plus `-master` copies at CRF 12.
