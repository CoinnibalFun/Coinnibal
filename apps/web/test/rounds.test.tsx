import { RULES, roundAt, type DeathStats, type RoomInfo, type RoundInfo, type RoundStanding } from '@elymum/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { ServerClock, serverClock } from '../src/game/clock';
import { HELD_JITTER_MS, HeldTicket } from '../src/game/held';
import { Input } from '../src/game/input';
import { formatCountdown, roundInfoFor, roundLengths, roundStartLabel, roundStateAt } from '../src/game/round';
import { useChainData } from '../src/wallet/chain';
import { chainStatus } from './evm-helpers';
import { RoundCues, type RoundCueSink } from '../src/game/roundCues';
import type { TicketGate, TicketModel } from '../src/wallet/ticket';
import { useUi } from '../src/store';
import { setReducedMotion } from '../src/test/media';
import { DeathSheet, GameHud, RoundChip, RoundCountdown, RoundOverSheet } from '../src/ui/game';
import { MobileControls } from '../src/ui/game/MobileControls';
import { NextRoundOpens } from '../src/ui/game/NextRoundOpens';
import { HeldBanner } from '../src/ui/lobby/HeldBanner';
import { QuickPlay } from '../src/ui/lobby/QuickPlay';
import { TicketList } from '../src/ui/lobby/TicketList';

const M = 1_000_000; // one whole token in ledger units (6 decimals of the 18-decimal token)
/** A round boundary: round N starts here (default 5-minute rounds). */
const N = 5_800_000;
const START = N * RULES.roundMs;
const R: RoundInfo = { n: N, endsAt: START + RULES.roundMs, joinsCloseAt: START + RULES.roundMs - RULES.roundJoinCloseMs };
const ARENA: RoomInfo = { id: 'arena-1-1', mode: 'arena', name: '$1 Room', width: 6400, height: 6400, players: 3, bots: 10, maxPlayers: 50, arenaId: 1, entryFee: 1000 * M, round: R };
const STATS: DeathStats = { aliveMs: 94_000, finalMass: 0, maxMass: 640, foodEaten: 88, cellsEaten: 1, playersEaten: 1, bestRank: 5 };
const CHAIN = chainStatus({ fees: null });
// jsdom has no canvas: the same null it returns, without the "not implemented" warning
HTMLCanvasElement.prototype.getContext = (() => null) as never;
const initial = useUi.getState();

/** Freezes `Date.now()` (the server clock, offset 0) at `at`; timers stay real. */
function clockAt(at: number) {
  vi.setSystemTime(at);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  serverClock.reset();
  useUi.setState({ chain: CHAIN, rooms: [ARENA] });
});
afterEach(() => {
  vi.useRealTimers();
  act(() => useUi.setState(initial, true));
});

describe('round math on the client', () => {
  it('derives the round length from RoundInfo and rolls past the bell with roundAt', () => {
    expect(roundLengths(R)).toEqual({ roundMs: 300_000, closeMs: 60_000, breakMs: 0 });
    // a server running 30 s rounds with a 5 s close (ROUND_SECONDS / ROUND_JOIN_CLOSE_SECONDS)
    const short = { n: 100, endsAt: 101 * 30_000, joinsCloseAt: 101 * 30_000 - 5_000 };
    expect(roundLengths(short)).toEqual({ roundMs: 30_000, closeMs: 5_000, breakMs: 0 });
    expect(roundStateAt(short, short.endsAt + 1)).toMatchObject({ n: 101, endsAt: 102 * 30_000, phase: 'open', msLeft: 29_999 });

    expect(roundStateAt(R, START + 108_000)).toMatchObject({ n: N, msLeft: 192_000, phase: 'open' });
    expect(roundStateAt(R, R.joinsCloseAt)).toMatchObject({ n: N, msLeft: 60_000, phase: 'closing' });
    // at the bell the next round is open (no intermission)
    const next = roundAt(R.endsAt);
    expect(roundStateAt(R, R.endsAt)).toEqual({ n: N + 1, endsAt: next.endsAt, joinsCloseAt: next.joinsCloseAt, opensAt: next.endsAt - RULES.roundMs, msLeft: RULES.roundMs, phase: 'open', breakMsLeft: 0 });
    // a server with a 15 s break after each bell: the next round opens to joins 15 s in
    const withBreak = { ...R, opensAt: R.endsAt - RULES.roundMs + 15_000 };
    expect(roundLengths(withBreak).breakMs).toBe(15_000);
    expect(roundStateAt(withBreak, R.endsAt + 1)).toMatchObject({ n: N + 1, opensAt: R.endsAt + 15_000 });
    // the 30 s break (RULES.roundBreakMs): the countdown to the open floor, then 0
    const thirty = { ...R, opensAt: R.endsAt - RULES.roundMs + RULES.roundBreakMs };
    expect(RULES.roundBreakMs).toBe(30_000);
    expect(roundStateAt(thirty, R.endsAt + 3_000)).toMatchObject({ n: N + 1, breakMsLeft: 27_000 });
    expect(formatCountdown(roundStateAt(thirty, R.endsAt + 3_000).breakMsLeft)).toBe('0:27');
    expect(roundStateAt(thirty, R.endsAt + 30_000).breakMsLeft).toBe(0);
    expect(formatCountdown(192_000)).toBe('3:12');
    expect(formatCountdown(41_200)).toBe('0:42');
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('takes the round from the room on screen, else its listing, else any arena', () => {
    const other: RoomInfo = { ...ARENA, id: 'arena-2-1', arenaId: 2, round: { ...R, n: N + 1 } };
    expect(roundInfoFor([ARENA, other], null, 2)?.n).toBe(N + 1);
    expect(roundInfoFor([ARENA], { ...ARENA, round: { ...R, n: 7 } }, 1)?.n).toBe(7);
    expect(roundInfoFor([ARENA], null, 9)?.n).toBe(N);
    expect(roundInfoFor([], null, 1)).toBeNull();
  });

  it('corrects clock skew with the server time of the fastest round trip', () => {
    let local = 1_000_000;
    const clock = new ServerClock(() => local);
    expect(clock.now()).toBe(local);
    clock.sync(1_005_000); // welcome: no round trip known
    expect(clock.offset).toBe(5_000);
    clock.sync(1_003_000, 200); // pong: +100 for the half trip
    expect(clock.offset).toBe(3_100);
    clock.sync(1_009_000, 900); // a slow trip does not win
    expect(clock.offset).toBe(3_100);
    local += 10_000;
    expect(clock.now()).toBe(1_013_100);
    expect(clock.toLocal(1_013_100)).toBe(local);
    // a bad round trip (negative, NaN) counts as unmeasured: no half-trip added, and it never wins
    const c2 = new ServerClock(() => 0);
    c2.sync(10_000, Number.NaN);
    expect(c2.offset).toBe(10_000);
    c2.sync(20_000, -5);
    expect(c2.offset).toBe(20_000);
  });
});

describe('a custom ticket room plays its own one game (no 5-minute bell)', () => {
  // a 45-minute room that opened 7 s into an arena round
  const OPEN = START + 7_000;
  const OWN: RoundInfo = { n: Math.floor(OPEN / 1000), startsAt: OPEN, endsAt: OPEN + 45 * 60_000, joinsCloseAt: OPEN + 44 * 60_000 };
  const PAID: RoomInfo = { ...ARENA, id: 'priv-AB2CD234', name: 'Whale Club', code: 'AB2CD234', round: OWN };

  it('its lengths are the room\'s: the whole game, joins closed in its last minute, no break; it never rolls into a next round', () => {
    expect(roundLengths(OWN)).toEqual({ roundMs: 45 * 60_000, closeMs: 60_000, breakMs: 0 });
    // past the arenas' bell: still the same game, open
    const mid = roundStateAt(OWN, R.endsAt + 1000);
    expect(mid).toMatchObject({ n: OWN.n, endsAt: OWN.endsAt, phase: 'open', breakMsLeft: 0 });
    expect(mid.msLeft).toBe(OWN.endsAt - R.endsAt - 1000);
    expect(roundStateAt(OWN, OWN.endsAt - 30_000)).toMatchObject({ phase: 'closing', msLeft: 30_000 });
    // over: it stays over (no next round to roll into)
    expect(roundStateAt(OWN, OWN.endsAt + 120_000)).toMatchObject({ n: OWN.n, endsAt: OWN.endsAt, msLeft: 0, phase: 'closing' });
    expect(roundStartLabel(OWN.n, OWN)).toBe(new Date(OPEN).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  });

  it('the HUD timer counts down to the room end (its own duration), not to the arenas\' bell', () => {
    useUi.setState({ screen: 'playing', room: PAID });
    clockAt(START + 108_000);
    render(
      <Kb>
        <RoundChip />
      </Kb>,
    );
    const chip = screen.getByRole('timer');
    expect(chip.textContent).toBe('43:19until the room ends');
    expect(chip.dataset.phase).toBe('open');
  });
});

describe('round sound cues', () => {
  function cues() {
    const calls: string[] = [];
    const sink: RoundCueSink = { tick: (s) => calls.push(`tick ${s}`), bell: (n) => calls.push(`bell ${n}`), say: (l) => calls.push(l) };
    return { c: new RoundCues(sink), calls };
  }
  const at = (ms: number) => roundStateAt(R, ms);

  it('one minute, ten seconds, a tick each of the last ten seconds, then the bell once', () => {
    const { c, calls } = cues();
    for (let t = R.endsAt - 62_000; t <= R.endsAt + 500; t += 250) c.update(at(t));
    expect(calls).toEqual(['oneMinute', 'tenSeconds', 'tick 10', 'tick 9', 'tick 8', 'tick 7', 'tick 6', 'tick 5', 'tick 4', 'countdown', 'tick 3', 'tick 2', 'tick 1', `bell ${N}`, 'roundOver']);
    // the server's roundOver for the same round does not ring it again
    c.ring(N);
    expect(calls.filter((x) => x.startsWith('bell'))).toHaveLength(1);
  });

  it('stays quiet after a jump (hidden tab) and outside arenas', () => {
    const { c, calls } = cues();
    c.update(at(R.endsAt - 120_000));
    c.update(at(R.endsAt - 5_000)); // jumped over the minute and the ten seconds
    c.update(null);
    c.update(at(R.endsAt + 3_000)); // a fresh start after the bell
    expect(calls).toEqual([]);
  });
});

describe('HUD round chip', () => {
  const renderChip = () =>
    render(
      <Kb>
        <RoundChip />
        <RoundCountdown />
      </Kb>,
    );
  beforeEach(() => useUi.setState({ screen: 'playing', room: ARENA }));

  it('open: m:ss to the bell', () => {
    clockAt(START + 108_000);
    renderChip();
    const chip = screen.getByRole('timer', { name: 'Round ends in 3:12' });
    expect(chip.dataset.phase).toBe('open');
    expect(chip.textContent).toBe('3:12until the bell');
    expect(screen.queryByTestId('round-count')).toBeNull();
  });

  it('final minute: joins closed, the chip says so', () => {
    clockAt(R.endsAt - 42_000);
    renderChip();
    const chip = screen.getByRole('timer', { name: 'Final minute: 0:42 left' });
    expect(chip.className).toContain('is-closing');
    expect(chip.textContent).toBe('0:42Final minute');
    expect(screen.queryByTestId('round-count')).toBeNull();
  });

  it('last 10 s: a big countdown', () => {
    clockAt(R.endsAt - 6_500);
    renderChip();
    expect(screen.getByTestId('round-count').textContent).toBe('7');
    expect(screen.getByRole('timer').textContent).toBe('0:07Final minute');
  });

  it('is not shown outside arenas', () => {
    useUi.setState({ room: { ...ARENA, id: 'practice-rookie-1', mode: 'practice', arenaId: undefined, round: undefined } });
    clockAt(START + 1000);
    renderChip();
    expect(screen.queryByRole('timer')).toBeNull();
  });
});

describe('no cash-out in arenas', () => {
  it('the HUD dock, the phone controls and the C key have no cash-out', () => {
    useUi.setState({ screen: 'playing', room: ARENA, ticket: { entryFee: 1000 * M, arenaId: 1, session: 'S' }, hud: { mass: 20, cells: 1, value: 1000 * M, rank: 2, players: 4 } });
    clockAt(START + 1000);
    render(
      <Kb>
        <GameHud />
        <MobileControls />
      </Kb>,
    );
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cash/i })).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/cash/i);
    // phones get the chat button in every room now
    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy();

    const actions = { split: vi.fn(), eject: vi.fn(), emote: vi.fn(), openChat: vi.fn(), escape: vi.fn(), spectateNext: vi.fn(), steering: vi.fn(() => true) };
    const input = new Input(document.createElement('div'), actions, () => {}, () => {});
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', key: 'c' }));
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
    input.destroy();
  });
});

describe('Round over sheet', () => {
  const standings: RoundStanding[] = [
    { rank: 1, name: 'Nakamoto', value: 9100 * M, mass: 4200, kills: 6 },
    { rank: 2, name: 'Penny', value: 5200 * M, mass: 2600, kills: 3 },
    { rank: 3, name: 'Daphne', value: 3000 * M, mass: 1800, kills: 2, you: true },
    { rank: 4, name: 'Rocky', value: 2100 * M, mass: 900, kills: 1 },
    { rank: 5, name: 'Lulu', value: 1500 * M, mass: 700, kills: 0 },
    { rank: 6, name: 'Sixth', value: 900 * M, mass: 300, kills: 0 },
  ];

  it('arena v3: the till, the fee on its profit and what is paid; then the settlement\'s own numbers', () => {
    setReducedMotion(true);
    clockAt(R.endsAt + 500);
    useUi.setState({
      screen: 'roundover',
      room: ARENA,
      ticket: { entryFee: 1000 * M, arenaId: 1, session: 'SessV3' },
      // a 3,500 till on a 1,000 ticket: 2,500 profit, 20 % of it (500) is the fee, 3,000 is paid
      roundResult: { kind: 'round', round: N, payout: 3000 * M, stats: { ...STATS, gross: 3500 * M, cut: 500 * M }, standings },
      lastSettlement: null,
    });
    render(
      <Kb>
        <RoundOverSheet />
      </Kb>,
    );
    expect(screen.getByText('3,500')).toBeTruthy();
    expect(screen.getByText('Fee 20% of profit')).toBeTruthy();
    expect(screen.getByText('≈ −500')).toBeTruthy();
    expect(document.querySelector('.g-receipt__net')?.textContent).toBe('≈ 3,000$ELYMUM');
    expect(screen.getByText('20% of your profit is the fee (15% burned, 5% to the fee wallet); no profit, no fee')).toBeTruthy();
    act(() =>
      useUi.setState({ lastSettlement: { session: 'SessV3', arenaId: 1, txHash: `0x${'5b'.repeat(32)}`, payout: 3500 * M, fee: 500 * M, burned: 375 * M, toVault: 125 * M, net: 3000 * M, at: Date.now() } }),
    );
    expect(screen.getByText('−500')).toBeTruthy();
    expect(document.querySelector('.g-receipt__net')?.textContent).toBe('3,000$ELYMUM');
  });

  it('prints till, fee and paid; my place and the top 5; then the PAID transaction', () => {
    setReducedMotion(true);
    clockAt(R.endsAt + 500);
    useUi.setState({
      screen: 'roundover',
      room: ARENA,
      ticket: { entryFee: 1000 * M, arenaId: 1, session: 'SessMine' },
      roundResult: { kind: 'round', round: N, payout: 2600 * M, stats: { ...STATS, gross: 3000 * M, cut: 400 * M }, standings },
      lastSettlement: null,
    });
    render(
      <Kb>
        <RoundOverSheet />
      </Kb>,
    );
    expect(screen.getByRole('dialog', { name: 'Round over' })).toBeTruthy();
    // the round is named by its start time, not by its index since 1970
    expect(screen.getByText(`ELYMUM · ${roundStartLabel(N, R)} ROUND`)).toBeTruthy();
    expect(roundStartLabel(N, R)).toMatch(/^\d\d:\d\d$/);
    expect(document.body.textContent).not.toContain(String(N));
    expect(screen.getByText('Your till')).toBeTruthy();
    expect(screen.getAllByText('3,000').length).toBeGreaterThan(0);
    expect(screen.getByText('Fee 20% of profit')).toBeTruthy();
    expect(screen.getByText('≈ −400')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(document.querySelector('.g-receipt__net')?.textContent).toBe('≈ 2,600$ELYMUM');
    expect(screen.getByRole('status').textContent).toContain('Settling on Robinhood Chain Testnet');
    // my place and the room's whole board at the bell (scrolling, my row highlighted and pinned)
    expect(screen.getByText('Your place').nextElementSibling?.textContent).toBe('3rd');
    const top = screen.getByRole('region', { name: 'Final standings · 6 at the bell' });
    const rows = [...top.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['01Nakamoto4,20069.1K', '02Penny2,60035.2K', '03DaphneYou1,80023K', '04Rocky90012.1K', '05Lulu70001.5K', '06Sixth3000900']);
    // the same board as a custom room's end: rank, name, mass and kills next to the payout
    expect(top.querySelector('.g-board__head')?.textContent).toBe('#PlayerMassKillsPayout');
    expect(top.querySelector('.is-me')?.textContent).toContain('Daphne');
    expect(top.querySelector('.is-me')?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: /Next round/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Lobby/ })).toBeTruthy();

    act(() => useUi.setState({ lastSettlement: { session: 'SessMine', arenaId: 1, txHash: `0x${'5a'.repeat(32)}`, payout: 3000 * M, fee: 400 * M, net: 2600 * M, at: Date.now() } }));
    expect(screen.getByText('−400')).toBeTruthy();
    expect(screen.getByRole('link', { name: /View transaction/ })).toBeTruthy();
  });

  it('outside the top 10 says so; the sheet waits for the bell without reduced motion', async () => {
    clockAt(R.endsAt + 500);
    useUi.setState({
      screen: 'roundover',
      room: ARENA,
      ticket: { entryFee: 1000 * M, arenaId: 1, session: 'S2' },
      roundResult: { kind: 'round', round: N, payout: 400 * M, stats: STATS, standings: standings.map(({ you: _you, ...s }) => s) },
    });
    render(
      <Kb>
        <RoundOverSheet />
      </Kb>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await screen.findByRole('dialog', { name: 'Round over' }, { timeout: 2000 });
    expect(screen.getByText('Your place').nextElementSibling?.textContent).toBe('Outside the top 6');
    // a loss pays no fee (the rate shown is the contract default while the server's is unknown)
    expect(screen.getByText('Fee 20% of profit')).toBeTruthy();
    expect(document.querySelector('.g-receipt__net')?.textContent).toBe('≈ 400$ELYMUM');
  });

  it("estimates the fee at the server's live rates, and at the ticket's own rates once its session is read", () => {
    setReducedMotion(true);
    clockAt(R.endsAt + 500);
    useUi.setState({ chain: { ...CHAIN, fees: { ...chainStatus().fees!, burnBps: 1000, vaultBps: 200 } } });
    useUi.setState({
      screen: 'roundover',
      room: ARENA,
      ticket: { entryFee: 1000 * M, arenaId: 1, session: 'S3' },
      roundResult: { kind: 'round', round: N, payout: 2760 * M, stats: { ...STATS, gross: 3000 * M, cut: 240 * M }, standings: [] },
    });
    render(
      <Kb>
        <RoundOverSheet />
      </Kb>,
    );
    expect(screen.getByText('Fee 12% of profit')).toBeTruthy();
    expect(screen.getByText('≈ −240')).toBeTruthy();
    // the rates fixed into the ticket at join win over the live ones
    act(() =>
      useChainData.setState({
        sessions: { 1: { arenaId: 1, player: '0x1111111111111111111111111111111111111111', id: 9n, entryFee: 10n ** 21n, openedAt: 1, burnBps: 500, vaultBps: 0, finalized: false, owed: 0n } },
      }),
    );
    expect(screen.getByText('Fee 5% of profit')).toBeTruthy();
    expect(screen.getByText('≈ −100')).toBeTruthy();
    useChainData.setState({ sessions: {} });
  });
});

describe('death sheet in an arena', () => {
  const eaten = () => {
    setReducedMotion(true);
    useUi.setState({ screen: 'dead', room: ARENA, ticket: { entryFee: 1000 * M, arenaId: 1, session: 'S' }, death: { stats: { ...STATS, valueLost: 10 * M }, killer: 'Nakamoto', killerSkin: 1 } });
    render(
      <Kb>
        <DeathSheet />
      </Kb>,
    );
  };

  it('"Start over" with the new ticket fee while joins are open', () => {
    clockAt(START + 30_000);
    eaten();
    const cta = screen.getByRole('button', { name: /^Start over/ });
    expect(cta.textContent).toContain('New ticket · 1K $ELYMUM');
    expect(screen.queryByText(/next round in/)).toBeNull();
  });

  it('"Start over" says when the next round opens in the final minute', () => {
    clockAt(R.endsAt - 42_000);
    eaten();
    const cta = screen.getByRole('button', { name: /^Start over/ });
    expect(cta.textContent).toContain('New ticket · next round in 0:42');
    expect(screen.queryByText(/1K \$ELYMUM/)).toBeNull();
  });

  it('"Start over" opens this arena\'s ticket flow from the lobby', () => {
    clockAt(START + 30_000);
    eaten();
    fireEvent.click(screen.getByRole('button', { name: /^Start over/ }));
    expect(useUi.getState().lobbyIntent).toMatchObject({ ticket: 'arena:1', open: true });
  });
});

describe('lobby tickets and the held ticket', () => {
  const practice: TicketModel = { key: 'practice', arenaId: null, entryFee: 0n, humans: 0, bots: 0, loot: 0, open: true };
  const penny: TicketModel = { key: 'arena:1', arenaId: 1, entryFee: 1000n * 10n ** 18n, humans: 3, bots: 10, loot: 0, open: true };
  const list = () =>
    render(
      <Kb>
        <TicketList tickets={[practice, penny]} gates={{ practice: { kind: 'practice' }, 'arena:1': { kind: 'buy' } }} openTickets={[]} value="practice" onChange={() => {}} onActivate={() => {}} />
      </Kb>,
    );

  it('arena rows say when the round ends', () => {
    clockAt(START + 108_000);
    list();
    expect(screen.getByText('Round ends in 3:12')).toBeTruthy();
    expect(screen.getAllByText(/Round ends in|Joins closed/)).toHaveLength(1); // not on practice
  });

  it('in the final minute: joins closed and when the next round opens', () => {
    clockAt(R.endsAt - 42_000);
    list();
    const line = screen.getByText('Joins closed · next round in 0:42');
    expect(line.className).toContain('is-closed');
  });

  it('a held ticket is flagged on its row, in a banner and on the button', () => {
    clockAt(R.endsAt - 41_000);
    useUi.setState({ held: { arenaId: 1, opensAt: R.endsAt } });
    list();
    expect(screen.getByText('Ticket held')).toBeTruthy();
    render(
      <Kb>
        <HeldBanner />
        <QuickPlay ticket={penny} gate={{ kind: 'resume' } as TicketGate} onPress={() => {}} />
      </Kb>,
    );
    expect(screen.getByText('Ticket held — next round in 0:41')).toBeTruthy();
    const cta = screen.getByRole('button', { name: /^Ticket held/ });
    expect(cta.textContent).toContain('Next round in 0:41');
    expect((cta as HTMLButtonElement).disabled).toBe(true);
  });

  it('a held ticket joins by itself when the round opens, within the jitter after the bell', () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(R.endsAt - 41_000);
    const join = vi.fn(() => true);
    let free = true;
    const released = vi.fn();
    const held = new HeldTicket({ join, free: () => free, released });
    held.hold('arena:1', R.endsAt);
    expect(useUi.getState().held).toEqual({ arenaId: 1, opensAt: R.endsAt });
    vi.advanceTimersByTime(40_999);
    expect(join).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1 + HELD_JITTER_MS);
    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith('arena:1');
    expect(held.inFlight).toBe(true);
    // refused for another reason: let go
    held.refused();
    expect(useUi.getState().held).toBeNull();

    // cleared before the opening: no join
    held.hold('arena:1', Date.now() + 5_000);
    held.clear();
    vi.advanceTimersByTime(10_000);
    // busy in a game at the opening: no join, released with a reason
    held.hold('arena:1', Date.now() + 5_000);
    free = false;
    vi.advanceTimersByTime(10_000);
    expect(join).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledWith('busy');
    expect(useUi.getState().held).toBeNull();
  });

  it('spreads held tickets over the jitter window', () => {
    const waits: number[] = [];
    for (const random of [0, 0.5, 0.999]) {
      const h = new HeldTicket(
        { join: () => true, free: () => true, released: () => {} },
        { toLocal: (ms) => ms, now: () => 1_000, random: () => random, setTimeout: (_fn, ms) => waits.push(ms), clearTimeout: () => {} },
      );
      h.hold('arena:2', 11_000);
    }
    expect(HELD_JITTER_MS).toBe(1500);
    expect(waits[0]).toBe(10_000);
    expect(waits[1]).toBe(10_750);
    expect(waits[2]).toBeGreaterThan(11_490);
    expect(waits[2]).toBeLessThan(11_500);
  });
});

describe('the break after the bell', () => {
  afterEach(() => vi.useRealTimers());
  it('shows "Next round opens in 0:27" during the break, nothing once the floor is open', () => {
    // the default schedule: slots of 5:30 (the 30 s break, then 5:00 of play)
    const cycle = RULES.roundMs + RULES.roundBreakMs;
    const n = 5_900_000;
    const bell = n * cycle; // the previous round's bell: this slot starts with the break
    const info: RoundInfo = { n, endsAt: bell + cycle, joinsCloseAt: bell + cycle - RULES.roundJoinCloseMs, opensAt: bell + RULES.roundBreakMs };
    const room: RoomInfo = { id: 'arena-1-1', mode: 'arena', arenaId: 1, name: 'A', players: 1, maxPlayers: 50, round: info } as RoomInfo;
    vi.useFakeTimers();
    vi.setSystemTime(bell + 3_000);
    serverClock.reset?.();
    act(() => useUi.setState({ rooms: [room], room: null }));
    const v = render(
      <Kb>
        <NextRoundOpens arenaId={1} />
      </Kb>,
    );
    expect(screen.getByTestId('next-round-opens').textContent).toBe('Next round opens in 0:27');
    act(() => vi.advanceTimersByTime(27_100));
    expect(screen.queryByTestId('next-round-opens')).toBeNull();
    v.unmount();
  });
});

describe('the default schedule: 5:00 of play, then the 30 s break (a 5:30 cycle)', () => {
  const CYCLE = 330_000;
  const N5 = 5_437_047; // the slot holding 2026-11-09T12:00:00Z
  const SLOT = N5 * CYCLE; // 11:58:30 UTC: the previous bell, the break starts
  const OPENS = SLOT + 30_000; // 11:59:00: play starts, joins open
  const CLOSES = SLOT + 270_000; // 12:03:00: joins close (the last minute)
  const BELL = SLOT + CYCLE; // 12:04:00: the bell, the next break starts
  const INFO: RoundInfo = { n: N5, endsAt: BELL, joinsCloseAt: CLOSES, opensAt: OPENS };

  it('derives 5:00 of play, a 1:00 close and a 30 s break from what the server sends', () => {
    expect(RULES.roundMs + RULES.roundBreakMs).toBe(CYCLE);
    expect(roundLengths(INFO)).toEqual({ roundMs: 300_000, closeMs: 60_000, breakMs: 30_000 });
    expect(roundStartLabel(N5, INFO)).toBe(new Date(OPENS).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  });

  it('every phase of the slot, boundaries included', () => {
    // the break: "Next round opens in", the bell is the full play plus the rest of the break away
    expect(roundStateAt(INFO, SLOT)).toMatchObject({ n: N5, breakMsLeft: 30_000, msLeft: 330_000, phase: 'open' });
    expect(roundStateAt(INFO, OPENS - 1)).toMatchObject({ n: N5, breakMsLeft: 1, phase: 'open' });
    // play: "Until the bell" starts at the full 5:00
    expect(roundStateAt(INFO, OPENS)).toMatchObject({ n: N5, breakMsLeft: 0, msLeft: 300_000, phase: 'open' });
    expect(formatCountdown(roundStateAt(INFO, OPENS).msLeft)).toBe('5:00');
    expect(roundStateAt(INFO, CLOSES - 1)).toMatchObject({ phase: 'open', msLeft: 60_001 });
    expect(roundStateAt(INFO, CLOSES)).toMatchObject({ phase: 'closing', msLeft: 60_000 });
    expect(roundStateAt(INFO, BELL - 10_000)).toMatchObject({ phase: 'closing', msLeft: 10_000 });
    expect(roundStateAt(INFO, BELL - 1)).toMatchObject({ n: N5, msLeft: 1 });
    // the bell: the next slot, which starts with its break
    expect(roundStateAt(INFO, BELL)).toEqual({ n: N5 + 1, endsAt: BELL + CYCLE, joinsCloseAt: CLOSES + CYCLE, opensAt: OPENS + CYCLE, msLeft: CYCLE, phase: 'open', breakMsLeft: 30_000 });
    // rolled forward several rounds without a new listing
    expect(roundStateAt(INFO, BELL + 2 * CYCLE + 45_000)).toMatchObject({ n: N5 + 3, breakMsLeft: 0, msLeft: CYCLE - 45_000 });
    // the same windows as the server's clock
    for (const t of [SLOT, OPENS, CLOSES, BELL - 1, BELL, BELL + 31_000]) {
      const w = roundAt(t, RULES.roundMs, RULES.roundJoinCloseMs, RULES.roundBreakMs);
      expect(roundStateAt(INFO, t)).toMatchObject({ n: w.n, endsAt: w.endsAt, joinsCloseAt: w.joinsCloseAt, opensAt: w.opensAt });
    }
  });

  it('the HUD chip: 5:00 until the bell when play starts, the final minute, the last ten seconds', () => {
    const room: RoomInfo = { ...ARENA, round: INFO };
    useUi.setState({ screen: 'playing', room, rooms: [room] });
    const renderChip = () =>
      render(
        <Kb>
          <RoundChip />
          <RoundCountdown />
        </Kb>,
      );
    clockAt(OPENS);
    let v = renderChip();
    expect(screen.getByRole('timer', { name: 'Round ends in 5:00' }).dataset.phase).toBe('open');
    v.unmount();
    clockAt(CLOSES);
    v = renderChip();
    expect(screen.getByRole('timer', { name: 'Final minute: 1:00 left' })).toBeTruthy();
    v.unmount();
    clockAt(BELL - 9_500);
    v = renderChip();
    expect(screen.getByTestId('round-count').textContent).toBe('10');
    v.unmount();
  });

  it('an older server whose break sat inside the slot still counts down right', () => {
    // 5-minute slots with the floor opening 30 s in (the schedule before the break moved out of the play)
    const n = 5_970_000;
    const old: RoundInfo = { n, endsAt: (n + 1) * 300_000, joinsCloseAt: (n + 1) * 300_000 - 60_000, opensAt: n * 300_000 + 30_000 };
    expect(roundLengths(old)).toEqual({ roundMs: 270_000, closeMs: 60_000, breakMs: 30_000 });
    expect(roundStateAt(old, old.endsAt + 1_000)).toMatchObject({ n: n + 1, opensAt: old.endsAt + 30_000, endsAt: old.endsAt + 300_000, breakMsLeft: 29_000 });
  });
});
