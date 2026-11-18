#!/usr/bin/env node
// Take "hero": the raw play for the landing page's hero loop, recorded as a journal (see
// media/gameplay/README.md, "Deterministic capture"). A practice pond of the dev stack (the same arena
// floor and renderer as the paid rooms, people only, no bots): goldie (the recorded page) and four other
// players (small silent browsers, no drawing).
//
// The others graze up to a modest size and then sit still, away from goldie and from each other (one that
// grows too heavy on the way leaves and drops in fresh). Again
// and again ("scenes") goldie waits, one of the others (or two side by side) swims across her side of the
// pond, she leaves her spot to cut it off, eats it and swims on out of the way; the second one bolts. Waiting and sitting still keep everyone from
// grazing up too fast; when she gets too heavy anyway she leaves to the lobby and drops in fresh.
// Every scene is a candidate for the loop; plan.mjs picks one afterwards.
//
// Besides the journal the take writes `tele.json`: 10 times a second, every coin and cactus goldie's page
// knows about (world units) and the server's view, so the loop's frame can be planned in world space.
// The page is small (640x400 CSS px): the replay renders it at 3x, so outlines and name tags keep a size
// that reads when the loop plays small on the landing page.
//
//   COINNIBAL_URL=http://127.0.0.1:5312/play node media/hero-loop/take.mjs [--name hero] [--minutes 7]
// `touch media/gameplay/cache/takes/<name>.stop` ends the take early (it still saves).
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE, Player, Recorder, TAKES, launch, log, sleep } from '../gameplay/capture/lib.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const NAME = opt('--name', 'hero');
const MINUTES = Number(opt('--minutes', '7'));
/** The others graze up to this mass, so the coin she eats reads clearly next to her. */
const PREY_MASS = Number(opt('--prey-mass', '40'));
/** Scenes run while she weighs HERO_MIN..HERO_MAX; past that she drops in fresh. */
const HERO_MIN = Number(opt('--hero-min', '200'));
const HERO_MAX = Number(opt('--hero-max', '380'));
/** She leaves her spot when the other one is this close (world units): they meet well away from it. */
const GO_AT = Number(opt('--go-at', '1900'));
/** Pairs: two swim across together, she eats one and the other bolts. */
const PAIR = opt('--pair', '1') === '1';
const W = 640, H = 400;
/** Mouse distance from her coin when steering (CSS px; the page is small). */
const REACH = 170;
const STOP = resolve(TAKES, `${NAME}.stop`);
const T0 = Date.now();

const common = { audio: 'off', minimap: false, theme: 'light', settings: { country: '', countryAuto: false, showChat: false, showEmotes: false } };
const browser = await launch();
const hero = new Player(browser, { name: 'goldie', skin: 1, w: W, h: H, quality: 'high', ...common, journal: resolve(CACHE, `journal-${NAME}.jsonl`) });
// skins with a neutral face mark only (heart, drop, gem, bolt; goldie's star): no $ or cent coin on the landing page
const others = [['nori', 4], ['pip', 5], ['mochi', 7], ['lulu', 6, true]].map(([name, skin, mateOnly]) => new Player(browser, { name, skin, mateOnly, w: W, h: H, quality: 'low', tick: 80, noDraw: true, fast: true, ...common }));

let stop = false;
const me = { wx: 3400, wy: 3400, big: 30, mass: 0, vx: 0, vy: 0 };
const plan = new Map();
const tele = [];
let rec;

/** In-page helpers for goldie: telemetry and the intercept steer. */
function heroHelpers() {
  window.__tele = () => {
    const S = window.__elymum;
    const w = S?.engine?.world;
    if (!w) return null;
    const m = w.myStats();
    const cells = [];
    const cacti = [];
    for (const e of w.entities.values()) {
      if (e.kind === 1) cells.push([e.id, e.playerId, Math.round(e.x), Math.round(e.y), Math.round(e.r), e.dying ? 1 : 0]);
      else if (e.kind === 4) cacti.push([Math.round(e.x), Math.round(e.y), Math.round(e.r)]);
    }
    return { t: Date.now() / 1000, screen: S.useUi.getState().screen, pid: w.myPid, me: m ? [Math.round(m.x), Math.round(m.y), Math.round(m.mass)] : null, view: [Math.round(w.serverView.x), Math.round(w.serverView.y), Math.round(w.serverView.h)], world: [w.width, w.height], cells, cacti };
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
    // smallest t > 0 with |d + v t| = sp t
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
  // a new coin is a new player id
  else p.pid = await p.ui(() => window.__elymum.useUi.getState().me?.pid).catch(() => p.pid);
  return ok;
}

/**
 * The others: graze up to PREY_MASS (fleeing anything bigger with a wide margin), then wait on a ring about
 * 2700 units around goldie (outside her view, close enough for a scene) and sit still there; they move off
 * when she comes within 2100 (out of her frame, and nobody grows by eating someone).
 */
const graze = (o) => () => {
  const m = o.pos?.mass ?? 0;
  if (!o.pos || m < PREY_MASS) return { mode: 'free', humans: 0, noCells: true, margin: 1100, splitMargin: 0 };
  const dx = o.pos.wx - me.wx, dy = o.pos.wy - me.wy, d = Math.hypot(dx, dy) || 1;
  if (d < 2100) return { mode: 'free', humans: 0, noCells: true, noFood: true, margin: 1700, splitMargin: 0 };
  if (d > 3300) return { mode: 'goto', wx: me.wx + (dx / d) * 2700, wy: me.wy + (dy / d) * 2700, noFood: true, noCells: true, margin: 1700, splitMargin: 0 };
  return { mode: 'still' };
};

async function otherLoop(o) {
  while (!stop) {
    const f = plan.get(o) ?? graze(o);
    const p = await o.brain({ reach: 44, split: false, ...f() }).catch(() => ({ wait: true }));
    if (p.dead) {
      o.dead = true;
      plan.delete(o);
      if (stop) return;
      await sleep(2500);
      await respawn(o);
      o.dead = false;
      o.pos = null;
      continue;
    }
    if (!p.wait) {
      o.pos = { wx: p.wx, wy: p.wy, big: p.big, mass: p.mass };
      await o.page.mouse.move(Math.max(4, Math.min(o.o.w - 4, p.x)), Math.max(4, Math.min(o.o.h - 4, p.y))).catch(() => {});
      // the floor is rich: grazing on the way puts on mass; one that got too heavy drops in fresh (tipping mass
      // off with E would leave blobs on the floor that look like a glitch on camera)
      if (!o.crossing && !plan.has(o) && p.mass > PREY_MASS * 2.2) await dropInFreshOther(o).catch((e) => log(`${o.o.name}: reset failed ${e.message}`));
    }
    await sleep(o.o.tick);
  }
}

/** One of the others back to the lobby and into the pond again (a fresh 20-mass coin, a new player id). */
async function dropInFreshOther(o) {
  log(`${o.o.name}: too heavy (${Math.round(o.pos.mass)}); drops in fresh`);
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
}

/** goldie steers by `fn` (brain options, or { intercept: pid }) until `until()` or `ms`. */
async function heroFor(ms, fn, until) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    if (until && (await until())) return 'until';
    const o = typeof fn === 'function' ? fn() : fn;
    const p = o.intercept ? await hero.ui(([pid, reach]) => window.__intercept(pid, reach), [o.intercept, REACH]) : await hero.brain({ reach: REACH, ...o });
    if (p.dead) return 'dead';
    if (p.lost || p.wait || p.x == null) { await sleep(100); continue; }
    const now = Date.now();
    if (last && now - last.t > 30) { const k = 0.3; me.vx += ((p.wx - last.wx) / ((now - last.t) / 1000) - me.vx) * k; me.vy += ((p.wy - last.wy) / ((now - last.t) / 1000) - me.vy) * k; }
    last = { t: now, wx: p.wx, wy: p.wy };
    Object.assign(me, { wx: p.wx, wy: p.wy, big: p.big ?? me.big, mass: p.mass });
    const x = Math.max(20, Math.min(W - 20, p.x)), y = Math.max(20, Math.min(H - 20, p.y));
    const nx = hero.cur.x + (x - hero.cur.x) * 0.5, ny = hero.cur.y + (y - hero.cur.y) * 0.5;
    await hero.page.mouse.move(nx, ny, { steps: 2 });
    hero.cur = { x: nx, y: ny };
    await sleep(50);
  }
  return 'time';
}
const forage = () => ({ mode: 'free', humans: 0, noCells: true, margin: 300, splitMargin: 0, split: false });
const still = { mode: 'still' };

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

try {
  await hero.open();
  await hero.ui(heroHelpers);
  for (const o of others) await o.open();
  rec = new Recorder(hero, NAME);
  await rec.start();
  await hero.practice();
  rec.mark('enter');
  for (const o of others) {
    await o.practice();
    await o.page.setViewportSize({ width: 192, height: 120 });
    o.o.w = 192; o.o.h = 120;
    o.pid = await o.ui(() => window.__elymum.useUi.getState().me?.pid);
    log(`${o.o.name} in as ${o.pid}`);
  }
  const loops = others.map((o) => otherLoop(o));
  const sampler = (async () => { while (!stop) { const s = await hero.ui(() => window.__tele()).catch(() => null); if (s) tele.push(s); await sleep(100); } })();
  const room = await hero.ui(() => { const w = window.__elymum.engine.world; return [w.width, w.height]; });
  const inside = (v, L, m = 1100) => Math.max(m, Math.min(L - m, v));

  let scene = 0, lastLog = 0;
  while (Date.now() - T0 < MINUTES * 60_000 && !existsSync(STOP)) {
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      log(`goldie ${Math.round(me.mass)}; others ${others.map((o) => (o.dead || !o.pos ? `${o.o.name} -` : `${o.o.name} ${Math.round(o.pos.mass)} @${Math.round(Math.hypot(o.pos.wx - me.wx, o.pos.wy - me.wy))}`)).join(', ')}`);
    }
    if ((await hero.screen()) !== 'playing') { rec.mark('hero-died'); await sleep(2500); await respawn(hero); continue; }
    if (me.mass > HERO_MAX) { await dropInFresh(); continue; }
    if (me.mass < HERO_MIN) { await heroFor(1500, forage); continue; }
    const ready = others.filter((o) => !o.dead && o.pos && o.pos.mass >= PREY_MASS * 0.85 && o.pos.mass <= me.mass / 3.5 && Math.hypot(o.pos.wx - me.wx, o.pos.wy - me.wy) < 3800);
    // waiting: still, away from the walls
    const edge = Math.min(me.wx, me.wy, room[0] - me.wx, room[1] - me.wy);
    if (!ready.length) { await heroFor(1000, edge < 1300 ? { mode: 'goto', wx: room[0] / 2, wy: room[1] / 2, noFood: true } : still); continue; }
    // the one she eats should not be gold like her (lulu, the yellow bolt coin, only ever swims alongside)
    const prey = ready.filter((o) => !o.o.mateOnly).sort((a, b) => Math.hypot(a.pos.wx - me.wx, a.pos.wy - me.wy) - Math.hypot(b.pos.wx - me.wx, b.pos.wy - me.wy))[0];
    if (!prey) { await heroFor(1000, still); continue; }
    scene++;
    // a pair when two are ready (PAIR): they gather off to one side first, then swim across side by side
    const mate = PAIR ? ready.filter((o) => o !== prey).sort((a, b) => Math.hypot(a.pos.wx - prey.pos.wx, a.pos.wy - prey.pos.wy) - Math.hypot(b.pos.wx - prey.pos.wx, b.pos.wy - prey.pos.wy))[0] : null;
    // the line passes `side` units beside her spot and runs on far past it
    let ux0 = me.wx - prey.pos.wx, uy0 = me.wy - prey.pos.wy, un = Math.hypot(ux0, uy0) || 1;
    const side = (scene % 2 ? 1 : -1) * (150 + (scene % 3) * 120);
    if (mate) {
      // side by side across the line of approach, the mate on the outer side (away from her spot)
      const stage = { wx: inside(me.wx - (ux0 / un) * 2500, room[0], 700), wy: inside(me.wy - (uy0 / un) * 2500, room[1], 700) };
      const sx = (-uy0 / un) * Math.sign(side), sy = (ux0 / un) * Math.sign(side);
      const spot = (k) => ({ wx: stage.wx + sx * k * 190, wy: stage.wy + sy * k * 190 });
      const dn = (o, k) => !o.pos || o.dead || Math.hypot(o.pos.wx - spot(k).wx, o.pos.wy - spot(k).wy) < 200;
      rec.mark('gather', { n: scene });
      for (const [o, k] of [[prey, -1], [mate, 1]]) plan.set(o, () => ({ mode: 'goto', ...spot(k), margin: 1700, splitMargin: 0, noFood: true, noCells: true }));
      // gathered, and still light enough next to her
      const light = (o) => o.pos && o.pos.mass <= Math.min(PREY_MASS * 2.2, me.mass / 3.5);
      await heroFor(22000, still, async () => dn(prey, -1) && dn(mate, 1) && light(prey) && light(mate));
      if (prey.dead || mate.dead || !light(prey) || !light(mate)) { log(`scene ${scene}: the pair is not ready; skipped`); plan.delete(prey); plan.delete(mate); continue; }
      ux0 = me.wx - prey.pos.wx; uy0 = me.wy - prey.pos.wy; un = Math.hypot(ux0, uy0) || 1;
    }
    const ux = ux0 / un, uy = uy0 / un;
    const line = (off) => ({ wx: inside(me.wx - uy * off + ux * 2200, room[0], 700), wy: inside(me.wy + ux * off + uy * 2200, room[1], 700) });
    const goal = line(side);
    rec.mark('scene', { n: scene, prey: prey.o.name, pid: prey.pid, mate: mate?.pid ?? null, heroMass: me.mass, preyMass: prey.pos.mass });
    log(`scene ${scene}: ${prey.o.name} (${prey.pos.mass})${mate ? ` + ${mate.o.name} (${mate.pos.mass})` : ''} -> goldie (${me.mass}), side ${side}`);
    plan.set(prey, () => ({ mode: 'goto', wx: goal.wx, wy: goal.wy, margin: -400, splitMargin: 0, noFood: true, noCells: true }));
    prey.crossing = true;
    if (mate) mate.crossing = true;
    if (mate) {
      // the mate keeps a slot beside its friend (further from her, a little ahead); once its friend is eaten it
      // bolts away from her
      const gx = goal.wx - prey.pos.wx, gy = goal.wy - prey.pos.wy, gn = Math.hypot(gx, gy) || 1;
      const fx = gx / gn, fy = gy / gn, nx = -fy * Math.sign(side), ny = fx * Math.sign(side);
      plan.set(mate, () => (prey.dead || !prey.pos
        ? { mode: 'free', humans: 0, noFood: true, noCells: true, margin: 1600, splitMargin: 0 }
        : { mode: 'goto', wx: prey.pos.wx + nx * 300 + fx * 260, wy: prey.pos.wy + ny * 300 + fy * 260, margin: -400, splitMargin: 0, noFood: true, noCells: true }));
    }
    await heroFor(14000, still, async () => !prey.pos || prey.dead || Math.hypot(prey.pos.wx - me.wx, prey.pos.wy - me.wy) < GO_AT);
    rec.mark('go', { n: scene });
    const res = await heroFor(9000, { intercept: prey.pid }, async () => prey.dead);
    rec.mark(prey.dead ? 'gulp' : 'missed', { n: scene, res });
    log(`scene ${scene}: ${prey.o.name} ${prey.dead ? 'eaten' : 'missed'} (${res}); goldie ${Math.round(me.mass)}`);
    plan.delete(prey);
    prey.crossing = false;
    if (mate) setTimeout(() => { plan.delete(mate); mate.crossing = false; }, 6000);
    // she swims on the way she was going, out of the frame, then waits again
    const vn = Math.hypot(me.vx, me.vy) || 1;
    const on = { wx: inside(me.wx + (me.vx / vn) * 1800, room[0]), wy: inside(me.wy + (me.vy / vn) * 1800, room[1]) };
    await heroFor(4500, { mode: 'goto', wx: on.wx, wy: on.wy, noFood: true, margin: 300 }, async () => Math.hypot(on.wx - me.wx, on.wy - me.wy) < 150);
    rec.mark('rest', { n: scene });
  }
  rec.mark('end');
  stop = true;
  await sampler;
  await Promise.all(loops).catch(() => {});
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
