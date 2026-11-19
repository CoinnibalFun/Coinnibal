import { JOIN_PERMIT_MAX_WINDOW_S, type JoinPermit, type JoinPermitError } from '@coinnibal/shared';
import { getAddress } from 'viem';
import { ChainBusyError, type ChainArena, type ChainGateway } from '../chain/types';
import { subnetOf } from '../net/ip-key';
import { Limiter } from '../net/limiter';

/**
 * Join permits (CoinnibalArena v4; 2026-11 audit S16). `join` needs a short-lived EIP-712 permit signed by the server
 * key, so the server decides who may buy a ticket. Before the permit, anyone could fill an arena's `maxSessions` with
 * tickets nobody played, get every entry fee back from the stale sweeper 15 minutes later, and do it again.
 *
 * A permit is issued only to a signed-in wallet, and only when:
 *  - the game is open for that wallet (`GAME_ACCESS` / the admin's setting) and it is not banned;
 *  - paid rooms are on, the arena exists and is enabled on chain, the contract is not paused, and the server does not
 *    keep the arena closed (books guard, re-price); in a holders-only arena, the wallet holds the NFT;
 *  - the wallet has no open ticket there (a ticket is resumed, never bought twice);
 *  - neither the wallet nor the network it asks from is a repeated no-show: `noShowLimit` tickets of the wallet
 *    cancelled unseated (while their arena was open) in 24 h, or 3× that many bought with permits asked from one IPv4
 *    address or IPv6 /64, or 8× from one IPv6 /48, close the permits until the oldest of them is a day old;
 *  - the networks it is asked from have fewer than their share of the arena's outstanding permits: issued there and not
 *    played yet (valid and unused, or used for a ticket that is not seated, not settled and not cancelled), at most
 *    `openPerIp` per IPv4 address (8: carrier NAT puts many players behind one), `openPerNet` per IPv6 /64 (4) and
 *    `openPerSite` per IPv6 /48 (16). Refused: `network_busy`. Without it, one /48 (or a few IPv4 addresses) could
 *    collect a permit per throwaway wallet and fill the arena's `maxSessions` with tickets nobody plays;
 *  - the arena's unseated tickets plus the places other new permits hold there stay under its cap (the seats a round
 *    can take, or `JOIN_PERMIT_ARENA_CAP`);
 *  - the caller's IP (and IPv6 /64 and /48) and wallet are under their request limits.
 * One live permit per wallet and arena: asking again returns the same permit while it is valid, unused and signed for
 * the arena contract in use (a new contract, registered live, starts every permit, place and share afresh).
 *
 * A permit is free, so it holds a place in the cap only briefly and only when backed: a new permit holds one for
 * `holdS` (120 s: the approval and the join) when the wallet holds the entry fee, no earlier permit of that wallet,
 * arena and join nonce held one, and the network it was asked from holds fewer than `holdsPerNet` places (an IPv4
 * address or an IPv6 /64) and `holdsPerSite` (an IPv6 /48). Any other permit is still issued; it holds nothing. A
 * place is given up as soon as the permit is used or cannot be: the wallet asks to sit with its ticket, the ticket is
 * read, seated or settled, or the wallet's join nonce moved (one nonce serves every arena; read at the wallet's next
 * request, and for every held place once the arena reaches its cap).
 *
 * A permit leaves its networks' share only when it is played or cannot be any more: its ticket is seated or settled
 * (a no-show included), or, read once the network is at its share (at most once per 10 s per permit), the permit is no
 * longer valid and the wallet holds no ticket there. Asking to sit, or asking again from the same wallet, frees nothing.
 */

export interface JoinPermitConfig {
  /** Seconds a permit stays valid (at most `JOIN_PERMIT_TTL_MAX_S`). */
  ttlS: number;
  /** Permit requests per IP per 10 minutes. */
  perIp: number;
  /** Permit requests per IPv6 /64 per 10 minutes. */
  perSubnet: number;
  /** Permit requests per IPv6 /48 per 10 minutes. */
  perSite: number;
  /** Permit requests per wallet per 10 minutes. */
  perWallet: number;
  /** Unseated tickets plus held places an arena may have at once; 0: the seats a round can take there. */
  arenaCap: number;
  /**
   * Tickets cancelled unseated in 24 h after which a wallet gets no permit (until the oldest is a day old); 3× as many
   * per IPv4 address or IPv6 /64 the permits were asked from, 8× per IPv6 /48. 0: off.
   */
  noShowLimit: number;
  /** Seconds a new permit holds a place in its arena's cap while unused; 0: permits hold no place. */
  holdS: number;
  /** Places held at once by permits asked from one IPv4 address or IPv6 /64 (every arena). */
  holdsPerNet: number;
  /** Places held at once by permits asked from one IPv6 /48 (every arena). */
  holdsPerSite: number;
  /**
   * An arena's outstanding permits (not played yet: valid and unused, or used for a ticket not seated or settled)
   * asked from one IPv4 address; at that many the address gets no new permit there (`network_busy`). 0: no limit.
   */
  openPerIp: number;
  /** The same per IPv6 /64. 0: no limit. */
  openPerNet: number;
  /** The same per IPv6 /48. 0: no limit. */
  openPerSite: number;
}

export const JOIN_PERMIT_DEFAULTS: JoinPermitConfig = {
  ttlS: 600,
  perIp: 12,
  perSubnet: 30,
  perSite: 60,
  perWallet: 20,
  arenaCap: 0,
  noShowLimit: 3,
  holdS: 120,
  holdsPerNet: 4,
  holdsPerSite: 16,
  openPerIp: 8,
  openPerNet: 4,
  openPerSite: 16,
};

/**
 * The longest permit the server signs: the contract's window (`JOIN_PERMIT_MAX_WINDOW_S`, checked against the block
 * time) less 5 minutes, so a block time that trails the chain clock the server reads never refuses every join.
 */
export const JOIN_PERMIT_TTL_MAX_S = JOIN_PERMIT_MAX_WINDOW_S - 300;

/** The window of the request limits. */
const LIMIT_WINDOW_MS = 10 * 60_000;
/** The window no-shows are counted in. */
export const NO_SHOW_WINDOW_MS = 24 * 3600_000;
/** No-shows per IPv4 address or IPv6 /64, and per IPv6 /48, as multiples of `noShowLimit`. */
export const NET_NO_SHOW_FACTOR = 3;
export const SITE_NO_SHOW_FACTOR = 8;
/** A kept permit is handed out again only while it has at least this long left (the wallet needs time to sign). */
const REUSE_MIN_LEFT_S = 120;
/** At the cap, a held place's join nonce is read again (its ticket may be bought) at most this often; at a network's
 * share, an outstanding permit's ticket likewise. */
const RECHECK_MS = 10_000;
/** A permit signed up to this long after a ticket's block time counts as signed before it (block times trail). */
const TICKET_CLOCK_SLACK_S = 5;
/** Permits and permit records remembered at most (expired, then the oldest go first). */
const MAX_KEPT = 50_000;
const MAX_ISSUED = 200_000;
const MAX_NET_KEYS = 50_000;
/** Requesters remembered per wallet, arena and nonce (a no-show of its ticket counts against each). */
const MAX_REQUESTERS = 4;

export interface JoinPermitDeps {
  chain: ChainGateway;
  /** Whether the game is open for `wallet` (`SiteApi.gameOpenFor`). */
  gameOpenFor: (wallet: string) => Promise<boolean>;
  /** The integrity ban list (banned wallets are never seated, so they get no ticket either). */
  isBanned?: (wallet: string) => boolean;
  /** Whether `wallet` holds the Coinnibal NFT (holders-only arenas). Absent: not checked (the contract refuses). */
  isHolder?: (wallet: string) => Promise<boolean>;
  /** Arenas the server keeps closed (books guard, re-price): no ticket is sold there. */
  blocked: () => readonly number[];
  /** Keys (`<arenaId>:<player>:<sessionId>`) of the tickets seated in a room now. */
  seatedKeys: () => Set<string>;
  /** Keys of the tickets queued for settlement (open on chain, being paid out). */
  pendingKeys: () => Iterable<string>;
  /** The seats a round can take in an arena (the default cap). */
  seatsPerRound: (arenaId: number) => number;
  /** Unix ms of each no-show of `wallet` (a ticket cancelled unseated while its arena was open) since `since`. */
  noShows: (wallet: string, since: number) => number[];
  cfg?: Partial<JoinPermitConfig>;
  /** The server clock (rate limits, held places, no-show windows). Permit deadlines use the chain's (`chainNow`). */
  now?: () => number;
  log?: (m: string) => void;
}

/** A refused permit: the HTTP status, the code and the message for the player. */
export class JoinPermitFail extends Error {
  constructor(
    readonly status: number,
    readonly code: JoinPermitError,
    message: string,
    /** `no_show`: when permits open again (Unix ms). */
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

/** The network an IPv6 address is limited by (/64); null for IPv4 (one address per player there). */
export function ipv6Net(ip: string): string | null {
  const net = subnetOf(ip);
  return net.endsWith('::/64') ? net : null;
}

/**
 * Who asked for a permit, by the keys its place and no-show limits use: `net` an IPv4 address or an IPv6 /64 (one
 * provider customer usually gets a whole /64), `site` the IPv6 /48 (a larger customer's; null for IPv4).
 */
export interface Requester {
  net: string;
  site: string | null;
}

export function requesterOf(ip: string): Requester {
  const v4 = /^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (v4) return { net: v4[1], site: null };
  const net = ipv6Net(ip);
  if (!net) return { net: ip.toLowerCase(), site: null };
  return { net, site: `${net.slice(0, -'::/64'.length).split(':').slice(0, 3).join(':')}::/48` };
}

const playerOf = (key: string): { arenaId: number; player: string } | null => {
  const m = /^(\d{1,5}):(0x[0-9a-f]{40}):/i.exec(key);
  return m ? { arenaId: Number(m[1]), player: m[2].toLowerCase() } : null;
};

/** The wallet (lower case) of a permit key `<arenaId>:<wallet>`. */
const walletOf = (key: string): string => key.slice(key.indexOf(':') + 1);

/** Every requester key (`net`, and `site` when there is one) of `by`. */
function requesterKeys(by: readonly Requester[]): Set<string> {
  const keys = new Set<string>();
  for (const b of by) {
    keys.add(b.net);
    if (b.site !== null) keys.add(b.site);
  }
  return keys;
}

interface Kept {
  permit: JoinPermit;
  /** When it was signed, on the chain's clock (Unix s). */
  issuedS: number;
}

interface Hold {
  arenaId: number;
  /** Lower case. */
  wallet: string;
  /** Server clock (Unix ms): the place is given up then. */
  until: number;
  by: Requester;
  /** Server clock (Unix ms) of the last re-read of the wallet's join nonce at the cap (0: never). */
  checkedAt: number;
}

/** The permits of one wallet and arena, for its latest join nonce. */
interface Issued {
  nonce: string;
  /** A permit of this nonce held a place already: the next one of the same nonce holds none. */
  held: boolean;
  /** Server clock (Unix ms) of the latest permit. */
  at: number;
  /** Who asked for the permits of this nonce (a no-show of the ticket bought with one counts against each). */
  by: Requester[];
  /** The deadline of the latest permit (Unix s, the chain's clock). */
  deadlineS: number;
  /** It counts against the share of every network in `by`: not played, settled or found unused yet. */
  open: boolean;
  /** Server clock (Unix ms) of the last read of its ticket at a network's share (0: never). */
  checkedAt: number;
}

export class JoinPermits {
  private readonly cfg: JoinPermitConfig;
  private readonly now: () => number;
  private readonly ipLimit: Limiter;
  private readonly netLimit: Limiter;
  private readonly siteLimit: Limiter;
  private readonly walletLimit: Limiter;
  /** The live permit of each `<arenaId>:<wallet lower>`. */
  private readonly kept = new Map<string, Kept>();
  /** Places held in arena caps, by `<arenaId>:<wallet lower>`. */
  private readonly holds = new Map<string, Hold>();
  /** The latest permits of each `<arenaId>:<wallet lower>` (kept a day: the no-shows of its ticket). */
  private readonly issued = new Map<string, Issued>();
  /** Unix ms of the no-shows of tickets bought with permits asked from each requester key (`net` / `site`). */
  private readonly netNoShows = new Map<string, number[]>();
  /** Arena ids seen (a used nonce voids the wallet's permits in each). */
  private readonly arenaIds = new Set<number>();
  /** The re-read of an arena's held places running now (requests at the cap wait for it). */
  private readonly rechecking = new Map<number, Promise<number>>();
  /** The open records (`<arenaId>:<wallet>`) of each `<arenaId>|<requester key>`: that network's outstanding permits. */
  private readonly openBy = new Map<string, Set<string>>();
  /** The re-read of a network's outstanding permits running now, by `<arenaId>|<requester key>`. */
  private readonly sharesChecking = new Map<string, Promise<number>>();
  /** Permits being prepared now, by `<arenaId>|<requester key>`: they count in the share (a burst passes it together). */
  private readonly inflight = new Map<string, number>();
  /** The arena contract (`<chainId>:<address>`) the permits, places and shares are for; null: none seen yet. */
  private contract: string | null = null;

  constructor(private readonly d: JoinPermitDeps) {
    this.cfg = { ...JOIN_PERMIT_DEFAULTS, ...d.cfg };
    this.cfg.ttlS = Math.max(60, Math.min(JOIN_PERMIT_TTL_MAX_S, Math.floor(this.cfg.ttlS)));
    this.cfg.holdS = Math.max(0, Math.min(this.cfg.ttlS, Math.floor(this.cfg.holdS)));
    this.now = d.now ?? Date.now;
    this.ipLimit = new Limiter(this.cfg.perIp, LIMIT_WINDOW_MS);
    this.netLimit = new Limiter(this.cfg.perSubnet, LIMIT_WINDOW_MS);
    this.siteLimit = new Limiter(this.cfg.perSite, LIMIT_WINDOW_MS);
    this.walletLimit = new Limiter(this.cfg.perWallet, LIMIT_WINDOW_MS);
  }

  /** The settings in use (admins and tests). */
  get config(): Readonly<JoinPermitConfig> {
    return this.cfg;
  }

  /** The chain's clock (Unix s): permit deadlines are checked against the block time, never the server's clock. */
  private chainNowS(): number {
    return Math.floor((this.d.chain.chainNow?.() ?? this.now()) / 1000);
  }

  /** When `wallet`'s permits open again after its no-shows (Unix ms); null when it may get one. */
  noShowUntil(wallet: string): number | null {
    const now = this.now();
    return untilBelow(this.d.noShows(wallet, now - NO_SHOW_WINDOW_MS), this.cfg.noShowLimit, now);
  }

  /** When permits asked from `ip` open again after the no-shows of tickets bought with them (Unix ms); null: open. */
  netNoShowUntil(ip: string): number | null {
    const limit = this.cfg.noShowLimit;
    if (limit <= 0) return null;
    const by = requesterOf(ip);
    const now = this.now();
    const net = untilBelow(this.netTimes(by.net, now), limit * NET_NO_SHOW_FACTOR, now);
    const site = by.site === null ? null : untilBelow(this.netTimes(by.site, now), limit * SITE_NO_SHOW_FACTOR, now);
    return net === null ? site : site === null ? net : Math.max(net, site);
  }

  private netTimes(key: string, now: number): number[] {
    const times = this.netNoShows.get(key);
    if (!times) return [];
    const live = times.filter((t) => t >= now - NO_SHOW_WINDOW_MS);
    if (live.length === 0) this.netNoShows.delete(key);
    else if (live.length < times.length) this.netNoShows.set(key, live);
    return live;
  }

  /**
   * An arena's unseated tickets (open on chain, not seated in a room, not being paid out), the places other new
   * permits hold there, and its cap. A permit whose ticket is seated is done (dropped here).
   */
  async load(arenaId: number, openSessions: number, except: string | null = null): Promise<{ used: number; cap: number; unseated: number; held: number }> {
    const now = this.now();
    const seatedHere = this.seatedIn(arenaId);
    let pending = 0;
    for (const k of this.d.pendingKeys()) {
      const p = playerOf(k);
      if (p && p.arenaId === arenaId && !seatedHere.has(p.player)) pending++;
    }
    const unseated = Math.max(0, openSessions - seatedHere.size - pending);
    let held = 0;
    for (const [key, h] of this.holds) {
      if (h.until <= now) {
        this.holds.delete(key);
        continue;
      }
      if (h.arenaId !== arenaId || key === except) continue;
      // its ticket is seated: the permit is used (that ticket counts as seated, not as a place)
      if (seatedHere.has(h.wallet)) {
        this.drop(key);
        continue;
      }
      held++;
    }
    const cap = this.cfg.arenaCap > 0 ? this.cfg.arenaCap : Math.max(1, this.d.seatsPerRound(arenaId));
    return { used: unseated + held, cap, unseated, held };
  }

  /** The wallets (lower case) seated in a room of `arenaId` now. */
  private seatedIn(arenaId: number): Set<string> {
    const seated = new Set<string>();
    for (const k of this.d.seatedKeys()) {
      const p = playerOf(k);
      if (p && p.arenaId === arenaId) seated.add(p.player);
    }
    return seated;
  }

  /** Places held now by permits asked from `by`'s IPv4 address or IPv6 /64, and from its /48 (every arena). */
  private heldBy(by: Requester, now: number): { net: number; site: number } {
    let net = 0;
    let site = 0;
    for (const h of this.holds.values()) {
      if (h.until <= now) continue;
      if (h.by.net === by.net) net++;
      if (by.site !== null && h.by.site === by.site) site++;
    }
    return { net, site };
  }

  /** The wallet holds at least `fee` of the game token (one read at normal priority); unknown counts as no. */
  private async funded(wallet: string, fee: number): Promise<boolean> {
    const chain = this.d.chain;
    if (!chain.tokenBalance) return true; // no balance read (the dev fake chain): the contract's transfer decides
    try {
      return (await chain.tokenBalance(wallet)) >= fee;
    } catch {
      return false;
    }
  }

  /** Drops the permit and the place of `<arenaId>:<wallet>`. */
  private drop(key: string): void {
    this.kept.delete(key);
    this.holds.delete(key);
  }

  /** `wallet`'s join nonce is `nonce` now: every permit of an earlier nonce is used up (one nonce serves every arena). */
  private nonceIs(wallet: string, nonce: bigint): void {
    for (const id of this.arenaIds) {
      const key = `${id}:${wallet}`;
      const k = this.kept.get(key);
      if (k && BigInt(k.permit.nonce) < nonce) this.drop(key);
    }
  }

  /**
   * At the cap: re-reads the join nonce of each wallet holding a place in `arenaId` (not re-read in the last 10 s)
   * and drops the permits whose ticket was bought meanwhile (a client that never asked to sit). The reads run at once:
   * the RPC layer merges them into multicalls. Returns how many places were given up.
   */
  private recheck(arenaId: number, except: string): Promise<number> {
    const running = this.rechecking.get(arenaId);
    if (running) return running;
    const chain = this.d.chain;
    const now = this.now();
    const todo: Kept[] = [];
    for (const [key, h] of this.holds) {
      if (h.arenaId !== arenaId || key === except || h.until <= now || now - h.checkedAt < RECHECK_MS) continue;
      const k = this.kept.get(key);
      if (!k) {
        this.holds.delete(key);
        continue;
      }
      h.checkedAt = now;
      todo.push(k);
    }
    if (todo.length === 0 || !chain.joinNonce) return Promise.resolve(0);
    const read = chain.joinNonce.bind(chain);
    const run = Promise.all(
      todo.map(async (k) => {
        try {
          const nonce = await read(k.permit.player);
          if (nonce <= BigInt(k.permit.nonce)) return 0;
          this.nonceIs(k.permit.player.toLowerCase(), nonce);
          return 1;
        } catch {
          return 0; // unknown: the place stays (read again at a later refusal)
        }
      }),
    )
      .then((r) => r.reduce<number>((a, b) => a + b, 0))
      .finally(() => this.rechecking.delete(arenaId));
    this.rechecking.set(arenaId, run);
    return run;
  }

  /**
   * The gateway saw `wallet`'s ticket of `arenaId`. `openedAtS` null: the wallet asked to sit with a ticket there (it
   * bought one, or it gives up its own place: either way it holds none now). A number: the ticket was read, opened at
   * that block time; it used up every permit of the wallet signed before then, in any arena (one nonce serves all).
   */
  ticketSeen(walletIn: string, arenaId: number, openedAtS: number | null): void {
    const wallet = walletIn.toLowerCase();
    const key = `${arenaId}:${wallet}`;
    this.holds.delete(key);
    if (openedAtS === null) return;
    // this arena's permit bought the ticket: it stays in its networks' share until the ticket is seated or settled
    this.kept.delete(key);
    for (const id of this.arenaIds) {
      const other = `${id}:${wallet}`;
      const k = this.kept.get(other);
      if (id !== arenaId && k && k.issuedS <= openedAtS + TICKET_CLOCK_SLACK_S) {
        // its nonce bought this ticket: that permit can buy nothing any more
        this.drop(other);
        this.close(other);
      }
    }
  }

  /**
   * `wallet`'s ticket of `arenaId` was settled or cancelled: its permit is done. `noShow`: it was cancelled unseated
   * while its arena was open, which also counts against every network its permits were asked from.
   */
  ticketDone(walletIn: string, arenaId: number, noShow = false): void {
    const wallet = walletIn.toLowerCase();
    const key = `${arenaId}:${wallet}`;
    this.drop(key);
    this.close(key);
    if (!noShow || this.cfg.noShowLimit <= 0) return;
    const rec = this.issued.get(key);
    if (!rec) return;
    const now = this.now();
    const keys = new Set<string>();
    for (const by of rec.by) {
      keys.add(by.net);
      if (by.site !== null) keys.add(by.site);
    }
    for (const k of keys) {
      const times = this.netTimes(k, now);
      if (times.length === 0 && this.netNoShows.size >= MAX_NET_KEYS) this.netNoShows.delete(this.netNoShows.keys().next().value!);
      this.netNoShows.set(k, [...times, now]);
    }
    this.d.log?.(`permits: no-show of ${wallet} in arena #${arenaId} counted against ${[...keys].join(', ')}`);
  }

  private prune(): void {
    const nowS = this.chainNowS();
    const now = this.now();
    for (const [k, p] of this.kept) if (p.permit.deadline < nowS) this.kept.delete(k);
    while (this.kept.size >= MAX_KEPT) this.kept.delete(this.kept.keys().next().value!);
    for (const [k, h] of this.holds) if (h.until <= now) this.holds.delete(k);
    // oldest first (a record is re-inserted when it changes)
    for (const [k, r] of this.issued) {
      if (r.at >= now - NO_SHOW_WINDOW_MS && this.issued.size < MAX_ISSUED) break;
      this.close(k);
      this.issued.delete(k);
    }
  }

  /**
   * Remembers who asked for a permit of `nonce` (a no-show of its ticket counts against them). A permit issued, or
   * handed out again, is outstanding: it counts against the share of every network that asked for it.
   */
  private record(key: string, permit: JoinPermit, by: Requester, held: boolean): void {
    const nonce = permit.nonce;
    const was = this.issued.get(key);
    const same = !!was && was.nonce === nonce;
    if (was) this.close(key);
    const list = same ? was.by.filter((b) => b.net !== by.net) : [];
    list.push(by);
    this.issued.delete(key);
    const rec: Issued = { nonce, held: (same && was.held) || held, at: this.now(), by: list.slice(-MAX_REQUESTERS), deadlineS: permit.deadline, open: true, checkedAt: 0 };
    this.issued.set(key, rec);
    this.index(key, rec, true);
  }

  /** Adds `key` to (or removes it from) the outstanding permits of every network of `rec`. */
  private index(key: string, rec: Issued, add: boolean): void {
    const arenaId = key.slice(0, key.indexOf(':'));
    for (const k of requesterKeys(rec.by)) {
      const at = `${arenaId}|${k}`;
      const set = this.openBy.get(at);
      if (add) {
        if (set) set.add(key);
        else this.openBy.set(at, new Set([key]));
      } else if (set) {
        set.delete(key);
        if (set.size === 0) this.openBy.delete(at);
      }
    }
  }

  /** The permit of `key` leaves its networks' share: its ticket was played or settled, or it bought none and cannot. */
  private close(key: string): void {
    const rec = this.issued.get(key);
    if (!rec || !rec.open) return;
    rec.open = false;
    this.index(key, rec, false);
  }

  /** The share of an arena's outstanding permits each network of `by` may have (an IPv4 address, an IPv6 /64, a /48). */
  private shares(by: Requester): { key: string; max: number }[] {
    const out: { key: string; max: number }[] = [];
    const net = by.net.endsWith('::/64') ? this.cfg.openPerNet : this.cfg.openPerIp;
    if (net > 0) out.push({ key: by.net, max: net });
    if (by.site !== null && this.cfg.openPerSite > 0) out.push({ key: by.site, max: this.cfg.openPerSite });
    return out;
  }

  /**
   * The outstanding permits of `arenaId` asked from network `net`, other than `except`'s. A permit whose ticket is
   * seated now is played: it leaves the share here.
   */
  private outstanding(arenaId: number, net: string, except: string, seated: Set<string>): number {
    const at = `${arenaId}|${net}`;
    let n = this.inflight.get(at) ?? 0;
    const set = this.openBy.get(at);
    if (!set) return n;
    for (const key of [...set]) {
      if (key === except) continue;
      if (seated.has(walletOf(key))) this.close(key);
      else n++;
    }
    return n;
  }

  /** The first network of `by` at its share of `arenaId`'s outstanding permits; null when every one is under it. */
  private fullShare(arenaId: number, by: Requester, except: string): string | null {
    const seated = this.seatedIn(arenaId);
    return this.shares(by).find((s) => this.outstanding(arenaId, s.key, except, seated) >= s.max)?.key ?? null;
  }

  /**
   * At a network's share: reads the ticket of each outstanding permit of `net` in `arenaId` that has expired and was
   * not read in the last 10 s. One whose wallet holds no ticket there bought none (or its ticket is settled): it leaves
   * the share. A permit still valid counts unread: unused, or its ticket bought a moment ago (the contract checks the
   * deadline at the join, so an expired permit buys nothing more). Returns how many left.
   */
  private recheckShare(arenaId: number, net: string, except: string): Promise<number> {
    const at = `${arenaId}|${net}`;
    const running = this.sharesChecking.get(at);
    if (running) return running;
    const chain = this.d.chain;
    const now = this.now();
    const nowS = this.chainNowS();
    const todo: string[] = [];
    for (const key of this.openBy.get(at) ?? []) {
      const rec = this.issued.get(key);
      if (key === except || !rec || rec.deadlineS >= nowS || now - rec.checkedAt < RECHECK_MS) continue;
      rec.checkedAt = now;
      todo.push(key);
    }
    if (todo.length === 0) return Promise.resolve(0);
    const hasTicket = async (wallet: string) => (chain.hasOpenTicket ? chain.hasOpenTicket(arenaId, wallet) : (await chain.getSession(arenaId, wallet)) !== null);
    const run = Promise.all(
      todo.map(async (key) => {
        try {
          if (await hasTicket(getAddress(walletOf(key)))) return 0;
          this.close(key);
          return 1;
        } catch {
          return 0; // unknown: it stays in the share (read again at a later refusal)
        }
      }),
    )
      .then((r) => r.reduce<number>((a, b) => a + b, 0))
      .finally(() => this.sharesChecking.delete(at));
    this.sharesChecking.set(at, run);
    return run;
  }

  /**
   * The arena contract in use is `st`'s: a new one (registered live by an admin) starts the permits, places and shares
   * afresh, since none of them is about its tickets (its nonces start again at 0). The no-shows of the networks stay.
   */
  private contractIs(st: { chainId: number | null; arenaAddress: string | null }): void {
    if (st.chainId === null || !st.arenaAddress) return; // unknown for now (the chain is down): nothing to compare
    const c = `${st.chainId}:${st.arenaAddress.toLowerCase()}`;
    if (c === this.contract) return;
    if (this.contract !== null) {
      this.d.log?.(`permits: arena contract changed (${this.contract} → ${c}): earlier permits, places and shares dropped`);
      this.kept.clear();
      this.holds.clear();
      this.issued.clear();
      this.openBy.clear();
      this.arenaIds.clear();
    }
    this.contract = c;
  }

  /** A permit for `wallet` (signed in) to buy one ticket of `arenaId`; throws `JoinPermitFail`. */
  async issue(walletIn: string, arenaId: number, ip: string): Promise<JoinPermit> {
    if (!Number.isInteger(arenaId) || arenaId < 1 || arenaId > 65_535) throw new JoinPermitFail(400, 'bad_request', 'arenaId must be an arena number.');
    const wallet = getAddress(walletIn);
    const lower = wallet.toLowerCase();
    const now = this.now();
    const net = ipv6Net(ip);
    const by = requesterOf(ip);
    // every request counts (a kept permit handed out again too): each one may read the chain
    const ipOk = this.ipLimit.allow(ip, now);
    const netOk = net === null || this.netLimit.allow(net, now);
    const siteOk = by.site === null || this.siteLimit.allow(by.site, now);
    const walletOk = this.walletLimit.allow(lower, now);
    if (!ipOk || !netOk || !siteOk || !walletOk) throw new JoinPermitFail(429, 'rate_limited', 'Too many ticket requests. Wait a few minutes, then try again.');
    if (!(await this.d.gameOpenFor(wallet).catch(() => false))) throw new JoinPermitFail(403, 'game_closed', 'The game is not open to this wallet yet.');
    if (this.d.isBanned?.(wallet)) throw new JoinPermitFail(403, 'banned', 'This wallet may not play paid rooms.');
    const chain = this.d.chain;
    if (!chain.stakeEnabled || !chain.joinNonce || !chain.signJoinPermit) throw new JoinPermitFail(503, 'arenas_off', 'Paid rooms are not open right now.');
    if (chain.joinsPaused?.()) throw new JoinPermitFail(409, 'arena_closed', 'Ticket sales are paused right now. Try again later.');
    if (this.d.blocked().includes(arenaId)) throw new JoinPermitFail(409, 'arena_closed', 'This room is closed for maintenance right now. Try again later.');
    let arenas;
    try {
      arenas = await chain.listArenas();
    } catch (err) {
      throw busy(err);
    }
    // the arena contract in use now (an admin can register a new one without a restart)
    const st = chain.status();
    this.contractIs(st);
    for (const a of arenas) this.arenaIds.add(a.id);
    const arena = arenas.find((a) => a.id === arenaId);
    if (!arena || !arena.enabled) throw new JoinPermitFail(409, 'arena_closed', 'This room is not open.');
    // the contract refuses a non-holder's ticket there: no permit (it could only hold a place)
    if (arena.holdersOnly && this.d.isHolder && !(await this.d.isHolder(wallet).catch(() => false))) {
      throw new JoinPermitFail(403, 'holders_only', 'This room is for Coinnibal NFT holders. Get the NFT to play here.');
    }
    const until = this.noShowUntil(wallet);
    if (until !== null) {
      throw new JoinPermitFail(
        403,
        'no_show',
        `Your last ${this.cfg.noShowLimit} tickets were never played and went back unplayed within a day, so new tickets pause for a while.`,
        until,
      );
    }
    const netUntil = this.netNoShowUntil(ip);
    if (netUntil !== null) {
      this.d.log?.(`permits: ${by.net}${by.site ? ` (${by.site})` : ''} has too many no-shows today — refused ${wallet}`);
      throw new JoinPermitFail(403, 'no_show', 'Too many tickets bought from your network went back unplayed today, so new tickets pause for a while.', netUntil);
    }
    const key = `${arenaId}:${lower}`;
    try {
      const open = chain.hasOpenTicket ? await chain.hasOpenTicket(arenaId, wallet) : (await chain.getSession(arenaId, wallet)) !== null;
      if (open) {
        this.drop(key);
        throw new JoinPermitFail(409, 'session_open', 'You already hold a ticket for this room: resume it, no new ticket needed.');
      }
    } catch (err) {
      if (err instanceof JoinPermitFail) throw err;
      throw busy(err);
    }
    let nonce: bigint;
    try {
      nonce = await chain.joinNonce(wallet);
    } catch (err) {
      throw busy(err);
    }
    // a nonce that moved used up the wallet's earlier permits, in every arena
    this.nonceIs(lower, nonce);
    const nonceStr = nonce.toString();
    const nowS = this.chainNowS();
    const kept = this.kept.get(key);
    // one live permit per wallet and arena: the same one again while it is valid, unused and signed for the arena
    // contract in use (it holds no new place, and stays one permit in its networks' share)
    if (kept && kept.permit.nonce === nonceStr && kept.permit.deadline - nowS >= REUSE_MIN_LEFT_S && signedFor(kept.permit, st)) {
      this.record(key, kept.permit, by, false);
      return kept.permit;
    }
    // each network it is asked from has a share of the arena's outstanding permits (unused, or a ticket not played yet)
    let full = this.fullShare(arenaId, by, key);
    if (full !== null) {
      const left = await Promise.all(this.shares(by).map((sh) => this.recheckShare(arenaId, sh.key, key)));
      if (left.some((n) => n > 0)) full = this.fullShare(arenaId, by, key);
    }
    if (full !== null) {
      this.d.log?.(`permits: ${full} has its share of arena #${arenaId}'s outstanding permits — refused ${wallet}`);
      throw new JoinPermitFail(409, 'network_busy', 'Enough tickets for this room were asked from your network and are not played yet. Try again in a few minutes.');
    }
    // counted at once, before anything is awaited: requests from the same network running meanwhile see it
    const reserved = this.shares(by).map((sh) => `${arenaId}|${sh.key}`);
    for (const at of reserved) this.inflight.set(at, (this.inflight.get(at) ?? 0) + 1);
    try {
      return await this.grant(wallet, arena, key, nonce, nowS, by, now);
    } finally {
      for (const at of reserved) {
        const n = (this.inflight.get(at) ?? 1) - 1;
        if (n > 0) this.inflight.set(at, n);
        else this.inflight.delete(at);
      }
    }
  }

  /** The arena's cap, the place the permit holds, the signature: the rest of `issue`. */
  private async grant(wallet: string, arena: ChainArena, key: string, nonce: bigint, nowS: number, by: Requester, now: number): Promise<JoinPermit> {
    const arenaId = arena.id;
    const lower = wallet.toLowerCase();
    const nonceStr = nonce.toString();
    const chain = this.d.chain;
    let { used, cap } = await this.load(arenaId, arena.openSessions, key);
    // a held place whose ticket was bought counts twice (its ticket is unseated too): read the holders' nonces again
    if (used >= cap && (await this.recheck(arenaId, key)) > 0) ({ used, cap } = await this.load(arenaId, arena.openSessions, key));
    if (used >= cap) {
      this.d.log?.(`permits: arena #${arenaId} at its cap (${used}/${cap} unseated tickets + held places) — refused ${wallet}`);
      throw new JoinPermitFail(409, 'arena_busy', 'This room has as many tickets waiting for a seat as a round can take. Try again in a minute.');
    }
    // a place for the approval and the join: the first of this nonce to hold one, a wallet that can pay, a network
    // under its share of places
    const rec = this.issued.get(key);
    let hold = false;
    if (this.cfg.holdS > 0 && !(rec && rec.nonce === nonceStr && rec.held)) {
      const mine = this.heldBy(by, now);
      const under = mine.net < this.cfg.holdsPerNet && (by.site === null || mine.site < this.cfg.holdsPerSite);
      hold = under && (await this.funded(wallet, arena.entryFee));
    }
    const deadline = nowS + this.cfg.ttlS;
    let permit: JoinPermit;
    try {
      permit = await chain.signJoinPermit!(wallet, arenaId, nonce, deadline);
    } catch (err) {
      throw busy(err);
    }
    this.prune();
    this.kept.set(key, { permit, issuedS: nowS });
    this.holds.delete(key);
    if (hold) this.holds.set(key, { arenaId, wallet: lower, until: now + this.cfg.holdS * 1000, by, checkedAt: 0 });
    this.record(key, permit, by, hold);
    return permit;
  }
}

/** `permit` is signed for the arena contract `st` names, on its chain. */
function signedFor(permit: JoinPermit, st: { chainId: number | null; arenaAddress: string | null }): boolean {
  return st.arenaAddress !== null && permit.arena.toLowerCase() === st.arenaAddress.toLowerCase() && permit.chainId === st.chainId;
}

/** When fewer than `limit` of `times` are left in the no-show window (Unix ms); null when that is so already. */
function untilBelow(times: number[], limit: number, now: number): number | null {
  if (limit <= 0) return null;
  const live = times.filter((t) => t >= now - NO_SHOW_WINDOW_MS).sort((a, b) => a - b);
  if (live.length < limit) return null;
  // the permits open again once fewer than `limit` no-shows are left in the window
  return live[live.length - limit] + NO_SHOW_WINDOW_MS;
}

function busy(err: unknown): JoinPermitFail {
  if (err instanceof JoinPermitFail) return err;
  const chainBusy = err instanceof ChainBusyError || (err as { code?: string })?.code === 'chain_busy';
  return new JoinPermitFail(503, 'chain_busy', chainBusy ? 'The network is busy. Try again in a few seconds.' : 'The ticket permit could not be prepared. Try again in a few seconds.');
}
