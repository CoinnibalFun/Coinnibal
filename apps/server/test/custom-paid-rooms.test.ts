import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUSTOM_DEFAULTS, CUSTOM_DURATION_LIMITS, ROOM_CLOSE_COUNTDOWN_MS, TICK_MS, profitFee, type CustomRoomConfig, type ServerMessage } from '@elymum/shared';
import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { UsedPayments, type NativeTransfer, type PaymentReader } from '../src/chain/payment';
import { loadConfig } from '../src/config';
import { CustomRoomFail, CustomRoomService } from '../src/rooms/custom';
import { RoomManager, isPaidCustom } from '../src/rooms/manager';
import { MAX_STAKE_SESSION_AGE_S, type Room } from '../src/rooms/room';
import { Journal, itemAmount } from '../src/stake/journal';
import { ArenaChain, MID_ROUND, arena, fakeConn, roomDeps, stakeJoin } from './helpers';
import { testSigner } from './signers';

const TREASURY = '0x1111111111111111111111111111111111111111';
const BASE = parseEther('0.0005');
const FEE = 1_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const cfgOf = (extra: Partial<CustomRoomConfig> = {}): CustomRoomConfig => ({ ...CUSTOM_DEFAULTS, name: 'Whale Club', bots: 0, ...extra });
const paid = (arenaId: number, extra: Partial<CustomRoomConfig> = {}) => cfgOf({ kind: 'paid', arenaId, ...extra });

class Transfers implements PaymentReader {
  readonly txs = new Map<string, NativeTransfer>();
  constructor(private readonly clock: { t: number }) {}
  pay(n: number, from: string, value: bigint): string {
    const h = hash(n);
    this.txs.set(h, { hash: h, from, to: TREASURY, value, status: 'success', blockNumber: 10n, timestamp: this.clock.t - 5_000 });
    return h;
  }
  async transfer(h: string): Promise<NativeTransfer | null> {
    return this.txs.get(h.toLowerCase()) ?? null;
  }
}

/** A manager with arenas 1 (1.0), 2 (10.0) and the holders-only 4 (250.0), and the custom-room service, on one hand-driven clock. */
function setup(o: { holder?: boolean; journal?: Journal } = {}) {
  const clock = { t: MID_ROUND };
  const chain = new ArenaChain([arena(1, FEE), arena(2, 10 * FEE), { ...arena(4, 250 * FEE), holdersOnly: true }]);
  const journal = o.journal ?? new Journal(null);
  const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-paid-')) } as NodeJS.ProcessEnv);
  const rooms = new RoomManager(cfg, roomDeps(chain, journal, () => clock.t), chain);
  const reader = new Transfers(clock);
  const dir = mkdtempSync(join(tmpdir(), 'elymum-paid-svc-'));
  const svc = new CustomRoomService({
    rooms,
    dataDir: dir,
    used: new UsedPayments(null),
    reader: () => reader,
    chainId: () => 31337,
    isHolder: async () => o.holder ?? false,
    ownerWallet: TREASURY,
    now: () => clock.t,
  });
  return { svc, rooms, reader, clock, journal, chain, dir, cfg };
}

const fail = async (p: Promise<unknown>): Promise<CustomRoomFail> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof CustomRoomFail) return err;
    throw err;
  }
  throw new Error('expected a CustomRoomFail');
};

const tick = (room: Room, n = 1) => {
  for (let i = 0; i < n; i++) room.tick(TICK_MS);
};

describe('custom rooms: capacity and its fee', () => {
  it('the fee grows 50 % of the base for every started 10 players above 10; the server computes it', async () => {
    const { svc, reader } = setup();
    svc.updateSettings({ maxPerWallet: 10, maxLive: 10, maxSeats: 500, maxPlayers: 100 });
    const a = testSigner().address;
    // 10 players: the base
    expect((await svc.create(a, { config: cfgOf({ maxPlayers: 10 }), txHash: reader.pay(1, a, BASE) })).feeWei).toBe(BASE.toString());
    // 11 players: x1.5, the base price is refused
    const low = await fail(svc.create(a, { config: cfgOf({ maxPlayers: 11 }), txHash: reader.pay(2, a, BASE) }));
    expect(low.code).toBe('payment_low');
    expect((await svc.create(a, { config: cfgOf({ maxPlayers: 11 }), txHash: reader.pay(3, a, (BASE * 3n) / 2n) })).maxPlayers).toBe(11);
    // 100 players: x5.5
    expect((await fail(svc.create(a, { config: cfgOf({ maxPlayers: 100 }), txHash: reader.pay(4, a, BASE * 5n) }))).code).toBe('payment_low');
    const big = await svc.create(a, { config: cfgOf({ maxPlayers: 100 }), txHash: reader.pay(5, a, (BASE * 11n) / 2n) });
    expect(big.feeWei).toBe(((BASE * 11n) / 2n).toString());
    // the refused (underpaid) hash was never used up
    expect(svc.feeWei(25)).toBe(BASE * 2n);
  });

  it('the admin sets the base, the step and the caps; the quote carries them', async () => {
    const { svc, reader } = setup();
    const a = testSigner().address;
    svc.updateSettings({ priceGas: '0.1', capacityStepPct: 100, maxPlayers: 30, maxSeats: 40 });
    const q = await svc.quote(a);
    expect(q).toMatchObject({ priceWei: parseEther('0.1').toString(), capacityStepPct: 100, maxPlayers: 30, seatsLeft: 40 });
    expect(svc.feeWei(21)).toBe(parseEther('0.3'));
    // above the admin's biggest room
    expect(await fail(svc.create(a, { config: cfgOf({ maxPlayers: 31 }), txHash: reader.pay(1, a, parseEther('1')) }))).toMatchObject({ code: 'bad_request', field: 'maxPlayers' });
    // seats: 30 + 20 > 40
    await svc.create(a, { config: cfgOf({ maxPlayers: 30 }), txHash: reader.pay(2, a, parseEther('0.3')) });
    expect((await svc.quote(a)).seatsLeft).toBe(10);
    const seats = await fail(svc.create(a, { config: cfgOf({ maxPlayers: 20 }), txHash: reader.pay(3, a, parseEther('1')) }));
    expect(seats).toMatchObject({ code: 'seats_busy', status: 503 });
    expect(seats.message).toMatch(/room for 10 more players/);
    // the refusal came before the payment was read: the hash is still good for a smaller room
    expect((await svc.create(a, { config: cfgOf({ maxPlayers: 10 }), txHash: hash(3) })).maxPlayers).toBe(10);
    // settings validation
    expect(() => svc.updateSettings({ capacityStepPct: 501 })).toThrow(/capacityStepPct/);
    expect(() => svc.updateSettings({ maxPlayers: 101 })).toThrow(/maxPlayers/);
    expect(() => svc.updateSettings({ maxSeats: 501 })).toThrow(/maxSeats/);
    expect(() => svc.updateSettings({ maxSeats: 20, maxPlayers: 30 })).toThrow(/at least the biggest room/);
    expect(() => svc.updateSettings({ paidRooms: 'yes' })).toThrow(/paidRooms/);
  });

  it("the holders' free room of the day covers 10 players; a bigger room pays its full fee and keeps the free room", async () => {
    const { svc, reader } = setup({ holder: true });
    svc.updateSettings({ holderPerk: 'free_daily', maxPerWallet: 5 });
    const a = testSigner().address;
    expect((await fail(svc.create(a, { config: cfgOf({ maxPlayers: 20 }) }))).code).toBe('payment_required');
    expect((await svc.create(a, { config: cfgOf({ maxPlayers: 20 }), txHash: reader.pay(1, a, (BASE * 3n) / 2n) })).paidWith).toBe('paid');
    expect((await svc.quote(a)).freeAvailable).toBe(true);
    expect((await svc.create(a, { config: cfgOf({ maxPlayers: 10 }) })).paidWith).toBe('free');
    expect((await svc.quote(a)).freeAvailable).toBe(false);
  });
});

describe('custom rooms: paid rooms (invite-only arena instances)', () => {
  it('opens a private instance of the chosen arena: never listed, never picked by quick play', async () => {
    const { svc, rooms, reader, clock, cfg } = setup();
    const a = testSigner().address;
    const q = await svc.quote(a);
    expect(q.paidRooms).toBe(true);
    expect(q.tiers).toEqual([
      { arenaId: 1, entryFee: FEE, holdersOnly: false },
      { arenaId: 2, entryFee: 10 * FEE, holdersOnly: false },
      { arenaId: 4, entryFee: 250 * FEE, holdersOnly: true },
    ]);
    const view = await svc.create(a, { config: paid(2, { maxPlayers: 8, durationMin: 15 }), txHash: reader.pay(1, a, BASE) });
    expect(view).toMatchObject({ kind: 'paid', arenaId: 2, maxPlayers: 8, feeWei: BASE.toString() });
    // it starts now and ends exactly its duration later, on its own clock (never rounded to an arena bell)
    expect(view.createdAt).toBe(clock.t);
    expect(view.endsAt).toBe(clock.t + 15 * 60_000);
    const room = rooms.get(`priv-${view.code}`) as Room;
    expect(room.opts).toMatchObject({ mode: 'arena', code: view.code, instance: 0, maxPlayers: 8, stake: { arenaId: 2, buyIn: 10 * FEE }, ownRound: { startsAt: clock.t, endsAt: view.endsAt } });
    // its round is its own game: open from now, joins closed in its last minute, the bell at the room's end
    expect(room.round()).toEqual({ n: Math.floor(clock.t / 1000), endsAt: view.endsAt, joinsCloseAt: view.endsAt - 60_000, startsAt: clock.t });
    expect(room.inBreak()).toBe(false);
    expect(isPaidCustom(room.opts)).toBe(true);
    expect(room.ledger).not.toBeNull();
    expect(room.info().custom).toMatchObject({ kind: 'paid', arenaId: 2 });
    // the directory: never listed, never an arena instance for matchmaking or spectating
    expect(rooms.list().some((r) => r.id === room.id)).toBe(false);
    expect(rooms.arenaInstances(2)).not.toContain(room);
    for (let i = 0; i < 3; i++) expect((await rooms.arenaRoom(2))!.id).toBe('arena-2-1');
    // even with the public instance full, quick play opens another public instance
    const pub = (await rooms.arenaRoom(2)) as Room;
    for (let i = 0; i < cfg.arenaInstanceCap; i++) pub.join(fakeConn(`w${i}`), stakeJoin(2, 10 * FEE));
    expect((await rooms.arenaRoom(2))!.id).toBe('arena-2-2');
    expect((await rooms.spectateRoom('arena-2-0'))!.id).toBe('arena-2-1');
    // seating by code: only with that arena's tickets
    expect(await rooms.paidRoom(2, view.code)).toBe(room);
    expect(await rooms.paidRoom(1, view.code)).toBe('missing');
    expect(await rooms.paidRoom(2, 'ZZZZZ')).toBe('missing');
    // a free room is never a paid seat, a paid room never a free one
    const free = await svc.create(a, { config: cfgOf(), txHash: reader.pay(2, a, BASE) });
    expect(await rooms.paidRoom(2, free.code)).toBe('missing');
  });

  it('a ticket seated there plays to the ROOM end (no 5-minute bell, no re-pay): settled at value there, loot burned', async () => {
    const { svc, rooms, reader, clock, journal } = setup();
    const a = testSigner().address;
    const view = await svc.create(a, { config: paid(1, { durationMin: 15 }), txHash: reader.pay(1, a, BASE) });
    const room = rooms.get(`priv-${view.code}`) as Room;
    const conn = fakeConn('w-host');
    const j = stakeJoin(1, FEE);
    const p = room.join(conn, j);
    expect(room.ledger!.has(p.id)).toBe(true);
    expect(rooms.findArenaStake(1, j.stake.player)?.room).toBe(room);
    expect(rooms.liveSessions().has(j.stake.session)).toBe(true);
    expect(journal.live().map((l) => l.session)).toContain(j.stake.session);
    room.world.restoreLoot([{ x: 100, y: 100, value: 777 }]);
    // the arenas' bells ring (and their last minutes come) while the room plays on: nothing is settled
    for (let bell = rooms.roundWindow(clock.t).endsAt; bell < view.endsAt; bell = rooms.roundWindow(bell).endsAt) {
      clock.t = bell;
      tick(room);
      expect(conn.msgs.some((m) => m.t === 'roundOver')).toBe(false);
      expect(p.alive).toBe(true);
      expect(journal.pending.some((i) => i.key === j.stake.session)).toBe(false);
      expect(rooms.roomWindow(room, clock.t).joinsCloseAt).toBe(view.endsAt - 60_000);
    }
    clock.t = view.endsAt - 1;
    tick(room);
    expect(conn.msgs.some((m) => m.t === 'roundOver')).toBe(false);
    clock.t = view.endsAt;
    tick(room);
    expect(conn.msgs.filter((m) => m.t === 'roundOver')).toHaveLength(1);
    expect(journal.pending.find((i) => i.key === j.stake.session)).toMatchObject({ kind: 'settle', reason: 'round', payout: FEE });
    const sweep = journal.pending.find((i) => i.kind === 'sweep');
    expect(sweep && itemAmount(sweep)).toBe(777);
    expect(sweep).toMatchObject({ arenaId: 1, roomId: room.id });
  });

  it('time up: no new seat; the room closes only once its bell settled every ticket and burned its loot', async () => {
    const { svc, rooms, reader, clock, journal } = setup();
    const a = testSigner().address;
    const view = await svc.create(a, { config: paid(1, { durationMin: 15 }), txHash: reader.pay(1, a, BASE) });
    const room = rooms.get(`priv-${view.code}`) as Room;
    // a ticket seated in the last round
    clock.t = view.endsAt - 120_000;
    const conn = fakeConn('w-last');
    const j = stakeJoin(1, FEE);
    room.join(conn, j);
    const watcher = fakeConn(null, '10.0.0.9');
    room.spectate(watcher);
    svc.sweep(clock.t);
    expect(svc.seatable(view.code)).toBe(true);
    // the service's clock reaches the end before the room rang its bell (two threads, one second apart)
    clock.t = view.endsAt;
    svc.sweep(clock.t);
    expect(svc.get(view.code)).toMatchObject({ closing: true });
    expect(svc.seatable(view.code)).toBe(false);
    expect(await rooms.paidRoom(1, view.code)).toBe('closed');
    // the ticket is never evicted: the room stays while it holds it
    expect(rooms.get(room.id)).toBe(room);
    expect(journal.pending.some((i) => i.key === j.stake.session)).toBe(false);
    expect(() => room.evict('nope')).toThrow(/never evicted/);
    // the bell settles it; the next sweep closes the room
    tick(room);
    expect(journal.pending.find((i) => i.key === j.stake.session)).toMatchObject({ reason: 'round', payout: FEE });
    svc.sweep(clock.t + 1000);
    expect(rooms.get(room.id)).toBeUndefined();
    expect(svc.get(view.code)).toBeNull();
    for (const c of [conn, watcher]) expect(c.msgs.at(-1)).toMatchObject({ t: 'error', code: 'room_closed' });
    expect(rooms.customClosedLately(view.code)).toBe(true);
    expect(await rooms.paidRoom(1, view.code)).toBe('closed');
  });

  it('closed early by its creator: no new seat, the ticket plays the 10 s countdown, is settled at that end, then the room closes', async () => {
    const { svc, rooms, reader, clock, journal } = setup();
    const a = testSigner().address;
    const view = await svc.create(a, { config: paid(1), txHash: reader.pay(1, a, BASE) });
    const room = rooms.get(`priv-${view.code}`) as Room;
    const conn = fakeConn('w-early');
    const j = stakeJoin(1, FEE);
    const p = room.join(conn, j);
    const t0 = clock.t;
    expect(svc.close(view.code, { wallet: a, admin: false })).toMatchObject({ closing: true });
    expect(svc.seatable(view.code)).toBe(false);
    expect(conn.msgs.some((m) => m.t === 'chat' && m.system && /settled at its end/.test(m.text))).toBe(true);
    expect(rooms.get(room.id)).toBe(room);
    // it now ends in 10 s (not at an arena bell): the countdown at once, with the reason; its own bell moved there
    const end = t0 + 10_000;
    expect(svc.get(view.code)!.endsAt).toBe(end);
    expect(conn.msgs.find((m) => m.t === 'closing')).toEqual({ t: 'closing', endsAt: end, message: expect.stringMatching(/creator closed this room\. Every ticket is settled at its end/) });
    expect(room.round()!.endsAt).toBe(end);
    tick(room, 5);
    expect(p.alive).toBe(true);
    svc.sweep(clock.t);
    expect(rooms.get(room.id)).toBe(room);
    clock.t = end;
    tick(room);
    // the bell's board: every ticket with its value, mass and kills (the same rows as a free room's end)
    const over = conn.msgs.find((m) => m.t === 'roundOver') as Extract<ServerMessage, { t: 'roundOver' }>;
    expect(over.standings).toEqual([{ rank: 1, name: j.name, mass: expect.any(Number), kills: 0, value: FEE, you: true }]);
    expect(journal.pending.find((i) => i.key === j.stake.session)).toMatchObject({ reason: 'round' });
    svc.sweep(clock.t);
    expect(rooms.get(room.id)).toBeUndefined();
    expect(svc.live).toBe(0);
  });

  it('an empty paid room closes at once; it never has bots (a creator cannot ask for them)', async () => {
    const { svc, rooms, reader } = setup();
    const a = testSigner().address;
    await expect(svc.create(a, { config: paid(1, { bots: 3 }), txHash: reader.pay(1, a, BASE) })).rejects.toMatchObject({ code: 'bad_request', field: 'bots' });
    const view = await svc.create(a, { config: paid(1, { bots: 0 }), txHash: reader.pay(1, a, BASE) });
    const room = rooms.get(`priv-${view.code}`) as Room;
    tick(room, 30 * 20);
    expect(room.bots).toBeNull();
    expect([...room.world.players.values()].some((p) => p.isBot)).toBe(false);
    svc.close(view.code, { wallet: a, admin: true });
    expect(rooms.get(room.id)).toBeUndefined();
    expect(svc.live).toBe(0);
  });

  it('refuses a holders-only tier to non-holders, a closed tier, and paid rooms when the admin turned them off, before any payment', async () => {
    const { svc, reader, chain } = setup();
    const a = testSigner().address;
    const h = reader.pay(1, a, BASE);
    expect(await fail(svc.create(a, { config: paid(4), txHash: h }))).toMatchObject({ code: 'holders_only', field: 'arenaId', status: 403 });
    expect(await fail(svc.create(a, { config: paid(3), txHash: h }))).toMatchObject({ code: 'bad_request', field: 'arenaId' });
    chain.arenas[1] = { ...chain.arenas[1], enabled: false };
    (svc as unknown as { d: { rooms: { arenaCache: unknown } } }).d.rooms.arenaCache = null;
    expect(await fail(svc.create(a, { config: paid(2), txHash: h }))).toMatchObject({ code: 'bad_request', field: 'arenaId' });
    svc.updateSettings({ paidRooms: false });
    expect(await fail(svc.create(a, { config: paid(1), txHash: h }))).toMatchObject({ code: 'paid_closed' });
    expect((await svc.quote(a)).paidRooms).toBe(false);
    // none of it used the payment
    expect((await svc.create(a, { config: cfgOf(), txHash: h })).paidWith).toBe('paid');
  });

  it('a holder may open the holders-only tier', async () => {
    const { svc, rooms, reader } = setup({ holder: true });
    const a = testSigner().address;
    const view = await svc.create(a, { config: paid(4), txHash: reader.pay(1, a, BASE) });
    expect(rooms.get(`priv-${view.code}`)?.opts.stake).toEqual({ arenaId: 4, buyIn: 250 * FEE });
  });

  it('survives a restart for its remaining time as the same arena instance', async () => {
    const first = setup();
    const a = testSigner().address;
    const view = await first.svc.create(a, { config: paid(2, { durationMin: 60 }), txHash: first.reader.pay(1, a, BASE) });
    first.rooms.shutdown();
    const clock = { t: first.clock.t + 10 * 60_000 };
    const chain = new ArenaChain([arena(1, FEE), arena(2, 10 * FEE)]);
    const rooms = new RoomManager(first.cfg, roomDeps(chain, new Journal(null), () => clock.t), chain);
    const svc = new CustomRoomService({
      rooms,
      dataDir: first.dir,
      used: new UsedPayments(null),
      reader: () => first.reader,
      chainId: () => 31337,
      isHolder: async () => false,
      ownerWallet: TREASURY,
      now: () => clock.t,
    });
    expect(svc.restore()).toBe(1);
    const back = rooms.get(`priv-${view.code}`)!;
    expect(back.opts).toMatchObject({ mode: 'arena', instance: 0, stake: { arenaId: 2, buyIn: 10 * FEE } });
    expect(rooms.list().some((r) => r.id === back.id)).toBe(false);
  });
});

describe('custom ticket rooms run on their own clock (no tie to the arenas\' 5-minute rounds)', () => {
  it('a 60-minute room: one game, no settlement at any of the arenas\' bells, every ticket settled at the room end with the normal fee on profit', async () => {
    const { svc, rooms, reader, clock, journal } = setup();
    const a = testSigner().address;
    const view = await svc.create(a, { config: paid(1, { durationMin: 60 }), txHash: reader.pay(1, a, BASE) });
    expect(view.endsAt - view.createdAt).toBe(60 * 60_000);
    const room = rooms.get(`priv-${view.code}`) as Room;
    const ca = fakeConn('w-a');
    const cb = fakeConn('w-b');
    const ja = stakeJoin(1, FEE);
    const jb = stakeJoin(1, FEE);
    const pa = room.join(ca, ja);
    const pb = room.join(cb, jb);
    // a eats half of b's value (the ledger moves value between this room's tickets only)
    const moved = room.ledger!.transfer(pb.id, pa.id, 10, 20, false);
    expect(moved).toBeGreaterThan(0);
    let bells = 0;
    for (let bell = rooms.roundWindow(clock.t).endsAt; bell < view.endsAt; bell = rooms.roundWindow(bell).endsAt) {
      // the arenas' last minute is no last minute here: joins stay open (the room's own window)
      const w = rooms.roundWindow(bell - 30_000);
      expect(bell - 30_000 >= w.joinsCloseAt).toBe(true);
      expect(rooms.roomWindow(room, bell - 30_000)).toMatchObject({ opensAt: view.createdAt, joinsCloseAt: view.endsAt - 60_000 });
      clock.t = bell;
      tick(room);
      svc.sweep(clock.t);
      bells++;
      // still the same game: both tickets live (so the stale sweeper never touches them), nothing queued, no re-pay
      expect(rooms.liveSessions().has(ja.stake.session) && rooms.liveSessions().has(jb.stake.session)).toBe(true);
      expect(journal.pending).toHaveLength(0);
      expect(svc.seatable(view.code)).toBe(true);
    }
    expect(bells).toBeGreaterThanOrEqual(10);
    expect(ca.msgs.some((m) => m.t === 'roundOver')).toBe(false);
    // the last minute: joins close (mirrored on the room end), the room says so; 10 s before: the countdown
    clock.t = view.endsAt - 60_000;
    svc.sweep(clock.t);
    expect(ca.msgs.some((m) => m.t === 'chat' && m.system && /1 minute left: joins are closed/.test(m.text))).toBe(true);
    clock.t = view.endsAt - ROOM_CLOSE_COUNTDOWN_MS;
    svc.sweep(clock.t);
    expect(ca.msgs.find((m) => m.t === 'closing')).toEqual({ t: 'closing', endsAt: view.endsAt, message: expect.stringMatching(/settled now, at its end/) });
    clock.t = view.endsAt;
    tick(room);
    const va = FEE + moved;
    const vb = FEE - moved;
    const overA = ca.msgs.find((m) => m.t === 'roundOver') as Extract<ServerMessage, { t: 'roundOver' }>;
    const overB = cb.msgs.find((m) => m.t === 'roundOver') as Extract<ServerMessage, { t: 'roundOver' }>;
    // net payout: the fee on profit only (the winner pays it, the loser nothing)
    expect(overA.payout).toBe(profitFee(FEE, va).net);
    expect(overA.payout).toBeLessThan(va);
    expect(overB.payout).toBe(vb);
    // the full board at the room end, value first
    expect(overA.standings.map((r) => [r.rank, r.value])).toEqual([
      [1, va],
      [2, vb],
    ]);
    // the journal carries the gross values (the contract takes the fee); Σ out = Σ in (never more than the vault took)
    const sa = journal.pending.find((i) => i.key === ja.stake.session);
    const sb = journal.pending.find((i) => i.key === jb.stake.session);
    expect(sa).toMatchObject({ kind: 'settle', reason: 'round', payout: va, entryFee: FEE, roundPool: 2 * FEE });
    expect(sb).toMatchObject({ kind: 'settle', reason: 'round', payout: vb, roundPool: 2 * FEE });
    expect(itemAmount(sa!) + itemAmount(sb!)).toBe(2 * FEE);
    // then the room closes (nothing of value left in it)
    svc.sweep(clock.t);
    expect(rooms.get(room.id)).toBeUndefined();
    expect(svc.get(view.code)).toBeNull();
  });

  it('starts at once: the creator is seated the moment it opens, even in the arenas\' last minute or break', async () => {
    const { svc, rooms, reader, clock } = setup();
    const a = testSigner().address;
    // the arenas are in their last minute (joins closed there)
    clock.t = rooms.roundWindow(clock.t).joinsCloseAt + 5_000;
    const view = await svc.create(a, { config: paid(1, { durationMin: 5 }), txHash: reader.pay(1, a, BASE) });
    const room = rooms.get(`priv-${view.code}`) as Room;
    const w = rooms.roomWindow(room, clock.t);
    expect(w).toMatchObject({ opensAt: clock.t, endsAt: clock.t + 5 * 60_000, joinsCloseAt: clock.t + 4 * 60_000 });
    expect(clock.t >= w.opensAt && clock.t < w.joinsCloseAt).toBe(true);
    // the arenas' bell and break pass: the 5-minute room is not reset
    clock.t = rooms.roundWindow(clock.t).endsAt + 10_000;
    expect(rooms.roomWindow(room, clock.t).endsAt).toBe(view.endsAt);
  });

  it('a join that raced the room end is settled at once (nothing waits for a next round: there is none)', async () => {
    const { svc, rooms, reader, clock, journal } = setup();
    const a = testSigner().address;
    const view = await svc.create(a, { config: paid(1, { durationMin: 5 }), txHash: reader.pay(1, a, BASE) });
    const room = rooms.get(`priv-${view.code}`) as Room;
    clock.t = view.endsAt;
    tick(room);
    const conn = fakeConn('w-race');
    const j = stakeJoin(1, FEE);
    room.join(conn, j);
    tick(room);
    expect(journal.pending.find((i) => i.key === j.stake.session)).toMatchObject({ kind: 'settle', reason: 'round', payout: FEE });
    expect(conn.msgs.some((m) => m.t === 'roundOver')).toBe(true);
    expect(room.ledger!.size).toBe(0);
    svc.sweep(clock.t);
    expect(rooms.get(room.id)).toBeUndefined();
  });

  it('the longest room fits under the ticket age cap; a restart re-opens it on the same own clock', async () => {
    expect(CUSTOM_DURATION_LIMITS.max * 60).toBeLessThan(MAX_STAKE_SESSION_AGE_S - 600);
    const first = setup();
    const a = testSigner().address;
    const view = await first.svc.create(a, { config: paid(2, { durationMin: CUSTOM_DURATION_LIMITS.max }), txHash: first.reader.pay(1, a, BASE) });
    expect(view.endsAt - view.createdAt).toBe(CUSTOM_DURATION_LIMITS.max * 60_000);
    first.rooms.shutdown();
    const clock = { t: first.clock.t + 47 * 60_000 };
    const chain = new ArenaChain([arena(1, FEE), arena(2, 10 * FEE)]);
    const rooms = new RoomManager(first.cfg, roomDeps(chain, new Journal(null), () => clock.t), chain);
    const svc = new CustomRoomService({ rooms, dataDir: first.dir, used: new UsedPayments(null), reader: () => first.reader, chainId: () => 31337, isHolder: async () => false, ownerWallet: TREASURY });
    expect(svc.restore()).toBe(1);
    const back = rooms.get(`priv-${view.code}`) as Room;
    expect(back.opts.ownRound).toEqual({ startsAt: view.createdAt, endsAt: view.endsAt });
    expect(back.round()).toMatchObject({ endsAt: view.endsAt, startsAt: view.createdAt });
  });

  it('a free room runs on its own duration too (no rounds at all)', async () => {
    const { svc, rooms, reader, clock } = setup();
    const a = testSigner().address;
    const view = await svc.create(a, { config: cfgOf({ durationMin: 25 }), txHash: reader.pay(1, a, BASE) });
    expect(view.endsAt).toBe(clock.t + 25 * 60_000);
    const room = rooms.get(`priv-${view.code}`) as Room;
    expect(room.round()).toBeUndefined();
    const conn = fakeConn(null);
    room.join(conn, { name: 'Free', skin: 1, flags: 0 });
    for (let bell = rooms.roundWindow(clock.t).endsAt; bell < view.endsAt; bell = rooms.roundWindow(bell).endsAt) {
      clock.t = bell;
      tick(room);
      svc.sweep(clock.t);
      expect(rooms.get(room.id)).toBe(room);
    }
    clock.t = view.endsAt;
    svc.sweep(clock.t);
    expect(rooms.get(room.id)).toBeUndefined();
    expect(conn.msgs.some((m) => m.t === 'roomOver')).toBe(true);
  });
});
