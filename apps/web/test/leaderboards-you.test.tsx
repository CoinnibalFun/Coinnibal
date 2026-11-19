import type { RoundBoard } from '@coinnibal/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { useUi } from '../src/store';
import { Leaderboards } from '../src/ui/news/Leaderboards';
import { useWallet } from '../src/wallet/store';

const ME = '0x00000000000000000000000000000000000000A1';
const OTHER = '0x00000000000000000000000000000000000000B2';
// jsdom has no canvas: the same null it returns, without the "not implemented" warning
HTMLCanvasElement.prototype.getContext = (() => null) as never;
const initial = useUi.getState();
const initialWallet = useWallet.getState();
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => {
    useUi.setState(initial, true);
    useWallet.setState(initialWallet, true);
  });
});

describe('the last rounds board', () => {
  it('marks "you" by the connected wallet, not by a name another coin may share', async () => {
    const round: RoundBoard = {
      n: 7,
      endedAt: Date.UTC(2026, 10, 19, 12),
      arenaId: 1,
      entryFee: 1_000_000,
      players: 3,
      top: [
        { name: 'Coinie', value: 3_000_000, skin: 1, wallet: OTHER },
        { name: 'Coinie', value: 2_000_000, skin: 2, wallet: ME.toLowerCase() },
        // a row of before the wallets: never "you"
        { name: 'Coinie', value: 1_000_000, skin: 3 },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ daily: [], allTime: [], rounds: [round] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    act(() => {
      useWallet.setState({ status: 'connected', address: ME });
      // the old check: my game name was "Coinie" too
      useUi.setState({ me: { pid: 7, name: 'Coinie', skin: 1 } });
    });
    render(
      <Kb>
        <Leaderboards />
      </Kb>,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Last rounds/ }));
    const board = await screen.findByTestId('round-board');
    const rows = within(board).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.classList.contains('is-me'))).toEqual([false, true, false]);
    expect(within(board).getAllByText('you')).toHaveLength(1);
  });
});
