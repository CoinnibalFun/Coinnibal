import { RULES, TICK_MS, WORLD_PRESETS } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/bots/brain';
import { BotManager } from '../src/bots/manager';
import { rollPersonality, type Personality } from '../src/bots/personality';
import { OP_GRACE_MS, squadIntel } from '../src/bots/squad';
import type { Player } from '../src/game/entities';
import { mulberry32 } from '../src/game/rng';
import { World, type WorldConfig } from '../src/game/world';

/** A good, steady bot (no random slips in the way). */
const good: Personality = {
  ...rollPersonality(mulberry32(1), { easy: 0, medium: 0, hard: 100 }),
  style: 'balanced',
  aggression: 1,
  greed: 0.8,
  splitBravery: 0,
  aimNoise: 0,
  distraction: 0,
  mistakeRate: 0,
  lapseRate: 0,
  reactionMs: 0,
  thinkMs: 100,
};

const cfg = (over: Partial<WorldConfig> = {}): WorldConfig => ({
  width: 6000,
  height: 6000,
  foodTarget: 0,
  virusTarget: 0,
  maxPowerUps: 0,
  powerUps: false,
  coinRain: false,
  seed: 7,
  ...over,
});

interface Driven {
  player: Player;
  brain: BotBrain;
}

function bot(world: World, x: number, y: number, mass: number, seed: number, p: Personality = good): Driven {
  const player = world.addPlayer({ spawnShield: false, name: `bot${seed}`, skin: 0, x, y, mass, isBot: true });
  const brain = new BotBrain(p, mulberry32(seed));
  brain.pid = player.id;
  brain.maxChasers = 3;
  return { player, brain };
}

function person(world: World, x: number, y: number, mass: number): Player {
  const p = world.addPlayer({ spawnShield: false, name: 'person', skin: 2, x, y, mass });
  p.stats.joinedAt = -OP_GRACE_MS * 2;
  return p;
}

/** Ticks the world; every brain thinks on its own clock, the squad refreshes like the manager does. */
function drive(world: World, bots: Driven[], ms: number, each?: () => void, onEject?: (b: Driven) => void) {
  for (let i = 0; i < Math.ceil(ms / TICK_MS); i++) {
    squadIntel(world).refresh(world, world.now);
    for (const b of bots) {
      if (!b.player.alive || !b.brain.shouldThink(world.now)) continue;
      const d = b.brain.think(world, b.player, world.now);
      if (!d) continue;
      world.setTarget(b.player.id, d.target.x, d.target.y);
      if (d.split) world.queueSplit(b.player.id);
      if (d.eject) {
        world.queueEject(b.player.id);
        onEject?.(b);
      }
    }
    world.tick(TICK_MS);
    each?.();
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('the bot squad', () => {
  it('the trap: a hunter calls a flanker, who heads for the way out ahead of the person', () => {
    const world = new World(cfg());
    const target = person(world, 3000, 3000, 60);
    const pusher = bot(world, 2600, 3000, 400, 1);
    const flanker = bot(world, 3600, 2000, 400, 2);
    // the person runs east, away from the pusher
    world.setTarget(target.id, 5800, 3000);
    const squad = squadIntel(world);
    let recruited = false;
    let closest = Infinity;
    drive(world, [pusher, flanker], 2500, () => {
      const op = squad.op(target.id);
      if (op && op.pusher === pusher.player.id && op.flanker === flanker.player.id) recruited = true;
      if (recruited && target.alive) {
        // the way out: ahead of the person, on the far side from the pusher
        closest = Math.min(closest, dist(flanker.player.center(), { x: target.center().x + 300, y: target.center().y }));
      }
    });
    expect(recruited).toBe(true);
    expect(closest).toBeLessThan(dist({ x: 3600, y: 2000 }, { x: 3300, y: 3000 }));
  });

  it('the trap catches a running person that one hunter alone does not', () => {
    const run = (teamplay: boolean) => {
      const world = new World(cfg({ width: 9000, height: 3000 }));
      squadIntel(world).teamplay = teamplay;
      const target = person(world, 3000, 1500, 70);
      const bots = [bot(world, 2400, 1500, 420, 11), bot(world, 4600, 900, 420, 12)];
      let caught = -1;
      drive(world, bots, 9000, () => {
        if (!target.alive) {
          if (caught < 0) caught = world.now;
          return;
        }
        // the person keeps running east along the middle
        const c = target.center();
        world.setTarget(target.id, c.x + 600, 1500);
      });
      return caught;
    };
    const solo = run(false);
    const trap = run(true);
    expect(trap).toBeGreaterThan(0);
    if (solo > 0) expect(trap).toBeLessThanOrEqual(solo);
  });

  it('the lure: a small bot chased by a person runs to a big teammate, who answers with an ambush', () => {
    const world = new World(cfg());
    const chaser = person(world, 2400, 3000, 300);
    const bait = bot(world, 2800, 3000, 60, 21);
    const big = bot(world, 3900, 3000, 1500, 22);
    const squad = squadIntel(world);
    world.setTarget(chaser.id, 2800, 3000);
    let ambush = false;
    const start = dist(bait.player.center(), big.player.center());
    let nearest = start;
    drive(world, [bait, big], 1500, () => {
      if (!bait.player.alive) return;
      const c = bait.player.center();
      world.setTarget(chaser.id, c.x, c.y);
      // the big teammate answers: ambushing, or hunting the chaser outright
      const op = squad.op(chaser.id);
      if (op && (op.ambusher === big.player.id || op.pusher === big.player.id)) ambush = true;
      nearest = Math.min(nearest, dist(c, big.player.center()));
    });
    expect(ambush).toBe(true);
    expect(nearest).toBeLessThan(start);
  });

  it('feeding: a small teammate tips mass into a pusher that is just short of a split kill', () => {
    const world = new World(cfg());
    // half of 190 cannot eat a 75 coin; a few blobs more and it can
    const target = person(world, 3000, 3000, 75);
    const pusher = bot(world, 2550, 3000, 190, 31);
    const feeder = bot(world, 2400, 2850, 70, 32);
    world.setTarget(target.id, 3000, 3000);
    const squad = squadIntel(world);
    let fed = 0;
    let role = false;
    drive(
      world,
      [pusher, feeder],
      2500,
      () => {
        if (squad.op(target.id)?.feeder === feeder.player.id) role = true;
      },
      (b) => {
        if (b === feeder) fed++;
      },
    );
    expect(role).toBe(true);
    expect(fed).toBeGreaterThan(0);
    expect(fed).toBeLessThanOrEqual(7);
  });

  it('patrol: with nobody in sight, an idle bot drifts toward a person it could eat across the map', () => {
    const world = new World(cfg({ width: 12_000, height: 12_000 }));
    const target = person(world, 10_000, 10_000, 40);
    world.setTarget(target.id, 10_000, 10_000);
    const b = bot(world, 2000, 2000, 300, 41);
    const start = dist(b.player.center(), target.center());
    drive(world, [b], 8000);
    expect(dist(b.player.center(), target.center())).toBeLessThan(start - 1500);
  });

  it('teammates on an operation are never eaten, but idle bots still eat each other now and then', () => {
    const world = new World(cfg());
    const big = bot(world, 3000, 3000, 900, 51);
    const small = bot(world, 3250, 3000, 40, 52, { ...good, caution: 0.01, greed: 0 });
    world.setTarget(small.player.id, 3250, 3000);
    drive(world, [big], 6000, () => {
      if (small.player.alive) world.setTarget(small.player.id, 3250, 3000);
    });
    expect(small.player.alive).toBe(false);

    const w2 = new World(cfg());
    const target = person(w2, 1000, 1000, 60);
    w2.setTarget(target.id, 1000, 1000);
    const b2 = bot(w2, 3000, 3000, 900, 53);
    const mate = bot(w2, 3250, 3000, 40, 54);
    const squad = squadIntel(w2);
    squad.refresh(w2, 0);
    // the small one works an operation on the person (it is the flanker)
    squad.hunt(-99, target.id, 0, 3);
    const op = squad.op(target.id)!;
    op.flanker = mate.player.id;
    (squad as unknown as { roleOf: Map<number, number> }).roleOf.set(mate.player.id, target.id);
    for (let i = 0; i < 40; i++) {
      squad.renew(mate.player.id, w2.now);
      w2.setTarget(mate.player.id, 3250, 3000);
      const d = b2.brain.think(w2, b2.player, w2.now);
      if (d) {
        // never steers onto the teammate
        expect(Math.abs(Math.atan2(d.target.y - 3000, d.target.x - 3000))).toBeGreaterThan(0.2);
      }
      w2.tick(TICK_MS * 3);
    }
  });

  it('the rookie league plays without squad roles; arenas weigh rich people and the last minute higher', () => {
    const world = new World({ ...WORLD_PRESETS.practice, powerUps: false, coinRain: false, seed: 9 });
    const m = new BotManager(world, { target: 6, min: 3, max: 6, teamplay: false }, mulberry32(9));
    m.update(0, 0);
    m.fill(0);
    expect(squadIntel(world).teamplay).toBe(false);
    for (const b of m.bots.values()) expect(b.brain.teamplay).toBe(false);
    expect(squadIntel(world).hunt(1, 2, 0, 3)).toBeNull();

    const w2 = new World(cfg());
    const rich = person(w2, 100, 100, 50);
    const poor = person(w2, 200, 200, 50);
    const squad = squadIntel(w2);
    squad.entryFee = 1000;
    squad.valueOf = (pid) => (pid === rich.id ? 8000 : 1000);
    squad.refresh(w2, 0);
    expect(squad.worth(rich.id)).toBeGreaterThan(squad.worth(poor.id));
    const before = squad.worth(poor.id);
    squad.roundLeftMs = 30_000;
    expect(squad.worth(poor.id)).toBeGreaterThan(before);
  });

  it('roles lapse unless renewed, and a dead or departed bot gives its role back', () => {
    const world = new World(cfg());
    const target = person(world, 3000, 3000, 60);
    const a = bot(world, 2600, 3000, 400, 61);
    const b = bot(world, 3600, 2000, 400, 62);
    const squad = squadIntel(world);
    squad.refresh(world, 0);
    squad.setSkill(a.player.id, 2);
    squad.setSkill(b.player.id, 2);
    const op = squad.hunt(a.player.id, target.id, 0, 3)!;
    expect(op.flanker).toBe(b.player.id);
    expect(squad.busy(b.player.id, 100)).toBe(true);
    b.brain.releaseClaim(world);
    expect(squad.op(target.id)?.flanker).toBe(-1);
    expect(squad.busy(a.player.id, 10_000)).toBe(false);
    expect(RULES.ejectMass).toBeGreaterThan(0);
  });
});
