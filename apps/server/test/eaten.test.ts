/**
 * The eaten list of a result ("who you ate this round"): the tracker's rules, and a room's real kills feeding it.
 * People count everywhere; practice bots only in a testnet test arena (tagged BOT). A split coin is one coin; the same
 * person eaten again (a rejoin, same wallet) is one entry ×2. Names are cleaned for a share card and an X post.
 */
import { EATEN_SHOWN, ROBINHOOD_TESTNET_CHAIN_ID, TICK_MS, eatenLine, shareName, type DeathStats, type ServerMessage } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import type { Player } from '../src/game/entities';
import { EatenTracker } from '../src/rooms/eaten';
import { Room, type RoomOptions } from '../src/rooms/room';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { ArenaChain, arena, fakeConn, freeCustom, roomDeps, stakeJoin, testWallet } from './helpers';

const FEE = 1_000_000;

describe('the eaten tracker', () => {
  it('counts each coin once, most eaten first, the first EATEN_SHOWN and "+N"', () => {
    const t = new EatenTracker(false);
    const names = ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus'];
    names.forEach((name, i) => t.note(1, { pid: 10 + i, name, bot: false, wallet: null }));
    // Gus again, by a new pid (a rejoin): one entry, eaten twice
    t.note(1, { pid: 99, name: 'Gus', bot: false, wallet: null });
    const r = t.take(1)!;
    expect(r.eaten).toHaveLength(EATEN_SHOWN);
    expect(r.eaten[0]).toEqual({ name: 'Gus', n: 2 });
    expect(r.eaten.slice(1).map((e) => e.name)).toEqual(['Ann', 'Bo', 'Cy', 'Di']);
    expect(r.eatenMore).toBe(2);
    // taken: forgotten
    expect(t.take(1)).toBeNull();
  });

  it('knows a person by wallet (a new name after a rejoin is still the same coin)', () => {
    const t = new EatenTracker(false);
    t.note(1, { pid: 2, name: 'Penny', bot: false, wallet: testWallet(7) });
    t.note(1, { pid: 3, name: 'Penny2', bot: false, wallet: testWallet(7).toLowerCase() });
    expect(t.take(1)).toEqual({ eaten: [{ name: 'Penny', n: 2 }], eatenMore: 0 });
  });

  it('bots count in a test arena only, tagged; never oneself', () => {
    const official = new EatenTracker(false);
    official.note(1, { pid: 2, name: 'Botty', bot: true, wallet: null });
    official.note(1, { pid: 1, name: 'Me', bot: false, wallet: null });
    expect(official.take(1)).toBeNull();
    const test = new EatenTracker(true);
    test.note(1, { pid: 2, name: 'Botty', bot: true, wallet: null });
    test.note(1, { pid: 3, name: 'Botty', bot: false, wallet: null });
    // a bot and a person of the same name are two coins
    expect(test.take(1)).toEqual({ eaten: [{ name: 'Botty', bot: true }, { name: 'Botty' }], eatenMore: 0 });
  });

  it('stores names cleaned: no invisible characters, addresses, mentions, hashtags or links; 16 characters at most', () => {
    const t = new EatenTracker(false);
    t.note(1, { pid: 2, name: '@elonmusk', bot: false, wallet: null });
    t.note(1, { pid: 3, name: 'evil.com/x', bot: false, wallet: null });
    t.note(1, { pid: 4, name: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', bot: false, wallet: null });
    t.note(1, { pid: 5, name: 'a\u202Eb\u200B#tag', bot: false, wallet: null });
    t.note(1, { pid: 6, name: '\u200B\u200B', bot: false, wallet: null });
    const r = t.take(1)!;
    // nothing usable left: a placeholder
    expect(r.eaten.map((e) => e.name)).toEqual(['elonmusk', 'evil\u00B7com x', '0x…', 'abtag', '???']);
    expect(r.eatenMore).toBe(0);
    for (const e of r.eaten) {
      expect(e.name).not.toMatch(/[@#$]|https?|:\/\/|[0-9a-f]{10,}/i);
      expect(Array.from(e.name).length).toBeLessThanOrEqual(16);
    }
    expect(shareName('A very very long coin name')).toBe('A very very long');
    expect(shareName('')).toBe('???');
    expect(eatenLine([{ name: 'Penny' }, { name: 'Rocky', n: 2 }, { name: 'Zed', bot: true }], 3)).toBe('Penny, Rocky \u00D72, Zed (BOT) +3');
    expect(eatenLine([], 4)).toBe('+4');
    expect(eatenLine([])).toBe('');
  });
});

/** Puts `eater` right over `victim` with a much bigger mass and ticks until the victim is gone. */
function eat(room: Room, eater: Player, victim: Player): void {
  eater.shieldUntil = 0;
  victim.shieldUntil = 0;
  const c = victim.center();
  const m = Math.max(victim.totalMass(), 50) * 6;
  for (const cell of eater.cells) {
    cell.x = c.x;
    cell.y = c.y;
    cell.setMass(m / eater.cells.length);
  }
  for (let i = 0; i < 80 && victim.alive; i++) {
    const v = victim.center();
    for (const cell of eater.cells) {
      cell.x = v.x;
      cell.y = v.y;
    }
    room.tick(TICK_MS);
  }
  expect(victim.alive).toBe(false);
}

describe('a room feeds the eaten list into my game-over stats', () => {
  it('a free custom room: people only (its practice bots never count), a split victim once, a rejoined victim ×2', () => {
    const over: DeathStats[] = [];
    const deps = { ...roomDeps(new ArenaChain([])), onGameOver: (e: { stats: DeathStats; player: { name: string } }) => e.player.name === 'Whale' && over.push(e.stats) };
    const room = new Room({ id: 'priv-EATEN', mode: 'private', code: 'EATEN', name: 'Eaten', maxPlayers: 10, bots: { count: 2, difficulty: 'easy', max: 4 }, custom: freeCustom(2), seed: 9 }, deps);
    room.tick(TICK_MS);
    const a = fakeConn(null);
    const whale = room.join(a, { name: 'Whale', skin: 1, flags: 0 });
    // a split victim: two cells, one coin
    const b = fakeConn(testWallet(0xb0b));
    const bob = room.join(b, { name: 'Bob', skin: 2, flags: 0 });
    bob.cells[0].setMass(400);
    bob.splitQueued = 1;
    room.tick(TICK_MS);
    expect(bob.cells.length).toBeGreaterThan(1);
    eat(room, whale, bob);
    // Bob comes back (same wallet, a new coin) and is eaten again
    const bob2 = room.join(b, { name: 'Bob', skin: 2, flags: 0 });
    eat(room, whale, bob2);
    // a practice bot of the room: eaten, not listed
    const bot = [...room.bots!.bots.values()][0].player;
    eat(room, whale, bot);
    room.leave(a, 'left');
    expect(over).toHaveLength(1);
    expect(over[0].eaten).toEqual([{ name: 'Bob', n: 2 }]);
    expect(over[0].eatenMore).toBe(0);
  });

  it('a split eater: its cells share one list', () => {
    const over: DeathStats[] = [];
    const deps = { ...roomDeps(new ArenaChain([])), onGameOver: (e: { stats: DeathStats; player: { name: string } }) => e.player.name === 'Whale' && over.push(e.stats) };
    const room = new Room({ id: 'priv-SPLIT', mode: 'private', code: 'SPLIT', name: 'Split', maxPlayers: 10, bots: null, custom: freeCustom(), seed: 3 }, deps);
    const a = fakeConn(null);
    const whale = room.join(a, { name: 'Whale', skin: 1, flags: 0 });
    whale.cells[0].setMass(2000);
    whale.splitQueued = 1;
    room.tick(TICK_MS);
    expect(whale.cells.length).toBeGreaterThan(1);
    for (const name of ['Ann', 'Bo']) eat(room, whale, room.join(fakeConn(null), { name, skin: 2, flags: 0 }));
    room.leave(a, 'left');
    expect(over[0].eaten).toEqual([{ name: 'Ann' }, { name: 'Bo' }]);
    expect(over[0].playersEaten).toBe(2);
  });

  it('a testnet test arena: eating a practice bot lists it tagged BOT, and every bot eaten is a kill to share', () => {
    const over: DeathStats[] = [];
    const kills: { victim: string; victimIsBot?: boolean }[] = [];
    const deps = {
      ...roomDeps(new ArenaChain([])),
      onGameOver: (e: { stats: DeathStats }) => over.push(e.stats),
      onNotableKill: (e: { victim: string; victimIsBot?: boolean }) => kills.push({ victim: e.victim, victimIsBot: e.victimIsBot }),
    };
    const opts: RoomOptions = {
      id: 'test-1',
      mode: 'arena',
      name: 'Test · Arena',
      instance: 0,
      maxPlayers: 50,
      stake: { arenaId: 1, buyIn: FEE },
      test: { chainId: ROBINHOOD_TESTNET_CHAIN_ID },
      bots: { count: 3, difficulty: 'easy', max: 20 },
      seed: 5,
    };
    const room = new Room(opts, deps);
    room.tick(TICK_MS);
    const j = stakeJoin(1, FEE);
    const p = room.join(fakeConn(j.stake.player), j);
    const [small, big] = [...room.bots!.bots.values()].map((b) => b.player);
    eat(room, p, small);
    big.stats.maxMass = 1050;
    eat(room, p, big);
    room.shutdown();
    expect(over).toHaveLength(1);
    expect(over[0].eaten).toEqual([
      { name: shareName(small.name), bot: true },
      { name: shareName(big.name), bot: true },
    ]);
    expect(kills).toEqual([
      { victim: small.name, victimIsBot: true },
      { victim: big.name, victimIsBot: true },
    ]);
    // bots carry no value: the ticket is worth its entry fee
    expect(room.ledger!.total()).toBe(0);
  });
});

describe('the app: a test arena result card', () => {
  it('the bell of a test arena sends a TEST card naming the eaten bots; the game counts in no profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-eaten-'));
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, TRUST_PROXY: '0', GAME_ACCESS: 'public', NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    const app = await createApp(cfg, { chain: new ArenaChain([arena(1, FEE)]), log: () => {}, persist: false });
    try {
      const room = app.rooms.testRooms()[0] as unknown as Room;
      expect(room?.opts.test).toBeTruthy();
      room.tick(TICK_MS);
      const j = stakeJoin(1, FEE);
      const conn = fakeConn(j.stake.player);
      const p = room.join(conn, j);
      const bot = [...room.bots!.bots.values()][0].player;
      eat(room, p, bot);
      room.syncRound(room.round()!.endsAt + 1);
      // eating the bot offered a TEST kill card first; the bell's result card follows
      const shares = conn.msgs.filter((m) => m.t === 'share') as Extract<ServerMessage, { t: 'share' }>[];
      expect(shares[0]).toMatchObject({ kind: 'kill', test: true, victimIsBot: true });
      const share = shares.find((m) => m.kind === 'round');
      expect(share).toMatchObject({ kind: 'round', test: true });
      const card = app.shares.get(share!.id)!;
      expect(card).toMatchObject({ test: true, eaten: [{ name: shareName(bot.name), bot: true }] });
      expect(card.paid).toBeUndefined();
      const over = conn.msgs.find((m) => m.t === 'roundOver') as Extract<ServerMessage, { t: 'roundOver' }>;
      expect(over.stats.eaten).toEqual([{ name: shareName(bot.name), bot: true }]);
      // test arena games stay off the profiles (no xp message, no record)
      expect(app.profiles.get(j.stake.player)).toBeNull();
      expect(conn.msgs.some((m) => m.t === 'xp')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
