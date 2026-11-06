import { CUSTOM_DEFAULTS, EntityKind, PlayerFlag, TICK_MS, VIEW, viewSize, type CustomRoomSummary } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { BOT_TUNING, BotBrain, botView, levelFor } from '../src/bots/brain';
import { BOT_RESPAWN_MS, PracticeBots } from '../src/bots/practice';
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
    for (let seed = 1; seed <= 20; seed++) {
      const d = new BotBrain('hard', mulberry32(seed), world.now).think(world, bot, world.now)!;
      if (d.split) splits++;
      expect(d.target.x).toBeGreaterThan(4500);
    }
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
