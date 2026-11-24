import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_REPLACED as SHARED_CLOSE_REPLACED } from '@coinnibal/shared';
import * as netModule from '../src/game/net';
import { Net, WATCHDOG_MS, gameProtocols, jitter, retryDelay, type NetDown } from '../src/game/net';

const CLOSE_REPLACED = SHARED_CLOSE_REPLACED;

/** A stand-in socket: records every instance; the test closes them as the network would. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  closeCalls = 0;
  /** A dead path: `close()` never brings its close event (the browser notices much later, if ever). */
  silent = false;
  onopen: (() => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send() {}
  close(code = 1000) {
    this.closeCalls++;
    this.readyState = 3;
    if (!this.silent) this.onclose?.({ code });
  }
  /** The server accepts the socket. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** A frame from the server. */
  frame(data: unknown = new ArrayBuffer(4)) {
    this.onmessage?.({ data });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSocket.all = [];
});

const setup = () => {
  vi.useFakeTimers();
  // the retry jitter at its middle: the delays below are the plain backoff
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('WebSocket', FakeSocket);
  const downs: NetDown[] = [];
  const net = new Net('ws://x/ws', { onOpen() {}, onClose: (d) => downs.push(d), onMessage() {}, onSnapshot() {} });
  net.connect();
  return { net, downs };
};

describe('Net', () => {
  it('reconnects after a drop, but not once it was closed while the retry waited', () => {
    const { net } = setup();
    expect(FakeSocket.all).toHaveLength(1);
    // the network drops the socket: a retry is scheduled
    FakeSocket.all[0].close();
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all).toHaveLength(2);
    // dropped again, and the engine is destroyed while the retry waits
    FakeSocket.all[1].close();
    net.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('backs off 0.5 s, 1 s, 2 s, 4 s, then every 8 s, and says when the next attempt starts', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    const { downs } = setup();
    FakeSocket.all[0].close();
    expect(downs[0]).toMatchObject({ kind: 'lost', attempt: 1 });
    expect(downs[0].retryAt! - performance.now()).toBe(500);
    vi.advanceTimersByTime(500);
    FakeSocket.all[1].close();
    expect(downs[1]).toMatchObject({ kind: 'lost', attempt: 2 });
    // an open socket starts the count again
    vi.advanceTimersByTime(1000);
    FakeSocket.all[2].accept();
    FakeSocket.all[2].close();
    expect(downs[2]).toMatchObject({ kind: 'lost', attempt: 1 });
  });
});

describe('Net: reconnect jitter', () => {
  it('spreads each retry ±25 % so a thousand clients do not all knock at once after a restart', () => {
    expect(jitter(1000, () => 0)).toBe(750);
    expect(jitter(1000, () => 0.5)).toBe(1000);
    expect(jitter(1000, () => 0.999)).toBeLessThanOrEqual(1250);
    const spread = new Set(Array.from({ length: 50 }, (_, i) => jitter(4000, () => i / 50)));
    expect(spread.size).toBeGreaterThan(40);
  });
});

describe('Net watchdog', () => {
  it('a socket that goes silent (no frame, no pong) is dropped after ~4 s and a new one opened', () => {
    const { downs } = setup();
    const ws = FakeSocket.all[0];
    ws.accept();
    // frames keep it alive
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(1000);
      ws.frame();
    }
    expect(downs).toHaveLength(0);
    // the path goes dead: nothing arrives, and the browser does not notice by itself
    ws.silent = true;
    vi.advanceTimersByTime(WATCHDOG_MS - 600);
    expect(downs).toHaveLength(0);
    vi.advanceTimersByTime(1200);
    expect(downs).toEqual([expect.objectContaining({ kind: 'lost', attempt: 1 })]);
    expect(ws.closeCalls).toBe(1);
    // late frames and a late close of the dead socket change nothing
    ws.frame();
    ws.onclose?.({ code: 1006 });
    expect(downs).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('a pong counts as a sign of life (the lobby keeps its socket without snapshots)', () => {
    const { downs } = setup();
    const ws = FakeSocket.all[0];
    ws.accept();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(2000);
      ws.frame(JSON.stringify({ t: 'pong', ts: 0, serverNow: 0 }));
    }
    expect(downs).toHaveLength(0);
  });
});

describe('Net: replaced by a newer connection', () => {
  it('a CLOSE_REPLACED close is not reconnected; resume() takes the game back', () => {
    const { net, downs } = setup();
    FakeSocket.all[0].accept();
    FakeSocket.all[0].close(CLOSE_REPLACED);
    expect(CLOSE_REPLACED).toBe(4000);
    expect(downs).toEqual([{ kind: 'replaced', attempt: 0, retryAt: null }]);
    vi.advanceTimersByTime(60_000);
    // no loop of two tabs taking the coin from each other
    expect(FakeSocket.all).toHaveLength(1);
    expect(net.open).toBe(false);
    net.resume();
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].accept();
    expect(net.open).toBe(true);
  });
});

describe('Net: the shared close code and the subprotocols', () => {
  it('uses the shared CLOSE_REPLACED (no local copy of it)', () => {
    expect(SHARED_CLOSE_REPLACED).toBe(4000);
    expect('CLOSE_REPLACED' in netModule).toBe(false);
  });

  it('a guest offers `coinnibal` alone; a signed-in socket adds `coinnibal.auth.<token>`, read at each connect', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    let token: string | null = null;
    const net = new Net('ws://x/ws', { onOpen() {}, onClose() {}, onMessage() {}, onSnapshot() {} }, WATCHDOG_MS, () => token);
    net.connect();
    expect(FakeSocket.all[0].url).toBe('ws://x/ws');
    expect(FakeSocket.all[0].protocols).toEqual(['coinnibal']);
    // signed in meanwhile: the reconnect carries the token (never in the URL)
    token = '0xAbC0000000000000000000000000000000000001.1700000000000.1690000000000.mAc_-x';
    FakeSocket.all[0].close();
    vi.advanceTimersByTime(700); // past the first retry with its jitter (500 ms ±25 %)
    expect(FakeSocket.all[1].protocols).toEqual(['coinnibal', `coinnibal.auth.${token}`]);
    expect(FakeSocket.all[1].url).toBe('ws://x/ws');
    net.close();
  });

  it('a token that is not a valid subprotocol token is not offered (the socket still opens as a guest)', () => {
    expect(gameProtocols(null)).toEqual(['coinnibal']);
    expect(gameProtocols('')).toEqual(['coinnibal']);
    expect(gameProtocols('bad token,with=chars')).toEqual(['coinnibal']);
    expect(gameProtocols('a.b.c')).toEqual(['coinnibal', 'coinnibal.auth.a.b.c']);
  });
});
