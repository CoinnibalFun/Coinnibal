/**
 * The Appetizer: an early card a visitor claims on the landing page before anything else opens. They give a wallet
 * address and their X handle and get a numbered card (the handle only: the wallet is never shown, drawn or shared) to
 * post on X. It is not the WL: separate store, separate routes, separate admin view.
 *
 * Routes:
 * - `POST /api/appetizer` (`AppetizerRequest`) → `AppetizerResponse`. 403 `closed` while `SiteSettings.appetizerOpen`
 *   is off; 400 `bad_wallet` / `bad_handle`; 409 `handle_taken` (the handle already holds a card for another wallet);
 *   429 when an IP sends too many. The same wallet again returns its card (`existing: true`; the handle stays).
 * - `POST /api/appetizer/<code>/post` (`AppetizerPostRequest`) → `{ ok: true }`: the link of the X post that shared
 *   the card (its author must be the card's handle); 400 `bad_post`.
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

export type AppetizerError = 'closed' | 'bad_wallet' | 'bad_handle' | 'handle_taken' | 'bad_post' | 'not_found' | 'rate_limited';

/** `POST /api/appetizer`. */
export interface AppetizerRequest {
  /** An EVM address (any case). */
  wallet: string;
  /** The X handle, with or without `@` (normalised by `normalizeXHandle`). */
  handle: string;
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

/** One card as the admin reads it. */
export interface AppetizerEntry extends AppetizerCard {
  /** EIP-55. */
  wallet: string;
  /** The X post that shared it (normalised `https://x.com/<handle>/status/<id>`), null until given. */
  post: string | null;
  postedAt: number | null;
  /** How many times the share image was fetched (X fetches it as a post is written). */
  views: number;
}

/** `GET /api/admin/appetizers`. */
export interface AppetizerList {
  items: AppetizerEntry[];
  total: number;
  /** Cards with a post link. */
  posted: number;
}

/** The share page of a card. */
export const appetizerPath = (code: string): string => `/appetizer/${code}`;
