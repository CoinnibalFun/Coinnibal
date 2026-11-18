import type { CustomRoomQuote, CustomRoomView } from '@coinnibal/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOM_SETTINGS_DEFAULT } from '@coinnibal/shared';
import { customRoomsPatch, draftBase, feeLadder, feeText, roomKindText } from '../src/admin/CustomRoomsCard';
import { arenaTarget, leavePaidSeat, openInvite, seatInPaidRoom } from '../src/rooms/invite';
import { Kb } from '../src/design';
import { RoomApiError, loadPendingPayment, roomLink, savePendingPayment } from '../src/rooms/api';
import { RoomCreator, roomFeeText } from '../src/rooms/RoomCreator';
import { newRoomRequest } from '../src/rooms/pay';
import { tokenText } from '../src/ui/lobby/useLobby';
import { RoomCard, resetInviteLink, useInviteLink } from '../src/rooms/RoomCard';

function Probe() {
  useInviteLink();
  return null;
}
import { useUi } from '../src/store';
import { resetWallets, useWallet } from '../src/wallet/store';
import { useChainData } from '../src/wallet/chain';
import { ALICE, ONE, chainStatus, detail, fakeProvider } from './evm-helpers';

const HASH = `0x${'ab'.repeat(32)}`;
const ARENA = '0x00000000000000000000000000000000000A7e4A';
/** The base room fee: 1,500 game tokens. */
const PRICE = 1500n * 10n ** 18n;
const REQUEST = expect.stringMatching(/^[a-z2-7]{16}$/);

const spies = vi.hoisted(() => ({ quote: vi.fn(), create: vi.fn(), pay: vi.fn(), play: vi.fn(), get: vi.fn(), buy: vi.fn() }));
vi.mock('../src/wallet/buyTicket', () => ({ buyTicket: spies.buy }));
vi.mock('../src/rooms/api', async (orig) => {
  const real = await orig<typeof import('../src/rooms/api')>();
  return { ...real, roomsApi: { ...real.roomsApi, quote: spies.quote, create: spies.create, get: spies.get, mine: async () => [] } };
});
vi.mock('../src/rooms/pay', async (orig) => ({ ...(await orig<typeof import('../src/rooms/pay')>()), payRoomFee: spies.pay }));
vi.mock('../src/game/instance', () => ({ engine: () => ({ play: spies.play }) }));

const quote = (o: Partial<CustomRoomQuote> = {}): CustomRoomQuote => ({
  enabled: true,
  pay: { token: { address: '0x0000000000000000000000000000000000007e57', symbol: '$ELYMUM', decimals: 18 }, payTo: ARENA, burnBps: 5000 },
  priceRaw: PRICE.toString(),
  youPayRaw: PRICE.toString(),
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
  spies.pay.mockImplementation(async (_pay: unknown, _raw: bigint, _request: string, ctx: { onPhase: (p: string) => void; onStep?: (s: string) => void }) => {
    ctx.onStep?.('approve');
    ctx.onPhase('signing');
    ctx.onStep?.('pay');
    ctx.onPhase('signing');
    ctx.onPhase('confirming');
    return { ok: true, hash: HASH };
  });
  spies.get.mockRejectedValue(new RoomApiError(404, 'not_found', 'No open room with that code.'));
  spies.buy.mockImplementation(async (_p: unknown, onPhase: (s: string | null, p: string, h?: string) => void) => {
    onPhase('approve', 'signing');
    onPhase('join', 'signing');
    onPhase('join', 'confirming', HASH);
    return { ok: true, hash: HASH };
  });
  resetWallets();
  useUi.setState({ chain: chainStatus(), auth: null, paidSeat: null, lobbyIntent: null, blockedArenas: [] });
  // the creator's wallet on chain: the token set, arena 2 at 10,000 tokens, 50,000 in the wallet, no allowance yet
  useChainData.setState({
    fake: false,
    config: { token: '0x0000000000000000000000000000000000007e57', burnBps: 1500, vaultBps: 500, holderNft: null, holderBurnBps: 1500, holderVaultBps: 500, paused: false } as never,
    arenas: [{ id: 2, entryFee: 10_000n * ONE, enabled: true } as never],
    sessions: {},
    pending: [],
    tokenBalance: 50_000n * ONE,
    allowance: 0n,
    holder: false,
  });
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
    // the fee in game tokens (no dollar value without a token price)
    expect(screen.getByTestId('cr-price').textContent).toMatch(/1,500 \$ELYMUM/);
    expect(screen.getByTestId('cr-price').textContent).not.toMatch(/ETH/);
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
    expect(payment.textContent).toMatch(/Total1,500 \$ELYMUM/);
    expect(payment.textContent).not.toMatch(/\d ETH/);
    // paid to the arena like a power-up pack: half burned, half to the team wallet
    expect(screen.getByTestId('cr-pay-note').textContent).toMatch(/50% is burned and 50% goes to the team wallet/);
    expect(screen.getByTestId('cr-pay').textContent).toMatch(/Pay 1,500 \$ELYMUM/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    fireEvent.click(screen.getByTestId('cr-pay')); // a double click never pays twice
    await settle();
    expect(spies.pay).toHaveBeenCalledTimes(1);
    expect(spies.pay.mock.calls[0][0]).toMatchObject({ payTo: ARENA });
    expect(spies.pay.mock.calls[0][1]).toBe(PRICE);
    const request = spies.pay.mock.calls[0][2] as string;
    expect(request).toMatch(/^[a-z2-7]{16}$/);
    // the server gets the payment and the request its ref names
    expect(spies.create).toHaveBeenCalledWith('tok', expect.objectContaining({ name: 'Friday Pond', durationMin: 60, mapSize: 'L', bots: 6, difficulty: 'hard', traps: 'many' }), { txHash: HASH, request });
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
    // the kept payment goes again with its own request (the ref it paid)
    expect(spies.create).toHaveBeenLastCalledWith('tok', expect.anything(), { txHash: HASH, request: spies.pay.mock.calls[0][2] });
    expect(screen.getByTestId('cr-code')).toBeTruthy();
  });

  it('a payment the server refuses for good is not offered again as the kept payment', async () => {
    signIn();
    spies.create.mockRejectedValueOnce(new RoomApiError(400, 'payment_invalid', 'That payment was made for something else, not for this room.', undefined, false));
    await open();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Short room' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/made for something else/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/Your payment is kept/);
    expect(loadPendingPayment(ALICE)).toBeNull();
    expect(screen.getByTestId('cr-pay').textContent).not.toMatch(/Open with my payment/);
  });

  it('a holder with a free room opens it without a payment', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ holder: true, holderPerk: 'free_daily', freeAvailable: true, youPayRaw: '0' }));
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

  it('shows the dollar value of the fee when the token has a price; the wallet first approves, then pays', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ usdCents: 150, usdPerToken: '0.001' }));
    let release: () => void = () => {};
    spies.pay.mockImplementation(async (_pay: unknown, _raw: bigint, _request: string, ctx: { onPhase: (p: string) => void; onStep?: (s: string) => void }) => {
      ctx.onStep?.('approve');
      ctx.onPhase('signing');
      await new Promise<void>((r) => (release = r));
      ctx.onStep?.('pay');
      ctx.onPhase('signing');
      return { ok: true, hash: HASH };
    });
    await open();
    expect(screen.getByTestId('cr-price').textContent).toMatch(/1,500 \$ELYMUM/);
    expect(screen.getByTestId('cr-price').textContent).toMatch(/\$1\.50/);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Dollar room' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    expect(screen.getByTestId('cr-payment').textContent).toMatch(/Total1,500 \$ELYMUMIn dollars≈ \$1\.50/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(screen.getByRole('status').textContent).toMatch(/Approve 1,500 \$ELYMUM in your wallet/);
    release();
    await settle();
    expect(screen.getByTestId('cr-code').textContent).toBe('AB2CD');
  });

  it('before the game token is live: a room that costs something cannot be paid, a holder\'s free room still opens', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ pay: null, payClosed: 'no_token' }));
    await open();
    expect(screen.getByTestId('cr-token-soon').textContent).toMatch(/paid in tokens, and the game token is not live yet\. Practice with bots is free/);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Too early' } });
    const btn = screen.getByTestId('cr-continue') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/opens when the token is live/);
    cleanup();
    spies.quote.mockResolvedValue(quote({ pay: null, payClosed: 'no_token', holder: true, holderPerk: 'free_daily', freeAvailable: true, youPayRaw: '0' }));
    await open();
    expect(screen.queryByTestId('cr-token-soon')).toBeNull();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Holder room' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.pay).not.toHaveBeenCalled();
    expect(spies.create).toHaveBeenCalledWith('tok', expect.anything(), null);
  });

  it('too few tokens for the fee is said before any signature', async () => {
    signIn();
    useChainData.setState({ tokenBalance: 1_000n * ONE });
    await open();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Poor room' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    expect(screen.queryByTestId('cr-payment')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/This room costs 1,500 \$ELYMUM, and this wallet has 1,000 \$ELYMUM/);
    expect(spies.pay).not.toHaveBeenCalled();
  });

  it('a declined payment pays nothing and keeps nothing; a payment sent but not seen confirming is checked by the server and kept', async () => {
    signIn();
    spies.pay.mockResolvedValueOnce({ ok: false, rejected: true, hash: null, message: 'You rejected the request in your wallet.' });
    await open();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Shy room' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/You rejected/);
    expect(spies.create).not.toHaveBeenCalled();
    expect(loadPendingPayment(ALICE)).toBeNull();
    // sent, the receipt timed out here: the server is asked (it says pending, then still pending), the payment is kept
    spies.pay.mockResolvedValueOnce({ ok: false, rejected: false, hash: HASH, message: 'The network did not answer in time.' });
    spies.create.mockRejectedValue(new RoomApiError(409, 'payment_pending', 'The payment is not confirmed yet. Try again in a few seconds.'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(screen.getByTestId('cr-pay'));
      for (let i = 0; i < 4; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(2600)));
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(spies.create).toHaveBeenCalledTimes(4);
    expect(spies.create).toHaveBeenLastCalledWith('tok', expect.anything(), { txHash: HASH, request: REQUEST });
    expect(screen.getByRole('alert').textContent).toMatch(/not confirmed yet.*Your payment is kept/);
    expect(loadPendingPayment(ALICE)).toMatchObject({ hash: HASH, raw: PRICE.toString() });
    expect(screen.getByTestId('cr-pay').textContent).toMatch(/Open with my payment/);
  });

  it('the fee follows the capacity live: x1.5 from 11 players, x2 from 21; the payment is the scaled fee', async () => {
    signIn();
    await open();
    const range = screen.getByTestId('cr-capacity-range') as HTMLInputElement;
    expect(screen.getByTestId('cr-capacity').textContent).toMatch(/^Max players10/);
    expect(screen.getByTestId('cr-price').textContent).toMatch(/1,500/);
    expect(screen.getByTestId('cr-capacity-note').textContent).toMatch(/up to 10 players/);
    // the steps: 2 4 6 8 10 15 20 25 30 40 50 (the server's biggest room is 50)
    expect(range.max).toBe('10');
    fireEvent.change(range, { target: { value: '6' } }); // 20 players
    expect(screen.getByTestId('cr-capacity').textContent).toMatch(/20/);
    expect(screen.getByTestId('cr-price').textContent).toMatch(/2,250/);
    expect(screen.getByTestId('cr-price').textContent).toMatch(/for up to 20 players/);
    expect(screen.getByTestId('cr-capacity-note').textContent).toMatch(/1\.5 times the base/);
    fireEvent.change(range, { target: { value: '8' } }); // 30 players
    expect(screen.getByTestId('cr-price').textContent).toMatch(/3,000/);
    fireEvent.change(range, { target: { value: '10' } }); // 50 players: x3
    expect(screen.getByTestId('cr-price').textContent).toMatch(/4,500/);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Big pond' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    expect(screen.getByTestId('cr-payment').textContent).toMatch(/up to 50/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.pay.mock.calls[0][1]).toBe(PRICE * 3n);
    expect(spies.create).toHaveBeenCalledWith('tok', expect.objectContaining({ maxPlayers: 50, kind: 'free', arenaId: null }), { txHash: HASH, request: REQUEST });
  });

  it('a holder discount applies to the scaled fee; too many seats for the server is said and blocks', async () => {
    signIn();
    spies.quote.mockResolvedValue(quote({ holder: true, seatsLeft: 12 }));
    await open();
    const range = screen.getByTestId('cr-capacity-range') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '6' } }); // 20 players: 2,250, half off
    expect(screen.getByTestId('cr-price').textContent).toMatch(/1,125/);
    expect(screen.getByTestId('cr-price').textContent).toMatch(/2,250 \$ELYMUM/); // the full price, struck
    expect(screen.getByTestId('cr-seats').textContent).toMatch(/room for 12 more players/);
    expect((screen.getByTestId('cr-continue') as HTMLButtonElement).disabled).toBe(true);
  });

  /** Sets up a ticket room on arena 2 in the sheet and presses Continue. */
  const ticketRoom = async () => {
    spies.create.mockResolvedValue({ room: roomView({ kind: 'paid', arenaId: 2, endsAt: Date.now() + 20 * 60_000 }), invite: 'http://localhost/play?room=AB2CD' });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Ticket room' }));
    fireEvent.click(screen.getByRole('group', { name: 'Ticket price' }).querySelector('[data-value="2"]')!);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Whale Club' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
  };
  const seated = () => act(async () => new Promise((r) => setTimeout(r, 1000)));

  it('a ticket room: picks an arena tier (holders-only tiers for holders only); one flow takes the fee, then the creator\'s own ticket, and seats the creator', async () => {
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
    expect(screen.getByTestId('cr-kind-hint').textContent).toMatch(/\$3 Room ticket/);
    expect(screen.getByTestId('cr-kind-hint').textContent).toMatch(/starts at once/);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Whale Club' } });
    fireEvent.click(screen.getByTestId('cr-continue'));
    await settle();
    // the receipt names both: the room fee, then the creator's own ticket
    const payment = screen.getByTestId('cr-payment');
    expect(payment.textContent).toMatch(/Paid room\$3 Room/);
    expect(payment.textContent).toMatch(/never holds anyone's tokens/);
    expect(payment.textContent).toMatch(/Your ticket10,000 \$ELYMUM/);
    expect(screen.getByTestId('cr-pay').textContent).toMatch(/then my ticket/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.pay).toHaveBeenCalledTimes(1);
    expect(spies.create).toHaveBeenCalledWith('tok', expect.objectContaining({ kind: 'paid', arenaId: 2, bots: 0 }), { txHash: HASH, request: REQUEST });
    // straight on: the creator's ticket of arena 2, the price on chain, approve then join (no second trip)
    expect(spies.buy).toHaveBeenCalledTimes(1);
    expect(spies.buy.mock.calls[0][0]).toMatchObject({ owner: ALICE, arenaId: 2, fake: false, review: { fee: 10_000n * ONE, steps: ['approve', 'join'], rates: { burnBps: 1500, vaultBps: 500 } } });
    expect(useUi.getState().paidSeat).toMatchObject({ code: 'AB2CD', arenaId: 2, name: 'Friday Pond' });
    expect(screen.getByTestId('cr-ticket').textContent).toMatch(/AB2CD/);
    await seated();
    // seated in the room by its code (the join waits for the ticket to be seen by the server)
    expect(spies.play).toHaveBeenCalledWith('arena:2:AB2CD', { awaitTicket: true });
    expect(useUi.getState().lobbyIntent).toBeNull();
  });

  it('a ticket room: a rejected ticket keeps the room open; the creator retries in the same sheet (the fee is never paid again)', async () => {
    signIn();
    spies.buy.mockResolvedValueOnce({ ok: false, text: 'You rejected the request in your wallet.' });
    await ticketRoom();
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('cr-ticket-error').textContent).toMatch(/The room is open, but your ticket did not go through: You rejected/);
    expect(spies.play).not.toHaveBeenCalled();
    // the room's seat is remembered for the lobby too ("Later")
    expect(useUi.getState().paidSeat).toMatchObject({ code: 'AB2CD', arenaId: 2 });
    fireEvent.click(screen.getByTestId('cr-ticket-retry'));
    await settle();
    expect(spies.buy).toHaveBeenCalledTimes(2);
    await seated();
    expect(spies.pay).toHaveBeenCalledTimes(1);
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.play).toHaveBeenCalledWith('arena:2:AB2CD', { awaitTicket: true });
  });

  it('a ticket room: too few tokens for the room fee and the creator\'s own ticket is said before any fee is paid', async () => {
    signIn();
    // 10,000 for the ticket, 1,500 for the room: 11,000 is not enough
    useChainData.setState({ tokenBalance: 11_000n * ONE });
    await ticketRoom();
    expect(screen.queryByTestId('cr-payment')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/You need 11,500 \$ELYMUM for the room fee and your own ticket/);
    expect(spies.pay).not.toHaveBeenCalled();
  });

  it('a ticket room: an open ticket of that arena is resumed in the room (no new ticket bought)', async () => {
    signIn();
    useChainData.setState({ sessions: { 2: { id: 7n, entryFee: 10_000n * ONE, openedAt: Math.floor(Date.now() / 1000), finalized: false, owed: 0n } as never } });
    await ticketRoom();
    expect(screen.getByTestId('cr-payment').textContent).toMatch(/Your open ticket/);
    fireEvent.click(screen.getByTestId('cr-pay'));
    await settle();
    expect(spies.buy).not.toHaveBeenCalled();
    expect(spies.play).toHaveBeenCalledWith('arena:2:AB2CD', {});
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
  it('writes a room fee in game tokens with its dollar value, and builds share links', () => {
    const tok = tokenText(18, '$ELYMUM');
    const f = roomFeeText(quote({ usdPerToken: '0.001' }), tok);
    expect(f.tokens(PRICE)).toBe('1,500 $ELYMUM');
    expect(f.usd(PRICE)).toBeCloseTo(1.5, 6);
    expect(f.usd(0n)).toBeNull();
    // no token price known: no dollar value; another token's decimals and symbol from the quote
    expect(roomFeeText(quote(), tok).usd(PRICE)).toBeNull();
    expect(roomFeeText(quote({ pay: { token: { address: ARENA, symbol: 'TEST', decimals: 6 }, payTo: ARENA, burnBps: 5000 } }), tok).tokens(2_500_000n)).toBe('2.5 TEST');
    // before the token is set: the lobby's token text
    expect(roomFeeText(quote({ pay: null }), tok).tokens(PRICE)).toBe('1,500 $ELYMUM');
    expect(roomLink('AB2CD', 'https://elymum.io/')).toBe('https://elymum.io/play?room=AB2CD');
  });

  it('every payment gets its own request id (the ref the server opens one room for)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRoomRequest()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{16}$/);
  });

  it('the admin card sends only the changed settings', () => {
    const s = { ...CUSTOM_SETTINGS_DEFAULT };
    expect(customRoomsPatch(s, { ...s })).toEqual({});
    expect(customRoomsPatch(s, { ...s, priceIn: 'token', priceTokens: '2000', usdCents: 200, maxLive: 4, capacityStepPct: 25, paidRooms: false })).toEqual({
      priceIn: 'token',
      priceTokens: '2000',
      usdCents: 200,
      maxLive: 4,
      capacityStepPct: 25,
      paidRooms: false,
    });
  });

  it('the admin card prices a draft with the server\'s own function', () => {
    const view = { settings: { ...CUSTOM_SETTINGS_DEFAULT }, base: { raw: PRICE.toString(), decimals: 18, usdCents: 150, usdPerToken: '0.001', sigFigs: 2 } };
    expect(draftBase(view, view.settings)).toEqual({ raw: PRICE, usdCents: 150 });
    // $2.50 at $0.001: 2,500 tokens; at $0.00081 the arenas' rounding (2 figures): 3,100
    expect(draftBase(view, { ...view.settings, usdCents: 250 })).toEqual({ raw: 2500n * ONE, usdCents: 250 });
    expect(draftBase({ ...view, base: { ...view.base, usdPerToken: '0.00081' } }, { ...view.settings, usdCents: 250 })).toEqual({ raw: 3100n * ONE, usdCents: 250 });
    expect(draftBase(view, { ...view.settings, priceIn: 'token', priceTokens: '12.5' })).toEqual({ raw: 125n * 10n ** 17n, usdCents: null });
    expect(draftBase(view, { ...view.settings, priceIn: 'token', priceTokens: '12.' })).toBeNull();
  });

  it('the admin card lists the kind, tier and fee of each room, and the fee by size', () => {
    expect(roomKindText({ kind: 'paid', arenaId: 2 })).toBe('paid · $3 Room #2');
    expect(roomKindText({ kind: 'free' })).toBe('free');
    expect(roomKindText({})).toBe('free');
    expect(roomKindText({ kind: 'free', practice: true })).toBe('practice with bots');
    expect(feeText({ feeRaw: (PRICE * 3n).toString(), feeIn: 'token' }, 18)).toBe('4,500');
    expect(feeText({ feeRaw: '0' }, 18)).toBe('0');
    expect(feeText({}, 18)).toBe('0');
    // a room opened before rooms were paid in tokens shows its ETH fee as such
    expect(feeText({ feeRaw: (5n * 10n ** 14n).toString(), feeIn: 'gas' }, 18)).toBe('0.0005 ETH');
    expect(feeLadder(PRICE, 18, 50, 100)).toBe('10: 1,500 · 20: 2,250 · 50: 4,500 · 100: 8,250');
    expect(feeLadder(PRICE, 18, 50, 36)).toBe('10: 1,500 · 20: 2,250 · 36: 3,750');
    expect(feeLadder(PRICE, 18, 50, 20, 150)).toBe('10: $1.50 (1,500) · 20: $2.25 (2,250)');
  });

  it('a kept payment belongs to its wallet and expires', () => {
    const request = newRoomRequest();
    savePendingPayment({ hash: HASH, wallet: ALICE, request, raw: '1', at: Date.now() });
    expect(loadPendingPayment(ALICE.toLowerCase())).toMatchObject({ hash: HASH, request });
    expect(loadPendingPayment('0x2222222222222222222222222222222222222222')).toBeNull();
    savePendingPayment({ hash: HASH, wallet: ALICE, request, raw: '1', at: Date.now() - 3 * 3600_000 });
    expect(loadPendingPayment(ALICE)).toBeNull();
    // a kept payment without its request (or an ETH one of before) is not offered
    localStorage.setItem('elymum.room-payment.v2', JSON.stringify({ hash: HASH, wallet: ALICE, raw: '1', at: Date.now() }));
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
