import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { APPETIZER_IMAGE } from '@coinnibal/shared';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ELYSIUM, appetizerDate, appetizerNo, drawAppetizerCard, lookForHandle, type AppetizerCardArt } from '../src/index';

/*
 * The Appetizer card on @napi-rs/canvas, as the server draws the share image. The site's fonts are registered when the
 * workspace has them (the web app's fontsource packages); without them the canvas falls back to its own faces and the
 * card still has to draw. `APPETIZER_SAMPLES=<dir>` writes the drawn cards there as PNGs for a look.
 */

const FONT_DIR = join(__dirname, '../../../apps/web/node_modules/@fontsource-variable');
const FONTS = { display: '"Fraunces"', body: '"DM Sans"', mono: '"Geist Mono"' };
for (const [pkg, file, family] of [
  ['fraunces', 'fraunces-latin-wght-normal.woff2', 'Fraunces'],
  ['dm-sans', 'dm-sans-latin-wght-normal.woff2', 'DM Sans'],
  ['geist-mono', 'geist-mono-latin-wght-normal.woff2', 'Geist Mono'],
] as const) {
  const path = join(FONT_DIR, pkg, 'files', file);
  if (existsSync(path)) GlobalFonts.registerFromPath(path, family);
}

const hex = (s: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
const near = (a: ArrayLike<number>, b: [number, number, number], tol: number) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

const AT = Date.UTC(2026, 10, 22, 10, 30);
const SHORT: AppetizerCardArt = { no: 42, handle: 'ana', at: AT, host: 'coinnibal.fun' };
const LONG: AppetizerCardArt = { no: 12345, handle: 'WWWWWWWWWWWWWWW', at: AT, host: 'coinnibal.fun' };
const TYPICAL: AppetizerCardArt = { no: 7, handle: 'satoshi_nibbles', at: AT, host: 'coinnibal.fun' };

function draw(card: AppetizerCardArt, stamp?: number) {
  const c = createCanvas(APPETIZER_IMAGE.width, APPETIZER_IMAGE.height);
  const ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D;
  drawAppetizerCard(ctx, card, FONTS, stamp === undefined ? {} : { stamp });
  return { c, ctx };
}

describe('drawAppetizerCard', () => {
  it('draws a short and a 15-character handle, 1200 x 675', () => {
    const out = process.env.APPETIZER_SAMPLES;
    if (out) mkdirSync(out, { recursive: true });
    for (const [name, card] of [
      ['short', SHORT],
      ['long', LONG],
      ['typical', TYPICAL],
      ['blank', { ...SHORT, no: 0, handle: '' }],
    ] as const) {
      const { c } = draw(card);
      expect(c.width).toBe(1200);
      expect(c.height).toBe(675);
      const png = c.toBuffer('image/png');
      expect(png.length).toBeGreaterThan(20_000);
      if (out) writeFileSync(join(out, `appetizer-${name}.png`), png);
    }
  });

  it('says it is an early card: a sun tag on the top line of the menu', () => {
    const { ctx } = draw(SHORT);
    const at = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data;
    // inside the tag, left of its text
    expect(near(at(302, 120), hex(ELYSIUM.sun), 16)).toBe(true);
  });

  it('lays the menu card on the tablecloth: cream stock on the left, the cloth in the corners', () => {
    const { ctx } = draw(SHORT);
    const at = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data;
    // a quiet spot of the card stock, under the title (left of the ornament's diamond)
    expect(near(at(400, 300), hex(ELYSIUM.cream), 14)).toBe(true);
    // the cloth at the corners is teal (one of the two band tones)
    for (const [x, y] of [
      [4, 4],
      [1196, 4],
      [4, 671],
    ]) {
      const px = at(x, y);
      expect(px[2]).toBeGreaterThan(px[0]);
    }
  });

  it('keeps the longest handle inside the menu card', () => {
    // the strip of cloth between the card's right edge and the fork, along the handle's line, is the same whatever
    // the handle: the text never reaches past the card
    const strip = (card: AppetizerCardArt) => Buffer.from(draw(card).ctx.getImageData(718, 260, 20, 120).data);
    expect(strip(LONG).equals(strip(SHORT))).toBe(true);
    expect(strip(TYPICAL).equals(strip(SHORT))).toBe(true);
  });

  it('is deterministic, and the coin is the handle’s own', () => {
    const a = Buffer.from(draw(TYPICAL).ctx.getImageData(0, 0, 1200, 675).data);
    const b = Buffer.from(draw(TYPICAL).ctx.getImageData(0, 0, 1200, 675).data);
    expect(a.equals(b)).toBe(true);
    // the coin's body paint shows in the middle of the coin (left of its face)
    const { ctx } = draw(TYPICAL);
    const body = ctx.getImageData(958 - 70, 470 - 112 + 26 - 10, 1, 1).data;
    expect(near(body, hex(lookForHandle('satoshi_nibbles').body), 40)).toBe(true);
  });

  it('a card without a number (the preview) and a stamp in the air still draw', () => {
    expect(() => draw({ ...SHORT, no: 0 })).not.toThrow();
    expect(() => draw(SHORT, 1.8)).not.toThrow();
    expect(() => draw(SHORT, 0)).not.toThrow();
  });

  it('prints the number and the day the same everywhere', () => {
    expect(appetizerNo(42)).toBe('0042');
    expect(appetizerNo(12345)).toBe('12345');
    expect(appetizerNo(0)).toBe('····');
    expect(appetizerDate(AT)).toBe('22 Nov 2026');
    expect(appetizerDate(Number.NaN)).toBe('');
  });
});
