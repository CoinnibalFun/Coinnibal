import { RULES, type DeathStats, type RoomInfo, type RoundInfo, type RoundStanding } from '@elymum/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { serverClock } from '../src/game/clock';
import { translate } from '../src/i18n';
import { updateSettings, useUi } from '../src/store';
import { setReducedMotion } from '../src/test/media';
import { RoundOverSheet } from '../src/ui/game';
import { KillShare, SHARE_COIN, SHARE_VARIANTS, killShareText, resultShareText } from '../src/ui/game/ShareOnX';
import { SettingsPage } from '../src/ui/profile/SettingsPage';
import { chainStatus } from './evm-helpers';

HTMLCanvasElement.prototype.getContext = (() => null) as never;
const initial = useUi.getState();
const M = 1_000_000;
const N = 5_800_000;
const START = N * RULES.roundMs;
const R: RoundInfo = { n: N, endsAt: START + RULES.roundMs, joinsCloseAt: START + RULES.roundMs - RULES.roundJoinCloseMs };
const ARENA: RoomInfo = { id: 'arena-1-1', mode: 'arena', name: '$1 Room', width: 6400, height: 6400, players: 3, bots: 0, maxPlayers: 50, arenaId: 1, entryFee: 1000 * M, round: R };
const TEST_ARENA: RoomInfo = { ...ARENA, id: 'test-1', test: true, bots: 6 };
const STANDINGS: RoundStanding[] = [
  { rank: 1, name: 'Daphne', value: 3000 * M, mass: 1800, kills: 6, you: true },
  { rank: 2, name: 'Penny', value: 900 * M, mass: 600, kills: 1 },
];
const STATS: DeathStats = {
  aliveMs: 94_000,
  finalMass: 1800,
  maxMass: 2000,
  foodEaten: 88,
  cellsEaten: 9,
  playersEaten: 8,
  bestRank: 1,
  finalRank: 1,
  finalOf: 2,
  eaten: [{ name: 'Penny', n: 2 }, { name: '@Rocky.com' }, { name: 'Lulu' }, { name: 'Zed' }, { name: 'Ed' }],
  eatenMore: 2,
};
const t = (k: Parameters<typeof translate>[0], v?: Record<string, string | number>) => translate(k, v);

const textOf = (el: HTMLElement) => new URL((el as HTMLAnchorElement).href).searchParams.get('text');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(R.endsAt + 500);
  serverClock.reset();
  setReducedMotion(true);
  useUi.setState({ chain: chainStatus({ fees: null }), rooms: [ARENA, TEST_ARENA] });
});
afterEach(() => {
  vi.useRealTimers();
  act(() => useUi.setState(initial, true));
  localStorage.clear();
});

function sheet(room: RoomInfo, stats: DeathStats, share: { test?: boolean } | null) {
  useUi.setState({
    screen: 'roundover',
    room,
    ticket: { entryFee: 1000 * M, arenaId: 1, session: 'S1' },
    roundResult: { kind: 'round', round: N, payout: 3000 * M, stats, standings: STANDINGS },
    lastSettlement: null,
    share: share ? { kind: 'round', id: 'AbCdE12345', at: Date.now(), ...share } : null,
  });
  return render(
    <Kb>
      <RoundOverSheet />
    </Kb>,
  );
}

describe('who I ate, on the round-over sheet and in the X post', () => {
  it('lists the eaten coins (×2, "+N more", names cleaned) next to the receipt, with Share on X', () => {
    sheet(ARENA, STATS, {});
    const eaten = screen.getByTestId('eaten');
    expect(eaten.textContent).toContain('You ate');
    const chips = [...eaten.querySelectorAll('li')].map((li) => li.textContent);
    expect(chips).toEqual(['Penny×2', 'Rocky·com', 'Lulu', 'Zed', 'Ed', '+2 more']);
    // the list sits in the sheet body with the receipt, the button in its footer
    expect(eaten.closest('.g-roundover__body')).toBeTruthy();
    const link = screen.getByTestId('share-x');
    const names = 'Penny ×2, Rocky·com, Lulu, Zed, Ed +2';
    expect(textOf(link)).toBe(`${resultShareText(t, { rank: 1, n: 2, room: '$1 Room', eaten: STATS.eaten, eatenMore: STATS.eatenMore })} ${SHARE_COIN}`);
    expect(SHARE_VARIANTS.resultAte.map((k) => `${t(k, { rank: 1, n: 2, room: '$1 Room', names })} ${SHARE_COIN}`)).toContain(textOf(link));
    expect(textOf(link)).not.toMatch(/@|\.com|TEST/);
  });

  it('a test arena: bots tagged BOT on the sheet and in the post, which says TEST (testnet test room)', () => {
    sheet(TEST_ARENA, { ...STATS, eaten: [{ name: 'Botty', bot: true }], eatenMore: 0 }, { test: true });
    const chip = screen.getByTestId('eaten').querySelector('li')!;
    expect(chip.textContent).toBe('BottyBOT');
    expect(chip.querySelector('.g-eaten__tag')?.textContent).toBe('BOT');
    const text = textOf(screen.getByTestId('share-x'))!;
    expect(text).toContain('Botty (BOT)');
    expect(SHARE_VARIANTS.resultAte.some((k) => text.startsWith(t(k, { rank: 1, n: 2, room: '$1 Room', names: 'Botty (BOT)' })))).toBe(true);
    expect(text).toContain('(TEST: testnet test room, no real money)');
  });

  it('ate nobody: no list, the plain post', () => {
    sheet(ARENA, { ...STATS, eaten: undefined, eatenMore: undefined }, {});
    expect(screen.queryByTestId('eaten')).toBeNull();
    expect(textOf(screen.getByTestId('share-x'))).toBe(`${resultShareText(t, { rank: 1, n: 2, room: '$1 Room' })} ${SHARE_COIN}`);
    const plain = resultShareText(t, { rank: 3, n: 9, room: 'Pond', test: true });
    expect(SHARE_VARIANTS.result.map((k) => `${t(k, { rank: 3, n: 9, room: 'Pond' })} (TEST: testnet test room, no real money)`)).toContain(plain);
  });

  it('a test arena kill of a big bot: the sticker says BOT and TEST', () => {
    useUi.setState({ screen: 'playing', share: { kind: 'kill', id: 'KiLL123456', victim: 'Botty', victimIsBot: true, test: true, at: Date.now() } });
    render(
      <Kb>
        <KillShare />
      </Kb>,
    );
    const sticker = screen.getByTestId('kill-share');
    expect(sticker.textContent).toContain('You ate Botty (BOT)!');
    expect(sticker.querySelector('.g-test-tag')?.textContent).toBe('TEST');
    // its post (from the end sheet's moments) says BOT and TEST
    const post = killShareText(t, useUi.getState().share!);
    expect(SHARE_VARIANTS.kill.map((k) => `${t(k, { name: 'Botty (BOT)' })} (TEST: testnet test room, no real money)`)).toContain(post);
  });
});

describe("the others' stickers setting", () => {
  it('is on by default, has its own switch next to Chat, and is saved with the settings', () => {
    expect(useUi.getState().settings.showEmotes).toBe(true);
    render(
      <Kb>
        <SettingsPage />
      </Kb>,
    );
    const sw = screen.getByRole('switch', { name: "Others' stickers" });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    // a separate switch from the chat one
    expect(screen.getByRole('switch', { name: 'Chat' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(useUi.getState().settings.showEmotes).toBe(false);
    expect(useUi.getState().settings.showChat).toBe(true);
    expect(JSON.parse(localStorage.getItem('elymum.settings.v1')!).showEmotes).toBe(false);
    act(() => updateSettings({ showEmotes: true }));
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });
});
