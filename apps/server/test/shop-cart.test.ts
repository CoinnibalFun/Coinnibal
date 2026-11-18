import { SHOP_CART_LIMITS, normalizeCart, parseShopCartRef, shopCartRef, shopPaymentRef } from '@coinnibal/shared';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoostInventory } from '../src/shop/inventory';
import { ShopFail } from '../src/shop/service';
import { ONE, cartFixture, cartOf, hash, runCartConservation, totalOf } from './shop-cart';

const WALLET = '0x1111111111111111111111111111111111111111';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof ShopFail) return err.code;
    throw err;
  }
}

describe('the power-up cart: the ref and the limits', () => {
  it('names the whole cart in the payment ref, and reads it back', () => {
    const cart = cartOf({ magnet: 2, invis: 1 });
    const ref = shopCartRef(cart);
    expect(ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parseShopCartRef(ref)).toEqual(cart);
    expect(parseShopCartRef(shopPaymentRef('magnet'))).toBeNull();
    expect(shopCartRef(cartOf({ magnet: 1 }))).not.toBe(shopCartRef(cartOf({ leap: 1 })));
  });

  it('refuses empty carts, fractions, unknown power-ups and carts over the limits', () => {
    expect(normalizeCart({ magnet: 1 })).toEqual(cartOf({ magnet: 1 }));
    expect(normalizeCart({})).toBeNull();
    expect(normalizeCart({ magnet: 1.5 })).toBeNull();
    expect(normalizeCart({ magnet: -1 })).toBeNull();
    expect(normalizeCart({ shock: 1 })).toBeNull();
    expect(normalizeCart({ magnet: SHOP_CART_LIMITS.perKind + 1 })).toBeNull();
    expect(normalizeCart({ magnet: 10, leap: 10, speed: 1 })).toBeNull();
    expect(normalizeCart([1, 2])).toBeNull();
  });
});

describe('the power-up cart: one payment, applied at once', () => {
  it('credits every power-up of the cart for one exact payment; a replay is refused', async () => {
    const { chain, shop, inventory } = cartFixture();
    await shop.view(WALLET);
    const cart = cartOf({ magnet: 2, invis: 1 });
    expect(totalOf(cart)).toBe(2400n * ONE);
    chain.pay(hash(1), WALLET, 2400n * ONE, shopCartRef(cart));
    const r = await shop.buyCart(WALLET, { cart, txHash: hash(1) });
    expect(r).toMatchObject({ ok: true, added: { magnet: 6, leap: 0, speed: 0, invis: 3 }, charges: { magnet: 6, invis: 3 } });
    expect(r.refund).toBeUndefined();
    expect(await code(shop.buyCart(WALLET, { cart, txHash: hash(1) }))).toBe('tx_used');
    expect(inventory.recent(1)[0]).toMatchObject({ kind: 'cart', charges: 9, paid: (2400n * ONE).toString(), cart: { magnet: 6, invis: 3 } });
  });

  it('refuses a payment of another amount, of another cart, or of a single pack; nothing is credited', async () => {
    const { chain, shop, inventory } = cartFixture();
    const cart = cartOf({ magnet: 1, leap: 1 });
    chain.pay(hash(2), WALLET, 1499n * ONE, shopCartRef(cart));
    expect(await code(shop.buyCart(WALLET, { cart, txHash: hash(2) }))).toBe('wrong_amount');
    chain.pay(hash(3), WALLET, 1500n * ONE, shopCartRef(cartOf({ magnet: 2 })));
    expect(await code(shop.buyCart(WALLET, { cart, txHash: hash(3) }))).toBe('wrong_pack');
    chain.pay(hash(4), WALLET, 600n * ONE, shopPaymentRef('magnet'));
    expect(await code(shop.buyCart(WALLET, { cart: cartOf({ magnet: 1 }), txHash: hash(4) }))).toBe('wrong_pack');
    expect(await code(shop.buyCart(WALLET, { cart: {}, txHash: hash(5) }))).toBe('bad_request');
    expect(inventory.get(WALLET)).toEqual({ magnet: 0, leap: 0, speed: 0, invis: 0 });
  });

  it('the holder discount applies to the whole cart, for holders only', async () => {
    const holder = cartFixture({ holders: [WALLET] });
    const cart = cartOf({ speed: 2, leap: 1 });
    holder.chain.pay(hash(6), WALLET, totalOf(cart, 20), shopCartRef(cart));
    expect((await holder.shop.buyCart(WALLET, { cart, txHash: hash(6) })).added).toMatchObject({ speed: 6, leap: 3 });
    const other = cartFixture();
    other.chain.pay(hash(7), WALLET, totalOf(cart, 20), shopCartRef(cart));
    expect(await code(other.shop.buyCart(WALLET, { cart, txHash: hash(7) }))).toBe('wrong_amount');
  });

  it('a power-up switched off after the quote is not applied: its exact share is owed back; the rest applies', async () => {
    const { chain, shop, settings, inventory } = cartFixture();
    await shop.view(WALLET);
    settings.update({ kinds: { invis: false } });
    const cart = cartOf({ magnet: 1, invis: 2 });
    chain.pay(hash(8), WALLET, 3000n * ONE, shopCartRef(cart));
    const r = await shop.buyCart(WALLET, { cart, txHash: hash(8) });
    expect(r.added).toEqual({ magnet: 3, leap: 0, speed: 0, invis: 0 });
    expect(r.refund).toEqual({ kinds: ['invis'], raw: (2400n * ONE).toString() });
    expect(inventory.refundsOwed()).toHaveLength(1);
    expect(inventory.markRefunded(hash(8))).toBe(true);
    expect(inventory.refundsOwed()).toHaveLength(0);
    // the shop closed by the admin after the payment: all of it owed back, nothing kept
    settings.update({ enabled: false });
    const all = cartOf({ leap: 1 });
    chain.pay(hash(9), WALLET, 900n * ONE, shopCartRef(all));
    const r2 = await shop.buyCart(WALLET, { cart: all, txHash: hash(9) });
    expect(r2.added.leap).toBe(0);
    expect(r2.refund?.raw).toBe((900n * ONE).toString());
  });

  it('is atomic: a failed write credits nothing and marks nothing used, so the retry credits it once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-cart-'));
    try {
      const path = join(dir, 'boosts.json');
      const { chain, shop, inventory } = cartFixture({ path });
      const cart = cartOf({ magnet: 1, speed: 1 });
      chain.pay(hash(10), WALLET, 1200n * ONE, shopCartRef(cart));
      const save = (inventory as unknown as { save: () => void }).save.bind(inventory);
      (inventory as unknown as { save: () => void }).save = () => {
        throw new Error('disk full');
      };
      await expect(shop.buyCart(WALLET, { cart, txHash: hash(10) })).rejects.toThrow('disk full');
      expect(inventory.get(WALLET)).toEqual({ magnet: 0, leap: 0, speed: 0, invis: 0 });
      expect(inventory.isUsed(hash(10))).toBe(false);
      (inventory as unknown as { save: () => void }).save = save;
      expect((await shop.buyCart(WALLET, { cart, txHash: hash(10) })).charges).toMatchObject({ magnet: 3, speed: 3 });
      // on disk, and read back by a restart
      expect(JSON.parse(readFileSync(path, 'utf8')).purchases).toHaveLength(1);
      expect(new BoostInventory(path).get(WALLET)).toMatchObject({ magnet: 3, speed: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the power-up cart: money conservation', () => {
  for (const seed of [11, 12]) {
    it(`seed ${seed}: every token paid is credited at its price or owed back, to the unit; no hash twice`, async () => {
      const r = await runCartConservation(seed, 200);
      expect(r.violations).toEqual([]);
      expect(r.refunds).toBeGreaterThan(0);
      expect(r.refused).toBeGreaterThan(0);
    });
  }
});
