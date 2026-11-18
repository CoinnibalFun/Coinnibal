#!/usr/bin/env node
// Renders a span of a journal take (take.mjs) for the hero loop: the take is replayed on the virtual clock of
// media/gameplay/capture/journal.mjs (every frame at an exact time, however long it takes to draw), with
//   - a fixed camera on a box of the world (the game's own camera keeps running underneath, so goldie's eyes
//     still follow her cursor; only the draw sees the fixed box),
//   - the page's DOM hidden from the pre-roll on (HUD, standings, controls, chat, buttons): only the arena
//     canvas shows.
// Frames go to a near-lossless intermediate (x264 RGB, CRF 4); loop.py makes the loop from it.
//
//   node media/hero-loop/render.mjs <take> --from 61.2 --to 70.4 --box 3400,3100,1000 [--fps 30] [--scale 1.5]
//     [--ramp 66.0-68.5@1.5] [--out x.mkv]
// --box is the world box: centre x, centre y and width (world units; the height follows the viewport's 16:10).
// --ramp plays source spans faster (take seconds, comma-separated `from-to@speed`), with smooth 0.6 s speed
// changes: for a stretch where a single coin swims out of the frame on its own. Keep the ramps clear of the
// loop's crossfade windows (the first and the last --fade seconds of the render): loop.py blends those frame
// by frame. Every frame is still drawn at an exact time of the take (no frame blending, no dropped frames).
import { spawn } from 'node:child_process';
import { readFileSync, createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { BASE, CHROME, FFMPEG, ROOT, TAKES, log, setupContext } from '../gameplay/capture/lib.mjs';
import { replayShim } from '../gameplay/capture/journal.mjs';

const require = createRequire(resolve(ROOT, 'apps/web/package.json'));
const { chromium } = require('playwright');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const NAME = argv[0];
const DIR = resolve(TAKES, NAME);
const FROM = Number(opt('--from')), TO = Number(opt('--to'));
const FPS = Number(opt('--fps', '30'));
const SCALE = Number(opt('--scale', '1.5'));
const [BX, BY, BW] = opt('--box').split(',').map(Number);
const OUT = resolve(opt('--out', resolve(DIR, `render-${FROM}-${TO}.mkv`)));
const RAMPS = (opt('--ramp', '') || '').split(',').filter(Boolean).map((r) => { const [span, sp] = r.split('@'); const [t0, t1] = span.split('-').map(Number); return { t0, t1, sp: Number(sp) }; });
const meta = JSON.parse(readFileSync(resolve(DIR, 'events.json'), 'utf8'));
if (!meta.journal) throw new Error(`${NAME} is not a journal take`);

// ── journal ──
const T0 = meta.t0 * 1000;
const ws = {}, msgs = [], fetches = [], inputs = [];
let clock = null;
for await (const line of createInterface({ input: createReadStream(resolve(DIR, meta.journal)), crlfDelay: Infinity })) {
  if (!line) continue;
  const e = JSON.parse(line);
  if (e.k === 'clock') clock ||= e;
  else if (e.k === 'ws') ws[e.key] = { t: e.t };
  else if (e.k === 'wsopen') (ws[e.key] ||= {}).open = e.t;
  else if (e.k === 'wsclose' || e.k === 'm') msgs.push(e);
  else if (e.k === 'fetch') fetches.push(e);
  else if (e.k === 'in') inputs.push(e);
}
msgs.sort((a, b) => a.t - b.t);
inputs.sort((a, b) => a.t - b.t);
const E = clock.date - clock.perf;
const vOf = (t) => T0 + t * 1000 - E; // take seconds -> virtual ms
const tOf = (v) => (v + E - T0) / 1000;

/** Page side: DOM hidden, and the draw sees the fixed box instead of the game's camera. */
function heroLoopInit(cfg) {
  window.__drawOn = false;
  // every string the page draws on a canvas while the loop's frames are drawn (name tags, value floats):
  // the forbidden-text check reads these (cached label sprites are drawn again when their text changes)
  window.__texts = new Set();
  for (const C of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
    if (!C) continue;
    for (const k of ['fillText', 'strokeText']) {
      const f = C.prototype[k];
      C.prototype[k] = function (text, ...rest) { if (window.__drawOn) window.__texts.add(String(text)); return f.call(this, text, ...rest); };
    }
  }
  /** From the pre-roll on: the DOM goes (not at load: the take's clicks on practice, leave and rejoin must land). */
  window.__hideDom = () => {
    const s = document.createElement('style');
    s.textContent = 'body * { visibility: hidden !important; } canvas.game-canvas { visibility: visible !important; } html, body { background: #000 !important; }';
    document.head.appendChild(s);
  };
  /** As soon as the engine exists: no drawing until the pre-roll (fast-forward), then the fixed box. */
  window.__installHeroCam = () => {
    const e = window.__elymum?.engine;
    if (!e) return false;
    if (e.__heroCam) return true;
    const r = e.renderer, cam = e.camera, draw = r.draw.bind(r);
    r.draw = (fi) => {
      if (!window.__drawOn) return;
      const keep = [cam.x, cam.y, cam.zoom];
      cam.x = cfg.x; cam.y = cfg.y; cam.zoom = cam.w / cfg.w;
      try { draw(fi); } finally { [cam.x, cam.y, cam.zoom] = keep; }
    };
    r.drawMinimap = () => {};
    e.__heroCam = true;
    return true;
  };
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu', '--disable-smooth-scrolling', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--force-color-profile=srgb', '--font-render-hinting=none'] });
const ctx = await browser.newContext({ viewport: { width: meta.w, height: meta.h }, deviceScaleFactor: SCALE, locale: 'en-US' });
const wsMeta = {};
for (const [k, v] of Object.entries(ws)) wsMeta[k] = { open: v.open ?? null };
await ctx.addInitScript(replayShim, { V0: clock.perf, E, ws: wsMeta, fetches });
await setupContext(ctx, meta.player);
await ctx.addInitScript(heroLoopInit, { x: BX, y: BY, w: BW });
const page = await ctx.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { if (pageErrors++ < 8) log('[pageerror]', e.message); });
await page.goto(BASE, { waitUntil: 'load' });
const cdp = await ctx.newCDPSession(page);

let mi = 0, ii = 0, V = clock.perf;
const due = (toV) => { const out = []; while (mi < msgs.length && msgs[mi].t <= toV) out.push(msgs[mi++]); return out; };
async function dispatch(e) {
  const m = page.mouse;
  if (e.type === 'mousemove') await m.move(e.x, e.y);
  else if (e.type === 'mousedown') { await m.move(e.x, e.y); await m.down({ button: ['left', 'middle', 'right'][e.b] || 'left' }); }
  else if (e.type === 'mouseup') { await m.move(e.x, e.y); await m.up({ button: ['left', 'middle', 'right'][e.b] || 'left' }); }
  else if (e.type === 'wheel') { await m.move(e.x, e.y); await m.wheel(e.dx, e.dy); }
  else if (e.type === 'keydown' && !e.rep) await page.keyboard.down(e.code || e.key).catch(() => {});
  else if (e.type === 'keyup') await page.keyboard.up(e.code || e.key).catch(() => {});
}
async function step(toV) {
  while (ii < inputs.length && inputs[ii].t <= toV) {
    const e = inputs[ii++];
    await page.evaluate(([v, m]) => window.__replay.advance(v, m), [e.t, due(e.t)]);
    await dispatch(e);
  }
  await page.evaluate(([v, m]) => window.__replay.advance(v, m), [toV, due(toV)]);
  await page.evaluate(() => window.__replay.frame());
  V = toV;
}

// fast-forward without drawing up to the pre-roll (the renderer's easing and jelly settle in it)
const PRE = 2000;
const first = vOf(FROM);
let cam = false;
while (first - PRE - V > 1) {
  const nextIn = ii < inputs.length ? inputs[ii].t : Infinity;
  const to = Math.min(first - PRE, nextIn, V + 1000);
  if (to > V) { await page.evaluate(([v, m]) => window.__replay.ffwd(v, m, 50), [to, due(to)]); V = to; }
  if (!cam) cam = await page.evaluate(() => window.__installHeroCam());
  if (nextIn <= Math.min(first - PRE, V)) await dispatch(inputs[ii++]);
}
if (!cam && !(await page.evaluate(() => window.__installHeroCam()))) throw new Error('no engine at the pre-roll');
await page.evaluate(() => { window.__hideDom(); window.__drawOn = true; });
const settle = await page.evaluate(() => window.__elymum.useUi.getState().screen);
log(`${NAME}: at ${tOf(V).toFixed(2)}s, screen ${settle}; rendering ${FROM}..${TO} at ${FPS} fps, box ${BX},${BY} w ${BW}`);

const W = Math.round(meta.w * SCALE), H = Math.round(meta.h * SCALE);
const enc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264rgb', '-preset', 'fast', '-crf', '4', '-r', String(FPS), OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
// the source time of every output frame: speed 1 outside the ramps, smoothstep changes of RAMP_W seconds
// centred on each ramp's ends
const RAMP_W = 0.6;
const ss = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const speed = (t) => RAMPS.reduce((v, r) => v + (r.sp - 1) * ss((t - r.t0 + RAMP_W / 2) / RAMP_W) * (1 - ss((t - r.t1 + RAMP_W / 2) / RAMP_W)), 1);
const src = [];
if (!RAMPS.length) for (let k = 0; k < Math.round((TO - FROM) * FPS); k++) src.push(FROM + k / FPS);
else {
  // integrate output time over source time; each frame's source time interpolated inside its step
  let t = FROM, out = 0;
  const dt = 0.0005;
  while (t < TO - 1e-9) {
    const next = out + dt / speed(t);
    while (src.length / FPS < next - 1e-12 && src.length / FPS >= out - 1e-12) src.push(t + ((src.length / FPS - out) / (next - out)) * dt);
    out = next;
    t += dt;
  }
  while (src.length && src[src.length - 1] > TO - 1e-9) src.pop();
}
for (const r of RAMPS) log(`ramp ${r.t0}-${r.t1} at ${r.sp}x`);
const n = src.length;
const tStart = Date.now();
const times = [];
for (let k = 0; k < n; k++) {
  const target = vOf(src[k]);
  while (target - V > 1000 / 60 + 0.5) await step(V + 1000 / 60);
  await step(target);
  await page.evaluate(() => window.__replay.paint());
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: meta.w, height: meta.h, scale: SCALE } });
  const buf = Buffer.from(shot.data, 'base64');
  if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once('drain', r));
  times.push(+tOf(target).toFixed(4));
  if (k % 60 === 0) log(`${NAME}: frame ${k}/${n}  ${(k / Math.max(1, (Date.now() - tStart) / 1000)).toFixed(1)} fps`);
}
enc.stdin.end();
await new Promise((r) => enc.on('close', r));
const errs = await page.evaluate(() => window.__replay.errors);
// what the frames can show besides the canvas (should be nothing) and every string drawn on canvases
const check = await page.evaluate(() => {
  const vis = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.matches('canvas.game-canvas')) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.visibility === 'visible' && cs.display !== 'none' && r.width > 0 && r.height > 0 && !el.querySelector('canvas.game-canvas')) vis.push(el.tagName + '.' + el.className);
  }
  return { visibleDom: vis.slice(0, 20), texts: [...window.__texts] };
});
await browser.close();
writeFileSync(OUT.replace(/\.mkv$/, '.json'), JSON.stringify({ take: NAME, from: FROM, to: TO, fps: FPS, box: [BX, BY, BW], size: [W, H], ...check, times }));
log(`canvas texts while drawing: ${JSON.stringify(check.texts)}; visible DOM besides the canvas: ${check.visibleDom.length}`);
log(`${NAME}: ${n} frames -> ${OUT}; page errors ${pageErrors}, callback errors ${errs}`);
