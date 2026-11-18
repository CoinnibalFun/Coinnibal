import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ledgerDecimals } from '@coinnibal/sdk';
import { BRAND_NAME, EATEN_SHOWN, siteHostOf, PlayerFlag, SHARE_BOARD_ROWS, SHARE_ID_RE, isXHandle, SHARE_IMAGE, arenaMeta, formatToken, shareName, shortAddress, type EatenName, type RoundStanding, type ShareBoardRow, type ShareCard, type ShareKind } from '@coinnibal/shared';
import { Limiter } from '../net/limiter';
import type { PlayerLook, RoomHandle } from '../rooms/handle';
import { renderShareCard, renderStandingsCard, shareFacts, shareHeadline } from './share-card';

/**
 * "Share on X" (`packages/shared/src/share.ts`): the cards of results and notable kills, made by the server from its
 * own game records when they happen (a client never sends a card's content), kept in `DATA_DIR/site/shares.json`
 * (the newest `SHARES_KEPT`) and served at `/share/<id>` (a page with the Open Graph / Twitter tags) and
 * `/share/<id>.png` (the image, rendered once and cached), and for a result also `/share/<id>/standings.png` (the room's
 * final standings, my row marked). Limits: a connection gets at most one kill card every
 * `KILL_SHARE_EVERY_MS`; an IP renders at most `RENDERS_PER_MIN` images a minute (crawlers fetch each card once).
 *
 * Every person eaten offers a kill card, so kill cards start as OFFERS: kept in memory only (the newest `OFFERS_KEPT`,
 * for `OFFER_TTL_MS`) and moved into the kept cards the first time their link is opened (X fetches the card as the
 * player writes the post). A kill nobody shares never reaches the disk and never pushes an older card out. A death's
 * card (the game I had: mass, coins eaten) is an offer too. Only the page keeps an offer: its picture is served from
 * the offer as it is (the end-of-game share panel previews and downloads it without storing anything).
 */

export const SHARES_KEPT = 5000;
export const KILL_SHARE_EVERY_MS = 5_000;
/** Kill offers held in memory (not yet opened) and how long one stays valid. */
export const OFFERS_KEPT = 20_000;
export const OFFER_TTL_MS = 6 * 60 * 60_000;
const RENDERS_PER_MIN = 30;
/**
 * Renders a minute for the whole server (each one is ~20-50 ms of the main thread's CPU): a crowd of IPs (or the
 * one IP of a CDN) cannot turn card rendering into a CPU flood. Cached cards are served without a render.
 */
const RENDERS_PER_MIN_ALL = 120;
const PNG_CACHE = 64;
const SAVE_EVERY_MS = 5000;
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface ShareDeps {
  dataDir: string | null;
  /** The site's public origin for the absolute card URLs (`publicBaseUrl`: `PUBLIC_URL`; never a forwarded header). */
  baseUrl: (req: IncomingMessage) => string;
  /** The game token's decimals and symbol (for "took home 1,234.5 $NIBAL"). */
  token: () => { decimals: number; symbol: string } | null;
  /** "Link X": the handle is linked to a wallet right now (a card tags only such a handle; absent: never tag). */
  xLinked?: (handle: string) => boolean;
  now?: () => number;
  log?: (m: string) => void;
}

/** Where a card was made: the room, the player and (signed in) the wallet. */
export interface ShareOrigin {
  room: RoomHandle;
  player: PlayerLook;
  wallet: string | null;
}

export class ShareService {
  private readonly cards = new Map<string, ShareCard>();
  /** Kill cards not opened yet (memory only; see the class note). */
  private readonly offers = new Map<string, ShareCard>();
  private readonly png = new Map<string, Buffer>();
  private readonly renders = new Limiter(RENDERS_PER_MIN, 60_000);
  private readonly rendersAll = new Limiter(RENDERS_PER_MIN_ALL, 60_000);
  /** Drawing failed on this machine (the canvas addon did not load): images fall back to the site's picture. */
  private renderBroken: string | null = null;
  /** Connection or wallet → when it last got a kill card. */
  private readonly lastKill = new Map<string, number>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly d: ShareDeps) {
    this.now = d.now ?? Date.now;
    this.load();
  }

  private file(): string | null {
    return this.d.dataDir ? join(this.d.dataDir, 'site', 'shares.json') : null;
  }

  private load(): void {
    const p = this.file();
    if (!p || !existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as { cards?: ShareCard[] };
      for (const c of Array.isArray(raw.cards) ? raw.cards.slice(-SHARES_KEPT) : []) if (c && typeof c.id === 'string' && SHARE_ID_RE.test(c.id)) this.cards.set(c.id, c);
    } catch (err) {
      const backup = `${p}.corrupt-${Date.now()}`;
      renameSync(p, backup);
      this.d.log?.(`shares: ${p} unreadable (${(err as Error).message}); moved to ${backup}`);
    }
  }

  /** Writes the cards now (shutdown, backups); otherwise at most every few seconds after a change. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const p = this.file();
    if (!p || !this.dirty) return;
    this.dirty = false;
    mkdirSync(join(this.d.dataDir!, 'site'), { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify({ v: 1, cards: [...this.cards.values()] }));
    renameSync(`${p}.tmp`, p);
  }

  private newId(): string {
    let id = '';
    do {
      id = [...randomBytes(10)].map((b) => ID_CHARS[b % ID_CHARS.length]).join('');
    } while (this.cards.has(id) || this.offers.has(id));
    return id;
  }

  private keep(full: ShareCard): void {
    this.cards.set(full.id, full);
    while (this.cards.size > SHARES_KEPT) this.cards.delete(this.cards.keys().next().value!);
    this.dirty = true;
    this.saveTimer ??= setTimeout(() => this.flush(), SAVE_EVERY_MS);
    this.saveTimer.unref?.();
  }

  private add(card: Omit<ShareCard, 'id' | 'at'>): ShareCard {
    const full: ShareCard = { id: this.newId(), at: this.now(), ...card };
    this.keep(full);
    return full;
  }

  /** A card held in memory until its link is first opened (`get` keeps it then). */
  private offer(card: Omit<ShareCard, 'id' | 'at'>): ShareCard {
    const now = this.now();
    const full: ShareCard = { id: this.newId(), at: now, ...card };
    this.offers.set(full.id, full);
    for (const [id, c] of this.offers) {
      if (this.offers.size <= OFFERS_KEPT && now - c.at < OFFER_TTL_MS) break;
      this.offers.delete(id);
    }
    return full;
  }

  private base(o: ShareOrigin): Pick<ShareCard, 'name' | 'wallet' | 'skin' | 'country' | 'holder' | 'room' | 'test'> {
    const r = o.room.opts;
    const room = r.stake && !r.custom ? arenaMeta(r.stake.arenaId).name : r.name;
    return {
      name: shareName(o.player.name),
      wallet: o.wallet ? shortAddress(o.wallet) : null,
      skin: o.player.skin,
      country: o.player.country,
      holder: (o.player.flags & PlayerFlag.Holder) !== 0,
      room,
      // a testnet test arena: TEST on the card and the page, never a payout
      ...(r.test ? { test: true } : {}),
    };
  }

  /**
   * A room's end (an arena's bell, a custom room's end): the card of my place on its final board. `payout`: what
   * reached the wallet (ledger units), arenas only (never on a test arena's card). `eaten`: the coins I ate
   * (`DeathStats.eaten`), names cleaned again here.
   */
  result(
    o: ShareOrigin,
    r: { rank: number; of: number; mass: number; kills: number; payout?: number; eaten?: readonly EatenName[]; eatenMore?: number; standings?: readonly RoundStanding[] },
  ): ShareCard {
    const kind: ShareKind = o.room.opts.stake ? 'round' : 'room';
    const paid = !o.room.opts.test && r.payout && r.payout > 0 ? this.money(r.payout) : undefined;
    const board = this.board(o, r.standings);
    return this.add({
      kind,
      ...this.base(o),
      rank: r.rank,
      players: r.of,
      mass: Math.floor(r.mass),
      kills: r.kills,
      ...(paid ? { paid } : {}),
      ...this.eaten(r),
      ...(board.length > 0 ? { board } : {}),
    });
  }

  /**
   * A death (every room): the card of the game I had (no place: the mass reached and the coins I ate), an offer like a
   * kill's (kept only once its link is opened).
   */
  game(o: ShareOrigin, g: { mass: number; kills: number; eaten?: readonly EatenName[]; eatenMore?: number }): ShareCard {
    return this.offer({ kind: o.room.opts.stake ? 'round' : 'room', ...this.base(o), mass: Math.floor(g.mass), kills: g.kills, ...this.eaten(g) });
  }

  /** "1,234.5 $NIBAL" (ledger units), or undefined without the token. */
  private money(v: number): string | undefined {
    const t = this.d.token();
    return t ? `${formatToken(v, ledgerDecimals(t.decimals), { maxFrac: 2 })} ${t.symbol}` : undefined;
  }

  /** The coins eaten, as a card keeps them: the first `EATEN_SHOWN` (names cleaned, linked handles only) and "+N". */
  private eaten(r: { eaten?: readonly EatenName[]; eatenMore?: number }): Pick<ShareCard, 'eaten' | 'eatenMore'> {
    const list = (r.eaten ?? []).slice(0, EATEN_SHOWN).map((e): EatenName => {
      const x = this.tag(e.bot ? null : e.xHandle);
      return { name: shareName(e.name), ...(e.bot ? { bot: true } : {}), ...(e.n && e.n > 1 ? { n: Math.floor(e.n) } : {}), ...(x ? { xHandle: x } : {}) };
    });
    const more = Math.max(0, Math.floor(r.eatenMore ?? 0)) + Math.max(0, (r.eaten?.length ?? 0) - list.length);
    return { ...(list.length > 0 ? { eaten: list } : {}), ...(more > 0 ? { eatenMore: more } : {}) };
  }

  /**
   * The final standings a result card draws: the top `SHARE_BOARD_ROWS` and my own row (names cleaned, bots tagged);
   * an arena's value at the bell formatted (never on a test arena's card: practice tokens).
   */
  private board(o: ShareOrigin, rows: readonly RoundStanding[] | undefined): ShareBoardRow[] {
    if (!rows) return [];
    const top = rows.filter((r) => r.rank <= SHARE_BOARD_ROWS);
    const mine = rows.find((r) => r.you && r.rank > SHARE_BOARD_ROWS);
    const test = !!o.room.opts.test;
    return [...top.slice(0, SHARE_BOARD_ROWS), ...(mine ? [mine] : [])].map((r): ShareBoardRow => {
      const value = !test && r.value !== undefined ? this.money(r.value) : undefined;
      return {
        rank: Math.floor(r.rank),
        name: shareName(r.name),
        mass: Math.max(0, Math.floor(r.mass)),
        kills: Math.max(0, Math.floor(r.kills)),
        ...(value ? { value } : {}),
        ...(r.isBot ? { bot: true } : {}),
        ...(r.you ? { you: true } : {}),
      };
    });
  }

  /** A handle a card may tag: valid and still linked to a wallet (an unlinked account is never tagged). */
  private tag(handle: string | null | undefined): string | null {
    return isXHandle(handle) && this.d.xLinked?.(handle) === true ? handle : null;
  }

  /**
   * A kill (every person eaten; a practice bot in a test arena only): an offer (`offer`), or null when this player
   * (`key`: its connection or wallet) got one in the last `KILL_SHARE_EVERY_MS`.
   */
  kill(o: ShareOrigin, key: string, k: { mass: number; kills: number; victim: string; victimMass: number; victimIsBot?: boolean; victimX?: string | null }): ShareCard | null {
    // a practice bot counts in a testnet test arena only
    if (k.victimIsBot && !o.room.opts.test) return null;
    const now = this.now();
    const last = this.lastKill.get(key);
    if (last !== undefined && now - last < KILL_SHARE_EVERY_MS) return null;
    this.lastKill.set(key, now);
    if (this.lastKill.size > 10_000) for (const [k2, at] of this.lastKill) if (now - at >= KILL_SHARE_EVERY_MS) this.lastKill.delete(k2);
    // a linked victim is tagged (bots never are)
    const victimX = k.victimIsBot ? null : this.tag(k.victimX);
    return this.offer({ kind: 'kill', ...this.base(o), mass: Math.floor(k.mass), kills: k.kills, victim: shareName(k.victim), victimMass: k.victimMass, ...(k.victimIsBot ? { victimBot: true } : {}), ...(victimX ? { victimX } : {}) });
  }

  /** Startup self-check result (`shareCardSelfCheck`): when drawing cannot work here, images fall back at once. */
  setRenderBroken(why: string | null): void {
    this.renderBroken = why;
  }

  /** A kept card or a live offer, as it is (an offer stays an offer: the pictures are served this way). */
  peek(id: string): ShareCard | null {
    if (!SHARE_ID_RE.test(id)) return null;
    const c = this.cards.get(id) ?? this.offers.get(id) ?? null;
    return c && (this.cards.has(id) || this.now() - c.at < OFFER_TTL_MS) ? c : null;
  }

  /** A kept card, or an offer opened for the first time (kept from then on); null when unknown or expired. */
  get(id: string): ShareCard | null {
    if (!SHARE_ID_RE.test(id)) return null;
    const kept = this.cards.get(id);
    if (kept) return kept;
    const o = this.offers.get(id);
    if (!o) return null;
    this.offers.delete(id);
    if (this.now() - o.at >= OFFER_TTL_MS) return null;
    this.keep(o);
    return o;
  }

  /**
   * `GET /share/<id>` (the page), `GET /share/<id>.png` (the image) and `GET /share/<id>/standings.png` (a result's
   * final standings). False when the path is not a share's.
   */
  handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): boolean {
    const m = /^\/share\/([^/.]+)(\.png|\/standings\.png)?$/.exec(path);
    if (!m) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return true;
    }
    const standings = m[2] === '/standings.png';
    // the page keeps an offer (X opens it as the post is written); a picture does not
    const card = m[2] ? this.peek(m[1]) : this.get(m[1]);
    if (!card || (standings && !card.board?.length)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No such card.');
      return true;
    }
    if (m[2]) {
      const key = standings ? `${card.id}/standings` : card.id;
      let png = this.png.get(key);
      if (!png) {
        if (this.renderBroken) {
          // no canvas here: the site's own Open Graph picture, so a shared link still shows an image
          res.writeHead(302, { Location: `${this.d.baseUrl(req).replace(/\/$/, '')}/og-coinnibal.png`, 'Cache-Control': 'public, max-age=300' });
          res.end();
          return true;
        }
        if (!this.renders.allow(ip) || !this.rendersAll.allow('all')) {
          res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
          res.end('Too many cards. Try again in a minute.');
          return true;
        }
        try {
          const site = siteHostOf(this.d.baseUrl(req));
          png = standings ? renderStandingsCard(card, site) : renderShareCard(card, site);
        } catch (err) {
          this.renderBroken = String((err as Error)?.message ?? err).split('\n')[0];
          this.d.log?.(`!!! share cards: drawing failed (${this.renderBroken}) — share images fall back to the site's picture until a restart`);
          res.writeHead(302, { Location: `${this.d.baseUrl(req).replace(/\/$/, '')}/og-coinnibal.png` });
          res.end();
          return true;
        }
        this.png.set(key, png);
        if (this.png.size > PNG_CACHE) this.png.delete(this.png.keys().next().value!);
      }
      // a card never changes: CDNs (the Vercel rewrite, Cloudflare) may keep it as long as they like
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=86400, s-maxage=604800, immutable' });
      res.end(req.method === 'HEAD' ? undefined : png);
      return true;
    }
    const html = sharePage(card, this.d.baseUrl(req).replace(/\/$/, ''));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      // the page runs no script at all
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  }
}

/** The share page: the Open Graph and Twitter card tags (X shows the image), the card, and the way into the game. */
export function sharePage(card: ShareCard, origin: string): string {
  const title = `${card.test ? 'TEST · ' : ''}${card.name} · ${shareHeadline(card)} · ${BRAND_NAME}`;
  const desc = card.test
    ? `${shareFacts(card).join(' · ')}. A testnet test arena: practice tokens, no real money.`
    : `${shareFacts(card).join(' · ')}. Coin eats coin on Robinhood Chain.`;
  const page = `${origin}/share/${card.id}`;
  const img = `${page}.png`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(page)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(page)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="${SHARE_IMAGE.width}">
<meta property="og:image:height" content="${SHARE_IMAGE.height}">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;background:#0F2A30;color:#F6EEDA;font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box}img{max-width:min(100%,900px);height:auto;border-radius:18px;border:4px solid #04181C}a{display:inline-block;padding:14px 28px;border-radius:999px;background:#F2C14E;color:#04181C;font-weight:700;text-decoration:none;border:3px solid #04181C}</style>
</head>
<body>
<img src="/share/${esc(card.id)}.png" width="${SHARE_IMAGE.width}" height="${SHARE_IMAGE.height}" alt="${esc(title)}">
<a href="/play">Play ${BRAND_NAME}</a>
</body>
</html>
`;
}
