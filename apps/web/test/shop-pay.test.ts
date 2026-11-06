import { shopPaymentRef, type ShopView } from '@elymum/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainStatus, ONE } from './evm-helpers';

const spies = vi.hoisted(() => ({ sendWalletCall: vi.fn(), getAllowance: vi.fn(), verifyArena: vi.fn() }));
// the pin and code-hash check (pinned.test.ts): this test's arena passes unless a test says otherwise
vi.mock('../src/wallet/pinned', async (orig) => ({ ...(await orig<typeof import('../src/wallet/pinned')>()), verifyArena: spies.verifyArena }));
vi.mock('../src/wallet/tx', async (orig) => ({ ...(await orig<typeof import('../src/wallet/tx')>()), sendWalletCall: spies.sendWalletCall }));
vi.mock('@elymum/sdk', async (orig) => ({ ...(await orig<typeof import('@elymum/sdk')>()), getAllowance: spies.getAllowance }));

import { ShopError, buyPack, loadPendingClaim, savePendingClaim } from '../src/wallet/shop';

const OWNER = '0x1111111111111111111111111111111111111111';
const ARENA = '0x00000000000000000000000000000000000a4e4a';
const TOKEN = '0x0000000000000000000000000000000000000707';
const HASH = `0x${'4'.repeat(64)}`;
const VIEW: ShopView = {
  open: true,
  token: { address: TOKEN, symbol: 'tELYMUM', decimals: 18 },
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

describe('buyPack: a power-up pack is paid with ElymumArena.pay', () => {
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
