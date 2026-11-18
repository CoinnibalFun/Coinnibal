/**
 * The power-up cart (several power-ups, one `CoinnibalArena.pay`): a fixture and a randomized money conservation run,
 * shared by test/shop-cart.test.ts and the money simulation suite (test/money-conservation.test.ts).
 */
import { BOOST_KINDS, SHOP_CART_LIMITS, shopCartRef, type BoostKind } from '@elymum/shared';
import { ChainBusyError, type TokenReceipt } from '../src/chain/types';
import { mulberry32 } from '../src/game/rng';
import { BoostInventory } from '../src/shop/inventory';
import { ShopFail, ShopService } from '../src/shop/service';
import { ShopSettingsStore } from '../src/shop/settings';
import { ArenaChain } from './helpers';

export const TOKEN = '0x0000000000000000000000000000000000000707';
export const ARENA_ADDR = '0x00000000000000000000000000000000000A7e4A';
export const ONE = 10n ** 18n;
export const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

export class CartChain extends ArenaChain {
  receipts = new Map<string, TokenReceipt>();
  busy = false;
  constructor() {
    super([]);
  }
  async tokenReceipt(h: string): Promise<TokenReceipt | null> {
    if (this.busy) throw new ChainBusyError('test');
    return this.receipts.get(h) ?? null;
  }
  /** Records `CoinnibalArena.pay(value, ref)` from `from` (the token moved to the arena, the `Paid` event). */
  pay(h: string, from: string, value: bigint, ref: string): void {
    this.receipts.set(h, {
      status: 'success',
      blockNumber: 10n,
      transfers: [{ token: TOKEN, from, to: ARENA_ADDR, value }],
      payments: [{ contract: ARENA_ADDR, payer: from, ref, amount: value }],
    });
  }
}

export function cartFixture(o: { holders?: string[]; path?: string | null } = {}) {
  const chain = new CartChain();
  const settings = new ShopSettingsStore(null);
  // token prices (no USD price source): magnet 600, leap 900, speed 600, invis 1200; packs of 3; holders pay 20 % less
  settings.update({ priceIn: 'token' });
  const inventory = new BoostInventory(o.path ?? null);
  const holders = new Set((o.holders ?? []).map((w) => w.toLowerCase()));
  let now = 1_000_000;
  const shop = new ShopService({ settings, inventory, chain, holder: async (w) => holders.has(w.toLowerCase()), now: () => now, receiptRetryMs: [0] });
  return { chain, settings, inventory, shop, holders, tick: (ms: number) => (now += ms) };
}

export const PRICE: Record<BoostKind, bigint> = { magnet: 600n * ONE, leap: 900n * ONE, speed: 600n * ONE, invis: 1200n * ONE };
export const cartOf = (c: Partial<Record<BoostKind, number>>): Record<BoostKind, number> => ({ magnet: 0, leap: 0, speed: 0, invis: 0, ...c });
export const totalOf = (c: Record<BoostKind, number>, discount = 0) =>
  BOOST_KINDS.reduce((s, k) => s + ((PRICE[k] * BigInt(100 - discount)) / 100n) * BigInt(c[k]), 0n);

export interface CartConservation {
  purchases: number;
  refunds: number;
  refused: number;
  violations: string[];
}

/**
 * Many wallets buy random carts (some holders at the discount, some paying a wrong amount or replaying a hash, an
 * admin switching power-ups off and on between the quote and the payment). Afterwards every token paid is either in
 * the charges credited at the quoted price or recorded as owed back, to the unit; no hash is credited twice; refused
 * payments credit nothing.
 */
export async function runCartConservation(seed: number, purchases = 300): Promise<CartConservation> {
  const rng = mulberry32(seed);
  const wallets = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  const holders = wallets.filter((_, i) => i % 3 === 0);
  const f = cartFixture({ holders });
  const violations: string[] = [];
  let paidTotal = 0n;
  let valueCredited = 0n;
  let refundsTotal = 0n;
  let refused = 0;
  let refunds = 0;
  const chargesExpected = new Map<string, Record<BoostKind, number>>();
  await f.shop.view(null);
  for (let i = 0; i < purchases; i++) {
    const wallet = wallets[Math.floor(rng() * wallets.length)];
    const holder = holders.includes(wallet);
    const cart = cartOf({});
    let packs = 0;
    for (const k of BOOST_KINDS) {
      const n = rng() < 0.5 ? Math.floor(rng() * 4) : 0;
      cart[k] = Math.min(n, SHOP_CART_LIMITS.perKind);
      packs += cart[k];
    }
    if (packs === 0) cart.magnet = 1;
    // the shop the player saw
    await f.shop.view(wallet);
    // sometimes the admin switches a power-up off after the quote (or back on)
    if (rng() < 0.15) {
      const k = BOOST_KINDS[Math.floor(rng() * BOOST_KINDS.length)];
      f.settings.update({ kinds: { [k]: !f.settings.settings.kinds[k] } });
    }
    const fair = totalOf(cart, holder ? 20 : 0);
    const mode = rng();
    const value = mode < 0.06 ? fair - 1n : mode < 0.09 && !holder ? totalOf(cart, 20) : fair;
    const h = hash(1000 + i);
    f.chain.pay(h, wallet, value, shopCartRef(cart));
    const before = { ...f.inventory.get(wallet) };
    try {
      const r = await f.shop.buyCart(wallet, { cart, txHash: h });
      paidTotal += value;
      const refund = BigInt(r.refund?.raw ?? '0');
      refundsTotal += refund;
      if (refund > 0n) refunds++;
      // what was applied, at the price paid
      let applied = 0n;
      for (const k of BOOST_KINDS) {
        if (r.added[k] % 3 !== 0) violations.push(`#${i}: ${r.added[k]} ${k} charges is not whole packs`);
        const packsApplied = r.added[k] / 3;
        applied += ((PRICE[k] * BigInt(holder ? 80 : 100)) / 100n) * BigInt(packsApplied);
        if (packsApplied !== 0 && packsApplied !== cart[k]) violations.push(`#${i}: ${k} partly applied`);
      }
      valueCredited += applied;
      if (applied + refund !== value) violations.push(`#${i}: paid ${value} != applied ${applied} + owed back ${refund}`);
      const exp = chargesExpected.get(wallet) ?? { ...before };
      for (const k of BOOST_KINDS) exp[k] += r.added[k];
      chargesExpected.set(wallet, exp);
      // a replay of the same payment is refused and changes nothing
      try {
        await f.shop.buyCart(wallet, { cart, txHash: h });
        violations.push(`#${i}: a hash was credited twice`);
      } catch (err) {
        if (!(err instanceof ShopFail) || err.code !== 'tx_used') violations.push(`#${i}: replay refused with ${String(err)}`);
      }
    } catch (err) {
      if (!(err instanceof ShopFail)) throw err;
      refused++;
      if (value === fair) violations.push(`#${i}: a fair payment was refused (${err.code})`);
      const after = f.inventory.get(wallet);
      for (const k of BOOST_KINDS) if (after[k] !== before[k]) violations.push(`#${i}: a refused payment changed the charges`);
    }
  }
  for (const [w, exp] of chargesExpected) {
    const got = f.inventory.get(w);
    for (const k of BOOST_KINDS) if (got[k] !== exp[k]) violations.push(`${w}: ${k} ${got[k]} != ${exp[k]}`);
  }
  if (paidTotal !== valueCredited + refundsTotal) violations.push(`books: paid ${paidTotal} != credited ${valueCredited} + owed back ${refundsTotal}`);
  const owed = f.inventory.refundsOwed().reduce((s, p) => s + BigInt(p.refund!), 0n);
  if (owed !== refundsTotal) violations.push(`owed list ${owed} != refunds ${refundsTotal}`);
  return { purchases, refunds, refused, violations };
}
