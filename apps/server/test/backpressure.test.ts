/**
 * A client that stops reading must not grow the server's memory (security review S8): every send checks the socket's
 * buffer and closes it past SEND_BUFFER_MAX_BYTES; the heartbeat's ping carries a payload the pong must echo, so
 * unsolicited pongs do not keep a non-reading socket alive; a buffer that stays backed up closes the socket; a
 * repeated `hello` gets no second `welcome`; `ping` replies are rate-limited.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Conn, PING_REPLY_MIN_MS, SEND_BUFFER_MAX_BYTES } from '../src/net/conn';
import { wsOut } from '../src/rooms/load';

let app: App;
let port = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-bp-')), GAME_ACCESS: 'public', NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv);
  app = await createApp(cfg, { chain: new NullChain(), log: () => {}, persist: false });
  port = await app.listen();
});

afterAll(async () => {
  await app.close();
});

function open(opts: WebSocket.ClientOptions = {}): Promise<{ ws: WebSocket; texts: { t: string }[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, opts);
    const texts: { t: string }[] = [];
    ws.on('message', (d, binary) => {
      if (!binary) texts.push(JSON.parse(String(d)));
    });
    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      resolve({ ws, texts });
    });
    ws.once('error', reject);
  });
}
const closed = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.once('close', () => r())));

describe('outbound backpressure (S8)', () => {
  it('a send over the buffer cap closes the socket instead of queuing', () => {
    let sent = 0;
    let terminated = 0;
    const ws = { readyState: 1, bufferedAmount: 0, send: () => sent++, terminate: () => terminated++ };
    const conn = new Conn(ws as never, '127.0.0.1');
    conn.sendText('{"t":"pong"}');
    expect(sent).toBe(1);
    const before = wsOut.overflow;
    ws.bufferedAmount = SEND_BUFFER_MAX_BYTES + 1;
    conn.sendText('{"t":"rooms"}');
    conn.sendBinary(new ArrayBuffer(8));
    expect(sent).toBe(1);
    expect(terminated).toBe(2);
    expect(wsOut.overflow - before).toBe(2);
  });

  it('only the echo of the server\'s ping keeps a socket: unsolicited pongs do not', async () => {
    const good = await open();
    // a client that never reads its pings, and sends pongs of its own all the time
    const bad = await open({ autoPong: false });
    const pongs = setInterval(() => bad.ws.readyState === WebSocket.OPEN && bad.ws.pong(Buffer.from('alive')), 5);
    try {
      await sleep(100);
      app.gateway.beat();
      await sleep(150);
      app.gateway.beat();
      await closed(bad.ws);
      expect(good.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      clearInterval(pongs);
      good.ws.close();
    }
  });

  it('a send buffer that stays over the snapshot-skip threshold for two beats closes the socket', async () => {
    const c = await open();
    await sleep(100);
    const conn = [...app.rooms.conns].at(-1)!;
    Object.defineProperty(conn.ws, 'bufferedAmount', { get: () => 800 * 1024 });
    const before = app.gateway.dropped.slow;
    app.gateway.beat();
    await sleep(100);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    app.gateway.beat();
    await closed(c.ws);
    expect(app.gateway.dropped.slow - before).toBe(1);
  });

  it('a second hello gets no second welcome; ping replies are rate-limited', async () => {
    const c = await open();
    await sleep(100);
    for (let i = 0; i < 20; i++) c.ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    for (let i = 0; i < 20; i++) c.ws.send(JSON.stringify({ t: 'ping', ts: i }));
    await sleep(150);
    expect(c.texts.filter((m) => m.t === 'welcome')).toHaveLength(1);
    expect(c.texts.filter((m) => m.t === 'pong')).toHaveLength(1);
    await sleep(PING_REPLY_MIN_MS + 50);
    c.ws.send(JSON.stringify({ t: 'ping', ts: 99 }));
    await sleep(100);
    expect(c.texts.filter((m) => m.t === 'pong')).toHaveLength(2);
    c.ws.close();
  });
});
