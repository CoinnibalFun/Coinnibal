import type { ProfileSummary, ServerMessage } from '@coinnibal/shared';
import { WebSocket } from 'ws';
import type { Player } from '../game/entities';
import { wsOut } from '../rooms/load';
import { ViewState } from '../rooms/visibility';
import type { RoomConn, RoomHandle } from '../rooms/handle';

let nextConnId = 1;

/** Strikes (dropped, malformed or premature messages) a connection may collect per window before it is closed. */
export const STRIKE_LIMIT = 300;
export const STRIKE_WINDOW_MS = 10_000;
/**
 * A socket whose send buffer holds more than this is closed instead of queuing more: its client stopped reading, and
 * what the server keeps sending it would otherwise pile up in memory without end. Snapshots are already skipped above
 * 768 KiB (`room.ts`, `pool.ts`), so a client that still reads never gets near it.
 */
export const SEND_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
/** `ping` messages answered at most this often per socket (the web client pings every 2 s). */
export const PING_REPLY_MIN_MS = 500;

/** A frame of a room worker held back while a reattach is answered (worker mode). */
export interface HeldFrame {
  hid: number;
  binary: boolean;
  data: Buffer;
}

/** One WebSocket client. */
export class Conn implements RoomConn {
  readonly id = nextConnId++;
  room: RoomHandle | null = null;
  player: Player | null = null;
  spectating = false;
  spectatePid: number | null = null;
  /** Last place the camera was (used while dead / spectating nobody). */
  lastCenter = { x: 0, y: 0 };
  aspect = 16 / 9;
  /** When `aspect` last changed, and a newer one waiting for its turn (`Gateway.viewport`, `VIEWPORT_MIN_MS`). */
  aspectAt = -Infinity;
  pendingAspect: number | null = null;
  aspectTimer: ReturnType<typeof setTimeout> | null = null;
  wallet: string | null = null;
  /** The page's `Origin` at the upgrade (an open-play copy of the site opens the game on a testnet); null without one. */
  origin: string | null = null;
  /** Browser fingerprint sent with the last join (untrusted, integrity evidence only; see `isFingerprint`). */
  fp: string | null = null;
  /** The signed-in wallet's server profile (name, skin, XP); null for guests and wallets without a name. */
  profile: ProfileSummary | null = null;
  helloed = false;
  /** `hello` messages received: only the first is answered (a `welcome` is far larger than a `hello`). */
  hellos = 0;
  /** When the last `ping` was answered (`PING_REPLY_MIN_MS`). */
  lastPongAt = 0;
  joining = false;
  /** Name used for chat while dead/spectating after having played. */
  lastName: string | null = null;
  lastSkin = 0;
  lastChatAt = 0;
  lastEmoteAt = 0;
  /** The client has the full standings sheet open (`standings` on): it gets `standings` with the leaderboard. */
  standings = false;
  readonly view = new ViewState();
  /**
   * Worker mode: a reattach on its way to a room worker. Frames of the room it leaves and of the one
   * it asks for wait here until the worker answers; then one side is delivered and the other dropped.
   */
  pendingReattach: { old: RoomHandle | null; target: RoomHandle; held: HeldFrame[] } | null = null;
  /** Worker mode: who plays the current game (the power-up rules need it on this thread). */
  game: { wallet: string | null; holder: boolean } | null = null;
  /** Worker mode: the room worker was told this socket is backed up (it skips snapshots). */
  slowSent = false;

  private tokens = 120;
  private lastRefill = Date.now();
  /** Separate, much smaller budget for messages that hit the chain RPC (auth, stake joins). */
  private chainTokens = 6;
  private chainRefill = Date.now();

  /** The last message from the client (Unix ms): an idle lobby guest is the first to go when the server is full. */
  lastMsgAt = Date.now();
  /**
   * When it last played (Unix ms): its admission, a join that seated it, an input while its coin is alive. A signed-in
   * lobby socket that has not played for `IDLE_SIGNED_MS` gives its slot to a newcomer at the cap; pings and lobby
   * messages do not move it.
   */
  playedAt = Date.now();
  /** Counted in its IP's and subnet's guest limit (until it signs in: signed-in sockets have a far higher bound). */
  countedAsGuest = true;
  /** Counted in its IP's signed-in bound (`SIGNED_PER_IP_FACTOR`). */
  countedAsSigned = false;
  /** Admitted with a session token that holds a live arena stake (the reserve is theirs). */
  priority: 'stake' | 'signed' | null = null;
  /**
   * The wallet (lower case) whose session token admitted this socket at the upgrade: it counts under that wallet for
   * `SOCKETS_PER_WALLET` for its whole life (a `logout` or a sign-in as another wallet does not free the slot).
   */
  admitSlot: string | null = null;
  /** The wallet (lower case) of its sign-in (`auth`) when that is not `admitSlot`: it counts under it too, until it signs out. */
  walletSlot: string | null = null;
  /** Admitted past `MAX_CONNECTIONS` on the stake path without a socket of its own to swap: its wallet's one extra slot. */
  headroom = false;

  constructor(
    readonly ws: WebSocket,
    readonly ip: string,
  ) {}

  /** Token bucket: ~90 messages/s sustained, bursts up to 120. */
  allow(cost = 1, now = Date.now()): boolean {
    this.tokens = Math.min(120, this.tokens + ((now - this.lastRefill) / 1000) * 90);
    this.lastRefill = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  private strikes = 0;
  private strikeWindow = 0;

  /**
   * Abuse counter: a message dropped by the rate limit, a malformed one or one before `hello`. True when the
   * connection passed `STRIKE_LIMIT` strikes within `STRIKE_WINDOW_MS` and should be closed (a client that floods
   * or speaks garbage; a real client never gets near it).
   */
  strike(now = Date.now()): boolean {
    if (now - this.strikeWindow > STRIKE_WINDOW_MS) {
      this.strikeWindow = now;
      this.strikes = 0;
    }
    return ++this.strikes > STRIKE_LIMIT;
  }

  /** RPC-touching ops: bursts of 6, then one every 2 s (an RPC call per message would be an amplifier). */
  allowChainOp(now = Date.now()): boolean {
    this.chainTokens = Math.min(6, this.chainTokens + (now - this.chainRefill) / 2000);
    this.chainRefill = now;
    if (this.chainTokens < 1) return false;
    this.chainTokens -= 1;
    return true;
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: ServerMessage): void {
    if (this.open) this.sendText(JSON.stringify(msg));
  }

  /** A message already serialised (a room's broadcast stringifies once for every viewer). */
  sendText(json: string): void {
    if (!this.open || !this.canSend()) return;
    wsOut.bytes += json.length;
    wsOut.msgs++;
    this.ws.send(json);
  }

  sendBinary(buf: ArrayBuffer): void {
    if (!this.open || !this.canSend()) return;
    wsOut.bytes += buf.byteLength;
    wsOut.msgs++;
    this.ws.send(buf, { binary: true });
  }

  /** False, and the socket is closed, when its send buffer is over `SEND_BUFFER_MAX_BYTES` (every send checks it). */
  canSend(): boolean {
    if (this.ws.bufferedAmount <= SEND_BUFFER_MAX_BYTES) return true;
    if (this.ws.readyState <= WebSocket.OPEN) {
      wsOut.overflow++;
      this.ws.terminate();
    }
    return false;
  }

  get buffered(): number {
    return this.ws.bufferedAmount;
  }
}
