import { EntityKind, PowerUpType, RULES, SPLIT_REACH, TICK_MS, massToRadius, mergeDelayMs } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { World, type WorldConfig } from '../src/game/world';

const cfg = (over: Partial<WorldConfig> = {}): WorldConfig => ({
  width: 3000,
  height: 3000,
  foodTarget: 0,
  virusTarget: 0,
  maxPowerUps: 0,
  powerUps: false,
  coinRain: false,
  seed: 42,
  ...over,
});

const run = (w: World, ms: number) => {
  const ticks = Math.ceil(ms / TICK_MS);
  for (let i = 0; i < ticks; i++) w.tick(TICK_MS);
};

const allFinite = (w: World) =>
  w.cells.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.r) && Number.isFinite(c.mass));

describe('world: eating', () => {
  it('a cell eats food whose centre it covers', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 500, y: 500, mass: 100 });
    const f = w.spawnFood(520, 500, 0);
    w.spawnFood(1500, 1500, 0); // far away, untouched
    w.tick(TICK_MS);
    expect(f.removed).toBe(true);
    expect(w.removed.get(f.id)).toBe(p.cells[0].id);
    expect(p.totalMass()).toBeCloseTo(101, 5);
    expect(p.stats.foodEaten).toBe(1);
    expect(w.foodCount).toBe(1);
  });

  it('a cell eats another player only at ratio >= 1.25 with enough overlap', () => {
    const w = new World(cfg());
    const big = w.addPlayer({ spawnShield: false, name: 'big', skin: 0, x: 500, y: 500, mass: 200 });
    const small = w.addPlayer({ spawnShield: false, name: 'small', skin: 1, x: 550, y: 500, mass: 100 });
    const events = w.tick(TICK_MS);
    expect(small.cells).toHaveLength(0);
    expect(small.alive).toBe(false);
    expect(big.totalMass()).toBeCloseTo(300, 0);
    expect(events.kills).toHaveLength(1);
    expect(events.kills[0].killer).toBe(big);
    expect(events.kills[0].victim).toBe(small);
    expect(events.cellsEaten[0]).toMatchObject({ eater: big, victim: small, mass: 100, victimTotalBefore: 100, last: true });
    expect(big.stats.playersEaten).toBe(1);
  });

  it('similar sized cells do not eat each other', () => {
    const w = new World(cfg());
    const a = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 500, y: 500, mass: 120 });
    const b = w.addPlayer({ spawnShield: false, name: 'b', skin: 0, x: 500, y: 500, mass: 100 });
    run(w, 500);
    expect(a.cells).toHaveLength(1);
    expect(b.cells).toHaveLength(1);
    expect(allFinite(w)).toBe(true);
  });

  it('needs overlap: touching is not enough', () => {
    const w = new World(cfg());
    const big = w.addPlayer({ spawnShield: false, name: 'big', skin: 0, x: 500, y: 500, mass: 400 }); // r=200
    const small = w.addPlayer({ spawnShield: false, name: 'small', skin: 0, x: 700, y: 500, mass: 100 }); // r=100, d=200 > 200-40
    w.tick(TICK_MS);
    expect(small.cells).toHaveLength(1);
    expect(big.totalMass()).toBeCloseTo(400, 0);
  });

  it('a shielded player can neither be eaten nor eat', () => {
    const w = new World(cfg());
    const big = w.addPlayer({ spawnShield: false, name: 'big', skin: 0, x: 500, y: 500, mass: 400 });
    const small = w.addPlayer({ spawnShield: false, name: 'small', skin: 0, x: 520, y: 500, mass: 50 });
    small.shieldUntil = w.now + 5000;
    run(w, 300);
    expect(small.cells).toHaveLength(1);
    big.shieldUntil = w.now + 5000;
    small.shieldUntil = 0;
    run(w, 300);
    expect(small.cells).toHaveLength(1);
  });
});

describe('world: split & merge', () => {
  it('split halves mass and caps at 16 cells', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1500, y: 1500, mass: 100 });
    w.setTarget(p.id, 2000, 1500);
    w.queueSplit(p.id);
    w.tick(TICK_MS);
    expect(p.cells).toHaveLength(2);
    expect(p.cells[0].mass).toBeCloseTo(50, 5);
    expect(p.cells[1].mass).toBeCloseTo(50, 5);
    // the new half flies toward the target
    expect(p.cells[1].x).toBeGreaterThan(p.cells[0].x);

    const q = w.addPlayer({ spawnShield: false, name: 'b', skin: 0, x: 600, y: 600, mass: 10000 });
    for (let i = 0; i < 4; i++) w.queueSplit(q.id);
    w.tick(TICK_MS);
    w.tick(TICK_MS);
    w.queueSplit(q.id);
    w.tick(TICK_MS);
    expect(q.cells).toHaveLength(16);
    expect(q.totalMass()).toBeGreaterThan(9900);
  });

  /** The widest edge-to-edge gap between the main (biggest) piece and any other piece of `p`. */
  const gapToMain = (p: { cells: { x: number; y: number; r: number; mass: number }[] }) => {
    const big = [...p.cells].sort((a, b) => b.mass - a.mass)[0];
    return Math.max(0, ...p.cells.map((c) => Math.hypot(c.x - big.x, c.y - big.y) - big.r - c.r));
  };
  /** Splits `mass` `splits` times and chases a far target (the mouse kept well ahead) for `ms`: the gap then. */
  const chase = (mass: number, splits: number, ms: number) => {
    const w = new World(cfg({ width: 12_000, height: 12_000 }));
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1500, y: 6000, mass });
    w.setTarget(p.id, 4000, 5900);
    for (let i = 0; i < splits; i++) {
      w.queueSplit(p.id);
      w.tick(TICK_MS);
    }
    for (let t = 0; t < ms; t += TICK_MS) {
      const c = p.center();
      w.setTarget(p.id, c.x + 1500, c.y - 100);
      w.tick(TICK_MS);
    }
    return { w, p, gap: gapToMain(p) };
  };

  it('a split flies a short way (owner playtest: pieces flew too far from the main coin); the launch is as fast as ever', () => {
    // the flight on the boost alone: about 325 units (was about 450 with a 0.04 decay)
    expect(SPLIT_REACH).toBeGreaterThan(300);
    expect(SPLIT_REACH).toBeLessThan(340);
    expect(RULES.splitSpeed).toBe(1440);
    // ejects keep their own (unchanged) flight
    expect(RULES.ejectDecayPerSec).toBe(0.04);
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1000, y: 1500, mass: 400 });
    w.setTarget(p.id, 1000.4, 1500); // the mouse on the coin: the flight alone moves the half
    w.queueSplit(p.id);
    w.tick(TICK_MS);
    const half = p.cells[1];
    const x0 = half.x;
    run(w, 400);
    expect(half.x - x0).toBeGreaterThan(SPLIT_REACH * 0.5);
    expect(half.x - x0).toBeLessThan(SPLIT_REACH * 1.05);
  });

  it('pieces stay close to the main coin while it moves (cohesion before the merge), merge timing unchanged', () => {
    // one split of a small coin chasing: the halves end up touching-close (was a gap of about 360)
    expect(chase(60, 1, 3000).gap).toBeLessThan(90);
    // two splits: about 120 (was about 490), and it keeps closing
    const two = chase(150, 2, 3000);
    expect(two.p.cells).toHaveLength(4);
    expect(two.gap).toBeLessThan(200);
    // a big coin's four pieces draw together over the seconds (was about 835 and staying there)
    const a = chase(1500, 2, 2000).gap;
    const b = chase(1500, 2, 7000).gap;
    expect(b).toBeLessThan(a * 0.7);
    expect(b).toBeLessThan(500);
    // movement only: the pieces still wait their full merge time
    for (const c of two.p.cells) expect(c.mergeAt).toBeGreaterThan(two.w.now);
    expect(two.p.totalMass()).toBeCloseTo(150, 0);
  });

  it('cells below the split threshold do not split', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 500, y: 500, mass: RULES.splitMinMass - 1 });
    w.queueSplit(p.id);
    w.tick(TICK_MS);
    expect(p.cells).toHaveLength(1);
  });

  it('own cells merge back after the merge delay', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1500, y: 1500, mass: 200 });
    w.setTarget(p.id, 1700, 1500);
    w.queueSplit(p.id);
    w.tick(TICK_MS);
    expect(p.cells).toHaveLength(2);
    run(w, mergeDelayMs(200) - 2000);
    expect(p.cells).toHaveLength(2);
    run(w, 6000);
    expect(p.cells).toHaveLength(1);
    expect(p.totalMass()).toBeGreaterThan(195);
  });
});

describe('world: viruses & ejects', () => {
  it('a big cell pops on a virus into many pieces', () => {
    const w = new World(cfg());
    const v = w.spawnVirus(1000, 1000)!;
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1000, y: 1000, mass: 400 });
    const events = w.tick(TICK_MS);
    expect(v.removed).toBe(true);
    expect(events.pops).toHaveLength(1);
    expect(p.cells).toHaveLength(16);
    expect(p.totalMass()).toBeCloseTo(500, 0);
  });

  it('small cells can hide under viruses', () => {
    const w = new World(cfg());
    const v = w.spawnVirus(1000, 1000)!;
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1000, y: 1000, mass: 100 });
    run(w, 1000);
    expect(v.removed).toBe(false);
    expect(p.cells).toHaveLength(1);
  });

  it('eject costs mass and spawns a blob', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 3, x: 1000, y: 1000, mass: 100 });
    w.setTarget(p.id, 1500, 1000);
    w.queueEject(p.id);
    w.tick(TICK_MS);
    expect(p.totalMass()).toBeCloseTo(100 - RULES.ejectCost, 0);
    expect(w.ejects).toHaveLength(1);
    expect(w.ejects[0].mass).toBe(RULES.ejectMass);
    expect(w.ejects[0].skin).toBe(3);
    // cooldown: an immediate second eject is ignored
    w.queueEject(p.id);
    w.tick(TICK_MS);
    expect(w.ejects).toHaveLength(1);
  });

  it('feeding a virus 7 times shoots a new virus in the feed direction', () => {
    const w = new World(cfg());
    const v = w.spawnVirus(1000, 1000)!;
    for (let i = 0; i < 6; i++) {
      w.spawnEject(990, 1000, 300, 0, 99, 0);
      w.tick(TICK_MS);
    }
    expect(w.viruses).toHaveLength(1);
    expect(v.mass).toBeCloseTo(100 + 6 * RULES.ejectMass, 5);
    w.spawnEject(990, 1000, 300, 0, 99, 0);
    w.tick(TICK_MS);
    expect(w.viruses).toHaveLength(2);
    expect(v.mass).toBe(RULES.virusMass);
    const shot = w.viruses.find((x) => x !== v)!;
    run(w, 1000);
    expect(shot.x).toBeGreaterThan(v.x + 200);
  });
});

describe('world: misc', () => {
  it('big cells decay slowly', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1500, y: 1500, mass: 1000 });
    run(w, 1000);
    expect(p.totalMass()).toBeLessThan(1000);
    expect(p.totalMass()).toBeGreaterThan(997);
  });

  it('coincident own cells are pushed apart without NaN', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1500, y: 1500, mass: 100 });
    const second = (w as unknown as { addCell: (...a: unknown[]) => { mergeAt: number } }).addCell(p, 1500, 1500, 100);
    second.mergeAt = w.now + 60_000;
    p.cells[0].mergeAt = w.now + 60_000;
    run(w, 500);
    expect(allFinite(w)).toBe(true);
    const [a, b] = p.cells;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r - 5);
  });

  it('invalid input is ignored', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 500, y: 500 });
    w.setTarget(p.id, Number.NaN, 10);
    w.setTarget(p.id, 10, Number.POSITIVE_INFINITY);
    expect(p.targetX).toBe(500);
    expect(p.targetY).toBe(500);
    w.setTarget(p.id, 1e12, -1e12);
    run(w, 200);
    expect(allFinite(w)).toBe(true);
    expect(p.cells[0].x).toBeLessThanOrEqual(3000);
    expect(p.cells[0].y).toBeGreaterThanOrEqual(0);
  });

  it('keeps food and viruses topped up and spawns airdrops', () => {
    const w = new World(cfg({ foodTarget: 300, virusTarget: 5, powerUps: true, maxPowerUps: 2 }));
    expect(w.foodCount).toBe(300);
    expect(w.viruses).toHaveLength(5);
    run(w, 40_000);
    expect(w.powerUps.length).toBeGreaterThan(0);
    expect(w.powerUps.length).toBeLessThanOrEqual(2);
  });

  it('picking up a power-up grants its effect', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 800, y: 800, mass: 100 });
    w.spawnPowerUp(PowerUpType.Pump, 820, 800);
    const events = w.tick(TICK_MS);
    expect(events.pickups).toHaveLength(1);
    expect(p.pumpUntil).toBeGreaterThan(w.now);
    w.spawnPowerUp(PowerUpType.Bag, 820, 800);
    w.tick(TICK_MS);
    expect(p.totalMass()).toBeGreaterThan(100 + RULES.bagMassMin - 1);
  });

  it('coin rain starts and ends', () => {
    const w = new World(cfg({ coinRain: true, foodTarget: 100, firstCoinRainMs: 1000 }));
    let started = false;
    let ended = false;
    for (let i = 0; i < 30 * 30; i++) {
      const e = w.tick(TICK_MS);
      if (e.coinRain === 'start') started = true;
      if (e.coinRain === 'end') ended = true;
    }
    expect(started).toBe(true);
    expect(ended).toBe(true);
  });

  it('visibility query returns overlapping entities only', () => {
    const w = new World(cfg());
    w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1000, y: 1000, mass: 100 });
    w.spawnFood(1100, 1000, 0);
    w.spawnFood(2500, 2500, 0);
    w.tick(TICK_MS);
    const seen: number[] = [];
    w.forEachVisible(800, 800, 1200, 1200, (e) => seen.push(e.kind));
    expect(seen.filter((k) => k === EntityKind.Food)).toHaveLength(1);
    expect(seen.filter((k) => k === EntityKind.Cell)).toHaveLength(1);
    expect(massToRadius(100)).toBe(100);
  });
});
