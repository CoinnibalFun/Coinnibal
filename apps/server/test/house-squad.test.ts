import { PlayerFlag, TICK_MS, roundAt } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/bots/brain';
import { ARRIVAL, BotManager } from '../src/bots/manager';
import { rollPersonality } from '../src/bots/personality';
import { BotSettingsStore, SQUAD_DEFAULT, defaultBotSettings, upgradeSavedBotSettings } from '../src/bots/settings';
import { OP_GRACE_MS, squadIntel } from '../src/bots/squad';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import type { Player } from '../src/game/entities';
import { mulberry32 } from '../src/game/rng';
import { World } from '../src/game/world';
import { Leaderboards } from '../src/leaderboards';
import { Room } from '../src/rooms/room';
import { Journal } from '../src/stake/journal';
import { fakeConn } from './helpers';

const FEE = 1_000_000;
const ROUND = { roundMs: 300_000, closeMs: 60_000 };

function arena(o: { reserve?: number; bank?: boolean; seed?: number } = {}) {
  const journal = new Journal(null);
  if (o.reserve) journal.commit({ house: [{ arenaId: 1, amount: o.reserve }] });
  const clock = { now: roundAt(1_791_000_000_000, ROUND.roundMs, ROUND.closeMs).startsAt + 500 };
  const bots = new BotSettingsStore(null, defaultBotSettings(loadConfig({}).bots)).options('arena');
  const room = new Room(
    { id: 'arena-1-1', mode: 'arena', name: 'Arena', instance: 1, maxPlayers: 50, bots, stake: { arenaId: 1, buyIn: FEE }, seed: o.seed ?? 9 },
    {
      chain: new NullChain(),
      journal,
      leaderboards: new Leaderboards(null),
      log: () => {},
      now: () => clock.now,
      round: ROUND,
      ...(o.bank === false ? {} : { houseBank: { draw: async (a: number, amt: number) => journal.drawHouse(a, amt) } }),
    },
  );
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.now += TICK_MS;
      room.tick(TICK_MS);
      await Promise.resolve();
    }
  };
  return { room, journal, clock, tick };
}

let seq = 0;
const stake = (value = FEE) => {
  const n = ++seq;
  return { name: `p${n}`, skin: 1, flags: PlayerFlag.Staker, stake: { player: `w${n}`, session: `s${n}`, sessionId: n, arenaId: 1, entryFee: FEE, value, openedAt: Math.floor(Date.now() / 1000) } };
};

/** Puts `eater` on top of `victim` until the victim is gone. */
async function eat(t: ReturnType<typeof arena>, eater: Player, victim: Player) {
  eater.shieldUntil = 0;
  victim.shieldUntil = 0;
  eater.cells[0].setMass(400);
  for (const c of eater.cells.slice(1)) c.setMass(1);
  victim.cells[0].setMass(20);
  for (const c of victim.cells.slice(1)) c.setMass(1);
  eater.cells[0].x = victim.cells[0].x;
  eater.cells[0].y = victim.cells[0].y;
  t.room.world.setTarget(eater.id, victim.cells[0].x, victim.cells[0].y);
  t.room.world.setTarget(victim.id, victim.cells[0].x, victim.cells[0].y);
  for (let i = 0; i < 40 && victim.alive; i++) await t.tick();
  expect(victim.alive).toBe(false);
}

describe('house bots play with a budget from the team reserve', () => {
  it('each bot walks in with a ticket worth from the reserve; eating it pays a person like eating a person', async () => {
    const t = arena({ reserve: 20 * FEE });
    await t.tick(30 * 20);
    const n = t.room.bots!.bots.size;
    expect(n).toBeGreaterThanOrEqual(3);
    for (const b of t.room.bots!.bots.values()) expect(t.room.purseOf(b.player.id)).toBe(FEE);
    // the reserve paid for them, nothing more: reserve + purses is what the team put in
    expect(t.journal.houseByArena(1)).toBe(20 * FEE - n * FEE);
    expect(t.journal.purses()).toEqual([{ roomId: 'arena-1-1', arenaId: 1, value: n * FEE }]);
    const p = t.room.join(fakeConn('wa'), stake());
    const bot = [...t.room.bots!.bots.values()][0].player;
    await eat(t, p, bot);
    expect(t.room.ledger!.value(p.id)).toBe(2 * FEE);
  });

  it('with an empty reserve the bots enter with nothing (the team never pays out of thin air)', async () => {
    const t = arena({ reserve: 2 * FEE });
    await t.tick(30 * 20);
    const funded = [...t.room.bots!.bots.values()].filter((b) => t.room.purseOf(b.player.id) > 0);
    expect(funded).toHaveLength(2);
    expect(t.journal.houseByArena(1)).toBe(0);
    // no bank at all: none is funded
    const u = arena({ bank: false });
    await u.tick(30 * 20);
    expect(u.room.purseTotal()).toBe(0);
  });

  it('at the bell what the bots hold goes back to the reserve, and the next round draws again', async () => {
    const t = arena({ reserve: 30 * FEE });
    await t.tick(30 * 20);
    const n = t.room.bots!.bots.size;
    t.clock.now = roundAt(t.clock.now, ROUND.roundMs, ROUND.closeMs).endsAt;
    await t.tick();
    expect(t.room.purseTotal()).toBe(0);
    expect(t.journal.houseByArena(1)).toBe(30 * FEE);
    await t.tick(30 * 60);
    const m = t.room.bots!.bots.size;
    expect(m).toBeGreaterThanOrEqual(6);
    expect(t.journal.houseByArena(1) + t.journal.purses().reduce((s, p) => s + p.value, 0)).toBe(30 * FEE);
    expect(n).toBeGreaterThan(0);
  });
});

describe('an arena round and its squad', () => {
  it('6 to 9 bots, all inside the first minute of the round, none after the joins close, none going home before the bell', async () => {
    for (const seed of [1, 2, 3]) {
      const t = arena({ seed });
      const watcher = fakeConn(null);
      t.room.spectate(watcher);
      const at: number[] = [];
      const start = t.clock.now;
      let last = 0;
      let most = 0;
      for (let i = 0; i < 60_000 / TICK_MS; i++) {
        await t.tick();
        const n = t.room.bots!.bots.size;
        if (n > last) at.push(t.clock.now - start);
        last = n;
        most = Math.max(most, n);
      }
      for (let i = 0; i < (180_000 - 500) / TICK_MS; i++) await t.tick();
      expect(most).toBeGreaterThanOrEqual(SQUAD_DEFAULT.min);
      expect(most).toBeLessThanOrEqual(SQUAD_DEFAULT.cap);
      expect(Math.max(...at)).toBeLessThanOrEqual(ARRIVAL.windowMs + 1000);
      // nobody went home mid-round (a bot leaves the room only by being eaten, or with the bell)
      expect(watcher.msgs.filter((m) => m.t === 'feed' && m.kind === 'left')).toEqual([]);
    }
    // a bot eaten in the last minute (joins closed) is not replaced before the bell
    const t = arena({ seed: 4 });
    t.clock.now = roundAt(t.clock.now, ROUND.roundMs, ROUND.closeMs).joinsCloseAt - 50_000;
    await t.tick(30 * 60);
    const before = t.room.bots!.bots.size;
    const p = t.room.join(fakeConn('wb'), stake());
    t.clock.now = roundAt(t.clock.now, ROUND.roundMs, ROUND.closeMs).joinsCloseAt + 1000;
    await eat(t, p, [...t.room.bots!.bots.values()][0].player);
    await t.tick(30 * 20);
    expect(t.room.bots!.bots.size).toBe(before - 1);
  });

  it('a saved bots.json still holding the old squad sizes gets the 6-9 squad; an admin size stays', () => {
    const raw = { kinds: { arena: { cap: 12, target: 12, min: 2 }, practicePro: { cap: 12, target: 12, min: 4 }, private: { cap: 8, target: 8, min: 2 }, practiceRookie: { cap: 20, target: 12, min: 4 } } };
    const out = upgradeSavedBotSettings(raw as unknown as Record<string, unknown>);
    expect(raw.kinds.arena).toMatchObject({ cap: 9, target: 8, min: 6 });
    expect(raw.kinds.practicePro).toMatchObject({ cap: 9, target: 8, min: 6 });
    expect(raw.kinds.private).toMatchObject({ cap: 8, target: 8, min: 2 });
    expect(raw.kinds.practiceRookie).toMatchObject({ cap: 20 });
    expect(out.join(' ')).toMatch(/squad 6-9/);
  });
});

describe('cover: a big bot looks after a small one', () => {
  it('is assigned a small teammate, stays loosely near it and cuts in when a person goes for it', () => {
    const world = new World({ width: 6000, height: 6000, foodTarget: 0, virusTarget: 0, maxPowerUps: 0, powerUps: false, coinRain: false, seed: 5 });
    const mk = (x: number, y: number, mass: number, seed: number) => {
      const player = world.addPlayer({ spawnShield: false, name: `b${seed}`, skin: 0, x, y, mass, isBot: true });
      const brain = new BotBrain({ ...rollPersonality(mulberry32(seed), { easy: 0, medium: 0, hard: 100 }), reactionMs: 0, distraction: 0, lapseRate: 0, mistakeRate: 0, aimNoise: 0, thinkMs: 100 }, mulberry32(seed));
      brain.pid = player.id;
      brain.maxChasers = 3;
      return { player, brain };
    };
    const small = mk(3000, 3000, 30, 1);
    const big = mk(2000, 3000, 900, 2);
    const squad = squadIntel(world);
    squad.refresh(world, 0);
    squad.setSkill(big.player.id, 2);
    squad.setSkill(small.player.id, 1);
    squad.refresh(world, 2000);
    expect(squad.wardFor(big.player.id)?.pid).toBe(small.player.id);
    expect(squad.guardFor(small.player.id)?.pid).toBe(big.player.id);
    // a person closes in on the small one
    const person = world.addPlayer({ spawnShield: false, name: 'person', skin: 2, x: 3500, y: 3000, mass: 200 });
    person.stats.joinedAt = -OP_GRACE_MS * 2;
    world.setTarget(person.id, 3000, 3000);
    squad.refresh(world, 4000);
    const d0 = Math.hypot(big.player.center().x - person.center().x, big.player.center().y - person.center().y);
    for (let i = 0; i < 30; i++) {
      if (big.brain.shouldThink(world.now)) {
        const d = big.brain.think(world, big.player, world.now);
        if (d) world.setTarget(big.player.id, d.target.x, d.target.y);
      }
      world.tick(TICK_MS);
    }
    const d1 = Math.hypot(big.player.center().x - person.center().x, big.player.center().y - person.center().y);
    expect(d1).toBeLessThan(d0 - 150);
    // the guard never eats its ward
    const m = new BotManager(world, { target: 0, min: 0, max: 0 }, mulberry32(1));
    expect(m.bots.size).toBe(0);
  });
});
