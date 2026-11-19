import { EntityKind, type SnapshotData } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { ClientWorld } from '../src/game/state';

const snap = (partial: Partial<SnapshotData>): SnapshotData => ({
  tick: 1,
  view: { x: 0, y: 0, h: 1200 },
  players: [],
  upserts: [],
  removals: [],
  ...partial,
});

const ME = 7;

/** A world where player ME owns cell 1 at (1000, 1000). */
function worldWithMe(now = 0): ClientWorld {
  const w = new ClientWorld();
  w.myPid = ME;
  w.apply(
    snap({
      players: [{ id: ME, skin: 2, flags: 0, name: 'Me' }],
      upserts: [{ id: 1, kind: EntityKind.Cell, x: 1000, y: 1000, r: 60, playerId: ME }],
    }),
    now,
  );
  w.update(now, 0);
  return w;
}

describe('ClientWorld · players', () => {
  it('lets go of players with no coin left in the mirror (bots respawn under new ids all session)', () => {
    const w = worldWithMe(0);
    for (let i = 0; i < 40; i++) {
      const pid = 100 + i;
      const t = 100 + i * 400;
      w.apply(snap({ players: [{ id: pid, skin: 1, flags: 0, name: `bot${i}`, isBot: true }], upserts: [{ id: 1000 + i, kind: EntityKind.Cell, x: 500, y: 500, r: 30, playerId: pid }] }), t);
      w.apply(snap({ removals: [{ id: 1000 + i, eaterId: 1 }] }), t + 10);
      w.update(t + 300, 0.016);
    }
    // a little later every eaten bot is gone; my own record stays (no coin while dead, still me)
    w.apply(snap({ removals: [{ id: 1, eaterId: 0 }] }), 40_010);
    w.update(41_000, 0.016);
    w.update(47_000, 0.016);
    expect(w.players.size).toBe(1);
    expect(w.players.has(ME)).toBe(true);
  });
});

describe('ClientWorld · loot', () => {
  it('loot entities are created, interpolated and removed with eater animation', () => {
    const w = worldWithMe(0);
    // a loot piece (tier 2) spills in
    w.apply(snap({ upserts: [{ id: 50, kind: EntityKind.Loot, x: 1200, y: 1000, r: 14, variant: 2 }] }), 10);
    const loot = w.entities.get(50)!;
    expect(loot.kind).toBe(EntityKind.Loot);
    expect(loot.variant).toBe(2);
    expect(loot.born).toBe(10);

    // it slides (friction) and the client eases between snapshots
    w.apply(snap({ upserts: [{ id: 50, kind: EntityKind.Loot, x: 1300, y: 1000, r: 14 }] }), 50);
    w.update(50 + 60, 0.06); // half way through the 120 ms lerp
    expect(loot.x).toBeGreaterThan(1200);
    expect(loot.x).toBeLessThan(1300);
    w.update(50 + 200, 0.14);
    expect(loot.x).toBeCloseTo(1300);
    expect(loot.variant).toBe(2); // variant kept when the upsert omits it

    // my cell eats it: it flies into the eater while shrinking, then disappears
    w.apply(snap({ removals: [{ id: 50, eaterId: 1 }] }), 300);
    expect(loot.dying).toBe(300);
    const eats = w.drainEats();
    expect(eats).toEqual([{ type: 'loot', eaterId: 1, x: 1300, y: 1000, variant: 2, mine: true }]);
    w.update(300 + 80, 0.08);
    expect(loot.x).toBeLessThan(1300);
    expect(loot.x).toBeGreaterThan(1000);
    expect(loot.r).toBeLessThan(14);
    expect(w.entities.has(50)).toBe(true);
    w.update(300 + 400, 0.3);
    expect(w.entities.has(50)).toBe(false);
  });

  it('loot that just leaves the view is removed without an eat event', () => {
    const w = worldWithMe(0);
    w.apply(snap({ upserts: [{ id: 51, kind: EntityKind.Loot, x: 1500, y: 1500, r: 14, variant: 0 }] }), 0);
    w.apply(snap({ removals: [{ id: 51, eaterId: 0 }] }), 20);
    expect(w.drainEats()).toEqual([]);
  });
});

describe('ClientWorld · value messages', () => {
  it('value message updates hud value and queues a floating number', () => {
    const w = worldWithMe(0);
    expect(w.value).toBeNull();
    w.applyValue({ t: 'value', value: 12_450_000_000, delta: 2_450_000_000, reason: 'loot' }, 100);
    expect(w.value).toBe(12_450_000_000);
    const floats = w.drainFloats();
    expect(floats).toHaveLength(1);
    expect(floats[0]).toMatchObject({ delta: 2_450_000_000, reason: 'loot', at: 100 });
    // the number rises from the top of my cell
    expect(floats[0].x).toBeCloseTo(1000);
    expect(floats[0].y).toBeLessThan(1000);
    expect(w.drainFloats()).toEqual([]);

    // a loss (a player took a share) is queued as a negative number
    w.applyValue({ t: 'value', value: 10_000_000_000, delta: -2_450_000_000, reason: 'eaten' }, 200);
    expect(w.value).toBe(10_000_000_000);
    expect(w.drainFloats()[0].delta).toBe(-2_450_000_000);

    // zero deltas update the value but float nothing
    w.applyValue({ t: 'value', value: 10_000_000_000, delta: 0, reason: 'eat' }, 300);
    expect(w.drainFloats()).toEqual([]);
  });

  it('a value message without my cells still updates the value (no float position)', () => {
    const w = new ClientWorld();
    w.applyValue({ t: 'value', value: 5, delta: 5, reason: 'eat' }, 0);
    expect(w.value).toBe(5);
    expect(w.drainFloats()).toEqual([]);
  });

  it('reset clears the value', () => {
    const w = worldWithMe(0);
    w.applyValue({ t: 'value', value: 5, delta: 5, reason: 'eat' }, 0);
    w.reset();
    expect(w.value).toBeNull();
  });
});

describe('ClientWorld · interpolation', () => {
  it('a coin moving at a steady speed moves the same distance every frame (30 snapshots a second, 60 frames)', () => {
    // the engine's order each frame: the snapshots due are applied, then the world steps
    const w = new ClientWorld();
    const TICK = 1000 / 30;
    const FRAME = 1000 / 60;
    const speed = 0.3; // world units per ms
    let tick = 0;
    const steps: number[] = [];
    let last: number | null = null;
    for (let f = 0; f < 60; f++) {
      const now = f * FRAME;
      while (tick * TICK <= now + 1e-6) {
        const at = tick * TICK;
        w.apply(snap({ tick, upserts: [{ id: 1, kind: EntityKind.Cell, x: 1000 + speed * at, y: 500, r: 40, playerId: ME }] }), at, TICK);
        tick++;
      }
      w.update(now, FRAME / 1000);
      const x = w.entities.get(1)!.x;
      if (last !== null && f > 4) steps.push(x - last);
      last = x;
    }
    const want = speed * FRAME;
    for (const s of steps) expect(s).toBeCloseTo(want, 6);
  });

  it('a snapshot picked up a little late eases on from where the coin is drawn, without a jump back', () => {
    const w = new ClientWorld();
    w.apply(snap({ upserts: [{ id: 1, kind: EntityKind.Cell, x: 0, y: 0, r: 40, playerId: ME }] }), 0, 100);
    w.apply(snap({ upserts: [{ id: 1, kind: EntityKind.Cell, x: 100, y: 0, r: 50, playerId: ME }] }), 0, 100);
    w.update(60, 0.016);
    const e = w.entities.get(1)!;
    expect(e.x).toBeCloseTo(60);
    // the next lands at 80 (before this frame's step): the new ease starts at the place on the old one at 80
    w.apply(snap({ upserts: [{ id: 1, kind: EntityKind.Cell, x: 200, y: 0, r: 60, playerId: ME }] }), 80, 100);
    expect(e.ox).toBeCloseTo(80);
    expect(e.or).toBeCloseTo(48);
    w.update(80, 0.016);
    expect(e.x).toBeCloseTo(80);
    w.update(130, 0.016);
    expect(e.x).toBeCloseTo(80 + (200 - 80) * 0.5);
  });
});
