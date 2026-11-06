import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { useUi } from '../src/store';
import { Feed } from '../src/ui/game/Feed';
import { FEED_FADE_MS } from '../src/ui/game/fade';

const initial = useUi.getState();
// jsdom has no scrolling
Element.prototype.scrollTo ??= (() => {}) as never;
const line = (id: number, text: string) => ({ id, pid: 1, from: 'Pip', skin: 1, text, at: Date.now() });

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ chat: [line(1, 'hello 😂')], killfeed: [], chatOpen: false, settings: { ...useUi.getState().settings, showChat: true } });
});
afterEach(() => {
  vi.useRealTimers();
  act(() => useUi.setState(initial, true));
});

const feed = () => screen.getByTestId('feed');
const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('chat and feed fade when idle', () => {
  it('fades a few seconds after the last line; a new line brings it back', () => {
    render(
      <Kb>
        <Feed narrow={false} />
      </Kb>,
    );
    expect(feed().className).not.toContain('is-faded');
    pass(FEED_FADE_MS - 100);
    expect(feed().className).not.toContain('is-faded');
    pass(200);
    expect(feed().className).toContain('is-faded');
    act(() => useUi.setState((s) => ({ chat: [...s.chat, line(2, 'gg')] })));
    expect(feed().className).not.toContain('is-faded');
    // a kill line wakes it too
    pass(FEED_FADE_MS + 1);
    expect(feed().className).toContain('is-faded');
    act(() => useUi.setState({ killfeed: [{ id: 9, killer: 'a', killerSkin: 1, victim: 'b', victimSkin: 2, cause: 'eat', at: Date.now() }] }));
    expect(feed().className).not.toContain('is-faded');
    // a kill line leaving by itself is no activity
    pass(FEED_FADE_MS + 1);
    act(() => useUi.setState({ killfeed: [] }));
    expect(feed().className).toContain('is-faded');
  });

  it('the pointer over it (or focus, or the open chat line) holds it awake; a tap wakes it', () => {
    render(
      <Kb>
        <Feed narrow={false} />
      </Kb>,
    );
    pass(FEED_FADE_MS + 1);
    expect(feed().className).toContain('is-faded');
    fireEvent.pointerEnter(feed(), { pointerType: 'mouse' });
    expect(feed().className).not.toContain('is-faded');
    pass(FEED_FADE_MS * 3);
    expect(feed().className).not.toContain('is-faded');
    fireEvent.pointerLeave(feed());
    pass(FEED_FADE_MS + 1);
    expect(feed().className).toContain('is-faded');
    // touch: a tap brings it back for another few seconds
    fireEvent.pointerDown(feed(), { pointerType: 'touch' });
    expect(feed().className).not.toContain('is-faded');
    pass(FEED_FADE_MS + 1);
    expect(feed().className).toContain('is-faded');
    act(() => useUi.setState({ chatOpen: true }));
    expect(feed().className).not.toContain('is-faded');
    pass(FEED_FADE_MS * 2);
    expect(feed().className).not.toContain('is-faded');
  });

  it('keeps the chat text (and its emoji) as typed: the fade is opacity only', () => {
    render(
      <Kb>
        <Feed narrow={false} />
      </Kb>,
    );
    pass(FEED_FADE_MS + 1);
    expect(screen.getByText('hello 😂')).toBeTruthy();
  });
});
