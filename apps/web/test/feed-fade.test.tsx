import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { useUi } from '../src/store';
import { CHAT_FADE_MS, CHAT_LINES, CHAT_SHOW_MS, ChatStream, freeBand, nameColor, visibleLines } from '../src/ui/game/ChatStream';
import { Feed } from '../src/ui/game/Feed';
import { FEED_FADE_MS } from '../src/ui/game/fade';

const initial = useUi.getState();
// jsdom has no scrolling
Element.prototype.scrollTo ??= (() => {}) as never;
const line = (id: number, text: string, o: Record<string, unknown> = {}) => ({ id, pid: 1, from: 'Pip', skin: 1, text, at: Date.now(), ...o });
const kill = (id: number) => ({ id, killer: 'a', killerSkin: 1, victim: 'b', victimSkin: 2, cause: 'eat' as const, at: Date.now() });

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ chat: [line(1, 'hello 😂')], killfeed: [kill(1)], chatOpen: false, settings: { ...useUi.getState().settings, showChat: true } });
});
afterEach(() => {
  vi.useRealTimers();
  act(() => useUi.setState(initial, true));
});

const feed = () => screen.getByTestId('feed');
const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('the kill feed fades when idle', () => {
  it('fades a few seconds after the last kill; a new kill brings it back; one leaving by itself does not', () => {
    render(
      <Kb>
        <Feed narrow={false} />
      </Kb>,
    );
    expect(feed().className).not.toContain('is-faded');
    pass(FEED_FADE_MS + 100);
    expect(feed().className).toContain('is-faded');
    act(() => useUi.setState({ killfeed: [kill(1), kill(9)] }));
    expect(feed().className).not.toContain('is-faded');
    pass(FEED_FADE_MS + 1);
    act(() => useUi.setState({ killfeed: [] }));
    expect(feed().className).toContain('is-faded');
  });

  it('the pointer over it holds it awake; a tap wakes it', () => {
    render(
      <Kb>
        <Feed narrow={false} />
      </Kb>,
    );
    pass(FEED_FADE_MS + 1);
    fireEvent.pointerEnter(feed(), { pointerType: 'mouse' });
    expect(feed().className).not.toContain('is-faded');
    pass(FEED_FADE_MS * 3);
    expect(feed().className).not.toContain('is-faded');
    fireEvent.pointerLeave(feed());
    pass(FEED_FADE_MS + 1);
    expect(feed().className).toContain('is-faded');
    fireEvent.pointerDown(feed(), { pointerType: 'touch' });
    expect(feed().className).not.toContain('is-faded');
  });
});

describe('the chat stream (bottom left, transparent, Twitch / Kick style)', () => {
  it('keeps the text (and its emoji) as typed, the name coloured, the newest at the bottom, at most 8 lines', () => {
    act(() => useUi.setState({ chat: Array.from({ length: 12 }, (_, i) => line(i + 1, `line ${i + 1}`, { from: `P${i}` })) }));
    render(
      <Kb>
        <ChatStream />
      </Kb>,
    );
    const items = screen.getByTestId('chat-stream').querySelectorAll('li');
    expect(items).toHaveLength(CHAT_LINES);
    expect(items[0].textContent).toContain('line 5');
    expect(items[CHAT_LINES - 1].textContent).toContain('line 12');
    const name = items[0].querySelector('b') as HTMLElement;
    expect(name.style.color).not.toBe('');
    expect(nameColor('Pip')).toBe(nameColor('Pip'));
    expect(nameColor('Pip')).not.toBe(nameColor('Daphne'));
  });

  it('lines fade to transparent 5 s after they came in; with the chat line open the last ones stay', () => {
    expect(CHAT_SHOW_MS).toBe(5000);
    const now = Date.now();
    const chat = [line(1, 'old', { at: now - CHAT_SHOW_MS - CHAT_FADE_MS - 1 }), line(2, 'new', { at: now })];
    expect(visibleLines(chat, now, false).map((c) => c.text)).toEqual(['new']);
    expect(visibleLines(chat, now, true).map((c) => c.text)).toEqual(['old', 'new']);
    render(
      <Kb>
        <ChatStream />
      </Kb>,
    );
    expect(screen.getByText('hello 😂')).toBeTruthy();
    const li = screen.getByText('hello 😂').closest('li') as HTMLElement;
    expect(li.className).toContain('is-fading');
    pass(CHAT_SHOW_MS + CHAT_FADE_MS + 1500);
    expect(screen.queryByText('hello 😂')).toBeNull();
  });

  it('a guest line stays muted (no colour); the chat setting hides it; Enter opens the line under it', () => {
    act(() => useUi.setState({ chat: [line(1, 'buy my coin', { guest: true })] }));
    const v = render(
      <Kb>
        <ChatStream />
      </Kb>,
    );
    const li = screen.getByText('buy my coin').closest('li') as HTMLElement;
    expect(li.className).toContain('is-guest');
    expect((li.querySelector('b') as HTMLElement).style.color).toBe('');
    act(() => useUi.setState({ chatOpen: true }));
    expect(screen.getByRole('textbox')).toBeTruthy();
    act(() => useUi.setState({ settings: { ...useUi.getState().settings, showChat: false } }));
    expect(screen.queryByTestId('chat-stream')).toBeNull();
    v.unmount();
  });

  it('docked on a desktop (in the bottom-left column); on its own elsewhere', () => {
    const v = render(
      <Kb>
        <ChatStream docked />
      </Kb>,
    );
    expect(screen.getByTestId('chat-stream').className).toContain('is-docked');
    v.unmount();
    render(
      <Kb>
        <ChatStream />
      </Kb>,
    );
    expect(screen.getByTestId('chat-stream').className).not.toContain('is-docked');
  });

  it('measures its free band: under the top-left corner, over the power-up row reaching into its column', () => {
    const vp = { w: 390, h: 844 };
    const col = { left: 14, right: 214 };
    const band = freeBand(vp, col, 642, [
      { top: 10, bottom: 60, left: 10, right: 200 }, // the pond tag
      { top: 70, bottom: 300, left: 10, right: 198 }, // standings and the kill feed (top-left corner)
      { top: 64, bottom: 400, left: 218, right: 380 }, // the right column: beside it, ignored
      { top: 652, bottom: 788, left: 18, right: 154 }, // the thumb stick under it: already clear
      { top: 594, bottom: 642, left: 164, right: 374 }, // the power-up row of the thumb cluster: lifts the bottom
    ]);
    expect(band).toEqual({ top: 310, bottom: 584 });
    // nothing in the way: from its anchor up to the corner
    expect(freeBand(vp, col, 642, [{ top: 70, bottom: 300, left: 10, right: 198 }])).toEqual({ top: 310, bottom: 642 });
  });
});
