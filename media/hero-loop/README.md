# Hero loop (landing page)

A short, muted, seamless loop of real Coinnibal play for the landing page's hero: goldie (the gold star
coin) cruises across a practice pond with a loose school of six or seven smaller coins around her. A coin
nibbling in her path sees her too late; she cuts it off and swallows it, its mass floats off her ("+N") and
the school swims on with her. The camera follows goldie and keeps her whole, in the middle of the frame and
at the same size (it eases out as she grows); seven or eight coins are in the frame all the time. 960x600
(16:10), 30 fps, about 9.5 s, no audio, no HUD; the name tags show names only.

Delivered files (the landing page serves them from `apps/web/public/media/`):

| File | What |
| --- | --- |
| `hero-loop.webm` | VP9, constant quality, two-pass (budget 900 KB) |
| `hero-loop.mp4` | H.264 main, yuv420p, `+faststart` (budget 1.3 MB) |
| `hero-loop-poster.webp` | The first frame: the coin in her path, a moment before the bite (the poster for `preload="metadata"` and reduced motion; budget 80 KB) |
| `contact-sheet.png` | 12 evenly spaced frames of the encoded mp4, labelled with their times (for review) |

## How it is made

Nothing is screen-recorded. The loop reuses the deterministic capture kit of `media/gameplay` (see its
README, "Deterministic capture"): a take records a journal of everything goldie's page received (WebSocket
messages, fetches, input) and a replay feeds it into a fresh page on a virtual clock, so every frame is
drawn at an exact time and the motion is as smooth as the game's own interpolation. The game client only
interpolates server snapshots, so the replay is the take.

A loop needs its last frame to run into its first. With a camera that follows a coin across the pond the
floor never repeats, so the take is staged so that everything the eye follows does: the school holds spots
around goldie, measured in her radius in the frame of her course, and drifts around them on smooth paths
that repeat every 9.2 s; her course sways on the same period. Any two moments 9.2 s apart in a scene then
look alike (the same coins in the same places around her, her eyes the same way and, since 9.2 s is twice
the coins' 4.6 s blink cycle, the same blinks), except for what happens in between: the coin she eats. The
seam cross-fades 0.6 s of floor and pellets under a frame that is otherwise the same.

1. `take-school.mjs` plays a practice pond of the dev stack (the same arena floor and renderer as the paid
   rooms; people only, no bots) with ten real players: goldie (the recorded page, 640x400 CSS px) and nine
   small silent browsers steered in-page (a 30 Hz timer sets each page's mouse). Seven are the school; two
   take turns as the prey. First goldie swims four passes across the pond, so every cactus is known. Then,
   scene after scene: she waits at the start of a lane across the pond (near the horizontal, clear of the
   walls, with no cactus that would show in the loop's frame), the school takes the spots nearest to it,
   the prey waits in her lane, nibbling, out of her frame; she cruises, comes up on it, it sees her too late
   and scurries off, she cuts it off (an intercept steer) and eats it; the school flinches away from the
   gulp and settles; she swims on. The school keeps 3.5 radii off her (closer, she would make her chomping
   face at it and it its scared face at her: the game's moods), rounds her instead of swimming through her
   and keeps clear of each other. Masses stay in bands (goldie about 270-450, the school 22 to a third of
   her, the prey 40-95): a coin that outgrows its band drops in fresh between scenes. Nobody grazes in coin
   rain. Besides the journal the take writes `tele.json`: 10 times a second every coin (with its mood) and
   cactus goldie's page knows about, in world units, the server's view, the pond's bounds and whether coin
   rain is falling.
2. `plan-school.mjs` scores every scene's spans [a, a + 9.2 s] under the follow camera of `cam.mjs`: the
   seam (the same coins in the same places with the same faces in the 0.6 s before a and before b, no prey,
   as little cactus as possible, no coin rain, goldie not growing: every pellet she eats makes her laugh
   for 0.65 s), the frame inside what the server sent and inside the pond, the prey in the frame a while
   before the gulp, the gulp near the middle, and the number of coins in the frame.
3. `render.mjs --follow 12 --no-mass` replays that span at 3x (640x400 CSS px rendered at 1920x1200) with
   the game's draw seeing the camera's box (goldie's position smoothed with a Gaussian of 0.35 s, 12 of her
   radii wide, the width following her radius critically damped) instead of the game's own camera (which
   keeps running underneath, so goldie's eyes still follow her cursor), the game's "show mass" setting
   off, and the DOM hidden from the pre-roll on: only the arena canvas shows. It also records every string
   drawn on a canvas while the frames are drawn and any DOM still visible, for the text check. `--ramp
   from-to@speed` changes the playback speed of source spans with smooth 0.6 s transitions; every frame is
   still drawn at an exact time of the take (no frame blending or dropping).
4. `loop.py` downsamples to 960x600 (Lanczos), moves each end of the loop by up to 0.3 s to where the
   frames at both ends match best (weighted to the middle of the frame: goldie), blends the loop's last
   0.6 s into the 0.6 s before its first frame (smoothstep), rotates the cycle so the first frame (the
   poster) is the moment before the bite, and encodes the web files, the poster and the contact sheet.

The small CSS viewport is on purpose: ink outlines (2.5 CSS px) and name tags (11-15 CSS px) keep a size
that reads when the loop plays at 400-600 px wide on the page.

## Re-make

```bash
# the dev stack on free ports (the game open to everyone, fake chain; ten capture browsers on one IP)
(cd apps/server && TRUST_PROXY=1 NODE_ENV=development DEV_FAKE_CHAIN=1 DEV_FAKE_TOKEN=1 GAME_ACCESS=public \
  MAX_CONNECTIONS_PER_IP=32 PORT=8942 DATA_DIR=$(mktemp -d) npx tsx src/index.ts) &
(cd apps/web && GAME_SERVER=http://127.0.0.1:8942 npx vite --port 5342 --strictPort --host 127.0.0.1) &
export COINNIBAL_URL=http://127.0.0.1:5342/play

node media/hero-loop/take-school.mjs --name school --minutes 20   # takes in media/gameplay/cache/takes/school
node media/hero-loop/plan-school.mjs school                      # prints the best spans: render and loop arguments
node media/hero-loop/render.mjs school --from <a-0.9> --to <b+0.3> --follow 12 --no-mass --scale 3 [--ramp ...] --out /tmp/school.mkv
python3 media/hero-loop/loop.py /tmp/school.mkv --fade 0.6 --a <a> --b <b> --search 0.3 --start-src <t> --out out/hero-loop
```

The delivered loop is take `s17`, scene 7 (goldie at 281, the prey at 77; the cleanest span of the takes tried:
no cactus in the frame but a corner of one at the seam), slowed to 0.7x through the gulp:

```bash
node media/hero-loop/render.mjs s17 --from 594.28 --to 604.68 --follow 12 --no-mass --scale 3 \
  --ramp 599.73-600.83@0.7 --out /tmp/s17.mkv
python3 media/hero-loop/loop.py /tmp/s17.mkv --fade 0.6 --a 595.18 --b 604.38 --search 0.3 --start-src 599.4 --out out/hero-loop
```

Keep ramps gentle (about 0.65x to 1.5x: the coins' motion reads as play speed) and clear of the
crossfade windows (the first and the last 0.9 s of the render).

`render.mjs` prints the canvas strings it saw (expect only the coin names and `+N` mass floats) and the
count of visible DOM elements besides the canvas (expect 0). Look at `contact-sheet.png`, at the frames
around the seam and at full frames before using a new loop: a take is live play and tells a slightly
different story each time.

Needs Playwright's Chromium (as the gameplay kit), ffmpeg with libx264 and libvpx-vp9, and Python 3 with
numpy and Pillow. A take runs ten browsers: on four cores, render nothing beside it.

## The first loop

`take.mjs` and `plan.mjs` made the first hero loop (take `hero7`, about 7.5 s): a fixed view of the floor
where goldie cuts off two smaller coins swimming past and eats one of them, with the seams where the view
held only floor. `render.mjs --box` and `loop.py` without `--a`/`--b` still make it:

```bash
node media/hero-loop/take.mjs --name hero --minutes 8
node media/hero-loop/plan.mjs hero
node media/hero-loop/render.mjs hero7 --from 276.45 --to 285.05 --box 3688,3769,1300 \
  --ramp 279.45-280.35@0.65,281.2-284.2@1.5 --scale 3 --out /tmp/hero7.mkv
python3 media/hero-loop/loop.py /tmp/hero7.mkv --fade 0.5 --start-src 279.42 --out out/hero-loop
```

## Rules for what may show

- Arena only: no HUD, standings, chat, buttons or wallet; the minimap and emote stickers are off.
- Coin names are neutral nicknames; no country flags (`country: ''`).
- Skins with a neutral face mark only (goldie's star; heart, drop, gem, bolt): the dollar and cent skins
  (and the old bars skin) never appear.
- No text other than names and `+N` mass floats (the school loop draws the name tags without masses: a mass
  would jump at the seam): never a ticker or `$`, a chain or network name, a wallet address or a dev label.
