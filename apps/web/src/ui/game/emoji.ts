import { emoteEmoji } from '@coinnibal/shared';

/** The platform's colour emoji fonts, in the order the systems ship them. */
export const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';

/**
 * Tile size, px: the sticker is drawn up to `EMOTE_MAX_PX` (150 CSS px) on a big coin, 300 device px on a 2x screen,
 * so the tile covers that without being stretched (a 128 px tile went soft on big coins).
 */
const SIZE = 320;
const tiles = new Map<number, HTMLCanvasElement | null>();

/**
 * Emote `id` rasterised once into a canvas tile (drawn over the coin each frame without re-shaping
 * the glyph); null where there is no canvas (tests, very old browsers).
 */
export function emojiImage(id: number): HTMLCanvasElement | null {
  if (tiles.has(id)) return tiles.get(id)!;
  let tile: HTMLCanvasElement | null = null;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = SIZE;
    c.height = SIZE;
    const ctx = c.getContext?.('2d');
    if (ctx) {
      ctx.font = `${Math.round(SIZE * 0.82)}px ${EMOJI_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoteEmoji(id), SIZE / 2, SIZE * 0.54);
      tile = c;
    }
  }
  tiles.set(id, tile);
  return tile;
}
