import { PRACTICE_ROOM } from '@coinnibal/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { PracticeQuiet } from '../src/rooms/PracticeQuiet';
import { useUi } from '../src/store';
import { json, mockFetch } from './site-helpers';

const spies = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock('../src/game/instance', () => ({ engine: () => ({ play: spies.play }) }));

const initial = useUi.getState();
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  spies.play.mockReset();
  act(() => useUi.setState(initial, true));
});

describe('practice ponds: the honest empty state', () => {
  it('says the ponds are quiet and opens a free room with bots in one click (guests too)', async () => {
    let auth: string | null = 'unset';
    ({ restore } = mockFetch({
      'POST /api/rooms/custom/practice': (c: { auth: string | null }) => {
        auth = c.auth;
        return { room: { code: 'PR4CT' }, invite: 'https://elymum.io/play?room=PR4CT' };
      },
    }));
    render(
      <Kb>
        <PracticeQuiet />
      </Kb>,
    );
    const card = screen.getByTestId('practice-quiet');
    expect(card.textContent).toContain('Quiet right now');
    expect(card.textContent).toContain('people only');
    expect(card.textContent).toContain(`Free · ${PRACTICE_ROOM.durationMin} min · up to ${PRACTICE_ROOM.maxPlayers - 1} friends with the code`);
    fireEvent.click(screen.getByTestId('practice-bots'));
    await waitFor(() => expect(spies.play).toHaveBeenCalledWith('private:PR4CT'));
    expect(auth).toBeNull();
  });

  it('a refusal is a toast (all busy, too many lately), nothing is joined', async () => {
    ({ restore } = mockFetch({ 'POST /api/rooms/custom/practice': json(503, { error: 'slots_busy', message: 'All practice rooms are busy right now. Try again in a few minutes, or play in a pond.' }) }));
    useUi.setState({ auth: { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', token: 'tok', profile: null } });
    render(
      <Kb>
        <PracticeQuiet hud />
      </Kb>,
    );
    expect(screen.getByTestId('practice-quiet-hud').textContent).toContain('You are alone in this pond');
    fireEvent.click(screen.getByTestId('practice-bots'));
    await waitFor(() => expect(useUi.getState().toasts.some((x) => /practice rooms are busy/.test(x.text))).toBe(true));
    expect(spies.play).not.toHaveBeenCalled();
    // the sticker can be hidden
    fireEvent.click(screen.getByText('Hide'));
    expect(screen.queryByTestId('practice-quiet-hud')).toBeNull();
  });
});
