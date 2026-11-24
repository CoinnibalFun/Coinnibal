/**
 * Cheating audit: malicious clients against the real app and the authoritative rooms. Each block is one finding
 * (confirmed against the code before its fix) or a check that a cheat a modified client could try is refused.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, decodeSnapshot, type ServerMessage, type SnapshotData } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { VIEWPORT_MIN_MS } from '../src/net/gateway';

let app: App;
let port = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const cfg = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-cheat-')),
    GAME_ACCESS: 'public',
    NODE_ENV: 'development',
  } as unknown as NodeJS.ProcessEnv);
  app = await createApp(cfg, { chain: new NullChain(), log: () => {}, persist: false });
  port = await app.listen();
});

afterAll(async () => {
  await app.close();
});

interface Client {
  ws: WebSocket;
  msgs: ServerMessage[];
  snaps: SnapshotData[];
}

function open(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c: Client = { ws, msgs: [], snaps: [] };
    ws.on('message', (data, isBinary) => {
      const buf = data as Buffer;
      if (isBinary) c.snaps.push(decodeSnapshot(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
      else c.msgs.push(JSON.parse(buf.toString()) as ServerMessage);
    });
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

describe('audit: a client flipping its viewport every frame sees a square of the wide side around its coin (fixed)', () => {
  it('a viewport change takes effect at most once per VIEWPORT_MIN_MS; the newest one still lands', async () => {
    const c = await open();
    c.ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    c.ws.send(JSON.stringify({ t: 'viewport', w: 1600, h: 900 }));
    c.ws.send(JSON.stringify({ t: 'join', room: 'practice', name: 'flipper', skin: 1 }));
    await sleep(300);
    c.snaps.length = 0;
    // the cheat: a very wide window, then a very tall one, every frame (the view's height says which one the server used)
    for (let i = 0; i < 40; i++) {
      c.ws.send(JSON.stringify({ t: 'viewport', w: i % 2 ? 1000 : 2500, h: i % 2 ? 2500 : 1000 }));
      await sleep(34);
    }
    await sleep(100);
    const heights = c.snaps.map((s) => Math.round(s.view.h));
    let flips = 0;
    for (let i = 1; i < heights.length; i++) if (heights[i] !== heights[i - 1]) flips++;
    // before: the view followed every message (dozens of flips in 1.4 s); now one change, the next waits its turn
    expect(heights.length).toBeGreaterThan(20);
    expect(flips).toBeLessThanOrEqual(1);
    // the last shape asked for (tall) is applied when its turn comes
    await sleep(VIEWPORT_MIN_MS);
    const last = c.snaps[c.snaps.length - 1].view.h;
    expect(last).toBeGreaterThan(heights[0] * 1.5);
    c.ws.close();
  }, 15_000);
});
