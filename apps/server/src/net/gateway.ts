import { randomBytes } from 'node:crypto';
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
  defaultName,
  isBasicSkin,
  isCountryCode,
  isFingerprint,
  parseJoinTarget,
  sanitizeName,
  type ErrorCode,
  type ServerMessage,
} from '@coinnibal/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { SIGN_IN_BUSY_MESSAGE, SignInBusyError, type Auth } from '../auth';
import { ChainBusyError, sessionKey, type ChainGateway, type ChainSession, type SettledEvent } from '../chain/types';
import type { ServerConfig } from '../config';
import type { ProfileStore } from '../profiles';
import type { RoomHandle } from '../rooms/handle';
import type { RoomManager } from '../rooms/manager';
import { MAX_STAKE_SESSION_AGE_S } from '../rooms/room';
import type { Journal, SettlementItem } from '../stake/journal';
import { CLIENT_BUSY_MESSAGE, ClientBudgetError, asClient } from './client-scope';
import { Conn, PING_REPLY_MIN_MS } from './conn';
import { rateKey, subnetOf, wideNetOf } from './ip-key';
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
/**
 * Guests per IPv6 /48: `MAX_CONNECTIONS_PER_SUBNET` times this. A guest is bounded per address and per /64 too, but one
 * customer's /48 holds 65536 /64s: without it one site would take the whole guest share.
 */
export const GUESTS_PER_WIDE_FACTOR = 2;
/**
 * A signed-in socket that has not played for this long (`Conn.playedAt`) and is not playing, not joining, its wallet
 * holding no live arena coin, is idle: at the cap the longest-idle one is closed (1013) when a newcomer needs a slot.
 * Its messages do not count (a socket that only pings keeps no place), so signed-in sockets that never play cannot
 * hold a full server.
 */
export const IDLE_SIGNED_MS = 2 * 60_000;
/** Above this share of `MAX_CONNECTIONS` the heartbeat closes guests idle for `2 × IDLE_GUEST_MS` (down to the share). */
const IDLE_SWEEP_SHARE = 0.9;
/** A send buffer over this (the snapshot skip of `room.ts`) at two heartbeats in a row closes the socket. */
const SLOW_SEND_BYTES = 768 * 1024;
/** Live-stake holders reconnecting get this much room above `MAX_CONNECTIONS` (one slot per wallet, see `admit`). */
const STAKE_HEADROOM = 0.05;
/**
 * Signed-in sockets per IP: `MAX_CONNECTIONS_PER_IP` times this (64 by default). Far above a household, enough for a
 * carrier NAT address, and still a bound on one address that signs in with many throwaway wallets. An IPv6 client
 * counts as its /64.
 */
export const SIGNED_PER_IP_FACTOR = 8;
/** Signed-in sockets per IPv4 /24 and per IPv6 /48: `MAX_CONNECTIONS_PER_SUBNET` times this (192 by default). */
export const SIGNED_PER_NET_FACTOR = 4;
/**
 * Sockets one wallet may hold at once (a few tabs, a reconnect beside a socket the heartbeat has not dropped yet). A
 * newer one closes the wallet's oldest lobby socket with `CLOSE_REPLACED` (its page does not reconnect), so one session
 * token can never fill the server.
 */
export const SOCKETS_PER_WALLET = 3;
/** WebSocket upgrades a minute of one ticket holder's wallet (the stake path's own budget: not its NAT address's). */
export const STAKE_UPGRADES_PER_WALLET_PER_MIN = 20;
/**
 * A playing socket that sent nothing for this long is taken for a dead one (a network switch the heartbeat has not
 * noticed yet): past the cap, its wallet's reconnect may take its place. The web client pings every 2 s while it plays.
 */
export const SILENT_PLAYER_MS = 5_000;
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
/**
 * Ticket reads (`getSession`: a join, each of its retries, a bell re-check, a refund check) a minute per wallet and per
 * client (`rateKey`), on top of each socket's own `allowChainOp`: many sockets or throwaway wallets do not add up. A
 * client's reads for wallets the `Joined`-log index knows to hold a ticket count apart from its reads for any other
 * wallet, so free wallets behind a carrier's NAT address never use up a ticket holder's reads there. Only reads for
 * wallets the index does not know count per network too (`TICKET_READS_PER_NET_PER_MIN`).
 */
export const TICKET_READS_PER_WALLET_PER_MIN = 20;
export const TICKET_READS_PER_IP_PER_MIN = 60;
/**
 * Reads for wallets the `Joined` index does not know, a minute per network (`ticketNet`: an IPv6 /48, an IPv4 /24).
 * Past it the join hears "network busy, retrying" and the index reads the new blocks (`refreshTicketIndex`): a
 * ticket bought a moment ago is known by the retry, and a known wallet is never counted or refused per network.
 */
export const TICKET_READS_PER_NET_PER_MIN = TICKET_READS_PER_IP_PER_MIN * 2;
/**
 * Ticket reads waiting at once, server-wide: this many seconds of the RPC budget (`RPC_MAX_RPS`), at least 16. Past
 * it a join hears "network busy" at once (and retries) instead of queuing for minutes behind a flood.
 */
export const TICKET_READ_QUEUE_S = 16;
/**
 * One network's share of that bound: ticket reads waiting at once per client (`rateKey`: an IPv4 address, an IPv6
 * /64; known wallets' reads apart from the others') and per network (`ticketNet`: an IPv6 /48, an IPv4 /24; only
 * wallets the `Joined` index does not know). Many sockets or free wallets of one network cannot hold the whole queue,
 * nor keep a ticket holder of that network out.
 */
export const TICKET_READS_IN_FLIGHT_PER_CLIENT = 4;
export const TICKET_READS_IN_FLIGHT_PER_WIDE = 8;
/**
 * The share of the server-wide bound open to wallets the `Joined`-log index does not know to hold a ticket: a wallet
 * with no `Joined` event holds none, so free wallets, however many networks they come from, fill only this part. A
 * ticket bought a moment ago is not in the index yet: its join, refused for a full share (or seated), has the index
 * read the new blocks at once (`refreshTicketIndex`), and its retry a few seconds later has the whole bound.
 */
export const TICKET_READS_UNKNOWN_SHARE = 0.25;

/**
 * A ticket read the gateway refused for one of its own bounds on reads waiting at once (this client's, its
 * network's, the server-wide queue): not the chain failing. A client can bring it on itself (many joins at once), so
 * it never excuses a no-show (`seatRefused`); a `ChainBusyError` of the chain read itself does.
 */
export class TicketReadsBusy extends ChainBusyError {}
/**
 * A join waits this long at most for the holder check of its laurel (`holderCheck`, cosmetic): past it the game starts
 * without the laurel (the check goes on and is cached for the next game). A paid seat never waits behind it.
 */
export const HOLDER_CHECK_WAIT_MS = 1_000;

/** The network a client's ticket reads count under besides the client itself: its IPv6 /48, an IPv4 address's /24. */
const ticketNet = (ip: string): string => wideNetOf(ip) ?? subnetOf(ip);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** `p`'s answer, or null once `ms` passed first (`p` goes on). */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
    timer.unref();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

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

/** A session token offered at the upgrade: its wallet, and whether that wallet holds a live arena coin here. */
interface Offer {
  priority: 'stake' | 'signed';
  wallet: string;
}

/** What `admit` lets in (null: refused). */
interface Admission {
  /** The offered wallet's open sockets that may stay beside the new one (`addToWallet` replaces the oldest beyond it). */
  keep: number;
  /** Past the cap: the wallet's own socket (a lobby one, or a silent game's) the new one takes the place of. */
  swap?: Conn;
  /** Past the cap with none to swap: the wallet's one extra slot (`Conn.headroom`). */
  headroom?: boolean;
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
  /** Guests per address, per /24 or /64 (`subnetOf`) and per IPv6 /48 (`wideNetOf`). */
  private readonly perIp = new Map<string, number>();
  private readonly perSubnet = new Map<string, number>();
  private readonly perWide = new Map<string, number>();
  /** Signed-in sockets per network (`signedNets`: the address or IPv6 /64, its /24 or /64, an IPv6 /48). */
  private readonly signedPerNet = new Map<string, number>();
  /** Open sockets per wallet (lower case), oldest first: offered its token at the upgrade, or signed in with `auth`. */
  private readonly byWallet = new Map<string, Conn[]>();
  /** Upgrades per client (`rateKey`: an IPv4 address, an IPv6 /64). */
  private readonly upgrades = new Limiter(UPGRADES_PER_IP_PER_MIN, 60_000);
  /** Upgrades per ticket-holder wallet (the stake path). */
  private readonly stakeUpgrades = new Limiter(STAKE_UPGRADES_PER_WALLET_PER_MIN, 60_000);
  /**
   * Ticket reads per wallet and per client (`allowTicketRead`: `k <rateKey>` for wallets the `Joined` index knows,
   * `c <rateKey>` for the others), and how many are waiting now (`readTicket`).
   */
  private readonly ticketReadsByWallet = new Limiter(TICKET_READS_PER_WALLET_PER_MIN, 60_000);
  private readonly ticketReadsByIp = new Limiter(TICKET_READS_PER_IP_PER_MIN, 60_000);
  /** Reads for wallets the index does not know, per network (`ticketNet`: an IPv6 /48, an IPv4 /24; `readTicket`). */
  private readonly ticketReadsByWide = new Limiter(TICKET_READS_PER_NET_PER_MIN, 60_000);
  private ticketReads = 0;
  /** Ticket reads waiting now per client (`c`/`k <rateKey>`, as above) and per network (`w <ticketNet>`). */
  private readonly ticketReadsOf = new Map<string, number>();
  /** Graceful degradation (new joins shed before live rooms suffer); null: never sheds (bare unit tests). */
  private shedder: LoadShedder | null = null;
  /** Connections closed for abuse (flood, garbage, no hello, a client that stops reading), for the load test and the logs. */
  readonly dropped = { noHello: 0, flood: 0, limit: 0, idle: 0, slow: 0 };
  /**
   * Sockets closed because a newer one of the same wallet took their arena coin over, or their place beyond
   * `SOCKETS_PER_WALLET` (`CLOSE_REPLACED`).
   */
  replaced = 0;
  /** Liveness: true once the client answered, else the payload of the ping it has to echo (`beat`). */
  private readonly alive = new WeakMap<WebSocket, true | Buffer>();
  /** Sockets whose send buffer was over `SLOW_SEND_BYTES` at the last beat. */
  private readonly slowAtBeat = new WeakSet<WebSocket>();
  private timers: NodeJS.Timeout[] = [];
  /** Who may enter a room (join or spectate); null: everyone (unit tests that build a bare gateway). */
  private gameGate: ((wallet: string | null, fresh?: boolean, origin?: string | null) => boolean | Promise<boolean>) | null = null;
  /** Server profiles (names, skins, XP); null: none (bare unit tests). */
  private profiles: ProfileStore | null = null;
  /** Wallets the admin banned from arenas (integrity); null: nobody (bare unit tests). */
  private banGate: ((wallet: string) => boolean) | null = null;
  /**
   * Whether a wallet holds a Coinnibal emblem (laurel flag, emblem skin); null: nobody does. `gate`: the emblem skin
   * was asked for (a decision: the mint service's `isHolder`); else only the laurel is shown (`shownHolder`: the
   * answer on record, never a chain read of its own).
   */
  private holderCheck: ((wallet: string, gate: boolean) => Promise<boolean>) | null = null;
  /** Arenas closed for a re-price at their bell (`RepriceScheduler.closedForSeats`); absent: none. */
  private repricing: ((arenaId: number) => boolean) | null = null;
  /** The seat check of holder tickets (`EmblemGate.seat`): null to seat, else the refusal; absent: none. */
  private emblemGate: ((wallet: string, session: ChainSession) => Promise<{ code: ErrorCode; message: string } | null>) | null = null;
  /** The join permits learn of a wallet's ticket (`JoinPermits.ticketSeen`); absent: none (bare unit tests). */
  private ticketSeen: ((wallet: string, arenaId: number, openedAtS: number | null) => void) | null = null;
  /**
   * Whether the early refund of a ticket, as the paid room `code` stopped taking seats, is excused
   * (`JoinPermits.roomExcuse`: bound to that room, just bought); absent: never (bare unit tests).
   */
  private roomExcuse: ((wallet: string, arenaId: number, code: string, openedAtS: number) => boolean) | null = null;

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

  /**
   * Sets who may enter rooms (the site's game gate: admins, NFT holders, or everyone). `origin`: the socket's page
   * (an open-play copy of the site opens the game on a testnet).
   */
  setGameGate(gate: ((wallet: string | null, fresh?: boolean, origin?: string | null) => boolean | Promise<boolean>) | null): void {
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

  /**
   * Sets the emblem holder check (cached by the mint service): holders wear a laurel and may pick the emblem skin.
   * `gate`: the join asked for the emblem skin; else the answer is only shown (the laurel).
   */
  setHolderCheck(check: ((wallet: string, gate: boolean) => Promise<boolean>) | null): void {
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

  /**
   * Sets who hears of a wallet's arena ticket (the join permits, `stake/join-permits.ts`): `openedAtS` null when the
   * wallet asks to sit with a ticket there (a place its permit held is given up), the ticket's block time once it is read.
   */
  setTicketSeen(fn: ((wallet: string, arenaId: number, openedAtS: number | null) => void) | null): void {
    this.ticketSeen = fn;
  }

  /** Sets who decides whether a paid room's early refund of an unseated ticket is excused (`JoinPermits.roomExcuse`). */
  setRoomExcuse(fn: ((wallet: string, arenaId: number, code: string, openedAtS: number) => boolean) | null): void {
    this.roomExcuse = fn;
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
  private async gameClosed(conn: Conn, fresh = false, wallet: string | null = conn.wallet): Promise<boolean> {
    if (!this.gameGate) return false;
    const open = await Promise.resolve(this.gameGate(wallet, fresh, conn.origin)).catch((err) => (err instanceof ClientBudgetError ? 'busy' : false));
    // the holder check could not run for this client right now (and knows no answer): busy, never "not open to you"
    if (open === 'busy') {
      this.error(conn, 'rate_limited', CLIENT_BUSY_MESSAGE);
      return true;
    }
    if (open) return false;
    this.error(conn, 'game_closed', wallet ? 'The game is not open to this wallet yet.' : 'The game is not open yet. Sign in with your wallet if you hold a Coinnibal NFT.');
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
      const offer = this.priorityOf(req);
      const admitted = this.admit(ip, net, offer);
      if (admitted === null) {
        refuse('429 Too Many Requests');
        return;
      }
      // overloaded: live games keep their budget, new sockets wait (a live stake's reconnect always gets in)
      if (offer?.priority !== 'stake' && this.shedder && !this.shedder.admitCritical()) {
        refuse('503 Service Unavailable');
        return;
      }
      // the page's origin rides on the connection: the game gate opens the game to an open-play copy on a testnet
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip, net, offer, admitted, origin));
    });
    // heartbeat + lobby room list
    this.timers.push(
      setInterval(() => this.beat(), 25_000),
      setInterval(() => {
        const msg = { t: 'rooms', rooms: this.rooms.list(), online: this.rooms.online(), blocked: this.rooms.blockedArenas() } as const;
        for (const c of this.rooms.conns) if (c.helloed && !c.player?.alive) c.send(msg);
      }, 5000),
    );
  }

  /**
   * The heartbeat (every 25 s): a socket that did not echo the last ping is closed. Each ping carries a fresh random
   * payload that the pong must echo (browsers and the ws client do so by themselves), so a client that stopped reading
   * cannot stay "alive" by sending pongs of its own: the ping waits behind what it does not read. A socket whose send
   * buffer stayed over `SLOW_SEND_BYTES` for two beats is closed too (its snapshots are skipped all that time).
   */
  beat(): void {
    for (const ws of this.wss.clients) {
      if (this.alive.get(ws) !== true) {
        ws.terminate();
        continue;
      }
      if (ws.bufferedAmount > SLOW_SEND_BYTES) {
        if (this.slowAtBeat.has(ws)) {
          this.dropped.slow++;
          ws.terminate();
          continue;
        }
        this.slowAtBeat.add(ws);
      } else this.slowAtBeat.delete(ws);
      const probe = randomBytes(8);
      this.alive.set(ws, probe);
      ws.ping(probe);
    }
    // close to the cap: lobby guests idle for a minute make room before anyone is refused
    const max = this.cfg.maxConnections;
    while (this.rooms.conns.size > max * IDLE_SWEEP_SHARE && this.evictIdleGuest(2 * IDLE_GUEST_MS));
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
   * The session token a browser offered as a subprotocol (`coinnibal.auth.<token>`) and its wallet: `stake` when that
   * wallet holds a live arena coin here (a reconnect: it gets in past the cap), `signed` for any other valid session,
   * null without one.
   */
  private priorityOf(req: IncomingMessage): Offer | null {
    const offers = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim());
    const prefix = offers.some((s) => s.startsWith(AUTH_SUBPROTOCOL)) ? AUTH_SUBPROTOCOL : OLD_AUTH_SUBPROTOCOL;
    const offered = offers.find((s) => s.startsWith(prefix));
    const wallet = offered ? this.auth.verifyToken(offered.slice(prefix.length)) : null;
    if (!wallet) return null;
    return { priority: this.rooms.holdsLiveStake(wallet) ? 'stake' : 'signed', wallet };
  }

  /**
   * One admission policy for every upgrade. Null refuses it (429); otherwise how many of the offered wallet's open
   * sockets may stay beside the new one (`addToWallet` replaces the rest; `Infinity` for a guest), and past the cap the
   * socket it takes the place of, or that it takes its wallet's one extra slot.
   * - Guests: per IP, per subnet and per IPv6 /48, at most `GUEST_SHARE` of the slots; at the cap an idle guest makes
   *   room, or (the guests under their share) a signed-in socket that does not play (`IDLE_SIGNED_MS`).
   * - Signed-in (a session token): `signedRoom` per address (an IPv6 /64), per /24 or /64 and per IPv6 /48; at most
   *   `SOCKETS_PER_WALLET` per wallet; the reserve the guests leave; at the cap an idle guest or an idle signed-in
   *   socket makes room.
   * - A live stake's reconnect: the same bounds per wallet and network (with a margin of `MAX_CONNECTIONS_PER_IP` for a
   *   carrier NAT), its own upgrade budget, and past the cap one slot per wallet: a socket of its own that does not play
   *   (or whose game went silent: a dead socket) is swapped; a live game is never closed for it: with every socket of
   *   the wallet playing, the new one takes the wallet's one extra slot (an idle guest's, of the 5 % headroom, or, the
   *   headroom full, an idle signed-in socket's).
   * A socket counts under the wallet its token named for its whole life (`Conn.admitSlot`): a `logout` or a sign-in as
   * another wallet does not take it out of these bounds. Every socket counts in `MAX_CONNECTIONS`, the headroom's too;
   * the upgrade limits count per `rateKey`.
   */
  private admit(ip: string, net: string, offer: Offer | null): Admission | null {
    const max = this.cfg.maxConnections;
    if (offer?.priority === 'stake') {
      if (!this.stakeUpgrades.allow(offer.wallet.toLowerCase())) return null;
      if (!this.signedRoom(ip, this.cfg.maxConnectionsPerIp)) return null;
      if (this.rooms.conns.size < max) return { keep: SOCKETS_PER_WALLET - 1 };
      const now = Date.now();
      const mine = this.walletConns(offer.wallet);
      const swap = mine.find((c) => this.swappable(c, now) === 'lobby') ?? mine.find((c) => this.swappable(c, now) === 'silent');
      if (swap) return { keep: Infinity, swap };
      if (mine.some((c) => c.headroom)) return null;
      // an idle guest's place, the headroom, or (both gone) the place of the signed-in socket that went longest
      // without playing: every lower priority may take that one, so the stake path may too
      return this.evictIdleGuest(IDLE_GUEST_MS) || this.rooms.conns.size < max * (1 + STAKE_HEADROOM) || this.evictIdleSigned() ? { keep: Infinity, headroom: true } : null;
    }
    if (!this.upgrades.allow(rateKey(ip))) return null;
    if (offer) {
      if (!this.signedRoom(ip)) return null;
      const keep = SOCKETS_PER_WALLET - 1;
      const freed = Math.max(0, this.walletConns(offer.wallet).length - keep);
      return this.rooms.conns.size - freed < max || this.evictIdleGuest(IDLE_GUEST_MS) || this.evictIdleSigned() ? { keep } : null;
    }
    const wide = wideNetOf(ip);
    if (
      (this.perIp.get(ip) ?? 0) >= this.cfg.maxConnectionsPerIp ||
      (this.perSubnet.get(net) ?? 0) >= this.cfg.maxConnectionsPerSubnet ||
      (wide !== null && (this.perWide.get(wide) ?? 0) >= this.cfg.maxConnectionsPerSubnet * GUESTS_PER_WIDE_FACTOR)
    )
      return null;
    // guests use at most GUEST_SHARE of the slots; at the cap (or the guest share) an idle guest makes room
    const guestsUnderShare = this.guestCount() < max * GUEST_SHARE;
    if (this.rooms.conns.size < max && guestsUnderShare) return { keep: Infinity };
    if (this.evictIdleGuest(IDLE_GUEST_MS)) return { keep: Infinity };
    // a full server with the guests under their share: a signed-in socket that does not play makes room
    return guestsUnderShare && this.evictIdleSigned() ? { keep: Infinity } : null;
  }

  /**
   * Whether a socket of a ticket holder's wallet may make room for its reconnect past the cap: `lobby` (open, not
   * playing, not joining), `silent` (its game sent nothing for `SILENT_PLAYER_MS`: a dead socket; the new socket's join
   * takes the coin over), or null (a live game, or a join on its way).
   */
  private swappable(c: Conn, now: number): 'lobby' | 'silent' | null {
    if (c.ws.readyState > 1 || c.joining) return null;
    if (!c.player?.alive) return 'lobby';
    return now - c.lastMsgAt >= SILENT_PLAYER_MS ? 'silent' : null;
  }

  /** The networks a signed-in socket counts in, with their bounds: its address (an IPv6 /64), its /24 or /64, an IPv6 /48. */
  private signedNets(ip: string): [key: string, limit: number][] {
    const perIp = this.cfg.maxConnectionsPerIp * SIGNED_PER_IP_FACTOR;
    const perNet = this.cfg.maxConnectionsPerSubnet * SIGNED_PER_NET_FACTOR;
    const nets: [string, number][] = [
      [`ip ${rateKey(ip)}`, perIp],
      [`net ${subnetOf(ip)}`, perNet],
    ];
    const wide = wideNetOf(ip);
    if (wide) nets.push([`wide ${wide}`, perNet]);
    return nets;
  }

  /** This address may hold one more signed-in socket (`margin` above the bounds: a ticket holder's reconnect). */
  private signedRoom(ip: string, margin = 0): boolean {
    return this.signedNets(ip).every(([key, limit]) => (this.signedPerNet.get(key) ?? 0) < limit + margin);
  }

  /** The socket counts as signed in for its networks. */
  private countSigned(conn: Conn): void {
    if (conn.countedAsSigned) return;
    conn.countedAsSigned = true;
    for (const [key] of this.signedNets(conn.ip)) this.signedPerNet.set(key, (this.signedPerNet.get(key) ?? 0) + 1);
  }

  private uncountSigned(conn: Conn): void {
    if (!conn.countedAsSigned) return;
    conn.countedAsSigned = false;
    for (const [key] of this.signedNets(conn.ip)) {
      const n = (this.signedPerNet.get(key) ?? 1) - 1;
      if (n <= 0) this.signedPerNet.delete(key);
      else this.signedPerNet.set(key, n);
    }
  }

  /** The wallet's open sockets, oldest first. */
  private walletConns(wallet: string): readonly Conn[] {
    return this.byWallet.get(wallet.toLowerCase()) ?? [];
  }

  /**
   * The socket joins `key`'s sockets. Beyond `keep` others of that wallet, the oldest are replaced: lobby sockets
   * before one that plays.
   */
  private addToWallet(conn: Conn, key: string, keep: number): void {
    const mine = this.byWallet.get(key) ?? [];
    if (mine.length > keep) {
      // a stable sort: the age order stays within lobby sockets and within playing ones
      const order = [...mine].sort((a, b) => Number(!!a.player?.alive) - Number(!!b.player?.alive));
      for (const old of order.slice(0, mine.length - Math.max(0, keep))) this.replaceSocket(old);
    }
    const list = this.byWallet.get(key) ?? [];
    list.push(conn);
    this.byWallet.set(key, list);
  }

  private removeFromWallet(conn: Conn, key: string): void {
    const list = this.byWallet.get(key);
    const i = list ? list.indexOf(conn) : -1;
    if (i >= 0) list!.splice(i, 1);
    if (list && list.length === 0) this.byWallet.delete(key);
  }

  /** The socket counts under the wallet its upgrade token named, for its whole life (`Conn.admitSlot`). */
  private admitWallet(conn: Conn, wallet: string, keep: number): void {
    const key = wallet.toLowerCase();
    this.addToWallet(conn, key, keep);
    conn.admitSlot = key;
  }

  /**
   * The socket signed in as `wallet` (`auth`): it counts under that wallet too (beside the one that admitted it, if
   * another), and beyond `keep` other sockets of it the oldest are replaced.
   */
  private claimWallet(conn: Conn, wallet: string, keep = SOCKETS_PER_WALLET - 1): void {
    const key = wallet.toLowerCase();
    if (conn.walletSlot === key) return;
    this.releaseWallet(conn);
    if (conn.admitSlot === key) return;
    this.addToWallet(conn, key, keep);
    conn.walletSlot = key;
  }

  /** The socket signed out (or in as another wallet): it stops counting under its sign-in's wallet; its admission slot stays. */
  private releaseWallet(conn: Conn): void {
    const key = conn.walletSlot;
    if (!key) return;
    conn.walletSlot = null;
    this.removeFromWallet(conn, key);
  }

  /** The socket is gone: it counts under no wallet. */
  private releaseAllWallets(conn: Conn): void {
    this.releaseWallet(conn);
    const key = conn.admitSlot;
    if (!key) return;
    conn.admitSlot = null;
    this.removeFromWallet(conn, key);
  }

  /**
   * A socket that took its wallet's extra slot past the cap (`Conn.headroom`) and no longer speaks for that wallet
   * (a `logout`, a sign-in as another wallet) is closed while the server is still full: the slot was granted for that
   * wallet's coin. A socket that plays stays (its game goes on). True when it was closed.
   */
  private dropHeadroom(conn: Conn): boolean {
    if (!conn.headroom || conn.player?.alive || conn.joining || this.rooms.conns.size < this.cfg.maxConnections) return false;
    this.dropped.limit++;
    this.log(`ws: ${conn.admitSlot ?? 'a wallet'} signed out on a socket that took a reserved slot past the cap (${conn.ip}): closed`);
    this.rooms.removeConn(conn);
    this.uncountSigned(conn);
    this.releaseAllWallets(conn);
    conn.room?.leave(conn, 'disconnect');
    try {
      conn.ws.close(1013, 'the server is full');
    } catch {
      /* already closing */
    }
    setTimeout(() => conn.ws.terminate(), 1_000).unref();
    return true;
  }

  /**
   * Closes a socket whose wallet opened one more than `SOCKETS_PER_WALLET` (`CLOSE_REPLACED`: its page does not
   * reconnect). Its slot is free at once; a coin it played waits AFK for the wallet's newer socket.
   */
  private replaceSocket(old: Conn): void {
    this.replaced++;
    this.log(`ws: ${old.admitSlot ?? old.walletSlot ?? 'a wallet'} opened more than ${SOCKETS_PER_WALLET} connections: its oldest (${old.ip}) is closed`);
    this.releaseAllWallets(old);
    this.rooms.removeConn(old);
    this.uncountGuest(old);
    this.uncountSigned(old);
    old.room?.leave(old, 'disconnect');
    try {
      old.ws.close(CLOSE_REPLACED, 'replaced by a newer connection of this wallet');
    } catch {
      /* already closing */
    }
    setTimeout(() => old.ws.terminate(), 2_000).unref();
  }

  /**
   * The sockets that count as guests (`Conn.countedAsGuest`: in their IP's guest bounds). A socket its session token
   * admitted is not one, whether or not it ever sends `auth` (it counts as signed in, `signedPerNet`).
   */
  private guestCount(): number {
    let n = 0;
    for (const c of this.rooms.conns) if (c.countedAsGuest) n++;
    return n;
  }

  /**
   * Closes the longest-idle guest (counted as a guest, not signed in, not playing, silent for `idleMs`). False when
   * there is none. A socket a session token admitted is never one (`evictIdleSigned` covers it).
   */
  private evictIdleGuest(idleMs: number): boolean {
    const now = Date.now();
    let worst: Conn | null = null;
    for (const c of this.rooms.conns) {
      if (!c.countedAsGuest || c.wallet || c.player?.alive || c.joining || c.ws.readyState > 1 || now - c.lastMsgAt < idleMs) continue;
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

  /**
   * Closes the signed-in socket that went longest without playing (`IDLE_SIGNED_MS`): not playing, not joining, its
   * wallet (the one it signed in as, or whose token opened it) holding no live arena coin. False when there is none.
   */
  private evictIdleSigned(): boolean {
    const now = Date.now();
    const idle: Conn[] = [];
    for (const c of this.rooms.conns) {
      if ((!c.wallet && !c.countedAsSigned) || c.player?.alive || c.joining || c.ws.readyState > 1 || now - c.playedAt < IDLE_SIGNED_MS) continue;
      idle.push(c);
    }
    // a live coin's wallet may be about to take it back on this socket: never that one (checked for the few first only)
    const worst = idle
      .sort((a, b) => a.playedAt - b.playedAt)
      .find((c) => !(c.wallet && this.rooms.holdsLiveStake(c.wallet)) && !(c.admitSlot && this.rooms.holdsLiveStake(c.admitSlot)));
    if (!worst) return false;
    this.dropped.idle++;
    // gone from the counts now: the newcomer takes its slot at once
    this.rooms.removeConn(worst);
    this.uncountGuest(worst);
    this.uncountSigned(worst);
    this.releaseAllWallets(worst);
    worst.room?.leave(worst, 'disconnect');
    try {
      worst.ws.close(1013, 'idle: the server is full');
    } catch {
      /* already closing */
    }
    setTimeout(() => worst.ws.terminate(), 1_000).unref();
    return true;
  }

  /** The socket stops counting in its IP's, subnet's and /48's guest limit (it signed in, or it is gone). */
  private uncountGuest(conn: Conn, net = subnetOf(conn.ip)): void {
    if (!conn.countedAsGuest) return;
    conn.countedAsGuest = false;
    const n = (this.perIp.get(conn.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(conn.ip);
    else this.perIp.set(conn.ip, n);
    const s = (this.perSubnet.get(net) ?? 1) - 1;
    if (s <= 0) this.perSubnet.delete(net);
    else this.perSubnet.set(net, s);
    const wide = wideNetOf(conn.ip);
    if (wide === null) return;
    const w = (this.perWide.get(wide) ?? 1) - 1;
    if (w <= 0) this.perWide.delete(wide);
    else this.perWide.set(wide, w);
  }

  private onConnection(ws: WebSocket, ip: string, net = subnetOf(ip), offer: Offer | null = null, admitted: Admission = { keep: SOCKETS_PER_WALLET - 1 }, origin: string | null = null): void {
    const conn = new Conn(ws, ip);
    conn.origin = origin;
    conn.priority = offer?.priority ?? null;
    // a session-token socket is not a guest: it never counts in its IP's guest limit (players behind a carrier NAT)
    if (offer) {
      conn.countedAsGuest = false;
      this.countSigned(conn);
      const { swap } = admitted;
      // past the cap: the socket it was let in for is swapped (its extra slot, if it held it, goes with its place),
      // unless it started a game meanwhile (then this one is the wallet's extra slot) or is gone already
      if (swap && swap.ws.readyState <= 1 && this.walletConns(offer.wallet).includes(swap)) {
        if (this.swappable(swap, Date.now())) {
          conn.headroom = swap.headroom;
          this.replaceSocket(swap);
        } else conn.headroom = true;
      } else if (swap?.headroom) conn.headroom = true;
      if (admitted.headroom) conn.headroom = true;
      this.admitWallet(conn, offer.wallet, admitted.keep);
    } else {
      this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
      this.perSubnet.set(net, (this.perSubnet.get(net) ?? 0) + 1);
      const wide = wideNetOf(ip);
      if (wide !== null) this.perWide.set(wide, (this.perWide.get(wide) ?? 0) + 1);
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
    // only the echo of the server's last ping counts (an unsolicited pong proves nothing)
    ws.on('pong', (data) => {
      const want = this.alive.get(ws);
      if (want instanceof Buffer && data.equals(want)) this.alive.set(ws, true);
    });
    // a text message may trigger chain reads: they count against this client's own budgets (`asClient`)
    const key = rateKey(ip);
    ws.on('message', (data, isBinary) => {
      const handled = isBinary ? this.onMessage(conn, data, isBinary) : asClient(key, () => this.onMessage(conn, data, isBinary));
      handled.catch((err) => this.log(`message handling failed: ${(err as Error).stack ?? err}`));
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
    this.releaseAllWallets(conn);
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
   * `wallet` asked to sit with its ticket of `arenaId` while joins were open, and the server refused for a reason of
   * its own (a re-price, the journal, overload, no seat in a public arena, the chain unreadable): if that ticket is
   * never seated, the stale sweeper's refund is not a no-show (2026-11 audit R3-M1). Never for a refusal the client
   * can bring on itself (its rate limits, its own bounds on reads waiting) or a closed round.
   */
  private seatRefused(wallet: string, arenaId: number): void {
    this.chain.excuseNoShow?.(arenaId, wallet);
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
      void this.refundUnseated(conn, room.opts.stake?.arenaId ?? -1, room.opts.code ?? null);
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
   * The paid custom room `code` (an instance of `arenaId`) has ended, closes, or is in its last minute (it never seats
   * again): the wallet's open ticket of that arena goes back in full now (`cancel`: the whole entry fee, no fee) instead
   * of waiting for the stale sweeper (15 minutes). Only a ticket that is open on chain, not finalized, not seated in
   * any room and not queued: checked again synchronously right before the one journal write, so a seat that won
   * meanwhile keeps the ticket (and the chain worker drops a `cancel` of a seated ticket too). Returns whether one was
   * queued.
   *
   * It is a no-show like the stale sweeper's (audit R4-M1: anyone may name a closed room's code) unless the server owes
   * the excuse: the arena takes no seat (closed, paused, re-pricing), the server refused this ticket a seat for a
   * reason of its own (`excusedSince`), or the ticket was bought for this very room just now (`roomExcuse`: its permit
   * was bound to the room while it took seats, not by its creator, within the room's seats).
   */
  async refundUnseated(conn: Conn, arenaId: number, code: string | null): Promise<boolean> {
    const wallet = conn.wallet;
    if (!wallet || arenaId < 0 || !this.chain.stakeEnabled || !this.allowTicketRead(conn, wallet, arenaId)) return false;
    let s: ChainSession | null;
    try {
      s = await this.readTicket(conn, arenaId, wallet);
    } catch {
      return false; // the sweeper refunds it later
    }
    if (!s || s.finalized || s.arenaId !== arenaId || s.player.toLowerCase() !== wallet.toLowerCase()) return false;
    const key = s.key;
    if (this.rooms.findArenaStake(arenaId, wallet) || this.rooms.liveSessions().has(key) || this.journal.pending.some((p) => p.key === key)) return false;
    if (this.journal.writeFailing) return false;
    const now = Date.now();
    const arenaOpen = !this.chain.joinsPaused?.() && this.rooms.arenaTakesSeats(arenaId) && !this.repricing?.(arenaId);
    const excused =
      !arenaOpen || this.chain.excusedSince?.(arenaId, s.player, s.openedAt) === true || (code !== null && this.roomExcuse?.(s.player, arenaId, code, s.openedAt) === true);
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
      // never seated while its arena took seats, and the server owes no excuse: a no-show (the join permits count it)
      ...(excused ? {} : { noShow: true as const }),
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    };
    this.journal.commit({ enqueue: [item] });
    this.chain.kick();
    this.log(`join: the paid room ${wallet} was headed for has ended; its unplayed ticket ${key} is refunded in full (cancel${excused ? '' : ', a no-show'})`);
    return true;
  }

  async onMessage(conn: Conn, data: RawData, isBinary: boolean): Promise<void> {
    // a socket being closed (replaced, evicted, flooding) is not heard any more
    if (conn.ws.readyState > 1) return;
    conn.lastMsgAt = Date.now();
    if (!conn.allow(isBinary ? 1 : 3)) return this.strike(conn);
    if (isBinary) {
      const input = decodeClientInput(toBytes(data));
      if (!input || !conn.helloed) return this.strike(conn);
      if (conn.room) {
        conn.room.input(conn, input);
        // its coin plays: not an idle socket (`IDLE_SIGNED_MS`)
        if (conn.player?.alive) conn.playedAt = conn.lastMsgAt;
      }
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
        // one hello per socket: a repeat would make the server send the (much larger) welcome again and again
        if (conn.hellos++ > 0) return this.strike(conn);
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
        // the wallet its token named still counts it (`admitSlot`); a sign-in's own slot goes
        this.releaseWallet(conn);
        this.dropHeadroom(conn);
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
      case 'ping': {
        // answered at most every PING_REPLY_MIN_MS (the web client pings every 2 s); more are dropped silently
        const now = Date.now();
        if (now - conn.lastPongAt < PING_REPLY_MIN_MS) return;
        conn.lastPongAt = now;
        conn.send({ t: 'pong', ts: Number(msg.ts) || 0, serverTime: now, serverNow: this.rooms.now() });
        return;
      }
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
      try {
        wallet = await this.auth.verifySignature(msg.address, msg.message, msg.signature);
      } catch (err) {
        if (!(err instanceof SignInBusyError)) throw err;
        // the smart-wallet check cannot run right now: not a wrong signature (the token is kept, the nonce too)
        this.error(conn, 'rate_limited', SIGN_IN_BUSY_MESSAGE);
        return;
      }
    }
    if (!wallet) {
      this.error(conn, 'auth_failed', 'Wallet sign-in failed. Please sign again.');
      return;
    }
    // a reserved slot past the cap was for the wallet that took it: another wallet's sign-in does not keep it
    if (conn.admitSlot !== wallet.toLowerCase() && this.dropHeadroom(conn)) return;
    conn.wallet = wallet;
    // at most SOCKETS_PER_WALLET sockets per wallet: one more replaces its oldest (the wallet its token named still
    // counts this socket too)
    this.claimWallet(conn, wallet);
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
    // the wallet this join is for: an `auth` or `logout` that lands during an await below changes `conn.wallet`, and
    // the join then stops (everything it checked was for this wallet)
    const wallet = conn.wallet;
    // every room entry (practice, private, arena ticket) is gated before anything else is looked at
    conn.joining = true;
    try {
      if (await this.gameClosed(conn, false, wallet)) return;
    } finally {
      conn.joining = false;
    }
    if (conn.wallet !== wallet) return;
    const target = typeof msg.room === 'string' ? parseJoinTarget(msg.room) : null;
    if (!target) {
      this.error(conn, 'bad_request', 'Unknown room');
      return;
    }
    conn.joining = true;
    // integrity evidence only: kept when well-formed, never trusted as an identity
    conn.fp = isFingerprint(msg.fp) ? msg.fp : null;
    try {
      let wantsEmblem = msg.skin === EMBLEM_SKIN_ID;
      let skin = wantsEmblem ? EMBLEM_SKIN_ID : Number.isInteger(msg.skin) && (msg.skin as number) >= 0 && (msg.skin as number) < SKIN_COUNT ? (msg.skin as number) : 0;
      if (wallet) conn.profile = this.profiles?.summary(wallet) ?? null;
      // null: not known right now (the holder index cannot tell, `ClientBudgetError`, or the check is slow: it goes on
      // and is cached); the laurel waits for the next game. Only the emblem skin is a decision: the laurel alone is
      // the answer on record, so a game never spends the holder reads of anyone behind the same address
      const holder =
        wallet && this.holderCheck
          ? await within(
              this.holderCheck(wallet, wantsEmblem).catch((err) => (err instanceof ClientBudgetError ? null : false)),
              HOLDER_CHECK_WAIT_MS,
            )
          : false;
      if (conn.wallet !== wallet) return;
      if (holder === null && wantsEmblem) {
        // a paid seat never waits on a cosmetic check: it starts in the basic skin; a free game asks to try again
        if (target.mode !== 'arena') {
          this.error(conn, 'rate_limited', CLIENT_BUSY_MESSAGE);
          return;
        }
        wantsEmblem = false;
        skin = 0;
      }
      // only the basic skins can be picked, and the emblem skin by emblem holders
      if (wantsEmblem ? !holder : !isBasicSkin(skin)) {
        this.error(conn, 'skin_locked', wantsEmblem ? 'The NFT skin is for Coinnibal NFT holders.' : 'That skin is locked.');
        return;
      }
      // no name, or none usable: "Coinie" and a tag of the wallet (the name the client sends for it) or, for a guest,
      // of this connection (`defaultName`), so players who set no name never become one "Coinie"
      let name = sanitizeName(msg.name, defaultName(wallet ?? `conn:${conn.id}`));
      let flags = holder ? PlayerFlag.Holder : 0;
      if (conn.profile) {
        name = sanitizeName(conn.profile.name, name);
        flags |= PlayerFlag.Verified;
      }
      // the signed-in wallet's own profile picture, when it asked to wear it (guests and bots never have one)
      const avatar = msg.pic === true && wallet ? (this.profiles?.avatar(wallet) ?? null) : null;
      // the flag by the name: an allowlisted ISO 3166-1 alpha-2 code exactly, anything else is no flag
      // (a join that leaves it out entirely takes the signed-in wallet's saved one; '' means no flag)
      const country = isCountryCode(msg.country) ? msg.country : msg.country === undefined && wallet ? (this.profiles?.country(wallet) ?? null) : null;
      // the flag skin: the coin painted with that flag (needs a country; a worn picture wins, so it is
      // not sent with one). A join that leaves `flag` out takes the signed-in wallet's saved choice.
      const wantsFlag = msg.flag === true || (msg.flag === undefined && !!wallet && (this.profiles?.flagSkin(wallet) ?? false));
      if (wantsFlag && country && !avatar) flags |= PlayerFlag.FlagSkin;
      // the linked X handle comes from the server's own store (a client never names one)
      const xHandle = wallet ? (this.xHandleOf?.(wallet) ?? null) : null;

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
      if (!wallet) {
        this.error(conn, 'auth_required', 'Connect and sign in with your wallet first.');
        return;
      }
      // banned wallets cannot start new arena games (a live ticket can still be resumed below: it is their money)
      const banned = this.banGate?.(wallet) === true;
      if (banned && !this.rooms.findArenaStake(target.arenaId, wallet)) {
        this.error(conn, 'banned', 'This wallet is banned from paid arenas after an integrity review. Practice is open.');
        return;
      }
      try {
        await this.joinArena(conn, wallet, target.arenaId, { name, skin, flags, avatar, country, xHandle }, target.code ?? null, target.test === true);
      } catch (err) {
        if (!(err instanceof ChainBusyError)) throw err;
        // the RPC refused us even after the retries: the ticket is untouched on chain, the player tries again
        this.log(`join: arena #${target.arenaId} for ${wallet} — ${err.message}`);
        this.error(conn, 'chain_busy', 'The network is busy. Your ticket is safe on chain: press Resume again in a moment.');
      }
    } finally {
      conn.joining = false;
      // seated (a game, a reclaimed coin): the socket plays (`IDLE_SIGNED_MS`)
      if (conn.player?.alive) conn.playedAt = Date.now();
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
        return await this.readTicket(conn, arenaId, wallet);
      } catch (err) {
        if (!(err instanceof ChainBusyError) || i >= JOIN_CHAIN_RETRY_MS.length || conn.ws.readyState > 1) throw err;
        if (!told) {
          told = true;
          this.error(conn, 'chain_busy', 'The network is busy, retrying your ticket…');
        }
        await sleep(JOIN_CHAIN_RETRY_MS[i]);
        // every retry is a ticket read of its own (the limits per socket, wallet and client count it)
        if (!this.allowTicketRead(conn, wallet, arenaId)) throw err;
      }
    }
  }

  /**
   * One more ticket read for this socket and wallet: per socket (`allowChainOp`), per wallet and per client (a wallet
   * the `Joined` index knows to hold a ticket in `arenaId` counts under the client's known reads, `k`, apart from free
   * wallets' `c`). A wallet the index does not know that is refused has the index read the new blocks
   * (`refreshTicketIndex`): a ticket bought a moment ago is known, with its own reads, by the next try.
   */
  private allowTicketRead(conn: Conn, wallet: string, arenaId: number): boolean {
    const known = this.knowsTicket(arenaId, wallet);
    const ok = conn.allowChainOp() && this.ticketReadsByWallet.allow(wallet.toLowerCase()) && this.ticketReadsByIp.allow(`${known ? 'k' : 'c'} ${rateKey(conn.ip)}`);
    if (!ok && !known) this.chain.refreshTicketIndex?.();
    return ok;
  }

  /** The `Joined`-log index knows `wallet` to hold an open ticket in `arenaId`. */
  private knowsTicket(arenaId: number, wallet: string): boolean {
    return this.chain.knowsOpenTicket?.(arenaId, wallet) === true;
  }

  /**
   * A ticket read within the bounds of the reads waiting at once: server-wide (`TICKET_READ_QUEUE_S`; a wallet the
   * `Joined`-log index does not know to hold a ticket only within `TICKET_READS_UNKNOWN_SHARE` of it) and per client;
   * a wallet the index does not know also per network (an IPv6 /48, an IPv4 /24), waiting and a minute
   * (`TICKET_READS_PER_NET_PER_MIN`). Past one, `ChainBusyError` at once (the join says "network busy" and retries). A
   * wallet the index does not know that is refused, or whose read finds a ticket, has the index read the new blocks
   * (`refreshTicketIndex`): a ticket bought a moment ago is known by the join's next retry, and then no network bound
   * applies to it.
   */
  private async readTicket(conn: Conn, arenaId: number, wallet: string): Promise<ChainSession | null> {
    const max = Math.max(16, Math.ceil(this.cfg.chain.rpcMaxRps * TICKET_READ_QUEUE_S));
    const known = this.knowsTicket(arenaId, wallet);
    const bound = known ? max : Math.max(1, Math.floor(max * TICKET_READS_UNKNOWN_SHARE));
    const keys: [string, number][] = known
      ? [[`k ${rateKey(conn.ip)}`, TICKET_READS_IN_FLIGHT_PER_CLIENT]]
      : [
          [`c ${rateKey(conn.ip)}`, TICKET_READS_IN_FLIGHT_PER_CLIENT],
          [`w ${ticketNet(conn.ip)}`, TICKET_READS_IN_FLIGHT_PER_WIDE],
        ];
    const busy = (why: string): never => {
      if (!known) this.chain.refreshTicketIndex?.();
      throw new TicketReadsBusy('ticket read', new Error(why));
    };
    if (this.ticketReads >= bound) busy(`${this.ticketReads} ticket reads are waiting already`);
    for (const [key, limit] of keys) {
      if ((this.ticketReadsOf.get(key) ?? 0) >= limit) busy(`${limit} ticket reads of ${key.slice(2)} are waiting already`);
    }
    if (!known && !this.ticketReadsByWide.allow(ticketNet(conn.ip))) busy(`the ticket reads of ${ticketNet(conn.ip)} this minute are spent`);
    this.ticketReads++;
    for (const [key] of keys) this.ticketReadsOf.set(key, (this.ticketReadsOf.get(key) ?? 0) + 1);
    try {
      const s = await this.chain.getSession(arenaId, wallet);
      // a ticket the index did not know (bought a moment ago): its next reads (a retry, the bell) have the whole bound
      if (s && !s.finalized && !known) this.chain.refreshTicketIndex?.();
      return s;
    } finally {
      this.ticketReads--;
      for (const [key] of keys) {
        const n = (this.ticketReadsOf.get(key) ?? 1) - 1;
        if (n <= 0) this.ticketReadsOf.delete(key);
        else this.ticketReadsOf.set(key, n);
      }
    }
  }

  /**
   * The arena part of a join (the caller checked the wallet, the gate and the ban). `wallet`: the signed-in wallet the
   * join is for. Every check and the seat are for that wallet only: when the socket's wallet changes during an await
   * (an `auth` or `logout` sent meanwhile) the join stops, so a ticket is never seated under another wallet. `code`:
   * seat the ticket in that paid custom room (an invite-only instance of this arena) instead of a public instance;
   * `test`: in the arena's test arena (testnet only, with practice bots). A live ticket comes back to wherever its coin
   * is, either way. Throws `ChainBusyError`.
   */
  private async joinArena(
    conn: Conn,
    wallet: string,
    arenaId: number,
    look: { name: string; skin: number; flags: number; avatar: string | null; country: string | null; xHandle?: string | null },
    code: string | null = null,
    test = false,
  ): Promise<void> {
    /** The socket is still signed in as the wallet this join is for (false: stop, say nothing more). */
    const same = () => conn.wallet === wallet;
    if (!same()) return;
    const target = { arenaId };
    const { name, skin, flags, avatar, country, xHandle = null } = look;
    // the wallet sits down with its ticket (or comes back to it): a place its join permit held in the arena is given up
    this.ticketSeen?.(wallet, arenaId, null);
    {
      // a live ticket comes back first, with no chain read at all: its coin is in this process already
      const existing = this.rooms.findArenaStake(target.arenaId, wallet);
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
        if (!same()) return;
        // `reattach` rings a due bell first: the ticket may have been settled at that bell just now
        if (!this.rooms.findArenaStake(target.arenaId, wallet) && this.rooms.bellSettled(target.arenaId, wallet)) {
          this.roundEnded(conn);
          return;
        }
        this.error(conn, 'session_busy', 'You are already playing in this arena.');
        return;
      }
      const pick = test ? await this.rooms.testRoom(target.arenaId) : code ? await this.rooms.paidRoom(target.arenaId, code) : await this.rooms.arenaRoom(target.arenaId);
      if (!same()) return; // signed out (or in as another wallet) during the await
      if (pick === 'closed') {
        this.error(conn, 'room_closed', 'This room has closed.');
        // this arena's paid room ended (or is closing): an unseated ticket goes back in full now (a no-show unless it
        // was bought for this room just now: `refundUnseated`)
        if (code) void this.refundUnseated(conn, target.arenaId, code);
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
      // a player back after a bell that settled their ticket while they were away (AFK)
      const bell = this.rooms.bellSettled(target.arenaId, wallet);
      if (bell) {
        const settling = this.journal.pending.some((p) => p.key === bell.session);
        // undefined: the chain could not be read (or this connection is rate-limited); the normal path below decides then
        const live = settling ? null : this.allowTicketRead(conn, wallet, target.arenaId) ? await this.readTicket(conn, target.arenaId, wallet).catch(() => undefined) : undefined;
        if (!same()) return;
        if (settling || live === null || (live && live.id === bell.sessionId && !live.finalized)) {
          this.roundEnded(conn);
          return;
        }
        // a newer ticket (or a payout waiting to be collected): the usual checks apply. When the chain
        // could not be read (`live` undefined) the memo stays, so a later retry still hears round_ended.
        if (live !== undefined) this.rooms.forgetBellSettled(target.arenaId, wallet);
      }
      // a new join (not the AFK return above): only while the round's joins are open (a paid room: its own game's)
      if (this.roundClosed(conn, room)) return;
      // closing for a re-price at its bell: the round plays out, nobody new sits down until the owner signed
      if (this.repricing?.(target.arenaId)) {
        this.seatRefused(wallet, target.arenaId);
        this.error(conn, REFUSAL_CODES.repricing, 'This arena is closing for a moment to update its ticket price. Your ticket is safe on chain: an unseated one is refunded in full.');
        return;
      }
      // the journal cannot be written (disk full): a new seat would hold money the server could not record
      if (this.journal.writeFailing) {
        this.seatRefused(wallet, target.arenaId);
        this.error(conn, REFUSAL_CODES.storage, 'Arena seats are paused for a moment: the server cannot save right now. Your ticket is safe on chain (seated later, or refunded in full).');
        return;
      }
      // badly overloaded: a new seat waits; the ticket stays on chain (seated later, or refunded in full if never played)
      if (this.shedder && !this.shedder.admitCritical()) {
        this.seatRefused(wallet, target.arenaId);
        this.error(conn, 'server_full', 'The server is very busy right now. Your ticket is safe on chain: press Resume again in a minute.');
        return;
      }
      if (!this.allowTicketRead(conn, wallet, target.arenaId)) {
        this.error(conn, 'rate_limited', 'Too many join attempts — wait a moment.');
        return;
      }
      let session: ChainSession | null;
      try {
        session = await this.sessionWithRetry(conn, target.arenaId, wallet);
      } catch (err) {
        // the chain could not be read (not this client's or network's own bounds): the server's failure, not a no-show
        if (err instanceof ChainBusyError && !(err instanceof TicketReadsBusy)) this.seatRefused(wallet, target.arenaId);
        throw err;
      }
      if (!same()) return; // signed out (or in as another wallet) during the retries
      if (!session) {
        this.error(conn, 'no_session', 'No open arena ticket found for your wallet.');
        return;
      }
      // the ticket read is this wallet's own ticket of this arena (the seat and its settlement go to `wallet`)
      if (session.arenaId !== target.arenaId || session.player.toLowerCase() !== wallet.toLowerCase() || session.key !== sessionKey(target.arenaId, wallet, session.id)) {
        this.log(`!!! join: the ticket read for ${wallet} in arena #${target.arenaId} names ${session.player} (${session.key}): not seated`);
        this.error(conn, 'no_session', 'No open arena ticket found for your wallet.');
        return;
      }
      // the wallet's own ticket: it used up the join permits this wallet was given before it was bought
      this.ticketSeen?.(wallet, target.arenaId, session.openedAt);
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
      if (await this.gameClosed(conn, true, wallet)) return;
      if (!same()) return;
      // a holder ticket (holders-only arena, holder fee rates): the emblem is there now, and serves no other open ticket
      if (this.emblemGate) {
        const refused = await this.emblemGate(wallet, session);
        if (!same()) return;
        if (refused) {
          this.error(conn, refused.code, refused.message);
          return;
        }
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
      // the last await: from here to the seat nothing waits, so the socket is still this wallet's at the seat
      if (!same()) return;
      if (!room) {
        // every instance of the public arena is full: the server has no seat for the ticket now
        this.seatRefused(wallet, target.arenaId);
        this.error(conn, 'room_full', 'Arena is full — try again in a moment.');
        return;
      }
      // re-check after the awaits above: another tab may have joined with the same ticket meanwhile (in any instance)
      if (this.rooms.findArenaStake(target.arenaId, wallet) || this.rooms.liveSessions().has(session.key)) {
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
        this.seatRefused(wallet, target.arenaId);
        this.error(conn, REFUSAL_CODES.storage, 'Arena seats are paused for a moment: the server cannot save right now. Your ticket is safe on chain (seated later, or refunded in full).');
        return;
      }
      // a new arena game (not a resumed ticket): refused for a banned wallet (the ban may be new since the check above)
      if (this.banGate?.(wallet) === true) {
        this.error(conn, 'banned', 'This wallet is banned from paid arenas after an integrity review. Practice is open.');
        return;
      }
      if (!code && !test) {
        // joins that came back from their awaits together all confirmed the same instance: the seat is taken now,
        // synchronously, where it is still free (a join storm fills an instance to its seats, then opens the next)
        room = this.rooms.seatArenaNow(target.arenaId, room);
        if (!room) {
          this.seatRefused(wallet, target.arenaId);
          this.error(conn, 'room_full', 'Arena is full — try again in a moment.');
          return;
        }
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
          player: wallet,
          session: session.key,
          sessionId: session.id,
          arenaId: target.arenaId,
          entryFee: session.entryFee,
          // the coin starts at the ticket's value: entry − fee on a fee-on-entry arena (v2), the entry fee on v1
          value: session.value,
          openedAt: session.openedAt,
          // the fee rates fixed into the ticket at join (a holder's are the holder pair): the round result shows the
          // fee the contract takes, not the default one
          ...(session.rates ? { rates: session.rates } : {}),
        },
      });
    }
  }
}
