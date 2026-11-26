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
  type AppetizerOurPost,
  type AppetizerOurPostResponse,
  type AppetizerPostResponse,
  type AppetizerResponse,
} from '@coinnibal/shared';
import type { XPost, XPostRead } from '../xlink';
import { Limiter } from '../net/limiter';
import { CardRenderError, inlineCardRenderer, type CardRenderer } from './card-renderer';
import { csv } from './store';
import { SiteFail, obj } from './validate';

/**
 * The Appetizer (`packages/shared/src/appetizer.ts`): an early card a visitor claims on the landing page with a wallet
 * and an X handle, once they say they follow the project's X account (`followed: true`, on trust: there is no X API
 * here, as the WL's `follow_x` task). The post link that completes a card is read back from X's public embed
 * endpoints (`XLinkService.readPost`, no key): by the card's handle, carrying the card's link. Kept in `DATA_DIR/site/appetizers.json` (the whole list, written to a temp file and renamed, a
 * moment after a change and on `flush`), served at `/appetizer/<code>` (a page with the Open Graph / Twitter tags) and
 * `/appetizer/<code>.png` (the card, rendered once and cached). Nothing public ever carries the wallet: the page, the
 * image and the claim's answer show the number and the handle only; the wallet is for the admin's list and CSV.
 */

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Writes wait this long after a change (a burst of claims or image views is one write). */
const SAVE_EVERY_MS = 1000;
/**
 * A change of the view counts only is written this long after it: the file is the whole list (about 25 MB at 100k
 * cards, a write blocks the main thread for ~150 ms), and image fetches are not limited once a card is cached, so a
 * flood of them must not rewrite it every second. A crash loses at most this much of the view counts.
 */
const VIEWS_SAVE_EVERY_MS = 60_000;
const RENDERS_PER_MIN = 30;
/** Renders a minute for the whole server (as the share cards: a crowd of IPs cannot turn drawing into a CPU flood). */
const RENDERS_PER_MIN_ALL = 120;
const PNG_CACHE = 256;
/** Our X post is read from X at most this often for the sheet's box; a failed read is tried again sooner. */
const OUR_POST_TTL_MS = 10 * 60_000;
const OUR_POST_RETRY_MS = 60_000;
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

/** The claim's follow: `true` only; a 400 `follow_required` otherwise. */
export function claimFollowed(v: unknown): true {
  if (v !== true) throw new SiteFail(400, 'follow_required', 'Follow the project on X first: the card needs the follow.', 'followed');
  return true;
}

/** Whether post `p` carries card `code`'s link: its code in the text or in a link X expanded (the share page's path). */
export function postCarriesCard(p: Pick<XPost, 'text' | 'urls'>, code: string): boolean {
  const re = new RegExp(`(?:^|[^A-Za-z0-9])${code}(?![A-Za-z0-9])`);
  return [p.text, ...(p.urls ?? [])].some((s) => re.test(s));
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
    postVerified: !!post && e.postVerified === true,
    likedAt: typeof e.likedAt === 'number' && Number.isFinite(e.likedAt) ? e.likedAt : null,
    // cards from before the follow was asked have none
    followedAt: typeof e.followedAt === 'number' && Number.isFinite(e.followedAt) ? e.followedAt : null,
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
  /** Reads a post from X (`XLinkService.readPost`); without it every post link is kept unchecked. */
  readPost?: ((id: string) => Promise<XPostRead>) | null;
  /** Where the cards are drawn (the app's card workers, `setRenderer`); default: this thread. */
  renderer?: CardRenderer;
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
  /** When the pending write runs (Unix ms of `Date.now`), while `saveTimer` is set. */
  private saveAt = 0;
  private readonly png = new Map<string, Buffer>();
  /** Cards being drawn: a second request for one waits for the same draw. */
  private readonly drawing = new Map<string, Promise<Buffer>>();
  private renderer: CardRenderer;
  private readonly renders = new Limiter(RENDERS_PER_MIN, 60_000);
  private readonly rendersAll = new Limiter(RENDERS_PER_MIN_ALL, 60_000);
  /** Drawing failed on this machine (the canvas addon did not load): images fall back to the site's picture. */
  private renderBroken: string | null = null;
  private readonly claimIp: Limiter;
  private readonly postIp: Limiter;
  private readonly kept: number;
  private readPost: ((id: string) => Promise<XPostRead>) | null;
  /** Our post as last read from X (`ourPost`), and the read under way. */
  private ours: { url: string; view: AppetizerOurPost | null; until: number } | null = null;
  private oursLoading: { url: string; p: Promise<AppetizerOurPost | null> } | null = null;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly d: AppetizerDeps) {
    this.claimIp = d.claimIp ?? new Limiter(APPETIZER_LIMITS.perIpHour, 60 * 60_000);
    this.postIp = d.postIp ?? new Limiter(30, 60 * 60_000);
    this.kept = d.kept ?? APPETIZER_LIMITS.kept;
    this.readPost = d.readPost ?? null;
    this.renderer = d.renderer ?? inlineCardRenderer;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => {});
    this.load();
  }

  /** The X reader for post links (set once "Link X" is up). */
  /** Where the cards are drawn from now on (the app's card workers). */
  setRenderer(r: CardRenderer): void {
    this.renderer = r;
  }

  setPostReader(fn: ((id: string) => Promise<XPostRead>) | null): void {
    this.readPost = fn;
    this.ours = null;
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

  /** Marks the cards for a write within `delayMs` (an earlier pending write stays; a later one is brought forward). */
  private changed(delayMs = SAVE_EVERY_MS): void {
    this.dirty = true;
    if (!this.d.path) return;
    const at = Date.now() + delayMs;
    if (this.saveTimer && this.saveAt <= at) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveAt = at;
    this.saveTimer = setTimeout(() => this.flush(), delayMs);
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
  claim(wallet: string, handle: string, liked = false): AppetizerResponse {
    const mine = this.byWallet.get(wallet.toLowerCase());
    if (mine) {
      if (mine.handle.toLowerCase() !== handle.toLowerCase()) throw new SiteFail(409, 'wallet_taken', 'This wallet already has its card, under another X handle.', 'wallet');
      return { card: publicCard(mine), existing: true };
    }
    if (this.byHandle.has(handle.toLowerCase())) throw new SiteFail(409, 'handle_taken', 'This X handle already has its card.', 'handle');
    if (this.cards.length >= this.kept) throw new SiteFail(403, 'closed', 'Every card has been handed out.');
    const at = this.now();
    // the claim itself says the visitor follows (`claimFollowed`): its moment is the claim's
    const e: AppetizerEntry = { code: this.newCode(), no: this.next++, handle, at, wallet, post: null, postedAt: null, postVerified: false, followedAt: at, likedAt: liked ? at : null, views: 0 };
    this.index(e);
    this.changed();
    return { card: publicCard(e), existing: false };
  }

  /**
   * The X post that shared card `code`: its author must be the card's handle, and X must show it carrying the card's
   * link. X down (or only its oEmbed answering, which has no expanded links) keeps the link unchecked
   * (`verified: false`) rather than block the visitor; X saying there is no such post, or the post not carrying the
   * card, refuses it (422 `post_unverified`).
   */
  async setPost(code: string, raw: unknown): Promise<AppetizerPostResponse> {
    const e = this.find(code);
    const post = parsePostUrl(raw);
    if (!post) throw new SiteFail(400, 'bad_post', 'That is not a link to a post on X (https://x.com/<handle>/status/<number>).', 'url');
    if (post.author.toLowerCase() !== e.handle.toLowerCase()) throw new SiteFail(400, 'bad_post', `That post is not by @${e.handle}.`, 'url');
    if (e.post === post.url && e.postVerified) return { ok: true, verified: true };
    const verified = await this.checkPost(e, post.url);
    // the card may have gone while X was read
    if (this.byCode.get(code) !== e) throw new SiteFail(404, 'not_found', 'No such card.');
    // anyone may send a link for a card (its code is in the public share link): a link X could not check never
    // replaces a verified post (X down, or its read budget spent by a flood, must not unverify someone's card)
    if (!verified && e.post && e.postVerified && e.post !== post.url) {
      throw new SiteFail(503, 'x_unreachable', 'X did not answer, so that link cannot be checked now. Your card keeps its verified post; try again later.', 'url');
    }
    if (e.post !== post.url || e.postVerified !== verified) {
      e.post = post.url;
      e.postedAt = this.now();
      e.postVerified = verified;
      this.changed();
    }
    return { ok: true, verified };
  }

  /** True: X shows the post by the card's handle carrying its link; false: X could not tell (kept unchecked). */
  private async checkPost(e: AppetizerEntry, url: string): Promise<boolean> {
    if (!this.readPost) return false;
    const id = /\/status\/(\d+)$/.exec(url)![1];
    const read = await this.readPost(id);
    if (!read.ok) {
      if (read.why === 'down') {
        this.log(`appetizer: X did not answer for card No. ${appetizerNo(e.no)}; its post link is kept unchecked`);
        return false;
      }
      throw new SiteFail(422, 'post_unverified', 'X shows no public post at that link. Is your account public?', 'url');
    }
    const p = read.post;
    if (p.handle.toLowerCase() !== e.handle.toLowerCase()) throw new SiteFail(400, 'bad_post', `That post is not by @${e.handle}.`, 'url');
    if (postCarriesCard(p, e.code)) return true;
    // oEmbed shows links as t.co only: the card's link may be behind one
    if (p.urls === null && /t\.co\//i.test(p.text)) return false;
    throw new SiteFail(422, 'post_unverified', 'That post does not carry your card. Post it with the "Post on X" button, then paste that link.', 'url');
  }

  /**
   * Our X post (`appetizerPostUrl`, only that one) as the sheet's box shows it: read from X at most once every
   * `OUR_POST_TTL_MS` (a failed read is tried again after `OUR_POST_RETRY_MS`), visitors sharing one read. Null while
   * no post is set, no X reader is up, or X cannot show it.
   */
  async ourPost(url: string | null): Promise<AppetizerOurPost | null> {
    const post = parsePostUrl(url);
    if (!post || !this.readPost) return null;
    const now = this.now();
    const c = this.ours;
    if (c && c.url === post.url && now < c.until) return c.view;
    if (this.oursLoading?.url === post.url) return this.oursLoading.p;
    const read = this.readPost;
    const p = (async () => {
      let view: AppetizerOurPost | null = null;
      try {
        const r = await read(/\/status\/(\d+)$/.exec(post.url)![1]);
        if (r.ok) {
          const v = r.post.view ?? { text: r.post.text, photo: null };
          view = { url: post.url, handle: r.post.handle, name: r.post.name || r.post.handle, avatar: r.post.avatarUrl, text: v.text, photo: v.photo, at: r.post.createdAt };
        }
      } catch (err) {
        this.log(`appetizer: our post could not be read (${(err as Error).message})`);
      }
      this.ours = { url: post.url, view, until: this.now() + (view ? OUR_POST_TTL_MS : OUR_POST_RETRY_MS) };
      return view;
    })();
    this.oursLoading = { url: post.url, p };
    try {
      return await p;
    } finally {
      if (this.oursLoading?.p === p) this.oursLoading = null;
    }
  }

  /** `GET /api/appetizer/post`: our post for the sheet's box (`AppetizerOurPostResponse`), cached a few minutes by browsers too. */
  async ourPostRoute(res: ServerResponse, url: string | null, head: boolean): Promise<void> {
    const body: AppetizerOurPostResponse = { post: await this.ourPost(url) };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(head ? undefined : JSON.stringify(body));
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

  /** `POST /api/appetizer {wallet, handle, followed: true}`; `open`: `SiteSettings.appetizerOpen`. */
  async claimRoute(req: IncomingMessage, res: ServerResponse, ip: string, open: boolean, read: (req: IncomingMessage, limit: number) => Promise<unknown>, send: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
    if (!open) throw new SiteFail(403, 'closed', 'Cards are not being handed out right now.');
    if (!this.claimIp.allow(ip)) throw new SiteFail(429, 'rate_limited', 'Too many cards from here in the last hour. Try again later.');
    const body = obj(await read(req, APPETIZER_LIMITS.bodyBytes));
    claimFollowed(body.followed);
    const r = this.claim(claimWallet(body.wallet), claimHandle(body.handle), body.liked === true);
    if (!r.existing) this.log(`appetizer: card No. ${appetizerNo(r.card.no)} claimed`);
    send(res, r.existing ? 200 : 201, r);
  }

  /** `POST /api/appetizer/<code>/post {url}`. */
  async postRoute(req: IncomingMessage, res: ServerResponse, code: string, ip: string, read: (req: IncomingMessage, limit: number) => Promise<unknown>, send: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
    if (!this.postIp.allow(ip)) throw new SiteFail(429, 'rate_limited', 'Too many links from here in the last hour. Try again later.');
    this.find(code);
    const body = obj(await read(req, APPETIZER_LIMITS.bodyBytes));
    send(res, 200, await this.setPost(code, body.url));
  }

  // ---------- the admin's side ----------

  /**
   * Newest first: at most `limit` (≤ `pageMax`) from `offset`; `q` keeps the cards whose handle or wallet contains it,
   * `complete` those with (true) or without (false) a post link.
   */
  list(opts: { offset?: number; limit?: number; q?: string | null; complete?: boolean | null } = {}): AppetizerList {
    const limit = Math.min(APPETIZER_LIMITS.pageMax, Math.max(1, Math.floor(opts.limit ?? 100) || 100));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0) || 0);
    const q = (opts.q ?? '').trim().replace(/^@/, '').toLowerCase();
    const items: AppetizerEntry[] = [];
    let skipped = 0;
    for (let i = this.cards.length - 1; i >= 0 && items.length < limit; i--) {
      const e = this.cards[i];
      if (q && !e.handle.toLowerCase().includes(q) && !e.wallet.toLowerCase().includes(q)) continue;
      if (typeof opts.complete === 'boolean' && opts.complete !== !!e.post) continue;
      if (skipped++ < offset) continue;
      items.push({ ...e });
    }
    return { items, total: this.cards.length, posted: this.posted(), verified: this.verified() };
  }

  posted(): number {
    let n = 0;
    for (const e of this.cards) if (e.post) n++;
    return n;
  }

  verified(): number {
    let n = 0;
    for (const e of this.cards) if (e.post && e.postVerified) n++;
    return n;
  }

  get total(): number {
    return this.cards.length;
  }

  /**
   * Every card, in claim order: no., handle, wallet, claimed, followed and liked (ISO, empty when not asked), post,
   * post_verified (yes / no, empty without a post), complete (yes / no: a post link is in), views.
   */
  csv(): string {
    const iso = (t: number | null) => (t === null ? '' : new Date(t).toISOString());
    return csv([
      ['no', 'handle', 'wallet', 'claimed', 'followed', 'liked', 'post', 'post_verified', 'complete', 'views'],
      ...this.cards.map((e) => [e.no, e.handle, e.wallet, iso(e.at), iso(e.followedAt), iso(e.likedAt), e.post ?? '', e.post ? (e.postVerified ? 'yes' : 'no') : '', e.post ? 'yes' : 'no', e.views]),
    ]);
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

  /**
   * Redates card `code` to now and draws it anew: the same number, link and post, today's date on the image. The share
   * page's image URL carries the date, so X fetches the new picture for a post made after this.
   */
  refresh(code: string): AppetizerEntry {
    const e = this.find(code);
    e.at = this.now();
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
    const send = (png: Buffer) => {
      if (res.writableEnded || res.destroyed) return;
      this.viewed(e);
      // kept short: every fetch counts as a view (a CDN that kept it for days would hide them), and a deleted card goes
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=300' });
      res.end(req.method === 'HEAD' ? undefined : png);
    };
    const cached = this.png.get(e.code);
    if (cached) {
      send(cached);
      return true;
    }
    if (this.renderBroken) return this.fallback(res, origin, e);
    const code = e.code;
    let draw = this.drawing.get(code);
    if (!draw) {
      if (!this.renders.allow(ip) || !this.rendersAll.allow('all')) {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
        res.end('Too many cards. Try again in a minute.');
        return true;
      }
      const at = e.at;
      draw = this.renderer.render({ kind: 'appetizer', card: { no: e.no, handle: e.handle, at }, site: siteHostOf(origin) });
      this.drawing.set(code, draw);
      draw.then(
        (png) => {
          this.drawing.delete(code);
          // a card deleted or redated while it was drawn is not cached
          if (this.byCode.get(code) !== e || e.at !== at) return;
          this.png.set(code, png);
          if (this.png.size > PNG_CACHE) this.png.delete(this.png.keys().next().value!);
        },
        (err: unknown) => {
          this.drawing.delete(code);
          if (err instanceof CardRenderError && err.code !== 'canvas') return;
          this.renderBroken ??= String((err as Error)?.message ?? err).split('\n')[0];
          this.log(`!!! appetizer cards: drawing failed (${this.renderBroken}) — card images fall back to the site's picture until a restart`);
        },
      );
    }
    draw.then(send, (err: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof CardRenderError && err.code === 'busy') {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '5' });
        res.end('Too many cards. Try again in a moment.');
      } else this.fallback(res, origin, e, err instanceof CardRenderError && err.code === 'canvas');
    });
    return true;
  }

  private viewed(e: AppetizerEntry): void {
    e.views++;
    this.changed(VIEWS_SAVE_EVERY_MS);
  }

  /** No canvas here: the site's own Open Graph picture, so a shared link still shows an image. */
  private fallback(res: ServerResponse, origin: string, e: AppetizerEntry, cache = true): true {
    this.viewed(e);
    // a passing failure (a worker died) is not cached: the next fetch draws the card
    res.writeHead(302, { Location: `${origin}/og-coinnibal.png`, ...(cache ? { 'Cache-Control': 'public, max-age=300' } : {}) });
    res.end();
    return true;
  }
}

/** The share page: the Open Graph and Twitter card tags (X shows the card), then on to the landing's card stand. */
export function appetizerPage(card: AppetizerCard, origin: string): string {
  // in step with the post the sheet writes (`ld.ap.postText`): "The Appetizer is out", a seat before the coinnibals
  const title = `The Appetizer is out · Early card No. ${appetizerNo(card.no)} · @${card.handle}`;
  const desc = `Grabbed my seat before the coinnibals showed up. A ${BRAND_NAME} early card for early fans.`;
  const page = `${origin}${appetizerPath(card.code)}`;
  // the date in the URL: a redated card (`refresh`) is a new picture to X, which keeps images by URL
  const img = `${page}.png?v=${card.at}`;
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
<img src="${esc(appetizerPath(card.code))}.png?v=${card.at}" width="${APPETIZER_IMAGE.width}" height="${APPETIZER_IMAGE.height}" alt="${esc(title)}">
<a href="${esc(landing)}">Get your own early card</a>
</body>
</html>
`;
}
