import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  SITE_URL_DEFAULT,
  X_CODE_CHARS,
  X_CODE_PREFIX,
  X_CODE_PREFIXES,
  X_CODE_TTL_MS,
  isXHandle,
  isXId,
  parseXPostId,
  xLinkIntentUrl,
  xLinkPostText,
  xPostTime,
  xSyndicationToken,
  type XCodeView,
  type XLinkError,
  type XLinkView,
  type XStatusView,
} from '@coinnibal/shared';
import { getAddress } from 'viem';
import { encodePng } from './avatars';
import { Limiter } from './net/limiter';

/**
 * "Link X" without the X API (`packages/shared/src/xlink.ts`): link codes, the proof check against X's public embed
 * endpoints, the links (`DATA_DIR/x-links.json`) and the cached account pictures (`DATA_DIR/x-avatars/`).
 *
 * The proof: the signed-in wallet asks for a code (one at a time, `X_CODE_TTL_MS`), posts it from its X account and
 * sends the post's link. The server reads that post from `cdn.syndication.twimg.com/tweet-result` (what X's own embed
 * script reads; no key), falling back to `publish.twitter.com/oembed`. It links when the post's text carries the
 * wallet's active code and the post was made after the code was issued (the post id is a snowflake: its time is read
 * from the id itself). The handle, the user id, the name and the picture come from X's answer, never from the link
 * the player typed. One X account belongs to one wallet: a newer proof moves it (the old wallet is unlinked).
 *
 * X being down never blocks a game: joins read the links from memory only; a failed check answers `x_unreachable`.
 */

/** What the server keeps of a link. */
export interface XLinkRecord {
  /** EIP-55. */
  wallet: string;
  /** X's user id; null when only the embed fallback answered (it carries no id). */
  userId: string | null;
  handle: string;
  name: string;
  /** X's picture of the account (`https://pbs.twimg.com/...`, the 400 x 400 variant), or null. */
  avatarUrl: string | null;
  linkedAt: number;
}

interface LinksFile {
  version: 1;
  links: XLinkRecord[];
}

/** A refused X request: HTTP status, error code (`XLinkError`, `rate_limited`, ...) and message. */
export class XLinkFail extends Error {
  constructor(
    readonly status: number,
    readonly code: XLinkError | 'rate_limited' | 'x_picture_unavailable' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

/** The `fetch` the service uses (tests and the dev stack pass their own). */
export type XFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'error' | 'follow' },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** What a post looked like to X's endpoints. */
export interface XPost {
  id: string;
  text: string;
  handle: string;
  userId: string | null;
  name: string;
  avatarUrl: string | null;
  /** Unix ms from the answer (`created_at`), when it carried one. */
  createdAt: number | null;
}

/** Biggest account picture taken (bytes) and the types taken. */
export const X_AVATAR_MAX_BYTES = 200 * 1024;
const X_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type XAvatarType = (typeof X_AVATAR_TYPES)[number];
const EXT: Record<XAvatarType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TYPE_OF_EXT: Record<string, XAvatarType> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** A post may be this much older than its code (clocks differ a little). */
const CLOCK_SKEW_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 256 * 1024;
const UA = `Mozilla/5.0 (compatible; CoinnibalLinkCheck/1.0; +${SITE_URL_DEFAULT})`;

/** The picture URL to fetch: X's own host, https, the 400 x 400 variant of `_normal` / `_bigger` / `_mini`. */
export function xAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'pbs.twimg.com' || u.port || u.username || u.password) return null;
  if (!/^\/profile_images\/[0-9]+\/[A-Za-z0-9_.-]+$/.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/_(?:normal|bigger|mini)(\.[A-Za-z]+)$/, '_400x400$1');
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** X's display name, cleaned: no control or invisible characters, at most 50 characters. */
export function cleanXName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, 50).join('');
}

/** The image type of `bytes` from its first bytes (JPEG, PNG, WebP), or null. */
export function sniffImage(bytes: Uint8Array): XAvatarType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–' };

/** The words of a post in oEmbed's HTML (`<blockquote><p>…</p>`): tags dropped, entities decoded. */
export function oembedText(html: string): string {
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  return (m ? m[1] : '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
}

/**
 * Whether the post's words carry `code` as a word of its own (any case). The code's six characters count under any of
 * `X_CODE_PREFIXES` (`COIN-7F3K9Q`, `NIBAL-7F3K9Q` and `ELYMUM-7F3K9Q` are the same code).
 */
export function carriesCode(text: string, code: string): boolean {
  const dash = code.indexOf('-');
  if (dash <= 0 || !/^[A-Za-z0-9-]+$/.test(code)) return false;
  const prefix = code.slice(0, dash);
  const tail = code.slice(dash + 1);
  const prefixes = X_CODE_PREFIXES.includes(prefix.toUpperCase()) ? X_CODE_PREFIXES : [prefix];
  return new RegExp(`(?:^|[^A-Za-z0-9])(?:${prefixes.join('|')})\\-${tail}(?![A-Za-z0-9])`, 'i').test(text);
}

/* ------------------------------------------------------------------ */
/* The links                                                           */
/* ------------------------------------------------------------------ */

/**
 * The links, kept in memory and written at once on every change (write to a temp file, then rename: links change
 * rarely). One X account (its user id, else its handle) and one handle belong to one wallet.
 */
export class XLinkStore {
  private readonly byWallet = new Map<string, XLinkRecord>();

  constructor(
    private readonly path: string | null,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as LinksFile;
      if (!data || data.version !== 1 || !Array.isArray(data.links)) throw new Error('bad shape');
      for (const r of data.links) {
        if (typeof r?.wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.wallet) || !isXHandle(r.handle)) continue;
        const rec: XLinkRecord = {
          wallet: getAddress(r.wallet),
          userId: isXId(r.userId) ? r.userId : null,
          handle: r.handle,
          name: cleanXName(r.name),
          avatarUrl: xAvatarUrl(r.avatarUrl),
          linkedAt: typeof r.linkedAt === 'number' ? r.linkedAt : 0,
        };
        this.drop(rec);
        this.byWallet.set(rec.wallet.toLowerCase(), rec);
      }
    } catch (err) {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      this.log(`x-links: ${this.path} is unreadable (${(err as Error).message}); moved to ${backup}`);
      try {
        renameSync(this.path, backup);
      } catch {
        /* ignore */
      }
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const data: LinksFile = { version: 1, links: [...this.byWallet.values()] };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
  }

  get size(): number {
    return this.byWallet.size;
  }

  get(wallet: string | null | undefined): XLinkRecord | null {
    const r = wallet ? this.byWallet.get(wallet.toLowerCase()) : undefined;
    return r ? { ...r } : null;
  }

  /** The wallet's linked handle, or null (joins read this: memory only). */
  handle(wallet: string | null | undefined): string | null {
    return (wallet && this.byWallet.get(wallet.toLowerCase())?.handle) || null;
  }

  /** Some wallet has this handle linked right now (a kill post tags only a handle still linked). */
  linkedHandle(handle: unknown): boolean {
    if (!isXHandle(handle)) return false;
    const h = handle.toLowerCase();
    for (const r of this.byWallet.values()) if (r.handle.toLowerCase() === h) return true;
    return false;
  }

  /** The link of an X user id (the picture route). */
  byUserId(userId: string): XLinkRecord | null {
    for (const r of this.byWallet.values()) if (r.userId === userId) return { ...r };
    return null;
  }

  /** Removes the links of the same X account or handle as `rec` (other wallets'); returns them. */
  private drop(rec: Pick<XLinkRecord, 'wallet' | 'userId' | 'handle'>): XLinkRecord[] {
    const h = rec.handle.toLowerCase();
    const gone: XLinkRecord[] = [];
    for (const [k, r] of this.byWallet) {
      if (k === rec.wallet.toLowerCase()) continue;
      if ((rec.userId && r.userId === rec.userId) || r.handle.toLowerCase() === h) {
        this.byWallet.delete(k);
        gone.push(r);
      }
    }
    return gone;
  }

  /** Links (or re-links) the wallet; returns the links of other wallets it replaced (the newest proof wins). */
  link(rec: XLinkRecord): XLinkRecord[] {
    if (!isXHandle(rec.handle)) throw new Error('bad handle');
    const wallet = getAddress(rec.wallet);
    const clean: XLinkRecord = { ...rec, wallet, userId: isXId(rec.userId) ? rec.userId : null, name: cleanXName(rec.name), avatarUrl: xAvatarUrl(rec.avatarUrl) };
    const moved = this.drop(clean);
    this.byWallet.set(wallet.toLowerCase(), clean);
    this.save();
    return moved;
  }

  /** Unlinks the wallet; returns what it had (null when nothing). */
  unlink(wallet: string): XLinkRecord | null {
    const k = wallet.toLowerCase();
    const r = this.byWallet.get(k);
    if (!r) return null;
    this.byWallet.delete(k);
    this.save();
    return r;
  }
}

/* ------------------------------------------------------------------ */
/* The cached account pictures                                         */
/* ------------------------------------------------------------------ */

/** Account pictures by X user id (`<id>.jpg|png|webp`, written to a temp file and renamed). `dir` null: memory only. */
export class XAvatarCache {
  private readonly types = new Map<string, XAvatarType>();
  private readonly memory = new Map<string, Buffer>();

  constructor(private readonly dir: string | null) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      const m = /^([0-9]{1,20})\.(jpg|png|webp)$/.exec(f);
      if (m) this.types.set(m[1], TYPE_OF_EXT[m[2]]);
    }
  }

  get(userId: string): { bytes: Buffer; type: XAvatarType } | null {
    const type = isXId(userId) ? this.types.get(userId) : undefined;
    if (!type) return null;
    if (!this.dir) {
      const b = this.memory.get(userId);
      return b ? { bytes: b, type } : null;
    }
    try {
      return { bytes: readFileSync(join(this.dir, `${userId}.${EXT[type]}`)), type };
    } catch {
      this.types.delete(userId);
      return null;
    }
  }

  put(userId: string, bytes: Buffer, type: XAvatarType): void {
    if (!isXId(userId)) return;
    this.delete(userId);
    if (this.dir) {
      const file = join(this.dir, `${userId}.${EXT[type]}`);
      writeFileSync(`${file}.tmp`, bytes);
      renameSync(`${file}.tmp`, file);
    } else this.memory.set(userId, Buffer.from(bytes));
    this.types.set(userId, type);
  }

  delete(userId: string): void {
    const type = this.types.get(userId);
    if (!type) return;
    this.types.delete(userId);
    this.memory.delete(userId);
    if (!this.dir) return;
    try {
      unlinkSync(join(this.dir, `${userId}.${EXT[type]}`));
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

interface PendingCode {
  code: string;
  issuedAt: number;
  expiresAt: number;
}

export interface XLinkDeps {
  /** `DATA_DIR` (null: memory only). */
  dataDir: string | null;
  /** The dev fake chain keeps its own files. */
  suffix?: string;
  fetch?: XFetch;
  now?: () => number;
  log?: (m: string) => void;
  /** Endpoint overrides (tests and the dev stack). */
  syndicationUrl?: string;
  oembedUrl?: string;
}

type Read = { ok: true; post: XPost } | { ok: false; why: 'not_found' | 'down' };

export class XLinkService {
  readonly links: XLinkStore;
  readonly avatars: XAvatarCache;
  private readonly codes = new Map<string, PendingCode>();
  private readonly now: () => number;
  private readonly fetchFn: XFetch;
  private readonly log: (m: string) => void;
  private readonly codeWallet = new Limiter(6, 60 * 60_000);
  private readonly codeIp = new Limiter(20, 60 * 60_000);
  private readonly verifyWallet = new Limiter(20, 60 * 60_000);
  private readonly verifyIp = new Limiter(40, 60 * 60_000);
  /** Calls to X for the whole server (proof checks and picture fetches). */
  private readonly upstream = new Limiter(120, 60_000);
  private readonly avatarFetches = new Map<string, Promise<boolean>>();

  constructor(private readonly d: XLinkDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => {});
    this.fetchFn = d.fetch ?? (globalThis.fetch as unknown as XFetch);
    const sfx = d.suffix ?? '';
    this.links = new XLinkStore(d.dataDir ? join(d.dataDir, `x-links${sfx}.json`) : null, this.log);
    this.avatars = new XAvatarCache(d.dataDir ? join(d.dataDir, `x-avatars${sfx}`) : null);
  }

  /** The view of a wallet's link. */
  view(wallet: string): XLinkView | null {
    const r = this.links.get(wallet);
    if (!r) return null;
    return { handle: r.handle, name: r.name, userId: r.userId, avatar: !!(r.userId && (r.avatarUrl || this.avatars.get(r.userId))), linkedAt: r.linkedAt };
  }

  private codeView(c: PendingCode, site?: string): XCodeView {
    return { code: c.code, text: xLinkPostText(c.code, site), intentUrl: xLinkIntentUrl(c.code, site), expiresAt: c.expiresAt };
  }

  /** The wallet's pending code, while it is valid. */
  private pending(wallet: string): PendingCode | null {
    const k = wallet.toLowerCase();
    const c = this.codes.get(k);
    if (!c) return null;
    if (this.now() >= c.expiresAt) {
      this.codes.delete(k);
      return null;
    }
    return c;
  }

  /** The newest code issued (the dev stack's fake X posts it). */
  lastCode(): string | null {
    let last: PendingCode | null = null;
    for (const c of this.codes.values()) if (!last || c.issuedAt >= last.issuedAt) last = c;
    return last?.code ?? null;
  }

  /** `GET /api/x`. */
  status(wallet: string, site?: string): XStatusView {
    const c = this.pending(wallet);
    return { link: this.view(wallet), code: c ? this.codeView(c, site) : null };
  }

  /** `POST /api/x/code`: a fresh code (it replaces the wallet's earlier one). */
  issueCode(wallet: string, ip: string, site?: string): XCodeView {
    if (!this.codeIp.allow(ip) || !this.codeWallet.allow(wallet.toLowerCase())) throw new XLinkFail(429, 'rate_limited', 'Too many link codes. Try again in an hour.');
    const now = this.now();
    let code = '';
    for (let i = 0; i < 6; i++) code += X_CODE_CHARS[randomInt(X_CODE_CHARS.length)];
    const c: PendingCode = { code: `${X_CODE_PREFIX}-${code}`, issuedAt: now, expiresAt: now + X_CODE_TTL_MS };
    this.codes.set(wallet.toLowerCase(), c);
    // forget expired codes of other wallets
    if (this.codes.size > 5000) for (const [k, v] of this.codes) if (now >= v.expiresAt) this.codes.delete(k);
    return this.codeView(c, site);
  }

  /**
   * `POST /api/x/verify {url}`: reads the post and links the wallet when the post carries its active code and is
   * newer than it. Returns the link and the wallets the account moved from.
   */
  async verify(wallet: string, ip: string, url: unknown): Promise<{ link: XLinkView; moved: string[] }> {
    const id = parseXPostId(url);
    if (!id) throw new XLinkFail(400, 'x_bad_url', 'Paste the link of your post (x.com/<you>/status/…).');
    const code = this.pending(wallet);
    if (!code) throw new XLinkFail(409, 'x_no_code', 'Your link code expired. Get a new code and post it again.');
    if (!this.verifyIp.allow(ip) || !this.verifyWallet.allow(wallet.toLowerCase())) throw new XLinkFail(429, 'rate_limited', 'Too many checks. Try again in an hour.');
    // the post's own time (its snowflake id) must come after the code
    const at = xPostTime(id);
    if (at === null || at < code.issuedAt - CLOCK_SKEW_MS) throw new XLinkFail(400, 'x_post_old', 'That post is older than your code. Post the new code and paste that link.');
    const read = await this.readPost(id);
    if (!read.ok) {
      if (read.why === 'down') throw new XLinkFail(503, 'x_unreachable', 'X did not answer. Try again in a few minutes.');
      throw new XLinkFail(404, 'x_not_found', 'X has no public post at that link. Is your account public?');
    }
    const post = read.post;
    if (post.createdAt !== null && post.createdAt < code.issuedAt - CLOCK_SKEW_MS) throw new XLinkFail(400, 'x_post_old', 'That post is older than your code. Post the new code and paste that link.');
    if (!carriesCode(post.text, code.code)) throw new XLinkFail(400, 'x_code_mismatch', `That post does not carry your code ${code.code}.`);
    // re-check after the wait: a newer code for this wallet (another tab) wins
    if (this.pending(wallet)?.code !== code.code) throw new XLinkFail(409, 'x_no_code', 'Your link code changed. Post the newest code.');
    this.codes.delete(wallet.toLowerCase());
    const before = this.links.get(wallet);
    if (before?.userId && before.userId !== post.userId) this.avatars.delete(before.userId);
    const replaced = this.links.link({ wallet, userId: post.userId, handle: post.handle, name: post.name, avatarUrl: post.avatarUrl, linkedAt: this.now() });
    // pictures of other accounts that lost their link (a handle taken over after a rename) go too
    for (const r of replaced) if (r.userId && r.userId !== post.userId) this.avatars.delete(r.userId);
    const moved = replaced.map((r) => r.wallet);
    this.log(`x-links: ${getAddress(wallet)} linked @${post.handle}${moved.length ? ` (moved from ${moved.join(', ')})` : ''}`);
    // the picture is fetched now (best effort: the route fetches it later if this fails)
    if (post.userId && post.avatarUrl) {
      if (before?.userId === post.userId) this.avatars.delete(post.userId);
      await this.fetchAvatar(post.userId).catch(() => false);
    }
    return { link: this.view(wallet)!, moved };
  }

  /** `DELETE /api/x`: unlinks; its cached picture goes too. */
  unlink(wallet: string): boolean {
    const r = this.links.unlink(wallet);
    if (r?.userId) this.avatars.delete(r.userId);
    if (r) this.log(`x-links: ${getAddress(wallet)} unlinked @${r.handle}`);
    return !!r;
  }

  /** The picture of a linked account: cached, else fetched once from X (null when there is none). */
  async avatar(userId: string): Promise<{ bytes: Buffer; type: XAvatarType } | null> {
    if (!isXId(userId)) return null;
    const cached = this.avatars.get(userId);
    if (cached) return cached;
    if (!this.links.byUserId(userId)?.avatarUrl) return null;
    return (await this.fetchAvatar(userId)) ? this.avatars.get(userId) : null;
  }

  private fetchAvatar(userId: string): Promise<boolean> {
    let p = this.avatarFetches.get(userId);
    if (!p) {
      p = this.doFetchAvatar(userId).finally(() => this.avatarFetches.delete(userId));
      this.avatarFetches.set(userId, p);
    }
    return p;
  }

  private async doFetchAvatar(userId: string): Promise<boolean> {
    const url = this.links.byUserId(userId)?.avatarUrl;
    if (!url || !this.upstream.allow('all')) return false;
    try {
      const res = await this.get(url, 'image/jpeg,image/png,image/webp', 'error', 'bytes');
      if (!res.ok || !(X_AVATAR_TYPES as readonly string[]).includes(res.type)) return false;
      const bytes = res.body as Buffer;
      if (bytes.length === 0 || sniffImage(bytes) !== res.type) return false;
      const type = res.type as XAvatarType;
      // still the same link after the wait
      if (this.links.byUserId(userId)?.avatarUrl !== url) return false;
      this.avatars.put(userId, bytes, type);
      return true;
    } catch (err) {
      this.log(`x-links: picture of ${userId} not fetched (${(err as Error).message})`);
      return false;
    }
  }

  /** One GET to X with a timeout over the whole exchange (the body read included). */
  private async get(url: string, accept: string, redirect: 'error' | 'follow', as: 'text' | 'bytes'): Promise<{ ok: boolean; status: number; type: string; body: Buffer | string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url, { signal: ctl.signal, headers: { Accept: accept, 'User-Agent': UA }, redirect });
      const type = String(res.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
      if (!res.ok) return { ok: false, status: res.status, type, body: '' };
      const limit = as === 'text' ? MAX_JSON_BYTES : X_AVATAR_MAX_BYTES;
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > limit) throw new Error('answer too large');
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > limit) throw new Error('answer too large');
      return { ok: true, status: res.status, type, body: as === 'text' ? bytes.toString('utf8') : bytes };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The post as X's syndication endpoint shows it, else as its oEmbed endpoint shows it. */
  async readPost(id: string): Promise<Read> {
    if (!this.upstream.allow('all')) return { ok: false, why: 'down' };
    const first = await this.syndication(id);
    if (first.ok) return first;
    const second = await this.oembed(id);
    if (second.ok) return second;
    // either one saying "no such post" is an answer; both silent is "X is down"
    return { ok: false, why: first.why === 'not_found' || second.why === 'not_found' ? 'not_found' : 'down' };
  }

  private async syndication(id: string): Promise<Read> {
    const base = this.d.syndicationUrl ?? 'https://cdn.syndication.twimg.com/tweet-result';
    try {
      const res = await this.get(`${base}?id=${id}&token=${xSyndicationToken(id)}&lang=en`, 'application/json', 'follow', 'text');
      if (res.status === 404) return { ok: false, why: 'not_found' };
      if (!res.ok) return { ok: false, why: 'down' };
      const j = JSON.parse(res.body as string) as Record<string, unknown> | null;
      if (!j || typeof j !== 'object') return { ok: false, why: 'down' };
      if (j.__typename === 'TweetTombstone' || j.__typename === 'TweetUnavailable' || Object.keys(j).length === 0) return { ok: false, why: 'not_found' };
      const user = (j.user ?? null) as Record<string, unknown> | null;
      if (typeof j.text !== 'string' || !user || !isXHandle(user.screen_name)) return { ok: false, why: 'down' };
      if (j.id_str !== undefined && j.id_str !== id) return { ok: false, why: 'not_found' };
      const created = typeof j.created_at === 'string' ? Date.parse(j.created_at) : NaN;
      return {
        ok: true,
        post: {
          id,
          text: j.text,
          handle: user.screen_name,
          userId: isXId(user.id_str) ? user.id_str : null,
          name: cleanXName(user.name),
          avatarUrl: xAvatarUrl(user.profile_image_url_https),
          createdAt: Number.isFinite(created) ? created : null,
        },
      };
    } catch (err) {
      this.log(`x-links: syndication read of ${id} failed (${(err as Error).message})`);
      return { ok: false, why: 'down' };
    }
  }

  private async oembed(id: string): Promise<Read> {
    const base = this.d.oembedUrl ?? 'https://publish.twitter.com/oembed';
    try {
      const res = await this.get(`${base}?url=${encodeURIComponent(`https://twitter.com/i/status/${id}`)}&omit_script=1&dnt=true`, 'application/json', 'follow', 'text');
      if (res.status === 404) return { ok: false, why: 'not_found' };
      if (!res.ok) return { ok: false, why: 'down' };
      const j = JSON.parse(res.body as string) as Record<string, unknown> | null;
      if (!j || typeof j.html !== 'string' || typeof j.author_url !== 'string') return { ok: false, why: 'down' };
      const m = /^https:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/.exec(j.author_url);
      if (!m) return { ok: false, why: 'down' };
      // the quote must be of this very post
      if (!new RegExp(`/status/${id}(?:[?"/]|$)`).test(j.html)) return { ok: false, why: 'not_found' };
      return { ok: true, post: { id, text: oembedText(j.html), handle: m[1], userId: null, name: cleanXName(j.author_name), avatarUrl: null, createdAt: null } };
    } catch (err) {
      this.log(`x-links: oEmbed read of ${id} failed (${(err as Error).message})`);
      return { ok: false, why: 'down' };
    }
  }
}

/**
 * A fake X for the dev stack (`DEV_FAKE_X=1`) and the screenshots: any post id answers as a post of `@elymum_fan`
 * carrying `text()` (the newest code issued), with a picture (`avatar()`). Never used unless asked for.
 */
export function fakeXFetch(opts: { text: () => string; handle?: string; avatar?: () => Buffer | null }): XFetch {
  const handle = opts.handle ?? 'elymum_fan';
  const answer = (bytes: Buffer, type: string, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? type : n.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  return async (url) => {
    if (url.startsWith('https://pbs.twimg.com/')) {
      const png = opts.avatar?.() ?? null;
      return png ? answer(png, 'image/png') : answer(Buffer.alloc(0), 'text/plain', 404);
    }
    const id = /[?&]id=([0-9]+)/.exec(url)?.[1] ?? '0';
    const body = {
      __typename: 'Tweet',
      id_str: id,
      text: opts.text(),
      created_at: new Date().toISOString(),
      user: { id_str: '1700000000000000001', screen_name: handle, name: 'Coinnibal Fan', profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/fan_normal.png' },
    };
    return answer(Buffer.from(JSON.stringify(body)), 'application/json');
  };
}

let fakePicture: Buffer | null = null;

/** The fake X's account picture (dev stack only): a 128 px teal-and-sun disc pattern, drawn once. */
export function devFakeXPicture(): Buffer {
  if (fakePicture) return fakePicture;
  const px = 128;
  const rgba = new Uint8Array(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const i = (y * px + x) * 4;
      const dx = x - 64;
      const dy = y - 52;
      const head = dx * dx + dy * dy < 26 * 26;
      const body = y > 84 && (x - 64) ** 2 / 46 ** 2 + (y - 128) ** 2 / 44 ** 2 < 1;
      const on = head || body;
      rgba[i] = on ? 0xf2 : 0x2d;
      rgba[i + 1] = on ? 0xc1 : 0x73 + ((x + y) & 15);
      rgba[i + 2] = on ? 0x4e : 0x88;
      rgba[i + 3] = 255;
    }
  }
  fakePicture = encodePng(rgba, px, px, 4);
  return fakePicture;
}
