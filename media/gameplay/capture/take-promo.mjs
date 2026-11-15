#!/usr/bin/env node
// Take "promo": the Coinnibal launch film's gameplay, in the $1 Room (a paid room: real wallets with real
// fake-chain tickets, no bots). Goldie (recorded as a journal, 1920x1080) plays with staged rivals played
// from tiny browsers. Rounds are wall-clock aligned, so the script waits for a fresh round:
//   0. a round opens: five rivals buy in; "chomper" forages hard and grows big;
//   1. Goldie buys a ticket and drops in small; chomper comes at her and she runs (mark `chase`);
//   2. chomper leaves; she forages and grows;
//   3. rival 1 runs into her: eaten head-on, its whole ticket value is hers (marks `hunt1` / `ate1`);
//   4. rival 2 comes close and turns to run: she splits onto it (marks `hunt2` / `split` / `ate2`);
//   5. rival 3 is eaten the same way (`ate3`); then free play until `--stop` seconds before the bell.
// If Goldie is eaten she buys back in from the death sheet and the beat is tried again.
//   node media/gameplay/capture/take-promo.mjs [--name promo] [--arena 1] [--grow 95] [--stop 70]
// Needs the dev stack with the game open to everyone (GAME_ACCESS=public DEV_FAKE_CHAIN=1 DEV_FAKE_TOKEN=1)
// and COINNIBAL_URL pointing at its /play page.
import { resolve } from 'node:path';
import { CACHE, Player, Recorder, launch, log, sleep } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const NAME = opt('--name', 'promo');
const ARENA = Number(opt('--arena', '1'));
const GROW = Number(opt('--grow', '95'));
const RIVAL_MASS = Number(opt('--rival-mass', '40'));
const BIG_MASS = Number(opt('--big-mass', '260'));
/** Seconds into the round at which Goldie's recording starts. */
const JOIN_AT = Number(opt('--join-at', '55'));
/** Stop this many seconds before the bell. */
const STOP_S = Number(opt('--stop', '70'));
const T0 = Date.now();

const browser = await launch();
const rivalOpts = { w: 1280, h: 720, audio: 'off', quality: 'low', minimap: false, tick: 90, fast: true };
const rivals = [
  { name: 'mochi_moon', skin: 0 },
  { name: 'bonk_bae', skin: 6 },
  { name: 'lil_wei', skin: 5 },
  { name: 'pixel_penny', skin: 3 },
].map((r) => new Player(browser, { ...r, ...rivalOpts }));
const chomper = new Player(browser, { name: 'big_chungus', skin: 2, ...rivalOpts });
const all = [...rivals, chomper];
const hero = new Player(browser, { name: 'goldie', skin: 1, keyPath: resolve(CACHE, 'keys/goldie.key'), audio: 'off', journal: resolve(CACHE, `journal-${NAME}.jsonl`) });

let stopAll = false;
const heroPos = { wx: 3200, wy: 3200, big: 30, mass: 0 };
const plan = new Map();
const pidOf = (p) => p.ui(() => window.__elymum.useUi.getState().me?.pid);
const distTo = (r) => (r.pos && !r.dead ? Math.hypot(r.pos.wx - heroPos.wx, r.pos.wy - heroPos.wy) : Infinity);
const leftS = async () => ((await hero.round(ARENA))?.left ?? 0) / 1000;
let rec;

async function enter(r, held = false) {
  for (let i = 0; ; i++) {
    try { r.state = await r.buyTicket(ARENA, { signDelay: 150, held }); break; } catch (e) {
      await r.page.screenshot({ path: resolve(CACHE, `debug-enter-${r.o.name}-${i}.png`) }).catch(() => {});
      if (i >= 3) throw e;
      log(`${r.o.name}: buy failed (${e.message.split('\n')[0]}); again`);
      await r.page.keyboard.press('Escape').catch(() => {});
      await sleep(1500 + i * 1000);
    }
  }
  r.dead = false;
  r.pos = null;
  log(`${r.o.name}: ${r.state || 'playing'}`);
}
/** Once a rival plays: a tiny window (costs almost nothing to draw) and its pid. */
async function settle(r) {
  await r.page.waitForFunction(() => window.__elymum.useUi.getState().screen === 'playing', null, { timeout: 120000 });
  await r.page.setViewportSize({ width: 192, height: 108 });
  r.o.w = 192; r.o.h = 108;
  r.pid = await pidOf(r);
  log(`${r.o.name} in as ${r.pid}`);
}
async function buyBack(p, o = {}) {
  await p.page.waitForSelector('.g-death .kb-btn--primary', { timeout: 8000 });
  await p.wait(o.pause ?? 400);
  await p.click('.g-death .kb-btn--primary', { before: o.before ?? 200 });
  await p.page.waitForFunction(() => window.__elymum.useUi.getState().screen === 'lobby', null, { timeout: 10000 }).catch(() => {});
  await p.page.waitForFunction(() => !!document.querySelector('.tf-sheet') || !document.querySelector('.kl-cta')?.disabled, null, { timeout: 25000 }).catch(() => {});
}
async function rivalLoop(r) {
  while (!stopAll) {
    const f = plan.get(r);
    const o = f ? f() : { mode: 'free', noFood: (r.pos?.mass ?? 0) >= RIVAL_MASS, noCells: true, margin: 320 };
    const p = await r.brain({ reach: 44, ...o }).catch(() => ({ wait: true }));
    if (p.dead) {
      r.dead = true;
      if (r.eaten || stopAll || p.screen === 'roundover') return;
      log(`${r.o.name} lost early; buys back in`);
      await sleep(2500);
      try { await r.page.setViewportSize({ width: 1280, height: 720 }); r.o.w = 1280; r.o.h = 720; await buyBack(r); await enter(r); await settle(r); } catch (e) { log('rebuy failed', e.message); await sleep(2000); }
      continue;
    }
    if (!p.wait) {
      r.pos = { wx: p.wx, wy: p.wy, big: p.big, value: p.value, mass: p.mass };
      await r.page.mouse.move(Math.max(4, Math.min(r.o.w - 4, p.x)), Math.max(4, Math.min(r.o.h - 4, p.y))).catch(() => {});
    }
    await sleep(r.o.tick);
  }
}
const bait = (r) => () => (distTo(r) < 650
  ? { mode: 'bait', pid: hero.pid, wx: heroPos.wx, wy: heroPos.wy, noFood: true, noCells: true, margin: -300, splitMargin: 0 }
  : { mode: 'bait', pid: hero.pid, wx: heroPos.wx, wy: heroPos.wy, noFood: true, noCells: true, margin: 40, splitMargin: 120 });
const run = () => ({ mode: 'free', noFood: true, noCells: true, margin: 700, splitMargin: 0 });
const goTo = (r) => ({ mode: 'goto', wx: r.pos?.wx ?? heroPos.wx, wy: r.pos?.wy ?? heroPos.wy, margin: 120, splitMargin: 200 });

class Died extends Error {}
class Late extends Error {}
async function heroWhile(ms, o, cond, { late = true } = {}) {
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < ms) {
    if (cond && !(await cond())) return 'cond';
    if (late && (await leftS()) < STOP_S) throw new Late('time');
    const oo = typeof o === 'function' ? await o() : o;
    const p = await hero.brain(oo);
    if (p.dead) { if (p.screen === 'roundover') return 'roundover'; throw new Died('Goldie died'); }
    if (!p.wait) {
      Object.assign(heroPos, { wx: p.wx, wy: p.wy, big: p.big, mass: p.mass });
      const x = Math.max(40, Math.min(1880, p.x)), y = Math.max(40, Math.min(1040, p.y));
      const nx = hero.cur.x + (x - hero.cur.x) * 0.5, ny = hero.cur.y + (y - hero.cur.y) * 0.5;
      await hero.page.mouse.move(nx, ny, { steps: 2 });
      hero.cur = { x: nx, y: ny };
    }
    if (Date.now() - lastLog > 4000) { lastLog = Date.now(); log('left', (await leftS()).toFixed(0), 'mass', p.mass, 'value', p.value, 'dist', all.map((r) => (r.dead ? 'x' : Math.round(distTo(r)))).join(' ')); }
    await sleep(55);
  }
  return 'time';
}
const forage = () => ({ mode: 'free', humans: 0, margin: 480, splitMargin: 520, avoidPids: all.filter((r) => !r.eaten).map((r) => r.pid) });
async function beat(name, fn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { rec.mark(name); return await fn(); } catch (e) {
      if (!(e instanceof Died)) throw e;
      rec.mark('died', { beat: name });
      log(`Goldie died during ${name}; buys back in`);
      await hero.wait(2500);
      rec.mark('buyback');
      await buyBack(hero, { pause: 600, before: 300 });
      await hero.buyTicket(ARENA, { signDelay: 400 });
      rec.mark('reenter');
      await heroWhile(60_000, forage, async () => heroPos.mass < GROW);
    }
  }
  throw new Error(`beat ${name} failed`);
}
const screenOf = (pos) => hero.ui((q) => window.__elymum.engine.camera.toScreen(q.wx, q.wy), pos);

/** A rival is baited onto Goldie and eaten; with `split` she splits onto it as it turns to run. */
async function hunt(r, split, tag) {
  plan.set(r, bait(r));
  let fled = !split, didSplit = 0;
  await heroWhile(45_000, async () => {
    const d = distTo(r);
    if (!fled && d < heroPos.big * 2.2 + 460) { fled = true; plan.set(r, run); rec.mark(`${tag}flees`); }
    if (split && fled && !didSplit && d < heroPos.big * 2.0 + 300 && r.pos) {
      const s = await screenOf(r.pos);
      await hero.page.mouse.move(s.x, s.y);
      hero.cur = { x: s.x, y: s.y };
      await sleep(40);
      await hero.key('Space');
      didSplit = Date.now();
      rec.mark('split');
    }
    return d < 1000 ? { mode: 'hunt', pid: r.pid, split: false, margin: 200, splitMargin: 120 } : goTo(r);
  }, async () => !r.dead);
  r.eaten = true;
}

try {
  for (const p of [hero, ...all]) { await p.open(); await p.login(); }
  // the rivals buy in while joins are closed (the final minute or the break): their tickets are held and
  // they all drop in the moment the next round opens; the big coin then has a minute to grow
  let r0 = await hero.round(ARENA);
  log('round left', (r0?.left / 1000).toFixed(0), 's', r0?.phase);
  if (r0.phase !== 'closing') {
    log('waiting for joins to close');
    await hero.untilRound((r) => r.phase === 'closing' && r.left > 15_000, 400_000, ARENA);
  }
  for (const r of all) await enter(r, true);
  await hero.untilRound((r) => r.phase === 'open' && r.left > 280_000, 200_000, ARENA);
  for (const r of all) await settle(r);
  plan.set(chomper, () => ({ mode: 'free', noFood: (chomper.pos?.mass ?? 0) >= BIG_MASS, margin: 200, loot: 2 }));
  const loops = all.map((r) => rivalLoop(r));
  await hero.untilRound((r) => r.left < (300 - JOIN_AT) * 1000, 300_000, ARENA);
  log('chomper mass', chomper.pos?.mass, 'rivals', rivals.map((r) => r.pos?.mass));

  rec = new Recorder(hero, NAME);
  await rec.start();
  await hero.wait(600);
  rec.mark('lobby');
  await hero.hover(`[role="radio"][data-kb-value="arena:${ARENA}"]`, { fx: 0.45, pause: 900 });
  rec.mark('buy');
  await hero.buyTicket(ARENA, { slow: true, signDelay: 900 });
  rec.mark('enter', { left: await leftS() });
  hero.pid = await pidOf(hero);
  try {
    // 1. the big coin comes for her; she runs
    await beat('chase', async () => {
      plan.set(chomper, () => (heroPos.mass > 0 ? { mode: 'hunt', pid: hero.pid, wx: heroPos.wx, wy: heroPos.wy, noFood: true, split: false, margin: -400, splitMargin: 0 } : { mode: 'free' }));
      await heroWhile(14_000, { mode: 'free', humans: 0, margin: 900, splitMargin: 900, split: false });
    });
    rec.mark('chased');
    plan.set(chomper, () => ({ mode: 'free', noFood: true, noCells: true, margin: 900 }));
    chomper.eaten = true; // it is never baited again
    // 2. grow
    await beat('grow', () => heroWhile(80_000, forage, async () => heroPos.mass < GROW));
    // 3-5. three rivals
    await beat('hunt1', () => hunt(rivals[0], false, 'r1'));
    rec.mark('ate1');
    await beat('after1', () => heroWhile(3_000, forage));
    await beat('hunt2', () => hunt(rivals[1], true, 'r2'));
    rec.mark('ate2');
    await beat('after2', () => heroWhile(4_000, forage));
    await beat('hunt3', () => hunt(rivals[2], false, 'r3'));
    rec.mark('ate3');
    await beat('roam', () => heroWhile(40_000, { mode: 'free', humans: 0.3, margin: 600, splitMargin: 700 }));
  } catch (e) {
    if (!(e instanceof Late)) throw e;
    log('beats end:', e.message);
  }
  rec.mark('end');
} catch (e) {
  log('ERROR', e.message);
  rec?.mark('error', { msg: e.message });
} finally {
  stopAll = true;
  if (rec) await rec.stop().catch((e) => log('stop failed', e.message));
  for (const r of all) await r.close();
  await hero.close();
  await browser.close();
  log('done', ((Date.now() - T0) / 1000).toFixed(0), 's');
}
