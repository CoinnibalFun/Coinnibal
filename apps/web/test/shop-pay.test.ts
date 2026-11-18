import { parseShopCartRef, shopCartRef, shopPaymentRef, type ShopView } from '@coinnibal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainStatus, ONE } from './evm-helpers';

const spies = vi.hoisted(() => ({ sendWalletCall: vi.fn(), getAllowance: vi.fn(), verifyArena: vi.fn() }));
// the pin and code-hash check (pinned.test.ts): this test's arena passes unless a test says otherwise
vi.mock('../src/wallet/pinned', async (orig) => ({ ...(await orig<typeof import('../src/wallet/pinned')>()), verifyArena: spies.verifyArena }));
vi.mock('../src/wallet/tx', async (orig) => ({ ...(await orig<typeof import('../src/wallet/tx')>()), sendWalletCall: spies.sendWalletCall }));
vi.mock('@coinnibal/sdk', async (orig) => ({ ...(await orig<typeof import('@coinnibal/sdk')>()), getAllowance: spies.getAllowance }));

import { ShopError, buyCart, buyPack, cartTotals, loadPendingClaim, savePendingClaim } from '../src/wallet/shop';

const OWNER = '0x1111111111111111111111111111111111111111';
const ARENA = '0x00000000000000000000000000000000000a4e4a';
const TOKEN = '0x0000000000000000000000000000000000000707';
const HASH = `0x${'4'.repeat(64)}`;
const VIEW: ShopView = {
  open: true,
  token: { address: TOKEN, symbol: 'TEST', decimals: 18 },
  payTo: ARENA,
  burnBps: 5000,
  packs: [{ kind: 'leap', charges: 3, priceRaw: (900n * ONE).toString(), fullPriceRaw: (900n * ONE).toString(), enabled: true }],
  holder: false,
  holderDiscountPct: 30,
  arenaUsesPerRound: 3,
  holderExtraArenaUses: 1,
};
const credited = { ok: true, kind: 'leap', added: 3, charges: { magnet: 0, leap: 3, speed: 0, invis: 0 } };

beforeEach(() => {
  spies.verifyArena.mockReset();
  spies.verifyArena.mockImplementation(async (_c: unknown, _id: unknown, a: { arena: string }) => ({ ok: true, arena: a.arena }));
  spies.sendWalletCall.mockReset();
  spies.sendWalletCall.mockImplementation(async () => ({ ok: true, hash: HASH, receipt: { status: 'success', logs: [] } }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(credited), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  savePendingClaim(null);
});

describe('buyPack: a power-up pack is paid with CoinnibalArena.pay', () => {
  it('approves the arena for exactly the price when the allowance is short, then pays with the pack ref', async () => {
    spies.getAllowance.mockResolvedValue(0n);
    const r = await buyPack(VIEW, VIEW.packs[0], { token: 'tok', owner: OWNER, chain: chainStatus() });
    expect(r.charges.leap).toBe(3);
    const calls = spies.sendWalletCall.mock.calls.map(([c]) => c as { address: string; functionName: string; args: readonly unknown[] });
    expect(calls.map((c) => [c.address.toLowerCase(), c.functionName])).toEqual([
      [TOKEN, 'approve'],
      [ARENA, 'pay'],
    ]);
    expect(calls[0].args).toEqual([expect.stringMatching(new RegExp(ARENA.slice(2), 'i')), 900n * ONE]);
    expect(calls[1].args).toEqual([900n * ONE, shopPaymentRef('leap')]);
    // the server is asked to credit the pay transaction
    const body = JSON.parse(((fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body as string) ?? '{}');
    expect(body).toEqual({ kind: 'leap', txHash: HASH });
  });

  it('a ticket\'s standing approval covers it: one pay call only', async () => {
    spies.getAllowance.mockResolvedValue(10n ** 30n);
    await buyPack(VIEW, VIEW.packs[0], { token: 'tok', owner: OWNER, chain: chainStatus() });
    expect(spies.sendWalletCall.mock.calls.map(([c]) => (c as { functionName: string }).functionName)).toEqual(['pay']);
  });

  it('a declined approval pays nothing and keeps no claim; a closed shop or no arena refuses at once', async () => {
    spies.getAllowance.mockResolvedValue(0n);
    spies.sendWalletCall.mockImplementationOnce(async () => ({ ok: false, hash: null, error: { kind: 'rejected', name: 'UserRejected', args: [], code: 4001, message: 'no' } }));
    await expect(buyPack(VIEW, VIEW.packs[0], { token: 'tok', owner: OWNER, chain: chainStatus() })).rejects.toMatchObject({ code: 'rejected' });
    expect(spies.sendWalletCall).toHaveBeenCalledTimes(1);
    expect(loadPendingClaim(OWNER)).toBeNull();
    await expect(buyPack({ ...VIEW, payTo: null }, VIEW.packs[0], { token: 'tok', owner: OWNER, chain: chainStatus() })).rejects.toBeInstanceOf(ShopError);
    await expect(buyPack({ ...VIEW, open: false }, VIEW.packs[0], { token: 'tok', owner: OWNER, chain: chainStatus() })).rejects.toMatchObject({ code: 'shop_closed' });
  });

  it('pays the pinned arena only: an arena the build does not trust gets no approval and no payment', async () => {
    spies.getAllowance.mockResolvedValue(0n);
    spies.verifyArena.mockImplementation(async () => ({ ok: false, reason: 'arena_mismatch' }));
    await expect(buyPack(VIEW, VIEW.packs[0], { token: 'tok', owner: OWNER, chain: chainStatus() })).rejects.toMatchObject({ code: 'tx', message: expect.stringMatching(/does not recognise the arena contract/) });
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
    expect(spies.verifyArena).toHaveBeenCalledWith(expect.anything(), chainStatus().chainId, { arena: ARENA, token: TOKEN });
  });
});

describe('buyCart: several power-ups, one CoinnibalArena.pay', () => {
  const CART_VIEW: ShopView = {
    ...VIEW,
    holder: true,
    packs: [
      { kind: 'magnet', charges: 3, priceRaw: (420n * ONE).toString(), fullPriceRaw: (600n * ONE).toString(), usdCents: 42, fullUsdCents: 60, enabled: true },
      { kind: 'leap', charges: 3, priceRaw: (630n * ONE).toString(), fullPriceRaw: (900n * ONE).toString(), usdCents: 63, fullUsdCents: 90, enabled: true },
      { kind: 'speed', charges: 3, priceRaw: (420n * ONE).toString(), fullPriceRaw: (600n * ONE).toString(), usdCents: 42, fullUsdCents: 60, enabled: true },
      { kind: 'invis', charges: 3, priceRaw: (840n * ONE).toString(), fullPriceRaw: (1200n * ONE).toString(), usdCents: 84, fullUsdCents: 120, enabled: true },
    ],
  };
  const cart = { magnet: 2, leap: 0, speed: 1, invis: 1 };

  it('totals the cart at the wallet\'s prices (holder discount), in tokens and US cents', () => {
    expect(cartTotals(CART_VIEW, cart)).toEqual({ raw: 2100n * ONE, fullRaw: 3000n * ONE, packs: 4, usdCents: 210, fullUsdCents: 300 });
    expect(cartTotals(CART_VIEW, { magnet: 0, leap: 0, speed: 0, invis: 0 })).toMatchObject({ raw: 0n, packs: 0, usdCents: null });
  });

  it('approves exactly the total when short, pays it once with the cart ref, and claims the whole cart', async () => {
    spies.getAllowance.mockResolvedValue(0n);
    const applied = { ok: true, cart, added: { magnet: 6, leap: 0, speed: 3, invis: 3 }, charges: { magnet: 6, leap: 0, speed: 3, invis: 3 } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(applied), { status: 200 })));
    const r = await buyCart(CART_VIEW, cart, { token: 'tok', owner: OWNER, chain: chainStatus() });
    expect(r.added).toEqual({ magnet: 6, leap: 0, speed: 3, invis: 3 });
    const calls = spies.sendWalletCall.mock.calls.map(([c]) => c as { functionName: string; args: readonly unknown[] });
    expect(calls.map((c) => c.functionName)).toEqual(['approve', 'pay']);
    expect(calls[0].args[1]).toBe(2100n * ONE);
    expect(calls[1].args).toEqual([2100n * ONE, shopCartRef(cart)]);
    expect(parseShopCartRef(calls[1].args[1] as string)).toEqual(cart);
    const body = JSON.parse(((fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body as string) ?? '{}');
    expect(body).toEqual({ cart, txHash: HASH });
    expect(loadPendingClaim(OWNER)).toBeNull();
  });

  it('keeps a paid cart whose claim did not get through, to claim it again without paying twice', async () => {
    spies.getAllowance.mockResolvedValue(10n ** 30n);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(buyCart(CART_VIEW, cart, { token: 'tok', owner: OWNER, chain: chainStatus(), retryMs: [0] })).rejects.toBeInstanceOf(ShopError);
    expect(loadPendingClaim(OWNER)).toMatchObject({ txHash: HASH, cart });
    expect(spies.sendWalletCall).toHaveBeenCalledTimes(1);
  });
});
