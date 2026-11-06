import type { CustomRoomQuote, CustomRoomView } from '@elymum/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOM_SETTINGS_DEFAULT } from '@elymum/shared';
import { customRoomsPatch, feeLadder, feeText, roomKindText } from '../src/admin/CustomRoomsCard';
import { arenaTarget, leavePaidSeat, openInvite, seatInPaidRoom } from '../src/rooms/invite';
import { Kb } from '../src/design';
import { RoomApiError, loadPendingPayment, roomLink, savePendingPayment } from '../src/rooms/api';
import { RoomCreator, gasText } from '../src/rooms/RoomCreator';
import { RoomCard, resetInviteLink, useInviteLink } from '../src/rooms/RoomCard';

function Probe() {
  useInviteLink();
  return null;
}
import { useUi } from '../src/store';
import { resetWallets, useWallet } from '../src/wallet/store';
import { ALICE, chainStatus, detail, fakeProvider } from './evm-helpers';

const HASH = `0x${'ab'.repeat(32)}`;
const TREASURY = '0x3333333333333333333333333333333333333333';
const PRICE = 5n * 10n ** 16n;

const spies = vi.hoisted(() => ({ quote: vi.fn(), create: vi.fn(), pay: vi.fn(), play: vi.fn(), get: vi.fn() }));
vi.mock('../src/rooms/api', async (orig) => {
  const real = await orig<typeof import('../src/rooms/api')>();
  return { ...real, roomsApi: { ...real.roomsApi, quote: spies.quote, create: spies.create, get: spies.get, mine: async () => [] } };
});
vi.mock('../src/rooms/pay', () => ({ payRoomFee: spies.pay }));
vi.mock('../src/game/instance', () => ({ engine: () => ({ play: spies.play }) }));

const quote = (o: Partial<CustomRoomQuote> = {}): CustomRoomQuote => ({
  enabled: true,
  priceWei: PRICE.toString(),
  youPayWei: PRICE.toString(),
  treasury: TREASURY,
  holderPerk: 'discount',
  holderDiscountPct: 50,
  holder: false,
  freeAvailable: false,
  live: 1,
  maxLive: 6,
  mine: 0,
  maxPerWallet: 2,
  chainId: 46630,
  capacityStepPct: 50,
  maxPlayers: 50,
  seatsLeft: 200,
  paidRooms: true,
  tiers: [
    { arenaId: 1, entryFee: 1_000_000_000, holdersOnly: false },
    { arenaId: 2, entryFee: 10_000_000_000, holdersOnly: false },
    { arenaId: 4, entryFee: 250_000_000_000, holdersOnly: true },
  ],
  ...o,
});
const roomView = (o: Partial<CustomRoomView> = {}): CustomRoomView => ({
  code: 'AB2CD',
  name: 'Friday Pond',
  maxPlayers: 10,
  players: 0,
  best: [],
  paidWith: 'paid',
  txHash: HASH,
  durationMin: 30,
  mapSize: 'M',
  bots: 6,
  difficulty: 'mixed',
  food: 'normal',
  traps: 'normal',
  powerUps: true,
  creator: ALICE,
  createdAt: 1,
  endsAt: 1 + 30 * 60_000,
  ...o,
});
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

function signIn() {
  useWallet.setState({ status: 'connected', address: ALICE, chainId: 46630, current: detail(fakeProvider({ chainId: 46630, known: [46630] })) });
  useUi.setState({ auth: { address: ALICE, token: 'tok', profile: null } });
}

beforeEach(() => {
  for (const s of Object.values(spies)) s.mockReset();
  spies.quote.mockResolvedValue(quote());
  spies.create.mockResolvedValue({ room: roomView(), invite: 'http://localhost/play?room=AB2CD' });
  spies.pay.mockImplementation(async (_c: unknown, _to: unknown, _wei: bigint, onPhase: (p: string, h?: string) => void) => {
    onPhase('signing');
    onPhase('confirming', HASH);
    return { ok: true, hash: HASH };
  });
  spies.get.mockRejectedValue(new RoomApiError(404, 'not_found', 'No open room with that code.'));
  resetWallets();
  useUi.setState({ chain: chainStatus(), auth: null, paidSeat: null, lobbyIntent: null });
  savePendingPayment(null);
});
afterEach(() => savePendingPayment(null));

const open = async () => {
  render(
    <Kb>
      <RoomCreator open onClose={() => {}} />
    </Kb>,
  );
  await settle();
};

describe('the room creator', () => {
  it('asks a guest to connect a wallet: guests cannot create', async () => {
    await open();
    expect(screen.getByText('Connect a wallet to create')).toBeTruthy();
    expect(screen.getByText(/Guests can join any room with its code/)).toBeTruthy();
    expect(spies.quote).toHaveBeenCalledWith(null);
  });

  it('picks the rules, shows the payment step, pays once and ends on the invite code and link', async () => {
    signIn();
    await open();
    expect(spies.quote).toHaveBeenCalledWith('tok');
    expect(screen.getByTestId('cr-price').textContent).toMatch(/0\.05/);
    // a name is required
    fireEvent.click(screen.getByTestId('cr-continue'));
    expect(screen.getByText(/Give the room a name/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Friday Pond' } });
    fireEvent.click(screen.getByRole('button', { name: '60 min' }));
    fireEvent.click(screen.getByRole('button', { name: 'Huge' }));
    expect(screen.getByTestId('cr-map-hint').textContent).toContain('9,000 x 9,000');
    fireEvent.click(screen.getByRole('button', { name: 'Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Many' }));
    // practice bots are off by default; turned on, they come at the suggested count and the difficulty appears
    expect(screen.queryByRole('group', { name: 'Bot difficulty' })).toBeNull();
    fireEvent.click(within(screen.getByRole('group', { name: 'Bots' })).getByRole('button', { name: 'On' }));
    expect(screen.getByText(/tagged BOT, they carry no value/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }));
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    const payment = screen.getByTestId('cr-payment');
    expect(payment.textContent).toMatch(/60 min/);
    expect(payment.textContent).toMatch(/Large · many cacti/);
    expect(payment.textContent).toMatch(/none, pure fun/);
    expect(payment.textContent).toMatch(/0\.05 ETH/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    fireEvent.click(screen.getByTestId('cr-pay')); // a double click never pays twice
    await settle();
    expect(spies.pay).toHaveBeenCalledTimes(1);
    expect(spies.pay.mock.calls[0][1]).toBe(TREASURY);
    expect(spies.pay.mock.calls[0][2]).toBe(PRICE);
    expect(spies.create).toHaveBeenCalledWith('tok', expect.objectContaining({ name: 'Friday Pond', durationMin: 60, mapSize: 'L', bots: 6, difficulty: 'hard', traps: 'many' }), HASH);
    expect(screen.getByTestId('cr-code').textContent).toBe('AB2CD');
    expect((screen.getByLabelText('Invite link') as HTMLInputElement).value).toMatch(/\/play\?room=AB2CD$/);
    expect(loadPendingPayment(ALICE)).toBeNull();
    fireEvent.click(screen.getByTestId('cr-enter'));
    expect(spies.play).toHaveBeenCalledWith('private:AB2CD');
  });

  it('a payment that went through but opened no room is kept and reused, never paid twice', async () => {
    signIn();
    spies.create.mockRejectedValueOnce(new RoomApiError(503, 'slots_busy', 'All room slots are busy right now.', undefined, true));
    await open();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Retry room' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/All room slots are busy.*Your payment is kept/);
    expect(loadPendingPayment(ALICE)?.hash).toBe(HASH);
    expect(screen.getByTestId('cr-pay').textContent).toMatch(/Open with my payment/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.pay).toHaveBeenCalledTimes(1);
    expect(spies.create).toHaveBeenLastCalledWith('tok', expect.anything(), HASH);
    expect(screen.getByTestId('cr-code')).toBeTruthy();
  });

  it('a payment the server refuses for good is not offered again as the kept payment', async () => {
    signIn();
    spies.create.mockRejectedValueOnce(new RoomApiError(400, 'payment_low', 'That payment is below the room price.', undefined, false));
    await open();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Short room' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/below the room price/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/Your payment is kept/);
    expect(loadPendingPayment(ALICE)).toBeNull();
    expect(screen.getByTestId('cr-pay').textContent).not.toMatch(/Open with my payment/);
  });

  it('a holder with a free room opens it without a payment', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ holder: true, holderPerk: 'free_daily', freeAvailable: true, youPayWei: '0' }));
    await open();
    expect(screen.getByTestId('cr-price').textContent).toMatch(/Free/);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Holder room' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.pay).not.toHaveBeenCalled();
    expect(spies.create).toHaveBeenCalledWith('tok', expect.anything(), null);
  });

  it('the fee follows the capacity live: x1.5 from 11 players, x2 from 21; the payment is the scaled fee', async () => {
    signIn();
    await open();
    const range = screen.getByTestId('cr-capacity-range') as HTMLInputElement;
    expect(screen.getByTestId('cr-capacity').textContent).toMatch(/^Max players10/);
    expect(screen.getByTestId('cr-price').textContent).toMatch(/0\.05/);
    expect(screen.getByTestId('cr-capacity-note').textContent).toMatch(/up to 10 players/);
    // the steps: 2 4 6 8 10 15 20 25 30 40 50 (the server's biggest room is 50)
    expect(range.max).toBe('10');
    fireEvent.change(range, { target: { value: '6' } }); // 20 players
    expect(screen.getByTestId('cr-capacity').textContent).toMatch(/20/);
    expect(screen.getByTestId('cr-price').textContent).toMatch(/0\.075/);
    expect(screen.getByTestId('cr-price').textContent).toMatch(/for up to 20 players/);
    expect(screen.getByTestId('cr-capacity-note').textContent).toMatch(/1\.5 times the base/);
    fireEvent.change(range, { target: { value: '8' } }); // 30 players
    expect(screen.getByTestId('cr-price').textContent).toMatch(/0\.10/);
    fireEvent.change(range, { target: { value: '10' } }); // 50 players: x3
    expect(screen.getByTestId('cr-price').textContent).toMatch(/0\.15/);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Big pond' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    expect(screen.getByTestId('cr-payment').textContent).toMatch(/up to 50/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.pay.mock.calls[0][2]).toBe(PRICE * 3n);
    expect(spies.create).toHaveBeenCalledWith('tok', expect.objectContaining({ maxPlayers: 50, kind: 'free', arenaId: null }), HASH);
  });

  it('a holder discount applies to the scaled fee; too many seats for the server is said and blocks', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ holder: true, seatsLeft: 12 }));
    await open();
    const range = screen.getByTestId('cr-capacity-range') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '6' } }); // 20 players: 0.075, half off
    expect(screen.getByTestId('cr-price').textContent).toMatch(/0\.0375/);
    expect(screen.getByTestId('cr-seats').textContent).toMatch(/room for 12 more players/);
    expect((screen.getByTestId('cr-continue') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a ticket room: picks an arena tier (holders-only tiers for holders only), opens, and its entry is the arena ticket', async () => {
    signIn();
    spies.create.mockResolvedValue({ room: roomView({ kind: 'paid', arenaId: 2, endsAt: Date.now() + 20 * 60_000 }), invite: 'http://localhost/play?room=AB2CD' });
    await open();
    // bots on in a free room, then a ticket room: practice bots are for free rooms only (no control, none sent)
    fireEvent.click(within(screen.getByRole('group', { name: 'Bots' })).getByRole('button', { name: 'On' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ticket room' }));
    expect(screen.queryByRole('group', { name: 'Bots' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Bot difficulty' })).toBeNull();
    const tiers = screen.getByRole('group', { name: 'Ticket price' });
    expect(tiers.querySelectorAll('button')).toHaveLength(2); // not the holders-only tier
    expect(tiers.querySelector('[aria-pressed="true"]')?.getAttribute('data-value')).toBe('1');
    fireEvent.click(tiers.querySelector('[data-value="2"]')!);
    expect(screen.getByTestId('cr-kind-hint').textContent).toMatch(/Lethe Shore ticket/);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Whale Club' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    const payment = screen.getByTestId('cr-payment');
    expect(payment.textContent).toMatch(/ArenaLethe Shore/);
    expect(payment.textContent).toMatch(/never holds anyone's tokens/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.create).toHaveBeenCalledWith('tok', expect.objectContaining({ kind: 'paid', arenaId: 2, bots: 0 }), HASH);
    expect(screen.getByTestId('cr-done').textContent).toMatch(/buys a Lethe Shore ticket/);
    fireEvent.click(screen.getByTestId('cr-enter'));
    expect(spies.play).not.toHaveBeenCalled();
    expect(useUi.getState().paidSeat).toMatchObject({ code: 'AB2CD', arenaId: 2, name: 'Friday Pond' });
    expect(useUi.getState().lobbyIntent).toMatchObject({ ticket: 'arena:2', open: true });
  });

  it('a holder sees the holders-only tier; ticket rooms closed are said', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ holder: true }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Ticket room' }));
    expect(screen.getByRole('group', { name: 'Ticket price' }).querySelectorAll('button')).toHaveLength(3);
  });

  it('ticket rooms off: the creator says so and does not continue', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ paidRooms: false, tiers: [] }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Ticket room' }));
    expect(screen.getByTestId('cr-paid-off')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Whale Club' } });
    expect((screen.getByTestId('cr-continue') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when every room slot is busy', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ live: 6, maxLive: 6 }));
    await open();
    const btn = screen.getByTestId('cr-continue') as HTMLButtonElement;
    expect(btn.textContent).toMatch(/All room slots are busy/);
    expect(btn.disabled).toBe(true);
  });
});

describe('room helpers', () => {
  it('formats ETH with as few decimals as needed and builds share links', () => {
    expect(gasText(PRICE)).toBe('0.05');
    expect(gasText(PRICE / 2n)).toBe('0.025');
    expect(gasText(10n ** 18n)).toBe('1.00');
    expect(roomLink('AB2CD', 'https://elymum.io/')).toBe('https://elymum.io/play?room=AB2CD');
  });

  it('the admin card sends only the changed settings', () => {
    const s = { ...CUSTOM_SETTINGS_DEFAULT };
    expect(customRoomsPatch(s, { ...s })).toEqual({});
    expect(customRoomsPatch(s, { ...s, priceGas: '0.1', maxLive: 4, capacityStepPct: 25, paidRooms: false })).toEqual({ priceGas: '0.1', maxLive: 4, capacityStepPct: 25, paidRooms: false });
  });

  it('the admin card lists the kind, tier and fee of each room, and the fee by size', () => {
    expect(roomKindText({ kind: 'paid', arenaId: 2 })).toBe('paid · Lethe Shore #2');
    expect(roomKindText({ kind: 'free' })).toBe('free');
    expect(roomKindText({})).toBe('free');
    expect(roomKindText({ kind: 'free', practice: true })).toBe('practice with bots');
    expect(feeText({ feeWei: (PRICE * 3n).toString() })).toBe('0.15');
    expect(feeText({ feeWei: '0' })).toBe('0');
    expect(feeText({})).toBe('0');
    expect(feeLadder('0.05', 50, 100)).toBe('10: 0.05 · 20: 0.075 · 50: 0.15 · 100: 0.275');
    expect(feeLadder('0.05', 50, 36)).toBe('10: 0.05 · 20: 0.075 · 36: 0.125');
    expect(feeLadder('nope', 50, 50)).toBeNull();
  });

  it('a kept payment belongs to its wallet and expires', () => {
    savePendingPayment({ hash: HASH, wallet: ALICE, wei: '1', at: Date.now() });
    expect(loadPendingPayment(ALICE.toLowerCase())?.hash).toBe(HASH);
    expect(loadPendingPayment('0x2222222222222222222222222222222222222222')).toBeNull();
    savePendingPayment({ hash: HASH, wallet: ALICE, wei: '1', at: Date.now() - 3 * 3600_000 });
    expect(loadPendingPayment(ALICE)).toBeNull();
  });
});

describe('invite links', () => {
  it('opens ?room=CODE once per page load, not again when the lobby mounts after the game', async () => {
    resetInviteLink();
    window.history.replaceState(null, '', '/play?room=ab2cd');
    act(() => useUi.setState({ connected: true }));
    const first = render(<Probe />);
    await settle();
    expect(spies.play).toHaveBeenCalledWith('private:AB2CD');
    first.unmount();
    render(<Probe />);
    await settle();
    expect(spies.play).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, '', '/');
  });

  it("a paid room's invite goes to its arena's ticket, seated there; quick play goes public again once let go", async () => {
    spies.get.mockResolvedValue(roomView({ kind: 'paid', arenaId: 3, name: 'Gold Club', endsAt: Date.now() + 20 * 60_000 }));
    await openInvite('AB2CD');
    expect(spies.play).not.toHaveBeenCalled();
    expect(useUi.getState().paidSeat).toMatchObject({ code: 'AB2CD', arenaId: 3, name: 'Gold Club' });
    expect(useUi.getState().lobbyIntent).toMatchObject({ ticket: 'arena:3', open: true });
    // a ticket of that arena joins the private room; any other arena plays its public rooms
    expect(arenaTarget(3)).toBe('arena:3:AB2CD');
    expect(arenaTarget(1)).toBe('arena:1');
    // the room's time is up: the seat no longer applies
    expect(arenaTarget(3, Date.now() + 21 * 60_000)).toBe('arena:3');
    leavePaidSeat();
    expect(arenaTarget(3)).toBe('arena:3');
  });

  it('a closing ticket room sends nobody to buy a ticket', async () => {
    spies.get.mockResolvedValueOnce(roomView({ kind: 'paid', arenaId: 3, closing: true, endsAt: Date.now() + 60_000 }));
    await openInvite('AB2CD');
    expect(useUi.getState().paidSeat).toBeNull();
    expect(useUi.getState().lobbyIntent).toBeNull();
    expect(spies.play).not.toHaveBeenCalled();
  });

  it('a free room (or a code the API does not know) is joined as a private room', async () => {
    spies.get.mockResolvedValueOnce(roomView({ kind: 'free' }));
    await openInvite('AB2CD');
    expect(spies.play).toHaveBeenLastCalledWith('private:AB2CD');
    await openInvite('ZZ2ZZ');
    expect(spies.play).toHaveBeenLastCalledWith('private:ZZ2ZZ');
    expect(useUi.getState().paidSeat).toBeNull();
    seatInPaidRoom({ code: 'AB2CD', name: 'x', endsAt: Date.now() + 60_000, arenaId: undefined });
    expect(useUi.getState().paidSeat).toBeNull();
  });
});

describe('join by code (8-character room codes)', () => {
  const mount = async () => {
    render(
      <Kb>
        <RoomCard />
      </Kb>,
    );
    await settle();
    return screen.getByLabelText('Room code') as HTMLInputElement;
  };

  it('takes a whole 8-character code (any case) and joins it', async () => {
    const input = await mount();
    expect(input.maxLength).toBeGreaterThanOrEqual(8);
    fireEvent.change(input, { target: { value: 'ab2cd3ef' } });
    expect(input.value).toBe('AB2CD3EF');
    fireEvent.submit(input.closest('form')!);
    await settle();
    expect(spies.play).toHaveBeenLastCalledWith('private:AB2CD3EF');
    expect(screen.queryByText('Room codes are 8 letters and digits.')).toBeNull();
  });

  it('older 5-character codes still join; a malformed code says how long codes are', async () => {
    const input = await mount();
    fireEvent.change(input, { target: { value: 'AB2CD' } });
    fireEvent.submit(input.closest('form')!);
    await settle();
    expect(spies.play).toHaveBeenLastCalledWith('private:AB2CD');
    fireEvent.change(input, { target: { value: 'AB1' } });
    fireEvent.submit(input.closest('form')!);
    await settle();
    expect(screen.getByText('Room codes are 8 letters and digits.')).toBeTruthy();
  });
});
