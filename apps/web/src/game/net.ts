import { CLOSE_REPLACED, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@coinnibal/shared';
import type { NetDown } from '../store';

/** The game's WebSocket subprotocol (the server answers with it; it never echoes the token one). */
const SUBPROTOCOL = 'coinnibal';
/** The session token rides in a second subprotocol, never in the URL (no proxy or access log sees it). */
const AUTH_SUBPROTOCOL = 'coinnibal.auth.';
/** A subprotocol must be an HTTP token: a session token (`0x….exp.iat.mac`, base64url) always is. */
const TOKEN_CHARS = /^[A-Za-z0-9._~-]{1,512}$/;

/**
 * The subprotocols a socket offers: `coinnibal` alone for a guest, plus `coinnibal.auth.<token>` when signed in, so a
 * signed-in player gets the server's reserved slots (and its live arena coin back) before any message is sent.
 */
export function gameProtocols(token: string | null | undefined): string[] {
  return token && TOKEN_CHARS.test(token) ? [SUBPROTOCOL, AUTH_SUBPROTOCOL + token] : [SUBPROTOCOL];
}

/** No frame and no pong for this long: the socket is dead even if the browser has not noticed; close and reconnect. */
export const WATCHDOG_MS = 4_000;
/** The ping (the server answers `pong`; the watchdog hears it even when no snapshots flow). */
const PING_MS = 2_000;
/** How often the watchdog looks. */
const WATCH_EVERY_MS = 500;

export type { NetDown } from '../store';

export interface NetHandlers {
  onOpen(): void;
  onClose(down: NetDown): void;
  onMessage(msg: ServerMessage): void;
  /** A binary snapshot as received (the engine applies it straight into the world: `ClientWorld.applyBinary`). */
  onSnapshot(buf: ArrayBuffer): void;
}

/** The reconnect backoff: 0.5 s, 1 s, 2 s, 4 s, then every 8 s. */
export const retryDelay = (attempt: number): number => Math.min(8000, 500 * 2 ** Math.max(0, attempt - 1));

/** ±25 % around `ms`: after a server restart a thousand clients must not all knock in the same instant. */
export const jitter = (ms: number, rand: () => number = Math.random): number => Math.round(ms * (0.75 + 0.5 * rand()));

/**
 * WebSocket with automatic reconnect, JSON + binary routing, ping, and a watchdog: a phone that changed networks (or
 * a path that went silent) keeps a socket the browser still thinks is open for a long time; when nothing at all
 * arrived for `WATCHDOG_MS` the socket is dropped and a new one opened. A close with `CLOSE_REPLACED` is not
 * reconnected (two tabs would take the coin from each other forever): the player chooses with `resume`.
 */
export class Net {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  private pingTimer: number | null = null;
  private watchTimer: number | null = null;
  /** The pending reconnect after a drop (cleared by `close`: a closed engine stays offline). */
  private retryTimer: number | null = null;
  /** The last frame, message or pong from the server (`performance.now()`). */
  private lastHeard = 0;
  rtt = 0;

  constructor(
    private readonly url: string,
    private readonly handlers: NetHandlers,
    private readonly watchdogMs = WATCHDOG_MS,
    /** The session token to offer when a socket opens (read at each connect: a sign-in counts from the next one). */
    private readonly token: () => string | null | undefined = () => null,
  ) {}

  connect(): void {
    this.retryTimer = null;
    this.closedByUser = false;
    const ws = new WebSocket(this.url, gameProtocols(this.token()));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.lastHeard = performance.now();
      this.send({ t: 'hello', v: PROTOCOL_VERSION });
      this.handlers.onOpen();
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', ts: performance.now() }), PING_MS);
      this.watchTimer = window.setInterval(() => this.watch(), WATCH_EVERY_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastHeard = performance.now();
      if (typeof ev.data === 'string') {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === 'pong') this.rtt = Math.max(0, performance.now() - msg.ts);
        this.handlers.onMessage(msg);
      } else {
        try {
          this.handlers.onSnapshot(ev.data as ArrayBuffer);
        } catch (err) {
          console.warn('bad snapshot', err);
        }
      }
    };
    ws.onclose = (ev?: CloseEvent) => {
      if (this.ws !== ws) return;
      this.down(ev?.code === CLOSE_REPLACED ? 'replaced' : 'lost');
    };
    ws.onerror = () => ws.close();
  }

  /** Nothing heard for too long: give up on this socket now (its own close may take minutes to come). */
  private watch(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (performance.now() - this.lastHeard < this.watchdogMs) return;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    if (this.ws === ws) this.down('lost');
  }

  /** The socket is gone: stop its timers, tell the engine, and schedule the next attempt (unless replaced or closed). */
  private down(kind: NetDown['kind']): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.pingTimer = null;
    this.watchTimer = null;
    this.ws = null;
    if (this.closedByUser) {
      this.handlers.onClose({ kind, attempt: this.retry, retryAt: null });
      return;
    }
    if (kind === 'replaced') {
      this.retry = 0;
      this.handlers.onClose({ kind, attempt: 0, retryAt: null });
      return;
    }
    const delay = jitter(retryDelay(++this.retry));
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
    this.handlers.onClose({ kind, attempt: this.retry, retryAt: performance.now() + delay });
  }

  /** Reconnects now (after `replaced`: "Play here"; or "Retry now" while waiting). */
  resume(): void {
    if (this.ws) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.connect();
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): void {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }

  sendBinary(buf: ArrayBuffer): void {
    if (this.open) this.ws!.send(buf);
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
  }
}
