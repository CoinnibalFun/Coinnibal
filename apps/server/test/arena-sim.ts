import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArenaScalingDecision, ArenaScalingSettings } from '@coinnibal/shared';
import { loadConfig } from '../src/config';
import { ArenaScalingStore, SCALER_SAMPLE_MS } from '../src/rooms/arena-scaler';
import { RoomManager } from '../src/rooms/manager';
import type { Room } from '../src/rooms/room';
import { Journal } from '../src/stake/journal';
import { ArenaChain, arena, fakeConn, roomDeps, stakeJoin } from './helpers';

/**
 * Arrival-wave simulation of one official arena with the instance scaler (used by `test/arena-scaling.test.ts`
 * and `scripts/arena-scaling-sim.ts`). Real `RoomManager` and `Room`s on a simulated wall clock (5-minute rounds,
 * joins closed in the last minute): every second the people who want to play (`demand(minute)`) and are not
 * seated buy a ticket and are seated through the manager (quick play), a few per second; people who are done
 * go AFK (their ticket plays on until the bell, as in the game). At every bell each ticket is settled. The
 * scaler samples every 5 s. Nothing is mocked but the chain (free tickets) and the clock.
 */
export interface ArenaSimOptions {
  /** People who want to play at a minute of the run. */
  demand: (minute: number) => number;
  minutes: number;
  /** Seats per instance (`ARENA_INSTANCE_CAP`). */
  cap: number;
  settings?: Partial<ArenaScalingSettings>;
  /** Most new seats per simulated second. */
  arrivalsPerSec?: number;
  seed?: number;
}

export interface ArenaSimMinute {
  minute: number;
  demand: number;
  seated: number;
  /** Instances taking seats / all public instances (draining ones too). */
  active: number;
  instances: number;
  /** People per instance (`#n:people`, `d` marks a draining one). */
  rooms: string;
}

export interface ArenaSimResult {
  timeline: ArenaSimMinute[];
  log: ArenaScalingDecision[];
  /** Tickets seated / settled (each exactly once) / seat requests that found no room. */
  seated: number;
  settled: number;
  duplicates: number;
  refused: number;
  /** Most people ever in one instance (must stay within `cap`). */
  maxInRoom: number;
  maxInstances: number;
}

const ROUND = { roundMs: 300_000, closeMs: 60_000 };

/** Two waves: a ramp to 45 people, a lull, a second wave of 30, then quiet (people wanting to play, by minute). */
export const ARENA_SIM_WAVES = (min: number): number => {
  if (min < 10) return 5 + 4 * min;
  if (min < 25) return 45;
  if (min < 40) return 8;
  if (min < 55) return 30;
  return 3;
};
const FEE = 1_000_000;

export async function runArenaSim(o: ArenaSimOptions): Promise<ArenaSimResult> {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-arena-sim-'));
  const cfg = loadConfig({ DATA_DIR: dir, ARENA_INSTANCE_CAP: String(o.cap) });
  const journal = new Journal(null);
  const chain = new ArenaChain([arena(1, FEE)]);
  // the run starts at a round start
  const clock = { t: Math.ceil(1_791_000_000_000 / ROUND.roundMs) * ROUND.roundMs };
  const store = new ArenaScalingStore(dir);
  if (o.settings) store.update(o.settings as Record<string, unknown>);
  const m = new RoomManager(cfg, { ...roomDeps(chain, journal, () => clock.t), round: ROUND }, chain, undefined, store);
  let rnd = (o.seed ?? 7) >>> 0;
  const rand = () => ((rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  /** Seated people still playing (not AFK), by room. */
  const playing: { room: Room; conn: ReturnType<typeof fakeConn> }[] = [];
  let seated = 0;
  let refused = 0;
  let maxInRoom = 0;
  let maxInstances = 0;
  const timeline: ArenaSimMinute[] = [];
  const perSec = o.arrivalsPerSec ?? 3;
  let nextSample = clock.t;
  const end = clock.t + o.minutes * 60_000;
  const t0 = clock.t;
  // the first instance, as the server opens it at start
  await m.ensureArenaRooms();
  const rooms = () => m.arenaInstances(1) as Room[];
  const settledKeys = new Map<string, number>();
  let duplicates = 0;
  let pendingSeen = 0;
  /** Settlements journaled since the last call (each ticket must appear exactly once). */
  const countSettled = () => {
    const pend = journal.pending;
    for (let i = pendingSeen; i < pend.length; i++) {
      const p = pend[i];
      if (p.kind !== 'settle') continue;
      const n = (settledKeys.get(p.key) ?? 0) + 1;
      settledKeys.set(p.key, n);
      if (n > 1) duplicates++;
    }
    pendingSeen = pend.length;
  };
  for (; clock.t < end; clock.t += 1000) {
    const minute = (clock.t - t0) / 60_000;
    // the bell (a room rings it at the start of its next tick)
    for (const r of rooms()) r.syncRound(clock.t);
    for (let i = playing.length - 1; i >= 0; i--) if (!playing[i].conn.player?.alive) playing.splice(i, 1);
    const want = Math.round(o.demand(minute));
    const win = m.roundWindow(clock.t);
    const open = clock.t >= win.opensAt && clock.t < win.joinsCloseAt;
    // done for this round: go AFK (the ticket plays on until the bell)
    if (playing.length > want) {
      for (let k = 0; k < Math.min(perSec, playing.length - want); k++) {
        const j = Math.floor(rand() * playing.length);
        const p = playing.splice(j, 1)[0];
        p.room.leave(p.conn, 'disconnect');
      }
    }
    // arrivals: quick play, the way the gateway seats a bought ticket
    if (open) {
      for (let k = 0; k < perSec && playing.length < want; k++) {
        if (rand() > 0.85) continue;
        const picked = (await m.arenaRoom(1)) as Room | null;
        const room = picked ? ((await m.confirmArenaRoom(1, picked)) as Room | null) : null;
        if (!room) {
          refused++;
          continue;
        }
        const conn = fakeConn(null);
        const j = stakeJoin(1, FEE);
        conn.wallet = j.stake.player;
        room.join(conn, j);
        seated++;
        playing.push({ room, conn });
      }
    }
    if (clock.t >= nextSample) {
      nextSample += SCALER_SAMPLE_MS;
      m.scaler.step(clock.t);
    }
    for (const r of rooms()) maxInRoom = Math.max(maxInRoom, r.humanCount);
    maxInstances = Math.max(maxInstances, rooms().length);
    countSettled();
    if ((clock.t - t0) % 60_000 === 0) {
      const view = m.scaler.view(clock.t).arenas.find((a) => a.arenaId === 1);
      const inst = view?.instances ?? [];
      timeline.push({
        minute: Math.round(minute),
        demand: want,
        seated: inst.reduce((s, x) => s + x.people, 0),
        active: inst.filter((x) => !x.draining).length,
        instances: inst.length,
        rooms: inst.map((x) => `#${x.instance}:${x.people}${x.draining ? 'd' : ''}`).join(' '),
      });
    }
  }
  // the last bell settles what is still in play
  clock.t = m.roundWindow(clock.t).endsAt;
  for (const r of rooms()) r.syncRound(clock.t);
  countSettled();
  m.stop();
  return { timeline, log: m.scaler.log().reverse(), seated, settled: settledKeys.size, duplicates, refused, maxInRoom, maxInstances };
}
