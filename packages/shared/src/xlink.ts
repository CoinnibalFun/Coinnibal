import { SITE_HOST_DEFAULT } from './brand';

/**
 * "Link X": a signed-in wallet ties its X (Twitter) account to its coin without any X API key. The server issues a
 * short-lived code (`X_CODE_RE`), the player posts it from their X account (X's web intent, `xLinkIntentUrl`) and
 * pastes the post's link; the server reads that post from X's public embed endpoints and takes the handle, the user
 * id, the display name and the picture from X's answer (never from what the player typed). Linking is consent to be
 * tagged: whoever eats a linked coin may tag `@handle` in their "Share on X" post. Bots never have a handle.
 */

/** An X handle exactly as X allows it: 1 to 15 letters, digits or underscores (no `@`). */
export const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** Whether `v` is a valid X handle (without the `@`). */
export function isXHandle(v: unknown): v is string {
  return typeof v === 'string' && X_HANDLE_RE.test(v);
}

/** X user ids and post ids: decimal snowflakes (at most 20 digits). */
export const X_ID_RE = /^[1-9][0-9]{0,19}$/;

export function isXId(v: unknown): v is string {
  return typeof v === 'string' && X_ID_RE.test(v);
}

/** `@handle` for a valid handle, else null (every place that tags someone goes through here). */
export function xMention(handle: unknown): string | null {
  return isXHandle(handle) ? `@${handle}` : null;
}

/** The prefix of a new link code. */
export const X_CODE_PREFIX = 'COIN';
/**
 * Prefixes a post may carry a code with: the current one, and the earlier ones (`NIBAL-`, `ELYMUM-`, for a code
 * shown by a page that was open across a deploy; a code lives `X_CODE_TTL_MS`).
 */
export const X_CODE_PREFIXES: readonly string[] = [X_CODE_PREFIX, 'NIBAL', 'ELYMUM'];
/** Link codes: `COIN-` (or the older `NIBAL-` / `ELYMUM-`) and six characters of `X_CODE_CHARS` (no 0/O, 1/I/L look-alikes). */
export const X_CODE_RE = /^(?:COIN|NIBAL|ELYMUM)-[2-9A-HJKMNP-Z]{6}$/;
export const X_CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A code is valid this long after it was issued (ms). */
export const X_CODE_TTL_MS = 30 * 60_000;

/** The X post that proves the account: short and friendly, with the code (the proof) and the site. */
export function xLinkPostText(code: string, site = SITE_HOST_DEFAULT): string {
  return `Joining the coin party \u{1FA99} my code: ${code} ${site}`;
}

/** X's web intent with the proof post written out (nothing is posted unless the player posts it). */
export function xLinkIntentUrl(code: string, site?: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(xLinkPostText(code, site))}`;
}

/**
 * The post id of a pasted link: `x.com` / `twitter.com` (and their `www.` / `mobile.` hosts) `/<handle>/status/<id>`
 * (also `/i/web/status/<id>`), query and fragment ignored; a bare id is taken too. Null for anything else.
 */
export function parseXPostId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 300) return null;
  if (X_ID_RE.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i.test(u.hostname)) return null;
  const m = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web|i)\/status(?:es)?\/([0-9]{1,20})\/?(?:photo\/\d+\/?)?$/.exec(u.pathname);
  return m && X_ID_RE.test(m[1]) ? m[1] : null;
}

/** When X made a post (Unix ms), read from its snowflake id; null for ids from before snowflakes. */
export function xPostTime(id: string): number | null {
  if (!X_ID_RE.test(id)) return null;
  const ms = Number(BigInt(id) >> 22n) + 1288834974657;
  return ms > 1288834974657 ? ms : null;
}

/** The token X's own embed script sends with `cdn.syndication.twimg.com/tweet-result` (derived from the id). */
export function xSyndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** Where the server serves a linked account's picture (fetched from X once, cached). */
export function xAvatarPath(userId: string): string {
  return `/api/x/avatar/${userId}`;
}

/** A wallet's linked X account, as `GET /api/x` and the profile show it. */
export interface XLinkView {
  /** Without the `@` (`isXHandle`). */
  handle: string;
  /** X's display name (cleaned, may be empty). */
  name: string;
  /** X's user id; null when X's answer did not carry one (the embed fallback). */
  userId: string | null;
  /** The account's picture is served at `xAvatarPath(userId)`. */
  avatar: boolean;
  /** Unix ms. */
  linkedAt: number;
}

/** `POST /api/x/code`: the code to post, the post's text, X's intent link and when the code expires. */
export interface XCodeView {
  code: string;
  text: string;
  intentUrl: string;
  /** Unix ms. */
  expiresAt: number;
}

/** `GET /api/x`: the link and the pending code (if any). */
export interface XStatusView {
  link: XLinkView | null;
  code: XCodeView | null;
}

/**
 * Why a link attempt failed (`{ error, message }`): `x_bad_url` not a post link; `x_no_code` no active code (ask for
 * one); `x_not_found` X has no such public post; `x_code_mismatch` the post does not carry this wallet's code;
 * `x_post_old` the post is older than the code; `x_unreachable` X's endpoints did not answer (try again later).
 */
export type XLinkError = 'x_bad_url' | 'x_no_code' | 'x_not_found' | 'x_code_mismatch' | 'x_post_old' | 'x_unreachable';
