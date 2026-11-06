/**
 * A client-side network drill: one coin moving on a circle, snapshotted at the server's 30 Hz, sent over the same path
 * model as `apps/server/scripts/bench/netem.ts` (RTT/2 each way; with probability `loss` a chunk is lost and it, and
 * everything behind it, waits a retransmission of max(200 ms, RTT + 50 ms): TCP is in order), and drawn by the real
 * `ClientWorld` at 60 frames a second.
 *
 * `direct` is the old client (each snapshot applied the moment it arrives, eased over 120 ms); `buffered` is the
 * jitter buffer (`SnapshotTimeline`, drawn `RENDER_DELAY_MS` behind, extrapolated up to `EXTRAPOLATE_MS`).
 *
 * A freeze is a run of frames lasting 100 ms or more in which the drawn coin does not move while the real one does (a
 * hitch: 50 ms or more); a jump is a frame in which it moves more than three frames' worth of the real speed.
 */
import { EntityKind, TICK_MS, type SnapshotData } from '@elymum/shared';
import { ClientWorld } from '../src/game/state';
import { EXTRAPOLATE_MS, SnapshotTimeline } from '../src/game/jitter';

export interface PathProfile {
  rttMs: number;
  loss: number;
}

export interface DrillResult {
  freezesPerMin: number;
  /** Shorter stills (50 ms or more): a visible hitch. */
  hitchesPerMin: number;
  jumpsPerMin: number;
  longestStillMs: number;
  /** Mean distance between the drawn coin and where the server had it one way-trip earlier (world units). */
  meanErr: number;
}

const SPEED = 250;
const RADIUS = 800;
const FRAME_MS = 1000 / 60;

/** Park–Miller: the same drill every run. */
function rng(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const truth = (ms: number): { x: number; y: number } => {
  const a = (ms / 1000) * (SPEED / RADIUS);
  return { x: 3000 + RADIUS * Math.cos(a), y: 3000 + RADIUS * Math.sin(a) };
};

/** When each snapshot of the run reaches the client (ms), tick by tick. */
export function arrivals(p: PathProfile, seconds: number, seed = 7): number[] {
  const rand = rng(seed);
  const out: number[] = [];
  let holdUntil = 0;
  let last = 0;
  const ticks = Math.floor((seconds * 1000) / TICK_MS);
  for (let k = 1; k <= ticks; k++) {
    let at = k * TICK_MS + p.rttMs / 2;
    if (rand() < p.loss) holdUntil = Math.max(holdUntil, at + Math.max(200, p.rttMs + 50));
    at = Math.max(at, holdUntil, last);
    last = at;
    out.push(at);
  }
  return out;
}

const snap = (tick: number): SnapshotData => {
  const at = truth(tick * TICK_MS);
  return { tick, view: { x: at.x, y: at.y, h: 1200 }, players: [], upserts: [{ id: 1, kind: EntityKind.Cell, x: at.x, y: at.y, r: 40, playerId: 1 }], removals: [] };
};

export function drill(mode: 'direct' | 'buffered', p: PathProfile, seconds = 60, seed = 7): DrillResult {
  const world = new ClientWorld();
  const timeline = new SnapshotTimeline<SnapshotData>();
  if (mode === 'buffered') world.extrapolateMs = EXTRAPOLATE_MS;
  const when = arrivals(p, seconds, seed);
  let next = 0;
  let freezes = 0;
  let hitches = 0;
  let jumps = 0;
  let still = 0;
  let longest = 0;
  let errSum = 0;
  let errN = 0;
  let prev: { x: number; y: number } | null = null;
  const end = seconds * 1000;
  const step = (SPEED * FRAME_MS) / 1000;
  for (let now = 0; now < end; now += FRAME_MS) {
    while (next < when.length && when[next] <= now) {
      const tick = next + 1;
      if (mode === 'direct') world.apply(snap(tick), when[next]);
      else timeline.push(snap(tick), tick, when[next]);
      next++;
    }
    if (mode === 'buffered') for (const d of timeline.due(now)) world.apply(d.item, now, d.step);
    world.update(now, FRAME_MS / 1000);
    const e = world.entities.get(1);
    if (!e) continue;
    if (prev && now > 2000) {
      const moved = Math.hypot(e.x - prev.x, e.y - prev.y);
      if (moved < step * 0.1) {
        still += FRAME_MS;
      } else {
        if (still >= 100) freezes++;
        if (still >= 50) hitches++;
        longest = Math.max(longest, still);
        still = 0;
      }
      if (moved > step * 3) jumps++;
      const t = truth(now - p.rttMs / 2);
      errSum += Math.hypot(e.x - t.x, e.y - t.y);
      errN++;
    }
    prev = { x: e.x, y: e.y };
  }
  if (still >= 100) freezes++;
  if (still >= 50) hitches++;
  longest = Math.max(longest, still);
  const minutes = (seconds - 2) / 60;
  return { freezesPerMin: freezes / minutes, hitchesPerMin: hitches / minutes, jumpsPerMin: jumps / minutes, longestStillMs: Math.round(longest), meanErr: errN ? errSum / errN : 0 };
}
