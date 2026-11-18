#!/usr/bin/env node
// Picks the loop from a take (take.mjs): for every gulp (goldie eats someone), a fixed world box (16:10)
// and a span [a, b] such that
//   - the box shows no coin (nor its name tag) in the crossfade windows before a and before b, so the
//     loop's seam only blends floor and pellets;
//   - the box stays inside what the server sent goldie (her view) and inside the world (no edge);
//   - the gulp is well inside the box and both coins are on screen long enough to read.
// Prints the best candidates (render.mjs arguments).
//   node media/hero-loop/plan.mjs <take> [--width 1000,1150,1300] [--min 6] [--max 10] [--fade 0.5]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TAKES } from '../gameplay/capture/lib.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const NAME = argv[0];
const DIR = resolve(TAKES, NAME);
const meta = JSON.parse(readFileSync(resolve(DIR, 'events.json'), 'utf8'));
const tele = JSON.parse(readFileSync(resolve(DIR, 'tele.json'), 'utf8')).filter((s) => s.me);
const ASPECT = meta.w / meta.h;
const WIDTHS = opt('--width', '1000,1150,1300').split(',').map(Number);
const LMIN = Number(opt('--min', '6')), LMAX = Number(opt('--max', '10'));
const FADE = Number(opt('--fade', '0.5'));
const TOP = Number(opt('--top', '8'));

const at = (t) => { let lo = 0, hi = tele.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (tele[m].t < t) lo = m + 1; else hi = m; } return lo; };
/** Does any coin (with its name tag) touch the box in samples [t0, t1]? */
function busy(box, t0, t1) {
  for (let i = at(t0); i < tele.length && tele[i].t <= t1; i++) {
    for (const [, , x, y, r] of tele[i].cells) {
      // the coin (a little more: jelly squash, 10 Hz samples) and its name tag above it
      const m = r * 1.1 + 40;
      if (x + m > box.x0 && x - m < box.x1 && y + m > box.y0 && y - m - 70 < box.y1) return true;
    }
  }
  return false;
}
/** Is the box inside the server's view (with a margin) and the world for all samples in [t0, t1]? */
function covered(box, t0, t1) {
  for (let i = at(t0); i < tele.length && tele[i].t <= t1; i++) {
    const [vx, vy, vh] = tele[i].view, vw = vh * ASPECT, [ww, wh] = tele[i].world;
    if (box.x0 < vx - vw / 2 + 60 || box.x1 > vx + vw / 2 - 60 || box.y0 < vy - vh / 2 + 60 || box.y1 > vy + vh / 2 - 60) return false;
    if (box.x0 < 40 || box.y0 < 40 || box.x1 > ww - 40 || box.y1 > wh - 40) return false;
  }
  return true;
}
/**
 * Seconds each player's coin is fully inside the box in [t0, t1]; seconds with no coin even half in it
 * (empty), with exactly one player's coin in it (solo) and with two or more (multi).
 */
function screenTime(box, t0, t1) {
  const out = {};
  let empty = 0, solo = 0, multi = 0;
  for (let i = at(t0); i < tele.length && tele[i].t <= t1; i++) {
    const seen = new Set(), inside = new Set();
    for (const [, pid, x, y, r] of tele[i].cells) {
      if (x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1) inside.add(pid);
      if (seen.has(pid)) continue;
      if (x - r > box.x0 && x + r < box.x1 && y - r > box.y0 && y + r < box.y1) { seen.add(pid); out[pid] = (out[pid] ?? 0) + 0.1; }
    }
    if (!inside.size) empty += 0.1;
    else if (inside.size === 1) solo += 0.1;
    else multi += 0.1;
  }
  return { out, empty, solo, multi };
}

// the gulps: near each `gulp` mark, a coin of another player that touches goldie and is gone (or dying) in the
// next sample (found in the telemetry itself: the take's own idea of who is who can be stale after a respawn)
const gulps = [];
for (const m of meta.marks.filter((m) => m.label === 'gulp')) {
  let found = null;
  for (let i = at(m.t - 2); i + 1 < tele.length && tele[i].t <= m.t + 0.3; i++) {
    const s0 = tele[i], s1 = tele[i + 1];
    const hero = s0.cells.find((c) => c[1] === s0.pid);
    if (!hero) continue;
    for (const c of s0.cells) {
      if (c[1] === s0.pid || c[5] || c[4] >= hero[4]) continue;
      const after = s1.cells.find((d) => d[0] === c[0]);
      if ((!after || after[5]) && Math.hypot(c[2] - hero[2], c[3] - hero[3]) < hero[4] + c[4]) found = { t: s0.t, x: c[2], y: c[3], r: c[4], pid: c[1], me: s0.me };
    }
  }
  if (found) gulps.push({ n: m.n, ...found, heroMass: found.me[2] });
}
console.log(`${NAME}: ${gulps.length} gulps:`, gulps.map((g) => `#${g.n} t=${g.t.toFixed(1)} prey r=${g.r} goldie mass ${g.heroMass}`).join('; '));

const cands = [];
for (const g of gulps) {
  for (const BW of WIDTHS) {
    const BH = BW / ASPECT;
    for (let ox = -0.35; ox <= 0.351; ox += 0.07) for (let oy = -0.3; oy <= 0.301; oy += 0.075) {
      const cx = Math.round(g.x + ox * BW), cy = Math.round(g.y + oy * BH);
      const box = { x0: cx - BW / 2, x1: cx + BW / 2, y0: cy - BH / 2, y1: cy + BH / 2 };
      for (let a = g.t - LMAX + 1; a <= g.t - 1; a += 0.1) {
        if (busy(box, a - FADE, a)) continue;
        for (let L = LMIN; L <= LMAX + 1e-6; L += 0.1) {
          const b = a + L;
          if (b < g.t + 1) continue;
          if (busy(box, b - FADE, b)) continue;
          if (!covered(box, a - FADE - 2.2, b)) continue;
          const { out: st, empty, solo, multi } = screenTime(box, a, b);
          const heroPid = tele[at(g.t)].pid;
          const hero = st[heroPid] ?? 0, prey = st[g.pid] ?? 0;
          const extras = Object.entries(st).filter(([p]) => +p !== heroPid && +p !== g.pid).reduce((s, [, v]) => s + v, 0);
          // the gulp near the middle of the box, both coins on screen a while, little dead air (the seams
          // themselves are empty by construction: about 2 x FADE)
          // (a little below the middle: the name tags stand above the coins)
          const off = Math.hypot((g.x - cx) / BW, (g.y - (cy + 0.06 * BH)) / BH);
          // a cactus cut by the frame's edge looks like a mistake; one fully inside is a nice prop
          let cut = 0;
          for (const [x, y, r] of tele[at(a)].cacti ?? []) {
            const R = r * 1.25, inX = x - R > box.x0 && x + R < box.x1 && y - R > box.y0 && y + R < box.y1;
            const touch = x + R > box.x0 && x - R < box.x1 && y + R > box.y0 && y - R < box.y1;
            if (touch && !inX) cut++;
          }
          // a loop is lively when several coins share the frame: time with one coin alone (she swims in or
          // out on her own) or none counts against it, as a share of the loop
          const score = Math.min(hero, 4) + Math.min(prey, 2.5) * 1.2 + Math.min(extras, 3) * 0.8 + (multi / L) * 6 - (solo / L) * 4 - Math.max(0, empty - 2 * FADE) * 2 - off * 4 - cut * 1.5 + (1300 / BW) * 0.8;
          cands.push({ n: g.n, score: +score.toFixed(2), a: +a.toFixed(2), b: +b.toFixed(2), L: +L.toFixed(1), box: [cx, cy, BW], hero: +hero.toFixed(1), prey: +prey.toFixed(1), extras: +extras.toFixed(1), multi: +multi.toFixed(1), solo: +solo.toFixed(1), empty: +empty.toFixed(1), cut, gulpAt: +(g.t - a).toFixed(2) });
          break; // the shortest L that works for this a
        }
      }
    }
  }
}
cands.sort((x, y) => y.score - x.score);
const seen = new Set();
const best = [];
for (const c of cands) {
  const key = `${c.n}:${c.box[2]}`;
  if (seen.has(key)) continue;
  seen.add(key);
  best.push(c);
  if (best.length >= TOP) break;
}
for (const c of best) console.log(JSON.stringify(c), `\n  render: node media/hero-loop/render.mjs ${NAME} --from ${(c.a - FADE).toFixed(2)} --to ${c.b.toFixed(2)} --box ${c.box.join(',')}\n  loop:   --fade ${FADE} --start-src ${(c.a + c.gulpAt - 0.4).toFixed(2)}`);
if (!best.length) console.log('no loop found: try other widths or a longer span');
