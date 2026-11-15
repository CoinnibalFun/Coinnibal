# Coinnibal promo (40 s, 1920x1080, 60 fps)

The launch film for Coinnibal, in the web app's Storybook paints and type (`packages/shared/src/palette.ts`;
Fraunces, DM Sans, Geist Mono) with the brand's own marks (the COINNIBAL wordmark with the bitten gold coin
for the O, the coin mark, the chomp mark: `apps/web/src/design/motifs`, redrawn on canvas in `scenes/lib.js`)
and the game's coin characters (`packages/art`). Like the films before it, **the whole film is printed**:
kinetic two-line headlines on paper stock, tickets, tape, stamps, a receipt, bold colour bars. One idea per
beat; three of them carry the film: **you keep what you eat**, **the $NIBAL loop and its burn**, and **the
NFT collection**.

Everything is deterministic (no CSS animation, no wall clock): any frame can be re-rendered on its own.

## The film

The beat starts are in `timeline.json` ("beats"); the score, the SFX cues and the voice cues sit on the same
100 BPM grid (one beat = 0.6 s, one bar = 2.4 s).

| Time | Beat | On screen | Voice (Kokoro `af_heart`) |
| --- | --- | --- | --- |
| 0:00.0 | Cold open: you keep what you eat | Real footage of a paid $1 Room. Goldie (the gold coin) gulps a coin in slow motion: its "1,000 $NIBAL" tag lifts off it and flies into her purse, which ticks 1,000 → 2,000; a second gulp stacks it to 3,000. The camera pushes into her coin. "Eat a coin. / Keep what it carried." | "Eat a coin." "Keep what it carried." |
| 0:04.8 | Logo drop | Silence, then the drop: the coin O lands (the match cut from Goldie's coin) and the COINNIBAL letters slam in around it. "Coins that eat coins." / ON ROBINHOOD CHAIN. The chomp mark crosses and bites a coin. | "This is Coinnibal. Coins that eat coins, on Robinhood Chain." |
| 0:08.4 | Tickets | Four room tickets dealt on the beat: $1, $3, $5, $10 (the $10 one: NFT HOLDERS), each paid in $NIBAL. The $1 ticket is taken, taped and stamped PAID; Goldie pops out of it with the ticket's value on her tag ("YOUR TICKET = YOUR COIN'S VALUE"); a hole is punched and the camera dives through it. | "Buy a ticket in $NIBAL, from one to ten dollars. That's your coin's value." |
| 0:13.2 | Play | Real footage in a frame, cut on the beat: a gulp (EATEN, +1,000), a bigger coin chasing (RUN!), a split onto a runner (SPLIT). "Eat smaller. / Run from bigger." | "Eat smaller coins. Run from bigger ones." |
| 0:18.0 | Round | The round clock spins 5:00 to the bell; the receipt prints: ticket 1,000, coins eaten +3,000 (the cold open's payoff, highlighted), 4,000 at the bell, profit 3,000, fee 20% of profit -600, PAID 3,400 $NIBAL. | "Five-minute rounds." "Alive at the bell? You get paid." |
| 0:22.8 | $NIBAL | The loop TICKET → EAT → GET PAID → BURN (and again), a $NIBAL coin hopping round it; the profit bar splits 80% yours / 15% burned / 5% team, the burn slice catches fire, coins drop into the fire and a burn counter climbs; four power-up packs (Magnet, Leap, Speed, Invisible) paid in $NIBAL, HALF BURNED. | "The fee only touches profit, and most of it burns. So does half of every power-up." |
| 0:28.8 | NFT collection | Twelve emblems dealt face down and flipped in a wave (Common to Legendary), swept into a fan; one comes forward, HOLDER; the perks are slapped on: half the fee (10% of profit, not 20%), the $10 Room, 20% off power-ups and +1 power-up a round, a free private room every day, NFT skin + badge. An ink flood to night. | "The Coinnibal NFT collection. Hold one: half the fee, the ten-dollar room, cheaper power-ups." |
| 0:34.8 | End card | Silence, then the hit: the die-cut wordmark, "Eat or be eaten.", the site (`SITE_HOST`) and $NIBAL on a ticket, ON ROBINHOOD CHAIN / FREE PRACTICE ROOMS, the cast peeks up, the chomp mark bites on the sting. | "Coinnibal. Eat, or be eaten!" |

Never in the film: an X handle, a mint or NFT price, dates, "cash out anytime", seasons, floor loot, other
chains or the old names. The receipt's numbers are an illustrative round (1,000 $NIBAL a ticket, as the dev
stack's token price makes it); the fee split, the rooms and the perks follow `packages/shared` and the player
guide (`apps/web/src/ui/docs/content.en.ts`).

## Footage

The gameplay is a journal take of the gameplay kit (`media/gameplay/capture/take-promo.mjs`): Goldie plays
a real paid **$1 Room** (no bots there) against five staged wallets with real fake-chain tickets: a big coin
chases her, then three rivals are eaten (one by a split). `capture/replay.mjs` renders the take frame by
frame (60 fps, 240 fps in the slow-motion window, 1.5x pixels); `render/footage-from-takes.mjs` cuts the shots
in `timeline.json` ("footage": take, source second, duration, speed ramp, the gulp's second) into
`cache/footage/<id>/` with the hero's and the prey's positions per frame (`track.json`), which the scenes use
to frame the shots and to fly the value tags. The HUD is the app's own (the worth chip, the standings, the
round clock); the dev FPS counter is off.

## Voice

Kokoro TTS (local ONNX, `kokoro-v1.0`), voice `af_heart`, through the shared voice kit
`media/gameplay/render/voice.py` (script marks: `|` a breath, `||` a beat, `*word*` an emphasis). Per-line
speeds 1.0-1.14, a punchy read. Fixed pronunciations: Coinnibal /ˈkɔɪnɪbəl/ (like cannibal, with coin),
$NIBAL /ˈnɪbəl/ ("nibble"), Robinhood. Lines are written for the ear (numbers in words). The mixer gives
every line the same loudness, runs the VO chain (high-pass, mud cut, presence, air, de-esser, 3:1
compression, a light room) and ducks the music 8 dB under the voice.

## Layout

| Path | What it is |
| --- | --- |
| `timeline.json` | The single source of timing: beats, VO cues, SFX cues, the footage shots, the montage order, the gulps (for the score). |
| `scenes/promo.html` | The stage: one 1920x1080 canvas. |
| `scenes/lib.js` | The drawing kit: easing and springs, paper, grain and halftone, kinetic headlines, kickers, tickets, tape, stamps, the Coinnibal wordmark / coin mark / chomp mark, the $NIBAL coin, odometers, particles, ink blobs. |
| `scenes/scenes.js` | The eight beats and the cuts between them (paper wipes, whip pans, the punch-hole dive, the ink flood). |
| `scenes/main.js` | Boot code: fonts, textures, `window.renderAt(t)` and sub-frame motion blur. |
| `scenes/art-entry.ts`, `render/build-art.mjs` | The browser bundle of `packages/art` (coin characters) as `cache/art.js`. |
| `render/nft-cards.ts` | Draws twelve illustrative emblems with the NFT collection's own generator and renderer (`apps/server/src/site/nft`) from a film-only seed (not any real token's art) into `cache/nft/`. |
| `render/footage-from-takes.mjs` | Cuts the footage shots out of the replayed take (`--plan` prints the replay ranges). |
| `render/render.mjs` | Headless-Chromium frame renderer: parallel workers piping frames to ffmpeg (`--preview t1,t2` writes stills). |
| `render/mux.sh` | Finishes the sound (`finalize.py`: -16 LUFS, true peak at or below -1.2 dBTP after AAC) and encodes `out/videos/coinnibal-promo.mp4`. |
| `audio/vo-lines.json`, `audio/tts.py` | The script and its synthesis. |
| `audio/music.py` | The original score (numpy), written to the beats. |
| `audio/sfx.py` | Procedural SFX: stamps, paper, tape, punch, printer, coins, gulps, the round bell, fire and more. |
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
node render/render.mjs --preview 2,6,11,15,21,26,32,38      # stills in cache/preview/
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
