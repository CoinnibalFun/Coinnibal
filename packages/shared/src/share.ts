/**
 * "Share on X": the server keeps a small public card of a result (an arena bell, a custom room's end) or a notable
 * kill, made from its own records only (nothing a client sends), and serves it at `/share/<id>` (a page with the
 * Open Graph and Twitter card tags) and `/share/<id>.png` (the 1200 x 630 card image). The web opens X's web intent
 * (`shareIntentUrl`) with a localized line and that link: no X API, no account linking. A card holds only what the
 * game shows anyway: the public name, the wallet's short form, the coin's paint, flag and emblem badge, the numbers.
 */

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
  /** An Elymum emblem holder. */
  holder: boolean;
  /** The room's name (an arena's, a custom room's, a pond's). */
  room: string;
  /** Results: place and players at the end. */
  rank?: number;
  players?: number;
  /** Mass at the end (results) or after the kill. */
  mass: number;
  kills: number;
  /** Arena results: what reached the wallet, formatted ("1,234.5 $ELYMUM"); absent elsewhere and when nothing was paid. */
  paid?: string;
  /** Kills: the coin eaten and its mass. */
  victim?: string;
  victimMass?: number;
}

/** Share ids: 10 characters of [A-Za-z0-9]. */
export const SHARE_ID_RE = /^[A-Za-z0-9]{10}$/;

/** Eating a person whose coin reached this mass in its game offers "Share on X" (a notable kill). */
export const NOTABLE_KILL_MASS = 1000;

/** The card image's size (X's summary_large_image, 1.91:1). */
export const SHARE_IMAGE = { width: 1200, height: 630 } as const;

/** X's web intent with the text and the share link (opens the composer; nothing is posted without the player). */
export function shareIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}
