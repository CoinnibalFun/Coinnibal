import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  CLOSE_REPLACED,
  REFUSAL_CODES,
  PROTOCOL_VERSION,
  PlayerFlag,
  SKIN_COUNT,
  EMBLEM_SKIN_ID,
  clamp,
  decodeClientInput,
  isBasicSkin,
  isCountryCode,
  isFingerprint,
  parseJoinTarget,
  sanitizeName,
  type ErrorCode,
  type ServerMessage,
} from '@coinnibal/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Auth } from '../auth';
import { ChainBusyError, type ChainGateway, type ChainSession, type SettledEvent } from '../chain/types';
import type { ServerConfig } from '../config';
import type { ProfileStore } from '../profiles';
import type { RoomHandle } from '../rooms/handle';
import type { RoomManager } from '../rooms/manager';
import { MAX_STAKE_SESSION_AGE_S } from '../rooms/room';
import type { Journal, SettlementItem } from '../stake/journal';
import { Conn } from './conn';
import { Limiter } from './limiter';
import type { LoadShedder } from './shedder';

/** A socket that has not said a valid `hello` this long after the upgrade is closed (idle sockets cost memory). */
export const HELLO_TIMEOUT_MS = 10_000;
/** WebSocket upgrades per IP a minute (reconnect storms of a real client stay far below it). */
export const UPGRADES_PER_IP_PER_MIN = 60;
/** Guests (sockets not signed in) may hold at most this share of `MAX_CONNECTIONS`: the rest is kept for signed-in players. */
export const GUEST_SHARE = 0.8;
/** A guest with no message for this long, not playing, is idle: it is closed when a newcomer needs its slot. */
export const IDLE_GUEST_MS = 30_000;
/** Above this share of `MAX_CONNECTIONS` the heartbeat closes guests idle for `2 × IDLE_GUEST_MS` (down to the share). */
const IDLE_SWEEP_SHARE = 0.9;
/** Live-stake holders reconnecting get this much room above `MAX_CONNECTIONS` (they always get in). */
const STAKE_HEADROOM = 0.05;
/**
 * Signed-in sockets per IP: `MAX_CONNECTIONS_PER_IP` times this (64 by default). Far above a household, enough for a
 * carrier NAT address, and still a bound on one address that signs in with many throwaway wallets.
 */
export const SIGNED_PER_IP_FACTOR = 8;
/** The game's WebSocket subprotocol: the server answers with it (never with the token one). */
const SUBPROTOCOL = 'coinnibal';
/** A browser may offer its session token as a WebSocket subprotocol `coinnibal.auth.<token>` (no token in the URL). */
export const AUTH_SUBPROTOCOL = 'coinnibal.auth.';
/**
 * The same two under the project's name before the rename (Elymum, November 2026), still accepted: a tab opened before
 * the update offers them when it reconnects, and a browser refuses a socket whose server answers none of its offers.
 * The server answers with the name the page offered.
 */
const OLD_SUBPROTOCOL = 'elymum';
const OLD_AUTH_SUBPROTOCOL = 'elymum.auth.';

/**
 * The network an address belongs to for the per-subnet connection limit: IPv4 /24, IPv6 /64 (an IPv4-mapped
 * IPv6 address counts as IPv4). One provider customer usually gets a whole IPv6 /64, so a per-IP limit alone does
 * not hold there.
 */
export function subnetOf(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * How many reverse proxies in front of this server append to `X-Forwarded-For`: 0 unless `TRUST_PROXY=1`,
 * then `TRUST_PROXY_HOPS` (default 1).
 */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  if (env.TRUST_PROXY !== '1') return 0;
  const n = Math.floor(Number(env.TRUST_PROXY_HOPS ?? '1'));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 16) : 1;
}

/**
 * The client's IP. Behind `hops` trusted proxies (true = 1) it is the `hops`-th `X-Forwarded-For` entry from
 * the RIGHT: the address the outermost trusted proxy saw. Entries to its left were written by the client
 * and are never trusted (a forged left-most value would otherwise pick any rate-limit key).
 */
export function clientIp(req: IncomingMessage, hops: number | boolean): string {
  const n = hops === true ? 1 : hops === false ? 0 : hops;
  if (n > 0) {
    const fwd = req.headers['x-forwarded-for'];
    const list = (Array.isArray(fwd) ? fwd.join(',') : (fwd ?? ''))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const hop = list.length > 0 ? list[Math.max(0, list.length - n)] : undefined;
    if (hop) return hop;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * A paid join whose ticket read fails because the RPC is busy is retried after these delays (on top of
 * the RPC budget's own 429 retries); the player hears "network busy, retrying" once.
 */
export const JOIN_CHAIN_RETRY_MS = [2_000, 4_000, 8_000];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * The `settled` message for a settlement event: it names the session key (and arena) so a client
 * matches it to the ticket it paid out, and the settlement transaction (`txHash`).
 */
export function settledMessage(e: SettledEvent): Extract<ServerMessage, { t: 'settled' }> {
  const kind = e.refund ? 'refund' : e.payout > 0 ? 'payout' : 'death';
  return {
    t: 'settled',
    kind,
    session: e.key,
    ...(e.arenaId === undefined ? {} : { arenaId: e.arenaId }),
    txHash: e.txHash,
    payout: e.payout,
    // the contract took the fee from the profit: `net` reached the wallet (or waits to be collected)
    ...(e.fee === undefined ? {} : { fee: e.fee, net: e.net ?? e.payout - e.fee }),
    ...(e.burned ? { burned: e.burned } : {}),
    ...(e.toVault ? { toVault: e.toVault } : {}),
    ...(e.collect ? { collect: true } : {}),
  };
}

/** WebSocket front door: connection limits, message parsing and routing. */
export class Gateway {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
    // the session token offered as a subprotocol (`coinnibal.auth.<token>`) is never echoed back: answer `coinnibal`
    // (`elymum` to a page from before the rename)
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : protocols.has(OLD_SUBPROTOCOL) ? OLD_SUBPROTOCOL : false),
  });
  private readonly perIp = new Map<string, number>();
  private readonly perSubnet = new Map<string, number>();
  /** Signed-in sockets per IP (limited at `SIGNED_PER_IP_FACTOR` × the guest limit). */
  private readonly signedPerIp = new Map<string, number>();
  private readonly upgrades = new Limiter(UPGRADES_PER_IP_PER_MIN, 60_000);
  /** Graceful degradation (new joins shed before live rooms suffer); null: never sheds (bare unit tests). */
  private shedder: LoadShedder | null = null;
  /** Connections closed for abuse (flood, garbage, no hello), for the load test and the logs. */
  readonly dropped = { noHello: 0, flood: 0, limit: 0, idle: 0 };
  /** Sockets closed because a newer one of the same wallet took their arena coin over (`CLOSE_REPLACED`). */
  replaced = 0;
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private timers: NodeJS.Timeout[] = [];
  /** Who may enter a room (join or spectate); null: everyone (unit tests that build a bare gateway). */
  private gameGate: ((wallet: string | null, fresh?: boolean) => boolean | Promise<boolean>) | null = null;
  /** Server profiles (names, skins, XP); null: none (bare unit tests). */
  private profiles: ProfileStore | null = null;
  /** Wallets the admin banned from arenas (integrity); null: nobody (bare unit tests). */
  private banGate: ((wallet: string) => boolean) | null = null;
  /** Whether a wallet holds a Coinnibal emblem (laurel flag, emblem skin); null: nobody does. */
  private holderCheck: ((wallet: string) => Promise<boolean>) | null = null;
  /** Arenas closed for a re-price at their bell (`RepriceScheduler.closedForSeats`); absent: none. */
  private repricing: ((arenaId: number) => boolean) | null = null;
  /** The seat check of holder tickets (`EmblemGate.seat`): null to seat, else the refusal; absent: none. */
  private emblemGate: ((wallet: string, session: ChainSession) => Promise<{ code: ErrorCode; message: string } | null>) | null = null;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly rooms: RoomManager,
    private readonly auth: Auth,
    private readonly chain: ChainGateway,
    private readonly journal: Journal,
    private readonly log: (m: string) => void,
    private readonly trustProxy: number | boolean = trustProxyHops(),
  ) {
    chain.onSettled((e) => {
      for (const conn of this.rooms.connsByWallet(e.player)) {
        conn.send(settledMessage(e));
      }
    });
    // the token was set (or another status change clients must see): push the new chain status
    chain.onStatusChange(() => this.broadcastChain());
    // the journal stopped (or resumed) being writable: the lobby stops (or resumes) offering tickets
    journal.onWriteStateChange?.(() => this.broadcastChain());
  }

  /** Sets who may enter rooms (the site's game gate: admins, NFT holders, or everyone). */
  setGameGate(gate: ((wallet: string | null, fresh?: boolean) => boolean | Promise<boolean>) | null): void {
    this.gameGate = gate;
  }

  /** Sets the profile store the sign-in and joins read names from. */
  setProfiles(profiles: ProfileStore | null): void {
    this.profiles = profiles;
  }

  /** The X handle a signed-in wallet linked ("Link X"): shown by its name and tagged in kill posts. */
  private xHandleOf: ((wallet: string) => string | null) | null = null;

  setXHandles(fn: ((wallet: string) => string | null) | null): void {
    this.xHandleOf = fn;
  }

  /** Sets the emblem holder check (cached by the mint service): holders wear a laurel and may pick the emblem skin. */
  setHolderCheck(check: ((wallet: string) => Promise<boolean>) | null): void {
    this.holderCheck = check;
  }

  /** Sets which arenas take no new seat because they close for a re-price (`site/reprice.ts`). */
  setRepricing(fn: ((arenaId: number) => boolean) | null): void {
    this.repricing = fn;
  }

  /** Sets the seat check of holder tickets (one emblem token id per open holder ticket; see `site/emblem-gate.ts`). */
  setEmblemGate(gate: ((wallet: string, session: ChainSession) => Promise<{ code: ErrorCode; message: string } | null>) | null): void {
    this.emblemGate = gate;
  }

  /** Sets the load shedder (see `net/shedder.ts`). */
  setShedder(s: LoadShedder | null): void {
    this.shedder = s;
  }

  /** Sets who is banned from arena joins (the integrity ban list). Practice is never gated by it. */
  setBanGate(gate: ((wallet: string) => boolean) | null): void {
    this.banGate = gate;
  }

  /**
   * Refuses (`game_closed`) a room entry the game gate does not allow for this session. `fresh`: the
   * holder check bypasses its cache (each arena seat, i.e. every new ticket and round, re-checks it).
   */
  private async gameClosed(conn: Conn, fresh = false): Promise<boolean> {
    if (!this.gameGate) return false;
    const open = await Promise.resolve(this.gameGate(conn.wallet, fresh)).catch(() => false);
    if (open) return false;
    this.error(conn, 'game_closed', conn.wallet ? 'The game is not open to this wallet yet.' : 'The game is not open yet. Sign in with your wallet if you hold a Coinnibal NFT.');
    return true;
  }

  /** Sends the current chain status (`chain` message) to every connection past `hello`. */
  broadcastChain(): void {
    const msg = { t: 'chain', chain: this.chain.status() } as const;
    for (const c of this.rooms.conns) if (c.helloed) c.send(msg);
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== '/ws') {
        socket.destroy();
        return;
      }
      const ip = clientIp(req, this.trustProxy);
      const net = subnetOf(ip);
      const refuse = (status: string) => {
        this.dropped.limit++;
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
      };
      if (!this.accepting) {
        refuse('503 Service Unavailable');
        return;
      }
      const priority = this.priorityOf(req);
      if (!this.admit(ip, net, priority)) {
        refuse('429 Too Many Requests');
        return;
      }
      // overloaded: live games keep their budget, new sockets wait (a live stake's reconnect always gets in)
      if (priority !== 'stake' && this.shedder && !this.shedder.admitCritical()) {
        refuse('503 Service Unavailable');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip, net, priority));
    });
    // heartbeat + lobby room list
    this.timers.push(
      setInterval(() => {
        for (const ws of this.wss.clients) {
          if (this.alive.get(ws) === false) {
            ws.terminate();
            continue;
          }
          this.alive.set(ws, false);
          ws.ping();
        }
        // close to the cap: lobby guests idle for a minute make room before anyone is refused
        const max = this.cfg.maxConnections;
        while (this.rooms.conns.size > max * IDLE_SWEEP_SHARE && this.evictIdleGuest(2 * IDLE_GUEST_MS));
      }, 25_000),
      setInterval(() => {
        const msg = { t: 'rooms', rooms: this.rooms.list(), online: this.rooms.online(), blocked: this.rooms.blockedArenas() } as const;
        for (const c of this.rooms.conns) if (c.helloed && !c.player?.alive) c.send(msg);
      }, 5000),
    );
  }

  /** The server is shutting down: every new WebSocket is refused (503) from now on. */
  stopAccepting(): void {
    this.accepting = false;
  }

  private accepting = true;

  close(): void {
    this.accepting = false;
    for (const t of this.timers) clearInterval(t);
    for (const ws of this.wss.clients) ws.close(1001, 'server shutting down');
  }

  /**
   * The session token a browser offered as a subprotocol (`coinnibal.auth.<token>`): `stake` when its wallet holds a
   * live arena coin here (a reconnect: it always gets in), `signed` for any other valid session, null without one.
   */
  private priorityOf(req: IncomingMessage): 'stake' | 'signed' | null {
    const offers = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim());
    const prefix = offers.some((s) => s.startsWith(AUTH_SUBPROTOCOL)) ? AUTH_SUBPROTOCOL : OLD_AUTH_SUBPROTOCOL;
    const offered = offers.find((s) => s.startsWith(prefix));
    const wallet = offered ? this.auth.verifyToken(offered.slice(prefix.length)) : null;
    if (!wallet) return null;
    return this.rooms.holdsLiveStake(wallet) ? 'stake' : 'signed';
  }

  /** Sockets not signed in, per IP and per subnet, are limited; the whole server keeps a reserve for signed-in players. */
  private admit(ip: string, net: string, priority: 'stake' | 'signed' | null): boolean {
    const max = this.cfg.maxConnections;
    if (priority === 'stake') {
      // a ticket holder coming back: past every per-IP limit (a carrier NAT), into the headroom above the cap
      if (this.rooms.conns.size < max) return true;
      return this.evictIdleGuest(IDLE_GUEST_MS) || this.rooms.conns.size < max * (1 + STAKE_HEADROOM);
    }
    if (!this.upgrades.allow(ip)) return false;
    if (priority === 'signed') {
      if (!this.signedRoom(ip)) return false;
      return this.rooms.conns.size < max || this.evictIdleGuest(IDLE_GUEST_MS);
    }
    if ((this.perIp.get(ip) ?? 0) >= this.cfg.maxConnectionsPerIp || (this.perSubnet.get(net) ?? 0) >= this.cfg.maxConnectionsPerSubnet) return false;
    // guests use at most GUEST_SHARE of the slots; at the cap (or the guest share) an idle guest makes room
    if (this.rooms.conns.size < max && this.guestCount() < max * GUEST_SHARE) return true;
    return this.evictIdleGuest(IDLE_GUEST_MS);
  }

  /** This IP may hold one more signed-in socket. */
  private signedRoom(ip: string): boolean {
    return (this.signedPerIp.get(ip) ?? 0) < this.cfg.maxConnectionsPerIp * SIGNED_PER_IP_FACTOR;
  }

  /** The socket counts as signed in for its IP (a stake holder's reconnect is counted, never refused). */
  private countSigned(conn: Conn): void {
    if (conn.countedAsSigned) return;
    conn.countedAsSigned = true;
    this.signedPerIp.set(conn.ip, (this.signedPerIp.get(conn.ip) ?? 0) + 1);
  }

  private uncountSigned(conn: Conn): void {
    if (!conn.countedAsSigned) return;
    conn.countedAsSigned = false;
    const n = (this.signedPerIp.get(conn.ip) ?? 1) - 1;
    if (n <= 0) this.signedPerIp.delete(conn.ip);
    else this.signedPerIp.set(conn.ip, n);
  }

  private guestCount(): number {
    let n = 0;
    for (const c of this.rooms.conns) if (!c.wallet) n++;
    return n;
  }

  /** Closes the longest-idle guest (not signed in, not playing, silent for `idleMs`). False when there is none. */
  private evictIdleGuest(idleMs: number): boolean {
    const now = Date.now();
    let worst: Conn | null = null;
    for (const c of this.rooms.conns) {
      if (c.wallet || c.player?.alive || c.joining || c.ws.readyState > 1 || now - c.lastMsgAt < idleMs) continue;
      if (!worst || c.lastMsgAt < worst.lastMsgAt) worst = c;
    }
    if (!worst) return false;
    this.dropped.idle++;
    // gone from the counts now: the newcomer takes its slot at once
    this.rooms.removeConn(worst);
    this.uncountGuest(worst);
    worst.ws.close(1013, 'idle: the server is full');
    setTimeout(() => worst.ws.terminate(), 1_000).unref();
    return true;
  }

  /** The socket stops counting in its IP's and subnet's guest limit (it signed in, or it is gone). */
  private uncountGuest(conn: Conn, net = subnetOf(conn.ip)): void {
    if (!conn.countedAsGuest) return;
    conn.countedAsGuest = false;
    const n = (this.perIp.get(conn.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(conn.ip);
    else this.perIp.set(conn.ip, n);
    const s = (this.perSubnet.get(net) ?? 1) - 1;
    if (s <= 0) this.perSubnet.delete(net);
    else this.perSubnet.set(net, s);
  }

  private onConnection(ws: WebSocket, ip: string, net = subnetOf(ip), priority: 'stake' | 'signed' | null = null): void {
    const conn = new Conn(ws, ip);
    conn.priority = priority;
    // a session-token socket is not a guest: it never counts in its IP's guest limit (players behind a carrier NAT)
    if (priority) {
      conn.countedAsGuest = false;
      this.countSigned(conn);
    } else {
      this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
      this.perSubnet.set(net, (this.perSubnet.get(net) ?? 0) + 1);
    }
    this.rooms.addConn(conn);
    this.alive.set(ws, true);
    // a socket that never says hello is closed (it would hold a slot and memory for nothing)
    const helloTimer = setTimeout(() => {
      if (conn.helloed) return;
      this.dropped.noHello++;
      ws.terminate();
    }, this.cfg.wsHelloTimeoutMs ?? HELLO_TIMEOUT_MS);
    helloTimer.unref();
    ws.on('pong', () => this.alive.set(ws, true));
    ws.on('message', (data, isBinary) => {
      this.onMessage(conn, data, isBinary).catch((err) => this.log(`message handling failed: ${(err as Error).stack ?? err}`));
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.onClose(conn, net);
    });
    ws.on('error', () => {});
  }

  /** A strike against the connection (see `Conn.strike`): closed once it floods or speaks garbage for long. */
  private strike(conn: Conn): void {
    if (!conn.strike()) return;
    if (conn.ws.readyState > 1) return;
    this.dropped.flood++;
    this.log(`ws: closed a flooding connection from ${conn.ip}${conn.wallet ? ` (${conn.wallet})` : ''}`);
    conn.ws.close(1008, 'rate limit');
    setTimeout(() => conn.ws.terminate(), 1_000).unref();
  }

  private onClose(conn: Conn, net = subnetOf(conn.ip)): void {
    this.uncountGuest(conn, net);
    this.uncountSigned(conn);
    this.rooms.removeConn(conn);
    conn.room?.leave(conn, 'disconnect');
  }

  private error(conn: Conn, code: ErrorCode, message: string, extra: { opensAt?: number } = {}): void {
    conn.send({ t: 'error', code, message, ...extra });
  }

  /**
   * The returning player's ticket was settled at a bell while they were away: their till was paid.
   * The memo stays (a reload asks again) until it expires or a newer ticket is seen.
   */
  private roundEnded(conn: Conn): void {
    this.error(conn, 'round_ended', 'The round ended while you were away. Your ticket was settled at the bell.');
  }

  /**
   * New arena joins are refused from `joinsCloseAt` until the bell, and in the break after a bell
   * (`round_closed` with `opensAt` = when joins open again; the client holds the ticket until then).
   * Returns true when refused. Reconnects of a live staker never come here.
   */
  private roundClosed(conn: Conn, room: RoomHandle | null = null): boolean {
    const now = this.rooms.now();
    if (room?.opts.ownRound) {
      // a paid custom room on its own clock: one game, joins open from its start until its last minute; it never
      // opens again, so the ticket is not held for a next round (there is none): it goes back in full
      const own = this.rooms.roomWindow(room, now);
      if (now >= own.opensAt && now < own.joinsCloseAt) return false;
      this.error(conn, 'room_closed', now >= own.endsAt ? 'This room has ended.' : 'This room is in its last minute: joins are closed. Your unplayed ticket is refunded in full.');
      void this.refundUnseated(conn, room.opts.stake?.arenaId ?? -1);
      return true;
    }
    const r = this.rooms.roundWindow(now);
    if (now >= r.opensAt && now < r.joinsCloseAt) return false;
    // in the break: this round opens soon; in the last minute: the next one opens after its break
    const opensAt = now < r.opensAt ? r.opensAt : this.rooms.roundWindow(r.endsAt).opensAt;
    const secs = Math.max(1, Math.ceil((opensAt - now) / 1000));
    const what = now < r.opensAt ? 'The round opens after a short break' : 'Joins are closed for the rest of this round';
    this.error(conn, 'round_closed', `${what}. The next round opens in ${secs} s.`, { opensAt });
    return true;
  }

  /**
   * The paid custom room a ticket was bought for has ended, closes, or is in its last minute (it never seats again):
   * the wallet's open ticket of that arena goes back in full now (`cancel`: the whole entry fee, no fee) instead of
   * waiting for the stale sweeper (15 minutes). Only a ticket that is open on chain, not finalized, not seated in
   * any room and not queued: checked again synchronously right before the one journal write, so a seat that won
   * meanwhile keeps the ticket (and the chain worker drops a `cancel` of a seated ticket too). Returns whether one was
   * queued.
   */
  async refundUnseated(conn: Conn, arenaId: number): Promise<boolean> {
    const wallet = conn.wallet;
    if (!wallet || arenaId < 0 || !this.chain.stakeEnabled || !conn.allowChainOp()) return false;
    let s: ChainSession | null;
    try {
      s = await this.chain.getSession(arenaId, wallet);
    } catch {
      return false; // the sweeper refunds it later
    }
    if (!s || s.finalized || s.arenaId !== arenaId || s.player.toLowerCase() !== wallet.toLowerCase()) return false;
    const key = s.key;
    if (this.rooms.findArenaStake(arenaId, wallet) || this.rooms.liveSessions().has(key) || this.journal.pending.some((p) => p.key === key)) return false;
    if (this.journal.writeFailing) return false;
    const now = Date.now();
    const item: SettlementItem = {
      kind: 'settle',
      key,
      player: s.player,
      arenaId,
      session: key,
      sessionId: s.id,
      payout: s.entryFee,
      entryFee: s.entryFee,
      score: 0,
      kills: 0,
      xp: 0,
      // an unplayed ticket: the chain worker sends it as `cancel` (the full entry fee back, no fee)
      reason: 'stale',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    };
    this.journal.commit({ enqueue: [item] });
    this.chain.kick();
    this.log(`join: the paid room ${wallet} was headed for has ended; its unplayed ticket ${key} is refunded in full (cancel)`);
    return true;
  }

  async onMessage(conn: Conn, data: RawData, isBinary: boolean): Promise<void> {
    conn.lastMsgAt = Date.now();
    if (!conn.allow(isBinary ? 1 : 3)) return this.strike(conn);
    if (isBinary) {
      const input = decodeClientInput(toBytes(data));
      if (!input || !conn.helloed) return this.strike(conn);
      if (conn.room) conn.room.input(conn, input);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return this.strike(conn);
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.strike(conn);
    if (msg.t !== 'hello' && !conn.helloed) return this.strike(conn);

    switch (msg.t) {
      case 'hello': {
        if (msg.v !== PROTOCOL_VERSION) {
          this.error(conn, 'version_mismatch', 'A new version of Coinnibal is available. Please refresh.');
          return;
        }
        conn.helloed = true;
        conn.send({
          t: 'welcome',
          v: PROTOCOL_VERSION,
          serverTime: Date.now(),
          serverNow: this.rooms.now(),
          rooms: this.rooms.list(),
          chain: this.chain.status(),
          online: this.rooms.online(),
          blocked: this.rooms.blockedArenas(),
        });
        return;
      }
      case 'auth':
        await this.onAuth(conn, msg);
        return;
      case 'logout':
        conn.wallet = null;
        conn.profile = null;
        return;
      case 'join':
        await this.onJoin(conn, msg);
        return;
      case 'spectate': {
        if (await this.gameClosed(conn)) return;
        // an arena instance not (or no longer) open here resolves to its arena's first instance
        const room =
          typeof msg.room === 'string' ? await this.rooms.spectateRoom(msg.room) : (conn.room ?? this.rooms.lobbyRoom());
        if (!room) {
          this.error(conn, 'room_not_found', 'Room not found');
          return;
        }
        if (conn.player?.alive && conn.room !== room) conn.room?.leave(conn, 'switch');
        room.spectate(conn, msg.next === true);
        return;
      }
      case 'leave':
        conn.room?.leave(conn, 'left');
        conn.send({ t: 'left' });
        return;
      case 'viewport': {
        const w = Number(msg.w);
        const h = Number(msg.h);
        if (w > 0 && h > 0 && Number.isFinite(w / h)) {
          conn.aspect = clamp(w / h, 0.3, 3);
          conn.room?.connChanged?.(conn);
        }
        return;
      }
      case 'chat':
        conn.room?.chat(conn, msg.text);
        return;
      case 'emote':
        conn.room?.emote(conn, msg.id);
        return;
      case 'cashout':
        conn.room?.cashout(conn);
        return;
      case 'boost':
        conn.room?.boost(conn, msg.kind);
        return;
      case 'standings': {
        const on = msg.on === true;
        const was = conn.standings;
        conn.standings = on;
        // the sheet fills at once instead of waiting for the next second
        if (on && !was) conn.room?.sendStandings(conn);
        else if (on !== was) conn.room?.connChanged?.(conn);
        return;
      }
      case 'ping':
        conn.send({ t: 'pong', ts: Number(msg.ts) || 0, serverTime: Date.now(), serverNow: this.rooms.now() });
        return;
    }
  }

  private async onAuth(conn: Conn, msg: Record<string, unknown>): Promise<void> {
    if (!conn.allowChainOp()) {
      this.error(conn, 'rate_limited', 'Too many sign-ins — wait a moment.');
      return;
    }
    let wallet: string | null = null;
    let token: string | null = null;
    if (typeof msg.token === 'string') {
      wallet = this.auth.verifyToken(msg.token);
      // a player's session slides on; an admin's short token comes back unchanged (never extended)
      if (wallet) token = this.auth.refreshToken(msg.token);
    } else if (typeof msg.address === 'string' && typeof msg.message === 'string' && typeof msg.signature === 'string') {
      wallet = await this.auth.verifySignature(msg.address, msg.message, msg.signature);
    }
    if (!wallet) {
      this.error(conn, 'auth_failed', 'Wallet sign-in failed. Please sign again.');
      return;
    }
    conn.wallet = wallet;
    // signed in: no longer a guest of its IP (many players share a carrier's NAT address), up to the signed-in bound
    if (conn.countedAsGuest && this.signedRoom(conn.ip)) {
      this.uncountGuest(conn);
      this.countSigned(conn);
    }
    conn.profile = this.profiles?.summary(wallet) ?? null;
    conn.send({ t: 'authed', address: wallet, token: token ?? this.auth.issueToken(wallet), profile: conn.profile });
  }

  private async onJoin(conn: Conn, msg: Record<string, unknown>): Promise<void> {
    if (conn.joining) return;
    // every room entry (practice, private, arena ticket) is gated before anything else is looked at
    conn.joining = true;
    try {
      if (await this.gameClosed(conn)) return;
    } finally {
      conn.joining = false;
    }
    const target = typeof msg.room === 'string' ? parseJoinTarget(msg.room) : null;
    if (!target) {
      this.error(conn, 'bad_request', 'Unknown room');
      return;
    }
    conn.joining = true;
    // integrity evidence only: kept when well-formed, never trusted as an identity
    conn.fp = isFingerprint(msg.fp) ? msg.fp : null;
    try {
      const wantsEmblem = msg.skin === EMBLEM_SKIN_ID;
      const skin = wantsEmblem ? EMBLEM_SKIN_ID : Number.isInteger(msg.skin) && (msg.skin as number) >= 0 && (msg.skin as number) < SKIN_COUNT ? (msg.skin as number) : 0;
      if (conn.wallet) conn.profile = this.profiles?.summary(conn.wallet) ?? null;
      const holder = conn.wallet && this.holderCheck ? await this.holderCheck(conn.wallet).catch(() => false) : false;
      // only the basic skins can be picked, and the emblem skin by emblem holders
      if (wantsEmblem ? !holder : !isBasicSkin(skin)) {
        this.error(conn, 'skin_locked', wantsEmblem ? 'The NFT skin is for Coinnibal NFT holders.' : 'That skin is locked.');
        return;
      }
      let name = sanitizeName(msg.name);
      let flags = holder ? PlayerFlag.Holder : 0;
      if (conn.profile) {
        name = sanitizeName(conn.profile.name, name);
        flags |= PlayerFlag.Verified;
      }
      // the signed-in wallet's own profile picture, when it asked to wear it (guests and bots never have one)
      const avatar = msg.pic === true && conn.wallet ? (this.profiles?.avatar(conn.wallet) ?? null) : null;
      // the flag by the name: an allowlisted ISO 3166-1 alpha-2 code exactly, anything else is no flag
      // (a join that leaves it out entirely takes the signed-in wallet's saved one; '' means no flag)
      const country = isCountryCode(msg.country) ? msg.country : msg.country === undefined && conn.wallet ? (this.profiles?.country(conn.wallet) ?? null) : null;
      // the flag skin: the coin painted with that flag (needs a country; a worn picture wins, so it is
      // not sent with one). A join that leaves `flag` out takes the signed-in wallet's saved choice.
      const wantsFlag = msg.flag === true || (msg.flag === undefined && !!conn.wallet && (this.profiles?.flagSkin(conn.wallet) ?? false));
      if (wantsFlag && country && !avatar) flags |= PlayerFlag.FlagSkin;
      // the linked X handle comes from the server's own store (a client never names one)
      const xHandle = conn.wallet ? (this.xHandleOf?.(conn.wallet) ?? null) : null;

      // overloaded: a new free game waits (live games, reconnects and paid seats go on)
      if (target.mode !== 'arena' && !(conn.player?.alive) && this.shedder && !this.shedder.admitFree()) {
        this.error(conn, 'server_full', 'The server is very busy right now. Try again in a minute.');
        return;
      }
      if (target.mode === 'practice') {
        if (conn.player?.alive && conn.room?.opts.mode === 'practice') return; // already playing
        const room = this.rooms.practiceRoom(this.rooms.leagueFor(conn), conn.room);
        if (conn.player?.alive) conn.room?.leave(conn, 'switch');
        room.join(conn, { name, skin, flags, avatar, country, xHandle });
        return;
      }

      if (target.mode === 'private') {
        const room = this.rooms.privateRoom(target.code);
        if (!room) {
          if (target.code && this.rooms.customClosedLately(target.code)) this.error(conn, 'room_closed', 'This room has closed.');
          else this.error(conn, 'room_not_found', 'No private room with that code.');
          return;
        }
        if (conn.player?.alive && conn.room === room) return;
        // a paid custom room (an arena instance) seats arena tickets only: `arena:<id>:<CODE>`
        if (room.opts.mode !== 'private') {
          this.error(conn, 'paid_room', 'This room is played with an arena ticket. Open its invite link to buy one.');
          return;
        }
        if (room.isFull) {
          this.error(conn, 'room_full', 'That room is full.');
          return;
        }
        if (conn.player?.alive) conn.room?.leave(conn, 'switch');
        room.join(conn, { name, skin, flags, avatar, country, xHandle });
        return;
      }

      // stake arena
      if (this.chain.enabled && !this.chain.tokenReady) {
        // no arena registered or the token not set yet: arenas open once it is (picked up without a restart)
        this.error(conn, 'token_not_set', 'Arenas are opening soon: the game token is not set yet. Practice is open.');
        return;
      }
      if (!this.chain.stakeEnabled) {
        this.error(conn, 'arenas_disabled', 'High-stakes arenas are offline.');
        return;
      }
      if (!conn.wallet) {
        this.error(conn, 'auth_required', 'Connect and sign in with your wallet first.');
        return;
      }
      // banned wallets cannot start new arena games (a live ticket can still be resumed below: it is their money)
      const banned = this.banGate?.(conn.wallet) === true;
      if (banned && !this.rooms.findArenaStake(target.arenaId, conn.wallet)) {
        this.error(conn, 'banned', 'This wallet is banned from paid arenas after an integrity review. Practice is open.');
        return;
      }
      try {
        await this.joinArena(conn, target.arenaId, { name, skin, flags, avatar, country, xHandle }, target.code ?? null, target.test === true);
      } catch (err) {
        if (!(err instanceof ChainBusyError)) throw err;
        // the RPC refused us even after the retries: the ticket is untouched on chain, the player tries again
        this.log(`join: arena #${target.arenaId} for ${conn.wallet} — ${err.message}`);
        this.error(conn, 'chain_busy', 'The network is busy. Your ticket is safe on chain: press Resume again in a moment.');
      }
    } finally {
      conn.joining = false;
    }
  }

  /**
   * Hands a live arena coin from the sockets that hold it to `conn` (same wallet, see `joinArena`): each old one
   * leaves the room (the coin waits, AFK, for the reattach that follows in the same command order) and is closed with
   * `CLOSE_REPLACED`, so its client does not reconnect and fight for the coin.
   */
  private replaceHolders(conn: Conn, room: RoomHandle, pid: number): void {
    for (const old of this.rooms.conns) {
      if (old === conn || old.room !== room || !old.player?.alive || old.player.id !== pid) continue;
      this.log(`ws: ${conn.wallet} took its arena coin over on a new connection (${old.ip} → ${conn.ip})`);
      room.leave(old, 'disconnect');
      old.player = null;
      this.replaced++;
      try {
        old.ws.close(CLOSE_REPLACED, 'replaced by a newer connection of this wallet');
      } catch {
        /* already closing */
      }
      // a dead socket (the network switch) never answers the close handshake: drop it after a moment
      setTimeout(() => old.ws.terminate(), 2_000).unref();
    }
  }

  /**
   * The ticket read of a paid join: on `ChainBusyError` (RPC rate-limited) it is retried after
   * `JOIN_CHAIN_RETRY_MS`, and the player is told once that the network is busy. Throws
   * `ChainBusyError` when every try failed (or the connection closed meanwhile).
   */
  private async sessionWithRetry(conn: Conn, arenaId: number, wallet: string): Promise<ChainSession | null> {
    let told = false;
    for (let i = 0; ; i++) {
      try {
        return await this.chain.getSession(arenaId, wallet);
      } catch (err) {
        if (!(err instanceof ChainBusyError) || i >= JOIN_CHAIN_RETRY_MS.length || conn.ws.readyState > 1) throw err;
        if (!told) {
          told = true;
          this.error(conn, 'chain_busy', 'The network is busy, retrying your ticket…');
        }
        await sleep(JOIN_CHAIN_RETRY_MS[i]);
      }
    }
  }

  /**
   * The arena part of a join (the caller checked the wallet, the gate and the ban). `code`: seat the
   * ticket in that paid custom room (an invite-only instance of this arena) instead of a public
   * instance; `test`: in the arena's test arena (testnet only, with practice bots). A live ticket comes back
   * to wherever its coin is, either way. Throws `ChainBusyError`.
   */
  private async joinArena(
    conn: Conn,
    arenaId: number,
    look: { name: string; skin: number; flags: number; avatar: string | null; country: string | null; xHandle?: string | null },
    code: string | null = null,
    test = false,
  ): Promise<void> {
    if (!conn.wallet) return;
    const wallet = conn.wallet;
    const target = { arenaId };
    const { name, skin, flags, avatar, country, xHandle = null } = look;
    {
      // a live ticket comes back first, with no chain read at all: its coin is in this process already
      const existing = this.rooms.findArenaStake(target.arenaId, conn.wallet);
      if (existing) {
        // the same signed-in wallet on a new socket (a reconnect after a network switch, a reload, another tab): it
        // takes the coin over at once. The old socket, often a dead one the heartbeat has not noticed yet, is closed
        // with CLOSE_REPLACED. Only this wallet's own session reaches here (`findArenaStake` is by the signed-in wallet)
        if (conn.player === null) this.replaceHolders(conn, existing.room, existing.entry.pid);
        if (conn.player === null) {
          // a room worker answers asynchronously; a room on this thread at once
          const back = existing.room.reattach(conn, existing.entry.pid);
          if (back === true || (back !== false && (await back))) return;
        }
        // `reattach` rings a due bell first: the ticket may have been settled at that bell just now
        if (!this.rooms.findArenaStake(target.arenaId, conn.wallet) && this.rooms.bellSettled(target.arenaId, conn.wallet)) {
          this.roundEnded(conn);
          return;
        }
        this.error(conn, 'session_busy', 'You are already playing in this arena.');
        return;
      }
      const pick = test ? await this.rooms.testRoom(target.arenaId) : code ? await this.rooms.paidRoom(target.arenaId, code) : await this.rooms.arenaRoom(target.arenaId);
      if (pick === 'closed') {
        this.error(conn, 'room_closed', 'This room has closed.');
        // the paid room this ticket was bought for ended (or is closing): its unseated ticket goes back in full now
        if (code) void this.refundUnseated(conn, target.arenaId);
        return;
      }
      if (pick === 'missing') {
        this.error(conn, 'room_not_found', test ? 'No test arena here: test arenas run on a testnet only, when the admin turns them on.' : 'No paid room with that code for this arena.');
        return;
      }
      if (!pick || pick === 'arena') {
        this.error(conn, 'room_not_found', 'Arena not available.');
        return;
      }
      let room: RoomHandle | null = pick;
      if (!conn.wallet) return; // signed out during the await
      // a player back after a bell that settled their ticket while they were away (AFK)
      const bell = this.rooms.bellSettled(target.arenaId, conn.wallet);
      if (bell) {
        const settling = this.journal.pending.some((p) => p.key === bell.session);
        // undefined: the chain could not be read (or this connection is rate-limited); the normal path below decides then
        const live = settling ? null : conn.allowChainOp() ? await this.chain.getSession(target.arenaId, conn.wallet).catch(() => undefined) : undefined;
        if (settling || live === null || (live && live.id === bell.sessionId && !live.finalized)) {
          this.roundEnded(conn);
          return;
        }
        // a newer ticket (or a payout waiting to be collected): the usual checks apply. When the chain
        // could not be read (`live` undefined) the memo stays, so a later retry still hears round_ended.
        if (live !== undefined) this.rooms.forgetBellSettled(target.arenaId, conn.wallet);
      }
      // a new join (not the AFK return above): only while the round's joins are open (a paid room: its own game's)
      if (this.roundClosed(conn, room)) return;
      // closing for a re-price at its bell: the round plays out, nobody new sits down until the owner signed
      if (this.repricing?.(target.arenaId)) {
        this.error(conn, REFUSAL_CODES.repricing, 'This arena is closing for a moment to update its ticket price. Your ticket is safe on chain: an unseated one is refunded in full.');
        return;
      }
      // the journal cannot be written (disk full): a new seat would hold money the server could not record
      if (this.journal.writeFailing) {
        this.error(conn, REFUSAL_CODES.storage, 'Arena seats are paused for a moment: the server cannot save right now. Your ticket is safe on chain (seated later, or refunded in full).');
        return;
      }
      // badly overloaded: a new seat waits; the ticket stays on chain (seated later, or refunded in full if never played)
      if (this.shedder && !this.shedder.admitCritical()) {
        this.error(conn, 'server_full', 'The server is very busy right now. Your ticket is safe on chain: press Resume again in a minute.');
        return;
      }
      if (!conn.allowChainOp()) {
        this.error(conn, 'rate_limited', 'Too many join attempts — wait a moment.');
        return;
      }
      const session = await this.sessionWithRetry(conn, target.arenaId, conn.wallet);
      if (!conn.wallet || conn.wallet !== wallet) return; // signed out (or in as another wallet) during the retries
      if (!session) {
        this.error(conn, 'no_session', 'No open arena ticket found for your wallet.');
        return;
      }
      if (session.finalized) {
        // this game is over (settled, but the transfer to the player failed); the payout waits for the player
        this.error(conn, 'payout_waiting', 'Your last game in this arena is settled. Collect your payout first.');
        return;
      }
      if (this.journal.pending.some((p) => p.key === session.key)) {
        this.error(conn, 'no_session', 'Your previous game in this arena is still being settled.');
        return;
      }
      // `openedAt` is a block timestamp: the chain's clock decides the ticket's age
      if ((this.chain.chainNow?.() ?? Date.now()) / 1000 - session.openedAt > MAX_STAKE_SESSION_AGE_S - 600) {
        this.error(conn, 'no_session', 'This arena ticket expired and will be refunded.');
        return;
      }
      // holders gate: re-checked uncached right before every arena seat (each round needs a new ticket and
      // join), so an NFT sold since the sign-in no longer seats its former holder
      if (await this.gameClosed(conn, true)) return;
      // a holder ticket (holders-only arena, holder fee rates): the emblem is there now, and serves no other open ticket
      if (this.emblemGate) {
        const refused = await this.emblemGate(wallet, session);
        if (refused) {
          this.error(conn, refused.code, refused.message);
          return;
        }
        if (!conn.wallet || conn.wallet !== wallet) return;
      }
      // the instance may have filled up or been closed during the awaits above: pick again (arena data is cached)
      if (code || test) {
        // a paid room (or a test arena) is never swapped for another room: it is this one or none
        const picked: RoomHandle = room;
        room = test ? this.rooms.confirmTestRoom(picked) : this.rooms.confirmPaidRoom(picked);
        if (!room) {
          if (this.rooms.get(picked.id) === picked && picked.isFull) this.error(conn, 'room_full', 'That room is full.');
          else this.error(conn, 'room_closed', 'This room has closed.');
          return;
        }
      } else room = await this.rooms.confirmArenaRoom(target.arenaId, room);
      if (!room) {
        this.error(conn, 'room_full', 'Arena is full — try again in a moment.');
        return;
      }
      // re-check after the awaits above: another tab may have joined with the same ticket meanwhile (in any instance)
      if (this.rooms.findArenaStake(target.arenaId, conn.wallet) || this.rooms.liveSessions().has(session.key)) {
        this.error(conn, 'session_busy', 'You are already playing in this arena.');
        return;
      }
      // a settlement (e.g. a stale refund) may have been queued for this session during the awaits
      if (this.journal.pending.some((p) => p.key === session.key)) {
        this.error(conn, 'no_session', 'Your previous game in this arena is still being settled.');
        return;
      }
      // the awaits above may have crossed into the closed window (or the disk filled meanwhile)
      if (this.roundClosed(conn, room)) return;
      if (this.journal.writeFailing) {
        this.error(conn, REFUSAL_CODES.storage, 'Arena seats are paused for a moment: the server cannot save right now. Your ticket is safe on chain (seated later, or refunded in full).');
        return;
      }
      // a new arena game (not a resumed ticket): refused for a banned wallet (the ban may be new since the check above)
      if (this.banGate?.(conn.wallet) === true) {
        this.error(conn, 'banned', 'This wallet is banned from paid arenas after an integrity review. Practice is open.');
        return;
      }
      if (conn.player?.alive) conn.room?.leave(conn, 'switch');
      room.join(conn, {
        name,
        skin,
        avatar,
        country,
        xHandle,
        flags: flags | PlayerFlag.Staker,
        stake: {
          player: conn.wallet,
          session: session.key,
          sessionId: session.id,
          arenaId: target.arenaId,
          entryFee: session.entryFee,
          // the coin starts at the ticket's value: entry − fee on a fee-on-entry arena (v2), the entry fee on v1
          value: session.value,
          openedAt: session.openedAt,
        },
      });
    }
  }
}
