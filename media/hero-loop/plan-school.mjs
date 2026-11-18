#!/usr/bin/env node
// Picks the loop from a school take (take-school.mjs). For every scene with a gulp, a span [a, b] of exactly the
// scene's period (b = a + period: the school and goldie's sway are where they were at a) with the follow camera
// of cam.mjs, scored on
//   - the seam: in the crossfade windows before a and before b the same coins are in the frame, each in about
//     the same place in it (the prey and its next turn nowhere near), no coin rain, no cactus in the frame;
//   - the frame: inside what the server sent goldie (no coin pops in at an edge) and inside the world (no wall);
//   - the eat: the prey in the frame a while before the gulp, the gulp well inside the frame;
//   - life: coins in the frame (6-10 most of the time is the aim).
// Prints the best candidates (render.mjs and loop.py arguments).
//   node media/hero-loop/plan-school.mjs <take> [--k 11] [--fade 0.6] [--top 6]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TAKES } from '../gameplay/capture/lib.mjs';
import { makeCam } from './cam.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const NAME = argv[0];
const DIR = resolve(TAKES, NAME);
const meta = JSON.parse(readFileSync(resolve(DIR, 'events.json'), 'utf8'));
const tele = JSON.parse(readFileSync(resolve(DIR, 'tele.json'), 'utf8')).filter((s) => s.me);
const ASPECT = meta.w / meta.h;
const K = Number(opt('--k', '11'));
const FADE = Number(opt('--fade', '0.6'));
const TOP = Number(opt('--top', '6'));
const cam = makeCam(tele, { k: K });

const at = (t) => { let lo = 0, hi = tele.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (tele[m].t < t) lo = m + 1; else hi = m; } return lo; };
const boxAt = (t) => { const c = cam(t); const h = c.w / ASPECT; return { ...c, h, x0: c.x - c.w / 2, x1: c.x + c.w / 2, y0: c.y - h / 2, y1: c.y + h / 2 }; };
/** Coins (by player) that show in the box at sample i: the coin or its name tag touches it. */
function shown(i) {
  const s = tele[i], b = boxAt(s.t);
  const out = new Map();
  for (const [, pid, x, y, r, dying] of s.cells) {
    if (pid === s.pid) continue;
    const m = r * 1.05;
    if (x + m > b.x0 && x - m < b.x1 && y + m > b.y0 && y - m - (dying ? 0 : b.w * 0.05) < b.y1) {
      const prev = out.get(pid);
      if (!prev || r > prev.r) out.set(pid, { u: (x - b.x) / b.w, v: (y - b.y) / b.w, r: r / b.w, dying });
    }
  }
  return out;
}
/** The seam: samples t in [a - FADE, a] against t + period; the cost of every coin that differs. */
function seam(a, T) {
  let cost = 0, odd = 0, n = 0;
  for (let i = at(a - FADE); i < tele.length && tele[i].t <= a; i++) {
    const j = at(tele[i].t + T);
    if (!tele[j] || Math.abs(tele[j].t - tele[i].t - T) > 0.08) continue;
    const A = shown(i), B = shown(j);
    n++;
    for (const [pid, p] of A) {
      const q = B.get(pid);
      if (!q) { odd += 1; continue; }
      cost += Math.hypot(p.u - q.u, p.v - q.v) + Math.abs(p.r - q.r);
    }
    for (const pid of B.keys()) if (!A.has(pid)) odd += 1;
  }
  return n ? { cost: cost / n, odd: odd / n } : { cost: 9, odd: 9 };
}
function covered(t0, t1) {
  for (let i = at(t0); i < tele.length && tele[i].t <= t1; i++) {
    const s = tele[i], b = boxAt(s.t);
    const [vx, vy, vh] = s.view, vw = vh * ASPECT, [ww, wh] = s.world;
    if (b.x0 < vx - vw / 2 + 60 || b.x1 > vx + vw / 2 - 60 || b.y0 < vy - vh / 2 + 60 || b.y1 > vy + vh / 2 - 60) return false;
    if (b.x0 < 40 || b.y0 < 40 || b.x1 > ww - 40 || b.y1 > wh - 40) return false;
    if (s.rain) return false;
  }
  return true;
}
/** Cacti touching the box in [t0, t1] (any) and at the seam samples. */
function cactusIn(t0, t1) {
  let n = 0;
  for (let i = at(t0); i < tele.length && tele[i].t <= t1; i++) {
    const b = boxAt(tele[i].t);
    for (const [x, y, r] of tele[i].cacti) if (x + r * 1.3 > b.x0 && x - r * 1.3 < b.x1 && y + r * 1.3 > b.y0 && y - r * 1.3 < b.y1) { n++; break; }
  }
  return n;
}
/** Coins in the frame per sample over [t0, t1] (goldie included): the mean and the share of samples with 6 or more. */
function crowd(t0, t1) {
  let sum = 0, six = 0, n = 0;
  for (let i = at(t0); i < tele.length && tele[i].t <= t1; i++) {
    const s = tele[i], b = boxAt(s.t);
    let c = 1;
    for (const [, pid, x, y] of s.cells) if (pid !== s.pid && x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) c++;
    sum += c; six += c >= 6 ? 1 : 0; n++;
  }
  return { mean: sum / Math.max(1, n), six: six / Math.max(1, n) };
}

const marks = meta.marks;
const cands = [];
for (const cr of marks.filter((m) => m.label === 'cruise')) {
  const gulp = marks.find((m) => m.label === 'gulp' && m.n === cr.n);
  const end = marks.find((m) => m.label === 'cruise-end' && m.n === cr.n);
  if (!gulp || !end) continue;
  const T = cr.period;
  // the gulp in the telemetry: the prey's coin touching goldie, gone (or dying) in the next sample
  let g = null;
  for (let i = at(gulp.t - 2.5); i + 1 < tele.length && tele[i].t <= gulp.t + 0.3; i++) {
    const s0 = tele[i], s1 = tele[i + 1];
    const hero = s0.cells.find((c) => c[1] === s0.pid);
    const c = s0.cells.find((x) => x[1] === cr.preyPid && !x[5]);
    if (!hero || !c) continue;
    const after = s1.cells.find((d) => d[0] === c[0]);
    if ((!after || after[5]) && Math.hypot(c[2] - hero[2], c[3] - hero[3]) < hero[4] + c[4]) { g = { t: s0.t, x: c[2], y: c[3] }; break; }
  }
  if (!g) { console.log(`scene ${cr.n}: no gulp found in the telemetry`); continue; }
  // the prey's time in the frame before the gulp
  let seen = 0;
  for (let i = at(g.t - 6); i < tele.length && tele[i].t < g.t; i++) {
    const b = boxAt(tele[i].t), c = tele[i].cells.find((x) => x[1] === cr.preyPid);
    if (c && c[2] > b.x0 && c[2] < b.x1 && c[3] > b.y0 && c[3] < b.y1) seen += 0.1;
  }
  const gb = boxAt(g.t);
  const off = Math.hypot((g.x - gb.x) / gb.w, (g.y - gb.y) / gb.h);
  for (let a = g.t - 5.4; a <= g.t - 2.6; a += 0.05) {
    const b = a + T;
    if (a - FADE - 2.2 < cr.t0 + 0.6 || b > end.t - 0.2) continue;
    if (!covered(a - FADE, b)) continue;
    const s1 = seam(a, T);
    const cac = cactusIn(a - FADE, a) + cactusIn(b - FADE, b);
    const cut = cactusIn(a, b);
    const { mean, six } = crowd(a, b);
    const score = Math.min(mean, 9) * 0.8 + six * 3 + Math.min(seen, 3) * 0.6 - s1.cost * 25 - s1.odd * 4 - cac * 0.3 - cut * 0.02 - off * 4;
    cands.push({ n: cr.n, score: +score.toFixed(2), a: +a.toFixed(2), b: +b.toFixed(2), T, gulpAt: +(g.t - a).toFixed(2), seam: +s1.cost.toFixed(3), odd: +s1.odd.toFixed(2), crowd: +mean.toFixed(1), six: +six.toFixed(2), preySeen: +seen.toFixed(1), off: +off.toFixed(2), cactusSeam: cac, cactus: cut, heroMass: cr.heroMass, preyMass: cr.preyMass, g: g.t });
  }
}
cands.sort((x, y) => y.score - x.score);
const best = [];
const seenN = new Set();
for (const c of cands) {
  if (seenN.has(c.n)) continue;
  seenN.add(c.n);
  best.push(c);
  if (best.length >= TOP) break;
}
for (const c of best) console.log(JSON.stringify(c), `\n  render: node media/hero-loop/render.mjs ${NAME} --from ${(c.a - FADE).toFixed(2)} --to ${c.b.toFixed(2)} --follow ${K}\n  loop:   --fade ${FADE} --start-src ${(c.g - 1.2).toFixed(2)}`);
if (!best.length) console.log('no loop found');
