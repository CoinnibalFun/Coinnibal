import { JOIN_PERMIT_MAX_WINDOW_S, type JoinPermit, type JoinPermitError } from '@coinnibal/shared';
import { getAddress } from 'viem';
import { ChainBusyError, type ChainArena, type ChainGateway } from '../chain/types';
import { CLIENT_BUSY_MESSAGE, ClientBudgetError } from '../net/client-scope';
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
 *  - the wallet is not a repeated no-show: `noShowLimit` of its tickets cancelled unseated (while their arena was
 *    open) in 24 h close its permits until the oldest of them is a day old;
 *  - the arena's unseated tickets plus the places other new permits hold there stay under its cap (the seats a round
 *    can take, or `JOIN_PERMIT_ARENA_CAP`);
 *  - the wallet is under its request limit.
 *
 * A wallet with standing (audit R3-M1) meets only those. Standing: its latest ticket of the last 14 days was played
 * (a `settle` in the settled log, never a `cancel`) and none of its tickets was a no-show since, or it holds a Coinnibal
 * NFT that gives no other wallet standing (one wallet per token id a day: an NFT passed from wallet to wallet gives one
 * of them standing); either way with no no-show of its own in 24 h, and for one unplayed ticket at a time (audit
 * R4-M2: a ticket of another arena bought with standing and not played yet makes this one follow the rules below, and a
 * refusal then says `ticket_elsewhere`; a permit not used yet never counts, since one join nonce buys one ticket in
 * all). It loses standing at its first no-show. So a player behind a carrier NAT, a VPN or a mobile /48 is never refused
 * for what other wallets of that network did.
 *
 * A wallet without standing (a new one) also meets the network rules, which follow the network it asks from: an IPv4
 * address or an IPv6 /64 (`net`), and its IPv4 /24 or IPv6 /48 (`site`; audit R3-M2: one cheap block of addresses is one
 * site):
 *  - the network is not a repeated no-show: 3× `noShowLimit` tickets bought with permits asked from one `net`, or 8×
 *    from one `site`, cancelled unseated in 24 h close the permits asked from there until the oldest is a day old;
 *  - the network has fewer than its share of the arena's outstanding permits: issued there and not played yet (valid
 *    and unused, or used for a ticket that is not seated, not settled and not cancelled), at most `openPerIp` per IPv4
 *    address (8: carrier NAT puts many players behind one), `openPerNet` per IPv6 /64 (4) and `openPerSite` per IPv4
 *    /24 or IPv6 /48 (16). Refused: `network_busy`. A permit that bought nothing leaves the share when it runs out (at
 *    the latest once its 10 minutes are over), so whatever its wallets did, a network is never held longer than its
 *    own valid permits and unplayed tickets last (audit R4b-M1: unused permits of other wallets, an attacker's or a
 *    hesitant player's, must never close a carrier NAT or a /24 for a day);
 *  - the wallet let fewer than `unusedLimit` (3) permits of this arena run out unused in 24 h, counted since its last
 *    ticket (its join nonce moved: a ticket bought or played starts the count afresh). Refused: `unused_permits`, until
 *    the oldest of them is a day old. So free permits cycled to hold a share cost a funded wallet per `unusedLimit`
 *    permits a day (per identity, never per network), while a player who asks, leaves and comes back later is served;
 *  - wallets without standing together hold fewer than `freshShare` of min(cap, `maxSessions`) of the arena's
 *    outstanding permits (half by default). Refused: `arena_busy`. However many networks they come from, new wallets
 *    can never fill the arena: the rest stays open to players with standing;
 *  - the wallet holds the entry fee (`no_funds`: its permit could buy nothing, and a free one must not hold a share);
 *  - the caller's IP (and IPv6 /64, IPv4 /24, IPv6 /48) are under their request limits.
 * One live permit per wallet and arena: asking again returns the same permit while it is valid, unused and signed for
 * the arena contract in use (a new contract, registered live, starts every permit, place and share afresh).
 *
 * A ticket for a paid custom room (audit R4-M1): the request names the room, which must be an instance of that arena
 * taking seats now (else `arena_closed`), and the permit is bound to it unless the wallet opened that room. If the room
 * stops taking seats before the ticket is seated, the gateway refunds the ticket at once; that refund is not a no-show
 * only when it comes from the room the ticket was bound to, within `ROOM_EXCUSE_S` of the ticket's opening, and within
 * the room's budget of excuses (its seats). Any other early refund is a no-show like the stale sweeper's.
 *
 * A permit is free, so it holds a place in the cap only briefly and only when backed: a new permit holds one for
 * `holdS` (120 s: the approval and the join) when the wallet holds the entry fee, no earlier permit of that wallet,
 * arena and join nonce held one, and the network it was asked from holds fewer than `holdsPerNet` places (an IPv4
 * address or an IPv6 /64) and `holdsPerSite` (an IPv6 /48). Any other permit is still issued; it holds nothing. A
 * place is given up as soon as the permit is used or cannot be: the wallet asks to sit with its ticket, the ticket is
 * read, seated or settled, or the wallet's join nonce moved (one nonce serves every arena; read at the wallet's next
 * request, and for every held place once the arena reaches its cap).
 *
 * A permit leaves its networks' share (and the new wallets') only when it is played or cannot be any more: its ticket
 * is seated or settled (a no-show included), or, read once that share is full (once per permit after it expired), the
 * wallet's join nonce never moved (it ran out unused: one more of its wallet's unused permits) or the wallet holds no
 * ticket there. The wallet asking again once its permit ran out frees that one too (and counts it unused). Asking to
 * sit, or asking again while the permit is valid, frees nothing.
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
  /** The same per IPv4 /24 or IPv6 /48. 0: no limit. */
  openPerSite: number;
  /**
   * The share of an arena's places (min(cap, `maxSessions`)) the outstanding permits of wallets without standing may
   * hold together; at it, such a wallet gets no new permit there (`arena_busy`). 0: no limit.
   */
  freshShare: number;
  /**
   * Permits of one arena that a wallet without standing let run out unused (its join nonce unmoved) in 24 h, since its
   * last ticket, after which it gets no new permit there (`unused_permits`) until the oldest is a day old. 0: off.
   */
  unusedLimit: number;
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
  // half: a launch of new players still fills an arena within the first minutes of a round (a permit is played, seated,
  // within about a minute, and leaves the share then), while locking players with standing out takes the other half
  freshShare: 0.5,
  // like NO_SHOW_LIMIT: a player who asks, declines or leaves, and comes back later is served twice more; a ticket bought
  // starts afresh. Cycling free permits to hold a share then takes a new funded wallet every 3 permits (30 minutes)
  unusedLimit: 3,
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
/** No-shows per IPv4 address or IPv6 /64, and per IPv4 /24 or IPv6 /48, as multiples of `noShowLimit`. */
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
/** A played ticket gives its wallet standing this long (the settled log's 14 days). */
export const PLAYED_WINDOW_MS = 14 * 24 * 3600_000;
/** A token id gives standing to one wallet: another wallet may use it this long after that one last did. */
export const CLAIM_MS = 24 * 3600_000;
/** A wallet's unused permits remembered at most per arena (enough for any `unusedLimit` worth setting). */
const MAX_UNUSED = 32;
const MAX_CLAIMS = 50_000;
/**
 * A ticket bound to a paid room that stops taking seats goes back without a no-show only this long after it opened (the
 * moments between a purchase and its seat; held unseated longer, it was the player's choice).
 */
export const ROOM_EXCUSE_S = 120;
/** A permit request's room code. */
const ROOM_CODE_RE = /^[A-Za-z0-9]{1,16}$/;
/**
 * A network at its share: its permits free their places as they are played or run out (10 minutes), its tickets as
 * they are seated or go back unplayed (the stale sweeper: 15 minutes and its sweep), so within half an hour at most.
 */
const NETWORK_BUSY_MESSAGE =
  'Enough tickets for this room were asked from your network and are not played yet. Places free up as they are played or run out, within half an hour: try again soon, or from another connection.';
/** The new wallets' key in `inflight` (`<arenaId>|new`; never a network key). */
const FRESH = 'new';

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
  /** Unix ms of `wallet`'s latest played ticket (a `settle` of the settled log), or null. Absent: none has played. */
  playedAt?: (wallet: string) => number | null;
  /**
   * The Coinnibal NFT token ids `wallet` holds (the holder index; no chain read), or null when unknown. Absent or null:
   * no wallet has standing as a holder.
   */
  holderTokens?: (wallet: string) => Promise<readonly string[] | null>;
  /**
   * The paid custom room `code` of `arenaId` when it takes new seats now: its seats and its creator; null otherwise.
   * Absent: a permit is never bound to a room (its early refund is a no-show).
   */
  paidRoom?: (arenaId: number, code: string) => { seats: number; creator: string } | null;
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

/** The network an IPv6 address is limited by (/64); null for IPv4 (an address is its own `net`). */
export function ipv6Net(ip: string): string | null {
  const net = subnetOf(ip);
  return net.endsWith('::/64') ? net : null;
}

/**
 * Who asked for a permit, by the keys its place and no-show limits use: `net` an IPv4 address or an IPv6 /64 (one
 * provider customer usually gets a whole /64), `site` the IPv4 /24 or the IPv6 /48 around it (a block of addresses one
 * provider or customer hands out: a cheap VPS range, a proxy pool, a larger customer's /48). Null only for an address
 * that is neither.
 */
export interface Requester {
  net: string;
  site: string | null;
}

export function requesterOf(ip: string): Requester {
  const v4 = /^(?:::ffff:)?((\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3})$/i.exec(ip);
  if (v4) return { net: v4[1], site: `${v4[2]}.${v4[3]}.${v4[4]}.0/24` };
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

/** The paid custom room a permit was asked for (audit R4-M1). */
interface RoomBinding {
  code: string;
  /** Its seats: how many early refunds it may excuse. */
  seats: number;
}

/** The permits of one wallet and arena, for its latest join nonce. */
interface Issued {
  nonce: string;
  /** A permit of this nonce held a place already: the next one of the same nonce holds none. */
  held: boolean;
  /** Server clock (Unix ms) of the latest permit. */
  at: number;
  /** The chain's clock (Unix s) of the latest permit (compared with a ticket's block time). */
  issuedS: number;
  /** The paid custom room the latest permit was asked for, bound to it (null: none, or its creator's own). */
  room: RoomBinding | null;
  /** Who asked for the permits of this nonce (a no-show of the ticket bought with one counts against each). */
  by: Requester[];
  /** The deadline of the latest permit (Unix s, the chain's clock). */
  deadlineS: number;
  /** It counts against the share of every network in `by`: not played, settled or found unused yet. */
  open: boolean;
  /**
   * Server clock (Unix ms) of the issue of each earlier permit of this nonce that ran out unused, issued to the wallet
   * without standing (`unusedLimit`; a day). A new nonce (a ticket bought) starts afresh.
   */
  unused: number[];
  /**
   * Issued to a wallet with standing: it counts in no network's share and not in the new wallets' share, and it is
   * that wallet's one unplayed ticket with standing.
   */
  exempt: boolean;
  /**
   * Server clock (Unix ms) of the last read of its ticket at a share (0: never; Infinity: its ticket was found, bought
   * and not seated, and it is never read again). An exempt record: Infinity once its ticket was found (`exemptElsewhere`).
   */
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
  /**
   * Permits being prepared now, by `<arenaId>|<requester key>` (and `<arenaId>|new` for wallets without standing): they
   * count in the share (a burst passes it together).
   */
  private readonly inflight = new Map<string, number>();
  /** The open records of wallets without standing, by arena: the new wallets' share of its outstanding permits. */
  private readonly freshOpen = new Map<number, Set<string>>();
  /** The wallet (lower case) each NFT token id gives standing to, and when it last did (Unix ms). */
  private readonly claims = new Map<string, { wallet: string; at: number }>();
  /** Early refunds each paid room code excused (`roomExcuse`), since the first (Unix ms; kept a day). */
  private readonly roomExcuses = new Map<string, { n: number; since: number }>();
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
   * `wallet`'s standing: `played` (its latest ticket of the last 14 days was played, and none was a no-show since),
   * `holder` (it holds an NFT that gives no other wallet standing), or null; never with a no-show of its own in 24 h.
   * Memory only (the settled log, the holder index): asked before the request limits.
   */
  async standing(walletIn: string): Promise<'played' | 'holder' | null> {
    const wallet = getAddress(walletIn);
    const now = this.now();
    const own = this.d.noShows(wallet, now - PLAYED_WINDOW_MS);
    const lastNoShow = own.reduce((a, b) => Math.max(a, b), -Infinity);
    if (lastNoShow >= now - NO_SHOW_WINDOW_MS) return null;
    const played = this.d.playedAt?.(wallet) ?? null;
    if (played !== null && played >= now - PLAYED_WINDOW_MS && played > lastNoShow) return 'played';
    if (!this.d.holderTokens) return null;
    const tokens = await this.d.holderTokens(wallet).catch(() => null);
    return tokens && tokens.length > 0 && this.claim(wallet.toLowerCase(), tokens, now) ? 'holder' : null;
  }

  /**
   * One of `tokens` gives `wallet` standing: one it used before, else one no other wallet used in the last day (an NFT
   * passed from wallet to wallet gives standing to one of them a day).
   */
  private claim(wallet: string, tokens: readonly string[], now: number): boolean {
    let pick = tokens.find((t) => this.claims.get(t)?.wallet === wallet);
    pick ??= tokens.find((t) => {
      const c = this.claims.get(t);
      return !c || c.at < now - CLAIM_MS;
    });
    if (pick === undefined) return false;
    this.claims.delete(pick);
    this.claims.set(pick, { wallet, at: now });
    while (this.claims.size > MAX_CLAIMS) this.claims.delete(this.claims.keys().next().value!);
    return true;
  }

  /**
   * Another arena holds `wallet`'s unplayed ticket bought with standing: standing covers one at a time, so a wallet that
   * played once cannot hold every arena's tickets past the network rules (audit R4-M2: only a ticket really bought):
   *  - a permit of the wallet's current join nonce bought nothing yet, and with this one the two can buy one ticket
   *    between them (the first join uses the nonce up): it never counts (expired, it leaves);
   *  - a permit of an earlier nonce bought a ticket, there or in another arena: read once whether that arena holds a
   *    ticket of the wallet; none and it leaves, one and it counts until that ticket is seated or settled;
   *  - a seated ticket is played: it leaves.
   * Throws when the chain cannot be read (the caller answers busy).
   */
  private async exemptElsewhere(wallet: string, arenaId: number, nonce: bigint, nowS: number): Promise<boolean> {
    const chain = this.d.chain;
    for (const id of [...this.arenaIds]) {
      if (id === arenaId) continue;
      const key = `${id}:${wallet}`;
      const rec = this.issued.get(key);
      if (!rec || !rec.open || !rec.exempt) continue;
      if (this.seatedIn(id).has(wallet)) {
        this.close(key);
        continue;
      }
      if (BigInt(rec.nonce) >= nonce) {
        if (rec.deadlineS < nowS) this.close(key);
        continue;
      }
      if (rec.checkedAt !== Infinity) {
        const player = getAddress(wallet);
        const open = chain.hasOpenTicket ? await chain.hasOpenTicket(id, player) : (await chain.getSession(id, player)) !== null;
        if (this.issued.get(key) !== rec || !rec.open) continue;
        if (!open) {
          this.close(key);
          continue;
        }
        rec.checkedAt = Infinity;
      }
      return true;
    }
    return false;
  }

  /**
   * `wallet`'s unseated ticket of `arenaId` (opened at `openedAtS`, the block time) goes back early because the paid
   * room `code` stopped taking seats: whether the server owes it the excuse, so the refund is no no-show (audit R4-M1).
   * Only when the permit that bought it was asked for that room while the room took seats (and not by the room's
   * creator: `issue`), the ticket opened at most `ROOM_EXCUSE_S` ago, and the room excused fewer early refunds than it
   * has seats. Counts the excuse (one per binding).
   */
  roomExcuse(walletIn: string, arenaId: number, code: string, openedAtS: number): boolean {
    const rec = this.issued.get(`${arenaId}:${walletIn.toLowerCase()}`);
    const room = rec?.room;
    if (!rec || !room || room.code !== code || rec.issuedS > openedAtS + TICKET_CLOCK_SLACK_S) return false;
    if (this.chainNowS() - openedAtS > ROOM_EXCUSE_S) return false;
    const now = this.now();
    const was = this.roomExcuses.get(code);
    const live = was && was.since >= now - NO_SHOW_WINDOW_MS ? was : null;
    if ((live?.n ?? 0) >= room.seats) return false;
    if (live) live.n++;
    else {
      // oldest first (by the first excuse): the prune stops at the first one still in its day
      this.roomExcuses.delete(code);
      this.roomExcuses.set(code, { n: 1, since: now });
      while (this.roomExcuses.size > MAX_NET_KEYS) this.roomExcuses.delete(this.roomExcuses.keys().next().value!);
    }
    rec.room = null;
    return true;
  }

  /**
   * The no-show block of the networks `ip` is in, for a wallet without standing (or one whose standing covers another
   * ticket: `rule` says so instead); throws `no_show`.
   */
  private netNoShowCheck(ip: string, by: Requester, wallet: string, rule: (f: JoinPermitFail) => JoinPermitFail = (f) => f): void {
    const until = this.netNoShowUntil(ip);
    if (until === null) return;
    this.d.log?.(`permits: ${by.net}${by.site ? ` (${by.site})` : ''} has too many no-shows today — refused ${wallet}`);
    throw rule(new JoinPermitFail(403, 'no_show', 'Too many tickets bought from your network went back unplayed today, so new tickets pause for a while.', until));
  }

  /**
   * The permit of `key` (`rec`) ran out unused (its deadline passed, the wallet's join nonce never moved): it leaves
   * every share now, and counts against its wallet's unused permits there (a wallet without standing). Never against a
   * network: other wallets' unused permits must not close a shared network (audit R4b-M1).
   */
  private ranOut(key: string, rec: Issued): void {
    if (!rec.exempt) rec.unused = [...rec.unused, rec.at].slice(-MAX_UNUSED);
    this.close(key);
  }

  /**
   * When the wallet of `key` may get a new permit there again after its unused permits of join nonce `nonce` (Unix ms);
   * null when it may now. A moved nonce (a ticket bought) counts none.
   */
  private unusedUntil(key: string, nonce: string, now: number): number | null {
    const rec = this.issued.get(key);
    return rec && rec.nonce === nonce ? untilBelow(rec.unused, this.cfg.unusedLimit, now) : null;
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
    return { used: unseated + held, cap: this.capOf(arenaId), unseated, held };
  }

  /** An arena's cap of unseated tickets plus held places: `JOIN_PERMIT_ARENA_CAP`, else the seats a round can take. */
  private capOf(arenaId: number): number {
    return this.cfg.arenaCap > 0 ? this.cfg.arenaCap : Math.max(1, this.d.seatsPerRound(arenaId));
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
    // the join nonce that bought it: this arena's latest permit, when it was issued before the ticket opened
    const mine = this.issued.get(key);
    const used = mine && mine.issuedS <= openedAtS + TICKET_CLOCK_SLACK_S ? mine.nonce : null;
    for (const id of this.arenaIds) {
      if (id === arenaId) continue;
      const other = `${id}:${wallet}`;
      const k = this.kept.get(other);
      const rec = this.issued.get(other);
      // a permit signed before then, still kept, or recorded with the nonce that bought this ticket (audit R4-M2: the
      // kept permit may be gone, pruned or dropped at a later request): it can buy nothing any more
      const spent = (k && k.issuedS <= openedAtS + TICKET_CLOCK_SLACK_S) || (used !== null && rec?.nonce === used && rec.issuedS <= openedAtS + TICKET_CLOCK_SLACK_S);
      if (spent) {
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
    for (const [code, e] of this.roomExcuses) {
      if (e.since >= now - NO_SHOW_WINDOW_MS) break;
      this.roomExcuses.delete(code);
    }
  }

  /**
   * Remembers who asked for a permit of `nonce` (a no-show of its ticket counts against them). A permit issued, or
   * handed out again, is outstanding: it counts against the share of every network that asked for it, and (`exempt`
   * false: a wallet without standing) in the new wallets' share. An earlier permit of the same nonce that expired
   * bought nothing (the nonce would have moved): it ran out unused, and the wallet's unused permits of that nonce carry
   * over.
   */
  private record(key: string, permit: JoinPermit, by: Requester, held: boolean, exempt: boolean, room: RoomBinding | null): void {
    const nonce = permit.nonce;
    const was = this.issued.get(key);
    const same = !!was && was.nonce === nonce;
    if (was && same && was.open && was.deadlineS < this.chainNowS()) this.ranOut(key, was);
    if (was) this.close(key);
    const list = same ? was.by.filter((b) => b.net !== by.net) : [];
    list.push(by);
    this.issued.delete(key);
    const rec: Issued = {
      nonce,
      held: (same && was.held) || held,
      at: this.now(),
      issuedS: this.chainNowS(),
      room,
      by: list.slice(-MAX_REQUESTERS),
      deadlineS: permit.deadline,
      open: true,
      unused: same ? was.unused : [],
      exempt,
      checkedAt: 0,
    };
    this.issued.set(key, rec);
    this.index(key, rec, true);
  }

  /**
   * Adds `key` to (or removes it from) the outstanding permits of every network of `rec` and the new wallets' share of
   * its arena (a permit issued with standing is in neither).
   */
  private index(key: string, rec: Issued, add: boolean): void {
    if (rec.exempt) return;
    const arenaId = key.slice(0, key.indexOf(':'));
    const fresh = this.freshOpen.get(Number(arenaId));
    if (add) {
      if (fresh) fresh.add(key);
      else this.freshOpen.set(Number(arenaId), new Set([key]));
    } else if (fresh) {
      fresh.delete(key);
      if (fresh.size === 0) this.freshOpen.delete(Number(arenaId));
    }
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

  /**
   * The share of an arena's outstanding permits each network of `by` may have (an IPv4 address or an IPv6 /64, and its
   * IPv4 /24 or IPv6 /48).
   */
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

  /** How many of an arena's outstanding permits the new wallets' share holds at most (Infinity: no limit). */
  private freshCap(arena: ChainArena): number {
    const f = this.cfg.freshShare;
    if (!(f > 0)) return Infinity;
    const places = Math.min(this.capOf(arena.id), arena.maxSessions > 0 ? arena.maxSessions : Infinity);
    return Math.max(1, Math.ceil(Math.min(1, f) * places));
  }

  /** The outstanding permits of wallets without standing in `arenaId`, other than `except`'s (a seated one leaves). */
  private freshOutstanding(arenaId: number, except: string): number {
    let n = this.inflight.get(`${arenaId}|${FRESH}`) ?? 0;
    const set = this.freshOpen.get(arenaId);
    if (!set) return n;
    const seated = this.seatedIn(arenaId);
    for (const key of [...set]) {
      if (key === except) continue;
      if (seated.has(walletOf(key))) this.close(key);
      else n++;
    }
    return n;
  }

  /** At a network's share: `recheckOpen` of its outstanding permits in `arenaId`. */
  private recheckShare(arenaId: number, net: string, except: string): Promise<number> {
    const at = `${arenaId}|${net}`;
    return this.recheckOpen(arenaId, at, this.openBy.get(at) ?? [], except);
  }

  /**
   * At a share (`at`: a network's, or the new wallets' of the arena): reads each of `keys`' outstanding permits that
   * has expired and was not read in the last 10 s. The wallet's join nonce first: unmoved, the permit bought nothing
   * (it ran out unused: it leaves every share, and counts against its wallet's unused permits). Moved: its ticket there;
   * none (settled, or the nonce bought a ticket elsewhere) and it leaves; one (bought, not seated) and it stays until
   * seated or settled, never read again. So each permit is read once after it expires, however full the shares stay. A
   * permit still valid counts unread: unused, or its ticket bought a moment ago (the contract checks the deadline at
   * the join, so an expired permit buys nothing more). Returns how many left.
   */
  private recheckOpen(arenaId: number, at: string, keys: Iterable<string>, except: string): Promise<number> {
    const running = this.sharesChecking.get(at);
    if (running) return running;
    const chain = this.d.chain;
    const now = this.now();
    const nowS = this.chainNowS();
    const todo: [string, Issued][] = [];
    for (const key of keys) {
      const rec = this.issued.get(key);
      if (key === except || !rec || !rec.open || rec.deadlineS >= nowS || now - rec.checkedAt < RECHECK_MS) continue;
      rec.checkedAt = now;
      todo.push([key, rec]);
    }
    if (todo.length === 0) return Promise.resolve(0);
    const hasTicket = async (wallet: string) => (chain.hasOpenTicket ? chain.hasOpenTicket(arenaId, wallet) : (await chain.getSession(arenaId, wallet)) !== null);
    const run = Promise.all(
      todo.map(async ([key, rec]) => {
        try {
          const wallet = getAddress(walletOf(key));
          const nonce = chain.joinNonce ? await chain.joinNonce(wallet) : null;
          if (this.issued.get(key) !== rec || !rec.open) return 0;
          if (nonce !== null && nonce <= BigInt(rec.nonce)) {
            this.ranOut(key, rec);
            return 1;
          }
          if (await hasTicket(wallet)) {
            // its ticket, bought and not seated yet: it stays until seated or settled, and is never read again
            rec.checkedAt = Infinity;
            return 0;
          }
          if (this.issued.get(key) !== rec) return 0;
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
      this.freshOpen.clear();
      this.arenaIds.clear();
      this.roomExcuses.clear();
    }
    this.contract = c;
  }

  /**
   * A permit for `wallet` (signed in) to buy one ticket of `arenaId`, for the paid custom room `room` when given;
   * throws `JoinPermitFail`.
   */
  async issue(walletIn: string, arenaId: number, ip: string, room: string | null = null): Promise<JoinPermit> {
    if (!Number.isInteger(arenaId) || arenaId < 1 || arenaId > 65_535) throw new JoinPermitFail(400, 'bad_request', 'arenaId must be an arena number.');
    if (room !== null && (typeof room !== 'string' || !ROOM_CODE_RE.test(room))) throw new JoinPermitFail(400, 'bad_request', 'room must be a room code.');
    const wallet = getAddress(walletIn);
    const lower = wallet.toLowerCase();
    const now = this.now();
    const net = ipv6Net(ip);
    const by = requesterOf(ip);
    // standing first (memory only): a wallet with standing is limited per wallet, never by what its network did
    const standing = await this.standing(wallet);
    // every request counts (a kept permit handed out again too): each one may read the chain
    const walletOk = this.walletLimit.allow(lower, now);
    let netsOk = true;
    if (standing === null) {
      const ipOk = this.ipLimit.allow(ip, now);
      const netOk = net === null || this.netLimit.allow(net, now);
      const siteOk = by.site === null || this.siteLimit.allow(by.site, now);
      netsOk = ipOk && netOk && siteOk;
    }
    if (!netsOk || !walletOk) throw new JoinPermitFail(429, 'rate_limited', 'Too many ticket requests. Wait a few minutes, then try again.');
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
    // a ticket for a paid custom room: the room takes seats now, and the permit is bound to it (its early refund, should
    // the room stop taking seats first, is then excused: `roomExcuse`), unless the wallet opened it (its own doing)
    let binding: RoomBinding | null = null;
    if (room !== null && this.d.paidRoom) {
      const r = this.d.paidRoom(arenaId, room);
      if (!r) throw new JoinPermitFail(409, 'arena_closed', 'This paid room takes no new seat now.');
      if (r.creator.toLowerCase() !== lower) binding = { code: room, seats: Math.max(1, Math.floor(r.seats)) };
    }
    // the contract refuses a non-holder's ticket there: no permit (it could only hold a place). Past this client's
    // holder reads the holder index answers; only while it cannot tell (`ClientBudgetError`, `site/mint.ts`) is it
    // busy: a holder is never told the room is not for them
    if (arena.holdersOnly && this.d.isHolder) {
      const holder = await this.d.isHolder(wallet).catch((err: unknown) => {
        if (err instanceof ClientBudgetError) throw new JoinPermitFail(503, 'chain_busy', CLIENT_BUSY_MESSAGE);
        return false;
      });
      if (!holder) throw new JoinPermitFail(403, 'holders_only', 'This room is for Coinnibal NFT holders. Get the NFT to play here.');
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
    if (standing === null) this.netNoShowCheck(ip, by, wallet);
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
    // the wallet's own permit here ran out unused (its nonce never moved): it bought nothing, and leaves its shares now
    const mine = this.issued.get(key);
    if (mine && mine.open && mine.nonce === nonceStr && mine.deadlineS < nowS) this.ranOut(key, mine);
    // standing covers one unplayed ticket at a time: with another arena's bought and not played yet, this one follows
    // the network rules, and a refusal by them says so (`ticket_elsewhere`), never the network's block
    let elsewhere = false;
    if (standing !== null) {
      try {
        elsewhere = await this.exemptElsewhere(lower, arenaId, nonce, nowS);
      } catch (err) {
        throw busy(err);
      }
    }
    const exempt = standing !== null && !elsewhere;
    const rule = (f: JoinPermitFail): JoinPermitFail =>
      elsewhere ? new JoinPermitFail(409, 'ticket_elsewhere', 'You hold a ticket for another room that is not played yet. Play it first, then buy this one.') : f;
    if (elsewhere) this.netNoShowCheck(ip, by, wallet, rule);
    const kept = this.kept.get(key);
    // one live permit per wallet and arena: the same one again while it is valid, unused and signed for the arena
    // contract in use (it holds no new place, and stays one permit in its networks' share, as it was issued)
    if (kept && kept.permit.nonce === nonceStr && kept.permit.deadline - nowS >= REUSE_MIN_LEFT_S && signedFor(kept.permit, st)) {
      const rec = this.issued.get(key);
      this.record(key, kept.permit, by, false, rec && rec.nonce === nonceStr ? rec.exempt : exempt, binding);
      return kept.permit;
    }
    const reserved: string[] = [];
    if (!exempt) {
      // free permits cycled from one wallet: after `unusedLimit` of them ran out unused, it waits (a ticket bought starts
      // afresh). Per wallet, never per network: what other wallets left unused never refuses this one
      const unusedAt = this.unusedUntil(key, nonceStr, now);
      if (unusedAt !== null) {
        this.d.log?.(`permits: ${wallet} let ${this.cfg.unusedLimit} permits of arena #${arenaId} run out unused today — refused`);
        throw rule(
          new JoinPermitFail(
            403,
            'unused_permits',
            `This wallet asked for ${this.cfg.unusedLimit} tickets for this room today and bought none, so new tickets for this room pause for a while. A ticket bought in another room starts afresh.`,
            unusedAt,
          ),
        );
      }
      // each network it is asked from has a share of the arena's outstanding permits (unused, or a ticket not played
      // yet); at a full one, its expired permits are read again
      if (this.fullShare(arenaId, by, key) !== null) await Promise.all(this.shares(by).map((sh) => this.recheckShare(arenaId, sh.key, key)));
      // and wallets without standing, from wherever, hold at most their share of the arena's places
      const freshMax = this.freshCap(arena);
      const freshAt = `${arenaId}|${FRESH}`;
      if (this.freshOutstanding(arenaId, key) >= freshMax) await this.recheckOpen(arenaId, freshAt, this.freshOpen.get(arenaId) ?? [], key);
      // decided from here to the reservation without an await: requests running meanwhile see each other
      const full = this.fullShare(arenaId, by, key);
      if (full !== null) {
        this.d.log?.(`permits: ${full} has its share of arena #${arenaId}'s outstanding permits — refused ${wallet}`);
        throw rule(new JoinPermitFail(409, 'network_busy', NETWORK_BUSY_MESSAGE));
      }
      const fresh = this.freshOutstanding(arenaId, key);
      if (fresh >= freshMax) {
        this.d.log?.(`permits: new wallets hold their share of arena #${arenaId} (${fresh}/${freshMax} outstanding permits) — refused ${wallet}`);
        throw rule(new JoinPermitFail(409, 'arena_busy', 'Many new players are buying tickets for this room right now. Try again in a minute.'));
      }
      reserved.push(...this.shares(by).map((sh) => `${arenaId}|${sh.key}`), freshAt);
    }
    // counted at once, before anything is awaited
    for (const at of reserved) this.inflight.set(at, (this.inflight.get(at) ?? 0) + 1);
    try {
      return await this.grant(wallet, arena, key, nonce, nowS, by, now, exempt, binding);
    } finally {
      for (const at of reserved) {
        const n = (this.inflight.get(at) ?? 1) - 1;
        if (n > 0) this.inflight.set(at, n);
        else this.inflight.delete(at);
      }
    }
  }

  /** The arena's cap, the entry fee of a wallet without standing, the place the permit holds, the signature. */
  private async grant(
    wallet: string,
    arena: ChainArena,
    key: string,
    nonce: bigint,
    nowS: number,
    by: Requester,
    now: number,
    exempt: boolean,
    binding: RoomBinding | null,
  ): Promise<JoinPermit> {
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
    // a wallet without standing holds the entry fee: its permit could buy nothing now, and a free one must not hold a
    // share (a read that fails is busy, never "no tokens")
    let funded: boolean | null = null;
    if (!exempt && chain.tokenBalance) {
      try {
        funded = (await chain.tokenBalance(wallet)) >= arena.entryFee;
      } catch (err) {
        throw busy(err);
      }
      if (!funded) throw new JoinPermitFail(409, 'no_funds', 'This wallet does not hold the entry fee for this room yet. Get tokens first, then buy the ticket.');
    }
    // a place for the approval and the join: the first of this nonce to hold one, a wallet that can pay, a network
    // under its share of places
    const rec = this.issued.get(key);
    let hold = false;
    if (this.cfg.holdS > 0 && !(rec && rec.nonce === nonceStr && rec.held)) {
      const mine = this.heldBy(by, now);
      const under = mine.net < this.cfg.holdsPerNet && (by.site === null || mine.site < this.cfg.holdsPerSite);
      hold = under && (funded ?? (await this.funded(wallet, arena.entryFee)));
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
    this.record(key, permit, by, hold, exempt, binding);
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
