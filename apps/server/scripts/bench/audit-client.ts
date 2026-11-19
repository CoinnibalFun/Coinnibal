/**
 * Load-audit client process (spawned by `audit-load.ts`). Like `load-client.ts` (hello, auth with a session
 * token, join, a binary target up to 30 times a second, rejoin after a death or a bell) plus what real players
 * do on top: split (about every 6 s while playing), eject mass (about every 10 s) and chat (about every 30 s).
 * Counts bytes and frames received per room kind and the interval between snapshots.
 *
 * IPC from the parent: `{ t: 'start', url, specs }`, `{ t: 'stats' }` (answers and starts a new window),
 * `{ t: 'stop' }`.
 */
import { PROTOCOL_VERSION, encodeEject, encodeSplit, encodeTarget } from '@coinnibal/shared';
import WebSocket from 'ws';

export interface AuditSpec {
  /** `practice`, `arena:<id>`, `private:<code>`. */
  room: string;
  token?: string;
  /** Sent as X-Forwarded-For (the bench server trusts one hop, as behind Caddy). */
  ip?: string;
}

export interface AuditStats {
  clients: number;
  open: number;
  playing: number;
  secs: number;
  bytesIn: number;
  framesIn: number;
  /** Bytes received by kind of room the client was in (`arena`, `practice`, `other`). */
  bytesByKind: Record<string, number>;
  clientsByKind: Record<string, number>;
  hist: number[];
  joins: number;
  deaths: number;
  splits: number;
  ejects: number;
  chats: number;
  chatsIn: number;
  errors: Record<string, number>;
}

const HIST = 1000;
const STEER_MS = 33;
const CHAT_LINES = ['gg', 'nice one', 'who is in the lead?', 'split me if you can', 'lol', 'one more round', 'good luck all'];

interface Client {
  ws: WebSocket;
  spec: AuditSpec;
  kind: string;
  playing: boolean;
  lastBin: number;
  bounds: { x0: number; y0: number; w: number; h: number };
  aim: { x: number; y: number };
  wp: { x: number; y: number };
  wpUntil: number;
  nextSplit: number;
  nextEject: number;
  nextChat: number;
  timer: NodeJS.Timeout | null;
  buf: ArrayBuffer;
}

let window = fresh(0);
let windowAt = performance.now();
const clients: Client[] = [];

function fresh(n: number): AuditStats {
  return {
    clients: n,
    open: 0,
    playing: 0,
    secs: 0,
    bytesIn: 0,
    framesIn: 0,
    bytesByKind: {},
    clientsByKind: {},
    hist: new Array(HIST).fill(0),
    joins: 0,
    deaths: 0,
    splits: 0,
    ejects: 0,
    chats: 0,
    chatsIn: 0,
    errors: {},
  };
}

const kindOf = (room: string) => (room.startsWith('arena:') ? 'arena' : room === 'practice' ? 'practice' : 'other');
const jitter = (base: number) => base * (0.5 + Math.random());

function connect(url: string, spec: AuditSpec): Client {
  const ws = new WebSocket(url, { perMessageDeflate: false, headers: spec.ip ? { 'x-forwarded-for': spec.ip } : {} });
  const now0 = performance.now();
  const c: Client = {
    ws,
    spec,
    kind: kindOf(spec.room),
    playing: false,
    lastBin: 0,
    bounds: { x0: 0, y0: 0, w: 4000, h: 4000 },
    aim: { x: 0, y: 0 },
    wp: { x: 0, y: 0 },
    wpUntil: 0,
    nextSplit: now0 + jitter(6000),
    nextEject: now0 + jitter(10_000),
    nextChat: now0 + jitter(30_000),
    timer: null,
    buf: new ArrayBuffer(9),
  };
  const join = () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'join', room: spec.room, name: `audit${Math.floor(Math.random() * 1e4)}`, skin: Math.floor(Math.random() * 4) }));
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
    window.framesIn++;
    window.bytesByKind[c.kind] = (window.bytesByKind[c.kind] ?? 0) + len;
    if (isBinary) {
      if (c.lastBin > 0 && c.playing) window.hist[Math.min(HIST - 1, Math.round(now - c.lastBin))]++;
      c.lastBin = now;
      return;
    }
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
      case 'chat':
        window.chatsIn++;
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
        if (m.t === 'death') window.deaths++;
        c.playing = false;
        setTimeout(join, 1000 + Math.random() * 1500).unref();
        break;
      case 'error': {
        const code = m.code ?? '?';
        window.errors[code] = (window.errors[code] ?? 0) + 1;
        c.playing = false;
        const wait = code === 'round_closed' && m.opensAt ? Math.max(1000, m.opensAt - Date.now() + 500) : 3000 + Math.random() * 2000;
        setTimeout(join, wait).unref();
        if (code === 'round_closed') ws.send(JSON.stringify({ t: 'spectate' }));
        break;
      }
    }
  });
  ws.on('error', (err) => {
    const k = `ws:${(err as Error).message}`;
    window.errors[k] = (window.errors[k] ?? 0) + 1;
  });
  c.timer = setInterval(() => {
    if (!c.playing || ws.readyState !== ws.OPEN) return;
    const now = performance.now();
    if (now >= c.wpUntil) {
      c.wp = { x: c.bounds.x0 + Math.random() * c.bounds.w, y: c.bounds.y0 + Math.random() * c.bounds.h };
      c.wpUntil = now + 1500 + Math.random() * 2500;
    }
    c.aim.x += (c.wp.x - c.aim.x) * 0.2 + (Math.random() - 0.5) * 30;
    c.aim.y += (c.wp.y - c.aim.y) * 0.2 + (Math.random() - 0.5) * 30;
    ws.send(encodeTarget(c.aim.x, c.aim.y, c.buf));
    if (now >= c.nextSplit) {
      ws.send(encodeSplit());
      window.splits++;
      c.nextSplit = now + jitter(6000);
    }
    if (now >= c.nextEject) {
      ws.send(encodeEject());
      window.ejects++;
      c.nextEject = now + jitter(10_000);
    }
    if (now >= c.nextChat) {
      ws.send(JSON.stringify({ t: 'chat', text: CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)] }));
      window.chats++;
      c.nextChat = now + jitter(30_000);
    }
  }, STEER_MS);
  return c;
}

process.on('message', (msg: { t: string; url?: string; specs?: AuditSpec[] }) => {
  if (msg.t === 'start') {
    const specs = msg.specs ?? [];
    specs.forEach((s, i) => setTimeout(() => clients.push(connect(msg.url!, s)), i * 8));
    window = fresh(specs.length);
    windowAt = performance.now();
  } else if (msg.t === 'stats') {
    const now = performance.now();
    window.secs = (now - windowAt) / 1000;
    window.clients = clients.length;
    window.open = clients.filter((c) => c.ws.readyState === WebSocket.OPEN).length;
    window.playing = clients.filter((c) => c.playing).length;
    for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) window.clientsByKind[c.kind] = (window.clientsByKind[c.kind] ?? 0) + 1;
    process.send!({ t: 'stats', stats: window });
    window = fresh(clients.length);
    windowAt = now;
  } else if (msg.t === 'stop') {
    for (const c of clients) {
      if (c.timer) clearInterval(c.timer);
      c.ws.terminate();
    }
    setTimeout(() => process.exit(0), 200);
  }
});
