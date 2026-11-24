import type { ServerMessage } from '@coinnibal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine without a canvas renderer or a real socket: the test plays the server.
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
}));
const net = vi.hoisted(() => ({ sent: [] as { t: string; token?: string }[], handlers: null as null | { onMessage(m: unknown): void } }));
vi.mock('../src/game/net', () => ({
  Net: class {
    rtt = 0;
    constructor(_url: string, handlers: { onMessage(m: unknown): void }) {
      net.handlers = handlers;
    }
    connect() {}
    close() {}
    get open() {
      return true;
    }
    send(msg: { t: string }) {
      net.sent.push(msg);
    }
    sendBinary() {}
  },
}));

const { GameEngine } = await import('../src/game/engine');
const { useUi } = await import('../src/store');

HTMLCanvasElement.prototype.getContext = (() => null) as never;
const initial = useUi.getState();
const ADDR = '0x00000000000000000000000000000000000000A1';
const STALE = `${ADDR}.1.stale`;
const recv = (m: Partial<ServerMessage> & { t: string }) => net.handlers!.onMessage(m);
const welcome = () => recv({ t: 'welcome', v: 1, serverTime: Date.now(), serverNow: Date.now(), rooms: [], chain: null as never, online: 1 });
const authFailed = () => recv({ t: 'error', code: 'auth_failed', message: 'Wallet sign-in failed. Please sign again.' });

let engine: InstanceType<typeof GameEngine>;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  net.sent = [];
  localStorage.clear();
  useUi.setState({ ...initial, screen: 'lobby' }, true);
});
afterEach(() => {
  engine.destroy();
  vi.unstubAllGlobals();
  useUi.setState(initial, true);
  localStorage.clear();
});

describe('a session token the server refuses', () => {
  it('signs the lobby out and forgets the stored token (the /play gate handed it over)', () => {
    localStorage.setItem('coinnibal.auth.v1', JSON.stringify({ address: ADDR, token: STALE, exp: Date.now() + 3600_000 }));
    useUi.setState({ auth: { address: ADDR, token: STALE, profile: null } });
    engine = new GameEngine(document.createElement('canvas'));
    welcome();
    expect(net.sent.find((m) => m.t === 'auth')?.token).toBe(STALE);
    authFailed();
    expect(useUi.getState().auth).toBeNull();
    expect(localStorage.getItem('coinnibal.auth.v1')).toBeNull();
    // the wallet hook now finds no token and no session: the lobby offers "Sign in"
    expect(GameEngine.storedToken(ADDR)).toBeNull();
  });

  it('keeps a session that was renewed meanwhile, and ignores a failed signature sign-in', () => {
    engine = new GameEngine(document.createElement('canvas'));
    welcome();
    engine.authToken(STALE);
    recv({ t: 'authed', address: ADDR, token: `${ADDR}.2.fresh`, profile: null });
    // a later failure (a signature sign-in, not this token) leaves the fresh session alone
    authFailed();
    expect(useUi.getState().auth?.token).toBe(`${ADDR}.2.fresh`);
    expect(GameEngine.storedToken(ADDR)).toBe(`${ADDR}.2.fresh`);
  });
});

describe('a custom room that closes', () => {
  it("shows the server's reason", () => {
    engine = new GameEngine(document.createElement('canvas'));
    welcome();
    recv({ t: 'error', code: 'room_closed', message: 'The room creator closed this room.' });
    expect(useUi.getState().toasts.at(-1)?.text).toBe('The room creator closed this room.');
  });
});

describe('a reload (or a reopened tab) mid-round', () => {
  const authed = (seat?: { arenaId: number; held: boolean }) => recv({ t: 'authed', address: ADDR, token: `${ADDR}.3.ok`, profile: null, ...(seat ? { seat } : {}) });
  const joins = () => net.sent.filter((m) => m.t === 'join') as { t: string; room?: string }[];

  it('takes the live coin back by itself, with no transaction (the way a reconnect does)', () => {
    engine = new GameEngine(document.createElement('canvas'));
    welcome();
    authed({ arenaId: 2, held: false });
    expect(joins()).toEqual([expect.objectContaining({ room: 'arena:2' })]);
    // the seat comes back: the game is on
    recv({ t: 'joined', room: { id: 'arena-2-1', mode: 'arena', name: 'A', width: 7800, height: 7800, players: 1, bots: 0, maxPlayers: 50, arenaId: 2, entryFee: 1 }, playerId: 7, name: 'me', skin: 0, value: 1, entryFee: 1 } as never);
    expect(useUi.getState().screen).toBe('playing');
    // a later sign-in on the same socket (the wallet hook) does not join twice
    authed({ arenaId: 2, held: false });
    expect(joins()).toHaveLength(1);
  });

  it('leaves a coin another tab plays alone (the lobby\'s Resume takes it over), and asks nothing without a live coin', () => {
    engine = new GameEngine(document.createElement('canvas'));
    welcome();
    authed({ arenaId: 2, held: true });
    authed();
    expect(joins()).toHaveLength(0);
    expect(useUi.getState().screen).toBe('lobby');
  });

  it('a coin gone meanwhile (eaten, or settled at the bell): back in the lobby with a note, no loop', () => {
    engine = new GameEngine(document.createElement('canvas'));
    welcome();
    authed({ arenaId: 2, held: false });
    recv({ t: 'error', code: 'no_session', message: 'No open ticket.' });
    expect(useUi.getState().screen).toBe('lobby');
    expect(joins()).toHaveLength(1);
  });

  it('never pulls a player out of a game in play', () => {
    engine = new GameEngine(document.createElement('canvas'));
    welcome();
    useUi.setState({ screen: 'playing' });
    authed({ arenaId: 2, held: false });
    expect(joins()).toHaveLength(0);
  });
});
