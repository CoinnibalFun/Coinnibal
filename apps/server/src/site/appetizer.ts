import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { getAddress, isAddress } from 'viem';
import {
  APPETIZER_CODE_RE,
  APPETIZER_IMAGE,
  APPETIZER_LIMITS,
  BRAND_NAME,
  appetizerPath,
  normalizeXHandle,
  siteHostOf,
  type AppetizerCard,
  type AppetizerEntry,
  type AppetizerList,
  type AppetizerResponse,
} from '@coinnibal/shared';
import { Limiter } from '../net/limiter';
import { renderAppetizerCard } from './share-card';
import { csv } from './store';
import { SiteFail, obj } from './validate';

/**
 * The Appetizer (`packages/shared/src/appetizer.ts`): an early card a visitor claims on the landing page with a wallet
 * and an X handle. Kept in `DATA_DIR/site/appetizers.json` (the whole list, written to a temp file and renamed, a
 * moment after a change and on `flush`), served at `/appetizer/<code>` (a page with the Open Graph / Twitter tags) and
 * `/appetizer/<code>.png` (the card, rendered once and cached). Nothing public ever carries the wallet: the page, the
 * image and the claim's answer show the number and the handle only; the wallet is for the admin's list and CSV.
 */

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Writes wait this long after a change (a burst of claims or image views is one write). */
const SAVE_EVERY_MS = 1000;
const RENDERS_PER_MIN = 30;
/** Renders a minute for the whole server (as the share cards: a crowd of IPs cannot turn drawing into a CPU flood). */
const RENDERS_PER_MIN_ALL = 120;
const PNG_CACHE = 256;
/** `https://(www.|mobile.)(x|twitter).com/<handle>/status/<id>`, a query string or a fragment allowed (dropped). */
const POST_RE = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?(?:[?#].*)?$/i;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "0042". */
export const appetizerNo = (no: number): string => String(no).padStart(4, '0');

/** The validated wallet (EIP-55) of a claim; a 400 `bad_wallet` otherwise. */
export function claimWallet(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!isAddress(t, { strict: false }) || /^0x0{40}$/i.test(t)) throw new SiteFail(400, 'bad_wallet', 'That is not a wallet address (0x followed by 40 hex characters).', 'wallet');
  return getAddress(t);
}

/** The X handle of a claim as typed (case kept, no `@`, a profile link accepted); a 400 `bad_handle` otherwise. */
export function claimHandle(v: unknown): string {
  const lower = normalizeXHandle(v);
  if (lower === null || typeof v !== 'string') throw new SiteFail(400, 'bad_handle', 'That is not an X handle (1 to 15 letters, numbers or underscores).', 'handle');
  let h = v.trim();
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(h);
  if (m) h = m[1];
  h = h.replace(/^@/, '');
  return h.toLowerCase() === lower ? h : lower;
}

/** A post link, normalised to `https://x.com/<handle>/status/<id>`, with its author; null when it is not one. */
export function parsePostUrl(v: unknown): { url: string; author: string } | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length > APPETIZER_LIMITS.postUrl || /\s/.test(t)) return null;
  const m = POST_RE.exec(t);
  return m ? { url: `https://x.com/${m[1]}/status/${m[2]}`, author: m[1] } : null;
}

/** A stored card, read back: a whole one or nothing. */
function entryOf(v: unknown): AppetizerEntry | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (typeof e.code !== 'string' || !APPETIZER_CODE_RE.test(e.code)) return null;
  if (typeof e.no !== 'number' || !Number.isInteger(e.no) || e.no < 1) return null;
  if (typeof e.at !== 'number' || typeof e.handle !== 'string' || normalizeXHandle(e.handle) === null) return null;
  if (typeof e.wallet !== 'string' || !isAddress(e.wallet, { strict: false })) return null;
  const post = parsePostUrl(e.post);
  return {
    code: e.code,
    no: e.no,
    handle: e.handle,
    at: e.at,
    wallet: getAddress(e.wallet),
    post: post ? post.url : null,
    postedAt: post && typeof e.postedAt === 'number' ? e.postedAt : null,
    views: typeof e.views === 'number' && Number.isFinite(e.views) && e.views > 0 ? Math.floor(e.views) : 0,
  };
}

const publicCard = (e: AppetizerEntry): AppetizerCard => ({ code: e.code, no: e.no, handle: e.handle, at: e.at });

export interface AppetizerDeps {
  /** `DATA_DIR/site/appetizers.json`; null: memory only (tests). */
  path: string | null;
  /** The site's public origin for the absolute page and image URLs (`publicBaseUrl`: `PUBLIC_URL`). */
  baseUrl: (req: IncomingMessage) => string;
  /** Cards one IP may claim (default `APPETIZER_LIMITS.perIpHour` an hour). */
  claimIp?: Limiter;
  /** Post links one IP may send (default 30 an hour). */
  postIp?: Limiter;
  kept?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export class AppetizerService {
  /** Oldest first (claim order). */
  private cards: AppetizerEntry[] = [];
  private readonly byCode = new Map<string, AppetizerEntry>();
  private readonly byWallet = new Map<string, AppetizerEntry>();
  private readonly byHandle = new Map<string, AppetizerEntry>();
  /** The next card's number (a deleted card's number is never handed out again). */
  private next = 1;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly png = new Map<string, Buffer>();
  private readonly renders = new Limiter(RENDERS_PER_MIN, 60_000);
  private readonly rendersAll = new Limiter(RENDERS_PER_MIN_ALL, 60_000);
  /** Drawing failed on this machine (the canvas addon did not load): images fall back to the site's picture. */
  private renderBroken: string | null = null;
  private readonly claimIp: Limiter;
  private readonly postIp: Limiter;
  private readonly kept: number;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly d: AppetizerDeps) {
    this.claimIp = d.claimIp ?? new Limiter(APPETIZER_LIMITS.perIpHour, 60 * 60_000);
    this.postIp = d.postIp ?? new Limiter(30, 60 * 60_000);
    this.kept = d.kept ?? APPETIZER_LIMITS.kept;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => {});
    this.load();
  }

  // ---------- persistence ----------

  private load(): void {
    const p = this.d.path;
    if (!p || !existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as { next?: unknown; cards?: unknown };
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cards)) throw new Error('no card list');
      for (const c of raw.cards) {
        const e = entryOf(c);
        if (!e || this.byCode.has(e.code) || this.byWallet.has(e.wallet.toLowerCase()) || this.byHandle.has(e.handle.toLowerCase())) continue;
        this.index(e);
      }
      const maxNo = this.cards.reduce((m, e) => Math.max(m, e.no), 0);
      this.next = Math.max(maxNo + 1, typeof raw.next === 'number' && Number.isInteger(raw.next) ? raw.next : 1);
    } catch (err) {
      // keep the unreadable file for the operator and start fresh
      const backup = `${p}.corrupt-${Date.now()}`;
      renameSync(p, backup);
      this.log(`appetizer: ${p} unreadable (${(err as Error).message}); moved to ${backup}`);
    }
  }

  private index(e: AppetizerEntry): void {
    this.cards.push(e);
    this.byCode.set(e.code, e);
    this.byWallet.set(e.wallet.toLowerCase(), e);
    this.byHandle.set(e.handle.toLowerCase(), e);
  }

  /** Writes the cards now (shutdown, backups); otherwise a moment after a change. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const p = this.d.path;
    if (!p || !this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(`${p}.tmp`, JSON.stringify({ v: 1, next: this.next, cards: this.cards }), { mode: 0o600 });
      renameSync(`${p}.tmp`, p);
    } catch (err) {
      this.dirty = true;
      this.log(`!!! appetizer: could not write ${p} (${(err as Error).message})`);
    }
  }

  private changed(): void {
    this.dirty = true;
    if (!this.d.path) return;
    this.saveTimer ??= setTimeout(() => this.flush(), SAVE_EVERY_MS);
    this.saveTimer.unref?.();
  }

  private newCode(): string {
    let code = '';
    do {
      code = [...randomBytes(10)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    } while (this.byCode.has(code));
    return code;
  }

  // ---------- the visitor's side ----------

  /**
   * A claim (`wallet` EIP-55, `handle` as typed): the wallet's own card again (`existing`) when the handle is the
   * card's too, a 409 `wallet_taken` when the wallet holds a card under another handle (never naming that handle: a
   * wallet alone must not reveal who holds it), a 409 `handle_taken` when another wallet holds the handle, else a new
   * card with the next number.
   */
  claim(wallet: string, handle: string): AppetizerResponse {
    const mine = this.byWallet.get(wallet.toLowerCase());
    if (mine) {
      if (mine.handle.toLowerCase() !== handle.toLowerCase()) throw new SiteFail(409, 'wallet_taken', 'This wallet already has its card, under another X handle.', 'wallet');
      return { card: publicCard(mine), existing: true };
    }
    if (this.byHandle.has(handle.toLowerCase())) throw new SiteFail(409, 'handle_taken', 'This X handle already has its card.', 'handle');
    if (this.cards.length >= this.kept) throw new SiteFail(403, 'closed', 'Every card has been handed out.');
    const e: AppetizerEntry = { code: this.newCode(), no: this.next++, handle, at: this.now(), wallet, post: null, postedAt: null, views: 0 };
    this.index(e);
    this.changed();
    return { card: publicCard(e), existing: false };
  }

  /** The X post that shared card `code`: its author must be the card's handle. */
  setPost(code: string, raw: unknown): void {
    const e = this.find(code);
    const post = parsePostUrl(raw);
    if (!post) throw new SiteFail(400, 'bad_post', 'That is not a link to a post on X (https://x.com/<handle>/status/<number>).', 'url');
    if (post.author.toLowerCase() !== e.handle.toLowerCase()) throw new SiteFail(400, 'bad_post', `That post is not by @${e.handle}.`, 'url');
    if (e.post === post.url) return;
    e.post = post.url;
    e.postedAt = this.now();
    this.changed();
  }

  private find(code: string): AppetizerEntry {
    const e = APPETIZER_CODE_RE.test(code) ? this.byCode.get(code) : undefined;
    if (!e) throw new SiteFail(404, 'not_found', 'No such card.');
    return e;
  }

  /** A card as anyone may see it (never the wallet); null when unknown. */
  card(code: string): AppetizerCard | null {
    const e = APPETIZER_CODE_RE.test(code) ? this.byCode.get(code) : undefined;
    return e ? publicCard(e) : null;
  }

  // ---------- the routes ----------

  /** `POST /api/appetizer {wallet, handle}`; `open`: `SiteSettings.appetizerOpen`. */
  async claimRoute(req: IncomingMessage, res: ServerResponse, ip: string, open: boolean, read: (req: IncomingMessage, limit: number) => Promise<unknown>, send: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
    if (!open) throw new SiteFail(403, 'closed', 'Cards are not being handed out right now.');
    if (!this.claimIp.allow(ip)) throw new SiteFail(429, 'rate_limited', 'Too many cards from here in the last hour. Try again later.');
    const body = obj(await read(req, APPETIZER_LIMITS.bodyBytes));
    const r = this.claim(claimWallet(body.wallet), claimHandle(body.handle));
    if (!r.existing) this.log(`appetizer: card No. ${appetizerNo(r.card.no)} claimed`);
    send(res, r.existing ? 200 : 201, r);
  }

  /** `POST /api/appetizer/<code>/post {url}`. */
  async postRoute(req: IncomingMessage, res: ServerResponse, code: string, ip: string, read: (req: IncomingMessage, limit: number) => Promise<unknown>, send: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
    if (!this.postIp.allow(ip)) throw new SiteFail(429, 'rate_limited', 'Too many links from here in the last hour. Try again later.');
    this.find(code);
    const body = obj(await read(req, APPETIZER_LIMITS.bodyBytes));
    this.setPost(code, body.url);
    send(res, 200, { ok: true });
  }

  // ---------- the admin's side ----------

  /** Newest first: at most `limit` (≤ `pageMax`) from `offset`; `q` keeps the cards whose handle or wallet contains it. */
  list(opts: { offset?: number; limit?: number; q?: string | null } = {}): AppetizerList {
    const limit = Math.min(APPETIZER_LIMITS.pageMax, Math.max(1, Math.floor(opts.limit ?? 100) || 100));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0) || 0);
    const q = (opts.q ?? '').trim().replace(/^@/, '').toLowerCase();
    const items: AppetizerEntry[] = [];
    let skipped = 0;
    for (let i = this.cards.length - 1; i >= 0 && items.length < limit; i--) {
      const e = this.cards[i];
      if (q && !e.handle.toLowerCase().includes(q) && !e.wallet.toLowerCase().includes(q)) continue;
      if (skipped++ < offset) continue;
      items.push({ ...e });
    }
    return { items, total: this.cards.length, posted: this.posted() };
  }

  posted(): number {
    let n = 0;
    for (const e of this.cards) if (e.post) n++;
    return n;
  }

  get total(): number {
    return this.cards.length;
  }

  /** Every card, in claim order: no., handle, wallet, claimed (ISO), post, views. */
  csv(): string {
    return csv([['no', 'handle', 'wallet', 'claimed', 'post', 'views'], ...this.cards.map((e) => [e.no, e.handle, e.wallet, new Date(e.at).toISOString(), e.post ?? '', e.views])]);
  }

  /** Deletes card `code` (its number is not handed out again; its handle and wallet may claim anew). */
  remove(code: string): AppetizerEntry {
    const e = this.find(code);
    this.cards = this.cards.filter((x) => x !== e);
    this.byCode.delete(e.code);
    this.byWallet.delete(e.wallet.toLowerCase());
    this.byHandle.delete(e.handle.toLowerCase());
    this.png.delete(e.code);
    this.changed();
    return { ...e };
  }

  // ---------- the share page and the image ----------

  /** Startup self-check result (`shareCardSelfCheck`): when drawing cannot work here, images fall back at once. */
  setRenderBroken(why: string | null): void {
    this.renderBroken = why;
  }

  /** `GET /appetizer/<code>` (the page) and `GET /appetizer/<code>.png` (the card). False when the path is not one. */
  handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): boolean {
    const m = /^\/appetizer\/([^/.]+)(\.png)?$/.exec(path);
    if (!m) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return true;
    }
    const e = APPETIZER_CODE_RE.test(m[1]) ? this.byCode.get(m[1]) : undefined;
    if (!e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No such card.');
      return true;
    }
    const origin = this.d.baseUrl(req).replace(/\/$/, '');
    if (!m[2]) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        // the page runs no script at all
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : appetizerPage(publicCard(e), origin));
      return true;
    }
    let png = this.png.get(e.code);
    if (!png) {
      if (this.renderBroken) return this.fallback(res, origin, e);
      if (!this.renders.allow(ip) || !this.rendersAll.allow('all')) {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
        res.end('Too many cards. Try again in a minute.');
        return true;
      }
      try {
        png = renderAppetizerCard(e, siteHostOf(origin));
      } catch (err) {
        this.renderBroken = String((err as Error)?.message ?? err).split('\n')[0];
        this.log(`!!! appetizer cards: drawing failed (${this.renderBroken}) — card images fall back to the site's picture until a restart`);
        return this.fallback(res, origin, e);
      }
      this.png.set(e.code, png);
      if (this.png.size > PNG_CACHE) this.png.delete(this.png.keys().next().value!);
    }
    this.viewed(e);
    // kept short: every fetch counts as a view (a CDN that kept it for days would hide them), and a deleted card goes
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? undefined : png);
    return true;
  }

  private viewed(e: AppetizerEntry): void {
    e.views++;
    this.changed();
  }

  /** No canvas here: the site's own Open Graph picture, so a shared link still shows an image. */
  private fallback(res: ServerResponse, origin: string, e: AppetizerEntry): true {
    this.viewed(e);
    res.writeHead(302, { Location: `${origin}/og-coinnibal.png`, 'Cache-Control': 'public, max-age=300' });
    res.end();
    return true;
  }
}

/** The share page: the Open Graph and Twitter card tags (X shows the card), then on to the landing's card stand. */
export function appetizerPage(card: AppetizerCard, origin: string): string {
  const title = `Appetizer No. ${appetizerNo(card.no)} · @${card.handle}`;
  const desc = `${BRAND_NAME}: coins eating coins.`;
  const page = `${origin}${appetizerPath(card.code)}`;
  const img = `${page}.png`;
  const landing = `${origin}/#appetizer`;
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
<meta property="og:image:width" content="${APPETIZER_IMAGE.width}">
<meta property="og:image:height" content="${APPETIZER_IMAGE.height}">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0; url=${esc(landing)}">
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;background:#0F2A30;color:#F6EEDA;font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box}img{max-width:min(100%,900px);height:auto;border-radius:18px;border:4px solid #04181C}a{display:inline-block;padding:14px 28px;border-radius:999px;background:#F2C14E;color:#04181C;font-weight:700;text-decoration:none;border:3px solid #04181C}</style>
</head>
<body>
<img src="${esc(appetizerPath(card.code))}.png" width="${APPETIZER_IMAGE.width}" height="${APPETIZER_IMAGE.height}" alt="${esc(title)}">
<a href="${esc(landing)}">Get your own card</a>
</body>
</html>
`;
}
