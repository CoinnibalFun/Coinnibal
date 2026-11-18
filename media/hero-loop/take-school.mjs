#!/usr/bin/env node
// Take "school": the raw play for the second hero loop, recorded as a journal (see media/gameplay/README.md,
// "Deterministic capture"). A practice pond of the dev stack (the same arena floor and renderer as the paid
// rooms, people only, no bots): goldie (the recorded page) cruises across the pond with a loose school of
// smaller coins around her, comes up on a coin nibbling in her path, eats it and swims on.
//
// Ten real players: goldie (640x400 CSS px, the journal) and nine small silent browsers (no drawing). Seven of
// them (the school) hold loose spots around goldie, measured in her radius in the frame of the scene's heading,
// each drifting around its spot on a smooth path that repeats every PERIOD seconds; a flinch away from the gulp
// is the only other motion. Goldie's own course sways on the same period. So any two moments PERIOD seconds
// apart in a scene look alike (the school in the same places around her, her eyes the same way), except for
// what happens in between: the coin she eats. plan-school.mjs then picks a span [a, a + PERIOD] where nothing
// else differs at the seam, and render.mjs follows her with the camera.
// Two more (the prey) take turns: one waits in her path, nibbling, outside her frame; she comes up on it, it
// sees her too late and scurries off, she eats it. It drops back in fresh, grazes and waits for its next turn.
//
// Masses stay in bands (the school and the prey drop in fresh when they grow too heavy, goldie too) so the
// sizes keep reading: goldie about 240-430, the school about 25-110, the prey about 40-95.
//
// Besides the journal the take writes `tele.json`: 10 times a second, every coin and cactus goldie's page
// knows about (world units), the server's view and whether coin rain is falling (its screen-space coins
// would show in the loop).
//
//   COINNIBAL_URL=http://127.0.0.1:5342/play node media/hero-loop/take-school.mjs [--name school] [--minutes 10]
// `touch media/gameplay/cache/takes/<name>.stop` ends the take early (it still saves).
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE, Player, Recorder, TAKES, launch, log, sleep } from '../gameplay/capture/lib.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const NAME = opt('--name', 'school');
const MINUTES = Number(opt('--minutes', '10'));
/** Seconds: the school's drift and goldie's sway repeat on this period (the loop's length in take time). */
const PERIOD = Number(opt('--period', '8.6'));
const HERO_MIN = Number(opt('--hero-min', '240'));
const HERO_MAX = Number(opt('--hero-max', '430'));
// the school stays smaller than a cactus (a coin bigger than one pops on it)
const ESC_MIN = 22, ESC_MAX = 110;
const PREY_MIN = 40, PREY_MAX = 95;
/** Goldie's sway (radians each way). */
const SWAY = (Number(opt('--sway', '8')) * Math.PI) / 180;
/** Seconds of cruise before the prey can show (the loop starts after it). */
const LEAD = 2.4;
/** The prey waits this far beyond what she covers in LEAD (in her radius): out of her frame when the loop starts. */
const SPOT_R = 6.6;
const W = 640, H = 400;
/** Mouse distance from her coin when steering (CSS px; the page is small). */
const REACH = 170;
const STOP = resolve(TAKES, `${NAME}.stop`);
const T0 = Date.now();

/**
 * The school's spots around goldie: [forward, left] in her radius, in the frame of the scene's heading (left is
 * up on screen when she swims right). The quarter ahead and up stays clear: the prey sits there.
 */
const SLOTS = [[3.6, -1.5], [3.1, 2.1], [0.5, -2.4], [-1.6, 2.1], [-2.3, -1.9], [-4.0, 0.5], [-4.3, -2.3]];
const SCHOOL = [['nori', 4], ['pip', 5], ['mochi', 7], ['lulu', 6], ['bean', 5], ['kiwi', 4], ['sumi', 7]];
const PREY = [['taro', 4], ['yuzu', 5]];

const common = { audio: 'off', minimap: false, theme: 'light', settings: { country: '', countryAuto: false, showChat: false, showEmotes: false, showMass: false } };
const browser = await launch();
const hero = new Player(browser, { name: 'goldie', skin: 1, w: W, h: H, quality: 'high', ...common, journal: resolve(CACHE, `journal-${NAME}.jsonl`) });
const mk = ([name, skin], role, i) => Object.assign(new Player(browser, { name, skin, w: W, h: H, quality: 'low', noDraw: true, fast: true, ...common }), { role, i });
const school = SCHOOL.map((s, i) => mk(s, 'school', i));
const preys = PREY.map((s, i) => mk(s, 'prey', i));
const others = [...school, ...preys];

let stop = false;
/** A scene runs (staging or cruise): the keeper starts nobody fresh. */
let sceneOn = false;
/** Coin rain is falling (everyone would put on mass fast, and its coins show on screen): nobody moves. */
let raining = false;
const me = { wx: 3400, wy: 3400, mass: 0, vx: 0, vy: 0, t: 0 };
const tele = [];
let rec;
const radius = (m) => Math.sqrt(Math.max(m, 1)) * 10;
const speedOf = (m) => { const r = radius(m); return r <= 100 ? 2185 * Math.pow(r, -0.44) : 2185 * Math.pow(100, -0.44) * Math.pow(r / 100, -0.3); };

/** A tiny seeded random (the school's drift is the same every run). */
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296); }

/** In-page helpers for goldie: telemetry and the intercept steer. */
function heroHelpers() {
  window.__tele = () => {
    const S = window.__elymum;
    const w = S?.engine?.world;
    if (!w) return null;
    const m = w.myStats();
    const ui = S.useUi.getState();
    const cells = [];
    const cacti = [];
    for (const e of w.entities.values()) {
      if (e.kind === 1) cells.push([e.id, e.playerId, Math.round(e.x), Math.round(e.y), Math.round(e.r), e.dying ? 1 : 0]);
      else if (e.kind === 4) cacti.push([Math.round(e.x), Math.round(e.y), Math.round(e.r)]);
    }
    const rain = !!ui.banner && ui.banner.kind === 'coinrain' && ui.banner.until > Date.now();
    return { t: Date.now() / 1000, screen: ui.screen, pid: w.myPid, me: m ? [Math.round(m.x), Math.round(m.y), Math.round(m.mass)] : null, view: [Math.round(w.serverView.x), Math.round(w.serverView.y), Math.round(w.serverView.h)], world: [w.width, w.height], bounds: [w.x0, w.y0, w.x0 + w.width, w.y0 + w.height], rain: rain ? 1 : 0, cells, cacti };
  };
  /** Steers at the point where she meets `pid` (its velocity from the snapshots), or straight at it once close. */
  window.__intercept = (pid, reach) => {
    const S = window.__elymum, e = S.engine, w = e.world;
    const m = w.myStats();
    if (!m) return { dead: S.useUi.getState().screen !== 'playing' };
    let prey = null;
    for (const en of w.entities.values()) if (en.kind === 1 && en.playerId === pid && !en.dying && (!prey || en.r > prey.r)) prey = en;
    if (!prey) return { lost: true };
    const big = Math.sqrt(m.mass) * 10;
    const sp = big <= 100 ? 2185 * Math.pow(big, -0.44) : 2185 * Math.pow(100, -0.44) * Math.pow(big / 100, -0.3);
    const dx = prey.x - m.x, dy = prey.y - m.y, d = Math.hypot(dx, dy);
    const vx = prey.vx || 0, vy = prey.vy || 0;
    const a = vx * vx + vy * vy - sp * sp, b = 2 * (dx * vx + dy * vy), c = dx * dx + dy * dy;
    let t = 0;
    if (Math.abs(a) < 1e-6) t = b < 0 ? -c / b : 0;
    else { const disc = b * b - 4 * a * c; if (disc >= 0) { const r = [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)].filter((x) => x > 0); t = r.length ? Math.min(...r) : 0; } }
    t = Math.min(Number.isFinite(t) ? t : 0, 2.5);
    const ax = prey.x + vx * t, ay = prey.y + vy * t;
    const ux = ax - m.x, uy = ay - m.y, un = Math.hypot(ux, uy) || 1;
    const c0 = e.camera.toScreen(m.x, m.y);
    const p = d < big * 1.1 ? e.camera.toScreen(prey.x, prey.y) : { x: c0.x + (ux / un) * reach, y: c0.y + (uy / un) * reach };
    return { x: p.x, y: p.y, d, wx: m.x, wy: m.y, mass: m.mass, big };
  };
  /** Where she is (world) and the screen point `reach` px from her coin along (hx, hy). */
  window.__ahead = (hx, hy, reach) => {
    const S = window.__elymum, e = S.engine, w = e.world;
    const m = w.myStats();
    if (!m) return { dead: S.useUi.getState().screen !== 'playing' };
    const c0 = e.camera.toScreen(m.x, m.y);
    return { x: c0.x + hx * reach, y: c0.y + hy * reach, wx: m.x, wy: m.y, mass: m.mass };
  };
}

/**
 * In-page steering for the school and the prey (no round trips: a 30 Hz timer sets the page's mouse from
 * `window.__esc.cfg`). Modes: `slot` (a spot around goldie that drifts on the period, plus the flinch),
 * `goto`, `dawdle` (nibbling around a point), `flee` (scurrying away from goldie, slowly) and `brain` (the kit's
 * forager: graze, keep away from bigger coins).
 */
function escHelpers() {
  const TAU = Math.PI * 2;
  window.__esc = { cfg: null, g: null };
  const goldie = (w, pid) => {
    let g = null;
    for (const en of w.entities.values()) if (en.kind === 1 && en.playerId === pid && !en.dying && (!g || en.r > g.r)) g = en;
    return g;
  };
  /**
   * A detour around goldie: when the straight line from me to the target passes within `safe` of her, a point on
   * a circle around her, turned from where I am toward the target (so nobody swims through her and is eaten).
   */
  const around = (tx, ty, mx, my, gx, gy, safe) => {
    const ax = mx - gx, ay = my - gy, da = Math.hypot(ax, ay) || 1;
    if (da < safe * 0.95) return [gx + (ax / da) * safe * 1.3, gy + (ay / da) * safe * 1.3];
    const sx = tx - mx, sy = ty - my, sl = sx * sx + sy * sy || 1;
    const u = Math.max(0, Math.min(1, -(ax * sx + ay * sy) / sl));
    if (Math.hypot(ax + sx * u, ay + sy * u) >= safe) return [tx, ty];
    const angA = Math.atan2(ay, ax);
    let d = Math.atan2(ty - gy, tx - gx) - angA;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    // round her on a circle just outside `safe` (from far away: in toward it while turning)
    const ang = angA + Math.sign(d) * Math.min(Math.abs(d), 1.0), rad = Math.min(da, safe * 1.3);
    return [gx + Math.cos(ang) * rad, gy + Math.sin(ang) * rad];
  };
  window.__esc.state = () => {
    const S = window.__elymum;
    const st = S.useUi.getState();
    const w = S.engine.world;
    const m = st.screen === 'playing' ? w.myStats() : null;
    return { screen: st.screen, pid: st.me?.pid ?? null, mass: m ? m.mass : 0, wx: m ? m.x : null, wy: m ? m.y : null };
  };
  setInterval(() => {
    const c = window.__esc.cfg;
    const S = window.__elymum;
    if (!c || !S) return;
    if (S.useUi.getState().screen !== 'playing') return;
    const e = S.engine, w = e.world;
    const m = w.myStats();
    if (!m) return;
    const now = Date.now() / 1000;
    const hg = window.__esc.g;
    const gEn = hg ? goldie(w, hg.pid) : null;
    const gx = gEn ? gEn.x : hg ? hg.wx + hg.vx * (now - hg.t) : null;
    const gy = gEn ? gEn.y : hg ? hg.wy + hg.vy * (now - hg.t) : null;
    // (a floor on her radius while she is small again: the school keeps well clear of a fresh coin)
    const R = Math.max(gEn ? gEn.r : hg ? hg.R : 150, c.Rmin || 0);
    let tx = null, ty = null;
    if (c.mode === 'slot' && gx != null) {
      const ph = (TAU * (now - c.t0)) / c.T;
      const d = c.drift;
      const u = c.u + d[0] * Math.sin(ph + d[1]) + d[2] * Math.sin(2 * ph + d[3]);
      const v = c.v + d[4] * Math.sin(ph + d[5]) + d[6] * Math.sin(2 * ph + d[7]);
      tx = gx + R * (u * c.hx + v * c.hy);
      ty = gy + R * (u * c.hy - v * c.hx);
      const sc = c.flinch;
      if (sc) {
        const k = (now - sc.t) / sc.dur;
        if (k > 0 && k < 1) {
          const dx = tx - sc.x, dy = ty - sc.y, dd = Math.hypot(dx, dy) || 1;
          const reach = sc.reach * R;
          if (dd < reach) {
            const amp = sc.amp * R * Math.pow(Math.sin(Math.PI * Math.min(1, k * 1.25)), 2) * (1 - 0.5 * (dd / reach));
            tx += (dx / dd) * amp;
            ty += (dy / dd) * amp;
          }
        }
      }
    } else if (c.mode === 'goto') {
      tx = c.wx; ty = c.wy;
    } else if (c.mode === 'dawdle') {
      const ph = (TAU * now) / c.per;
      tx = c.wx + c.rad * Math.cos(ph) + 0.4 * c.rad * Math.sin(2.3 * ph);
      ty = c.wy + c.rad * Math.sin(ph);
    } else if (c.mode === 'flee' && gx != null) {
      const dx = m.x - gx, dy = m.y - gy, dd = Math.hypot(dx, dy) || 1;
      // away from her, a little to the side it was already on
      const sx = -dy / dd * c.side, sy = dx / dd * c.side;
      tx = m.x + (dx / dd + sx * 0.35) * c.step;
      ty = m.y + (dy / dd + sy * 0.35) * c.step;
    } else if (c.mode === 'brain') {
      const p = window.__brain({ reach: 44, split: false, ...c.brain });
      if (p && p.x != null && !p.wait) e.input.mouse = { x: p.x, y: p.y, active: true };
      return;
    }
    if (tx == null) return;
    if (gx != null && (c.mode === 'slot' || c.mode === 'goto')) [tx, ty] = around(tx, ty, m.x, m.y, gx, gy, R * 1.6 + Math.sqrt(m.mass) * 10 + 60);
    if (c.mode === 'slot' || c.mode === 'goto') {
      // and clear of the other small coins (one 1.25 times the other's mass would eat it)
      const mr = Math.sqrt(m.mass) * 10, mine = w.myPid;
      for (const en of w.entities.values()) {
        if (en.kind !== 1 || en.playerId === mine || (hg && en.playerId === hg.pid) || en.dying) continue;
        const dx = m.x - en.x, dy = m.y - en.y, dd = Math.hypot(dx, dy) || 1, near = mr + en.r + 170;
        if (dd < near) { tx += (dx / dd) * (near - dd) * 2; ty += (dy / dd) * (near - dd) * 2; }
      }
    }
    const p = e.camera.toScreen(tx, ty);
    e.input.mouse = { x: p.x, y: p.y, active: true };
  }, 33);
}

const setCfg = (o, cfg) => o.ui((c) => { window.__esc.cfg = c; }, cfg).catch(() => {});
async function pushGoldie() {
  const g = { pid: hero.pid, wx: me.wx, wy: me.wy, vx: me.vx, vy: me.vy, t: Date.now() / 1000, R: radius(me.mass) };
  await Promise.all(others.map((o) => (o.dead ? null : o.ui((x) => { window.__esc.g = x; }, g).catch(() => {}))));
}
async function pollOthers() {
  await Promise.all(others.map(async (o) => {
    const s = await o.ui(() => window.__esc.state()).catch(() => null);
    if (!s) return;
    o.st = s;
    if (s.screen === 'playing' && s.wx != null) o.pos = { wx: s.wx, wy: s.wy, mass: s.mass };
    else if (s.screen !== 'playing') o.pos = null;
  }));
}

async function respawn(p) {
  // the death sheet needs a page of normal size (the others steer from a tiny one)
  const small = p !== hero && p.o.w < W;
  if (small) await p.page.setViewportSize({ width: W, height: H });
  let ok = false;
  for (let i = 0; i < 6 && !stop && !ok; i++) {
    if ((await p.screen().catch(() => null)) === 'playing') { ok = true; break; }
    await p.page.locator('.g-death .kb-btn--primary').click({ timeout: 4000 }).catch(() => {});
    ok = await p.page.waitForFunction(() => window.__elymum.useUi.getState().screen === 'playing', null, { timeout: 6000 }).then(() => true, () => false);
    if (!ok) await sleep(1000);
  }
  if (small) await p.page.setViewportSize({ width: p.o.w, height: p.o.h });
  if (!ok) log(`${p.o.name}: could not drop in again`);
  else p.pid = await p.ui(() => window.__elymum.useUi.getState().me?.pid).catch(() => p.pid);
  return ok;
}

/** One of the others back to the lobby and into the pond again (a fresh 20-mass coin, a new player id). */
async function dropInFreshOther(o) {
  log(`${o.o.name}: ${Math.round(o.pos?.mass ?? 0)}; drops in fresh`);
  o.busy = true;
  await setCfg(o, null);
  await o.page.setViewportSize({ width: W, height: H });
  o.o.w = W; o.o.h = H;
  await o.page.locator('button[aria-label="Leave to lobby"]').click({ timeout: 5000 });
  await o.page.waitForFunction(() => window.__elymum.useUi.getState().screen === 'lobby', null, { timeout: 10000 });
  await sleep(600);
  await o.practice();
  await o.page.setViewportSize({ width: 192, height: 120 });
  o.o.w = 192; o.o.h = 120;
  o.pid = await o.ui(() => window.__elymum.useUi.getState().me?.pid);
  o.pos = null;
  o.busy = false;
}

/** The others' housekeeping, every half second: drop in again when eaten, fresh when too heavy. */
async function keeper() {
  while (!stop) {
    await pollOthers();
    for (const o of others) {
      if (o.busy) continue;
      if (o.st && o.st.screen !== 'playing') {
        if (o.st.screen === 'lobby') continue;
        if (!o.dead) { o.dead = true; o.deadAt = Date.now(); }
        if (Date.now() - o.deadAt > 2500) {
          o.busy = true;
          respawn(o).then(() => { o.dead = false; o.busy = false; o.pos = null; }, () => { o.busy = false; });
        }
        continue;
      }
      o.dead = false;
      if (!o.pos || o.locked) continue;
      // (no fresh starts while a scene runs: the school keeps its coins; between scenes, any that would outgrow
      // the band during the next one starts fresh)
      // (relative caps only once she is big: while she regrows they would only churn)
      const big = me.mass >= HERO_MIN * 0.9;
      const cap = o.role === 'school' ? Math.min(ESC_MAX, big ? me.mass * 0.5 : ESC_MAX) : Math.min(PREY_MAX, big ? me.mass / 2.8 : PREY_MAX);
      if (!sceneOn && o.pos.mass > Math.max(cap * (o.role === 'school' ? 0.85 : 1), (o.role === 'school' ? ESC_MIN : PREY_MIN) * 1.6)) { dropInFreshOther(o).catch((e) => { o.busy = false; log(`${o.o.name}: reset failed ${e.message}`); }); continue; }
      // light ones graze (and keep near goldie); the school holds its spots between scenes too
      const min = o.role === 'school' ? ESC_MIN : PREY_MIN;
      // nobody grazes in coin rain or while goldie grows up again (the floor is rich: they would soon be too
      // heavy): sitting still, they only keep away from bigger coins
      const hold = raining || (o.role === 'school' && me.mass < HERO_MIN * 0.9);
      if (hold) {
        if (o.mode !== 'hold') { o.mode = 'hold'; await setCfg(o, { mode: 'brain', brain: { mode: 'still' } }); }
      } else if (o.pos.mass < min || (sceneOn && o.mode === 'graze')) {
        // (one that is still grazing when a scene starts grazes on, well clear of her frame, until it ends)
        const d = Math.hypot(o.pos.wx - me.wx, o.pos.wy - me.wy);
        const want = d > 2600 ? { mode: 'brain', brain: { mode: 'goto', wx: me.wx, wy: me.wy, noCells: true, margin: 1500, splitMargin: 0 } } : { mode: 'brain', brain: { mode: 'free', humans: 0, noCells: true, margin: 1500, splitMargin: 0 } };
        if (o.mode !== 'graze' || Date.now() - (o.cfgAt ?? 0) > 2000) { o.mode = 'graze'; o.cfgAt = Date.now(); await setCfg(o, want); }
      } else if (o.role === 'school' && o.mode !== 'slot') {
        o.mode = 'slot';
        await setCfg(o, slotCfg(o));
      } else if (o.role === 'prey' && (o.mode !== 'wait' || Date.now() - (o.cfgAt ?? 0) > 3000)) {
        // a prey waits off to one side of her course, outside her view
        o.mode = 'wait';
        o.cfgAt = Date.now();
        const a = (o.i ? 1 : -1) * 1.75, c = Math.cos(a), s = Math.sin(a);
        const dx = heading[0] * c - heading[1] * s, dy = heading[0] * s + heading[1] * c;
        await setCfg(o, { mode: 'goto', wx: clampW(me.wx + dx * 2400, 0), wy: clampW(me.wy + dy * 2400, 1) });
      }
    }
    await pushGoldie();
    await sleep(400);
  }
}

/** The pond's floor (world units: x0, y0, x1, y1; it grows with the number of players). */
let room = [0, 0, 6800, 6800];
const clampW = (v, k, m = 900) => Math.max(room[k] + m, Math.min(room[k + 2] - m, v));
const midX = () => (room[0] + room[2]) / 2, midY = () => (room[1] + room[3]) / 2;
let heading = [1, 0];
let swayT0 = Date.now() / 1000;
const drifts = SCHOOL.map(([name]) => {
  const r = rng(name.split('').reduce((s, c) => s * 31 + c.charCodeAt(0), 7));
  return [0.22 + 0.16 * r(), r() * 6.283, 0.06 + 0.07 * r(), r() * 6.283, 0.2 + 0.16 * r(), r() * 6.283, 0.05 + 0.07 * r(), r() * 6.283];
});
const slotCfg = (o, extra = {}) => ({ mode: 'slot', u: SLOTS[o.slot ?? o.i][0], v: SLOTS[o.slot ?? o.i][1], hx: heading[0], hy: heading[1], t0: swayT0, T: PERIOD, drift: drifts[o.i], flinch: null, ...extra });

/** goldie steers by `fn` until `until()` or `ms`; `fn` returns { ahead: [hx, hy] } | { intercept: pid } | brain options. */
async function heroFor(ms, fn, until) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    if (until && (await until())) return 'until';
    const o = typeof fn === 'function' ? fn() : fn;
    const p = o.intercept ? await hero.ui(([pid, reach]) => window.__intercept(pid, reach), [o.intercept, REACH])
      : o.ahead ? await hero.ui(([hx, hy, reach]) => window.__ahead(hx, hy, reach), [o.ahead[0], o.ahead[1], o.reach ?? REACH])
      : await hero.brain({ reach: REACH, ...o });
    if (p.dead) return 'dead';
    if (p.lost || p.wait || p.x == null) { await sleep(60); continue; }
    const now = Date.now();
    if (last && now - last.t > 30) { const k = 0.3; me.vx += ((p.wx - last.wx) / ((now - last.t) / 1000) - me.vx) * k; me.vy += ((p.wy - last.wy) / ((now - last.t) / 1000) - me.vy) * k; }
    last = { t: now, wx: p.wx, wy: p.wy };
    Object.assign(me, { wx: p.wx, wy: p.wy, mass: p.mass, t: now / 1000 });
    const x = Math.max(4, Math.min(W - 4, p.x)), y = Math.max(4, Math.min(H - 4, p.y));
    const nx = hero.cur.x + (x - hero.cur.x) * 0.5, ny = hero.cur.y + (y - hero.cur.y) * 0.5;
    await hero.page.mouse.move(nx, ny, { steps: 2 });
    hero.cur = { x: nx, y: ny };
    await sleep(40);
  }
  return 'time';
}
const forage = () => ({ mode: 'free', humans: 0, noCells: true, margin: 300, splitMargin: 0, split: false });
// (split: false: the kit's brain would otherwise point her at a small coin in reach, even when still)
const still = { mode: 'still', split: false };

/** Back to the lobby and into the pond again: a fresh 20-mass coin. */
async function dropInFresh() {
  rec.mark('reset', { mass: me.mass });
  await hero.click('button[aria-label="Leave to lobby"]', { pause: 0, before: 100, after: 200 });
  await hero.page.waitForFunction(() => window.__elymum.useUi.getState().screen === 'lobby', null, { timeout: 10000 });
  await hero.wait(800);
  await hero.practice();
  rec.mark('enter');
  hero.pid = await hero.ui(() => window.__elymum.useUi.getState().me?.pid);
  me.mass = 20;
}

/** Every cactus seen so far (the latest place of each; one she cannot see now may still be on her course). */
const cactusMap = new Map();
const cacti = () => [...cactusMap.values()];
/** A heading with room for the whole scene (no wall, no cactus on her path or at the prey's spot), or null. */
function pickHeading(len, spot) {
  const R = radius(me.mass);
  let best = null;
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const hx = Math.cos(a), hy = Math.sin(a);
    let ok = true;
    for (let s = 0; s <= len && ok; s += 100) {
      const x = me.wx + hx * s, y = me.wy + hy * s;
      if (x < room[0] + 1350 || y < room[1] + 1350 || x > room[2] - 1350 || y > room[3] - 1350) ok = false;
      for (const [cx, cy, cr] of cacti()) if (Math.hypot(cx - x, cy - y) < R * 1.4 + cr * 1.3 + 150) ok = false;
    }
    if (!ok) continue;
    const px = me.wx + hx * spot, py = me.wy + hy * spot;
    if (cacti().some(([cx, cy, cr]) => Math.hypot(cx - px, cy - py) < cr * 1.3 + 400)) continue;
    // the frame is wide: a course near the horizontal reads best (the prey then comes from the side, its name
    // tag clear of hers); a steep one only when nothing else has room
    const score = hx * hx + (Math.abs(hy) <= 0.45 ? 1 : 0);
    if (!best || score > best.score) best = { hx, hy, score };
  }
  return best;
}

try {
  await hero.open();
  await hero.ui(heroHelpers);
  for (const o of others) await o.open();
  rec = new Recorder(hero, NAME);
  await rec.start();
  await hero.practice();
  rec.mark('enter');
  hero.pid = await hero.ui(() => window.__elymum.useUi.getState().me?.pid);
  for (const o of others) {
    await o.ui(escHelpers);
    await o.practice();
    await o.page.setViewportSize({ width: 192, height: 120 });
    o.o.w = 192; o.o.h = 120;
    o.pid = await o.ui(() => window.__elymum.useUi.getState().me?.pid);
    log(`${o.o.name} in as ${o.pid}`);
  }
  const sampler = (async () => {
    while (!stop) {
      const s = await hero.ui(() => window.__tele()).catch(() => null);
      if (s) { tele.push(s); room = s.bounds; raining = !!s.rain; if (s.me) Object.assign(me, { wx: s.me[0], wy: s.me[1], mass: s.me[2] }); for (const c of s.cacti) cactusMap.set(`${Math.round(c[0] / 150)}:${Math.round(c[1] / 150)}`, c); }
      await sleep(100);
    }
  })();
  const keep = keeper();

  let scene = 0, lastLog = 0, preyTurn = 0;
  while (Date.now() - T0 < MINUTES * 60_000 && !existsSync(STOP)) {
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      log(`goldie ${Math.round(me.mass)}; ${others.map((o) => `${o.o.name} ${o.dead || !o.pos ? '-' : Math.round(o.pos.mass)}${o.mode ? `/${o.mode}` : ''}`).join(', ')}`);
    }
    if ((await hero.screen()) !== 'playing') { rec.mark('hero-died'); await sleep(2500); await respawn(hero); continue; }
    if (raining) { await heroFor(1000, still); continue; }
    if (me.mass > HERO_MAX) { await dropInFresh(); continue; }
    if (me.mass < HERO_MIN) {
      const p0 = [me.wx, me.wy];
      await heroFor(1500, forage);
      // stalled (food next to a cactus she must not touch): off toward the middle of the pond for a while
      if (Math.hypot(me.wx - p0[0], me.wy - p0[1]) < 200) await heroFor(2500, { mode: 'goto', wx: midX() + (Math.random() - 0.5) * 2400, wy: midY() + (Math.random() - 0.5) * 2400, noFood: true, split: false });
      continue;
    }
    const R = radius(me.mass), v = speedOf(me.mass);
    const spot = v * LEAD + SPOT_R * R;
    const need = spot + v * 7.5 + 400;
    const h = pickHeading(need, spot);
    if (!h) {
      // no room: swim toward the middle of the pond for a while
      const cx = midX(), cy = midY(), d = Math.hypot(cx - me.wx, cy - me.wy) || 1;
      await heroFor(2500, { ahead: [(cx - me.wx) / d, (cy - me.wy) / d] });
      continue;
    }
    const prey = [...preys].sort((a, b) => (a.i === preyTurn % 2 ? -1 : 1) - (b.i === preyTurn % 2 ? -1 : 1)).find((o) => !o.dead && !o.busy && o.pos && o.pos.mass >= PREY_MIN * 0.9 && o.pos.mass <= me.mass / 2.6);
    const ready = school.filter((o) => !o.dead && !o.busy && o.pos && o.mode === 'slot');
    if (!prey || ready.length < 5) { await heroFor(1000, still); continue; }
    scene++;
    preyTurn++;
    // staging: she waits facing the new heading, the school takes its spots around her, the prey goes to its spot
    heading = [h.hx, h.hy];
    swayT0 = Date.now() / 1000;
    // each spot to the nearest coin of the school still free (a new heading moves the spots: nobody crosses the
    // whole school to reach one)
    const spotAt = (k) => [me.wx + R * (SLOTS[k][0] * h.hx + SLOTS[k][1] * h.hy), me.wy + R * (SLOTS[k][0] * h.hy - SLOTS[k][1] * h.hx)];
    const free = new Set(school);
    for (const k of SLOTS.map((_, k) => k).sort((x, y) => Math.hypot(...SLOTS[y]) - Math.hypot(...SLOTS[x]))) {
      let bestO = null, bestD = Infinity;
      for (const o of free) { if (!o.pos) continue; const [tx, ty] = spotAt(k); const d = Math.hypot(o.pos.wx - tx, o.pos.wy - ty); if (d < bestD) { bestD = d; bestO = o; } }
      if (bestO) { bestO.slot = k; free.delete(bestO); }
    }
    for (const o of free) o.slot = o.i;
    for (const o of school) if (o.mode === 'slot') await setCfg(o, slotCfg(o));
    const sx = me.wx + h.hx * spot + R * 0.25 * h.hy, sy = me.wy + h.hy * spot - R * 0.25 * h.hx;
    prey.locked = true;
    await setCfg(prey, { mode: 'goto', wx: sx, wy: sy });
    rec.mark('stage', { n: scene });
    const onSpot = (o) => { if (!o.pos || o.dead || o.mode !== 'slot') return false; const [tx, ty] = spotAt(o.slot); return Math.hypot(o.pos.wx - tx, o.pos.wy - ty) < R * 0.9; };
    // all of the school on its spots, or six after a while (the rest graze clear of her frame through the scene)
    const t0s = Date.now();
    const settled = () => { const n = school.filter(onSpot).length; return n >= ready.length || (n >= 6 && Date.now() - t0s > 8000); };
    const res0 = await heroFor(32000, still, async () => raining || (prey.pos && Math.hypot(prey.pos.wx - sx, prey.pos.wy - sy) < 140 && settled()));
    if (res0 !== 'until' || raining || prey.dead || !prey.pos || ready.some((o) => o.pos && o.pos.mass > Math.min(ESC_MAX, me.mass * 0.5))) {
      const off = ready.filter((o) => o.pos && !o.dead).map((o) => { const [tx, ty] = spotAt(o.slot); return `${o.o.name} ${Math.round(Math.hypot(o.pos.wx - tx, o.pos.wy - ty))}`; });
      log(`scene ${scene}: staging failed (${res0}${raining ? ', rain' : ''}); prey ${prey.pos ? Math.round(Math.hypot(prey.pos.wx - sx, prey.pos.wy - sy)) : '-'} from its spot; school off its spots: ${off.join(', ')}`); prey.locked = false; prey.mode = null; continue; }
    await setCfg(prey, { mode: 'dawdle', wx: sx, wy: sy, rad: 45, per: 3.4 });
    sceneOn = true;
    const inSchool = school.filter(onSpot);
    for (const o of school) if (!inSchool.includes(o) && o.pos && !o.dead && !o.busy) { o.mode = 'graze'; o.cfgAt = Date.now(); await setCfg(o, { mode: 'brain', brain: { mode: 'free', humans: 0, noCells: true, margin: 1500, splitMargin: 0 } }); }
    // the cruise: her course sways on the period, the school drifts on it
    const t0 = Date.now() / 1000;
    rec.mark('cruise', { n: scene, t0: +(t0 - rec.t0).toFixed(3), sway0: +(swayT0 - rec.t0).toFixed(3), period: PERIOD, heading, prey: prey.o.name, preyPid: prey.pid, preyMass: Math.round(prey.pos.mass), heroMass: Math.round(me.mass), school: inSchool.map((o) => o.pid) });
    log(`scene ${scene}: heading ${h.hx.toFixed(2)},${h.hy.toFixed(2)}; ${prey.o.name} (${Math.round(prey.pos.mass)}) -> goldie (${Math.round(me.mass)}); school ${inSchool.length}`);
    const sway = () => { const a = SWAY * Math.sin((2 * Math.PI * (Date.now() / 1000 - swayT0)) / PERIOD); const c = Math.cos(a), s = Math.sin(a); return [heading[0] * c - heading[1] * s, heading[0] * s + heading[1] * c]; };
    let eaten = null, fleeing = false;
    const dist = () => (prey.pos ? Math.hypot(prey.pos.wx - me.wx, prey.pos.wy - me.wy) : Infinity);
    // up to the prey: cruise, then cut it off when it is close
    const r1 = await heroFor(LEAD * 1000 + 9000, () => (dist() < R * 2.6 ? { intercept: prey.pid } : { ahead: sway() }), async () => {
      if (!fleeing && dist() < R * 2.3) { fleeing = true; await setCfg(prey, { mode: 'flee', step: 16, side: 1 }); }
      if (prey.dead || (prey.st && prey.st.screen !== 'playing')) { eaten = Date.now() / 1000; return true; }
      // a faster read than the keeper's poll near the end
      if (dist() < R * 1.6) { const s = await prey.ui(() => window.__esc.state()).catch(() => null); if (s && s.screen !== 'playing') { prey.dead = true; prey.deadAt = Date.now(); eaten = Date.now() / 1000; return true; } }
      return false;
    });
    if (!eaten) { rec.mark('missed', { n: scene, res: r1 }); log(`scene ${scene}: missed (${r1})`); prey.locked = false; prey.mode = null; sceneOn = false; continue; }
    rec.mark('gulp', { n: scene, at: [Math.round(prey.pos?.wx ?? me.wx), Math.round(prey.pos?.wy ?? me.wy)] });
    // the school flinches away from the gulp and settles again
    const gx = prey.pos?.wx ?? me.wx, gy = prey.pos?.wy ?? me.wy;
    for (const o of school) if (o.mode === 'slot') setCfg(o, slotCfg(o, { flinch: { t: Date.now() / 1000, x: gx, y: gy, dur: 2.2, amp: 0.7, reach: 4.5 } }));
    prey.locked = false;
    prey.mode = null;
    prey.pos = null;
    log(`scene ${scene}: ${prey.o.name} eaten; goldie ${Math.round(me.mass)}`);
    // on along the course past the end of the loop
    await heroFor(6500, () => ({ ahead: sway() }));
    rec.mark('cruise-end', { n: scene });
    sceneOn = false;
  }
  rec.mark('end');
  stop = true;
  await sampler;
  await keep.catch(() => {});
} catch (e) {
  log('ERROR', e.stack || e.message);
  rec?.mark('error', { msg: e.message });
} finally {
  stop = true;
  if (rec) {
    await rec.stop().catch((e) => log('stop failed', e.message));
    writeFileSync(resolve(TAKES, NAME, 'tele.json'), JSON.stringify(tele.map((s) => ({ ...s, t: +(s.t - rec.t0).toFixed(3) }))));
  }
  for (const o of others) await o.close();
  await hero.close();
  await browser.close();
  log('done', ((Date.now() - T0) / 1000).toFixed(0), 's');
}
