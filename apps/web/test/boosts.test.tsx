import { BOOST_RULES, CellFlag, EntityKind, SHOP_DEFAULTS, type BoostState, type ShopView, type SnapshotData } from '@elymum/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shopPatch } from '../src/admin/ShopCard';
import { Kb } from '../src/design';
import { setEngine } from '../src/game/instance';
import type { GameEngine } from '../src/game/engine';
import { Input, boostForCode, type InputActions } from '../src/game/input';
import { ClientWorld } from '../src/game/state';
import { useUi } from '../src/store';
import { BoostBar, cooldownFrac, shownKinds } from '../src/ui/game/BoostBar';
import { ShopSheet, priceText } from '../src/ui/shop/ShopSheet';
import { ShopError, claimPack, loadPendingClaim, savePendingClaim, settleClaim, totalCharges } from '../src/wallet/shop';
import { chainStatus } from './evm-helpers';

const initial = useUi.getState();
const ONE = 10n ** 18n;
const state = (over: Partial<BoostState> = {}): BoostState => ({
  usable: true,
  signedIn: true,
  charges: { magnet: 2, leap: 0, speed: 1, invis: 0 },
  cooldownMs: { magnet: 0, leap: 0, speed: 0, invis: 0 },
  ...over,
});

afterEach(() => {
  act(() => useUi.setState(initial, true));
  setEngine(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('boost keys', () => {
  it('R, F, G and V fire the four power-ups and nothing else does', () => {
    expect(boostForCode('KeyR')).toBe('magnet');
    expect(boostForCode('KeyF')).toBe('leap');
    expect(boostForCode('KeyG')).toBe('speed');
    expect(boostForCode('KeyV')).toBe('invis');
    for (const c of ['KeyE', 'Space', 'KeyQ', 'Digit1', 'KeyW', 'Enter']) expect(boostForCode(c)).toBeNull();
  });

  it('the input routes the keys (no repeats, not while typing)', () => {
    const actions: InputActions = { split: vi.fn(), eject: vi.fn(), emote: vi.fn(), openChat: vi.fn(), escape: vi.fn(), spectateNext: vi.fn(), steering: () => true, boost: vi.fn() };
    const input = new Input(document.createElement('div'), actions, () => {}, () => {});
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', repeat: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', key: '3' }));
    expect(actions.boost).toHaveBeenCalledTimes(2);
    expect(actions.boost).toHaveBeenNthCalledWith(1, 'leap');
    expect(actions.boost).toHaveBeenNthCalledWith(2, 'magnet');
    expect(actions.emote).toHaveBeenCalledWith(2);
    const field = document.createElement('input');
    document.body.append(field);
    field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true }));
    expect(actions.boost).toHaveBeenCalledTimes(2);
    field.remove();
    input.destroy();
  });

  it('a left mouse click on the floor splits; clicks on HUD controls, right clicks and touch taps do not', () => {
    const canvas = document.createElement('canvas');
    const hud = document.createElement('button');
    document.body.append(canvas, hud);
    let steering = true;
    const actions: InputActions = { split: vi.fn(), eject: vi.fn(), emote: vi.fn(), openChat: vi.fn(), escape: vi.fn(), spectateNext: vi.fn(), steering: () => steering };
    const input = new Input(canvas, actions, () => {}, () => {});
    const down = (el: Element, init: { button?: number; pointerType?: string }) => {
      const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: init.button ?? 0 });
      Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' });
      el.dispatchEvent(e);
      return e;
    };
    expect(down(canvas, {}).defaultPrevented).toBe(true);
    expect(actions.split).toHaveBeenCalledTimes(1);
    down(canvas, { button: 2 });
    down(canvas, { pointerType: 'touch' });
    down(hud, {});
    expect(actions.split).toHaveBeenCalledTimes(1);
    // the right click opens no browser menu over the game
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    // outside a game nothing happens
    steering = false;
    down(canvas, {});
    expect(actions.split).toHaveBeenCalledTimes(1);
    input.destroy();
    canvas.remove();
    hud.remove();
  });

  it('keys 1-8 pass the slot on; 9 does nothing', () => {
    const actions: InputActions = { split: vi.fn(), eject: vi.fn(), emote: vi.fn(), openChat: vi.fn(), escape: vi.fn(), spectateNext: vi.fn(), steering: () => true };
    const input = new Input(document.createElement('div'), actions, () => {}, () => {});
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit8', key: '8' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit9', key: '9' }));
    expect(actions.emote).toHaveBeenCalledWith(7);
    expect(actions.emote).toHaveBeenCalledTimes(1);
    input.destroy();
  });
});

describe('boost HUD helpers', () => {
  it('cooldown ring fraction and the kinds shown', () => {
    expect(cooldownFrac(0, 1000, 'magnet')).toBe(0);
    expect(cooldownFrac(1000 + BOOST_RULES.magnet.cooldownMs / 2, 1000, 'magnet')).toBeCloseTo(0.5);
    expect(cooldownFrac(1e12, 0, 'leap')).toBe(1);
    // only owned power-ups show (a recharging one with no charge left is gone: nothing is sold in a game)
    expect(shownKinds({ magnet: 1, leap: 0, speed: 0, invis: 0 })).toEqual(['magnet']);
    expect(shownKinds({ magnet: 1, leap: 0, speed: 3, invis: 2 }, ['speed'])).toEqual(['magnet', 'invis']);
    expect(shownKinds({ magnet: 0, leap: 0, speed: 0, invis: 0 })).toEqual([]);
    expect(totalCharges({ magnet: 1, leap: 2, speed: 3, invis: 4 })).toBe(10);
    expect(totalCharges(null)).toBe(0);
  });
});

describe('BoostBar', () => {
  beforeEach(() => {
    useUi.setState({ chain: chainStatus(), screen: 'playing' });
  });

  it('shows a button per owned power-up with its key and count; a press asks the engine', () => {
    const boost = vi.fn();
    setEngine({ boost } as unknown as GameEngine);
    act(() => useUi.setState({ boosts: state(), boostReady: { magnet: 0, leap: 0, speed: 0, invis: 0 } }));
    render(
      <Kb>
        <BoostBar />
      </Kb>,
    );
    const magnet = screen.getByRole('button', { name: /Magnet \(R\) · 2 left/ });
    expect(screen.getByRole('button', { name: /Speed burst \(G\) · 1 left/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Leap|Invisibility/ })).toBeNull();
    fireEvent.pointerDown(magnet);
    expect(boost).toHaveBeenCalledWith('magnet');
    // nothing is sold during a game: no shop entry on the HUD
    expect(screen.queryByRole('button', { name: /Open the power-up shop/ })).toBeNull();
    expect(screen.queryByText('+')).toBeNull();
  });

  it('no charges: no power-up buttons at all', () => {
    act(() => useUi.setState({ boosts: state({ charges: { magnet: 0, leap: 0, speed: 0, invis: 0 } }), boostReady: { magnet: Date.now() + 5000, leap: 0, speed: 0, invis: 0 } }));
    const { container } = render(<BoostBar />);
    expect(container.innerHTML).toBe('');
  });

  it('a power-up key with no charge left shows the lobby hint instead of the shop', async () => {
    const { GameEngine } = await import('../src/game/engine');
    const send = vi.fn();
    const fake = Object.create(GameEngine.prototype) as GameEngine;
    Object.assign(fake, { net: { send }, lastBuyHintAt: 0 });
    act(() => useUi.setState({ screen: 'playing', chatOpen: false, boosts: state({ charges: { magnet: 0, leap: 0, speed: 0, invis: 0 } }), toasts: [] }));
    act(() => fake.boost('magnet'));
    expect(useUi.getState().modal).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(useUi.getState().toasts.map((x) => x.text)).toContain('Buy power-ups in the lobby');
    // a held key does not stack slips
    act(() => fake.boost('invis'));
    expect(useUi.getState().toasts).toHaveLength(1);
  });

  it('arena rooms print the round allowance; guests see nothing', () => {
    act(() => useUi.setState({ boosts: state({ arena: { left: 1, max: 2 } }) }));
    const { unmount } = render(<BoostBar />);
    expect(screen.getByText('1/2 this round')).toBeTruthy();
    unmount();
    act(() => useUi.setState({ boosts: state({ signedIn: false, usable: false }) }));
    const { container } = render(<BoostBar />);
    expect(container.innerHTML).toBe('');
  });

  it('a recharging power-up is marked', () => {
    act(() => useUi.setState({ boosts: state(), boostReady: { magnet: Date.now() + 10_000, leap: 0, speed: 0, invis: 0 } }));
    render(<BoostBar />);
    expect(screen.getByRole('button', { name: /Magnet/ }).className).toContain('is-cooling');
  });
});

const VIEW: ShopView = {
  open: true,
  token: { address: '0x0000000000000000000000000000000000000707', symbol: 'tELYMUM', decimals: 18 },
  payTo: '0x00000000000000000000000000000000000a4e4a',
  burnBps: 5000,
  packs: [
    { kind: 'magnet', charges: 3, priceRaw: (1050n * ONE).toString(), fullPriceRaw: (1500n * ONE).toString(), enabled: true },
    { kind: 'leap', charges: 3, priceRaw: (1750n * ONE).toString(), fullPriceRaw: (2500n * ONE).toString(), enabled: true },
    { kind: 'speed', charges: 3, priceRaw: (1050n * ONE).toString(), fullPriceRaw: (1500n * ONE).toString(), enabled: false },
    { kind: 'invis', charges: 3, priceRaw: (2100n * ONE).toString(), fullPriceRaw: (3000n * ONE).toString(), enabled: true },
  ],
  holder: true,
  holderDiscountPct: 30,
  arenaUsesPerRound: 3,
  holderExtraArenaUses: 1,
  charges: { magnet: 4, leap: 0, speed: 0, invis: 0 },
};

describe('ShopSheet', () => {
  it('lists the packs with holder prices, owned charges and where a payment goes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(VIEW), { status: 200 })));
    act(() => useUi.setState({ chain: chainStatus(), modal: 'shop', auth: { address: '0x1111111111111111111111111111111111111111', token: 'tok', profile: null } }));
    render(
      <Kb>
        <ShopSheet />
      </Kb>,
    );
    await waitFor(() => expect(screen.getByTestId('shop-buy-magnet')).toBeTruthy());
    expect(screen.getByTestId('shop-buy-magnet').textContent).toContain('Buy 3 for 1,050 tELYMUM');
    expect(screen.getAllByText('1,500 tELYMUM')).toHaveLength(2);
    expect(screen.getByText(/You have 4/)).toBeTruthy();
    expect(screen.getByText(/30% off and \+1 arena use per round/)).toBeTruthy();
    expect(screen.getByText(/Each pack is paid to the arena contract \(0x0000…4e4a\): 50% is burned, 50% goes to the fee wallet\./)).toBeTruthy();
    expect((screen.getByTestId('shop-buy-speed') as HTMLButtonElement).disabled).toBe(true);
    // the two new power-ups are on sale, the Shockwave is gone
    expect(screen.getByTestId('shop-buy-leap').textContent).toContain('Buy 3 for 1,750 tELYMUM');
    expect(screen.getByTestId('shop-buy-invis').textContent).toContain('Buy 3 for 2,100 tELYMUM');
    expect(screen.getByText('Leap')).toBeTruthy();
    expect(screen.getByText('Invisibility')).toBeTruthy();
    expect(screen.queryByText(/Shockwave/)).toBeNull();
  });

  it('asks guests to sign in and disables buying', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...VIEW, holder: false, charges: undefined }), { status: 200 })));
    act(() => useUi.setState({ chain: chainStatus(), modal: 'shop', auth: null }));
    render(
      <Kb>
        <ShopSheet />
      </Kb>,
    );
    await waitFor(() => expect(screen.getByTestId('shop-buy-magnet')).toBeTruthy());
    expect((screen.getByTestId('shop-buy-magnet') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Sign in with wallet/ }));
    expect(useUi.getState().modal).toBe('wallet');
  });

  it('price text', () => {
    expect(priceText((12_500_000n * 10n ** 12n).toString(), VIEW)).toBe('12.5 tELYMUM');
  });
});

describe('claimPack', () => {
  it('retries while the receipt is not visible, then returns the charges', async () => {
    const replies = [
      new Response(JSON.stringify({ error: 'tx_pending', message: 'not yet' }), { status: 409 }),
      new Response(JSON.stringify({ ok: true, kind: 'leap', added: 3, charges: { magnet: 0, leap: 3, speed: 0, invis: 0 } }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => replies.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    const r = await claimPack('tok', 'leap', `0x${'1'.repeat(64)}`, { retryMs: [0, 1, 1] });
    expect(r.charges.leap).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ kind: 'leap', txHash: `0x${'1'.repeat(64)}` });
  });

  it('stops at a final refusal and keeps the hash for the player', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'wrong_amount', message: 'That payment does not match the pack price.' }), { status: 400 })));
    const err = await claimPack('tok', 'magnet', `0x${'2'.repeat(64)}`, { retryMs: [0, 1] }).catch((e) => e);
    expect(err).toBeInstanceOf(ShopError);
    expect(err).toMatchObject({ code: 'wrong_amount', txHash: `0x${'2'.repeat(64)}` });
  });
});

describe('a paid pack whose claim did not get through', () => {
  const OWNER = '0x1111111111111111111111111111111111111111';
  const HASH = `0x${'3'.repeat(64)}`;
  afterEach(() => savePendingClaim(null));

  it('keeps the payment while the claim cannot reach the server, and drops it once credited or finally refused', async () => {
    savePendingClaim({ owner: OWNER, kind: 'magnet', txHash: HASH, at: Date.now() });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(settleClaim('tok', OWNER, 'magnet', HASH, { retryMs: [0] })).rejects.toBeInstanceOf(ShopError);
    expect(loadPendingClaim(OWNER)?.txHash).toBe(HASH);
    // another wallet does not see it
    expect(loadPendingClaim('0x2222222222222222222222222222222222222222')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, kind: 'magnet', added: 3, charges: { magnet: 3, leap: 0, speed: 0, invis: 0 } }), { status: 200 })));
    await settleClaim('tok', OWNER, 'magnet', HASH, { retryMs: [0] });
    expect(loadPendingClaim(OWNER)).toBeNull();
    savePendingClaim({ owner: OWNER, kind: 'magnet', txHash: HASH, at: Date.now() });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'tx_used', message: 'used' }), { status: 409 })));
    await expect(settleClaim('tok', OWNER, 'magnet', HASH, { retryMs: [0] })).rejects.toMatchObject({ code: 'tx_used' });
    expect(loadPendingClaim(OWNER)).toBeNull();
  });

  it('the shop offers to claim it again (no second payment)', async () => {
    savePendingClaim({ owner: OWNER, kind: 'speed', txHash: HASH, at: Date.now() });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/api/shop/buy')
        ? new Response(JSON.stringify({ ok: true, kind: 'speed', added: 3, charges: { magnet: 4, leap: 0, speed: 3, invis: 0 } }), { status: 200 })
        : new Response(JSON.stringify(VIEW), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    act(() => useUi.setState({ chain: chainStatus(), modal: 'shop', auth: { address: OWNER, token: 'tok', profile: null } }));
    render(
      <Kb>
        <ShopSheet />
      </Kb>,
    );
    await waitFor(() => expect(screen.getByTestId('shop-claim')).toBeTruthy());
    expect(screen.getByTestId('shop-pending').textContent).toMatch(/payment for Speed burst went through/i);
    fireEvent.click(screen.getByTestId('shop-claim'));
    await waitFor(() => expect(screen.queryByTestId('shop-pending')).toBeNull());
    const claimCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/shop/buy')) as unknown as [string, RequestInit];
    expect(JSON.parse(claimCall[1].body as string)).toEqual({ kind: 'speed', txHash: HASH });
    expect(loadPendingClaim(OWNER)).toBeNull();
  });
});

describe('leap trail state', () => {
  const snap = (flags: number, x = 100): SnapshotData => ({
    tick: 1,
    view: { x: 0, y: 0, h: 1200 },
    players: [{ id: 3, skin: 0, flags: 0, name: 'a' }],
    upserts: [{ id: 9, kind: EntityKind.Cell, x, y: 100, r: 40, playerId: 3, flags }],
    removals: [],
  });
  it('starts the trail on the rising edge of the flag only, from where the coin was', () => {
    const w = new ClientWorld();
    w.apply(snap(0), 10);
    expect(w.entities.get(9)!.leapAt).toBe(0);
    w.apply(snap(CellFlag.Leap, 600), 50);
    const e = w.entities.get(9)!;
    expect(e.leapAt).toBe(50);
    expect([e.leapX, e.leapY]).toEqual([100, 100]);
    w.apply(snap(CellFlag.Leap | CellFlag.Magnet, 610), 80);
    expect(w.entities.get(9)!.leapAt).toBe(50);
    w.apply(snap(0), 120);
    w.apply(snap(CellFlag.Leap), 400);
    expect(w.entities.get(9)!.leapAt).toBe(400);
  });
});

describe('admin shop patch', () => {
  it('sends only what changed', () => {
    const a = structuredClone(SHOP_DEFAULTS);
    const b = structuredClone(SHOP_DEFAULTS);
    expect(shopPatch(a, b)).toEqual({});
    b.prices.leap = '500';
    b.kinds.invis = false;
    b.arenaUsesPerRound = 1;
    expect(shopPatch(a, b)).toEqual({ prices: { leap: '500' }, kinds: { invis: false }, arenaUsesPerRound: 1 });
  });
});
