import { defaultName, type ClientMessage, type RoomInfo, type ServerMessage } from '@coinnibal/shared';
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
const net = vi.hoisted(() => ({ sent: [] as unknown[], handlers: null as null | { onMessage(m: unknown): void } }));
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
    send(msg: unknown) {
      net.sent.push(msg);
    }
    sendBinary() {}
  },
}));

const { GameEngine } = await import('../src/game/engine');
const { NAME_TAG_KEY } = await import('../src/game/playerName');
const { useUi } = await import('../src/store');

HTMLCanvasElement.prototype.getContext = (() => null) as never;
const initial = useUi.getState();
const ADDR = '0x00000000000000000000000000000000000000A1';
const POND: RoomInfo = { id: 'practice-rookie-1', mode: 'practice', name: 'Rookie Pond #1', width: 6000, height: 6000, players: 2, bots: 0, maxPlayers: 30 };
const recv = (m: Partial<ServerMessage> & { t: string }) => net.handlers!.onMessage(m);
const joinedName = () => (net.sent as ClientMessage[]).filter((m): m is Extract<ClientMessage, { t: 'join' }> => m.t === 'join').at(-1)?.name;
const settings = (name: string) => useUi.setState((s) => ({ settings: { ...s.settings, name } }));

let engine: InstanceType<typeof GameEngine>;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  localStorage.clear();
  // a returning player: the first-play brief does not hold the join
  localStorage.setItem('coinnibal.brief', '1');
  net.sent = [];
  useUi.setState({ ...initial, rooms: [POND], screen: 'lobby' }, true);
  engine = new GameEngine(document.createElement('canvas'));
  recv({ t: 'welcome', v: 1, serverTime: Date.now(), serverNow: Date.now(), rooms: [POND], chain: initial.chain as never, online: 1 });
});
afterEach(() => {
  engine.destroy();
  vi.unstubAllGlobals();
  useUi.setState(initial, true);
  localStorage.clear();
});

describe('the name a join sends', () => {
  it('no name set: "Coinie" and a tag of this browser, the same on every join; another browser gets another', () => {
    settings('');
    engine.play('practice');
    const first = joinedName()!;
    expect(first).toMatch(/^Coinie-[0-9a-f]{4}$/);
    expect(localStorage.getItem(NAME_TAG_KEY)).toMatch(/^[0-9a-f]{16}$/);
    engine.play('practice');
    expect(joinedName()).toBe(first);
    // the tag is this browser's own: a browser with another tag plays under another name
    localStorage.setItem(NAME_TAG_KEY, '0123456789abcdef');
    engine.play('practice');
    expect(joinedName()).toBe(defaultName('0123456789abcdef'));
    expect(joinedName()).not.toBe(first);
    // the setting is left empty: nothing was chosen for the player
    expect(useUi.getState().settings.name).toBe('');
  });

  it('signed in without a name: the tag of the wallet (what the server falls back to); a chosen name goes as it is', () => {
    useUi.setState({ auth: { address: ADDR, token: 't', profile: null } });
    settings('');
    engine.play('practice');
    expect(joinedName()).toBe(defaultName(ADDR));
    settings('Coinie');
    engine.play('practice');
    expect(joinedName()).toBe('Coinie');
    settings('Penny');
    engine.play('practice');
    expect(joinedName()).toBe('Penny');
  });
});

describe('"you" in the kill feed is my player id, never my name', () => {
  const kf = (killerPid: number, victimPid: number) =>
    recv({ t: 'kf', killer: 'Coinie', killerSkin: 1, victim: 'Coinie', victimSkin: 2, killerPid, victimPid, cause: 'eat' });

  it('three coins called "Coinie": only the line with my id says it was me, and only my bites count', () => {
    recv({ t: 'joined', room: POND, playerId: 7, name: 'Coinie', skin: 1 });
    expect(useUi.getState().screen).toBe('playing');
    kf(7, 8); // I ate one
    kf(9, 8); // two others, neither of them me
    kf(8, 7); // one ate me
    const feed = useUi.getState().killfeed;
    expect(feed.map((k) => [k.killerIsMe, k.victimIsMe])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
    expect(useUi.getState().myEaten).toBe(1);
  });

  it('a spectator is in no line', () => {
    recv({ t: 'spectating', room: POND, targetPid: 7 });
    kf(7, 8);
    expect(useUi.getState().killfeed.at(-1)).toMatchObject({ killerIsMe: false, victimIsMe: false });
  });
});
