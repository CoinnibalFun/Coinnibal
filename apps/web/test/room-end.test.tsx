import type { RoomInfo, RoundStanding } from '@elymum/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { serverClock } from '../src/game/clock';
import { useUi } from '../src/store';
import { setReducedMotion } from '../src/test/media';
import { RoomClosingNotice, RoomOverSheet, RoundCountdown } from '../src/ui/game';
import { KillShare, KILL_SHARE_MS, SHARE_COIN, shareUrl } from '../src/ui/game/ShareOnX';
import { boardPlace } from '../src/ui/game/FinalBoard';

HTMLCanvasElement.prototype.getContext = (() => null) as never;
const initial = useUi.getState();
const T0 = 1_800_000_000_000;
const ROOM: RoomInfo = {
  id: 'priv-PONDS',
  mode: 'private',
  name: 'Friday Pond',
  code: 'PONDS',
  width: 6000,
  height: 6000,
  players: 3,
  bots: 2,
  maxPlayers: 20,
  custom: { durationMin: 30, mapSize: 'auto', bots: 2, difficulty: 'easy', food: 'normal', traps: 'normal', powerUps: true, kind: 'free', creator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', createdAt: T0 - 1_790_000, endsAt: T0 + 60_000 },
};
const BOARD: RoundStanding[] = [
  { rank: 1, name: 'Nakamoto', mass: 4200, kills: 7 },
  { rank: 2, name: 'Bot 1', mass: 2600, kills: 2, isBot: true },
  { rank: 3, name: 'Daphne', mass: 1800, kills: 1, you: true },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  serverClock.reset();
  setReducedMotion(true);
});
afterEach(() => {
  vi.useRealTimers();
  act(() => useUi.setState(initial, true));
});

describe('a custom room ends: countdown, then the final board', () => {
  it('shows the countdown only in the last ten seconds, with the reason, and drops the big numerals', () => {
    useUi.setState({ screen: 'playing', room: ROOM, closing: null });
    const { rerender } = render(
      <Kb>
        <RoomClosingNotice />
        <RoundCountdown />
      </Kb>,
    );
    expect(screen.queryByTestId('room-closing')).toBeNull();
    // the creator closes it: the server names the new end
    act(() => useUi.setState({ closing: { endsAt: T0 + 7_200, message: 'The room creator closed this room.' } }));
    rerender(
      <Kb>
        <RoomClosingNotice />
        <RoundCountdown />
      </Kb>,
    );
    const notice = screen.getByTestId('room-closing');
    expect(notice.textContent).toContain('This room closes in 8 s');
    expect(notice.textContent).toContain('The room creator closed this room.');
    expect(screen.getByTestId('round-count').textContent).toBe('8');
  });

  it('a room whose time runs out counts down by itself from its scheduled end', () => {
    vi.setSystemTime(T0 + 55_000);
    useUi.setState({ screen: 'playing', room: ROOM, closing: null });
    render(
      <Kb>
        <RoomClosingNotice />
      </Kb>,
    );
    expect(screen.getByTestId('room-closing').textContent).toContain('This room closes in 5 s');
  });

  it('the final board: everyone by mass with kills (bots tagged), my place, the reason and the way back', () => {
    useUi.setState({ screen: 'roomover', room: null, roomResult: { message: 'Time is up: this room has closed. Thanks for playing!', players: 2, standings: BOARD, stats: null, room: ROOM } });
    render(
      <Kb>
        <RoomOverSheet />
      </Kb>,
    );
    const sheet = screen.getByRole('dialog', { name: 'Final standings' });
    expect(sheet.textContent).toContain('Room over · ');
    expect(sheet.textContent).toContain('Time is up');
    expect(screen.getByText('Your place').nextElementSibling?.textContent).toBe('3rd');
    const rows = [...sheet.querySelectorAll('.g-board__list li')].map((li) => li.textContent);
    expect(rows).toEqual(['01Nakamoto4,2007', '02Bot 1BOT2,6002', '03DaphneYou1,8001']);
    // no value column outside arenas
    expect(sheet.querySelector('.g-board__head')?.textContent).toBe('#PlayerMassKills');
    expect(sheet.textContent).toContain('2 players at the end');
    expect(sheet.textContent).toMatch(/Back to the lobby in \d+ s/);
    expect(screen.getByRole('button', { name: /Lobby/ })).toBeTruthy();
  });

  it('my place: my rank when my row is on the board, else outside the top n', () => {
    expect(boardPlace(BOARD, (n) => `out ${n}`)).toBe('3rd');
    expect(boardPlace([{ ...BOARD[0] }, { rank: 14, name: 'Me', mass: 10, kills: 0, you: true }], (n) => `out ${n}`)).toBe('14th');
    expect(boardPlace(BOARD.map(({ you: _y, ...r }) => r), (n) => `out ${n}`)).toBe('out 3');
    expect(boardPlace([], (n) => `out ${n}`)).toBe('—');
  });

  it('Share on X: the final board links X\'s composer to my card once the server made it', () => {
    const stats = { aliveMs: 1, finalMass: 1800, maxMass: 1800, foodEaten: 1, cellsEaten: 0, playersEaten: 1, bestRank: 3, finalRank: 3, finalOf: 3 };
    useUi.setState({ screen: 'roomover', roomResult: { message: 'Time is up.', players: 2, standings: BOARD, stats, room: ROOM }, share: null });
    const { rerender } = render(
      <Kb>
        <RoomOverSheet />
      </Kb>,
    );
    expect(screen.queryByTestId('share-x')).toBeNull();
    act(() => useUi.setState({ share: { kind: 'room', id: 'AbCdE12345', at: Date.now() } }));
    rerender(
      <Kb>
        <RoomOverSheet />
      </Kb>,
    );
    const link = screen.getByTestId('share-x') as HTMLAnchorElement;
    expect(link.textContent).toContain('Share on X');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    const url = new URL(link.href);
    expect(url.origin + url.pathname).toBe('https://x.com/intent/post');
    expect(url.searchParams.get('text')).toBe(`I finished #3 of 3 in Friday Pond on Elymum! ${SHARE_COIN}`);
    expect(url.searchParams.get('url')).toBe(shareUrl('AbCdE12345'));
    expect(shareUrl('AbCdE12345')).toMatch(/\/share\/AbCdE12345$/);
  });

  it('a notable kill shows "You ate ..." with Share on X for a few seconds', () => {
    useUi.setState({ screen: 'playing', share: { kind: 'kill', id: 'KiLL123456', victim: 'Nakamoto', at: Date.now() } });
    render(
      <Kb>
        <KillShare />
      </Kb>,
    );
    const sticker = screen.getByTestId('kill-share');
    expect(sticker.textContent).toContain('You ate Nakamoto!');
    expect(new URL((screen.getByTestId('share-x') as HTMLAnchorElement).href).searchParams.get('text')).toBe(`I just ate Nakamoto on Elymum! ${SHARE_COIN}`);
    expect(KILL_SHARE_MS).toBeGreaterThanOrEqual(5000);
  });
});
