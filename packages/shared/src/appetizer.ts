/**
 * The Appetizer: an early card a visitor claims on the landing page before anything else opens. A short checklist:
 * follow the project's X account (required; there is no X API for it, so the follow is on trust, as the WL's
 * `follow_x` task), like and comment on our X post (`SiteSettings.appetizerPostUrl`; the step is shown only while it
 * is set, also on trust), give a wallet address and their X handle and get a numbered card (the handle only: the
 * wallet is never shown, drawn or shared), then post the card on X and send the post's link (required: a card counts
 * once its post link is in; the server reads the post from X's public embed endpoints). It is not the WL: separate
 * store, separate routes, separate admin view.
 *
 * Routes:
 * - `POST /api/appetizer` (`AppetizerRequest`) → `AppetizerResponse`. 403 `closed` while `SiteSettings.appetizerOpen`
 *   is off; 400 `follow_required` (no `followed: true`) / `bad_wallet` / `bad_handle`; 409 `handle_taken` (the handle already holds a card for another wallet);
 *   429 when an IP sends too many. The same wallet with the same handle returns its card
 *   (`existing: true`); with another handle, 409 `wallet_taken` (a wallet alone never reveals its handle).
 * - `POST /api/appetizer/<code>/post` (`AppetizerPostRequest`) → `AppetizerPostResponse`: the link of the X post that
 *   shared the card. 400 `bad_post` (not a post link, or its author is not the card's handle); 422 `post_unverified`
 *   (X has no public post there, or the post does not carry the card's link `/appetizer/<code>`). When X cannot be
 *   reached, or only answers without expanded links, the link is kept anyway with `verified: false` (the visitor is
 *   not blocked; the admin checks those by hand), except over a card's verified post: that one is never replaced by a
 *   link X cannot check (503 `x_unreachable`, the verified post kept).
 * - `GET /api/appetizer/post` → `AppetizerOurPostResponse`: our X post (`SiteSettings.appetizerPostUrl`, never any
 *   other) as X's public embed endpoint shows it, for the sheet's post box; `post: null` while no post is set or X
 *   cannot show it (the box then links to X only). Read from X at most every few minutes (cached).
 * - `GET /appetizer/<code>`: the share page (Open Graph / Twitter `summary_large_image` tags, the card as its image)
 *   that sends a person on to the landing page; `GET /appetizer/<code>.png`: the card, `APPETIZER_IMAGE` px.
 * - Admin (session): `GET /api/admin/appetizers?offset&limit` → `AppetizerList` (newest first);
 *   `GET /api/admin/appetizers.csv`; `DELETE /api/admin/appetizers/<code>`.
 */

export const APPETIZER_LIMITS = {
  /** The JSON body of `POST /api/appetizer` and of the post link (bytes). */
  bodyBytes: 2 * 1024,
  /** A post link (characters). */
  postUrl: 300,
  /** Cards kept on the server. */
  kept: 100_000,
  /** Cards per page of the admin list (at most). */
  pageMax: 1000,
  /** Cards one IP may claim per hour. */
  perIpHour: 10,
} as const;

/** The card image: 1200 × 675 (X shows 16:9 images whole). */
export const APPETIZER_IMAGE = { width: 1200, height: 675 } as const;

/** A card's code: its share link (`/appetizer/<code>`). */
export const APPETIZER_CODE_RE = /^[A-Za-z0-9]{10}$/;

export type AppetizerError = 'closed' | 'follow_required' | 'post_unverified' | 'x_unreachable' | 'bad_wallet' | 'bad_handle' | 'handle_taken' | 'wallet_taken' | 'bad_post' | 'not_found' | 'rate_limited';

/** `POST /api/appetizer`. */
export interface AppetizerRequest {
  /** An EVM address (any case). */
  wallet: string;
  /** The X handle, with or without `@` (normalised by `normalizeXHandle`). */
  handle: string;
  /** The visitor says they follow the project's X account (they opened the follow intent): required. */
  followed: true;
  /**
   * The visitor opened our X post to like and comment on it: sent when that step was shown (the server does not
   * require it: the admin may set the post while a visitor's sheet is open).
   */
  liked?: boolean;
}

/** A card as anyone may see it: never the wallet. */
export interface AppetizerCard {
  code: string;
  /** The card number, 1, 2, 3 … in the order they were claimed. */
  no: number;
  /** The X handle, without `@`, as typed (case kept). */
  handle: string;
  /** Unix ms, when it was claimed. */
  at: number;
}

export interface AppetizerResponse {
  card: AppetizerCard;
  /** This wallet already held this card. */
  existing: boolean;
}

/** `POST /api/appetizer/<code>/post`. */
export interface AppetizerPostRequest {
  /** `https://x.com/<handle>/status/<id>` (twitter.com too). */
  url: string;
}

export interface AppetizerPostResponse {
  ok: true;
  /** X showed the post, by the card's handle, carrying the card's link; false: kept unchecked (X did not answer). */
  verified: boolean;
}

/** Our X post as the sheet's box shows it (`GET /api/appetizer/post`). */
export interface AppetizerOurPost {
  /** The post's link (`appetizerPostUrl`, normalised). */
  url: string;
  /** The author's handle, without `@`. */
  handle: string;
  /** The author's display name. */
  name: string;
  /** The author's picture (`https://pbs.twimg.com/…`), or null. */
  avatar: string | null;
  /** The text as X shows it: links as X displays them, the picture's own link dropped. */
  text: string;
  /** The post's first picture (`https://pbs.twimg.com/…`), or null. */
  photo: { url: string; width: number; height: number } | null;
  /** Unix ms, when it was posted (null when X did not say). */
  at: number | null;
}

export interface AppetizerOurPostResponse {
  post: AppetizerOurPost | null;
}

/** One card as the admin reads it. */
export interface AppetizerEntry extends AppetizerCard {
  /** EIP-55. */
  wallet: string;
  /** The X post that shared it (normalised `https://x.com/<handle>/status/<id>`), null until given. */
  post: string | null;
  postedAt: number | null;
  /** Unix ms, when the visitor said they liked and commented on our X post (the claim); null when not asked. */
  likedAt: number | null;
  /** Whether X showed the post carrying the card's link (false while there is no post, or it was kept unchecked). */
  postVerified: boolean;
  /** Unix ms, when the visitor said they follow the project's X account (the claim); null on cards from before that was asked. */
  followedAt: number | null;
  /** How many times the share image was fetched (X fetches it as a post is written). */
  views: number;
}

/** `GET /api/admin/appetizers`. */
export interface AppetizerList {
  items: AppetizerEntry[];
  total: number;
  /** Cards with a post link (complete). */
  posted: number;
  /** Cards whose post X showed carrying the card's link. */
  verified: number;
}

/** The share page of a card. */
export const appetizerPath = (code: string): string => `/appetizer/${code}`;
