/**
 * Stress-test client process (spawned by `stress.ts`). Every socket speaks the real protocol like the web client:
 * `hello`, `viewport`, `auth` with a session token (arena players), `join`, a binary target up to 30 times a second,
 * `ping` every 2 s, a rejoin after a death or a bell, and on a close the web client's reconnect (0.5 s, 1 s, 2 s,
 * 4 s, then every 8 s; `retryDelay` in apps/web/src/game/net.ts; never after `CLOSE_REPLACED`). Each socket sends its
 * own address as X-Forwarded-For (the server trusts one hop, as behind Caddy).
 *
 * Measured per window (answered on `{ t: 'stats' }`, which starts a new window): sockets open / playing, bytes and
 * frames in, the interval between snapshots, the ping round trip, join latency (join sent to `joined`), the downtime
 * of a reconnect (close to `joined` again), errors by code, closes by code and refused upgrades by HTTP status.
 *
 * IPC from the parent: `{ t: 'add', url, specs, spreadMs }`, `{ t: 'stats' }`, `{ t: 'drop', n, room? }` (terminates n
 * sockets for good, of that join target only if given: a mass disconnect), `{ t: 'slow', n }` (n sockets stop reading: slow clients),
 * `{ t: 'url', url }` (where reconnects go), `{ t: 'stop' }`.
 */
import { PROTOCOL_VERSION, encodeTarget } from '@coinnibal/shared';
import WebSocket from 'ws';

export interface StressSpec {
  /** Join target: `practice`, `arena:<id>`, `arena:<id>:test`, `private:<code>`. */
  room: string;
  token?: string;
  ip: string;
  /** Reconnect after a close (default true). */
  reconnect?: boolean;
  /** Only connect (no join): an idle lobby socket. */
  idle?: boolean;
}

/** A histogram with 1 ms buckets 0..HIST-1 (the last bucket is HIST-1 and above). */
export type Hist = number[];

export interface StressStats {
  clients: number;
  open: number;
  playing: number;
  secs: number;
  bytesIn: number;
  framesIn: number;
  snapHist: Hist;
  rttHist: Hist;
  joinHist: Hist;
  downHist: Hist;
  joins: number;
  reconnects: number;
  errors: Record<string, number>;
  closes: Record<string, number>;
  refused: Record<string, number>;
  /** Wall-clock times (Unix ms) of the arena bells (`roundOver`) this window, one per second at most. */
  bells: number[];
}

const HIST = 10_000;
const STEER_MS = 33;
const PING_MS = 2000;
const CLOSE_REPLACED = 4000;
const retryDelay = (attempt: number): number => Math.min(8000, 500 * 2 ** Math.max(0, attempt - 1));

interface Client {
  spec: StressSpec;
  ws: WebSocket | null;
  dead: boolean;
  playing: boolean;
  lastBin: number;
  joinSentAt: number;
  downSince: number;
  retry: number;
  bounds: { x0: number; y0: number; w: number; h: number };
  aim: { x: number; y: number };
  wp: { x: number; y: number };
  wpUntil: number;
}

let url = '';
let win = fresh();
let winAt = performance.now();
const clients: Client[] = [];
const buf = new ArrayBuffer(9);

function fresh(): StressStats {
  const h = () => new Array(HIST).fill(0);
  return { clients: 0, open: 0, playing: 0, secs: 0, bytesIn: 0, framesIn: 0, snapHist: h(), rttHist: h(), joinHist: h(), downHist: h(), joins: 0, reconnects: 0, errors: {}, closes: {}, refused: {}, bells: [] };
}
const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
const rec = (h: Hist, ms: number) => h[Math.max(0, Math.min(HIST - 1, Math.round(ms)))]++;

function sendJoin(c: Client): void {
  const ws = c.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || c.spec.idle) return;
  c.joinSentAt = performance.now();
  ws.send(JSON.stringify({ t: 'join', room: c.spec.room, name: `stress${Math.floor(Math.random() * 1e4)}`, skin: Math.floor(Math.random() * 4) }));
}

function open(c: Client): void {
  if (c.dead) return;
  const ws = new WebSocket(url, { perMessageDeflate: false, headers: { 'X-Forwarded-For': c.spec.ip } });
  c.ws = ws;
  ws.binaryType = 'arraybuffer';
  ws.on('unexpected-response', (_req, res) => {
    bump(win.refused, `http:${res.statusCode}`);
    res.resume();
    ws.terminate();
  });
  ws.on('open', () => {
    c.retry = 0;
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    ws.send(JSON.stringify({ t: 'viewport', w: 1600, h: 900 }));
    if (c.spec.token) ws.send(JSON.stringify({ t: 'auth', token: c.spec.token }));
    else sendJoin(c);
  });
  ws.on('message', (data: ArrayBuffer | Buffer, isBinary: boolean) => {
    const now = performance.now();
    win.bytesIn += data instanceof ArrayBuffer ? data.byteLength : data.length;
    win.framesIn++;
    if (isBinary) {
      if (c.lastBin > 0 && c.playing) rec(win.snapHist, now - c.lastBin);
      c.lastBin = now;
      return;
    }
    let m: { t: string; code?: string; ts?: number; opensAt?: number; room?: { width: number; height: number; x0?: number; y0?: number; code?: string } };
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (m.t) {
      case 'authed':
        sendJoin(c);
        break;
      case 'pong':
        if (typeof m.ts === 'number' && m.ts > 0) rec(win.rttHist, now - m.ts);
        break;
      case 'joined': {
        win.joins++;
        if (c.joinSentAt > 0) rec(win.joinHist, now - c.joinSentAt);
        if (c.downSince > 0) rec(win.downHist, now - c.downSince);
        c.joinSentAt = 0;
        c.downSince = 0;
        c.playing = true;
        c.lastBin = 0;
        const r = m.room!;
        // a new private room: its people come back to the same code, as invited friends do
        if (c.spec.room === 'private:NEW' && r.code) c.spec.room = `private:${r.code}`;
        c.bounds = { x0: r.x0 ?? 0, y0: r.y0 ?? 0, w: r.width, h: r.height };
        c.wpUntil = 0;
        break;
      }
      case 'roundOver': {
        const t = Date.now();
        if (!win.bells.some((b) => Math.abs(b - t) < 1000)) win.bells.push(t);
        c.playing = false;
        setTimeout(() => sendJoin(c), 1000 + Math.random() * 1500).unref();
        break;
      }
      case 'death':
      case 'cashout':
      case 'room_closed':
        c.playing = false;
        setTimeout(() => sendJoin(c), 1000 + Math.random() * 1500).unref();
        break;
      case 'error': {
        const code = m.code ?? '?';
        bump(win.errors, code);
        c.playing = false;
        const wait = code === 'round_closed' && m.opensAt ? Math.max(1000, m.opensAt - Date.now() + 200 + Math.random() * 800) : 3000 + Math.random() * 2000;
        if (code === 'room_full' && c.spec.room.startsWith('private:')) c.spec.room = 'practice';
        setTimeout(() => sendJoin(c), wait).unref();
        break;
      }
    }
  });
  ws.on('error', (err) => bump(win.errors, `ws:${(err as Error).message.slice(0, 60)}`));
  ws.on('close', (code) => {
    bump(win.closes, String(code));
    if (c.ws === ws) c.ws = null;
    c.playing = false;
    if (c.dead || c.spec.reconnect === false || code === CLOSE_REPLACED) return;
    if (c.downSince === 0) c.downSince = performance.now();
    win.reconnects++;
    setTimeout(() => open(c), retryDelay(++c.retry)).unref();
  });
}

// one timer for every socket of the process (a timer per socket costs more than the sockets)
setInterval(() => {
  const now = performance.now();
  for (const c of clients) {
    const ws = c.ws;
    if (!c.playing || !ws || ws.readyState !== WebSocket.OPEN) continue;
    if (now >= c.wpUntil) {
      c.wp = { x: c.bounds.x0 + Math.random() * c.bounds.w, y: c.bounds.y0 + Math.random() * c.bounds.h };
      c.wpUntil = now + 1500 + Math.random() * 2500;
    }
    c.aim.x += (c.wp.x - c.aim.x) * 0.2 + (Math.random() - 0.5) * 30;
    c.aim.y += (c.wp.y - c.aim.y) * 0.2 + (Math.random() - 0.5) * 30;
    ws.send(encodeTarget(c.aim.x, c.aim.y, buf));
  }
}, STEER_MS);
setInterval(() => {
  for (const c of clients) if (c.ws?.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
}, PING_MS);

process.on('message', (msg: { t: string; url?: string; specs?: StressSpec[]; spreadMs?: number; n?: number; room?: string }) => {
  if (msg.t === 'add') {
    url = msg.url ?? url;
    const specs = msg.specs ?? [];
    const spread = msg.spreadMs ?? specs.length * 8;
    specs.forEach((spec, i) => {
      const c: Client = { spec, ws: null, dead: false, playing: false, lastBin: 0, joinSentAt: 0, downSince: 0, retry: 0, bounds: { x0: 0, y0: 0, w: 4000, h: 4000 }, aim: { x: 0, y: 0 }, wp: { x: 0, y: 0 }, wpUntil: 0 };
      clients.push(c);
      setTimeout(() => open(c), specs.length > 1 ? (i * spread) / specs.length : 0);
    });
  } else if (msg.t === 'url') {
    url = msg.url ?? url;
  } else if (msg.t === 'stats') {
    const now = performance.now();
    win.secs = (now - winAt) / 1000;
    win.clients = clients.filter((c) => !c.dead).length;
    win.open = clients.filter((c) => c.ws?.readyState === WebSocket.OPEN).length;
    win.playing = clients.filter((c) => c.playing).length;
    process.send!({ t: 'stats', stats: win });
    win = fresh();
    winAt = now;
  } else if (msg.t === 'drop') {
    let n = msg.n ?? 0;
    for (const c of clients) {
      if (n <= 0) break;
      if (c.dead || !c.ws || (msg.room !== undefined && c.spec.room !== msg.room)) continue;
      c.dead = true;
      c.ws.terminate();
      n--;
    }
  } else if (msg.t === 'slow') {
    let n = msg.n ?? 0;
    for (const c of clients) {
      if (n <= 0) break;
      const sock = (c.ws as unknown as { _socket?: { pause(): void } } | null)?._socket;
      if (c.dead || !c.playing || !sock) continue;
      // stops reading: the server's send buffer for it grows until it closes the socket
      sock.pause();
      c.dead = true;
      n--;
    }
  } else if (msg.t === 'stop') {
    for (const c of clients) {
      c.dead = true;
      c.ws?.terminate();
    }
    setTimeout(() => process.exit(0), 200);
  }
});
