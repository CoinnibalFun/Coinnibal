import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CUSTOM_DEFAULTS,
  CUSTOM_PAYMENT_MAX_AGE_MS,
  PRACTICE_ROOM,
  PROTOCOL_VERSION,
  ROOM_CLOSE_COUNTDOWN_MS,
  TICK_MS,
  CUSTOM_MAP_WIDTH,
  CUSTOM_WORLD_CAPS,
  customRoomPaymentRef,
  parseUsdPrice,
  shopCartRef,
  shopPaymentRef,
  type ChainStatus,
  type CustomRoomConfig,
  type ServerMessage,
} from '@elymum/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { UsedPayments } from '../src/chain/payment';
import { ChainBusyError, NullChain, type ChainArena, type TokenReceipt } from '../src/chain/types';
import type { Room } from '../src/rooms/room';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { CUSTOM_QUOTE_VALID_MS, CustomRoomFail, CustomRoomService, customWorld } from '../src/rooms/custom';
import { RoomManager } from '../src/rooms/manager';
import { arena, fakeConn, roomDeps } from './helpers';
import { ARENA_ADDR, ONE, PRICE, PayChain, TOKEN, hash, requestOf } from './room-pay';
import { testSigner } from './signers';

const cfgOf = (extra: Partial<CustomRoomConfig> = {}): CustomRoomConfig => ({ ...CUSTOM_DEFAULTS, name: 'Friday Pond', ...extra });

function setup(o: { dir?: string | null; holder?: boolean; clock?: { t: number }; reader?: PayChain; usd?: { usdPerToken: string } | null } = {}) {
  const clock = o.clock ?? { t: 1_800_000_000_000 };
  const rooms = new RoomManager(loadConfig({} as NodeJS.ProcessEnv), roomDeps(new NullChain()), new NullChain());
  const reader = o.reader ?? new PayChain(clock);
  const dir = o.dir === undefined ? mkdtempSync(join(tmpdir(), 'elymum-custom-')) : o.dir;
  const used = new UsedPayments(dir ? join(dir, 'chains', '46630', 'room-payments.json') : null);
  const usd = { current: o.usd ?? null };
  const svc = new CustomRoomService({
    rooms,
    dataDir: dir,
    used,
    chain: reader,
    usdPrice: async () => (usd.current ? { price: parseUsdPrice(usd.current.usdPerToken), usdPerToken: usd.current.usdPerToken, sigFigs: 2 } : null),
    receiptRetryMs: [0],
    isHolder: async () => o.holder ?? false,
    now: () => clock.t,
  });
  return { svc, rooms, reader, clock, dir, used, usd };
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

describe('room fee payment (the game token, ElymumArena.pay)', () => {
  it('opens a room for a pay of at least the price from the signed-in wallet with its request ref; the fee is recorded in tokens', async () => {
    const { svc, reader } = setup();
    const alice = testSigner().address;
    const q = await svc.quote(alice);
    expect(q).toMatchObject({ priceRaw: PRICE.toString(), youPayRaw: PRICE.toString(), pay: { token: { address: TOKEN }, payTo: ARENA_ADDR, burnBps: 5000 } });
    expect(q).not.toHaveProperty('payClosed');
    const v = await svc.create(alice, { config: cfgOf(), ...reader.pay(1, alice) });
    expect(v).toMatchObject({ paidWith: 'paid', txHash: hash(1), feeRaw: PRICE.toString(), feeIn: 'token' });
    // paying more than the price is accepted (and recorded as paid)
    const more = await svc.create(alice, { config: cfgOf(), ...reader.pay(2, alice, { value: PRICE + 1n }) });
    expect(more.feeRaw).toBe((PRICE + 1n).toString());
  });

  it('refuses a forged, foreign, misdirected, mis-referenced, underpaid, reverted, tokenless or stale payment, naming the reason', async () => {
    const { svc, reader, clock, used } = setup();
    svc.updateSettings({ maxPerWallet: 10, maxLive: 20 });
    const alice = testSigner().address;
    const bob = testSigner().address;
    const create = (pay: { txHash: string; request: string }) => fail(svc.create(alice, { config: cfgOf(), ...pay }));
    // forged: no such transaction on chain (or not mined yet)
    expect(await create({ txHash: hash(404), request: requestOf(404) })).toMatchObject({ code: 'payment_pending', status: 409 });
    expect(await create({ txHash: 'not-a-hash', request: requestOf(1) })).toMatchObject({ code: 'payment_invalid' });
    // the payment names its request: none, or a malformed one, is refused before the chain is read
    const reads = reader.reads;
    expect(await fail(svc.create(alice, { config: cfgOf(), txHash: reader.pay(2, alice).txHash }))).toMatchObject({ code: 'payment_invalid', field: 'request' });
    expect(await create({ txHash: hash(2), request: 'NOT-A-REQUEST' })).toMatchObject({ code: 'payment_invalid', field: 'request' });
    expect(reader.reads).toBe(reads);
    // somebody else's payment cannot be claimed (bob paid, alice sends his hash and request)
    expect(await create(reader.pay(3, bob))).toMatchObject({ code: 'payment_invalid', message: expect.stringMatching(/another wallet/) });
    // a Paid event of another contract (a look-alike), or to a contract that is not the arena
    expect(await create(reader.pay(4, alice, { contract: bob }))).toMatchObject({ code: 'payment_invalid', message: expect.stringMatching(/arena contract/) });
    // the ref of another request, of a power-up pack or of a cart never opens this room
    expect(await create({ ...reader.pay(5, alice, { ref: customRoomPaymentRef(requestOf(55)) }), request: requestOf(5) })).toMatchObject({ code: 'payment_invalid', message: expect.stringMatching(/something else/) });
    expect(await create(reader.pay(6, alice, { ref: shopPaymentRef('magnet') }))).toMatchObject({ code: 'payment_invalid' });
    expect(await create(reader.pay(7, alice, { ref: shopCartRef({ magnet: 3, leap: 0, speed: 0, invis: 0 }) }))).toMatchObject({ code: 'payment_invalid' });
    expect(await create(reader.pay(8, alice, { value: PRICE - 1n }))).toMatchObject({ code: 'payment_low' });
    expect(await create(reader.pay(9, alice, { status: 'reverted' }))).toMatchObject({ code: 'payment_invalid', message: expect.stringMatching(/failed/) });
    // a Paid event without the token moving (another token, or none)
    expect(await create(reader.pay(10, alice, { token: bob }))).toMatchObject({ code: 'payment_invalid', message: expect.stringMatching(/game token/) });
    expect(await create(reader.pay(11, alice, { token: null }))).toMatchObject({ code: 'payment_invalid' });
    expect(await create(reader.pay(12, alice, { timestamp: clock.t - CUSTOM_PAYMENT_MAX_AGE_MS - 1 }))).toMatchObject({ code: 'payment_stale' });
    // nothing opened, nothing was used up
    expect(svc.live).toBe(0);
    expect(used.size).toBe(0);
    // a refused hash is not burned: once it is a valid payment it opens the room
    reader.pay(8, alice);
    expect((await svc.create(alice, { config: cfgOf(), ...{ txHash: hash(8), request: requestOf(8) } })).paidWith).toBe('paid');
  });

  it('replays: a hash opens one room, a request of a wallet opens one room, another wallet cannot borrow either', async () => {
    const { svc, reader, used } = setup();
    svc.updateSettings({ maxPerWallet: 10, maxLive: 20 });
    const alice = testSigner().address;
    const bob = testSigner().address;
    const first = reader.pay(1, alice);
    const room = await svc.create(alice, { config: cfgOf(), ...first });
    // the same payment for another room: the room it opened, never a second one
    expect((await svc.create(alice, { config: cfgOf({ maxPlayers: 4 }), ...first, request: requestOf(77) })).code).toBe(room.code);
    expect(svc.live).toBe(1);
    // a second payment naming the same request
    expect(await fail(svc.create(alice, { config: cfgOf(), ...reader.pay(2, alice, { request: first.request }) }))).toMatchObject({ code: 'payment_used', field: 'request' });
    // bob sends alice's paid hash: refused, and alice's room is not handed to him
    expect(await fail(svc.create(bob, { config: cfgOf(), ...first }))).toMatchObject({ code: 'payment_used' });
    // bob paying with alice's request id (seen on chain) opens his own room and takes nothing from alice
    const copied = await svc.create(bob, { config: cfgOf(), ...reader.pay(3, bob, { request: requestOf(30) }) });
    expect(copied.creator).toBe(bob);
    expect(used.hasRequest(alice, requestOf(30))).toBe(false);
    expect((await svc.create(alice, { config: cfgOf(), ...reader.pay(4, alice, { request: requestOf(30) }) })).paidWith).toBe('paid');
    // alice asking again with the payment that opened her room (an answer that got lost): the same room, not a second
    const again = await svc.create(alice, { config: cfgOf(), ...first });
    expect(again.code).toBe(room.code);
    expect(svc.mine(alice)).toHaveLength(2);
    // two creates with one hash at once: one room
    const h = reader.pay(5, alice);
    const both = await Promise.allSettled([svc.create(alice, { config: cfgOf(), ...h }), svc.create(alice, { config: cfgOf(), ...h })]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(svc.mine(alice)).toHaveLength(3);
  });

  it('the network being busy keeps the payment safe and unused', async () => {
    const { svc, reader } = setup();
    const alice = testSigner().address;
    const h = reader.pay(1, alice);
    reader.busy = true;
    expect((await fail(svc.create(alice, { config: cfgOf(), ...h }))).code).toBe('chain_busy');
    reader.busy = false;
    expect((await svc.create(alice, { config: cfgOf(), ...h })).txHash).toBe(h.txHash);
  });

  it('before the game token is set: a room that costs something is refused with the reason; the free room of the day and practice still open', async () => {
    const plain = setup();
    plain.reader.tokenSet = false;
    const alice = testSigner().address;
    expect(await plain.svc.quote(alice)).toMatchObject({ pay: null, payClosed: 'no_token', enabled: true, priceRaw: PRICE.toString() });
    const refused = await fail(plain.svc.create(alice, { config: cfgOf(), ...plain.reader.pay(1, alice) }));
    expect(refused).toMatchObject({ code: 'token_not_set', status: 503, message: expect.stringMatching(/paid in tokens.*not live yet/) });
    expect(plain.reader.reads).toBe(0);
    expect(plain.svc.practice({ wallet: alice, ip: '10.0.0.1' }).paidWith).toBe('free');
    // an emblem holder's free room of the day costs nothing: it opens
    const holder = setup({ holder: true });
    holder.reader.tokenSet = false;
    expect(await holder.svc.quote(alice)).toMatchObject({ pay: null, freeAvailable: true, youPayRaw: '0' });
    expect((await holder.svc.create(alice, { config: cfgOf() })).paidWith).toBe('free');
    expect((await fail(holder.svc.create(alice, { config: cfgOf() }))).code).toBe('token_not_set');
    // no chain at all: closed, with its own reason
    const off = new CustomRoomService({ rooms: plain.rooms, dataDir: null, used: new UsedPayments(null), chain: new NullChain(), isHolder: async () => false });
    expect(await off.quote(alice)).toMatchObject({ pay: null, payClosed: 'no_chain' });
    expect((await fail(off.create(alice, { config: cfgOf() }))).code).toBe('rooms_closed');
  });

  it('priced in dollars: $1.50 at the arenas\' token price; a price quoted in the last 15 minutes is honoured', async () => {
    const { svc, reader, clock, usd } = setup({ usd: { usdPerToken: '0.001' } });
    svc.updateSettings({ maxPerWallet: 10, maxLive: 20 });
    const alice = testSigner().address;
    const q = await svc.quote(alice);
    expect(q).toMatchObject({ priceRaw: (1500n * ONE).toString(), usdCents: 150, usdPerToken: '0.001' });
    // the token doubles in dollars after the quote: the room now costs 750 tokens, the quoted 1,500 is more than enough
    usd.current = { usdPerToken: '0.002' };
    expect((await svc.quote(null)).priceRaw).toBe((750n * ONE).toString());
    expect((await svc.create(alice, { config: cfgOf(), ...reader.pay(1, alice, { value: 750n * ONE }) })).feeRaw).toBe((750n * ONE).toString());
    // the token halves: the new price is 3,000, but the 1,500 quoted a minute ago is accepted for 15 minutes
    clock.t += 60_000;
    usd.current = { usdPerToken: '0.001' };
    await svc.quote(alice);
    usd.current = { usdPerToken: '0.0005' };
    expect((await svc.quote(null)).priceRaw).toBe((3000n * ONE).toString());
    expect((await svc.create(alice, { config: cfgOf(), ...reader.pay(2, alice, { value: 1500n * ONE }) })).paidWith).toBe('paid');
    clock.t += CUSTOM_QUOTE_VALID_MS + 1;
    expect(await fail(svc.create(alice, { config: cfgOf(), ...reader.pay(3, alice, { value: 1500n * ONE }) }))).toMatchObject({ code: 'payment_low' });
    // priced in tokens: whole tokens, whatever the dollar price
    svc.updateSettings({ priceIn: 'token', priceTokens: '20' });
    expect(await svc.quote(null)).toMatchObject({ priceRaw: (20n * ONE).toString() });
    expect(await svc.quote(null)).not.toHaveProperty('usdCents');
  });

  it('persists used hashes and requests and refuses an unreadable file instead of forgetting them', () => {
    const alice = testSigner().address;
    const dir = mkdtempSync(join(tmpdir(), 'elymum-pay-'));
    const file = join(dir, 'room-payments.json');
    const a = new UsedPayments(file);
    a.markUsed(hash(1), { at: 1, wallet: alice, code: 'ABCDE', request: requestOf(1), paid: '5' });
    const b = new UsedPayments(file);
    expect(b.has(hash(1))).toBe(true);
    expect(b.hasRequest(alice.toLowerCase(), requestOf(1))).toBe(true);
    expect(b.hasRequest(testSigner().address, requestOf(1))).toBe(false);
    expect(b.get(hash(1))).toMatchObject({ code: 'ABCDE', paid: '5' });
    expect(a.claim(hash(2))).toBe(true);
    expect(a.claim(hash(2))).toBe(false); // in flight
    a.release(hash(2));
    expect(a.claim(hash(2))).toBe(true);
    expect(() => a.markUsed(hash(3), { at: 1, wallet: alice, code: 'ABCDE', request: 'bad' })).toThrow(TypeError);
    writeFileSync(file, '{oops');
    expect(() => new UsedPayments(file)).toThrow(/unreadable/);
  });

  it('the file of the rooms paid in ETH loads as it is: those hashes stay used', () => {
    const alice = testSigner().address;
    const dir = mkdtempSync(join(tmpdir(), 'elymum-pay-old-'));
    const file = join(dir, 'room-payments.json');
    writeFileSync(file, JSON.stringify({ v: 1, used: { [hash(9)]: { at: 1, wallet: alice, code: 'ABCDE' } } }));
    const u = new UsedPayments(file);
    expect(u.has(hash(9))).toBe(true);
    expect(u.size).toBe(1);
  });
});

describe('custom rooms: create, caps, perks', () => {
  it('a paid room opens with its own rules and invite code; the same payment cannot open a second room', async () => {
    const { svc, rooms, reader } = setup();
    const alice = testSigner().address;
    const h = reader.pay(1, alice);
    const view = await svc.create(alice, { config: cfgOf({ mapSize: 'S', bots: 4, difficulty: 'hard', maxPlayers: 6, powerUps: false }), ...h });
    expect(view.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(view).toMatchObject({ name: 'Friday Pond', paidWith: 'paid', txHash: h.txHash, maxPlayers: 6, creator: alice, durationMin: 30 });
    expect(view.endsAt - view.createdAt).toBe(30 * 60_000);
    const room = rooms.privateRoom(view.code) as Room;
    expect(room.opts.custom?.creator).toBe(alice);
    expect(room.world.cfg.width).toBe(CUSTOM_MAP_WIDTH.S);
    expect(room.world.cfg.powerUps).toBe(false);
    expect(room.opts.maxPlayers).toBe(6);
    expect(room.info().custom).toMatchObject({ mapSize: 'S', bots: 4, difficulty: 'hard' });
    // the creator's practice bots walk in at once and stay at the count (an eaten one comes back)
    room.tick(33);
    expect(room.bots?.size).toBe(4);
    expect(room.bots?.opts).toEqual({ count: 4, difficulty: 'hard' });
    // a map settings change leaves a custom room alone
    rooms.applyMapSettings();
    room.tick(33);
    expect(room.bots?.count).toBe(4);
    // not listed publicly (invite only)
    expect(rooms.list().some((r) => r.code === view.code)).toBe(false);
    // the same payment again: its room, not a second one
    expect((await svc.create(alice, { config: cfgOf(), ...h })).code).toBe(view.code);
    expect(svc.live).toBe(1);
  });

  it('refuses a missing, underpaid or foreign payment, and a bad config, without opening a room', async () => {
    const { svc, rooms, reader } = setup();
    const alice = testSigner().address;
    const bob = testSigner().address;
    expect((await fail(svc.create(alice, { config: cfgOf() }))).code).toBe('payment_required');
    expect((await fail(svc.create(alice, { config: cfgOf(), ...reader.pay(2, alice, { value: PRICE / 2n }) }))).code).toBe('payment_low');
    expect((await fail(svc.create(alice, { config: cfgOf(), ...reader.pay(3, bob) }))).code).toBe('payment_invalid');
    expect((await fail(svc.create(alice, { config: cfgOf(), txHash: hash(99), request: requestOf(99) }))).code).toBe('payment_pending');
    const four = reader.pay(4, alice);
    const bad = await fail(svc.create(alice, { config: cfgOf({ bots: 13 }), ...four }));
    expect(bad).toMatchObject({ code: 'bad_request', field: 'bots' });
    expect(svc.live).toBe(0);
    expect(rooms.customRooms()).toHaveLength(0);
    // a refused hash was never marked used: it still works once valid
    expect((await svc.create(alice, { config: cfgOf(), ...four })).paidWith).toBe('paid');
  });

  it('caps: a global cap of live rooms and a per-wallet cap, with a friendly message', async () => {
    const { svc, reader } = setup();
    svc.updateSettings({ maxLive: 3, maxPerWallet: 2 });
    const [a, b, c] = [testSigner().address, testSigner().address, testSigner().address];
    await svc.create(a, { config: cfgOf(), ...reader.pay(1, a) });
    await svc.create(a, { config: cfgOf(), ...reader.pay(2, a) });
    const wl = await fail(svc.create(a, { config: cfgOf(), ...reader.pay(3, a) }));
    expect(wl.code).toBe('wallet_limit');
    await svc.create(b, { config: cfgOf(), ...reader.pay(4, b) });
    const busy = await fail(svc.create(c, { config: cfgOf(), ...reader.pay(5, c) }));
    expect(busy).toMatchObject({ code: 'slots_busy', status: 503 });
    expect(busy.message).toMatch(/All room slots are busy/);
    // checked before the payment is read: nothing was spent on the RPC
    expect((await svc.quote(c)).live).toBe(3);
  });

  it('slots that fill up while a payment is checked: the payment is kept unused for a retry', async () => {
    const { svc, reader, clock } = setup();
    svc.updateSettings({ maxLive: 1 });
    const [a, b] = [testSigner().address, testSigner().address];
    const ha = reader.pay(1, a);
    const hb = reader.pay(2, b);
    // both pass the first cap check; a's create finishes first
    const pa = svc.create(a, { config: cfgOf(), ...ha });
    const pb = svc.create(b, { config: cfgOf(), ...hb });
    await pa;
    const err = await fail(pb);
    expect(err).toMatchObject({ code: 'slots_busy', paid: true });
    svc.close(svc.mine(a)[0].code, { wallet: a, admin: false });
    // the room ends after its countdown, then the slot is free
    clock.t += ROOM_CLOSE_COUNTDOWN_MS;
    svc.sweep();
    expect((await svc.create(b, { config: cfgOf(), ...hb })).txHash).toBe(hb.txHash);
  });

  it('holder perks: a discount, or one free room a day', async () => {
    const { svc, reader, clock } = setup({ holder: true });
    const a = testSigner().address;
    svc.updateSettings({ holderPerk: 'discount' });
    let q = await svc.quote(a);
    expect(q).toMatchObject({ holder: true, holderPerk: 'discount', holderDiscountPct: 50, youPayRaw: (PRICE / 2n).toString(), pay: { payTo: ARENA_ADDR } });
    // half the price is enough for a holder
    expect((await svc.create(a, { config: cfgOf(), ...reader.pay(1, a, { value: PRICE / 2n }) })).paidWith).toBe('paid');

    svc.updateSettings({ holderPerk: 'free_daily', maxPerWallet: 5 });
    q = await svc.quote(a);
    expect(q).toMatchObject({ freeAvailable: true, youPayRaw: '0' });
    expect((await svc.create(a, { config: cfgOf() })).paidWith).toBe('free');
    // the free room of the day is used: the next one is paid in full
    q = await svc.quote(a);
    expect(q).toMatchObject({ freeAvailable: false, youPayRaw: PRICE.toString() });
    expect((await fail(svc.create(a, { config: cfgOf() }))).code).toBe('payment_required');
    clock.t += 24 * 3600_000;
    expect((await svc.create(a, { config: cfgOf() })).paidWith).toBe('free');
  });

  it('the free room of the day is the default perk: one per UTC day, kept across a restart, new at 00:00 UTC', async () => {
    const day = Date.UTC(2027, 0, 15);
    const clock = { t: day + 23 * 3600_000 + 59 * 60_000 + 59_000 }; // 23:59:59 UTC
    const first = setup({ holder: true, clock });
    const a = testSigner().address;
    const b = testSigner().address;
    expect(first.svc.settings.holderPerk).toBe('free_daily');
    expect(await first.svc.quote(a)).toMatchObject({ holderPerk: 'free_daily', freeAvailable: true, youPayRaw: '0' });
    // two creates at once: one free room, the other is refused while the first is under way
    const [r1, r2] = await Promise.allSettled([first.svc.create(a, { config: cfgOf() }), first.svc.create(a, { config: cfgOf() })]);
    expect([r1.status, r2.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect((await first.svc.quote(a)).freeAvailable).toBe(false);
    expect((await fail(first.svc.create(a, { config: cfgOf() }))).code).toBe('payment_required');
    // a bigger room than the base size is never the free one (it is paid in full)
    expect((await first.svc.quote(b)).freeAvailable).toBe(true);
    expect((await fail(first.svc.create(b, { config: cfgOf({ maxPlayers: 20 }) }))).code).toBe('payment_required');
    expect((await first.svc.quote(b)).freeAvailable).toBe(true);

    // a restart the same UTC day: the record is on disk, no second free room
    clock.t += 500;
    const again = setup({ holder: true, clock, dir: first.dir });
    expect((await again.svc.quote(a)).freeAvailable).toBe(false);
    expect((await fail(again.svc.create(a, { config: cfgOf() }))).code).toBe('payment_required');
    const stored = JSON.parse(readFileSync(join(first.dir!, 'site', 'custom-rooms.json'), 'utf8')) as { freeUsed: Record<string, string> };
    expect(stored.freeUsed).toEqual({ [a.toLowerCase()]: '2027-01-15' });

    // 00:00:00 UTC: a new day, a new free room (also after another restart)
    clock.t = day + 24 * 3600_000;
    const nextDay = setup({ holder: true, clock, dir: first.dir });
    expect((await nextDay.svc.quote(a)).freeAvailable).toBe(true);
    expect((await nextDay.svc.create(a, { config: cfgOf() })).paidWith).toBe('free');
    expect((await nextDay.svc.quote(a)).freeAvailable).toBe(false);
    // yesterday's records are dropped from the file
    const later = JSON.parse(readFileSync(join(first.dir!, 'site', 'custom-rooms.json'), 'utf8')) as { freeUsed: Record<string, string> };
    expect(later.freeUsed).toEqual({ [a.toLowerCase()]: '2027-01-16' });
  });

  it('the free room of the day is for emblem holders only', async () => {
    const { svc } = setup({ holder: false });
    const a = testSigner().address;
    expect(await svc.quote(a)).toMatchObject({ holder: false, freeAvailable: false, youPayRaw: PRICE.toString() });
    expect((await fail(svc.create(a, { config: cfgOf() }))).code).toBe('payment_required');
  });

  it('closed creation, guests and admin settings validation', async () => {
    const { svc } = setup();
    const a = testSigner().address;
    expect(await svc.quote(null)).toMatchObject({ holder: false, mine: 0, enabled: true });
    svc.updateSettings({ enabled: false });
    expect((await fail(svc.create(a, { config: cfgOf() }))).code).toBe('rooms_closed');
    // the ETH price and the treasury are retired, with the reason
    expect(() => svc.updateSettings({ priceGas: '0.1' })).toThrow(/priceGas is retired: private rooms are paid in the game token/);
    expect(() => svc.updateSettings({ treasury: '0x2111111111111111111111111111111111111111' })).toThrow(/treasury is retired/);
    expect(() => svc.updateSettings({ maxLive: 1000 })).toThrow(/maxLive/);
    expect(() => svc.updateSettings({ surprise: 1 })).toThrow(/unknown field/);
    expect(() => svc.updateSettings({ priceIn: 'eth' })).toThrow(/priceIn must be "usd" or "token"/);
    expect(() => svc.updateSettings({ usdCents: 0 })).toThrow(/usdCents must be a whole number from 1 to 100000/);
    expect(() => svc.updateSettings({ usdCents: 1.5 })).toThrow(CustomRoomFail);
    expect(() => svc.updateSettings({ priceTokens: '0' })).toThrow(/priceTokens must be above 0/);
    expect(() => svc.updateSettings({ priceTokens: 'free' })).toThrow(/priceTokens must be a token amount/);
    expect(() => svc.updateSettings({ priceTokens: '1.1234567' })).toThrow(/priceTokens/);
    const s = svc.updateSettings({ enabled: true, priceIn: 'token', usdCents: 250, priceTokens: '2000', holderPerk: 'none' });
    expect(s).toMatchObject({ priceIn: 'token', usdCents: 250, priceTokens: '2000', holderPerk: 'none' });
    expect(s).not.toHaveProperty('priceGas');
    expect(s).not.toHaveProperty('treasury');
  });

  it('a settings file from the rooms paid in ETH loads without an error: its price and treasury are dropped, the rest kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-custom-old-'));
    mkdirSync(join(dir, 'site'), { recursive: true });
    const file = join(dir, 'site', 'custom-rooms-settings.json');
    writeFileSync(file, JSON.stringify({ enabled: true, priceGas: '0.002', treasury: '0x2111111111111111111111111111111111111111', holderPerk: 'discount', holderDiscountPct: 40, maxLive: 5, maxPerWallet: 3, capacityStepPct: 50, maxPlayers: 100, maxSeats: 300, paidRooms: true }));
    const logs: string[] = [];
    const rooms = new RoomManager(loadConfig({} as NodeJS.ProcessEnv), roomDeps(new NullChain()), new NullChain());
    const svc = new CustomRoomService({ rooms, dataDir: dir, used: new UsedPayments(null), chain: new PayChain({ t: 0 }), isHolder: async () => false, log: (m) => logs.push(m) });
    expect(svc.settings).toMatchObject({ priceIn: 'usd', usdCents: 150, priceTokens: '1500', holderPerk: 'discount', holderDiscountPct: 40, maxLive: 5, maxPerWallet: 3 });
    expect(svc.settings).not.toHaveProperty('priceGas');
    expect(logs.some((m) => /ETH price \(0\.002\) and the treasury are retired/.test(m))).toBe(true);
    // the next save writes the new shape
    svc.updateSettings({ maxLive: 4 });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ priceIn: 'usd', usdCents: 150, maxLive: 4 });
    expect(saved).not.toHaveProperty('priceGas');
    expect(saved).not.toHaveProperty('treasury');
    expect(existsSync(`${file}.corrupt`)).toBe(false);
  });
});

describe('practice with bots (one click, free, short-lived)', () => {
  it('opens a free room with practice bots for a guest; asking again returns it; it is outside the paid caps', async () => {
    const { svc, rooms, reader, clock } = setup();
    const guest = svc.practice({ wallet: null, ip: '10.0.0.1' });
    expect(guest).toMatchObject({ practice: true, kind: 'free', bots: PRACTICE_ROOM.bots, maxPlayers: PRACTICE_ROOM.maxPlayers, paidWith: 'free', feeRaw: '0', name: PRACTICE_ROOM.name });
    expect(guest.creator).toBe('0x0000000000000000000000000000000000000000');
    expect(guest.endsAt - clock.t).toBe(PRACTICE_ROOM.durationMin * 60_000);
    const room = rooms.privateRoom(guest.code) as Room;
    for (let i = 0; i < 30; i++) room.tick(TICK_MS);
    expect(room.botCounts().bots).toBe(PRACTICE_ROOM.bots);
    expect(room.info().custom).toMatchObject({ practice: true });
    // the same player (same IP, no wallet) gets the same room back
    expect(svc.practice({ wallet: null, ip: '10.0.0.1' }).code).toBe(guest.code);
    // a signed-in player is keyed by wallet
    const a = testSigner().address;
    const mine = svc.practice({ wallet: a, ip: '10.0.0.1' });
    expect(mine.code).not.toBe(guest.code);
    expect(mine.creator).toBe(a);
    expect(svc.practice({ wallet: a.toLowerCase(), ip: '10.9.9.9' }).code).toBe(mine.code);
    // practice rooms take no paid slot, seat or per-wallet room
    expect(svc.live).toBe(0);
    expect(svc.practiceLive).toBe(2);
    expect(svc.seatsUsed()).toBe(0);
    expect(svc.mine(a)).toEqual([]);
    svc.updateSettings({ maxLive: 1, maxPerWallet: 1 });
    expect((await svc.create(a, { config: cfgOf(), ...reader.pay(1, a) })).practice).toBeUndefined();
  });

  it('caps the live practice rooms, can be turned off, and a room nears its end is not handed back', () => {
    const { svc, clock } = setup();
    svc.updateSettings({ practiceMaxLive: 2 });
    svc.practice({ wallet: null, ip: '1.1.1.1' });
    const second = svc.practice({ wallet: null, ip: '2.2.2.2' });
    expect(() => svc.practice({ wallet: null, ip: '3.3.3.3' })).toThrow(expect.objectContaining({ code: 'slots_busy' }));
    svc.updateSettings({ practiceRooms: false });
    expect(() => svc.practice({ wallet: null, ip: '1.1.1.1' })).toThrow(expect.objectContaining({ code: 'rooms_closed' }));
    svc.updateSettings({ practiceRooms: true, practiceMaxLive: 3 });
    // two minutes left: a fresh room, not the old one
    clock.t = second.endsAt - 2 * 60_000;
    expect(svc.practice({ wallet: null, ip: '2.2.2.2' }).code).not.toBe(second.code);
    expect(() => svc.updateSettings({ practiceMaxLive: 51 })).toThrow(/practiceMaxLive must be a whole number from 0 to 50/);
  });

  it('closes once it stood empty for two minutes; while someone plays it runs to its end (countdown, final board)', () => {
    const { svc, rooms, clock } = setup();
    const empty = svc.practice({ wallet: null, ip: '1.1.1.1' });
    const busy = svc.practice({ wallet: null, ip: '2.2.2.2' });
    const c = fakeConn(null);
    (rooms.privateRoom(busy.code) as Room).join(c, { name: 'Pip', skin: 1, flags: 0 });
    svc.sweep(clock.t);
    clock.t += PRACTICE_ROOM.idleMs - 1000;
    svc.sweep(clock.t);
    expect(rooms.privateRoom(empty.code)).not.toBeNull();
    clock.t += 1000;
    svc.sweep(clock.t);
    expect(rooms.privateRoom(empty.code)).toBeNull();
    expect(svc.practiceLive).toBe(1);
    svc.sweep(busy.endsAt - 5000);
    clock.t = busy.endsAt;
    svc.sweep(clock.t);
    expect(rooms.privateRoom(busy.code)).toBeNull();
    expect(c.msgs.some((m) => m.t === 'closing')).toBe(true);
    expect(c.msgs.find((m) => m.t === 'roomOver')).toMatchObject({ players: 1 });
  });
});

describe('custom rooms: lifecycle', () => {
  it('expires at its end time: players and spectators hear room_closed, a late joiner too', async () => {
    const { svc, rooms, reader, clock } = setup();
    const a = testSigner().address;
    const view = await svc.create(a, { config: cfgOf({ durationMin: 15, bots: 0 }), ...reader.pay(1, a) });
    const room = rooms.privateRoom(view.code) as Room;
    const player = fakeConn(null, '10.0.0.1');
    const watcher = fakeConn(null, '10.0.0.2');
    room.join(player, { name: 'Guest', skin: 1, flags: 0 });
    room.spectate(watcher);
    clock.t = view.endsAt - 30_000;
    svc.sweep(clock.t);
    // the "1 minute left" line
    expect(player.msgs.some((m) => m.t === 'chat' && m.system && /1 minute left/.test(m.text))).toBe(true);
    expect(rooms.privateRoom(view.code)).toBe(room);
    clock.t = view.endsAt;
    svc.sweep(clock.t);
    expect(rooms.privateRoom(view.code)).toBeNull();
    expect(svc.get(view.code)).toBeNull();
    for (const c of [player, watcher]) {
      const last = c.msgs.at(-1) as Extract<ServerMessage, { t: 'error' }>;
      expect(last).toMatchObject({ t: 'error', code: 'room_closed' });
      expect(c.room).toBeNull();
      expect(c.player).toBeNull();
    }
    expect(rooms.customClosedLately(view.code)).toBe(true);
    // the code is not handed out again while remembered
    for (let i = 0; i < 200; i++) expect(rooms.newPrivateCode()).not.toBe(view.code);
  });

  it('the creator (or an admin) closes early, after the 10 s countdown and the final board; nobody else can', async () => {
    const { svc, rooms, reader, clock } = setup();
    const [a, b] = [testSigner().address, testSigner().address];
    const v1 = await svc.create(a, { config: cfgOf({ bots: 2 }), ...reader.pay(1, a) });
    const room = rooms.privateRoom(v1.code) as Room;
    // the practice bots take their places
    for (let i = 0; i < 30; i++) room.tick(TICK_MS);
    const player = fakeConn(null);
    const p = room.join(player, { name: 'Pip', skin: 1, flags: 0 });
    const watcher = fakeConn(null);
    room.spectate(watcher);
    expect(() => svc.close(v1.code, { wallet: b, admin: false })).toThrow(/Only the room creator/);
    const closing = svc.close(v1.code, { wallet: a.toLowerCase(), admin: false });
    // not abruptly: everyone sees the countdown with the reason; the room still plays
    expect(closing.endsAt).toBe(clock.t + ROOM_CLOSE_COUNTDOWN_MS);
    for (const c of [player, watcher]) expect(c.msgs.find((m) => m.t === 'closing')).toEqual({ t: 'closing', endsAt: clock.t + ROOM_CLOSE_COUNTDOWN_MS, message: 'The room creator closed this room.' });
    expect(rooms.privateRoom(v1.code)).toBe(room);
    // closing twice does not move the end
    clock.t += 3000;
    expect(svc.close(v1.code, { wallet: a, admin: false }).endsAt).toBe(closing.endsAt);
    // a late joiner gets the countdown too
    const late = fakeConn(null);
    room.spectate(late);
    expect(late.msgs.some((m) => m.t === 'closing')).toBe(true);
    p.stats.playersEaten = 3;
    clock.t = closing.endsAt;
    svc.sweep();
    expect(rooms.privateRoom(v1.code)).toBeNull();
    // the final board (everyone by mass, the practice bots included), then room_closed
    const over = player.msgs.find((m) => m.t === 'roomOver') as Extract<ServerMessage, { t: 'roomOver' }>;
    expect(over).toMatchObject({ message: 'The room creator closed this room.', players: 1 });
    expect(over.standings).toHaveLength(3);
    expect(over.standings.filter((s) => s.isBot)).toHaveLength(2);
    expect(over.standings.map((s) => s.rank)).toEqual([1, 2, 3]);
    expect(over.standings.find((s) => s.you)).toMatchObject({ name: 'Pip', kills: 3 });
    expect(over.stats).toMatchObject({ playersEaten: 3 });
    expect(player.msgs.findIndex((m) => m.t === 'roomOver')).toBeLessThan(player.msgs.findIndex((m) => m.t === 'error' && m.code === 'room_closed'));
    const seen = watcher.msgs.find((m) => m.t === 'roomOver') as Extract<ServerMessage, { t: 'roomOver' }>;
    expect(seen.stats).toBeNull();
    expect(seen.standings.some((s) => s.you)).toBe(false);
    const v2 = await svc.create(a, { config: cfgOf(), ...reader.pay(2, a) });
    svc.close(v2.code, { wallet: b, admin: true });
    clock.t += ROOM_CLOSE_COUNTDOWN_MS;
    svc.sweep();
    expect(svc.live).toBe(0);
    expect(() => svc.close(v2.code, { wallet: a, admin: false })).toThrow(/No open room/);
  });

  it('a room whose time runs out shows the countdown 10 s before its end', async () => {
    const { svc, rooms, reader, clock } = setup();
    const a = testSigner().address;
    const v = await svc.create(a, { config: cfgOf({ durationMin: 5 }), ...reader.pay(1, a) });
    const c = fakeConn(null);
    (rooms.privateRoom(v.code) as Room).join(c, { name: 'Pip', skin: 1, flags: 0 });
    clock.t = v.endsAt - ROOM_CLOSE_COUNTDOWN_MS - 1000;
    svc.sweep(clock.t);
    expect(c.msgs.some((m) => m.t === 'closing')).toBe(false);
    clock.t += 1000;
    svc.sweep(clock.t);
    expect(c.msgs.filter((m) => m.t === 'closing')).toEqual([{ t: 'closing', endsAt: v.endsAt, message: expect.stringMatching(/Time is up/) }]);
    svc.sweep(clock.t + 500);
    expect(c.msgs.filter((m) => m.t === 'closing')).toHaveLength(1);
    clock.t = v.endsAt;
    svc.sweep(clock.t);
    expect(c.msgs.find((m) => m.t === 'roomOver')).toMatchObject({ message: expect.stringMatching(/Time is up/), players: 1 });
  });

  it('keeps its own leaderboard (best games) and stays off the global one', async () => {
    const { svc, rooms, reader } = setup();
    const a = testSigner().address;
    const view = await svc.create(a, { config: cfgOf({ bots: 0 }), ...reader.pay(1, a) });
    const room = rooms.privateRoom(view.code) as Room;
    const submitted: unknown[] = [];
    (room as unknown as { deps: { leaderboards: { submit: (e: unknown) => void } } }).deps.leaderboards.submit = (e) => submitted.push(e);
    const c = fakeConn(null);
    const p = room.join(c, { name: 'Bubbles', skin: 2, flags: 0 });
    p.stats.maxMass = 420;
    room.leave(c, 'left');
    expect(svc.get(view.code)!.best[0]).toMatchObject({ name: 'Bubbles', score: 420 });
    expect(submitted).toHaveLength(0);
  });

  it('survives a restart for its remaining time; an expired one is dropped; used payments stay used', async () => {
    const clock = { t: 1_800_000_000_000 };
    const first = setup({ clock });
    const a = testSigner().address;
    const h = first.reader.pay(1, a);
    const keep = await first.svc.create(a, { config: cfgOf({ durationMin: 60, name: 'Long one', mapSize: 'L' }), ...h });
    const gone = await first.svc.create(a, { config: cfgOf({ durationMin: 15 }), ...first.reader.pay(2, a) });
    first.svc.onGame(first.rooms.privateRoom(keep.code) as Room, { name: 'Pip', score: 300, kills: 1 });
    first.svc.flush();
    expect(existsSync(join(first.dir!, 'site', 'custom-rooms.json'))).toBe(true);
    first.rooms.shutdown();

    // the server was down for 20 minutes
    clock.t += 20 * 60_000;
    const second = setup({ clock, dir: first.dir, reader: first.reader });
    expect(second.svc.restore()).toBe(1);
    const back = second.rooms.privateRoom(keep.code) as Room;
    expect(back.opts.custom?.endsAt).toBe(keep.endsAt);
    expect(back.world.cfg.width).toBe(CUSTOM_MAP_WIDTH.L);
    expect(back.opts.name).toBe('Long one');
    expect(second.svc.get(keep.code)!.best[0]).toMatchObject({ name: 'Pip' });
    expect(second.rooms.privateRoom(gone.code)).toBeNull();
    // the payment stays used after the restart: asked again it is the room it opened, never a second one
    expect((await second.svc.create(a, { config: cfgOf(), ...h })).code).toBe(keep.code);
    expect(second.used.hasRequest(a, h.request)).toBe(true);
    expect((await fail(second.svc.create(a, { config: cfgOf(), ...second.reader.pay(3, a, { request: h.request }) }))).code).toBe('payment_used');
    // the hash of the room that ended is refused too
    const goneHash = { txHash: hash(2), request: requestOf(2) };
    expect((await fail(second.svc.create(a, { config: cfgOf(), ...goneHash }))).code).toBe('payment_used');
    const stored = JSON.parse(readFileSync(join(first.dir!, 'site', 'custom-rooms.json'), 'utf8'));
    expect(stored.rooms.map((r: { code: string }) => r.code)).toEqual([keep.code]);
  });

  it('worlds scale with the map size and food choice', () => {
    const s = customWorld(cfgOf({ mapSize: 'S' }));
    const l = customWorld(cfgOf({ mapSize: 'L' }));
    const lHigh = customWorld(cfgOf({ mapSize: 'L', food: 'high' }));
    expect(s.width).toBeLessThan(l.width);
    expect(s.foodTarget).toBeLessThan(l.foodTarget);
    expect(lHigh.foodTarget).toBeGreaterThan(l.foodTarget);
    expect(customWorld(cfgOf({ powerUps: false })).maxPowerUps).toBe(0);
  });

  it('traps set the cacti; XS..XL stay within the CPU caps; old rooms without traps read as normal', () => {
    const none = customWorld(cfgOf({ traps: 'none' }));
    const few = customWorld(cfgOf({ traps: 'few' }));
    const normal = customWorld(cfgOf({ traps: 'normal' }));
    const many = customWorld(cfgOf({ traps: 'many' }));
    expect(none.virusTarget).toBe(0);
    expect(few.virusTarget).toBeGreaterThan(0);
    expect(few.virusTarget).toBeLessThan(normal.virusTarget);
    expect(many.virusTarget).toBeGreaterThan(normal.virusTarget);
    const xs = customWorld(cfgOf({ mapSize: 'XS' }));
    const xl = customWorld(cfgOf({ mapSize: 'XL', food: 'high', traps: 'many' }));
    expect(xs.width).toBe(CUSTOM_MAP_WIDTH.XS);
    expect(xl.width).toBe(CUSTOM_MAP_WIDTH.XL);
    expect(xl.foodTarget).toBeLessThanOrEqual(CUSTOM_WORLD_CAPS.food);
    expect(xl.virusTarget).toBeLessThanOrEqual(CUSTOM_WORLD_CAPS.viruses);
    expect(xs.foodTarget).toBeGreaterThan(100);
    const { traps: _t, ...old } = cfgOf({});
    expect(customWorld(old as CustomRoomConfig).virusTarget).toBe(normal.virusTarget);
  });
});

describe('custom rooms over HTTP and WebSocket', () => {
  let app: App | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function boot(chain: PayChain, admin: string, customNow?: () => number) {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-custom-http-'));
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0', GAME_ACCESS: 'public' } as NodeJS.ProcessEnv);
    app = await createApp(cfg, {
      chain,
      log: () => {},
      persist: true,
      customNow,
      siteLimits: { writeIp: new Limiter(10_000, 60_000), writeWallet: new Limiter(10_000, 60_000), login: new Limiter(10_000, 60_000) },
      apiLimiter: new Limiter(10_000, 60_000),
    });
    const port = await app.listen();
    const call = async (method: string, path: string, opts: { wallet?: string; body?: unknown } = {}) => {
      const headers: Record<string, string> = {};
      if (opts.wallet) headers.Authorization = `Bearer ${app!.auth.issueToken(opts.wallet)}`;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { port, call, dir };
  }

  it('practice with bots over HTTP: a guest gets a room and an invite; creations are rate-limited per IP', async () => {
    const admin = testSigner().address;
    const { call } = await boot(new PayChain({ t: Date.now() }, [arena(1, 1000)]), admin);
    const first = await call('POST', '/api/rooms/custom/practice');
    expect(first.status).toBe(200);
    expect(first.body.room).toMatchObject({ practice: true, bots: PRACTICE_ROOM.bots });
    expect(first.body.invite).toMatch(new RegExp(`/play\\?room=${first.body.room.code}$`));
    // asking again returns the same room (still counted against the IP's creations)
    expect((await call('POST', '/api/rooms/custom/practice')).body.room.code).toBe(first.body.room.code);
    expect((await call('GET', '/api/rooms/custom/practice')).status).toBe(405);
    for (let i = 2; i < PRACTICE_ROOM.perIp; i++) await call('POST', '/api/rooms/custom/practice');
    const limited = await call('POST', '/api/rooms/custom/practice');
    expect(limited).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  });

  it('guests cannot create; a wallet pays and gets an invite; anyone joins with the code; admin lists and closes', async () => {
    const admin = testSigner().address;
    const clock = { t: Date.now() };
    const reader = new PayChain(clock, [arena(1, 1000)]);
    const { port, call } = await boot(reader, admin, () => clock.t);
    const alice = testSigner().address;
    expect((await call('GET', '/api/rooms/custom/quote')).body).toMatchObject({ enabled: true, priceRaw: PRICE.toString(), pay: { payTo: ARENA_ADDR, token: { address: TOKEN } }, chainId: 31337 });
    expect((await call('POST', '/api/rooms/custom', { body: { config: cfgOf() } })).status).toBe(401);
    const unpaid = await call('POST', '/api/rooms/custom', { wallet: alice, body: { config: cfgOf() } });
    expect(unpaid).toMatchObject({ status: 402, body: { error: 'payment_required' } });
    const made = await call('POST', '/api/rooms/custom', { wallet: alice, body: { config: cfgOf({ bots: 2 }), ...reader.pay(1, alice) } });
    expect(made.status).toBe(201);
    const code: string = made.body.room.code;
    expect(made.body.invite).toMatch(new RegExp(`/play\\?room=${code}$`));
    expect((await call('GET', `/api/rooms/custom/${code}`)).body.room).toMatchObject({ code, name: 'Friday Pond' });
    expect((await call('GET', `/api/rooms/custom/${code.toLowerCase()}`)).status).toBe(200);
    expect((await call('GET', '/api/rooms/custom/mine', { wallet: alice })).body.rooms).toHaveLength(1);
    expect((await call('GET', '/api/rooms/custom/ZZZZZ')).status).toBe(404);

    // a guest joins by code over the socket
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs: ServerMessage[] = [];
    ws.on('message', (d, bin) => {
      if (!bin) msgs.push(JSON.parse(String(d)));
    });
    await new Promise<void>((r) => ws.once('open', () => r()));
    const waitFor = async (pred: (m: ServerMessage) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const m = msgs.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('message never came');
    };
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    await waitFor((m) => m.t === 'welcome');
    ws.send(JSON.stringify({ t: 'join', room: `private:${code}`, name: 'Guest', skin: 1 }));
    const joined = (await waitFor((m) => m.t === 'joined')) as Extract<ServerMessage, { t: 'joined' }>;
    expect(joined.room.custom).toMatchObject({ creator: alice, bots: 2 });
    expect(joined.room.code).toBe(code);

    // admin view and close
    const bob = testSigner().address;
    expect((await call('GET', '/api/admin/custom-rooms', { wallet: bob })).status).toBe(403);
    const list = await call('GET', '/api/admin/custom-rooms', { wallet: admin });
    expect(list.body.rooms.map((r: { code: string }) => r.code)).toEqual([code]);
    expect(list.body.settings).toMatchObject({ priceIn: 'usd', usdCents: 150, maxLive: 6, maxPerWallet: 2 });
    // where fees are paid and the base price now (no USD price set: the token price)
    expect(list.body).toMatchObject({ pay: { payTo: ARENA_ADDR, burnBps: 5000 }, base: { raw: PRICE.toString(), decimals: 18 } });
    expect((await call('PUT', '/api/admin/custom-rooms', { wallet: admin, body: { priceGas: '0.1' } })).body).toMatchObject({ error: 'bad_request', field: 'priceGas' });
    expect((await call('PUT', '/api/admin/custom-rooms', { wallet: admin, body: { maxLive: 0 } })).body.settings.maxLive).toBe(0);
    expect((await call('DELETE', `/api/rooms/custom/${code}`, { wallet: bob })).status).toBe(403);
    // closing: the countdown first, the room still listed until it ends
    expect((await call('DELETE', `/api/admin/custom-rooms/${code}`, { wallet: admin })).body.rooms.map((r: { code: string }) => r.code)).toEqual([code]);
    expect(await waitFor((m) => m.t === 'closing')).toMatchObject({ message: 'An admin closed this room.' });
    clock.t += ROOM_CLOSE_COUNTDOWN_MS;
    expect(await waitFor((m) => m.t === 'roomOver')).toMatchObject({ message: 'An admin closed this room.' });
    await waitFor((m) => m.t === 'error' && m.code === 'room_closed');
    msgs.length = 0;
    ws.send(JSON.stringify({ t: 'join', room: `private:${code}`, name: 'Guest', skin: 1 }));
    expect(await waitFor((m) => m.t === 'error')).toMatchObject({ code: 'room_closed' });
    const busy = await call('POST', '/api/rooms/custom', { wallet: alice, body: { config: cfgOf(), ...reader.pay(2, alice) } });
    expect(busy).toMatchObject({ status: 503, body: { error: 'slots_busy' } });
    ws.close();
  });
});
