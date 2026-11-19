import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FEEDBACK_LIMITS, FEEDBACK_VIEWPORT_RE, isFeedbackRoom, type FeedbackEntry, type FeedbackList, type FeedbackRoom } from '@coinnibal/shared';
import { SiteFail, bad, cleanText, obj, text } from './validate';

/** A message id: 12 URL-safe characters (the admin's read / delete paths). */
const ID_RE = /^[A-Za-z0-9_-]{12}$/;

/** The validated fields of `POST /api/feedback` (the wallet and the time are the server's). */
export interface FeedbackInput {
  text: string;
  contact: string;
  page: string;
  room: FeedbackRoom | null;
  viewport: string;
  build: string;
}

/**
 * Validates a `POST /api/feedback` body. The message is required; the context fields are the sheet's own and are
 * checked strictly (a path, a known room kind, `<w>x<h>`, a short build name), so nothing else rides along with them.
 */
export function parseFeedback(raw: unknown): FeedbackInput {
  const body = obj(raw);
  const page = text(body.page, 'page', FEEDBACK_LIMITS.page);
  if (page && !page.startsWith('/')) throw bad('page', 'page must be a path (/…)');
  const room = body.room === undefined || body.room === null || body.room === '' ? null : body.room;
  if (room !== null && !isFeedbackRoom(room)) throw bad('room', 'room is not a known room kind');
  const viewport = text(body.viewport, 'viewport', 11);
  if (viewport && !FEEDBACK_VIEWPORT_RE.test(viewport)) throw bad('viewport', 'viewport must be <width>x<height>');
  const build = text(body.build, 'build', FEEDBACK_LIMITS.build);
  if (build && !/^[\w.+-]+$/.test(build)) throw bad('build', 'build must be a short version name');
  return {
    text: text(body.text, 'text', FEEDBACK_LIMITS.text, { min: 1, multiline: true }),
    contact: text(body.contact, 'contact', FEEDBACK_LIMITS.contact),
    page,
    room,
    viewport,
    build,
  };
}

/** A stored line, read back: a whole entry or nothing (a torn or edited line is dropped). */
function entryOf(v: unknown): FeedbackEntry | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id) || typeof e.at !== 'number' || typeof e.text !== 'string' || !e.text) return null;
  const str = (x: unknown, max: number) => (typeof x === 'string' ? cleanText(x, max === FEEDBACK_LIMITS.text).slice(0, max) : '');
  return {
    id: e.id,
    at: e.at,
    text: str(e.text, FEEDBACK_LIMITS.text),
    contact: str(e.contact, FEEDBACK_LIMITS.contact),
    wallet: typeof e.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(e.wallet) ? e.wallet : null,
    page: str(e.page, FEEDBACK_LIMITS.page),
    room: isFeedbackRoom(e.room) ? e.room : null,
    viewport: typeof e.viewport === 'string' && FEEDBACK_VIEWPORT_RE.test(e.viewport) ? e.viewport : '',
    build: str(e.build, FEEDBACK_LIMITS.build),
    read: e.read === true,
  };
}

/**
 * Player feedback (`DATA_DIR/site/feedback.jsonl`, one JSON entry a line; not per chain): the newest
 * `FEEDBACK_LIMITS.kept` messages. A new message is appended; the file is rewritten (atomically) when the admin marks
 * or deletes one, and when the appends ran past the cap. The text is plain text: stored as sent (control characters
 * removed), escaped by JSON, never turned into HTML. A write that fails is logged, never a refused message (the entry
 * stays in memory).
 */
export class FeedbackStore {
  /** Oldest first. */
  private entries: FeedbackEntry[] = [];
  /** Lines in the file now (the appends since the last rewrite included). */
  private lines = 0;
  private readonly kept: number;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(
    private readonly path: string | null,
    opts: { kept?: number; now?: () => number; log?: (m: string) => void } = {},
  ) {
    this.kept = opts.kept ?? FEEDBACK_LIMITS.kept;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      const seen = new Set<string>();
      const out: FeedbackEntry[] = [];
      for (const line of raw) {
        let e: FeedbackEntry | null = null;
        try {
          e = entryOf(JSON.parse(line));
        } catch {
          /* a torn last line */
        }
        if (!e || seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
      this.entries = out.slice(-this.kept);
      this.lines = raw.length;
      if (this.lines !== this.entries.length) this.rewrite();
    } catch (err) {
      this.log(`!!! feedback: could not read ${this.path} (${(err as Error).message}); starting empty`);
    }
  }

  /** Writes every kept entry (tmp file, then rename). */
  private rewrite(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, this.entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
      renameSync(tmp, this.path);
      this.lines = this.entries.length;
    } catch (err) {
      this.log(`!!! feedback: could not write ${this.path} (${(err as Error).message})`);
    }
  }

  /** Stores a message from `wallet` (null: a guest); the newest `kept` stay. */
  add(input: FeedbackInput, wallet: string | null): FeedbackEntry {
    let id = randomBytes(9).toString('base64url');
    while (this.entries.some((e) => e.id === id)) id = randomBytes(9).toString('base64url');
    const entry: FeedbackEntry = { id, at: this.now(), ...input, wallet, read: false };
    this.entries.push(entry);
    if (this.entries.length > this.kept) this.entries.splice(0, this.entries.length - this.kept);
    if (!this.path) return entry;
    // past the cap by a twentieth: one rewrite drops the oldest lines (not one rewrite per message)
    if (this.lines + 1 > this.kept + Math.max(20, Math.floor(this.kept / 20))) {
      this.rewrite();
      return entry;
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
      this.lines++;
    } catch (err) {
      this.log(`!!! feedback: could not append to ${this.path} (${(err as Error).message})`);
    }
    return entry;
  }

  /** Newest first: at most `limit` (`unread`: only the unread ones), from `offset`. */
  list(opts: { limit?: number; offset?: number; unread?: boolean } = {}): FeedbackList {
    const limit = Math.min(FEEDBACK_LIMITS.pageMax, Math.max(1, Math.floor(opts.limit ?? 100) || 100));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0) || 0);
    const items: FeedbackEntry[] = [];
    let skipped = 0;
    for (let i = this.entries.length - 1; i >= 0 && items.length < limit; i--) {
      const e = this.entries[i];
      if (opts.unread && e.read) continue;
      if (skipped++ < offset) continue;
      items.push({ ...e });
    }
    return { items, total: this.entries.length, unread: this.unread() };
  }

  unread(): number {
    let n = 0;
    for (const e of this.entries) if (!e.read) n++;
    return n;
  }

  private find(id: string): FeedbackEntry {
    const e = ID_RE.test(id) ? this.entries.find((x) => x.id === id) : undefined;
    if (!e) throw new SiteFail(404, 'not_found', 'No such message');
    return e;
  }

  /** Marks one message read or unread. */
  setRead(id: string, read: boolean): FeedbackEntry {
    const e = this.find(id);
    if (e.read !== read) {
      e.read = read;
      this.rewrite();
    }
    return { ...e };
  }

  /** Marks every message read; how many changed. */
  readAll(): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.read) continue;
      e.read = true;
      n++;
    }
    if (n > 0) this.rewrite();
    return n;
  }

  remove(id: string): void {
    const e = this.find(id);
    this.entries = this.entries.filter((x) => x !== e);
    this.rewrite();
  }
}
