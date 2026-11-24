/**
 * Cheating audit: malicious clients against the real app and the authoritative rooms. Each block is one finding
 * (confirmed against the code before its fix) or a check that a cheat a modified client could try is refused.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, RULES, TICK_MS, decodeSnapshot, speedForRadius, type ServerMessage, type SnapshotData } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { mulberry32 } from '../src/game/rng';
import { World } from '../src/game/world';
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

describe('audit: server authority over movement and actions (checked, clean)', () => {
  const world = () => new World({ width: 4000, height: 4000, foodTarget: 0, virusTarget: 0, maxPowerUps: 0, powerUps: false, coinRain: false, seed: 7 });

  it('no stream of inputs moves a coin faster than its size allows: spam, flips, huge and invalid aims', () => {
    const w = world();
    const p = w.addPlayer({ name: 'speeder', skin: 1, x: 2000, y: 2000, mass: 30, spawnShield: false });
    const cap = speedForRadius(p.cells[0].r) * (TICK_MS / 1000) + 1e-9;
    const rng = mulberry32(3);
    for (let t = 0; t < 300; t++) {
      const c = p.cells[0];
      const before = { x: c.x, y: c.y };
      // a modified client: dozens of aims per tick, far away, flipping, non-finite and huge
      for (let k = 0; k < 40; k++) {
        const r = rng();
        if (r < 0.2) w.setTarget(p.id, Number.NaN, Infinity);
        else if (r < 0.4) w.setTarget(p.id, 3.4e38 * (rng() < 0.5 ? 1 : -1), -3.4e38);
        else w.setTarget(p.id, c.x + (rng() - 0.5) * 1e6, c.y + (rng() - 0.5) * 1e6);
      }
      w.tick(TICK_MS);
      expect(Math.hypot(c.x - before.x, c.y - before.y)).toBeLessThanOrEqual(cap);
      expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
      // the aim never leaves the world by more than its margin
      expect(Math.abs(p.targetX - 2000)).toBeLessThanOrEqual(2000 + 2000);
    }
  });

  it('split and eject spam: two splits a tick at most, one eject per cooldown, never past 16 pieces', () => {
    const w = world();
    const p = w.addPlayer({ name: 'spammer', skin: 1, x: 2000, y: 2000, mass: 4000, spawnShield: false });
    w.setTarget(p.id, 3000, 2000);
    for (let t = 0; t < 30; t++) {
      const cells = p.cells.length;
      for (let k = 0; k < 50; k++) w.queueSplit(p.id);
      w.tick(TICK_MS);
      // each split pass at most doubles the pieces
      expect(p.cells.length).toBeLessThanOrEqual(Math.min(RULES.maxCells, cells * 4));
    }
    expect(p.cells.length).toBeLessThanOrEqual(RULES.maxCells);
    const t0 = w.now;
    for (let t = 0; t < 30; t++) {
      for (let k = 0; k < 50; k++) w.queueEject(p.id);
      w.tick(TICK_MS);
    }
    const ejectRounds = Math.floor((w.now - t0) / RULES.ejectCooldownMs) + 1;
    // one eject per cell per cooldown, however many the client sends
    expect(w.ejects.length).toBeLessThanOrEqual(ejectRounds * RULES.maxCells);
  });
});

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
