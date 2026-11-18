import { CUSTOM_DEFAULTS, EntityKind, PlayerFlag, TICK_MS, VIEW, canEat, viewSize, type CustomRoomSummary } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { BOT_TUNING, BotBrain, botView, levelFor } from '../src/bots/brain';
import { BOT_LEAVE_MAX_MS, BOT_RESPAWN_MS, PracticeBots, type BotSurroundings, type PracticeBot } from '../src/bots/practice';
import { mulberry32 } from '../src/game/rng';
import { World, type WorldConfig } from '../src/game/world';
import { Room } from '../src/rooms/room';
import { ArenaChain, roomDeps } from './helpers';

const emptyCfg = (over: Partial<WorldConfig> = {}): WorldConfig => ({
  width: 4000,
  height: 4000,
  foodTarget: 0,
  virusTarget: 0,
  maxPowerUps: 0,
  powerUps: false,
  coinRain: false,
  seed: 3,
  ...over,
});

const summary = (bots: number): CustomRoomSummary => ({
  durationMin: 30,
  mapSize: 'M',
  bots,
  difficulty: 'mixed',
  food: 'normal',
  traps: 'normal',
  powerUps: true,
  kind: 'free',
  creator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  createdAt: 0,
  endsAt: 1e15,
});

/** One decision of a fresh brain (no randomness in its aim on `hard`). */
function decide(world: World, level: 'easy' | 'normal' | 'hard', pid: number) {
  const brain = new BotBrain(level, mulberry32(9), world.now);
  return brain.think(world, world.players.get(pid)!, world.now)!;
}

describe('practice bots: only in free custom rooms', () => {
  it('a free custom room keeps exactly its count of labelled bots', () => {
    const room = new Room({ id: 'priv-ABCDE', mode: 'private', name: 'Pond', code: 'ABCDE', maxPlayers: 10, bots: { count: 5, difficulty: 'mixed' }, custom: summary(5), seed: 1 }, roomDeps(new ArenaChain([])));
    room.tick(TICK_MS);
    expect(room.bots?.size).toBe(5);
    const bots = [...room.world.players.values()].filter((p) => p.isBot);
    expect(bots.map((b) => b.name).sort()).toEqual(['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4', 'Bot 5']);
    for (const b of bots) {
      expect(b.flags & PlayerFlag.Bot).toBe(PlayerFlag.Bot);
      expect(b.flags & PlayerFlag.Staker).toBe(0);
      expect(b.country).toBeNull();
    }
    expect(room.info().bots).toBe(5);
    // they hold no value: the room has no ledger at all
    expect(room.ledger).toBeNull();
  });

  it('refuses bots in arenas, practice ponds, plain private rooms and paid rooms', () => {
    const deps = roomDeps(new ArenaChain([]));
    const bots = { count: 3, difficulty: 'easy' as const };
    expect(() => new Room({ id: 'arena-1-1', mode: 'arena', name: 'A', instance: 1, maxPlayers: 50, bots, stake: { arenaId: 1, buyIn: 1000 } }, deps)).toThrow(/free custom rooms/);
    expect(() => new Room({ id: 'practice-rookie-1', mode: 'practice', league: 'rookie', name: 'P', maxPlayers: 40, bots }, deps)).toThrow(/free custom rooms/);
    expect(() => new Room({ id: 'priv-X', mode: 'private', name: 'X', maxPlayers: 20, bots }, deps)).toThrow(/free custom rooms/);
    expect(() => new Room({ id: 'priv-P', mode: 'arena', name: 'Paid', code: 'PAIDD', instance: 0, maxPlayers: 20, bots, custom: { ...summary(3), kind: 'paid', arenaId: 1 }, stake: { arenaId: 1, buyIn: 1000 } }, deps)).toThrow(/free custom rooms/);
    // without bots every room kind opens as before
    expect(new Room({ id: 'arena-1-1', mode: 'arena', name: 'A', instance: 1, maxPlayers: 50, bots: null, stake: { arenaId: 1, buyIn: 1000 } }, deps).bots).toBeNull();
    expect(new Room({ id: 'practice-pro-1', mode: 'practice', league: 'pro', name: 'P', maxPlayers: 40 }, deps).bots).toBeNull();
  });

  it('an eaten bot comes back as the same slot after a few seconds', () => {
    const world = new World(emptyCfg());
    const bots = new PracticeBots(world, { count: 2, difficulty: 'easy' }, mulberry32(1));
    bots.update(world.now);
    expect(bots.size).toBe(2);
    const [first] = [...bots.bots.values()];
    const pid = first.player.id;
    world.removePlayer(pid);
    bots.onDeath(pid, world.now);
    expect(bots.size).toBe(1);
    bots.update(world.now + BOT_RESPAWN_MS.min - 1);
    expect(bots.size).toBe(1);
    bots.update(world.now + BOT_RESPAWN_MS.max);
    expect(bots.size).toBe(2);
    expect([...bots.bots.values()].map((b) => b.player.name).sort()).toEqual(['Bot 1', 'Bot 2']);
    expect(bots.removeAll()).toHaveLength(2);
    expect(world.players.size).toBe(0);
  });

  it('difficulty: easy and hard rooms are uniform, mixed rooms take a third of each', () => {
    const rng = mulberry32(4);
    expect(levelFor('easy', rng)).toBe('easy');
    expect(levelFor('hard', rng)).toBe('hard');
    const world = new World(emptyCfg());
    const mixed = new PracticeBots(world, { count: 6, difficulty: 'mixed' }, mulberry32(2));
    mixed.update(world.now);
    const levels = [...mixed.bots.values()].map((b) => b.brain.level).sort();
    expect(levels).toEqual(['easy', 'easy', 'hard', 'hard', 'normal', 'normal']);
    expect(BOT_TUNING.hard.thinkMs).toBeLessThan(BOT_TUNING.easy.thinkMs);
    expect(CUSTOM_DEFAULTS.bots).toBe(0); // rooms are for people unless the creator adds bots
  });
});

describe('practice bots play fair', () => {
  it('see exactly what a person of their size sees (the server view rectangle on a 16:9 screen)', () => {
    const world = new World(emptyCfg({ width: 9000, height: 9000 }));
    const bot = world.addPlayer({ name: 'Bot 1', skin: 0, isBot: true, x: 4500, y: 4500, mass: 100, spawnShield: false });
    const v = botView(bot);
    const size = viewSize(bot.totalMass(), 16 / 9);
    expect(v.x1 - v.x0).toBeCloseTo(size.w * VIEW.serverMargin, 6);
    expect(v.y1 - v.y0).toBeCloseTo(size.h * VIEW.serverMargin, 6);
  });

  it('a threat just outside the view is unknown; inside it, the bot runs away', () => {
    const world = new World(emptyCfg({ width: 9000, height: 9000 }));
    const bot = world.addPlayer({ name: 'Bot 1', skin: 0, isBot: true, x: 4500, y: 4500, mass: 50, spawnShield: false });
    const v = botView(bot);
    // a whale to the right, just beyond the right edge of the view
    const whale = world.addPlayer({ name: 'whale', skin: 1, x: v.x1 + 400, y: 4500, mass: 3000, spawnShield: false });
    const blind = decide(world, 'hard', bot.id);
    // it cannot have seen it: no reason to run left
    world.removePlayer(whale.id);
    const alone = decide(world, 'hard', bot.id);
    expect(blind.target).toEqual(alone.target);
    // the same whale inside the view: the bot heads away from it (to the left)
    world.addPlayer({ name: 'whale', skin: 1, x: 4500 + 500, y: 4500, mass: 3000, spawnShield: false });
    const seen = decide(world, 'hard', bot.id);
    expect(seen.target.x).toBeLessThan(4500);
  });

  it('never sees an invisible coin', () => {
    const world = new World(emptyCfg({ width: 9000, height: 9000 }));
    const bot = world.addPlayer({ name: 'Bot 1', skin: 0, isBot: true, x: 4500, y: 4500, mass: 50, spawnShield: false });
    const whale = world.addPlayer({ name: 'whale', skin: 1, x: 5000, y: 4500, mass: 3000, spawnShield: false });
    whale.invisUntil = world.now + 10_000;
    const hidden = decide(world, 'hard', bot.id);
    world.removePlayer(whale.id);
    const alone = decide(world, 'hard', bot.id);
    expect(hidden.target).toEqual(alone.target);
  });

  it('easy bots never hunt or split; hard bots split on a reachable prey', () => {
    const world = new World(emptyCfg({ width: 9000, height: 9000 }));
    const bot = world.addPlayer({ name: 'Bot 1', skin: 0, isBot: true, x: 4500, y: 4500, mass: 400, spawnShield: false });
    world.addPlayer({ name: 'snack', skin: 1, x: 4800, y: 4500, mass: 60, spawnShield: false });
    let splits = 0;
    let chases = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const d = new BotBrain('hard', mulberry32(seed), world.now).think(world, bot, world.now)!;
      if (d.split) splits++;
      if (d.target.x > 4500) chases++;
    }
    // a hard bot goes for the prey on most decisions (it has a few distracted moments)
    expect(chases).toBeGreaterThanOrEqual(14);
    expect(splits).toBeGreaterThan(0);
    for (let seed = 1; seed <= 20; seed++) expect(new BotBrain('easy', mulberry32(seed), world.now).think(world, bot, world.now)!.split).toBe(false);
  });

  it('a headless 2-minute room of bots stays finite and keeps its count', () => {
    const room = new Room({ id: 'priv-SIMUL', mode: 'private', name: 'Sim', code: 'SIMUL', maxPlayers: 10, bots: { count: 8, difficulty: 'mixed' }, custom: summary(8), seed: 11 }, roomDeps(new ArenaChain([])));
    for (let i = 0; i < (120_000 / TICK_MS); i++) room.tick(TICK_MS);
    expect(room.bots!.size).toBeGreaterThanOrEqual(6); // a few may be waiting to come back
    for (const p of room.world.players.values()) {
      for (const c of p.cells) {
        expect(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.mass)).toBe(true);
      }
    }
    // bots ate food (they move with purpose)
    let food = 0;
    for (const p of room.world.players.values()) food += p.stats.foodEaten;
    expect(food).toBeGreaterThan(0);
    // only food, coins and cacti exist on a free map: no loot
    expect([...room.world.entities.values()].some((e) => e.kind === EntityKind.Loot)).toBe(false);
  });
});

describe('practice bots make room for people (the testnet test arenas)', () => {
  /** `count` bots playing on a big empty map and one person in the middle (none of them shielded). */
  function setup(count = 3, arriveMs = 0) {
    const world = new World(emptyCfg({ width: 9000, height: 9000 }));
    const bots = new PracticeBots(world, { count, difficulty: 'easy', makeRoom: true, arriveMs }, mulberry32(3));
    bots.update(world.now);
    const person = world.addPlayer({ name: 'P', skin: 0, x: 4500, y: 4500, mass: 100, spawnShield: false });
    const list = [...bots.bots.values()];
    for (const b of list) b.player.shieldUntil = 0;
    return { world, bots, person, list };
  }
  const put = (b: PracticeBot, x: number, y: number, mass: number) => {
    const c = b.player.cells[0];
    c.x = x;
    c.y = y;
    c.setMass(mass);
  };
  const run = (world: World, bots: PracticeBots, around: BotSurroundings, ms: number) => {
    const gone = [];
    for (let t = 0; t < ms; t += TICK_MS) {
      world.tick(TICK_MS);
      gone.push(...bots.update(world.now, around));
    }
    return gone;
  };

  it('the setting is the bots of an empty room: each person takes one place, never below 0', () => {
    const { bots } = setup(3);
    expect(bots.size).toBe(3);
    expect([0, 1, 2, 3, 4, 7].map((n) => bots.targetFor(n))).toEqual([3, 2, 1, 0, 0, 0]);
    // a free custom room keeps its creator's count, people or not
    const world = new World(emptyCfg());
    const own = new PracticeBots(world, { count: 3, difficulty: 'easy' }, mulberry32(1));
    expect(own.targetFor(5)).toBe(3);
  });

  it('the bot that leaves is out of the way: in no chase with a person, the farthest from the people', () => {
    const { bots, person, list } = setup(3);
    const [chaser, far, mid] = list;
    put(chaser, 4700, 4500, 400); // right next to the person and able to eat it
    put(far, 8500, 8500, 30);
    put(mid, 6000, 4500, 30);
    expect(canEat(400, person.totalMass())).toBe(true);
    // somebody sees it: it swims off first (still in the world, no longer playing)
    expect(bots.fit({ people: [person], seen: () => true })).toEqual([]);
    expect(far.leaving).toMatchObject({ reason: 'make_room' });
    expect(chaser.leaving).toBeUndefined();
    expect(mid.leaving).toBeUndefined();
    expect([bots.size, bots.leavingCount, bots.bots.size]).toEqual([2, 1, 3]);
  });

  it('every bot in a chase with a person: the smallest leaves', () => {
    const { bots, person, list } = setup(3);
    const [a, b, c] = list;
    put(a, 4700, 4500, 400); // could eat the person
    put(b, 4300, 4500, 300); // could eat the person
    put(c, 4500, 4650, 40); // the person could eat it
    bots.fit({ people: [person], seen: () => true });
    expect(c.leaving).toBeTruthy();
    expect(a.leaving ?? b.leaving).toBeUndefined();
  });

  it('a leaving bot is harmless (it eats nobody, nobody eats it) and is gone once nobody sees it, at the latest after BOT_LEAVE_MAX_MS', () => {
    const { world, bots, person, list } = setup(1);
    const [bot] = list;
    put(bot, 4510, 4500, 2000); // right on top of the person: without its shield it would eat it at once
    let seen = true;
    const around: BotSurroundings = { people: [person], seen: () => seen };
    bots.fit(around);
    expect(bot.leaving).toBeTruthy();
    expect(run(world, bots, around, 1000)).toEqual([]);
    expect(person.alive).toBe(true);
    expect(person.totalMass()).toBeGreaterThan(90);
    // a big person over it cannot eat it either
    const c = bot.player.center();
    person.cells[0].x = c.x;
    person.cells[0].y = c.y;
    person.cells[0].setMass(20_000);
    expect(run(world, bots, around, 1000)).toEqual([]);
    expect(bot.player.alive).toBe(true);
    // it swims off; still seen when its time is up: it goes anyway
    const gone = run(world, bots, around, BOT_LEAVE_MAX_MS);
    expect(gone.map((g) => [g.player.id, g.reason])).toEqual([[bot.player.id, 'make_room']]);
    expect(world.players.has(bot.player.id)).toBe(false);
    expect(bots.bots.size).toBe(0);
    expect(bots.left).toBe(1);
    // nobody sees the next one: it goes at once
    seen = false;
    bots.reconfigure(2, 'easy', { people: [person], seen: () => false });
    run(world, bots, { people: [], seen: () => false }, 200);
    expect(bots.size).toBe(2);
    const out = bots.fit({ people: [person], seen: () => false });
    expect(out).toHaveLength(1);
    expect(bots.bots.size).toBe(1);
  });

  it('a person gone: the bots come back one by one with the arrival pacing, never above the setting', () => {
    const gap = 4000;
    const { world, bots, person } = setup(3, gap);
    // the room fills one by one
    run(world, bots, { people: [], seen: () => false }, 20_000);
    expect(bots.size).toBe(3);
    const crowd = [person, ...[1, 2, 3].map((i) => world.addPlayer({ name: `P${i}`, skin: 0, x: 1000 * i, y: 1000, mass: 100, spawnShield: false }))];
    // four people: no bot plays (never below 0)
    bots.fit({ people: crowd, seen: () => false });
    expect([bots.size, bots.bots.size, bots.arriving]).toEqual([0, 0, 0]);
    // everyone leaves: the bots come back about `gap` apart, the first about `gap` after
    const back: number[] = [];
    const t0 = world.now;
    for (let t = 0; t < 30_000; t += TICK_MS) {
      world.tick(TICK_MS);
      const before = bots.size;
      bots.update(world.now, { people: [], seen: () => false });
      expect(bots.bots.size).toBeLessThanOrEqual(3);
      if (bots.size > before) back.push(world.now - t0);
      expect(bots.size - before).toBeLessThanOrEqual(1);
    }
    expect(back).toHaveLength(3);
    expect(back[0]).toBeGreaterThanOrEqual(gap * 0.6);
    for (let i = 1; i < back.length; i++) expect(back[i] - back[i - 1]).toBeGreaterThanOrEqual(gap * 0.6 - TICK_MS);
  });

  it('a bot on its way in is called off first (nothing leaves the world); an eaten bot does not come back while the room is full of people', () => {
    const { world, bots, person, list } = setup(2);
    // one bot was eaten: it waits to come back
    world.removePlayer(list[0].player.id);
    bots.onDeath(list[0].player.id, world.now);
    expect([bots.size, bots.arriving]).toEqual([1, 1]);
    // a person arrives: the comeback is called off, the playing bot stays
    bots.fit({ people: [person], seen: () => true });
    expect([bots.size, bots.arriving, bots.leavingCount]).toEqual([1, 0, 0]);
    run(world, bots, { people: [person], seen: () => true }, BOT_RESPAWN_MS.max + 1000);
    expect(bots.size).toBe(1);
  });

  it('a lower setting: the extra bots leave the same way (reason settings), the rest keep playing', () => {
    const { bots } = setup(3);
    const gone = bots.reconfigure(1, 'easy');
    expect(gone.map((g) => g.reason)).toEqual(['settings', 'settings']);
    expect([bots.size, bots.bots.size]).toEqual([1, 1]);
  });
});
