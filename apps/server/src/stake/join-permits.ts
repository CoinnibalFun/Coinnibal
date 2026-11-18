import { JOIN_PERMIT_MAX_WINDOW_S, type JoinPermit, type JoinPermitError } from '@coinnibal/shared';
import { getAddress } from 'viem';
import { ChainBusyError, type ChainGateway } from '../chain/types';
import { subnetOf } from '../net/gateway';
import { Limiter } from '../net/limiter';

/**
 * Join permits (CoinnibalArena v4; 2026-11 audit S16). `join` needs a short-lived EIP-712 permit signed by the server
 * key, so the server decides who may buy a ticket. Before the permit, anyone could fill an arena's `maxSessions` with
 * tickets nobody played, get every entry fee back from the stale sweeper 15 minutes later, and do it again.
 *
 * A permit is issued only to a signed-in wallet, and only when:
 *  - the game is open for that wallet (`GAME_ACCESS` / the admin's setting) and it is not banned;
 *  - paid rooms are on, the arena exists and is enabled on chain, the contract is not paused, and the server does not
 *    keep the arena closed (books guard, re-price);
 *  - the wallet has no open ticket there (a ticket is resumed, never bought twice);
 *  - the wallet is not a repeated no-show: `noShowLimit` tickets cancelled unseated (while their arena was open) in
 *    24 h close the permits until the oldest of them is a day old;
 *  - the arena's live permits plus its unseated tickets stay under its cap (the seats a round can take, or
 *    `JOIN_PERMIT_ARENA_CAP`);
 *  - the caller's IP (and IPv6 /64) and wallet are under their request limits.
 * One live permit per wallet and arena: asking again returns the same permit while it is valid and unused.
 */

export interface JoinPermitConfig {
  /** Seconds a permit stays valid (the contract refuses more than `JOIN_PERMIT_MAX_WINDOW_S`). */
  ttlS: number;
  /** Permit requests per IP per 10 minutes. */
  perIp: number;
  /** Permit requests per IPv6 /64 per 10 minutes. */
  perSubnet: number;
  /** Permit requests per wallet per 10 minutes. */
  perWallet: number;
  /** Live permits plus unseated tickets an arena may have at once; 0: the seats a round can take there. */
  arenaCap: number;
  /** Tickets cancelled unseated in 24 h after which a wallet gets no permit (until the oldest is a day old); 0: off. */
  noShowLimit: number;
}

export const JOIN_PERMIT_DEFAULTS: JoinPermitConfig = { ttlS: 600, perIp: 12, perSubnet: 30, perWallet: 20, arenaCap: 0, noShowLimit: 3 };

/** The window of the request limits. */
const LIMIT_WINDOW_MS = 10 * 60_000;
/** The window no-shows are counted in. */
export const NO_SHOW_WINDOW_MS = 24 * 3600_000;
/** A kept permit is handed out again only while it has at least this long left (the wallet needs time to sign). */
const REUSE_MIN_LEFT_S = 120;
/** Permits remembered at most (expired ones go first). */
const MAX_KEPT = 50_000;

export interface JoinPermitDeps {
  chain: ChainGateway;
  /** Whether the game is open for `wallet` (`SiteApi.gameOpenFor`). */
  gameOpenFor: (wallet: string) => Promise<boolean>;
  /** The integrity ban list (banned wallets are never seated, so they get no ticket either). */
  isBanned?: (wallet: string) => boolean;
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

const playerOf = (key: string): { arenaId: number; player: string } | null => {
  const m = /^(\d{1,5}):(0x[0-9a-f]{40}):/i.exec(key);
  return m ? { arenaId: Number(m[1]), player: m[2].toLowerCase() } : null;
};

export class JoinPermits {
  private readonly cfg: JoinPermitConfig;
  private readonly now: () => number;
  private readonly ipLimit: Limiter;
  private readonly netLimit: Limiter;
  private readonly walletLimit: Limiter;
  /** The live permit of each `<arenaId>:<wallet lower>`. */
  private readonly kept = new Map<string, JoinPermit>();

  constructor(private readonly d: JoinPermitDeps) {
    this.cfg = { ...JOIN_PERMIT_DEFAULTS, ...d.cfg };
    this.cfg.ttlS = Math.max(60, Math.min(JOIN_PERMIT_MAX_WINDOW_S, Math.floor(this.cfg.ttlS)));
    this.now = d.now ?? Date.now;
    this.ipLimit = new Limiter(this.cfg.perIp, LIMIT_WINDOW_MS);
    this.netLimit = new Limiter(this.cfg.perSubnet, LIMIT_WINDOW_MS);
    this.walletLimit = new Limiter(this.cfg.perWallet, LIMIT_WINDOW_MS);
  }

  /** The settings in use (admins and tests). */
  get config(): Readonly<JoinPermitConfig> {
    return this.cfg;
  }

  /** When `wallet`'s permits open again after its no-shows (Unix ms); null when it may get one. */
  noShowUntil(wallet: string): number | null {
    const limit = this.cfg.noShowLimit;
    if (limit <= 0) return null;
    const now = this.now();
    const times = this.d.noShows(wallet, now - NO_SHOW_WINDOW_MS).sort((a, b) => a - b);
    if (times.length < limit) return null;
    // the permits open again once fewer than `limit` no-shows are left in the window
    return times[times.length - limit] + NO_SHOW_WINDOW_MS;
  }

  /** Live permits plus unseated tickets of an arena, and its cap. */
  async load(arenaId: number, openSessions: number, except: string | null = null): Promise<{ used: number; cap: number }> {
    const now = this.now();
    const nowS = Math.floor(now / 1000);
    const seated = this.d.seatedKeys();
    const seatedHere = new Set<string>();
    for (const k of seated) {
      const p = playerOf(k);
      if (p && p.arenaId === arenaId) seatedHere.add(p.player);
    }
    let pending = 0;
    for (const k of this.d.pendingKeys()) {
      const p = playerOf(k);
      if (p && p.arenaId === arenaId && !seatedHere.has(p.player)) pending++;
    }
    const unseated = Math.max(0, openSessions - seatedHere.size - pending);
    let live = 0;
    for (const [key, p] of this.kept) {
      if (p.arenaId !== arenaId || p.deadline < nowS || key === except) continue;
      // a permit whose ticket is seated is done
      if (!seatedHere.has(p.player.toLowerCase())) live++;
    }
    const cap = this.cfg.arenaCap > 0 ? this.cfg.arenaCap : Math.max(1, this.d.seatsPerRound(arenaId));
    return { used: live + unseated, cap };
  }

  private prune(): void {
    const nowS = Math.floor(this.now() / 1000);
    for (const [k, p] of this.kept) if (p.deadline < nowS) this.kept.delete(k);
    while (this.kept.size >= MAX_KEPT) this.kept.delete(this.kept.keys().next().value!);
  }

  /** A permit for `wallet` (signed in) to buy one ticket of `arenaId`; throws `JoinPermitFail`. */
  async issue(walletIn: string, arenaId: number, ip: string): Promise<JoinPermit> {
    if (!Number.isInteger(arenaId) || arenaId < 1 || arenaId > 65_535) throw new JoinPermitFail(400, 'bad_request', 'arenaId must be an arena number.');
    const wallet = getAddress(walletIn);
    const now = this.now();
    const net = ipv6Net(ip);
    // every request counts (a kept permit handed out again too): each one may read the chain
    const ipOk = this.ipLimit.allow(ip, now);
    const netOk = net === null || this.netLimit.allow(net, now);
    const walletOk = this.walletLimit.allow(wallet.toLowerCase(), now);
    if (!ipOk || !netOk || !walletOk) throw new JoinPermitFail(429, 'rate_limited', 'Too many ticket requests. Wait a few minutes, then try again.');
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
    const arena = arenas.find((a) => a.id === arenaId);
    if (!arena || !arena.enabled) throw new JoinPermitFail(409, 'arena_closed', 'This room is not open.');
    const until = this.noShowUntil(wallet);
    if (until !== null) {
      throw new JoinPermitFail(
        403,
        'no_show',
        `Your last ${this.cfg.noShowLimit} tickets were never played and went back unplayed within a day, so new tickets pause for a while.`,
        until,
      );
    }
    try {
      const open = chain.hasOpenTicket ? await chain.hasOpenTicket(arenaId, wallet) : (await chain.getSession(arenaId, wallet)) !== null;
      if (open) {
        this.kept.delete(`${arenaId}:${wallet.toLowerCase()}`);
        throw new JoinPermitFail(409, 'session_open', 'You already hold a ticket for this room: resume it, no new ticket needed.');
      }
    } catch (err) {
      if (err instanceof JoinPermitFail) throw err;
      throw busy(err);
    }
    const key = `${arenaId}:${wallet.toLowerCase()}`;
    let nonce: bigint;
    try {
      nonce = await chain.joinNonce(wallet);
    } catch (err) {
      throw busy(err);
    }
    const nowS = Math.floor(now / 1000);
    const kept = this.kept.get(key);
    // one live permit per wallet and arena: the same one again while it is valid and unused
    if (kept && kept.nonce === nonce.toString() && kept.deadline - nowS >= REUSE_MIN_LEFT_S) return kept;
    const { used, cap } = await this.load(arenaId, arena.openSessions, key);
    if (used >= cap) {
      this.d.log?.(`permits: arena #${arenaId} at its cap (${used}/${cap} live permits + unseated tickets) — refused ${wallet}`);
      throw new JoinPermitFail(409, 'arena_busy', 'This room has as many tickets waiting for a seat as a round can take. Try again in a minute.');
    }
    const deadline = nowS + this.cfg.ttlS;
    let permit: JoinPermit;
    try {
      permit = await chain.signJoinPermit(wallet, arenaId, nonce, deadline);
    } catch (err) {
      throw busy(err);
    }
    this.prune();
    this.kept.set(key, permit);
    return permit;
  }
}

function busy(err: unknown): JoinPermitFail {
  if (err instanceof JoinPermitFail) return err;
  const chainBusy = err instanceof ChainBusyError || (err as { code?: string })?.code === 'chain_busy';
  return new JoinPermitFail(503, 'chain_busy', chainBusy ? 'The network is busy. Try again in a few seconds.' : 'The ticket permit could not be prepared. Try again in a few seconds.');
}
