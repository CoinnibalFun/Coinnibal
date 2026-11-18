/**
 * "Share on X": the server keeps a small public card of a result (an arena bell, a custom room's end) or of a kill
 * (every person eaten; a practice bot only in a testnet test arena), made from its own records only (nothing a client sends), and serves it at `/share/<id>` (a page with the
 * Open Graph and Twitter card tags) and `/share/<id>.png` (the 1200 x 630 card image). The web opens X's web intent
 * (`shareIntentUrl`) with a localized line and that link: no X API. A card holds only what the game shows anyway: the
 * public name, the wallet's short form, the coin's paint, flag and emblem badge, the numbers, and the public names of
 * the coins eaten that game (`shareName`: never a wallet address). A coin eaten whose owner linked an X account
 * ("Link X", `xlink.ts`: linking is consent to be tagged) is named by its `@handle`, which only the server sets.
 */
import { sanitizeName } from './text';
import { xMention } from './xlink';

export type ShareKind = 'round' | 'room' | 'kill';

/** A share card as the server keeps it (`DATA_DIR/site/shares.json`); the page and the image show it. */
export interface ShareCard {
  id: string;
  kind: ShareKind;
  /** Unix ms. */
  at: number;
  /** Public player name. */
  name: string;
  /** The wallet's short form (`shortAddress`: `0x1234…abcd`), or null for a guest. */
  wallet: string | null;
  /** The coin's basic paint (`lookForBasicSkin`). */
  skin: number;
  /** ISO country code of the flag the player played for, or null. */
  country: string | null;
  /** A Coinnibal emblem holder. */
  holder: boolean;
  /** The room's name (an arena's, a custom room's, a pond's). */
  room: string;
  /** Results: place and players at the end. */
  rank?: number;
  players?: number;
  /** Mass at the end (results) or after the kill. */
  mass: number;
  kills: number;
  /** Arena results: what reached the wallet, formatted ("1,234.5 tokens"); absent elsewhere and when nothing was paid. */
  paid?: string;
  /** Kills: the coin eaten and its mass. */
  victim?: string;
  victimMass?: number;
  /** Kills: the coin eaten was a practice bot (test arenas only). */
  victimBot?: boolean;
  /** Kills: the X handle the eaten coin's owner linked (`isXHandle`, set by the server only): the post tags it. */
  victimX?: string;
  /** Results: the coins eaten this game (the first `EATEN_SHOWN`) and how many more. */
  eaten?: EatenName[];
  eatenMore?: number;
  /** A testnet test arena: the card says TEST everywhere and never shows a payout. */
  test?: boolean;
  /**
   * Results: the room's final standings (the top `SHARE_BOARD_ROWS`, plus my own row when it is below them), drawn as
   * the second picture (`/share/<id>/standings.png`). Names cleaned (`shareName`).
   */
  board?: ShareBoardRow[];
}

/** One row of a result card's final standings (`ShareCard.board`). */
export interface ShareBoardRow {
  rank: number;
  name: string;
  mass: number;
  kills: number;
  /** Arena rooms (never a test arena): the value at the bell, formatted ("1,234.5 tokens"). */
  value?: string;
  /** A practice bot (test arenas, free custom rooms). */
  bot?: boolean;
  /** The card's own player. */
  you?: boolean;
}

/** Rows a result card's standings picture shows (my own row is added when it is below them). */
export const SHARE_BOARD_ROWS = 10;

/** A coin eaten this game, as a result shows it: its public name (`shareName`), BOT for a practice bot, and times eaten. */
export interface EatenName {
  name: string;
  /** A practice bot (counted in testnet test arenas only). */
  bot?: boolean;
  /** Times eaten this game (absent: once). */
  n?: number;
  /** The X handle its owner linked (`isXHandle`, set by the server only): named `@handle`. Never for a bot. */
  xHandle?: string;
}

/** Names a result shows of the coins eaten; the rest are "+N". */
export const EATEN_SHOWN = 5;

// a run of hex long enough to be (part of) an address or a hash
const HEXISH = /(?:0x)?[0-9a-f]{10,}/gi;

/**
 * A player name made safe for a share card and an X post: the usual name cleaning (invisible characters, 16 characters
 * at most), no address-like hex, no @mention / #hashtag / $cashtag, and no link (dots become middle dots).
 */
export function shareName(raw: unknown): string {
  const s = sanitizeName(raw, '')
    .replace(HEXISH, '0x…')
    .replace(/[@#$\uFF20\uFF03\uFF04]/g, '')
    .replace(/[:/\\]+/g, ' ')
    .replace(/[.\u3002\uFF0E]/g, '\u00B7')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 0 ? s : '???';
}

/** How a coin eaten is named in a post: its linked `@handle` (people only), else its cleaned public name. */
export function eatenLabel(e: { name: string; bot?: boolean; xHandle?: string }): string {
  return (!e.bot && xMention(e.xHandle)) || shareName(e.name);
}

/** "Penny, @rocky ×2, Zed (BOT) +3": the eaten coins on one line (`botTag`: the translated BOT tag). */
export function eatenLine(list: readonly EatenName[], more = 0, botTag = 'BOT'): string {
  const names = list.map((e) => `${eatenLabel(e)}${e.bot ? ` (${botTag})` : ''}${e.n && e.n > 1 ? ` \u00D7${e.n}` : ''}`).join(', ');
  const rest = more > 0 ? `+${more}` : '';
  return names && rest ? `${names} ${rest}` : names || rest;
}

/** Share ids: 10 characters of [A-Za-z0-9]. */
export const SHARE_ID_RE = /^[A-Za-z0-9]{10}$/;

/** The card image's size (X's summary_large_image, 1.91:1). */
export const SHARE_IMAGE = { width: 1200, height: 630 } as const;

/** The card's picture (`/share/<id>.png`) and a result's standings picture (`/share/<id>/standings.png`). */
export const shareImagePath = (id: string): string => `/share/${id}.png`;
export const shareStandingsPath = (id: string): string => `/share/${id}/standings.png`;

/** X's web intent with the text and the share link (opens the composer; nothing is posted without the player). */
export function shareIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}
