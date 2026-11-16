#!/usr/bin/env node
// Cuts the promo's gameplay shots (timeline.json "footage") out of a replayed journal take of the gameplay
// kit (media/gameplay/cache/takes/<take>: video.mkv, frames.json, fsamples.json; see media/gameplay/README.md)
// into cache/footage/<id>/NNNN.jpg (60 fps, the replay's own pixels; scenes.js reframes them) plus
// track.json: per output frame the hero coin and the nearest smaller coin in CSS px of the 1920x1080 page,
// [hx, hy, hr, px, py, pr], the frame count and the shot's events (the gulp, in shot seconds).
// A shot: {id, take, from (take seconds), dur, speed?: [[shot s, rate], ...] (a speed ramp; rate 1 = real
// time), gulp?: take seconds of a gulp, zoom?, lead?}.
//   node render/footage-from-takes.mjs --plan      prints the replay ranges (60 fps cover + 240 fps slow windows)
//   node render/footage-from-takes.mjs [id ...]    cuts the shots
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMO = resolve(HERE, '..');
const ROOT = resolve(PROMO, '../..');
const TAKES = resolve(ROOT, 'media/gameplay/cache/takes');
const FF = process.env.FFMPEG || '/usr/bin/ffmpeg';
const TL = JSON.parse(readFileSync(resolve(PROMO, 'timeline.json'), 'utf8'));
const argv = process.argv.slice(2);

/** Shot seconds -> take seconds, integrating the speed ramp (piecewise-linear rate). */
function srcMap(sh) {
  const ramp = sh.speed || [[0, 1], [sh.dur, 1]];
  const rate = (u) => {
    if (u <= ramp[0][0]) return ramp[0][1];
    for (let i = 0; i + 1 < ramp.length; i++) if (u <= ramp[i + 1][0]) return ramp[i][1] + ((ramp[i + 1][1] - ramp[i][1]) * (u - ramp[i][0])) / (ramp[i + 1][0] - ramp[i][0]);
    return ramp[ramp.length - 1][1];
  };
  const n = Math.round(sh.dur * 60);
  const out = [sh.from];
  for (let i = 1; i < n; i++) {
    const u = (i - 0.5) / 60;
    out.push(out[i - 1] + rate(u) / 60);
  }
  return out;
}

if (argv.includes('--plan')) {
  const per = {};
  for (const sh of TL.footage) {
    const m = srcMap(sh);
    (per[sh.take] ||= []).push(`${(m[0] - 0.3).toFixed(2)}-${(m[m.length - 1] + 0.3).toFixed(2)}@60`);
    // slow stretches get the 240 fps grid
    for (let i = 1; i < m.length; i++) {
      if ((m[i] - m[i - 1]) * 60 < 0.75) {
        let j = i;
        while (j + 1 < m.length && (m[j + 1] - m[j]) * 60 < 0.75) j++;
        per[sh.take].push(`${(m[i - 1] - 0.02).toFixed(3)}-${(m[j] + 0.02).toFixed(3)}@240`);
        i = j;
      }
    }
  }
  for (const [take, r] of Object.entries(per)) console.log(`node media/gameplay/capture/replay.mjs ${take} --scale 1.5 --ranges ${r.join(',')}`);
  process.exit(0);
}

const only = argv.filter((a) => !a.startsWith('--'));
for (const sh of TL.footage) {
  if (only.length && !only.includes(sh.id)) continue;
  const dir = resolve(TAKES, sh.take);
  const ft = JSON.parse(readFileSync(resolve(dir, 'frames.json'), 'utf8'));
  const fs = JSON.parse(readFileSync(resolve(dir, 'fsamples.json'), 'utf8'));
  const m = srcMap(sh);
  // the nearest captured frame for each output frame
  const pick = m.map((t) => {
    let lo = 0, hi = ft.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ft[mid] < t) lo = mid; else hi = mid; }
    return Math.abs(ft[lo] - t) <= Math.abs(ft[hi] - t) ? lo : hi;
  });
  const worst = Math.max(...m.map((t, i) => Math.abs(ft[pick[i]] - t)));
  if (worst > 0.02) console.warn(`${sh.id}: a frame is ${worst.toFixed(3)} s off its time (replay the ranges from --plan)`);
  const a = Math.min(...pick), b = Math.max(...pick);
  const tmp = resolve(PROMO, `cache/footage-tmp-${sh.id}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const r = spawnSync(FF, ['-v', 'error', '-i', resolve(dir, 'video.mkv'), '-vf', `select='between(n\\,${a}\\,${b})'`, '-vsync', '0', '-q:v', '3', resolve(tmp, '%05d.jpg')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  const got = readdirSync(tmp).length;
  if (got < b - a + 1) throw new Error(`${sh.id}: decoded ${got} frames, wanted ${b - a + 1}`);
  const out = resolve(PROMO, 'cache/footage', sh.id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const track = [];
  pick.forEach((j, i) => {
    copyFileSync(resolve(tmp, `${String(j - a + 1).padStart(5, '0')}.jpg`), resolve(out, `${String(i + 1).padStart(4, '0')}.jpg`));
    const s = fs[j] || {};
    const me = s.me || { x: 960, y: 540, r: 60 };
    // the prey: the nearest player coin smaller than the hero (tag 'p', a real pid)
    let best = null;
    for (const [tag, x, y, rr, pid] of s.near || []) {
      if (tag !== 'p' || !(pid > 0)) continue;
      const d = Math.hypot(x - me.x, y - me.y);
      if (!best || d < best.d) best = { x, y, r: rr, d };
    }
    track.push([+me.x.toFixed(1), +me.y.toFixed(1), +me.r.toFixed(1), best ? +best.x.toFixed(1) : 0, best ? +best.y.toFixed(1) : 0, best ? +best.r.toFixed(1) : 0]);
  });
  rmSync(tmp, { recursive: true, force: true });
  const events = {};
  if (sh.gulp != null) { let k = 0; while (k + 1 < m.length && m[k + 1] <= sh.gulp) k++; events.gulp = +(k / 60).toFixed(3); }
  writeFileSync(resolve(out, 'track.json'), JSON.stringify({ frames: pick.length, track, events }));
  console.log(`${sh.id}: ${pick.length} frames from ${sh.take} ${m[0].toFixed(2)}-${m[m.length - 1].toFixed(2)} s${events.gulp != null ? `, gulp at ${events.gulp} s` : ''}`);
}
