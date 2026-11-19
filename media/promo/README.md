# Coinnibal promo (31.8 s, 1920x1080, 60 fps)

The launch film for Coinnibal, in the web app's Storybook paints and type (`packages/shared/src/palette.ts`;
Fraunces, DM Sans, Geist Mono) with the brand's own marks (the COINNIBAL wordmark with the bitten gold coin
for the O, the coin mark, the chomp mark: `apps/web/src/design/motifs`, redrawn on canvas in `scenes/lib.js`)
and the game's coin characters (`packages/art`). The whole film is printed: kinetic headlines on paper stock,
tickets, tape, stamps, a receipt, dealt cards. It is a first look meant to raise interest, so the
information is kept plain: the game, one mention of the token, the NFT collection. Few words, short lines.

Everything is deterministic (no CSS animation, no wall clock): any frame can be re-rendered on its own.

## The film

The beat starts are in `timeline.json` ("beats"); the score, the SFX cues and the voice cues sit on the same
100 BPM grid (one beat = 0.6 s, one bar = 2.4 s).

| Time | Beat | On screen | Voice (Kokoro `af_heart`) |
| --- | --- | --- | --- |
| 0:00.0 | Cold open | Real footage of a paid $1 Room. Goldie gulps a coin in slow motion; its "1,000" tag (a plain gold token coin, no ticker) flies into her purse, 1,000 → 2,000; a second gulp stacks it to 3,000. The camera pushes into her coin. | 0.15 "Eat a coin." 1.55 "Keep what it carried." |
| 0:04.8 | Logo drop | Silence, then the drop: the coin O lands, the letters slam in. "Coins eating coins." / ON ROBINHOOD CHAIN; the chomp mark bites a coin. | 4.95 "This is Coinnibal. Coins eating coins." |
| 0:07.8 | Ticket + the token | Four room tickets dealt ($1, $3, $5, $10; the $10 one NFT HOLDERS ONLY); a big gold token coin drops in ("One token runs it all."); the $1 ticket is taped and stamped PAID, a hole is punched and the camera dives through it. | 7.95 "Buy a ticket. One token runs it all." |
| 0:11.4 | Play | Real footage in a frame, cut on the beat: a gulp (EATEN, +1,000), a bigger coin chasing (RUN!), a split (SPLIT). | 11.55 "Eat smaller coins. Run from bigger ones." |
| 0:15.0 | Round | The round clock spins 5:00 to the bell; a short receipt prints (ticket 1,000, coins eaten +3,000, your coin at the bell 4,000 tokens), PAID. | 15.1 "Five-minute rounds." 16.35 "Alive at the bell? You get paid." |
| 0:19.2 | NFT collection | Twelve emblems dealt face down and flipped, swept into a fan; one comes forward, HOLDER; HOLD ONE: the five holder perks as the site lists them (`apps/web/src/site/nft/WhyNft.tsx`), each slapped on as a sticker as the voice names it: Half the fee (on your profit), $10 Room for holders, 20% off power-ups (+1 power-up every paid round), 1 free private room a day, NFT skin and holder badge (the gold emblem coin). Ink flood to night. | 19.3 "The Coinnibal NFT collection. Half the fee, the ten-dollar room, cheaper power-ups, a free room every day, and a gold holder skin." |
| 0:27.0 | End card | Silence, then the hit: the die-cut wordmark, "Eat or be eaten.", the site (`SITE_HOST`) on a ticket, ON ROBINHOOD CHAIN, the cast peeks up, the chomp mark bites on the sting. | 27.25 "Coinnibal. Eat, or be eaten!" |

Never in the film: the token's ticker or name, fee or burn percentages (the holders' fee is "half the fee"), an
X handle, a mint or NFT price, dates, other chains, the old names or the test network (so no faucet perk). The
token is shown as a plain gold coin with a star. The receipt's numbers are an illustrative round. The NFT beat's
perks follow the site (the `nf.*` strings and the shared defaults in `packages/shared`): when a perk changes
there, change `PERKS` in `scenes/scenes.js`, the `nft` line and the sticker cues with it.

## Footage

The gameplay is a journal take of the gameplay kit (`media/gameplay/capture/take-promo.mjs`): Goldie plays
a real paid **$1 Room** (no bots there) against five staged wallets with real fake-chain tickets: a big coin
chases her, then rivals are eaten (one by a split). `capture/replay.mjs` renders the take frame by
frame (60 fps, 240 fps in the slow-motion window, 1.5x pixels); `render/footage-from-takes.mjs` cuts the shots
in `timeline.json` ("footage": take, source second, duration, speed ramp, the gulp's second) into
`cache/footage/<id>/` with the hero's and the prey's positions per frame (`track.json`), which the scenes use
to frame the shots and to fly the value tags. The HUD is the app's own (the worth chip, the standings, the
round clock); the dev FPS counter is off.

## Voice

Kokoro TTS (local ONNX, `kokoro-v1.0`), voice `af_heart`, through the shared voice kit
`media/gameplay/render/voice.py` (script marks: `|` a breath, `||` a beat, `*word*` an emphasis). Per-line
speeds 1.0-1.14, a punchy read. Every phrase is read in one piece: a breath only between sentences, list items
joined by commas, and no `*emphasis*` inside a phrase (the kit synthesises an emphasised word on its own after a
lift-in pause, so "Run from *bigger* ones." came out as "run from bigger ... ones"). Fixed pronunciations:
Coinnibal /ˈkɔɪnɪbəl/ (like cannibal, with coin), Robinhood. Lines are written for the ear (numbers in words).
The mixer gives every line the same loudness, runs the VO chain (high-pass, mud cut, presence, air, de-esser, 3:1
compression, a light room) and ducks the music 8 dB under the voice.

## Layout

| Path | What it is |
| --- | --- |
| `timeline.json` | The single source of timing: beats, VO cues, SFX cues, the footage shots, the montage order, the gulps (for the score). |
| `scenes/promo.html` | The stage: one 1920x1080 canvas. |
| `scenes/lib.js` | The drawing kit: easing and springs, paper, grain and halftone, kinetic headlines, kickers, tickets, tape, stamps, the Coinnibal wordmark / coin mark / chomp mark, the token coin, odometers, particles, ink blobs. |
| `scenes/scenes.js` | The seven beats and the cuts between them (paper wipes, whip pans, the punch-hole dive, the ink flood). |
| `scenes/main.js` | Boot code: fonts, textures, `window.renderAt(t)` and sub-frame motion blur. |
| `scenes/art-entry.ts`, `render/build-art.mjs` | The browser bundle of `packages/art` (coin characters) as `cache/art.js`. |
| `render/nft-cards.ts` | Draws twelve illustrative emblems with the NFT collection's own generator and renderer (`apps/server/src/site/nft`) from a film-only seed (not any real token's art) into `cache/nft/`. |
| `render/footage-from-takes.mjs` | Cuts the footage shots out of the replayed take (`--plan` prints the replay ranges). |
| `render/render.mjs` | Headless-Chromium frame renderer: parallel workers piping frames to ffmpeg (`--preview t1,t2` writes stills). |
| `render/mux.sh` | Finishes the sound (`finalize.py`: -16 LUFS, true peak at or below -1.2 dBTP after AAC) and encodes `out/videos/coinnibal-promo.mp4`. |
| `audio/vo-lines.json`, `audio/tts.py` | The script and its synthesis. |
| `audio/music.py` | The original score (numpy), written to the beats. |
| `audio/sfx.py` | Procedural SFX: stamps, paper, tape, punch, printer, coins, gulps, the round bell and more. |
| `audio/mix.py` | VO chain, ducking, stem levels, limiter, loudnorm to -16 LUFS. |

`cache/` is gitignored.

## Re-render

```bash
# 0. a python with kokoro-onnx, numpy, scipy, soundfile, pyloudnorm; the Kokoro models (kokoro-v1.0.onnx, voices-v1.0.bin)
PY=../gameplay/cache/venv/bin/python; MODELS=../gameplay/cache/models

# 1. footage: a dev stack with the game open to everyone, then the take and its replay
#    (server: GAME_ACCESS=public DEV_FAKE_CHAIN=1 DEV_FAKE_TOKEN=1 NODE_ENV=development PORT=8831,
#     with DATA_DIR/site/settings.json = {"wlOpen":true,"collabOpen":true,"gameAccess":"public"};
#     web: GAME_SERVER=http://127.0.0.1:8831 vite --port 5131)
COINNIBAL_URL=http://127.0.0.1:5131/play node ../gameplay/capture/take-promo.mjs     # ~15 min
#    pick the shots with the take's marks (events.json: chase, ate1, split, ate2, ate3) into timeline.json "footage"
node render/footage-from-takes.mjs --plan      # prints the replay command(s); run them from the repo root
node render/footage-from-takes.mjs             # -> cache/footage/<id>/

# 2. art
node render/build-art.mjs
(cd ../../apps/server && npx tsx ../../media/promo/render/nft-cards.ts)

# 3. picture
node render/render.mjs --preview 2,6,9,12,17,22,26,29      # stills in cache/preview/
SITE_HOST=coinnibal.fun node render/render.mjs --workers 3   # -> cache/video.mp4

# 4. sound
$PY audio/tts.py --models $MODELS --out cache/vo-raw
$PY audio/music.py cache/audio/music.wav
$PY audio/sfx.py cache/audio/sfx.wav
$PY audio/mix.py cache

# 5. the deliverable
PY=$PY render/mux.sh            # -> out/videos/coinnibal-promo.mp4
```

If you move a beat in `timeline.json`, the scenes, the score and the cue times follow the beat starts; the SFX
and VO cue seconds are absolute, so move them with it.

When only the later beats change and the footage cache is gone (a new take needs a dev stack), the picture can be
re-rendered from a beat on and the earlier part taken from the last film, decoded once into a lossless
intermediate (mux.sh then encodes it once). The frames are deterministic, so the cut has no seam as long as the
earlier beats and the first frame of the cut beat are unchanged (the 19.2 s cut, 19 Nov 2026):

```bash
SITE_HOST=coinnibal.fun node render/render.mjs --from 19.2 --to 31.8 --workers 3 --out cache/video-tail.mp4
ffmpeg -i ../../out/videos/coinnibal-promo.mp4 -i cache/video-tail.mp4 -filter_complex \
  "[0:v]trim=end_frame=1152,setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1[v]" \
  -map "[v]" -c:v libx264 -preset veryfast -qp 0 -pix_fmt yuv420p -r 60 cache/video.mp4
```
