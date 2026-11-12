/**
 * The Coinnibal brand shapes, shared by the SVG motifs (`Wordmark`, `CoinMark`) and the canvas art (the WL pass card).
 * `brand/lib/art.mjs` and `apps/web/public/favicon.svg` repeat these paths (they cannot import TS): change them together.
 */

/**
 * The bitten coin: a circle of radius 46 around (0, 0) with three bites out of its upper right edge (each bite a circle
 * sitting on the rim). One closed path: the long way round the rim, then back along the three bite arcs.
 */
export const BITTEN_COIN = 'M46 -0.63 A46 46 0 1 1 -7.36 -45.41 A15.64 15.64 0 0 0 13.63 -31.98 A16.27 16.27 0 0 0 29.13 -18.98 A15.64 15.64 0 0 0 46 -0.63Z';

/** The fat "C" pressed into the coin mark (a brush skeleton, drawn with a round pen). */
export const MARK_C = 'M13 -14 C8 -22 -13 -24 -13 0 C-13 24 8 22 13 14';

/** One wordmark letter: a brush skeleton in its own 80 x 112 cell, placed at `x`, nudged `dy` and turned `rot` degrees. */
export interface BrandLetter {
  /** The skeleton path; absent for the coin "O" (drawn as the bitten coin). */
  d?: string;
  x: number;
  rot: number;
  dy: number;
  /** A small shine dab. */
  shine?: string;
}

/**
 * The COINNIBAL letters, hand-built (no font): every letter is one skeleton path drawn with a fat round brush, and the
 * "O" is a gold coin with a bite taken out of it (the coin mark without its C).
 */
export const WORD_LETTERS: readonly BrandLetter[] = [
  // C
  { d: 'M62 30 C52 12 16 12 16 56 C16 100 52 100 62 82', x: 0, rot: -4, dy: 1, shine: 'M8 40 v12' },
  // O: the bitten coin
  { x: 78, rot: 3, dy: 2 },
  // I
  { d: 'M28 18 V94', x: 158, rot: -2, dy: -2, shine: 'M20 32 v12' },
  // N
  { d: 'M16 94 V18 L60 94 V18', x: 208, rot: 2.5, dy: 3, shine: 'M8 34 v12' },
  // N
  { d: 'M16 94 V18 L60 94 V18', x: 288, rot: -2, dy: -1, shine: 'M8 34 v12' },
  // I
  { d: 'M28 18 V94', x: 358, rot: 3, dy: 2, shine: 'M20 32 v12' },
  // B
  { d: 'M16 94 V18 H36 C62 18 62 54 36 54 H16 M36 54 C68 54 68 94 36 94 H16', x: 408, rot: -3, dy: 0, shine: 'M8 34 v12' },
  // A
  { d: 'M12 94 L38 18 L64 94 M24 68 H52', x: 488, rot: 2, dy: 2, shine: 'M18 50 l5 -14' },
  // L
  { d: 'M16 18 V94 H56', x: 568, rot: -2.5, dy: -1, shine: 'M8 32 v14' },
];

/** The drawing box of the wordmark (letters, outline and shadow): x from -6, y from -4. */
export const WORD_W = 654;
export const WORD_H = 128;
/** The coin "O" is the bitten coin scaled to sit on the letters' 18..94 line. */
export const WORD_COIN_SCALE = 0.9;
