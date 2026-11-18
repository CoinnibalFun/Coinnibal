import { BOOST_RULES, CellFlag, PlayerFlag, RULES, OLD_SHOP_PRICES, SHOP_DEFAULTS, TICK_MS, leapDistance, packPriceRaw, parseUsdPrice, customRoomPaymentRef, shopCartRefs, shopPaymentRef, shopPaymentRefs, type ServerMessage } from '@coinnibal/shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BotBrain } from '../src/bots/brain';
import { mulberry32 } from '../src/game/rng';
import { ViewState } from '../src/rooms/visibility';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChainBusyError, type TokenReceipt } from '../src/chain/types';
import { World, type WorldConfig } from '../src/game/world';
import { Room } from '../src/rooms/room';
import { BoostInventory } from '../src/shop/inventory';
import { ShopFail, ShopService, type UseContext } from '../src/shop/service';
import { ShopSettingsError, ShopSettingsStore, applyShopSettings } from '../src/shop/settings';
import { SHOP_PAYMENT_MAX_AGE_MS, verifyPurchase } from '../src/shop/verify';
import { ArenaChain, MID_ROUND, fakeConn, roomDeps } from './helpers';

const cfg = (over: Partial<WorldConfig> = {}): WorldConfig => ({
  width: 4000,
  height: 4000,
  foodTarget: 0,
  virusTarget: 0,
  maxPowerUps: 0,
  powerUps: false,
  coinRain: false,
  seed: 7,
  ...over,
});
const run = (w: World, ms: number) => {
  for (let i = 0; i < Math.ceil(ms / TICK_MS); i++) w.tick(TICK_MS);
};

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x0000000000000000000000000000000000000707';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const ONE = 10n ** 18n;

/* ------------------------------------------------------------------ */
/* World effects                                                       */
/* ------------------------------------------------------------------ */

describe('boosts: world effects', () => {
  it('magnet pulls food (not loot, not coins) for 8 s and shows the magnet flag', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 1000, y: 1000, mass: 100 });
    const other = w.addPlayer({ spawnShield: false, name: 'b', skin: 0, x: 1180, y: 1000, mass: 30 });
    const f = w.spawnFood(1150, 1000, 0);
    w.restoreLoot([{ x: 1000, y: 1160, value: 5 }]);
    expect(w.useBoost(p.id, 'magnet')).toBe(true);
    const before = Math.hypot(f.x - 1000, f.y - 1000);
    w.tick(TICK_MS);
    expect(Math.hypot(f.x - p.cells[0].x, f.y - p.cells[0].y)).toBeLessThan(before);
    expect(p.cells[0].flags & CellFlag.Magnet).toBeTruthy();
    expect(w.loot()[0]).toMatchObject({ x: 1000, y: 1160 });
    expect(other.cells[0].x).toBeGreaterThan(1150);
    run(w, BOOST_RULES.magnet.durationMs + 100);
    expect(p.cells[0].flags & CellFlag.Magnet).toBe(0);
  });

  it('speed burst is faster for 3 s, then normal', () => {
    const fast = new World(cfg());
    const slow = new World(cfg());
    const a = fast.addPlayer({ spawnShield: false, name: 'a', skin: 0, x: 500, y: 500, mass: 50 });
    const b = slow.addPlayer({ spawnShield: false, name: 'b', skin: 0, x: 500, y: 500, mass: 50 });
    fast.setTarget(a.id, 3500, 500);
    slow.setTarget(b.id, 3500, 500);
    fast.useBoost(a.id, 'speed');
    run(fast, 1000);
    run(slow, 1000);
    expect(a.cells[0].x - 500).toBeGreaterThan((b.cells[0].x - 500) * 1.3);
    expect(a.cells[0].flags & CellFlag.Pump).toBeTruthy();
    run(fast, BOOST_RULES.speed.durationMs);
    expect(a.cells[0].flags & CellFlag.Pump).toBe(0);
  });

  it('leap: every cell jumps the same step toward the aim; the flag shows briefly', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'me', skin: 0, x: 2000, y: 2000, mass: 20 });
    w.setTarget(p.id, 3000, 2000);
    const x0 = p.cells[0].x;
    expect(w.useBoost(p.id, 'leap')).toBe(true);
    w.tick(TICK_MS);
    const jumped = p.cells[0].x - x0;
    // the leap plus at most one tick of walking
    expect(jumped).toBeGreaterThan(leapDistance(p.cells[0].r) - 5);
    expect(jumped).toBeLessThan(leapDistance(p.cells[0].r) + 30);
    expect(Math.abs(p.cells[0].y - 2000)).toBeLessThan(2);
    expect(p.cells[0].flags & CellFlag.Leap).toBeTruthy();
    run(w, BOOST_RULES.leap.fxMs + 50);
    expect(p.cells[0].flags & CellFlag.Leap).toBe(0);
  });

  it('leap never crosses the border, and gets a coin out of a corner', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'me', skin: 0, x: 3950, y: 3950, mass: 100 });
    // into the wall: it lands inside (then walks against the wall like any coin)
    w.setTarget(p.id, 6000, 6000);
    w.useBoost(p.id, 'leap');
    w.tick(TICK_MS);
    const c = p.cells[0];
    expect(c.x + c.r * 0.5).toBeLessThanOrEqual(w.x1 + 1e-6);
    expect(c.y + c.r * 0.5).toBeLessThanOrEqual(w.y1 + 1e-6);
    expect(c.x).toBeGreaterThan(3800);
    // out of the corner toward the middle
    const before = { x: c.x, y: c.y };
    w.setTarget(p.id, 2000, 2000);
    w.tick(TICK_MS);
    (w as unknown as { now: number }).now += BOOST_RULES.leap.cooldownMs;
    w.useBoost(p.id, 'leap');
    w.tick(TICK_MS);
    expect(Math.hypot(c.x - before.x, c.y - before.y)).toBeGreaterThan(leapDistance(c.r) * 0.9);
  });

  it('leap moves a split player as one (the formation keeps) and eating works where it lands', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'me', skin: 0, x: 1000, y: 2000, mass: 200 });
    w.setTarget(p.id, 3000, 2000);
    w.splitPlayer(p);
    run(w, 100);
    const big = p.biggestCell()!;
    const d = leapDistance(big.r);
    // a crumb waits where the leap lands
    const c = p.center();
    const crumb = w.addPlayer({ spawnShield: false, name: 'crumb', skin: 0, x: big.x + d, y: big.y, mass: 10 });
    w.setTarget(crumb.id, big.x + d, big.y);
    const gaps = p.cells.map((q) => q.x - big.x);
    w.useBoost(p.id, 'leap');
    w.tick(TICK_MS);
    expect(p.center().x - c.x).toBeGreaterThan(d * 0.8);
    p.cells.forEach((q, i) => expect(Math.abs(q.x - big.x - gaps[i])).toBeLessThan(60));
    expect(crumb.alive).toBe(false);
  });

  it('invisibility: 10 s of the flag; the coins still eat and can be eaten', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'ghost', skin: 0, x: 2000, y: 2000, mass: 100 });
    const crumb = w.addPlayer({ spawnShield: false, name: 'crumb', skin: 0, x: 2030, y: 2000, mass: 10 });
    w.setTarget(crumb.id, 2030, 2000);
    expect(w.useBoost(p.id, 'invis')).toBe(true);
    w.tick(TICK_MS);
    expect(w.isInvisible(p)).toBe(true);
    expect(p.cells[0].flags & CellFlag.Invisible).toBeTruthy();
    expect(crumb.alive).toBe(false);
    const whale = w.addPlayer({ spawnShield: false, name: 'whale', skin: 0, x: 2000, y: 2000, mass: 900 });
    w.setTarget(whale.id, p.cells[0].x, p.cells[0].y);
    run(w, 300);
    expect(p.alive).toBe(false);
    expect(whale.alive).toBe(true);
  });

  it('invisibility ends after its duration', () => {
    const w = new World(cfg());
    const p = w.addPlayer({ spawnShield: false, name: 'ghost', skin: 0, x: 2000, y: 2000, mass: 100 });
    w.useBoost(p.id, 'invis');
    run(w, BOOST_RULES.invis.durationMs - 200);
    expect(p.cells[0].flags & CellFlag.Invisible).toBeTruthy();
    run(w, 400);
    expect(w.isInvisible(p)).toBe(false);
    expect(p.cells[0].flags & CellFlag.Invisible).toBe(0);
  });

  it('anti-cheat: other viewers are not sent an invisible coin at all; its owner is, and it comes back after', () => {
    const w = new World(cfg());
    const ghost = w.addPlayer({ spawnShield: false, name: 'ghost', skin: 0, x: 2000, y: 2000, mass: 100 });
    const other = w.addPlayer({ spawnShield: false, name: 'other', skin: 0, x: 2300, y: 2000, mass: 100 });
    const rect = { x0: 1000, y0: 1000, x1: 3000, y1: 3000 };
    const v = { x: 2000, y: 2000, h: 2000 };
    const theirs = new ViewState();
    const mine = new ViewState();
    const ids = (s: ReturnType<ViewState['build']>) => (s?.upserts ?? []).map((u) => u.id);
    const ghostCell = ghost.cells[0].id;
    expect(ids(theirs.build(w, rect, v, 0, undefined, other.id))).toContain(ghostCell);
    w.useBoost(ghost.id, 'invis');
    w.tick(TICK_MS);
    const snap = theirs.build(w, rect, v, 0, undefined, other.id)!;
    expect(ids(snap)).not.toContain(ghostCell);
    expect(snap.removals.map((r) => r.id)).toContain(ghostCell);
    expect(snap.players.map((p) => p.id)).not.toContain(ghost.id);
    // a spectator (no player) does not get it either
    expect(ids(new ViewState().build(w, rect, v, 0, undefined, null))).not.toContain(ghostCell);
    // the owner does, with the flag
    const own = mine.build(w, rect, v, 0, undefined, ghost.id)!;
    expect(own.upserts.find((u) => u.id === ghostCell)?.flags! & CellFlag.Invisible).toBeTruthy();
    run(w, BOOST_RULES.invis.durationMs + 100);
    expect(ids(theirs.build(w, rect, v, 0, undefined, other.id))).toContain(ghostCell);
  });

  it('bots cannot see an invisible coin', () => {
    const w = new World(cfg());
    const bot = w.addPlayer({ spawnShield: false, name: 'bot', skin: 0, x: 2000, y: 2000, mass: 400, isBot: true });
    const prey = w.addPlayer({ spawnShield: false, name: 'prey', skin: 0, x: 2250, y: 2000, mass: 30 });
    w.setTarget(prey.id, 2250, 2000);
    // a hard bot hunts the prey it sees (its aim goes right, toward it); invisible, the prey is not there for it
    const aimX = () => new BotBrain('hard', mulberry32(4), w.now).think(w, bot, w.now)!.target.x;
    expect(aimX()).toBeGreaterThan(2000);
    w.useBoost(prey.id, 'invis');
    w.tick(TICK_MS);
    w.removePlayer(prey.id);
    const alone = aimX();
    const p2 = w.addPlayer({ spawnShield: false, name: 'prey', skin: 0, x: 2250, y: 2000, mass: 30 });
    w.useBoost(p2.id, 'invis');
    w.tick(TICK_MS);
    expect(aimX()).toBe(alone);
  });

  it('useBoost refuses a dead or unknown player', () => {
    const w = new World(cfg());
    expect(w.useBoost(99, 'magnet')).toBe(false);
    const p = w.addPlayer({ name: 'x', skin: 0, x: 100, y: 100 });
    w.removePlayer(p.id);
    expect(w.useBoost(p.id, 'leap')).toBe(false);
    expect(w.useBoost(p.id, 'invis')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Purchase verification                                               */
/* ------------------------------------------------------------------ */

/** The arena of the test chains (`ArenaChain.status().arenaAddress`): power-ups are paid to it with `pay`. */
const ARENA_ADDR = '0x00000000000000000000000000000000000A7e4A';
const REF = shopPaymentRef('magnet');

/** The receipt of `CoinnibalArena.pay(value, ref)` from `from`: the token transfer to the arena and the `Paid` event. */
const payReceipt = (value: bigint, o: { from?: string; ref?: string; contract?: string; token?: string; transferValue?: bigint } = {}): TokenReceipt => ({
  status: 'success',
  blockNumber: 10n,
  transfers: [{ token: o.token ?? TOKEN, from: o.from ?? WALLET, to: o.contract ?? ARENA_ADDR, value: o.transferValue ?? value }],
  payments: [{ contract: o.contract ?? ARENA_ADDR, payer: o.from ?? WALLET, ref: o.ref ?? REF, amount: value }],
});

describe('boosts: verifyPurchase (a Paid event of CoinnibalArena.pay)', () => {
  const exp = { token: TOKEN, from: WALLET, arena: ARENA_ADDR, ref: REF, amounts: [300n * ONE] };
  it('accepts the exact payment (any address case)', () => {
    expect(verifyPurchase(payReceipt(300n * ONE), { ...exp, from: WALLET.toUpperCase().replace('0X', '0x'), arena: ARENA_ADDR.toLowerCase() })).toEqual({ ok: true, paid: 300n * ONE });
  });
  it('refuses pending, reverted, no payment, another contract, another payer, another pack, a wrong amount, no token move', () => {
    expect(verifyPurchase(null, exp)).toEqual({ ok: false, code: 'tx_pending' });
    expect(verifyPurchase({ ...payReceipt(300n * ONE), status: 'reverted' }, exp)).toEqual({ ok: false, code: 'tx_failed' });
    // a plain token transfer is not a payment any more
    expect(verifyPurchase({ ...payReceipt(300n * ONE), payments: [] }, exp)).toEqual({ ok: false, code: 'no_payment' });
    expect(verifyPurchase(payReceipt(300n * ONE, { contract: OTHER }), exp)).toEqual({ ok: false, code: 'wrong_recipient' });
    expect(verifyPurchase(payReceipt(300n * ONE, { from: OTHER }), exp)).toEqual({ ok: false, code: 'wrong_sender' });
    expect(verifyPurchase(payReceipt(300n * ONE, { ref: shopPaymentRef('leap') }), exp)).toEqual({ ok: false, code: 'wrong_pack' });
    expect(verifyPurchase(payReceipt(299n * ONE), exp)).toEqual({ ok: false, code: 'wrong_amount' });
    expect(verifyPurchase(payReceipt(301n * ONE), exp)).toEqual({ ok: false, code: 'wrong_amount' });
    expect(verifyPurchase(payReceipt(300n * ONE, { token: OTHER }), exp)).toEqual({ ok: false, code: 'wrong_token' });
    expect(verifyPurchase(payReceipt(300n * ONE, { transferValue: 1n }), exp)).toEqual({ ok: false, code: 'wrong_token' });
  });
  it('the pack ref is coinnibal.shop.<kind> in ASCII, 32 bytes', () => {
    expect(shopPaymentRef('magnet')).toBe(`0x${Buffer.from('coinnibal.shop.magnet').toString('hex').padEnd(64, '0')}`);
    expect(new Set(['magnet', 'leap', 'speed', 'invis'].map((k) => shopPaymentRef(k as 'magnet'))).size).toBe(4);
  });
  it('accepts a pack paid with the ref of before the rename (elymum.shop.<kind>), with every other check unchanged', () => {
    const old = `0x${Buffer.from('elymum.shop.magnet').toString('hex').padEnd(64, '0')}`;
    expect(shopPaymentRefs('magnet')).toEqual([shopPaymentRef('magnet'), old]);
    const both = { ...exp, ref: shopPaymentRefs('magnet') };
    expect(verifyPurchase(payReceipt(300n * ONE), both)).toEqual({ ok: true, paid: 300n * ONE });
    expect(verifyPurchase(payReceipt(300n * ONE, { ref: old }), both)).toEqual({ ok: true, paid: 300n * ONE });
    // the old ref of another pack, from another wallet, of another amount, to another arena: refused as before
    expect(verifyPurchase(payReceipt(300n * ONE, { ref: shopPaymentRefs('leap')[1] }), both)).toEqual({ ok: false, code: 'wrong_pack' });
    expect(verifyPurchase(payReceipt(300n * ONE, { ref: old, from: OTHER }), both)).toEqual({ ok: false, code: 'wrong_sender' });
    expect(verifyPurchase(payReceipt(299n * ONE, { ref: old }), both)).toEqual({ ok: false, code: 'wrong_amount' });
    expect(verifyPurchase(payReceipt(300n * ONE, { ref: old, contract: OTHER }), both)).toEqual({ ok: false, code: 'wrong_recipient' });
    expect(verifyPurchase(payReceipt(300n * ONE, { ref: old, token: OTHER }), both)).toEqual({ ok: false, code: 'wrong_token' });
    // only where the expectation lists it: the new ref alone does not take the old one
    expect(verifyPurchase(payReceipt(300n * ONE, { ref: old }), exp)).toEqual({ ok: false, code: 'wrong_pack' });
  });
  it('a ref of one kind never matches another kind, under either prefix (a pack, a cart, a room fee)', () => {
    const kinds: Record<string, readonly string[]> = {
      pack: shopPaymentRefs('magnet'),
      cart: shopCartRefs({ magnet: 1, leap: 0, speed: 0, invis: 0 }),
      room: [customRoomPaymentRef('abcdefghijk23456')],
    };
    for (const [a, mine] of Object.entries(kinds))
      for (const [b, wanted] of Object.entries(kinds)) {
        if (a === b) continue;
        for (const ref of mine) expect(verifyPurchase(payReceipt(300n * ONE, { ref }), { ...exp, ref: wanted }), `${a} paid, ${b} wanted`).toEqual({ ok: false, code: 'wrong_pack' });
      }
  });
  it('refuses a payment older than SHOP_PAYMENT_MAX_AGE_MS (a lost used-hash list cannot re-credit old purchases)', () => {
    const now = 1_900_000_000_000;
    expect(verifyPurchase({ ...payReceipt(300n * ONE), timestamp: now - SHOP_PAYMENT_MAX_AGE_MS + 1 }, { ...exp, now })).toEqual({ ok: true, paid: 300n * ONE });
    expect(verifyPurchase({ ...payReceipt(300n * ONE), timestamp: now - SHOP_PAYMENT_MAX_AGE_MS - 1 }, { ...exp, now })).toEqual({ ok: false, code: 'tx_stale' });
    expect(verifyPurchase({ ...payReceipt(300n * ONE), timestamp: now - 10 * 60_000 }, { ...exp, now, maxAgeMs: 60_000 })).toEqual({ ok: false, code: 'tx_stale' });
    // a wrong payment keeps its own, more specific reason
    expect(verifyPurchase({ ...payReceipt(1n), timestamp: 0 }, { ...exp, now })).toEqual({ ok: false, code: 'wrong_amount' });
  });
});

/* ------------------------------------------------------------------ */
/* Shop service: buying                                                */
/* ------------------------------------------------------------------ */

class ShopChain extends ArenaChain {
  receipts = new Map<string, TokenReceipt>();
  busy = false;
  reads = 0;
  constructor() {
    super([]);
  }
  async tokenReceipt(h: string): Promise<TokenReceipt | null> {
    this.reads++;
    if (this.busy) throw new ChainBusyError('test');
    return this.receipts.get(h) ?? null;
  }
}

function shopFixture(opts: { holder?: boolean; dir?: string | null; settings?: Record<string, unknown>; usd?: { usdPerToken: string; sigFigs?: number } } = {}) {
  const chain = new ShopChain();
  const settings = new ShopSettingsStore(opts.dir ?? null);
  if (opts.settings) settings.update(opts.settings);
  const inventory = new BoostInventory(opts.dir ? join(opts.dir, 'boosts.json') : null);
  let now = 1_000_000;
  const holders = new Set<string>(opts.holder ? [WALLET.toLowerCase()] : []);
  const usd: { v: { usdPerToken: string; sigFigs?: number } | null } = { v: opts.usd ?? null };
  const shop = new ShopService({
    settings,
    inventory,
    chain,
    holder: async (w) => holders.has(w.toLowerCase()),
    usdPrice: async () => (usd.v ? { price: parseUsdPrice(usd.v.usdPerToken), usdPerToken: usd.v.usdPerToken, sigFigs: usd.v.sigFigs ?? 2 } : null),
    now: () => now,
    receiptRetryMs: [0, 1],
  });
  return { chain, settings, inventory, shop, holders, usd, tick: (ms: number) => (now += ms) };
}

/** Records a `pay` of `value` for the pack `kind` (default: the one the test buys, read from the claim). */
const pay = (
  chain: ShopChain,
  h: string,
  value: bigint,
  o: { kind?: 'magnet' | 'leap' | 'speed' | 'invis'; contract?: string; from?: string; token?: string } = {},
) => chain.receipts.set(h, payReceipt(value, { ref: shopPaymentRef(o.kind ?? 'magnet'), ...(o.contract ? { contract: o.contract } : {}), ...(o.from ? { from: o.from } : {}), ...(o.token ? { token: o.token } : {}) }));

async function buyFails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ShopFail) return err.code;
    throw err;
  }
  return 'ok';
}

describe('boosts: buying', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('credits a pack for an exact payment to the burn address', async () => {
    const { chain, shop } = shopFixture();
    pay(chain, hash(1), 600n * ONE);
    const r = await shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) });
    expect(r).toMatchObject({ ok: true, kind: 'magnet', added: 3, charges: { magnet: 3, leap: 0, speed: 0, invis: 0 } });
  });

  it('refuses a duplicate hash (also in another case), a forged one, wrong amount and wrong sender', async () => {
    const { chain, shop, inventory } = shopFixture();
    pay(chain, hash(1), 600n * ONE);
    await shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) }))).toBe('tx_used');
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(1).toUpperCase().replace('0X', '0x') }))).toBe('tx_used');
    // forged: no such transaction on chain
    expect(await buyFails(shop.buy(WALLET, { kind: 'speed', txHash: hash(2) }))).toBe('tx_pending');
    pay(chain, hash(3), 1499n * ONE);
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(3) }))).toBe('wrong_amount');
    // the leap pack costs more: a magnet price is the wrong amount for it
    pay(chain, hash(4), 600n * ONE, { kind: 'leap' });
    expect(await buyFails(shop.buy(WALLET, { kind: 'leap', txHash: hash(4) }))).toBe('wrong_amount');
    // someone else's payment cannot be claimed
    pay(chain, hash(5), 600n * ONE, { from: OTHER });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(5) }))).toBe('wrong_sender');
    pay(chain, hash(6), 600n * ONE, { contract: OTHER });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(6) }))).toBe('wrong_recipient');
    pay(chain, hash(7), 600n * ONE, { token: OTHER });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(7) }))).toBe('wrong_token');
    chain.receipts.set(hash(8), { status: 'reverted', blockNumber: 1n, transfers: [] });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(8) }))).toBe('tx_failed');
    expect(inventory.get(WALLET).magnet).toBe(3);
    // a refused payment is not burned as "used": once it is right (it never will be on chain) it could count
    expect(inventory.isUsed(hash(3))).toBe(false);
  });

  it('refuses a payment mined more than a day ago (tx_stale), credits a recent one', async () => {
    const { chain, shop, inventory, tick } = shopFixture();
    const now = tick(0);
    chain.receipts.set(hash(1), { ...payReceipt(600n * ONE), timestamp: now - SHOP_PAYMENT_MAX_AGE_MS - 1000 });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) }))).toBe('tx_stale');
    expect(inventory.isUsed(hash(1))).toBe(false);
    chain.receipts.set(hash(2), { ...payReceipt(600n * ONE), timestamp: now - 60_000 });
    expect(await shop.buy(WALLET, { kind: 'magnet', txHash: hash(2) })).toMatchObject({ ok: true, added: 3 });
  });

  it('two requests for the same hash at once credit it once', async () => {
    const { chain, shop, inventory } = shopFixture();
    pay(chain, hash(1), 600n * ONE);
    const [a, b] = await Promise.allSettled([shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) }), shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) })]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(inventory.get(WALLET).magnet).toBe(3);
  });

  it('bad requests, a closed shop, a disabled kind and a busy chain', async () => {
    const { chain, shop, settings } = shopFixture();
    expect(await buyFails(shop.buy(WALLET, { kind: 'laser', txHash: hash(1) }))).toBe('bad_request');
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: '0x12' }))).toBe('bad_request');
    chain.busy = true;
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) }))).toBe('chain_busy');
    chain.busy = false;
    settings.update({ kinds: { invis: false } });
    expect(await buyFails(shop.buy(WALLET, { kind: 'invis', txHash: hash(1) }))).toBe('kind_disabled');
    // the retired Shockwave is no setting any more
    expect(() => settings.update({ kinds: { shock: false } })).toThrow(ShopSettingsError);
    settings.update({ enabled: false });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) }))).toBe('shop_closed');
  });

  it('holders pay 20 % less (the server quotes it); a non-holder cannot pay the holder price; the admin sets the share', async () => {
    const { chain, shop, holders, settings } = shopFixture({ holder: true });
    const view = await shop.view(WALLET);
    expect(view.holder).toBe(true);
    expect(view.holderDiscountPct).toBe(20);
    expect(view.packs.map((p) => [p.kind, p.priceRaw, p.fullPriceRaw])).toEqual([
      ['magnet', (480n * ONE).toString(), (600n * ONE).toString()],
      ['leap', (720n * ONE).toString(), (900n * ONE).toString()],
      ['speed', (480n * ONE).toString(), (600n * ONE).toString()],
      ['invis', (960n * ONE).toString(), (1200n * ONE).toString()],
    ]);
    expect(view.arenaUsesPerRound).toBe(3);
    // a guest (no wallet) sees the full price
    expect((await shop.view(null)).packs.find((p) => p.kind === 'magnet')).toMatchObject({ priceRaw: (600n * ONE).toString() });
    pay(chain, hash(1), 480n * ONE);
    expect((await shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) })).charges.magnet).toBe(3);
    // a holder who pays the full price is still served
    pay(chain, hash(2), 600n * ONE);
    expect((await shop.buy(WALLET, { kind: 'magnet', txHash: hash(2) })).charges.magnet).toBe(6);
    // any other amount is refused (the old 30 % price, or less)
    pay(chain, hash(4), 420n * ONE);
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(4) }))).toBe('wrong_amount');
    // the admin changes the discount: the quote and the check follow at once
    settings.update({ holderDiscountPct: 25 });
    expect((await shop.view(WALLET)).packs.find((p) => p.kind === 'leap')).toMatchObject({ priceRaw: (675n * ONE).toString() });
    pay(chain, hash(5), 675n * ONE, { kind: 'leap' });
    expect((await shop.buy(WALLET, { kind: 'leap', txHash: hash(5) })).charges.leap).toBe(3);
    settings.update({ holderDiscountPct: 20 });
    holders.clear();
    pay(chain, hash(3), 480n * ONE);
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(3) }))).toBe('wrong_amount');
    // a non-holder's quote is the full price
    expect((await shop.view(WALLET)).packs.find((p) => p.kind === 'magnet')).toMatchObject({ priceRaw: (600n * ONE).toString() });
  });

  it('priced in dollars: converted at the arenas\' token price with their rounding; both amounts shown; holders 20 % less', async () => {
    const { chain, shop, holders, usd, tick } = shopFixture({ holder: true, usd: { usdPerToken: '0.00081' } });
    const view = await shop.view(WALLET);
    expect(view.usdPerToken).toBe('0.00081');
    // $0.60 at $0.00081 = 740.7 tokens → 740 (2 figures, like a ticket: $1 → 1,200); holders 592 → 590
    expect(view.packs.map((p) => [p.kind, p.fullUsdCents, p.usdCents, p.fullPriceRaw, p.priceRaw])).toEqual([
      ['magnet', 60, 48, (740n * ONE).toString(), (590n * ONE).toString()],
      ['leap', 90, 72, (1100n * ONE).toString(), (880n * ONE).toString()],
      ['speed', 60, 48, (740n * ONE).toString(), (590n * ONE).toString()],
      ['invis', 120, 96, (1500n * ONE).toString(), (1200n * ONE).toString()],
    ]);
    pay(chain, hash(1), 590n * ONE);
    expect((await shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) })).charges.magnet).toBe(3);
    // the token price moves (the owner re-syncs): the new price applies, the one just shown is still credited for a while
    usd.v = { usdPerToken: '0.0012' };
    expect((await shop.view(null)).packs[0]).toMatchObject({ fullPriceRaw: (500n * ONE).toString(), fullUsdCents: 60 });
    holders.clear();
    pay(chain, hash(2), 740n * ONE);
    expect((await shop.buy(WALLET, { kind: 'magnet', txHash: hash(2) })).charges.magnet).toBe(6);
    // a non-holder cannot pay a holder price, old or new
    pay(chain, hash(3), 590n * ONE);
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(3) }))).toBe('wrong_amount');
    tick(16 * 60_000);
    pay(chain, hash(4), 740n * ONE);
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(4) }))).toBe('wrong_amount');
    // no token price set yet: the token prices apply
    usd.v = null;
    expect((await shop.view(null)).packs[0]).toMatchObject({ fullPriceRaw: (600n * ONE).toString() });
    expect((await shop.view(null)).packs[0].fullUsdCents).toBeUndefined();
  });

  it('payments go to the arena contract (it burns half and pays the fee wallet half); saved sink settings are ignored', async () => {
    const { chain, shop, settings } = shopFixture();
    expect(shop.payTo()).toBe(ARENA_ADDR);
    const view = await shop.view(WALLET);
    expect(view).toMatchObject({ payTo: ARENA_ADDR, burnBps: 5000 });
    pay(chain, hash(1), 600n * ONE, { contract: OTHER });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(1) }))).toBe('wrong_recipient');
    pay(chain, hash(2), 600n * ONE);
    expect((await shop.buy(WALLET, { kind: 'magnet', txHash: hash(2) })).ok).toBe(true);
    // a pack paid as another kind is refused
    pay(chain, hash(3), 600n * ONE, { kind: 'speed' });
    expect(await buyFails(shop.buy(WALLET, { kind: 'magnet', txHash: hash(3) }))).toBe('wrong_pack');
    // the retired sink fields are refused from an admin and dropped from saved files
    expect(() => settings.update({ sink: 'treasury' })).toThrow(ShopSettingsError);
    expect('sink' in applyShopSettings(SHOP_DEFAULTS, { sink: 'burn', treasury: OTHER }, { strict: false })).toBe(false);
  });

  it('charges and used hashes survive a restart (per-chain file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boosts-'));
    dirs.push(dir);
    const a = shopFixture({ dir });
    pay(a.chain, hash(9), 900n * ONE, { kind: 'leap' });
    await a.shop.buy(WALLET, { kind: 'leap', txHash: hash(9) });
    const b = shopFixture({ dir });
    expect(b.inventory.get(WALLET).leap).toBe(3);
    pay(b.chain, hash(9), 900n * ONE, { kind: 'leap' });
    expect(await buyFails(b.shop.buy(WALLET, { kind: 'leap', txHash: hash(9) }))).toBe('tx_used');
  });

  it('backward compatibility: saved Shockwave charges load as Leap charges 1:1, old purchase records stay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boosts-'));
    dirs.push(dir);
    const file = join(dir, 'boosts.json');
    const old = {
      version: 1,
      wallets: [{ wallet: WALLET.toLowerCase(), charges: { magnet: 1, shock: 4, speed: 2 } }],
      purchases: [{ tx: hash(77), wallet: WALLET, kind: 'shock', charges: 3, paid: (900n * ONE).toString(), at: 1 }],
    };
    writeFileSync(file, JSON.stringify(old));
    const inv = new BoostInventory(file);
    expect(inv.get(WALLET)).toEqual({ magnet: 1, leap: 4, speed: 2, invis: 0 });
    expect(inv.isUsed(hash(77))).toBe(true);
    expect(inv.recent()[0].kind).toBe('shock');
    // the next write stores the new kinds only
    expect(inv.consume(WALLET, 'leap')).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { wallets: { charges: Record<string, number> }[] };
    expect(saved.wallets[0].charges).toEqual({ magnet: 1, leap: 3, speed: 2, invis: 0 });
  });

  it('backward compatibility: a pending claim for a Shockwave pack credits a Leap pack (same price)', async () => {
    const { chain, shop } = shopFixture();
    pay(chain, hash(5), 900n * ONE, { kind: 'leap' });
    expect(await shop.buy(WALLET, { kind: 'shock', txHash: hash(5) })).toMatchObject({ ok: true, kind: 'leap', added: 3, charges: { leap: 3 } });
  });

  it('backward compatibility: saved shop settings with the Shockwave load, its price and switch go to Leap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shop-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, 'site', 'shop.json'), JSON.stringify({ ...SHOP_DEFAULTS, prices: { magnet: '1500', shock: '2200', speed: '1500' }, kinds: { magnet: true, shock: false, speed: true } }));
    const s = new ShopSettingsStore(dir).settings;
    expect(s.prices).toEqual({ magnet: '1500', leap: '2200', speed: '1500', invis: SHOP_DEFAULTS.prices.invis });
    expect(s.kinds).toEqual({ magnet: true, leap: false, speed: true, invis: true });
    expect(existsSync(join(dir, 'site', 'shop.json'))).toBe(true);
  });

  it('the default prices: Magnet 600, Leap 900, Speed 600, Invisibility 1,200 per pack of 3 (a charge is 20-40 % of the cheapest ticket); holders pay 20% less', () => {
    expect(SHOP_DEFAULTS.packSize).toBe(3);
    expect(packPriceRaw(SHOP_DEFAULTS.prices.magnet, 18, 0)).toBe(600n * ONE);
    expect(packPriceRaw(SHOP_DEFAULTS.prices.leap, 18, 0)).toBe(900n * ONE);
    expect(packPriceRaw(SHOP_DEFAULTS.prices.speed, 18, 0)).toBe(600n * ONE);
    expect(packPriceRaw(SHOP_DEFAULTS.prices.invis, 18, 0)).toBe(1200n * ONE);
    expect(packPriceRaw(SHOP_DEFAULTS.prices.leap, 18, SHOP_DEFAULTS.holderDiscountPct)).toBe(720n * ONE);
    expect(packPriceRaw(SHOP_DEFAULTS.prices.magnet, 18, SHOP_DEFAULTS.holderDiscountPct)).toBe(480n * ONE);
    expect('sink' in SHOP_DEFAULTS).toBe(false);
  });

  it('a saved shop file still holding every pre-2026-11 default price takes the new ones; an admin price stays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-shop-prices-'));
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, 'site', 'shop.json'), JSON.stringify({ ...SHOP_DEFAULTS, prices: { ...OLD_SHOP_PRICES } }));
    expect(new ShopSettingsStore(dir).settings.prices).toEqual(SHOP_DEFAULTS.prices);
    writeFileSync(join(dir, 'site', 'shop.json'), JSON.stringify({ ...SHOP_DEFAULTS, prices: { ...OLD_SHOP_PRICES, magnet: '777' } }));
    expect(new ShopSettingsStore(dir).settings.prices.magnet).toBe('777');
  });

  it('admin settings are validated', () => {
    expect(() => applyShopSettings(SHOP_DEFAULTS, { prices: { magnet: '-1' } })).toThrow(ShopSettingsError);
    expect(() => applyShopSettings(SHOP_DEFAULTS, { prices: { magnet: '0' } })).toThrow(ShopSettingsError);
    expect(() => applyShopSettings(SHOP_DEFAULTS, { sink: 'moon' })).toThrow(ShopSettingsError);
    expect(() => applyShopSettings(SHOP_DEFAULTS, { treasury: 'nope' })).toThrow(ShopSettingsError);
    expect(() => applyShopSettings(SHOP_DEFAULTS, { arenaUsesPerRound: 99 })).toThrow(ShopSettingsError);
    expect(() => applyShopSettings(SHOP_DEFAULTS, { surprise: 1 })).toThrow(ShopSettingsError);
    expect(applyShopSettings(SHOP_DEFAULTS, { prices: { speed: '12.5' }, arenaUsesPerRound: 1, kinds: { magnet: false } })).toMatchObject({
      prices: { speed: '12.5', magnet: SHOP_DEFAULTS.prices.magnet },
      arenaUsesPerRound: 1,
      kinds: { magnet: false, leap: true, invis: true },
    });
  });
});

/* ------------------------------------------------------------------ */
/* Shop service: using (limits)                                        */
/* ------------------------------------------------------------------ */

describe('boosts: use limits', () => {
  const ctx = (over: Partial<UseContext> = {}): UseContext => ({ wallet: WALLET, isBot: false, arena: false, round: null, holder: false, ...over });
  async function stocked(holder = false) {
    const f = shopFixture({ holder, settings: { packSize: 10 } });
    for (const [i, kind, price] of [
      [1, 'magnet', 600n],
      [2, 'leap', 900n],
      [3, 'speed', 600n],
      [4, 'invis', 1200n],
    ] as const) {
      pay(f.chain, hash(i), price * ONE, { kind });
      await f.shop.buy(WALLET, { kind, txHash: hash(i) });
    }
    return f;
  }

  it('practice: a charge per use, a cooldown per power-up, no round cap', async () => {
    const { shop, tick } = await stocked();
    const ok = () => true;
    expect(shop.use(ctx(), 'magnet', ok)).toEqual({ ok: true });
    expect(shop.use(ctx(), 'magnet', ok)).toEqual({ ok: false, reason: 'cooldown' });
    // another power-up has its own cooldown
    expect(shop.use(ctx(), 'speed', ok)).toEqual({ ok: true });
    expect(shop.use(ctx(), 'leap', ok)).toEqual({ ok: true });
    tick(BOOST_RULES.magnet.cooldownMs);
    expect(shop.use(ctx(), 'magnet', ok)).toEqual({ ok: true });
    tick(BOOST_RULES.magnet.cooldownMs);
    expect(shop.use(ctx(), 'magnet', ok)).toEqual({ ok: true });
    const st = shop.state(ctx());
    expect(st.charges.magnet).toBe(7);
    expect(st.arena).toBeUndefined();
    expect(st.cooldownMs.magnet).toBe(BOOST_RULES.magnet.cooldownMs);
  });

  it('paid arenas: at most 2 uses per round, 3 for holders; a new round resets', async () => {
    const { shop, tick } = await stocked();
    const ok = () => true;
    const a = ctx({ arena: true, round: 5 });
    expect(shop.use(a, 'magnet', ok).ok).toBe(true);
    expect(shop.use(a, 'leap', ok).ok).toBe(true);
    expect(shop.use(a, 'speed', ok)).toEqual({ ok: false, reason: 'round_limit' });
    expect(shop.state(a).arena).toEqual({ left: 0, max: 2 });
    // the holder's extra use
    expect(shop.use({ ...a, holder: true }, 'speed', ok).ok).toBe(true);
    expect(shop.use({ ...a, holder: true }, 'speed', ok)).toEqual({ ok: false, reason: 'cooldown' });
    tick(60_000);
    expect(shop.use({ ...a, holder: true }, 'speed', ok)).toEqual({ ok: false, reason: 'round_limit' });
    expect(shop.use({ ...a, round: 6 }, 'speed', ok).ok).toBe(true);
  });

  it('the admin limit applies; guests, bots, empty and disabled power-ups are refused; a dead player keeps the charge', async () => {
    const { shop, settings, inventory } = await stocked();
    settings.update({ arenaUsesPerRound: 1, holderExtraArenaUses: 0 });
    expect(shop.use(ctx({ arena: true, round: 1, holder: true }), 'magnet', () => true).ok).toBe(true);
    expect(shop.use(ctx({ arena: true, round: 1, holder: true }), 'leap', () => true)).toEqual({ ok: false, reason: 'round_limit' });
    expect(shop.use(ctx({ wallet: null }), 'leap', () => true)).toEqual({ ok: false, reason: 'guest' });
    expect(shop.use(ctx({ isBot: true }), 'leap', () => true)).toEqual({ ok: false, reason: 'bot' });
    expect(shop.use(ctx({ wallet: OTHER }), 'leap', () => true)).toEqual({ ok: false, reason: 'no_charges' });
    const before = inventory.get(WALLET).leap;
    expect(shop.use(ctx(), 'leap', () => false)).toEqual({ ok: false, reason: 'dead' });
    expect(inventory.get(WALLET).leap).toBe(before);
    settings.update({ kinds: { leap: false } });
    expect(shop.use(ctx(), 'leap', () => true)).toEqual({ ok: false, reason: 'disabled' });
    expect(shop.state(ctx()).disabled).toEqual(['leap']);
  });
});

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

describe('boosts: rooms', () => {
  async function roomWith(mode: 'practice' | 'arena') {
    const f = shopFixture();
    pay(f.chain, hash(1), 900n * ONE, { kind: 'leap' });
    await f.shop.buy(WALLET, { kind: 'leap', txHash: hash(1) });
    const room = new Room(
      { id: `${mode}-1`, mode, name: 'Test', maxPlayers: 10, bots: null, ...(mode === 'arena' ? { stake: { arenaId: 1, buyIn: 1000 } } : {}) },
      { ...roomDeps(f.chain), shop: f.shop },
    );
    return { ...f, room };
  }
  const last = (msgs: ServerMessage[], t: string) => [...msgs].reverse().find((m) => m.t === t);

  it('a signed-in player gets the state on join and can leap; guests cannot', async () => {
    const { room } = await roomWith('practice');
    const conn = fakeConn(WALLET);
    room.join(conn, { name: 'me', skin: 0, flags: PlayerFlag.Verified });
    expect(last(conn.msgs, 'boosts')).toMatchObject({ state: { usable: true, signedIn: true, charges: { leap: 3 } } });
    room.boost(conn, 'leap');
    expect(last(conn.msgs, 'boost')).toEqual({ t: 'boost', kind: 'leap', ok: true, ms: 0 });
    expect(last(conn.msgs, 'boosts')).toMatchObject({ state: { charges: { leap: 2 } } });
    room.tick(TICK_MS);
    expect(conn.player!.cells[0].flags & CellFlag.Leap).toBeTruthy();
    room.boost(conn, 'leap');
    expect(last(conn.msgs, 'boost')).toMatchObject({ ok: false, reason: 'cooldown' });
    room.boost(conn, 'laser');

    const guest = fakeConn(null);
    room.join(guest, { name: 'guest', skin: 0, flags: 0 });
    expect(last(guest.msgs, 'boosts')).toMatchObject({ state: { usable: false, signedIn: false } });
    room.boost(guest, 'leap');
    expect(last(guest.msgs, 'boost')).toMatchObject({ ok: false, reason: 'guest' });
  });

  it('an invisible leader has no minimap dot', async () => {
    const f = shopFixture();
    pay(f.chain, hash(2), 1200n * ONE, { kind: 'invis' });
    await f.shop.buy(WALLET, { kind: 'invis', txHash: hash(2) });
    const room = new Room({ id: 'practice-9', mode: 'practice', name: 'Test', maxPlayers: 10, bots: null }, { ...roomDeps(f.chain), shop: f.shop });
    const conn = fakeConn(WALLET);
    room.join(conn, { name: 'me', skin: 0, flags: PlayerFlag.Verified });
    const watcher = fakeConn(null);
    const lead = () => (last(watcher.msgs, 'lb') as Extract<ServerMessage, { t: 'lb' }> | undefined)?.leaders.length ?? -1;
    room.spectate(watcher);
    (room as unknown as { lastLbAt: number }).lastLbAt = 0;
    room.tick(TICK_MS);
    expect(lead()).toBe(1);
    room.boost(conn, 'invis');
    expect(last(conn.msgs, 'boost')).toEqual({ t: 'boost', kind: 'invis', ok: true, ms: BOOST_RULES.invis.durationMs });
    watcher.msgs.length = 0;
    // the leaderboard goes out once a wall-clock second
    (room as unknown as { lastLbAt: number }).lastLbAt = 0;
    room.tick(TICK_MS);
    expect(lead()).toBe(0);
  });

  it('emotes: every id on the wire (0..16, the crown included) is accepted; others are not', async () => {
    const { room } = await roomWith('practice');
    const a = fakeConn(WALLET);
    const b = fakeConn(null);
    room.join(a, { name: 'a', skin: 0, flags: PlayerFlag.Verified });
    room.join(b, { name: 'b', skin: 0, flags: 0 });
    const emotes = () => b.msgs.filter((m) => m.t === 'emote').map((m) => (m as Extract<ServerMessage, { t: 'emote' }>).id);
    room.emote(a, 15);
    expect(emotes()).toEqual([15]);
    // the rate limit is unchanged (one per 900 ms)
    room.emote(a, 8);
    expect(emotes()).toEqual([15]);
    (a as unknown as { lastEmoteAt: number }).lastEmoteAt = 0;
    room.emote(a, 17);
    room.emote(a, -1);
    expect(emotes()).toEqual([15]);
  });

  it('arena rooms report the round allowance', async () => {
    const { room } = await roomWith('arena');
    const conn = fakeConn(WALLET);
    room.join(conn, { name: 'me', skin: 0, flags: PlayerFlag.Verified | PlayerFlag.Holder });
    expect(last(conn.msgs, 'boosts')).toMatchObject({ state: { arena: { left: 3, max: 3 } } });
    room.boost(conn, 'leap');
    expect(last(conn.msgs, 'boosts')).toMatchObject({ state: { arena: { left: 2, max: 3 } } });
    expect(MID_ROUND).toBeGreaterThan(0);
    expect(RULES.roundMs).toBeGreaterThan(0);
  });
});
