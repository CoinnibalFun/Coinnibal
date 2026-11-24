import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARENA_SCALING_DEFAULT, applyArenaScaling, roundAt, type ArenaScalingSettings } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { ArenaScalingFail, ArenaScalingStore, SCALER_SAMPLE_MS } from '../src/rooms/arena-scaler';
import { RoomManager } from '../src/rooms/manager';
import type { Room } from '../src/rooms/room';
import { Journal } from '../src/stake/journal';
import { ARENA_SIM_WAVES, runArenaSim } from './arena-sim';
import { TICK_MS } from '@coinnibal/shared';
import { ArenaChain, arena, fakeConn, roomDeps, stakeJoin, type TestConn } from './helpers';

/** A zero-value eater lands on the coin and eats it (its ticket settles at its death). */
function eat(room: Room, conn: TestConn): void {
  const p = conn.player!;
  p.shieldUntil = 0;
  const c = p.center();
  const eater = room.world.addPlayer({ name: 'eater', skin: 0, isBot: true, x: c.x, y: c.y, mass: 800, spawnShield: false });
  for (let i = 0; i < 60 && p.alive; i++) room.tick(TICK_MS);
  room.world.removePlayer(eater.id);
  expect(p.alive).toBe(false);
}

const FEE = 1_000_000;
const ROUND = { roundMs: 300_000, closeMs: 60_000 };

/** A manager with arena #1, `cap` seats per instance and the scaler's settings, on a hand-driven clock 10 s into a round. */
async function setup(cap: number, settings: Partial<ArenaScalingSettings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-scale-'));
  const cfg = loadConfig({ DATA_DIR: dir, ARENA_INSTANCE_CAP: String(cap) });
  const journal = new Journal(null);
  const chain = new ArenaChain([arena(1, FEE)]);
  const clock = { t: roundAt(1_791_000_000_000, ROUND.roundMs, ROUND.closeMs).startsAt + 10_000 };
  const store = new ArenaScalingStore(dir);
  store.update(settings as Record<string, unknown>);
  const m = new RoomManager(cfg, { ...roomDeps(chain, journal, () => clock.t), round: ROUND }, chain, undefined, store);
  await m.ensureArenaRooms();
  /** Seats one ticket through quick play (as the gateway does) and returns the room. */
  const seat = async () => {
    const picked = await m.arenaRoom(1);
    const room = (picked ? await m.confirmArenaRoom(1, picked) : null) as Room | null;
    if (!room) throw new Error('no room');
    const j = stakeJoin(1, FEE);
    const conn = fakeConn(j.stake.player);
    room.join(conn, j);
    return { room, conn, session: j.stake.session };
  };
  /** Advances the clock by `ms` in sampling steps (rings due bells first, like a tick). */
  const advance = (ms: number) => {
    const end = clock.t + ms;
    while (clock.t < end) {
      clock.t = Math.min(end, clock.t + SCALER_SAMPLE_MS);
      for (const r of m.arenaInstances(1)) (r as Room).syncRound(clock.t);
      m.scaler.step(clock.t);
    }
  };
  const ids = () => m.arenaInstances(1).map((r) => r.id);
  return { m, journal, clock, seat, advance, ids, dir, store };
}

describe('arena scaling settings', () => {
  it('validates every field, keeps min <= max and the hysteresis gap low < high', () => {
    const d = ARENA_SCALING_DEFAULT;
    expect(applyArenaScaling(d, { maxInstances: 8, highPct: 90 })).toEqual({ ok: true, settings: { ...d, maxInstances: 8, highPct: 90 } });
    expect(applyArenaScaling(d, { minInstances: 7, maxInstances: 5 })).toMatchObject({ ok: false, field: 'minInstances' });
    expect(applyArenaScaling(d, { lowPct: 80 })).toMatchObject({ ok: false, field: 'lowPct' });
    expect(applyArenaScaling(d, { fullHits: 0 })).toMatchObject({ ok: false, field: 'fullHits' });
    expect(applyArenaScaling(d, { windowMin: 2.5 })).toMatchObject({ ok: false, field: 'windowMin' });
    expect(applyArenaScaling(d, { enabled: 'yes' })).toMatchObject({ ok: false, field: 'enabled' });
    expect(applyArenaScaling(d, { speed: 1 })).toMatchObject({ ok: false, field: 'speed' });
    // a saved file: bad and unknown fields are skipped, the pairs are repaired
    expect(applyArenaScaling(d, { speed: 1, fullHits: -3, minInstances: 9, maxInstances: 2, lowPct: 85 }, false)).toEqual({
      ok: true,
      settings: { ...d, minInstances: 2, maxInstances: 2, lowPct: 79 },
    });
  });

  it('stores admin changes in DATA_DIR/site/arena-scaling.json and moves a broken file aside', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-scale-store-'));
    const s = new ArenaScalingStore(dir);
    expect(s.settings).toEqual(ARENA_SCALING_DEFAULT);
    s.update({ maxInstances: 4, cooldownMin: 1 });
    expect(new ArenaScalingStore(dir).settings).toMatchObject({ maxInstances: 4, cooldownMin: 1 });
    expect(() => s.update({ lowPct: 99 })).toThrow(ArenaScalingFail);
    writeFileSync(join(dir, 'site', 'arena-scaling.json'), '{oops');
    const logs: string[] = [];
    expect(new ArenaScalingStore(dir, (m) => logs.push(m)).settings).toEqual(ARENA_SCALING_DEFAULT);
    expect(logs.join()).toMatch(/unreadable/);
    expect(readdirSync(join(dir, 'site')).some((f) => f.startsWith('arena-scaling.json.corrupt-'))).toBe(true);
    expect(existsSync(join(dir, 'site', 'arena-scaling.json'))).toBe(false);
  });
});

describe('arena instance seating', () => {
  it('fills the fullest open instance first, overflows into a new one, and never seats past capacity', async () => {
    const { m, seat, ids } = await setup(3);
    const rooms: string[] = [];
    for (let i = 0; i < 7; i++) rooms.push((await seat()).room.id);
    expect(rooms).toEqual(['arena-1-1', 'arena-1-1', 'arena-1-1', 'arena-1-2', 'arena-1-2', 'arena-1-2', 'arena-1-3']);
    expect(ids()).toEqual(['arena-1-1', 'arena-1-2', 'arena-1-3']);
    expect(m.scaler.log().filter((d) => d.action === 'overflow').map((d) => d.room)).toEqual(['arena-1-3', 'arena-1-2']);
    for (const r of m.arenaInstances(1)) expect(r.humanCount).toBeLessThanOrEqual(3);
  });

  it('above maxInstances a bought ticket still gets a seat (an overflow, logged)', async () => {
    const { m, seat, ids } = await setup(2, { maxInstances: 2 });
    for (let i = 0; i < 5; i++) await seat();
    expect(ids()).toEqual(['arena-1-1', 'arena-1-2', 'arena-1-3']);
    expect(m.scaler.log()[0]).toMatchObject({ action: 'overflow', room: 'arena-1-3', reason: expect.stringMatching(/above the maximum of 2/) });
  });
});

describe('arena scaling decisions', () => {
  it('opens an instance ahead of demand after repeated capacity events in the window, then waits out the cooldown', async () => {
    const { m, seat, advance, ids } = await setup(4, { fullHits: 2, windowMin: 5, cooldownMin: 3, highPct: 75, lowPct: 20 });
    // two instances fill up (each a capacity event while the arena is busy)
    for (let i = 0; i < 8; i++) await seat();
    advance(SCALER_SAMPLE_MS);
    expect(ids()).toEqual(['arena-1-1', 'arena-1-2', 'arena-1-3']);
    const open = m.scaler.log().find((d) => d.action === 'open');
    expect(open).toMatchObject({ room: 'arena-1-3', reason: expect.stringMatching(/reached capacity/) });
    // within the cooldown nothing else happens, however full
    for (let i = 0; i < 4; i++) await seat();
    advance(60_000);
    expect(m.scaler.log().filter((d) => d.action === 'open')).toHaveLength(1);
  });

  it('opens an instance when the arena stays at least highPct full for sustainMin', async () => {
    const { m, seat, advance, ids } = await setup(10, { fullHits: 50, highPct: 70, sustainMin: 1, lowPct: 20 });
    for (let i = 0; i < 8; i++) await seat();
    advance(30_000);
    expect(ids()).toEqual(['arena-1-1']);
    advance(40_000);
    expect(ids()).toEqual(['arena-1-1', 'arena-1-2']);
    expect(m.scaler.log()[0]).toMatchObject({ action: 'open', reason: expect.stringMatching(/at least 70 % full for 1 min/) });
  });

  it('enabled off: nothing opens ahead of demand', async () => {
    const { m, seat, advance, ids } = await setup(10, { enabled: false, highPct: 50, sustainMin: 1, lowPct: 20 });
    for (let i = 0; i < 9; i++) await seat();
    advance(120_000);
    expect(ids()).toEqual(['arena-1-1']);
    expect(m.scaler.log()).toHaveLength(0);
  });

  it('drains the emptiest extra instance once demand falls; an empty one closes at once', async () => {
    const { m, journal, seat, advance, ids } = await setup(4, { lowPct: 40, highPct: 80, lowMin: 1, cooldownMin: 0 });
    const seated = [];
    for (let i = 0; i < 6; i++) seated.push(await seat());
    // 6 of 8 seats: busy, nothing drains; the tickets play to the bell
    advance(90_000);
    expect(m.scaler.log().some((d) => d.action === 'drain')).toBe(false);
    advance(roundAt(m.now(), ROUND.roundMs, ROUND.closeMs).endsAt - m.now());
    // at the bell every ticket settled exactly once
    const settled = journal.pending.filter((p) => p.kind === 'settle').map((p) => p.key);
    expect(settled.sort()).toEqual(seated.map((s) => s.session).sort());
    // the next round: three people come back, all into #1 (the fullest open instance)
    for (let i = 0; i < 3; i++) expect((await seat()).room.id).toBe('arena-1-1');
    advance(70_000);
    // #2 stayed empty for a minute: drained and closed at once (nothing of value in it)
    expect(ids()).toEqual(['arena-1-1']);
    expect(m.scaler.log().slice(0, 2).map((d) => `${d.action} ${d.room}`)).toEqual(['close arena-1-2', 'drain arena-1-2']);
  });

  it('a draining instance keeps its live tickets to the bell and takes no new seat; #1 is never drained', async () => {
    const { m, journal, seat, advance, ids } = await setup(4, { lowPct: 60, highPct: 80, lowMin: 1, cooldownMin: 0 });
    const seated = [];
    for (let i = 0; i < 8; i++) seated.push(await seat());
    // six coins are eaten (their tickets settle at their death): #1 and #2 keep one person each
    for (const s of [...seated.slice(1, 4), ...seated.slice(5, 8)]) eat(s.room, s.conn);
    expect(m.arenaInstances(1).map((r) => r.humanCount)).toEqual([1, 1]);
    advance(70_000);
    // 2 of 8 seats for a minute (25 % < 60 %), and one instance holds them: the emptiest, newest drains
    expect(m.scaler.log()[0]).toMatchObject({ action: 'drain', room: 'arena-1-2' });
    // its person plays on: the room stays open, the coin alive, the ticket live
    const survivor = seated[4];
    expect(ids()).toEqual(['arena-1-1', 'arena-1-2']);
    expect(survivor.conn.player?.alive).toBe(true);
    expect(survivor.room.liveSessions()).toEqual([survivor.session]);
    // new seats go to #1 only (3 of its 4 seats: under the 80 % that would take #2 back)
    for (let i = 0; i < 2; i++) expect((await seat()).room.id).toBe('arena-1-1');
    // the bell settles everything; the drained #2 then closes, #1 stays
    advance(roundAt(m.now(), ROUND.roundMs, ROUND.closeMs).endsAt - m.now() + SCALER_SAMPLE_MS);
    expect(ids()).toEqual(['arena-1-1']);
    expect(m.scaler.log()[0]).toMatchObject({ action: 'close', room: 'arena-1-2' });
    const keys = journal.pending.filter((p) => p.kind === 'settle').map((p) => p.key);
    expect(keys).toHaveLength(10);
    expect(new Set(keys).size).toBe(10);
    expect(keys).toContain(survivor.session);
    expect(m.scaler.log().filter((d) => d.action === 'drain').some((d) => d.room === 'arena-1-1')).toBe(false);
  });

  it('a seat that finds every open instance full takes a draining instance back before opening a new one', async () => {
    const { m, seat, advance, ids } = await setup(4, { lowPct: 60, highPct: 80, lowMin: 1, cooldownMin: 0 });
    const seated = [];
    for (let i = 0; i < 5; i++) seated.push(await seat());
    for (const s of seated.slice(1, 4)) eat(s.room, s.conn);
    advance(70_000);
    expect(m.scaler.log()[0]).toMatchObject({ action: 'drain', room: 'arena-1-2' });
    for (let i = 0; i < 3; i++) expect((await seat()).room.id).toBe('arena-1-1');
    // #1 is full again: the next seat takes #2 back
    expect((await seat()).room.id).toBe('arena-1-2');
    expect(m.scaler.log()[0]).toMatchObject({ action: 'undrain', room: 'arena-1-2' });
    expect(ids()).toEqual(['arena-1-1', 'arena-1-2']);
  });

  it('never consolidates when one instance fewer could not hold the peak (no flapping)', async () => {
    const { m, seat, advance } = await setup(10, { lowPct: 60, highPct: 65, lowMin: 1, cooldownMin: 0, fullHits: 50 });
    for (let i = 0; i < 11; i++) await seat();
    // 11 people in 2 x 10 seats = 55 % (< 60 %), but 11 > 1 x 10 x 65 %: draining #2 would call for it again
    advance(120_000);
    expect(m.scaler.log().some((d) => d.action === 'drain')).toBe(false);
  });

  it('keeps minInstances open', async () => {
    const { m, advance, ids } = await setup(10, { minInstances: 3, maxInstances: 5 });
    advance(SCALER_SAMPLE_MS);
    expect(ids()).toEqual(['arena-1-1', 'arena-1-2', 'arena-1-3']);
    expect(m.scaler.log().filter((d) => d.action === 'open').every((d) => /below the minimum of 3/.test(d.reason))).toBe(true);
    // and never drains below it, however empty
    advance(30 * 60_000);
    expect(ids()).toEqual(['arena-1-1', 'arena-1-2', 'arena-1-3']);
  });

  it('the admin view lists every instance, its fill and the decisions', async () => {
    const { m, seat } = await setup(2);
    for (let i = 0; i < 3; i++) await seat();
    const v = m.scaler.view();
    expect(v.settings).toEqual(ARENA_SCALING_DEFAULT);
    expect(v.arenas).toEqual([
      {
        arenaId: 1,
        name: expect.any(String),
        instances: [
          { id: 'arena-1-1', instance: 1, people: 2, capacity: 2, draining: false },
          { id: 'arena-1-2', instance: 2, people: 1, capacity: 2, draining: false },
        ],
        fillPct: 75,
        fullHits: 1,
        lastActionAt: null,
      },
    ]);
    expect(v.log[0]).toMatchObject({ arenaId: 1, action: 'overflow', room: 'arena-1-2' });
  });
});

describe('arrival-wave simulation (scripts/arena-scaling-sim.ts)', () => {
  it('scales up through the waves and back down in the lulls without dropping or double-settling a ticket', { timeout: 120_000 }, async () => {
    const r = await runArenaSim({ demand: ARENA_SIM_WAVES, minutes: 80, cap: 10 });
    expect(r.refused).toBe(0);
    expect(r.duplicates).toBe(0);
    expect(r.settled).toBe(r.seated);
    expect(r.seated).toBeGreaterThan(250);
    expect(r.maxInRoom).toBeLessThanOrEqual(10);
    // up to the first wave's 45 people (5 instances full and one ahead of demand), back to one at the end
    expect(r.maxInstances).toBeGreaterThanOrEqual(5);
    expect(r.maxInstances).toBeLessThanOrEqual(ARENA_SCALING_DEFAULT.maxInstances);
    expect(r.timeline.at(-1)!.instances).toBe(1);
    const actions = r.log.map((d) => d.action);
    expect(actions).toContain('open');
    expect(actions).toContain('drain');
    expect(actions.filter((a) => a === 'close').length).toBe(actions.filter((a) => a === 'drain').length);
    // the lull between the waves consolidated before the second wave
    const lull = r.timeline.find((t) => t.minute === 39)!;
    expect(lull.instances).toBeLessThan(r.maxInstances);
  });
});
