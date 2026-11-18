import type { RoomInfo, ServerMessage } from '@coinnibal/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetDown } from '../src/game/net';

// The engine without a canvas renderer or a real socket: the test plays the server and the network.
vi.mock('../src/render/renderer', () => ({
  Renderer: class {
    levels = [{ dpr: 1, low: false }];
    autoLow = false;
    resize() {}
    setLevel() {}
    draw() {}
    drawMinimap() {}
    lookFor() {
      return {};
    }
  },
  canvasDpr: () => 1,
}));
type Handlers = { onOpen(): void; onClose(d: NetDown): void; onMessage(m: unknown): void; onSnapshot(b: ArrayBuffer): void };
const net = vi.hoisted(() => ({ resumed: 0, handlers: null as null | Handlers }));
vi.mock('../src/game/net', async (orig) => ({
  ...(await orig<typeof import('../src/game/net')>()),
  Net: class {
    rtt = 0;
    constructor(_url: string, handlers: Handlers) {
      net.handlers = handlers;
    }
    connect() {}
    close() {}
    resume() {
      net.resumed++;
    }
    get open() {
      return true;
    }
    send() {}
    sendBinary() {}
  },
}));

const { GameEngine } = await import('../src/game/engine');
const { setEngine } = await import('../src/game/instance');
const { Kb } = await import('../src/design');
const { useUi } = await import('../src/store');
const { ConnectionBanner, BANNER_DELAY_MS } = await import('../src/ui/game/ConnectionBanner');
const { ChatStream } = await import('../src/ui/game/ChatStream');

HTMLCanvasElement.prototype.getContext = (() => null) as never;
// jsdom has no scrolling
Element.prototype.scrollTo = (() => {}) as never;
const ui0 = useUi.getState();
const recv = (m: Partial<ServerMessage> & { t: string }) => act(() => net.handlers!.onMessage(m));
const ARENA: RoomInfo = { id: 'arena-1-1', mode: 'arena', name: '$1 Room', width: 6400, height: 6400, players: 3, bots: 0, maxPlayers: 50, arenaId: 1, entryFee: 1000 };
const POND: RoomInfo = { id: 'practice-rookie-1', mode: 'practice', name: 'Practice', width: 4000, height: 4000, players: 3, bots: 0, maxPlayers: 40 };

let engine: InstanceType<typeof GameEngine>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  localStorage.setItem('coinnibal.brief', '1');
  useUi.setState({ ...ui0, screen: 'lobby' }, true);
  engine = new GameEngine(document.createElement('canvas'));
  setEngine(engine);
  net.resumed = 0;
  recv({ t: 'welcome', v: 4, serverTime: Date.now(), serverNow: Date.now(), rooms: [POND, ARENA], chain: ui0.chain as never, online: 2 });
});
afterEach(() => {
  setEngine(null);
  engine.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  act(() => useUi.setState(ui0, true));
});

const banner = () =>
  render(
    <Kb>
      <ConnectionBanner />
    </Kb>,
  );
const drop = (d: NetDown) => act(() => net.handlers!.onClose(d));

describe('the connection banner', () => {
  it('during an arena game: blocks the game with "your coin is still in the room", the attempt and its countdown', () => {
    recv({ t: 'joined', room: ARENA, playerId: 7, name: 'Daphne', skin: 0 });
    banner();
    drop({ kind: 'lost', attempt: 2, retryAt: performance.now() + 1000 });
    // a blip shorter than the delay shows nothing
    expect(screen.queryByTestId('net-lost')).toBeNull();
    act(() => vi.advanceTimersByTime(BANNER_DELAY_MS));
    const el = screen.getByTestId('net-lost');
    expect(el.getAttribute('role')).toBe('alertdialog');
    expect(el.textContent).toContain('Connection lost, reconnecting… your coin is still in the room');
    expect(el.textContent).toMatch(/Attempt 2 · next try in \d s/);
    // "Retry now" reconnects at once
    act(() => screen.getByRole('button', { name: 'Retry now' }).click());
    expect(net.resumed).toBe(1);
    // back: the banner goes
    act(() => net.handlers!.onOpen());
    expect(screen.queryByTestId('net-lost')).toBeNull();
  });

  it('in practice it does not promise a kept coin; in the lobby it stays out of the way', () => {
    recv({ t: 'joined', room: POND, playerId: 7, name: 'Daphne', skin: 0 });
    banner();
    drop({ kind: 'lost', attempt: 1, retryAt: performance.now() + 500 });
    act(() => vi.advanceTimersByTime(BANNER_DELAY_MS));
    expect(screen.getByTestId('net-lost').textContent).toContain('Connection lost, reconnecting…');
    expect(screen.getByTestId('net-lost').textContent).not.toContain('still in the room');
    act(() => useUi.setState({ screen: 'lobby' }));
    expect(screen.queryByTestId('net-lost')).toBeNull();
  });

  it('replaced by another tab: no reconnect loop, "You\'re playing in another tab or window", and Play here', () => {
    recv({ t: 'joined', room: ARENA, playerId: 7, name: 'Daphne', skin: 0 });
    banner();
    drop({ kind: 'replaced', attempt: 0, retryAt: null });
    const el = screen.getByTestId('net-replaced');
    expect(el.textContent).toContain("You're playing in another tab or window");
    expect(useUi.getState().connecting).toBe(false);
    act(() => vi.advanceTimersByTime(60_000));
    expect(net.resumed).toBe(0);
    act(() => screen.getByRole('button', { name: 'Play here' }).click());
    expect(net.resumed).toBe(1);
  });
});

describe('guest chat', () => {
  it('a line from a player who is not signed in is muted and tagged; a signed-in player and the system are not', () => {
    act(() => useUi.setState({ screen: 'playing', settings: { ...useUi.getState().settings, showChat: true } }));
    // player 9 is in view and signed in (Verified), player 11 is in view as a guest, 12 is nowhere to be seen
    engine.world.players.set(9, { id: 9, skin: 1, flags: 2, name: 'Iris', isBot: false, emote: null });
    engine.world.players.set(11, { id: 11, skin: 1, flags: 0, name: 'Guest 11', isBot: false, emote: null });
    recv({ t: 'chat', pid: 9, from: 'Iris', skin: 1, text: 'gl hf' });
    recv({ t: 'chat', pid: 11, from: 'Guest 11', skin: 1, text: 'send me tokens' });
    recv({ t: 'chat', pid: 12, from: 'Stranger', skin: 1, text: 'hello' });
    recv({ t: 'chat', pid: 0, from: '', skin: 0, text: 'Round over', system: true });
    expect(useUi.getState().chat.map((c) => [c.from, c.guest === true])).toEqual([
      ['Iris', false],
      ['Guest 11', true],
      ['Stranger', true],
      ['', false],
    ]);
    render(
      <Kb>
        <ChatStream />
      </Kb>,
    );
    const guest = screen.getByText('send me tokens').closest('li')!;
    expect(guest.className).toContain('is-guest');
    expect(guest.textContent).toContain('guest');
    expect(screen.getByText('gl hf').closest('li')!.className).not.toContain('is-guest');
  });
});
