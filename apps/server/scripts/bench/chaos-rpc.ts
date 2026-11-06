/**
 * A JSON-RPC proxy that misbehaves like a public RPC under load, for the bell-burst and failure drills. It forwards
 * POST bodies to `upstream` and, depending on `mode` (changeable at any time):
 *
 * - `rateLimitRps`: a token bucket per proxy (every call of a JSON-RPC batch costs one token); over it the whole
 *   request answers HTTP 429 (no Retry-After, like Robinhood Chain's public RPC);
 * - `random429`: that share of requests answers 429 anyway;
 * - `latencyMs` on every request, and `spikePct` of requests wait `spikeMs` more;
 * - `down`: every request fails at the socket (connection reset), as with an RPC that is offline;
 * - `dropSendResponseOnce`: the next `eth_sendRawTransaction` IS forwarded (the transaction lands) but the answer
 *   is a 502: the ambiguous send a nonce/double-pay bug would trip over.
 *
 * Counts requests, calls per method, 429s, resets and dropped answers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ChaosMode {
  rateLimitRps: number;
  random429: number;
  latencyMs: number;
  spikePct: number;
  spikeMs: number;
  down: boolean;
  dropSendResponseOnce: boolean;
}

export const CLEAN: ChaosMode = { rateLimitRps: 0, random429: 0, latencyMs: 0, spikePct: 0, spikeMs: 0, down: false, dropSendResponseOnce: false };

export interface ChaosStats {
  requests: number;
  calls: number;
  limited: number;
  resets: number;
  droppedAnswers: number;
  byMethod: Record<string, number>;
  sendRaw: number;
}

export class ChaosRpc {
  mode: ChaosMode = { ...CLEAN };
  stats: ChaosStats = ChaosRpc.fresh();
  private server: Server | null = null;
  private tokens = 0;
  private refillAt = Date.now();

  constructor(private readonly upstream: string) {}

  static fresh(): ChaosStats {
    return { requests: 0, calls: 0, limited: 0, resets: 0, droppedAnswers: 0, byMethod: {}, sendRaw: 0 };
  }

  resetStats(): ChaosStats {
    const s = this.stats;
    this.stats = ChaosRpc.fresh();
    return s;
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    const a = this.server.address();
    return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }

  close(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private take(n: number): boolean {
    const rps = this.mode.rateLimitRps;
    if (!(rps > 0)) return true;
    const now = Date.now();
    this.tokens = Math.min(rps, this.tokens + ((now - this.refillAt) / 1000) * rps);
    this.refillAt = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    this.stats.requests++;
    let calls: { method?: string }[] = [];
    try {
      const j = JSON.parse(body);
      calls = Array.isArray(j) ? j : [j];
    } catch {
      /* forwarded as is */
    }
    this.stats.calls += calls.length;
    for (const c of calls) this.stats.byMethod[c.method ?? '?'] = (this.stats.byMethod[c.method ?? '?'] ?? 0) + 1;
    const m = this.mode;
    if (m.down) {
      this.stats.resets++;
      req.socket.destroy();
      return;
    }
    const wait = m.latencyMs + (Math.random() < m.spikePct ? m.spikeMs : 0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (Math.random() < m.random429 || !this.take(Math.max(1, calls.length))) {
      this.stats.limited++;
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('Rate Limit Exceeded');
      return;
    }
    const isSend = calls.some((c) => c.method === 'eth_sendRawTransaction');
    if (isSend) this.stats.sendRaw++;
    let up: Response;
    try {
      up = await fetch(this.upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    } catch {
      this.stats.resets++;
      req.socket.destroy();
      return;
    }
    const text = await up.text();
    if (isSend && m.dropSendResponseOnce) {
      m.dropSendResponseOnce = false;
      this.stats.droppedAnswers++;
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Bad Gateway');
      return;
    }
    res.writeHead(up.status, { 'content-type': 'application/json' });
    res.end(text);
  }
}
