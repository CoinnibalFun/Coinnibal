import { PlayerFlag, TICK_MS, WORLD_PRESETS, botCountry, botWearsFlag, isCountryCode } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/bots/brain';
import { BotManager } from '../src/bots/manager';
import { rollPersonality, type Personality } from '../src/bots/personality';
import { loadConfig } from '../src/config';
import type { Player } from '../src/game/entities';
import { mulberry32 } from '../src/game/rng';
import { World, type WorldConfig } from '../src/game/world';

const hard: Personality = {
  style: 'hunter',
  skill: 2,
  aggression: 1.4,
  greed: 1,
  caution: 1.1,
  splitBravery: 1,
  thinkMs: 100,
  aimNoise: 0.02,
  perception: 1.05,
  distraction: 0,
  virusAware: true,
  leadsTargets: true,
  virusShooter: true,
  reactionMs: 0,
  predictS: 0.45,
  mistakeRate: 0,
  foodRouting: 1,
  wallSense: 1.25,
  doubleSplit: true,
  chaseMs: 9000,
  // the brain mechanics below are tested without the holding back on people (see 'fair to people')
  humanBias: 1,
  humanSplit: 1,
  humanSplitCooldownMs: 0,
  lapseRate: 0,
};

const emptyCfg = (over: Partial<WorldConfig> = {}): WorldConfig => ({
  width: 3000,
  height: 3000,
  foodTarget: 0,
  virusTarget: 0,
  maxPowerUps: 0,
  powerUps: false,
  coinRain: false,
  seed: 3,
  ...over,
});

/** Drives a single brain-controlled player for `ms`. */
function drive(world: World, brain: BotBrain, bot: Player, ms: number, onDecision?: (split: boolean) => void) {
  const ticks = Math.ceil(ms / TICK_MS);
  for (let i = 0; i < ticks; i++) {
    if (bot.alive && brain.shouldThink(world.now)) {
      const d = brain.think(world, bot, world.now);
      if (d) {
        world.setTarget(bot.id, d.target.x, d.target.y);
        if (d.split) world.queueSplit(bot.id);
        if (d.eject) world.queueEject(bot.id);
        onDecision?.(d.split);
      }
    }
    world.tick(TICK_MS);
  }
}

describe('bots', () => {
  it('flees from a much bigger threat', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 1500, y: 1500, mass: 100 });
    const threat = world.addPlayer({ spawnShield: false, name: 'whale', skin: 1, x: 1880, y: 1500, mass: 900 });
    world.setTarget(threat.id, 1880, 1500);
    const brain = new BotBrain(hard, mulberry32(1));
    const before = Math.hypot(bot.cells[0].x - 1880, bot.cells[0].y - 1500);
    drive(world, brain, bot, 1000);
    expect(bot.alive).toBe(true);
    const after = Math.hypot(bot.center().x - 1880, bot.center().y - 1500);
    expect(after).toBeGreaterThan(before + 150);
    expect(brain.lastDanger).toBeGreaterThan(0);
  });

  it('split-kills reachable prey', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 1000, y: 1000, mass: 400 });
    const prey = world.addPlayer({ spawnShield: false, name: 'snack', skin: 2, x: 1290, y: 1000, mass: 60 });
    prey.stats.joinedAt = -60_000; // a veteran, not a fresh spawn
    world.setTarget(prey.id, 1290, 1000);
    const brain = new BotBrain(hard, mulberry32(2));
    let splits = 0;
    drive(world, brain, bot, 2000, (s) => {
      if (s) splits++;
    });
    expect(splits).toBeGreaterThan(0);
    expect(prey.alive).toBe(false);
  });

  it('never split-attacks a human who just joined', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 1000, y: 1000, mass: 400 });
    const newbie = world.addPlayer({ spawnShield: false, name: 'newbie', skin: 2, x: 1290, y: 1000, mass: 60 });
    world.setTarget(newbie.id, 1290, 1000);
    const brain = new BotBrain(hard, mulberry32(2));
    let splits = 0;
    drive(world, brain, bot, 1500, (s) => {
      if (s) splits++;
    });
    expect(splits).toBe(0);
  });

  it('does not split into prey guarded by a bigger player', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 1000, y: 1000, mass: 400 });
    const prey = world.addPlayer({ spawnShield: false, name: 'snack', skin: 2, x: 1290, y: 1000, mass: 60 });
    const guard = world.addPlayer({ spawnShield: false, name: 'guard', skin: 3, x: 1600, y: 1000, mass: 380 });
    world.setTarget(prey.id, 1290, 1000);
    world.setTarget(guard.id, 1600, 1000);
    const brain = new BotBrain(hard, mulberry32(5));
    let splits = 0;
    drive(world, brain, bot, 600, (s) => {
      if (s) splits++;
    });
    expect(splits).toBe(0);
  });

  it('avoids getting stuck in corners', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 40, y: 40, mass: 50 });
    const brain = new BotBrain({ ...hard, skill: 0, aimNoise: 0.3 }, mulberry32(9));
    drive(world, brain, bot, 3000);
    const c = bot.center();
    expect(Math.max(c.x, c.y)).toBeGreaterThan(250);
  });

  it('headless 3-minute rooms: stable population, finite state, bots grow, and now and then eat each other', () => {
    // bots mostly leave teammates alone (BOT_APPETITE): over two rooms a few still get eaten
    let kills = 0;
    for (const seed of [11, 12]) {
      const world = new World({ ...WORLD_PRESETS.practice, powerUps: true, coinRain: true, seed });
      const manager = new BotManager(world, { target: 18, min: 3, max: 18 }, mulberry32(seed + 1));
      let maxSeen = 0;
      for (let i = 0; i < 180_000 / TICK_MS; i++) {
      const events = world.tick(TICK_MS);
      for (const k of events.kills) {
        kills++;
        manager.onDeath(k.victim.id, world.now);
        world.removePlayer(k.victim.id);
        if (k.killer) manager.onKill(k.killer.id);
      }
      manager.update(world.now, 0);
      maxSeen = Math.max(maxSeen, manager.bots.size);
      if (i % 300 === 0) {
        for (const c of world.cells) {
          expect(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.mass)).toBe(true);
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.x).toBeLessThanOrEqual(world.cfg.width);
        }
      }
    }
    expect(maxSeen).toBeLessThanOrEqual(18);
    expect(manager.bots.size).toBeGreaterThanOrEqual(8);
    const masses = [...manager.bots.values()].map((b) => b.player.totalMass());
    const avg = masses.reduce((a, b) => a + b, 0) / masses.length;
      expect(avg).toBeGreaterThan(60);
    }
    expect(kills).toBeGreaterThan(0);
  }, 120_000);

  it('the squad walks in one by one at random moments, all of it inside the first minute, and people never send it home', () => {
    const world = new World({ ...WORLD_PRESETS.practice, powerUps: false, coinRain: false, seed: 4 });
    const manager = new BotManager(world, { target: 9, min: 6, max: 9 }, mulberry32(4));
    manager.update(0, 0);
    // a room never opens full
    expect(manager.bots.size).toBe(0);
    const sizes: number[] = [];
    const at: number[] = [];
    for (let t = 0; t <= 120_000; t += 250) {
      const before = manager.bots.size;
      manager.update(t, 14);
      if (manager.bots.size > before) at.push(t);
      sizes.push(manager.bots.size);
    }
    // never a burst: at most one more bot per update
    for (let i = 1; i < sizes.length; i++) expect(sizes[i] - sizes[i - 1]).toBeLessThanOrEqual(1);
    // the squad is 6-9, the first 3 within 15 s, every one of them by 55 s; 14 people never pushed one out
    expect(manager.planned).toBeGreaterThanOrEqual(6);
    expect(manager.planned).toBeLessThanOrEqual(9);
    expect(at.length).toBe(manager.planned);
    expect(at[2]).toBeLessThanOrEqual(15_000);
    expect(at[at.length - 1]).toBeLessThanOrEqual(55_000);
    // not all at once either: spread over at least a quarter of a minute
    expect(at[at.length - 1] - at[0]).toBeGreaterThan(15_000);
    expect(manager.bots.size).toBe(manager.planned);
  });

  it('the squad size is rolled evenly from min to the cap (6-9 by default)', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const world = new World({ ...WORLD_PRESETS.practice, powerUps: false, coinRain: false, seed });
      const m = new BotManager(world, { target: 8, min: 6, max: 9 }, mulberry32(seed));
      m.update(0, 0);
      seen.add(m.planned);
    }
    expect([...seen].sort()).toEqual([6, 7, 8, 9]);
  });

  it('rookie mix has ≥ 60% easy bots over 200 rolls', () => {
    const rng = mulberry32(77);
    const rookie = Array.from({ length: 200 }, () => rollPersonality(rng, 'rookie'));
    const easy = rookie.filter((p) => p.skill === 0).length;
    expect(easy / 200).toBeGreaterThanOrEqual(0.6);
    expect(rookie.some((p) => p.skill === 2)).toBe(false);
    // the standard mix still has hard bots
    const standard = Array.from({ length: 200 }, () => rollPersonality(rng, 'standard'));
    expect(standard.some((p) => p.skill === 2)).toBe(true);
    expect(standard.filter((p) => p.skill === 0).length / 200).toBeLessThan(0.6);
  });

  it('bots ignore loot', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 1500, y: 1500, mass: 60, isBot: true });
    // a rich pile of loot to the east, a few plain coins to the west
    const loot = [];
    for (let i = 0; i < 12; i++) loot.push({ x: 1650 + (i % 4) * 30, y: 1460 + Math.floor(i / 4) * 40, value: 1_000_000 });
    world.restoreLoot(loot);
    for (let i = 0; i < 6; i++) world.spawnFood(1300 - i * 25, 1500, 0);
    const brain = new BotBrain({ ...hard, aimNoise: 0 }, mulberry32(3));
    for (let i = 0; i < 20; i++) {
      const d = brain.think(world, bot, world.now + i * 200)!;
      const c = bot.center();
      // never aims at the loot side
      expect(d.target.x).toBeLessThan(c.x);
    }
    expect(world.loot().length).toBe(12);
  });

  it('every room fields at least 3 bots, whatever the people and the admin minimum', () => {
    const cfg = loadConfig({});
    expect(cfg.bots.arena).toEqual({ target: 8, min: 6, max: 9, mix: 'standard' });
    expect(cfg.bots.practiceRookie).toEqual({ target: 8, min: 6, max: 9, mix: 'rookie' });
    expect(cfg.bots.practicePro).toEqual({ target: 8, min: 6, max: 9, mix: 'standard' });
    expect(cfg.bots.private).toEqual({ target: 8, min: 3, max: 8, mix: 'standard' });
    expect(BotManager.desiredOf({ target: 0, min: 0, max: 12 })).toBe(3);
    expect(BotManager.desiredOf({ target: 1, min: 1, max: 12 })).toBe(3);
    // only a cap below 3 (or bots off) fields fewer
    expect(BotManager.desiredOf({ target: 5, min: 3, max: 2 })).toBe(2);
    expect(BotManager.desiredOf({ target: 5, min: 3, max: 12, enabled: false })).toBe(0);

    const world = new World({ ...WORLD_PRESETS.arena, powerUps: false, coinRain: false, seed: 8 });
    const manager = new BotManager(world, { target: 0, min: 0, max: 12 }, mulberry32(8));
    for (let t = 0; t < 120_000; t += 500) manager.update(t, 40);
    expect(manager.bots.size).toBeGreaterThanOrEqual(3);
  });

  it('bots wear basic skins only', () => {
    const world = new World(emptyCfg());
    const manager = new BotManager(world, { target: 0, min: 0, max: 0, mix: 'standard' }, mulberry32(21));
    for (let i = 0; i < 300; i++) expect(manager.spawnBot(30).player.skin).toBeLessThan(8);
  });

  it('bots play for a plausible country, the same one for the same name', () => {
    const world = new World(emptyCfg());
    const manager = new BotManager(world, { target: 0, min: 0, max: 0, mix: 'standard' }, mulberry32(5));
    const flags = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const p = manager.spawnBot(30).player;
      expect(isCountryCode(p.country)).toBe(true);
      expect(p.country).toBe(botCountry(p.name));
      flags.add(p.country!);
    }
    expect(flags.size).toBeGreaterThan(3);
  });

  it('some bots paint their coin with their flag (the flag skin), the same ones by name', () => {
    const world = new World(emptyCfg());
    const manager = new BotManager(world, { target: 0, min: 0, max: 0, mix: 'standard' }, mulberry32(9));
    let worn = 0;
    const n = 120;
    for (let i = 0; i < n; i++) {
      const p = manager.spawnBot(30).player;
      const on = (p.flags & PlayerFlag.FlagSkin) !== 0;
      expect(on).toBe(botWearsFlag(p.name));
      if (on) worn++;
      world.removePlayer(p.id);
    }
    // about BOT_FLAG_SKIN_PERCENT (30 %): some, not all
    expect(worn).toBeGreaterThan(n * 0.1);
    expect(worn).toBeLessThan(n * 0.6);
  });

  it('anticipates a charging threat from beyond its static danger zone', () => {
    const world = new World(emptyCfg({ width: 6000, height: 3000 }));
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 3000, y: 1500, mass: 40 });
    world.setTarget(bot.id, 3000, 1500);
    // a big splitter far to the west (beyond its double-split lunge), charging straight at the bot
    const whale = world.addPlayer({ spawnShield: false, name: 'whale', skin: 1, x: 1700, y: 1500, mass: 400 });
    world.setTarget(whale.id, 6000, 1500);
    const brain = new BotBrain({ ...hard, caution: 1 }, mulberry32(4));
    brain.think(world, bot, world.now); // first look: no velocity known yet
    expect(brain.lastDanger).toBe(0);
    for (let i = 0; i < 3; i++) world.tick(TICK_MS);
    world.setTarget(bot.id, 3000, 1500);
    brain.think(world, bot, world.now);
    expect(brain.lastDanger).toBeGreaterThan(0);
  });

  it('cornered against a wall it slides out the long way instead of dithering into the corner', () => {
    const world = new World(emptyCfg({ width: 6800, height: 6800 }));
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 6500, y: 6300, mass: 300 });
    const whale = world.addPlayer({ spawnShield: false, name: 'whale', skin: 1, x: 5600, y: 5900, mass: 2000 });
    const brain = new BotBrain({ ...hard, skill: 1, doubleSplit: false, virusShooter: false }, mulberry32(1));
    for (let i = 0; i < 300; i++) {
      if (!bot.alive) break;
      const c = bot.center();
      world.setTarget(whale.id, c.x, c.y);
      if (brain.shouldThink(world.now)) {
        const d = brain.think(world, bot, world.now)!;
        world.setTarget(bot.id, d.target.x, d.target.y);
      }
      world.tick(TICK_MS);
    }
    expect(bot.alive).toBe(true);
    expect(bot.center().y).toBeLessThan(5000);
  });

  it('hard bots double-split prey just beyond one split', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 900, y: 1500, mass: 900 });
    const prey = world.addPlayer({ spawnShield: false, name: 'snack', skin: 2, x: 900 + 650, y: 1500, mass: 60, isBot: true });
    prey.stats.joinedAt = -60_000;
    world.setTarget(prey.id, 900 + 650, 1500);
    const brain = new BotBrain(hard, mulberry32(2));
    let splits = 0;
    drive(world, brain, bot, 1500, (s) => {
      if (s) splits++;
    });
    expect(splits).toBeGreaterThanOrEqual(2);
    expect(prey.alive).toBe(false);
  });

  it('ignores ejected bait next to a bush when it would pop', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 1500, y: 1500, mass: 400, isBot: true });
    const v = world.spawnVirus(1800, 1500)!;
    for (let i = 0; i < 5; i++) world.spawnEject(v.x - v.r - 20, 1440 + i * 30, 0, 0, 999, 0);
    for (let i = 0; i < 3; i++) world.spawnFood(1250 - i * 25, 1500, 0);
    const brain = new BotBrain({ ...hard, aimNoise: 0 }, mulberry32(3));
    for (let i = 0; i < 10; i++) {
      const d = brain.think(world, bot, world.now + i * 150)!;
      expect(d.target.x).toBeLessThan(bot.center().x);
    }
  });

  it('heads for a rich coin field it can only see from afar', () => {
    const world = new World(emptyCfg({ width: 6000, height: 3000 }));
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 3000, y: 1500, mass: 40, isBot: true });
    // a dense field 1200 to the east, a few loose coins 900 to the west
    for (let i = 0; i < 80; i++) world.spawnFood(4100 + (i % 10) * 30, 1380 + Math.floor(i / 10) * 30, 0);
    for (let i = 0; i < 4; i++) world.spawnFood(2100 - i * 200, 1500, 0);
    const brain = new BotBrain({ ...hard, aimNoise: 0 }, mulberry32(4));
    const d = brain.think(world, bot, world.now)!;
    expect(d.target.x).toBeGreaterThan(3000);
  });

  it('easy bots notice a new threat only after their reaction delay', () => {
    const world = new World(emptyCfg());
    const bot = world.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 1500, y: 1500, mass: 60 });
    world.addPlayer({ spawnShield: false, name: 'whale', skin: 1, x: 1900, y: 1500, mass: 900 });
    const brain = new BotBrain({ ...hard, skill: 0, distraction: 0, reactionMs: 450 }, mulberry32(5));
    brain.think(world, bot, 1000);
    expect(brain.lastDanger).toBe(0);
    brain.think(world, bot, 1300);
    expect(brain.lastDanger).toBe(0);
    brain.think(world, bot, 1500);
    expect(brain.lastDanger).toBeGreaterThan(0);
  });

  it('thoughts are staggered: a 12-bot room never has more than a quarter of its bots think in one tick', () => {
    const world = new World({ ...WORLD_PRESETS.practice, powerUps: false, coinRain: false, seed: 9 });
    const manager = new BotManager(world, { target: 12, min: 4, max: 12, mix: 'standard' }, mulberry32(9));
    manager.update(0, 0);
    manager.fill();
    const squad = manager.bots.size;
    let thinks = 0;
    const orig = BotBrain.prototype.think;
    BotBrain.prototype.think = function (this: BotBrain, ...args: Parameters<BotBrain['think']>) {
      thinks++;
      return orig.apply(this, args);
    };
    try {
      let most = 0;
      let all = 0;
      for (let i = 0; i < 600; i++) {
        world.tick(TICK_MS);
        thinks = 0;
        manager.update(world.now, 0);
        most = Math.max(most, thinks);
        all += thinks;
      }
      expect(most).toBeLessThanOrEqual(3);
      // every bot still thinks several times a second, well below the 30 Hz tick
      const perBotPerSec = all / squad / (600 / 30);
      expect(perBotPerSec).toBeGreaterThan(2.5);
      expect(perBotPerSec).toBeLessThan(10);
    } finally {
      BotBrain.prototype.think = orig;
    }
  });
});

describe('bot level of detail', () => {
  it('a zero-value bot far from every human thinks less often; near ones and rooms without humans keep the full rate', () => {
    const world = new World({ width: 12_000, height: 12_000, foodTarget: 0, virusTarget: 0, maxPowerUps: 0, powerUps: false, coinRain: false, seed: 3 });
    const mgr = new BotManager(world, { target: 2, min: 2, max: 2 }, mulberry32(9));
    mgr.update(0, 0);
    mgr.fill();
    const [near, far] = [...mgr.bots.values()];
    const thinks = new Map<number, number>();
    for (const b of [near, far]) {
      const orig = b.brain.think.bind(b.brain);
      b.brain.think = (w, p, now) => {
        thinks.set(p.id, (thinks.get(p.id) ?? 0) + 1);
        return orig(w, p, now);
      };
    }
    const pin = (p: Player, x: number, y: number) => {
      for (const c of p.cells) {
        c.x = x;
        c.y = y;
      }
    };
    // no human: both at the full rate
    for (let t = 0; t < 3000; t += TICK_MS) {
      pin(near.player, 1000, 1000);
      pin(far.player, 11_000, 11_000);
      mgr.update(t, 0);
    }
    const alone = { near: thinks.get(near.player.id) ?? 0, far: thinks.get(far.player.id) ?? 0 };
    expect(alone.far).toBeGreaterThan(alone.near * 0.6);
    thinks.clear();
    const human = world.addPlayer({ name: 'me', skin: 0, x: 1200, y: 1200, mass: 50 });
    for (let t = 3000; t < 9000; t += TICK_MS) {
      pin(near.player, 1000, 1000);
      pin(far.player, 11_000, 11_000);
      pin(human, 1200, 1200);
      mgr.update(t, 1);
    }
    const n = thinks.get(near.player.id) ?? 0;
    const f = thinks.get(far.player.id) ?? 0;
    expect(n).toBeGreaterThan(10);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(n * 0.75);
    expect(f).toBeLessThanOrEqual(Math.ceil(6000 / 600) + 1);
  });
});
