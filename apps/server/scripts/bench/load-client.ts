/**
 * Load-test client process (spawned by `load.ts`): opens one WebSocket per spec, speaks the real
 * protocol (hello, auth with a session token, join), steers like the web client (a binary target up
 * to 30 times a second, `encodeTarget`), rejoins after a death or a bell, and measures what each
 * client sees: bytes and messages received and the interval between snapshots (binary frames).
 *
 * Messages from the parent (IPC): `{ t: 'start', url, specs }`, `{ t: 'stats' }` (answers with the
 * window's figures and starts a new window), `{ t: 'stop' }`.
 */
import { PROTOCOL_VERSION, encodeTarget } from '@coinnibal/shared';
import WebSocket from 'ws';

export interface ClientSpec {
  /** Join target: `practice`, `arena:<id>`, `private:<code>`. */
  room: string;
  /** Session token (arena players sign in). */
  token?: string;
}

export interface ClientStats {
  clients: number;
  open: number;
  playing: number;
  secs: number;
  bytesIn: number;
  binIn: number;
  textIn: number;
  /** Snapshot intervals: histogram with 1 ms buckets (0..999, the last bucket is 999+). */
  hist: number[];
  joins: number;
  errors: Record<string, number>;
}

const HIST = 1000;
const STEER_MS = 33;

interface Client {
  ws: WebSocket;
  spec: ClientSpec;
  playing: boolean;
  lastBin: number;
  bounds: { x0: number; y0: number; w: number; h: number };
  aim: { x: number; y: number };
  wp: { x: number; y: number };
  wpUntil: number;
  steer: NodeJS.Timeout | null;
  buf: ArrayBuffer;
}

let window = fresh(0);
let windowAt = performance.now();
const clients: Client[] = [];

function fresh(n: number): ClientStats {
  return { clients: n, open: 0, playing: 0, secs: 0, bytesIn: 0, binIn: 0, textIn: 0, hist: new Array(HIST).fill(0), joins: 0, errors: {} };
}

function connect(url: string, spec: ClientSpec): Client {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  const c: Client = {
    ws,
    spec,
    playing: false,
    lastBin: 0,
    bounds: { x0: 0, y0: 0, w: 4000, h: 4000 },
    aim: { x: 0, y: 0 },
    wp: { x: 0, y: 0 },
    wpUntil: 0,
    steer: null,
    buf: new ArrayBuffer(9),
  };
  const join = () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'join', room: spec.room, name: `load${Math.floor(Math.random() * 1e4)}`, skin: Math.floor(Math.random() * 4) }));
  };
  ws.binaryType = 'arraybuffer';
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    ws.send(JSON.stringify({ t: 'viewport', w: 1600, h: 900 }));
    if (spec.token) ws.send(JSON.stringify({ t: 'auth', token: spec.token }));
    else join();
  });
  ws.on('message', (data: ArrayBuffer | Buffer, isBinary: boolean) => {
    const now = performance.now();
    const len = data instanceof ArrayBuffer ? data.byteLength : data.length;
    window.bytesIn += len;
    if (isBinary) {
      window.binIn++;
      if (c.lastBin > 0 && c.playing) window.hist[Math.min(HIST - 1, Math.round(now - c.lastBin))]++;
      c.lastBin = now;
      return;
    }
    window.textIn++;
    let m: { t: string; code?: string; room?: { width: number; height: number; x0?: number; y0?: number }; opensAt?: number };
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (m.t) {
      case 'authed':
        join();
        break;
      case 'joined': {
        window.joins++;
        c.playing = true;
        c.lastBin = 0;
        const r = m.room!;
        c.bounds = { x0: r.x0 ?? 0, y0: r.y0 ?? 0, w: r.width, h: r.height };
        c.wpUntil = 0;
        break;
      }
      case 'death':
      case 'roundOver':
      case 'cashout':
        c.playing = false;
        setTimeout(join, 1000 + Math.random() * 1500).unref();
        break;
      case 'error': {
        const code = m.code ?? '?';
        window.errors[code] = (window.errors[code] ?? 0) + 1;
        c.playing = false;
        // closed arena joins: retry when the next round opens; anything else after a few seconds
        const wait = code === 'round_closed' && m.opensAt ? Math.max(1000, m.opensAt - Date.now() + 500) : 3000 + Math.random() * 2000;
        if (code === 'room_full' && spec.room.startsWith('private:')) spec.room = 'practice';
        setTimeout(join, wait).unref();
        if (code === 'round_closed') ws.send(JSON.stringify({ t: 'spectate' }));
        break;
      }
    }
  });
  ws.on('error', (err) => {
    window.errors[`ws:${(err as Error).message}`] = (window.errors[`ws:${(err as Error).message}`] ?? 0) + 1;
  });
  c.steer = setInterval(() => {
    if (!c.playing || ws.readyState !== ws.OPEN) return;
    const now = performance.now();
    if (now >= c.wpUntil) {
      c.wp = { x: c.bounds.x0 + Math.random() * c.bounds.w, y: c.bounds.y0 + Math.random() * c.bounds.h };
      c.wpUntil = now + 1500 + Math.random() * 2500;
    }
    // a hand on a mouse: the aim drifts toward the waypoint with a little wobble
    c.aim.x += (c.wp.x - c.aim.x) * 0.2 + (Math.random() - 0.5) * 30;
    c.aim.y += (c.wp.y - c.aim.y) * 0.2 + (Math.random() - 0.5) * 30;
    ws.send(encodeTarget(c.aim.x, c.aim.y, c.buf));
  }, STEER_MS);
  return c;
}

process.on('message', (msg: { t: string; url?: string; specs?: ClientSpec[] }) => {
  if (msg.t === 'start') {
    const specs = msg.specs ?? [];
    // spread the connects over a moment (a burst of hundreds of handshakes is not what a server sees)
    specs.forEach((s, i) => setTimeout(() => clients.push(connect(msg.url!, s)), i * 8));
    window = fresh(specs.length);
    windowAt = performance.now();
  } else if (msg.t === 'stats') {
    const now = performance.now();
    window.secs = (now - windowAt) / 1000;
    window.clients = clients.length;
    window.open = clients.filter((c) => c.ws.readyState === WebSocket.OPEN).length;
    window.playing = clients.filter((c) => c.playing).length;
    process.send!({ t: 'stats', stats: window });
    window = fresh(clients.length);
    windowAt = now;
  } else if (msg.t === 'stop') {
    for (const c of clients) {
      if (c.steer) clearInterval(c.steer);
      c.ws.terminate();
    }
    setTimeout(() => process.exit(0), 200);
  }
});
