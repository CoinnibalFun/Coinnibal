import { EMOTES, EMOTE_BAR, emoteEmoji, emoteForSlot, type DeathStats, type RoomInfo } from '@coinnibal/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainStatus } from './evm-helpers';
import { Kb } from '../src/design';
import { setEngine } from '../src/game/instance';
import type { GameEngine } from '../src/game/engine';
import { useUi } from '../src/store';
import { setReducedMotion } from '../src/test/media';
import { DeathSheet, receiptNumbers, settlementFor } from '../src/ui/game';
import { EmoteBar } from '../src/ui/game/EmoteBar';
import { Feed } from '../src/ui/game/Feed';
import { roomName, tokenFormat } from '../src/ui/game/format';

const M = 1_000_000; // one whole token in ledger units (6 decimals)
const ARENA: RoomInfo = { id: 'arena-1-1', mode: 'arena', name: '$1 Room', width: 6400, height: 6400, players: 3, bots: 10, maxPlayers: 50, arenaId: 1, entryFee: 1000 * M };
const STATS: DeathStats = { aliveMs: 94_000, finalMass: 0, maxMass: 640, foodEaten: 88, cellsEaten: 1, playersEaten: 1, bestRank: 5 };
const initial = useUi.getState();

beforeEach(() => {
  useUi.setState({ chain: chainStatus() });
});
afterEach(() => {
  act(() => useUi.setState(initial, true));
});

describe('round receipt numbers', () => {
  it('arena v3: estimates the fee on profit at the ticket\'s rates until the settlement arrives', () => {
    const R = { burnBps: 1500, vaultBps: 500 };
    // profit 2,000: 300 burned + 100 to the fee wallet; the player gets 2,600
    expect(receiptNumbers(3000 * M, 1000 * M, R, null)).toEqual({ gain: 2000 * M, fee: 400 * M, net: 2600 * M, pct: 20, final: false });
    expect(receiptNumbers(3000 * M, 1000 * M, { burnBps: 1000, vaultBps: 0 }, null)).toMatchObject({ fee: 200 * M, net: 2800 * M, pct: 10 });
    // a loss or a break-even pays no fee
    expect(receiptNumbers(400 * M, 1000 * M, R, null)).toMatchObject({ gain: -600 * M, fee: 0, net: 400 * M });
    expect(receiptNumbers(1000 * M, 1000 * M, R, null)).toMatchObject({ fee: 0, net: 1000 * M });
    // the settlement's own numbers win
    expect(receiptNumbers(3000 * M, 1000 * M, R, { fee: 399 * M, net: 2601 * M })).toMatchObject({ fee: 399 * M, net: 2601 * M, final: true, pct: 20 });
  });

  it('adopts only the settlement of the ticket that was paid (by session address)', () => {
    const s = (session: string | null) => ({ session, arenaId: 1, txHash: '0x', payout: 1, at: 0 });
    expect(settlementFor(s('SessA'), 'SessA')).toEqual(s('SessA'));
    expect(settlementFor(s('SessB'), 'SessA')).toBeNull();
    expect(settlementFor(s(null), 'SessA')).toBeNull();
    expect(settlementFor(s('SessA'), null)).toBeNull();
    expect(settlementFor(null, 'SessA')).toBeNull();
  });
});

describe('format helpers', () => {
  it('signs token deltas with a real minus and no sign on zero', () => {
    const tf = tokenFormat(6, '$NIBAL');
    expect(tf.signed(1250 * M)).toBe('+1,250');
    expect(tf.signed(-1250 * M)).toBe('−1,250');
    expect(tf.fmt(1500 * M, { compact: true })).toBe('1.5K');
    expect(tf.signed(-1)).toBe('0');
  });

  it('names arenas and practice rooms', () => {
    expect(roomName(ARENA)).toBe('$1 Room');
    expect(roomName({ ...ARENA, arenaId: 4, instance: 2 })).toBe('$10 Room · 2');
    expect(roomName({ ...ARENA, id: 'practice-rookie-2', mode: 'practice', league: 'rookie', arenaId: undefined })).toBe('Rookie Pond #2');
    expect(roomName({ ...ARENA, id: 'practice-pro-1', mode: 'practice', league: 'pro', arenaId: undefined })).toBe('Pro Pond #1');
  });
});

describe('kill feed', () => {
  it('reads as one sentence: no space before the period, and the period stays glued to the name it follows', () => {
    // id 3 picks "{k} ate {v}. No crumbs."
    act(() => useUi.setState({ killfeed: [{ id: 3, killer: 'Penny', killerSkin: 1, victim: 'Dime', victimSkin: 2, cause: 'eat', at: Date.now() }] }));
    const { container } = render(<Feed narrow={false} />);
    const line = container.querySelector('.g-kill')!;
    expect(line.textContent).toBe('Penny ate Dime. No crumbs.');
    const glued = line.querySelector('.g-kill__who')!;
    expect(glued.textContent).toBe('Dime.');
  });

  it('"you" is the coin the line marks as mine (by player id), never a coin that only shares my name', () => {
    // id 1 picks "{k} had {v} for lunch."
    act(() =>
      useUi.setState({
        me: { pid: 7, name: 'Coinie', skin: 1 },
        killfeed: [
          { id: 1, killer: 'Coinie', killerSkin: 1, victim: 'Coinie', victimSkin: 2, killerIsMe: true, victimIsMe: false, cause: 'eat', at: Date.now() },
          { id: 5, killer: 'Coinie', killerSkin: 3, victim: 'Coinie', victimSkin: 2, cause: 'eat', at: Date.now() },
        ],
      }),
    );
    const { container } = render(<Feed narrow={false} />);
    const lines = [...container.querySelectorAll('.g-kill')].map((l) => l.textContent);
    expect(lines).toEqual(['you had Coinie for lunch.', 'Coinie had Coinie for lunch.']);
    expect(container.querySelectorAll('.is-me')).toHaveLength(1);
  });
});

describe('emoji bar', () => {
  it('every emote has its own emoji; the bar is laughing, shades, the crown, fuming, cursing, crying, the clown', () => {
    expect(new Set(EMOTES.map((e) => e.emoji)).size).toBe(EMOTES.length);
    expect(EMOTE_BAR.map((id) => emoteEmoji(id))).toEqual(['😂', '🤣', '😎', '👑', '😡', '🤬', '😭', '🤡']);
  });

  it('shows the eight emoji with keys 1-8; a click and a key both send the emote', async () => {
    const emote = vi.fn();
    setEngine({ emote } as unknown as GameEngine);
    render(
      <Kb>
        <EmoteBar />
      </Kb>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(8);
    const king = screen.getByRole('button', { name: 'King' });
    expect(king.getAttribute('aria-keyshortcuts')).toBe('4');
    expect(king.textContent).toContain('👑');
    expect(screen.getByRole('button', { name: 'Clown' }).getAttribute('aria-keyshortcuts')).toBe('8');
    fireEvent.click(screen.getByRole('button', { name: 'Cursing' }));
    expect(emote).toHaveBeenCalledWith(8);
    setEngine(null);
    const { GameEngine } = await import('../src/game/engine');
    const send = vi.fn();
    const fake = Object.create(GameEngine.prototype) as GameEngine;
    Object.assign(fake, { net: { send } });
    act(() => useUi.setState({ screen: 'playing' }));
    fake.emote(emoteForSlot(2)!);
    expect(send).toHaveBeenCalledWith({ t: 'emote', id: 10 });
  });
});

describe('death sheet', () => {
  it('says Game over, names the eater, shows the value lost and one Start over button', async () => {
    useUi.setState({
      screen: 'dead',
      room: ARENA,
      death: { stats: { ...STATS, valueLost: 1450 * M, lootSpilled: 0 }, killer: 'Rocky', killerSkin: 6 },
    });
    render(
      <Kb>
        <DeathSheet />
      </Kb>,
    );
    // the sheet waits out the death slow motion
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('dialog', { name: 'Game over' })).toBeTruthy();
    expect(screen.getByText('Rocky ate you')).toBeTruthy();
    expect(screen.getByText('−1,450')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Start over/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Practice|Buy back in/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Watch who is still eating' })).toBeTruthy();
  });

  it('names the player who ate us (reduced motion: no slow-motion wait)', () => {
    setReducedMotion(true);
    useUi.setState({ screen: 'dead', room: ARENA, death: { stats: { ...STATS, valueLost: 10 * M }, killer: 'Nakamoto', killerSkin: 1 } });
    render(
      <Kb>
        <DeathSheet />
      </Kb>,
    );
    expect(screen.getByText('Nakamoto ate you')).toBeTruthy();
  });

  it('practice: Start over rejoins the same practice room at once', () => {
    setReducedMotion(true);
    const play = vi.fn();
    setEngine({ play, backToLobby: vi.fn(), watch: vi.fn() } as unknown as GameEngine);
    const PRACTICE: RoomInfo = { id: 'practice-rookie-1', mode: 'practice', name: 'Practice', width: 4000, height: 4000, players: 2, bots: 18, maxPlayers: 40 };
    useUi.setState({ screen: 'dead', room: PRACTICE, death: { stats: STATS, killer: 'Nakamoto', killerSkin: 1 } });
    try {
      render(
        <Kb>
          <DeathSheet />
        </Kb>,
      );
      expect(screen.getByRole('dialog', { name: 'Game over' })).toBeTruthy();
      expect(screen.queryByText(/New ticket/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      expect(play).toHaveBeenCalledWith('practice');
    } finally {
      setEngine(null);
    }
  });
});
