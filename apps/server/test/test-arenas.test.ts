/**
 * Test arenas (testnet only): an arena instance on the official arena's tickets and vault, populated with practice
 * bots. The guards (testnet chain + the admin switch; never on the mainnet), the value rules (bots carry none: eating
 * a bot moves no value, a bot eating a staker spills the eaten value as floor loot, bots pick up no loot), the
 * directory (fixed, one per tier, never in quick play or the scaler, closed only once settled) and the boards.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CellFlag, PROTOCOL_VERSION, PlayerFlag, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID, TEST_ARENA_ARRIVE_MS, TEST_ARENA_DEFAULT, TICK_MS, type ServerMessage } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BOT_LEAVE_MAX_MS } from '../src/bots/practice';
import type { ChainSession } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Leaderboards } from '../src/leaderboards';
import { RoomManager } from '../src/rooms/manager';
import { Room, type RoomOptions } from '../src/rooms/room';
import { TestArenaFail, TestArenaStore } from '../src/rooms/test-arenas';
import { Journal } from '../src/stake/journal';
import { createApp } from '../src/app';
import { ArenaChain, MID_ROUND, arena, fakeConn, roomDeps, stakeJoin, testWallet } from './helpers';

const FEE = 1_000_000;

const testOpts = (over: Partial<RoomOptions> = {}): RoomOptions => ({
  id: 'test-1',
  mode: 'arena',
  name: 'Test · Arena',
  instance: 0,
  maxPlayers: 50,
  stake: { arenaId: 1, buyIn: FEE },
  test: { chainId: ROBINHOOD_TESTNET_CHAIN_ID },
  bots: { count: 6, difficulty: 'mixed', max: 20 },
  seed: 5,
  ...over,
});

describe('test arenas: the room guard', () => {
  it('builds a test arena with bots on the testnet and the local node only', () => {
    const deps = roomDeps(new ArenaChain([]));
    const room = new Room(testOpts(), deps);
    room.tick(TICK_MS);
    expect(room.bots?.size).toBe(6);
    expect(room.ledger).not.toBeNull();
    expect(room.info()).toMatchObject({ id: 'test-1', mode: 'arena', arenaId: 1, entryFee: FEE, test: true, bots: 6 });
    expect(new Room(testOpts({ test: { chainId: 31337 } }), deps).bots).not.toBeNull();
    // the mainnet: refused, with or without bots
    expect(() => new Room(testOpts({ test: { chainId: ROBINHOOD_CHAIN_ID } }), deps)).toThrow(/testnet/);
    expect(() => new Room(testOpts({ test: { chainId: ROBINHOOD_CHAIN_ID }, bots: null }), deps)).toThrow(/testnet/);
    // a test arena is an arena instance with a stake, never a custom room
    expect(() => new Room(testOpts({ stake: undefined }), deps)).toThrow(/testnet/);
    expect(() => new Room(testOpts({ mode: 'practice' }), deps)).toThrow(/testnet/);
    expect(() => new Room(testOpts({ code: 'ABCDE' }), deps)).toThrow(/testnet/);
    // the old guard holds for every room that is not marked test: no bots with stakes
    expect(() => new Room(testOpts({ id: 'arena-1-1', instance: 1, test: undefined }), deps)).toThrow(/free custom rooms/);
  });

  it('bots arrive one by one', () => {
    const room = new Room(testOpts({ bots: { count: 5, difficulty: 'easy', max: 20, arriveMs: 4000 } }), roomDeps(new ArenaChain([])));
    room.tick(TICK_MS);
    expect(room.bots?.size).toBe(1);
    for (let i = 0; i < (30_000 / TICK_MS); i++) room.tick(TICK_MS);
    expect(room.bots?.size).toBe(5);
  });

  it('takes new bot settings live (more arrive, extra bots leave: at once when nobody sees them)', () => {
    const room = new Room(testOpts(), roomDeps(new ArenaChain([])));
    room.tick(TICK_MS);
    room.setBots(3, 'hard');
    expect(room.bots?.size).toBe(3);
    expect(room.bots?.count).toBe(3);
    room.setBots(9, 'hard');
    for (let i = 0; i < 300; i++) room.tick(TICK_MS);
    expect(room.bots?.size).toBe(9);
    // a free custom room or an arena instance ignores it
    const plain = new Room({ id: 'arena-1-1', mode: 'arena', name: 'A', instance: 1, maxPlayers: 50, stake: { arenaId: 1, buyIn: FEE } }, roomDeps(new ArenaChain([])));
    plain.setBots(5, 'easy');
    expect(plain.bots).toBeNull();
  });
});

describe('test arenas: bots carry no value', () => {
  /** A test arena with no bots playing (they are placed by hand) and one staker. */
  function setup() {
    const journal = new Journal(null);
    const leaderboards = new Leaderboards(null);
    const room = new Room(testOpts({ bots: { count: 3, difficulty: 'easy', max: 20 } }), { ...roomDeps(new ArenaChain([]), journal), leaderboards });
    room.tick(TICK_MS);
    const j = stakeJoin(1, FEE);
    const conn = fakeConn(j.stake.player);
    const p = room.join(conn, j);
    p.shieldUntil = 0;
    const bots = [...room.bots!.bots.values()].map((b) => b.player);
    return { room, journal, leaderboards, conn, p, bots, j };
  }
  const books = (room: Room) => room.ledger!.total() + room.lootValue();

  it('a staker eating a bot gains mass, never value', () => {
    const { room, p, bots } = setup();
    const bot = bots[0];
    bot.shieldUntil = 0;
    p.cells[0].setMass(2000);
    const c = p.center();
    bot.cells[0].setMass(200);
    bot.cells[0].x = c.x + 5;
    bot.cells[0].y = c.y;
    const before = p.totalMass();
    for (let i = 0; i < 40 && bot.alive; i++) room.tick(TICK_MS);
    expect(bot.alive).toBe(false);
    expect(p.totalMass()).toBeGreaterThan(before);
    expect(room.ledger!.value(p.id)).toBe(FEE);
    expect(books(room)).toBe(FEE);
    expect(room.bots!.eaten).toBeGreaterThan(0);
  });

  it('a bot eating a staker spills the eaten value as floor loot (books unchanged), and bots pick up no loot', () => {
    const { room, p, bots, journal } = setup();
    const bot = bots[0];
    bot.shieldUntil = 0;
    bot.cells[0].setMass(3000);
    const c = bot.center();
    p.cells[0].setMass(100);
    p.cells[0].x = c.x + 5;
    p.cells[0].y = c.y;
    for (let i = 0; i < 40 && p.alive; i++) room.tick(TICK_MS);
    expect(p.alive).toBe(false);
    expect(room.botSpills.n).toBeGreaterThan(0);
    expect(room.botSpills.value).toBe(FEE);
    // the staker's value lies on the floor; its settlement pays nothing; Σ stays the entry fee
    const item = journal.settlements()[0];
    expect(item?.payout).toBe(0);
    expect(room.lootValue()).toBe(FEE);
    // the bot sits on the loot for a while: it never takes it
    for (const l of room.world.loot()) {
      bot.cells[0].x = l.x;
      bot.cells[0].y = l.y;
      for (let i = 0; i < 5; i++) room.tick(TICK_MS);
    }
    expect(room.lootValue()).toBe(FEE);
  });

  it('the bell settles like an official instance, burns the floor loot, and posts to no board', () => {
    const journal = new Journal(null);
    const leaderboards = new Leaderboards(null);
    const clock = { t: MID_ROUND };
    const room = new Room(testOpts({ seed: 9 }), { ...roomDeps(new ArenaChain([]), journal, () => clock.t), leaderboards });
    room.tick(TICK_MS);
    const j = stakeJoin(1, FEE);
    room.join(fakeConn(j.stake.player), { ...j, country: 'DE' });
    for (let i = 0; i < 100; i++) room.tick(TICK_MS);
    clock.t = room.round(MID_ROUND)!.endsAt;
    room.syncRound(clock.t);
    const settle = journal.settlements().find((x) => x.key === j.stake.session);
    expect(settle).toMatchObject({ reason: 'round', arenaId: 1 });
    const sweep = journal.pending.filter((x) => x.kind === 'sweep').reduce((s, x) => s + (x.kind === 'sweep' ? x.amount : 0), 0);
    // value conserved: what the ticket brought is its payout plus the loot queued to burn, never more
    expect((settle?.payout ?? 0) + sweep).toBe(FEE);
    const lb = leaderboards.snapshot();
    expect(lb.daily).toEqual([]);
    expect(lb.rounds).toEqual([]);
    expect(lb.countries.daily).toEqual([]);
    // the bots play on into the next round
    expect(room.bots!.size).toBeGreaterThan(0);
  });
});

describe('test arenas: every person takes a bot\'s place', () => {
  const COUNT = 3;
  /** A test arena whose COUNT bots all arrived (one by one, with the real pacing). */
  function full(journal = new Journal(null), clock = { t: MID_ROUND }) {
    const room = new Room(testOpts({ bots: { count: COUNT, difficulty: 'easy', max: 20, arriveMs: TEST_ARENA_ARRIVE_MS } }), {
      ...roomDeps(new ArenaChain([]), journal, () => clock.t),
      leaderboards: new Leaderboards(null),
    });
    for (let i = 0; i < 30_000 / TICK_MS && room.bots!.size < COUNT; i++) room.tick(TICK_MS);
    expect(room.bots!.size).toBe(COUNT);
    return { room, journal, clock };
  }
  /** Never more bots in the world than the setting, never more playing than the setting minus the people, no bot with a ticket. */
  const bounded = (room: Room) => {
    const b = room.bots!;
    expect(b.bots.size).toBeLessThanOrEqual(b.count);
    expect(b.size).toBeLessThanOrEqual(Math.max(0, b.count - room.humanCount));
    for (const pid of b.bots.keys()) expect(room.ledger!.has(pid)).toBe(false);
  };
  const tick = (room: Room, ms: number, each?: () => void) => {
    for (let t = 0; t < ms; t += TICK_MS) {
      room.tick(TICK_MS);
      bounded(room);
      each?.();
    }
  };

  it('a person seated: one bot fewer at once (the lobby and admin counts too), never below 0; viewers hear it went home', () => {
    const { room } = full();
    const conns = [];
    for (let n = 1; n <= COUNT + 2; n++) {
      const j = stakeJoin(1, FEE);
      const c = fakeConn(j.stake.player);
      room.join(c, j);
      conns.push(c);
      const bots = Math.max(0, COUNT - n);
      expect(room.bots!.size).toBe(bots);
      expect(room.info()).toMatchObject({ players: n, bots });
      expect(room.botCounts()).toEqual({ humans: n, bots });
      tick(room, 300);
    }
    // the leavers are out of the world within BOT_LEAVE_MAX_MS (out of sight, or their time ran out)
    tick(room, BOT_LEAVE_MAX_MS + 200);
    expect(room.bots!.bots.size).toBe(0);
    expect(room.bots!.left).toBe(COUNT);
    expect([...room.world.players.values()].some((p) => p.isBot)).toBe(false);
    // the first person was there for every one of them: "Bot N went home." in the feed, never a death
    const feed = conns[0].msgs.filter((m): m is Extract<ServerMessage, { t: 'feed' }> => m.t === 'feed');
    expect(feed).toHaveLength(COUNT);
    for (const f of feed) expect(f).toMatchObject({ kind: 'left', isBot: true, reason: 'make_room', name: expect.stringMatching(/^Bot \d+$/) });
    expect(conns[0].msgs.some((m) => m.t === 'kf' && m.victimIsBot)).toBe(false);
  });

  it('a person gone (eaten, or settled at the bell): the bots come back one by one with the arrival pacing', () => {
    const { room, clock } = full();
    const a = stakeJoin(1, FEE);
    const b = stakeJoin(1, FEE);
    const pa = room.join(fakeConn(a.stake.player), a);
    const pb = room.join(fakeConn(b.stake.player), b);
    expect(room.bots!.size).toBe(COUNT - 2);
    // a eats b: one person fewer
    pa.shieldUntil = 0;
    pb.shieldUntil = 0;
    pa.cells[0].setMass(3000);
    const c = pa.center();
    pb.cells[0].x = c.x + 5;
    pb.cells[0].y = c.y;
    pb.cells[0].setMass(100);
    for (let i = 0; i < 60 && pb.alive; i++) room.tick(TICK_MS);
    expect(pb.alive).toBe(false);
    expect(room.humanCount).toBe(1);
    // the bot comes back, not at once: after the arrival pacing
    const back: number[] = [];
    const t0 = room.world.now;
    let size = room.bots!.size;
    const watch = () => {
      if (room.bots!.size > size) back.push(room.world.now - t0);
      expect(room.bots!.size - size).toBeLessThanOrEqual(1);
      size = room.bots!.size;
    };
    tick(room, 12_000, watch);
    expect(room.bots!.size).toBe(COUNT - 1);
    expect(back).toHaveLength(1);
    expect(back[0]).toBeGreaterThanOrEqual(TEST_ARENA_ARRIVE_MS * 0.6 - TICK_MS);
    // the bell settles the last person: the last bot comes back too, one at a time
    clock.t = room.round(MID_ROUND)!.endsAt;
    room.syncRound(clock.t);
    expect(room.humanCount).toBe(0);
    expect(room.bots!.size).toBe(COUNT - 1);
    tick(room, 12_000, watch);
    expect(room.bots!.size).toBe(COUNT);
    expect(back).toHaveLength(2);
    expect(back[1] - back[0]).toBeGreaterThanOrEqual(TEST_ARENA_ARRIVE_MS * 0.6 - TICK_MS);
  });

  it('bots leaving and coming back move no value: ticket values, floor loot, settlements and burns stay exactly as they are', () => {
    const journal = new Journal(null);
    const { room } = full(journal);
    let paidIn = 0;
    const sessions = new Set<string>();
    /**
     * Σ entry fees = Σ values in play + floor loot + Σ settled payouts + Σ loot queued to burn, every tick; every
     * journal item is a person's settlement or a loot sweep (none names a bot).
     */
    const conserved = () => {
      const out = journal.pending.reduce((n, p) => n + (p.kind === 'settle' ? (p.payout ?? 0) : p.kind === 'sweep' ? p.amount : 0), 0);
      expect(room.ledger!.total() + room.lootValue() + out).toBe(paidIn);
      for (const p of journal.pending) expect(p.kind === 'sweep' || (p.kind === 'settle' && sessions.has(p.key))).toBe(true);
    };
    const seat = () => {
      const j = stakeJoin(1, FEE);
      sessions.add(j.stake.session);
      const p = room.join(fakeConn(j.stake.player), j);
      paidIn += FEE;
      p.shieldUntil = 0;
      conserved();
      return { p, j };
    };
    const a = seat();
    const b = seat();
    tick(room, 500, conserved);
    // a playing bot eats b: b's value spills as floor loot (the bot takes none)
    const bot = [...room.bots!.bots.values()].find((x) => !x.leaving)!.player;
    bot.shieldUntil = 0;
    bot.cells[0].setMass(3000);
    const bc = b.p.center();
    bot.cells[0].x = bc.x + 5;
    bot.cells[0].y = bc.y;
    b.p.cells[0].setMass(100);
    for (let i = 0; i < 60 && b.p.alive; i++) {
      room.tick(TICK_MS);
      conserved();
    }
    expect(b.p.alive).toBe(false);
    expect(room.lootValue()).toBe(FEE);
    expect(journal.settlements().find((x) => x.key === b.j.stake.session)?.payout).toBe(0);
    // a bot comes back for b, then c is seated and one leaves: the loot on the floor does not move
    tick(room, 12_000, conserved);
    const loot = room.lootValue();
    const left = room.bots!.left;
    seat();
    tick(room, BOT_LEAVE_MAX_MS + 200, conserved);
    expect(room.bots!.left).toBeGreaterThan(left);
    expect(room.lootValue()).toBe(loot);
    expect(room.ledger!.value(a.p.id)).toBe(FEE);
    expect(journal.settlements().map((x) => x.key)).toEqual([b.j.stake.session]);
  });

  it('a bot someone has in view swims off first, harmless (shielded), and is gone once out of sight', () => {
    const room = new Room(testOpts({ bots: { count: 2, difficulty: 'easy', max: 20 } }), roomDeps(new ArenaChain([])));
    room.tick(TICK_MS);
    const [b1, b2] = [...room.bots!.bots.values()].map((b) => b.player);
    // both bots side by side in the middle, a spectator watching them
    const mid = room.world.center();
    b1.cells[0].x = mid.x;
    b1.cells[0].y = mid.y;
    b2.cells[0].x = mid.x + 150;
    b2.cells[0].y = mid.y;
    const spectator = fakeConn(null);
    room.spectate(spectator);
    tick(room, 200);
    expect(spectator.view.knownPlayers.has(b1.id) && spectator.view.knownPlayers.has(b2.id)).toBe(true);
    const j = stakeJoin(1, FEE);
    room.join(fakeConn(j.stake.player), j);
    // one bot makes room: the spectator sees it, so it is still in the world, leaving and harmless
    expect(room.bots!.size).toBe(1);
    const leaver = [...room.bots!.bots.values()].find((b) => b.leaving)!;
    expect(leaver).toBeTruthy();
    room.tick(TICK_MS);
    expect(leaver.player.cells[0].flags & CellFlag.Shield).toBe(CellFlag.Shield);
    let goneAt = -1;
    const t0 = room.world.now;
    tick(room, BOT_LEAVE_MAX_MS + 500, () => {
      if (goneAt < 0 && !room.world.players.has(leaver.player.id)) goneAt = room.world.now - t0;
    });
    expect(goneAt).toBeGreaterThan(0);
    expect(goneAt).toBeLessThanOrEqual(BOT_LEAVE_MAX_MS + TICK_MS);
    expect(spectator.msgs.some((m) => m.t === 'feed' && m.pid === leaver.player.id && m.reason === 'make_room')).toBe(true);
  });

  it('the admin setting with people in the room: the setting minus the people play', () => {
    const room = new Room(testOpts({ bots: { count: 6, difficulty: 'easy', max: 20 } }), roomDeps(new ArenaChain([])));
    room.tick(TICK_MS);
    for (let n = 0; n < 2; n++) {
      const j = stakeJoin(1, FEE);
      room.join(fakeConn(j.stake.player), j);
    }
    expect(room.bots!.size).toBe(4);
    room.setBots(3, 'easy');
    expect(room.bots!.size).toBe(1);
    room.setBots(8, 'hard');
    tick(room, 300);
    expect(room.bots!.size).toBe(6);
    // the map is sized for the coins expected: the people and the bots that play beside them
    expect(room.expectedPlayers()).toBe(8);
    expect(room.expectedPlayers(10)).toBe(10);
  });
});

describe('test arenas: the admin switch', () => {
  it('defaults on on the testnet and persists changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-tests-'));
    const s = new TestArenaStore(ROBINHOOD_TESTNET_CHAIN_ID, dir);
    expect(s.available).toBe(true);
    expect(s.active).toBe(true);
    expect(s.settings).toEqual(TEST_ARENA_DEFAULT);
    s.update({ bots: 4, difficulty: 'hard' });
    expect(JSON.parse(readFileSync(join(dir, 'site', 'test-arenas.json'), 'utf8'))).toEqual({ enabled: true, bots: 4, difficulty: 'hard' });
    expect(new TestArenaStore(ROBINHOOD_TESTNET_CHAIN_ID, dir).settings).toEqual({ enabled: true, bots: 4, difficulty: 'hard' });
    expect(() => s.update({ bots: 1 })).toThrow(TestArenaFail);
  });

  it('is impossible on the mainnet: refused, a stored file ignored, never active', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-tests-'));
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, 'site', 'test-arenas.json'), JSON.stringify({ enabled: true, bots: 10, difficulty: 'mixed' }));
    const s = new TestArenaStore(ROBINHOOD_CHAIN_ID, dir);
    expect(s.available).toBe(false);
    expect(s.active).toBe(false);
    expect(s.settings.enabled).toBe(false);
    expect(() => s.update({ enabled: true })).toThrow(/testnet only/);
    expect(() => s.update({ bots: 5 })).toThrow(/testnet only/);
    expect(s.active).toBe(false);
    // the file was not touched (and is still ignored)
    expect(existsSync(join(dir, 'site', 'test-arenas.json'))).toBe(true);
    expect(new TestArenaStore(ROBINHOOD_CHAIN_ID, dir, undefined, { enabled: true }).active).toBe(false);
  });
});

describe('test arenas: the room directory', () => {
  async function setup(env: Record<string, string> = {}, chainId = 31337) {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-tests-'));
    const cfg = loadConfig({ DATA_DIR: dir, ...env } as NodeJS.ProcessEnv);
    const journal = new Journal(null);
    const chain = new ArenaChain([arena(1, FEE), arena(2, 5 * FEE)]);
    const status = chain.status.bind(chain);
    chain.status = () => ({ ...status(), chainId, testnet: chainId !== ROBINHOOD_CHAIN_ID });
    const store = new TestArenaStore(cfg.chain.chainId, dir);
    const m = new RoomManager(cfg, roomDeps(chain, journal), chain, undefined, undefined, store);
    await m.ensureArenaRooms();
    return { m, journal, store, cfg };
  }

  it('one fixed test arena per tier, listed with the official arenas, never picked by quick play or the scaler', async () => {
    const { m } = await setup();
    expect(m.testRooms().map((r) => r.id).sort()).toEqual(['test-1', 'test-2']);
    const list = m.list().filter((r) => r.mode === 'arena');
    expect(list.filter((r) => r.test).map((r) => r.name).sort()).toEqual(['Test · ' + list.find((r) => r.id === 'arena-1-1')!.name, 'Test · ' + list.find((r) => r.id === 'arena-2-1')!.name].sort());
    expect(m.arenaInstances(1).map((r) => r.id)).toEqual(['arena-1-1']);
    for (let i = 0; i < 20; i++) expect((await m.arenaRoom(1))?.id).toBe('arena-1-1');
    expect(m.scaler.view().arenas.flatMap((a) => a.instances.map((x) => x.id))).not.toContain('test-1');
    const t = await m.testRoom(1);
    expect(typeof t === 'object' && t.id).toBe('test-1');
    // a live ticket in the test arena is found like any other of that arena (one session per wallet per arena)
    const room = t as Room;
    const j = stakeJoin(1, FEE);
    room.join(fakeConn(j.stake.player), j);
    expect(m.findArenaStake(1, j.stake.player)?.room.id).toBe('test-1');
    expect(m.liveSessions().has(j.stake.session)).toBe(true);
    expect(m.testArenaView()).toMatchObject({ available: true, active: true, rooms: [{ id: 'test-1', people: 1 }, { id: 'test-2', people: 0 }] });
  });

  it('turned off: no new seats, each test arena closes once its bell settled it (nobody evicted); on again: back', async () => {
    const { m, store, journal } = await setup();
    const room = m.get('test-1') as Room;
    const j = stakeJoin(1, FEE);
    const conn = fakeConn(j.stake.player);
    room.join(conn, j);
    store.update({ enabled: false });
    // test-2 was empty: gone at once; test-1 keeps its ticket until the bell
    expect(m.get('test-2')).toBeUndefined();
    expect(m.get('test-1')).toBe(room);
    expect(await m.testRoom(1)).toBe('missing');
    expect(m.confirmTestRoom(room)).toBeNull();
    expect(room.ledger!.has(conn.player!.id)).toBe(true);
    expect(m.testArenaView().rooms).toEqual([expect.objectContaining({ id: 'test-1', closing: true })]);
    room.syncRound(room.round(MID_ROUND)!.endsAt);
    expect(journal.pending.some((x) => x.key === j.stake.session)).toBe(true);
    // the cleanup closes it once settled (nothing of value left)
    (m as unknown as { closeTestArenas(): void }).closeTestArenas();
    expect(m.get('test-1')).toBeUndefined();
    store.update({ enabled: true });
    await m.ensureArenaRooms();
    expect(m.testRooms().map((r) => r.id).sort()).toEqual(['test-1', 'test-2']);
    // the bot settings reach the live test arenas
    store.update({ bots: 3 });
    expect(m.testRooms().map((r) => (r as Room).bots!.count)).toEqual([3, 3]);
  });

  it('never on the mainnet: no test arena opens, joins and the setting are refused', async () => {
    const { m, store } = await setup({ CHAIN_ID: String(ROBINHOOD_CHAIN_ID) }, ROBINHOOD_CHAIN_ID);
    expect(m.testRooms()).toEqual([]);
    expect(m.list().some((r) => r.test)).toBe(false);
    expect(await m.testRoom(1)).toBe('missing');
    expect(() => store.update({ enabled: true })).toThrow(TestArenaFail);
    expect(m.testArenaView()).toMatchObject({ available: false, active: false, rooms: [] });
  });

  it('an RPC that serves the mainnet keeps them closed even with a testnet CHAIN_ID', async () => {
    const { m } = await setup({}, ROBINHOOD_CHAIN_ID);
    expect(m.testActive()).toBe(false);
    expect(m.testRooms()).toEqual([]);
  });

  it('bots in a test arena are labelled BOT and hold no ticket', async () => {
    const { m } = await setup();
    const room = m.get('test-1') as Room;
    // they arrive one by one, about 4 s apart; a bot another bot ate is away for a few seconds before its slot comes
    // back, so count every bot slot seen over the run rather than the ones alive at one instant
    const seen = new Set<string>();
    for (let i = 0; i < 70_000 / TICK_MS; i++) {
      room.tick(TICK_MS);
      for (const b of room.world.players.values()) {
        if (!b.isBot) continue;
        seen.add(b.name);
        expect(b.flags & PlayerFlag.Bot).toBe(PlayerFlag.Bot);
        expect(b.flags & PlayerFlag.Staker).toBe(0);
        expect(room.ledger!.has(b.id)).toBe(false);
      }
    }
    expect(seen.size).toBe(TEST_ARENA_DEFAULT.bots);
  });
});

describe('test arenas: the admin API', () => {
  async function server(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-tests-api-'));
    const admin = testWallet(0xad01);
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0', ...env } as NodeJS.ProcessEnv);
    const app = await createApp(cfg, { chain: new ArenaChain([arena(1, FEE)]), log: () => {}, persist: true });
    const port = await app.listen();
    const call = async (method: string, body?: unknown, wallet: string | null = admin) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (wallet) headers.Authorization = `Bearer ${app.auth.issueToken(wallet)}`;
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/test-arenas`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { app, call };
  }

  it('testnet: GET the live view, PUT a change (admins only), a bad value is a 400', async () => {
    const { app, call } = await server({});
    try {
      const g = await call('GET');
      expect(g.status).toBe(200);
      expect(g.body).toMatchObject({ available: true, active: true, settings: TEST_ARENA_DEFAULT, rooms: [{ id: 'test-1' }] });
      expect((await call('PUT', { bots: 5 }, testWallet(0xbeef))).status).toBe(403);
      expect((await call('PUT', { bots: 99 })).status).toBe(400);
      const p = await call('PUT', { bots: 5, difficulty: 'easy' });
      expect(p.status).toBe(200);
      expect(p.body.settings).toEqual({ enabled: true, bots: 5, difficulty: 'easy' });
    } finally {
      await app.close();
    }
  });

  it('the game is for admins only: an admin plays a test arena (a bot makes room); a visitor, even with a ticket, is refused at the join', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-tests-gate-'));
    const admin = testWallet(0xad02);
    /** Every wallet holds an open ticket of arena 1. */
    class TicketChain extends ArenaChain {
      private seq = 0;
      private readonly tickets = new Map<string, ChainSession>();
      override async getSession(arenaId?: number, player?: string): Promise<ChainSession | null> {
        if (arenaId !== 1 || !player) return null;
        let s = this.tickets.get(player);
        if (!s) {
          const id = ++this.seq;
          s = { key: `1:${player.toLowerCase()}:${id}`, id, player, arenaId: 1, entryFee: FEE, value: FEE, openedAt: Math.floor(Date.now() / 1000), finalized: false, owed: 0 };
          this.tickets.set(player, s);
        }
        return s;
      }
    }
    // no GAME_ACCESS: the site setting decides, and a fresh server opens the game to admins only
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0' } as NodeJS.ProcessEnv);
    const t0 = Date.now();
    const app = await createApp(cfg, { chain: new TicketChain([arena(1, FEE)]), log: () => {}, persist: true, now: () => MID_ROUND + (Date.now() - t0) });
    const port = await app.listen();
    const open = async (wallet: string | null) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const msgs: ServerMessage[] = [];
      ws.on('message', (d, bin) => {
        if (!bin) msgs.push(JSON.parse(d.toString()) as ServerMessage);
      });
      await new Promise((r, j) => {
        ws.once('open', r);
        ws.once('error', j);
      });
      const next = async (pick: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
        for (const until = Date.now() + 4000; Date.now() < until; await new Promise((r) => setTimeout(r, 10))) {
          const i = msgs.findIndex(pick);
          if (i >= 0) return msgs.splice(0, i + 1)[i];
        }
        throw new Error(`no reply: ${JSON.stringify(msgs.map((m) => m.t))}`);
      };
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      await next((m) => m.t === 'welcome');
      if (wallet) {
        ws.send(JSON.stringify({ t: 'auth', token: app.auth.issueToken(wallet) }));
        await next((m) => m.t === 'authed');
      }
      const ask = (m: unknown) => {
        ws.send(JSON.stringify(m));
        return next((x) => x.t === 'joined' || x.t === 'spectating' || x.t === 'error');
      };
      return { ws, ask };
    };
    try {
      expect(app.site.gameAccess()).toBe('admins');
      const room = app.rooms.get('test-1') as Room;
      expect(room?.opts.test).toBeTruthy();
      for (let i = 0; i < 200 && room.bots!.size < 1; i++) await new Promise((r) => setTimeout(r, 20));
      // the bots arrive one by one: those playing plus those on their way in make the setting
      const bots = () => room.bots!.size + room.bots!.arriving;
      expect(room.bots!.size).toBeGreaterThan(0);
      expect(bots()).toBe(TEST_ARENA_DEFAULT.bots);
      // a visitor (signed in with a ticket, or a guest): refused at the join and when watching, whatever the UI shows
      for (const w of [testWallet(0xbee1), null]) {
        const c = await open(w);
        expect(await c.ask({ t: 'join', room: 'arena:1:test', name: 'Visitor', skin: 0 })).toMatchObject({ t: 'error', code: 'game_closed' });
        expect(await c.ask({ t: 'spectate', room: 'test-1' })).toMatchObject({ t: 'error', code: 'game_closed' });
        c.ws.close();
      }
      expect(room.humanCount).toBe(0);
      expect(bots()).toBe(TEST_ARENA_DEFAULT.bots);
      // the admin plays it from the lobby: seated in the test arena on the ticket, and a bot makes room
      const c = await open(admin);
      const joined = await c.ask({ t: 'join', room: 'arena:1:test', name: 'Owner', skin: 0 });
      expect(joined).toMatchObject({ t: 'joined', room: { id: 'test-1', test: true }, value: FEE });
      expect(room.humanCount).toBe(1);
      expect(room.bots!.target).toBe(TEST_ARENA_DEFAULT.bots - 1);
      expect(bots()).toBe(TEST_ARENA_DEFAULT.bots - 1);
      c.ws.close();
    } finally {
      await app.close();
    }
  });

  it('mainnet: the setting is refused (409) and no test arena exists', async () => {
    const { app, call } = await server({ CHAIN_ID: String(ROBINHOOD_CHAIN_ID) });
    try {
      const g = await call('GET');
      expect(g.body).toMatchObject({ available: false, active: false, rooms: [] });
      const p = await call('PUT', { enabled: true });
      expect(p.status).toBe(409);
      expect(app.rooms.testRooms()).toEqual([]);
      expect(app.rooms.list().some((r) => r.test)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
