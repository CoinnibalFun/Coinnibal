# Hero loop (landing page)

A short, muted, seamless loop of real Coinnibal play for the landing page's hero: a fixed view of the
arena floor where goldie (the gold star coin) cuts off two smaller coins swimming past and eats one of
them, while the other one bolts. 960x600 (16:10), 30 fps, about 7.5 s, no audio, no HUD.

Delivered files (not in the repository):

| File | What |
| --- | --- |
| `hero-loop.webm` | VP9, constant quality (CRF 32), two-pass, about 0.3 MB (budget 900 KB) |
| `hero-loop.mp4` | H.264 main, yuv420p, `+faststart`, CRF 20, about 0.45 MB (budget 1.3 MB) |
| `hero-loop-poster.webp` | The first frame (the poster for `preload="metadata"` and reduced motion) |
| `contact-sheet.png` | 12 evenly spaced frames of the encoded mp4, labelled with their times (for review) |

## How it is made

Nothing is screen-recorded. The loop reuses the deterministic capture kit of `media/gameplay` (see its
README, "Deterministic capture"): a take records a journal of everything goldie's page received (WebSocket
messages, fetches, input) and a replay feeds it into a fresh page on a virtual clock, so every frame is
drawn at an exact time and the motion is as smooth as the game's own interpolation. The game client only
interpolates server snapshots, so the replay is the take.

1. `take.mjs` plays a practice pond of the dev stack (the same arena floor and renderer as the paid rooms;
   people only, no bots) with five real players: goldie (the recorded page, 640x400 CSS px) and four small
   silent browsers (`nori`, `pip`, `mochi`, `lulu`) steered by the kit's in-page brain. The others graze
   to a modest size (one that grows too heavy drops in fresh) and wait out of goldie's view. Again and again one of
   them, or two side by side, swims across her side of the pond; she leaves her spot to cut it off (an
   intercept steer on the snapshot velocities), eats it and swims on; the companion bolts. Besides the
   journal the take writes `tele.json`: 10 times a second every coin and cactus she knows about, in world
   units, and the server's view.
2. `plan.mjs` picks the shot from the telemetry: for each gulp a fixed world box (16:10) and a span
   [a, b] such that the box holds no coin or name tag during the crossfade window before a and before b
   (so the seam only blends floor and pellets), stays inside what the server sent (no coins popping in at
   the edge) and inside the world (no wall), keeps both coins on screen as long as possible, favours time
   with several coins in the frame over time with one coin alone or none, and does not cut a cactus with
   the frame's edge.
3. `render.mjs` replays that span at 3x (640x400 CSS px rendered at 1920x1200) with the game's draw seeing
   the fixed box instead of the following camera (the game's own camera keeps running underneath, so
   goldie's eyes still follow her cursor) and with the DOM hidden from the pre-roll on: only the arena
   canvas shows. It also records every string drawn on a canvas while the frames are drawn and any DOM
   still visible, for the text check. `--ramp from-to@speed` changes the playback speed of source spans
   with smooth 0.6 s transitions; every frame is still drawn at an exact time of the take (no frame
   blending or dropping). The delivered loop slows to 0.65x through the gulp and plays goldie's exit,
   when she is alone in the frame, at 1.5x.
4. `loop.py` downsamples to 960x600 (Lanczos), blends the loop's last 0.5 s into the 0.5 s before its
   first frame (smoothstep), rotates the cycle so the first frame (the poster) is the moment before the
   bite (`--start-src`, a time of the take), and encodes the web files, the poster and the contact sheet.

The small CSS viewport is on purpose: ink outlines (2.5 CSS px) and name tags (11-15 CSS px) keep a size
that reads when the loop plays at 400-600 px wide on the page.

## Re-make

```bash
# the dev stack on free ports (the game open to everyone, fake chain)
(cd apps/server && TRUST_PROXY=1 NODE_ENV=development DEV_FAKE_CHAIN=1 DEV_FAKE_TOKEN=1 GAME_ACCESS=public \
  PORT=8912 DATA_DIR=$(mktemp -d) npx tsx src/index.ts) &
(cd apps/web && GAME_SERVER=http://127.0.0.1:8912 npx vite --port 5312 --strictPort --host 127.0.0.1) &
export COINNIBAL_URL=http://127.0.0.1:5312/play

node media/hero-loop/take.mjs --name hero --minutes 8      # takes in media/gameplay/cache/takes/hero
node media/hero-loop/plan.mjs hero                         # prints the best shots: render and loop arguments
node media/hero-loop/render.mjs hero --from <a-0.5> --to <b> --box <cx,cy,w> --scale 3 [--ramp ...] --out /tmp/hero.mkv
python3 media/hero-loop/loop.py /tmp/hero.mkv --fade 0.5 --start-src <t> --out out/hero-loop
```

The delivered loop is take `hero7`, gulp 8 (plan.mjs's best shot of seven takes):

```bash
node media/hero-loop/render.mjs hero7 --from 276.45 --to 285.05 --box 3688,3769,1300 \
  --ramp 279.45-280.35@0.65,281.2-284.2@1.5 --scale 3 --out /tmp/hero7.mkv
python3 media/hero-loop/loop.py /tmp/hero7.mkv --fade 0.5 --start-src 279.42 --out out/hero-loop
```

Keep ramps gentle (about 0.65x to 1.5x: the coins' motion reads as play speed) and clear of the
crossfade windows (the first and the last `--fade` seconds of the render).

`render.mjs` prints the canvas strings it saw (expect only the coin names, their masses and `+N` mass
floats) and the count of visible DOM elements besides the canvas (expect 0). Look at `contact-sheet.png`
and at full frames before using a new loop: a take is live play and tells a slightly different story
each time.

Needs Playwright's Chromium (as the gameplay kit), ffmpeg with libx264 and libvpx-vp9, and Python 3 with
numpy and Pillow.

## Rules for what may show

- Arena only: no HUD, standings, chat, buttons or wallet; the minimap and emote stickers are off.
- Coin names are neutral nicknames; no country flags (`country: ''`).
- Skins with a neutral face mark only (goldie's star; heart, drop, gem, bolt): the dollar and cent skins
  (and the old bars skin) never appear.
- No text other than names, masses and `+N` mass floats: never a ticker or `$`, a chain or network name,
  a wallet address or a dev label.
