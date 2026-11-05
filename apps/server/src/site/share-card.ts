import { createRequire } from 'node:module';
import { drawRisoCoin, lookForBasicSkin } from '@elymum/art';
import { SHARE_IMAGE, ordinal, type ShareCard } from '@elymum/shared';
import { GlobalFonts, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

/**
 * The "Share on X" card image (1200 x 630 PNG, X's summary_large_image): the player's coin drawn by the same
 * Storybook art as the game (`@elymum/art` on @napi-rs/canvas), the result or the kill in the display face, the
 * name, the wallet's short form, the flag's country code and the emblem badge, the numbers. Fonts are the site's
 * own (Fraunces, DM Sans), shipped with the server, so the card looks the same in a bare container. English only:
 * the image is one picture for every reader.
 */

const INK = '#04181C';
const NIGHT = '#0F2A30';
const CREAM = '#F6EEDA';
const SUN = '#F2C14E';
const TEAL = '#2D7388';
const FOAM = '#93D9EE';

let fontsReady = false;
function fonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  const require = createRequire(import.meta.url);
  GlobalFonts.registerFromPath(require.resolve('@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2'), 'Fraunces');
  GlobalFonts.registerFromPath(require.resolve('@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2'), 'DM Sans');
}

/** The card's headline: "1st of 42", "Ate Nakamoto!". */
export function shareHeadline(c: ShareCard): string {
  if (c.kind === 'kill') return `Ate ${c.victim ?? 'a coin'}!`;
  return c.rank ? `${ordinal(c.rank)}${c.players ? ` of ${c.players}` : ''}` : 'Played';
}

/** The card's line of numbers. */
export function shareFacts(c: ShareCard): string[] {
  const n = (v: number) => v.toLocaleString('en-US');
  if (c.kind === 'kill') return [`${c.victim ?? 'They'} weighed ${n(c.victimMass ?? 0)}`, `now ${n(c.mass)} mass · ${n(c.kills)} eaten`];
  return [`${n(c.mass)} mass · ${n(c.kills)} eaten`, ...(c.paid ? [`took home ${c.paid}`] : [])];
}

/** Fits `text` into `max` px at the largest size from `size` down (never below 60 %); cuts with an ellipsis if still too long. */
function fit(ctx: SKRSContext2D, text: string, font: (px: number) => string, size: number, max: number): string {
  for (let px = size; px >= size * 0.6; px -= 2) {
    ctx.font = font(px);
    if (ctx.measureText(text).width <= max) return text;
  }
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

function chip(ctx: SKRSContext2D, x: number, y: number, text: string, fill: string, ink: string): number {
  ctx.font = '700 22px "DM Sans"';
  const w = ctx.measureText(text).width + 28;
  ctx.fillStyle = fill;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 40, 20);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.fillText(text, x + 14, y + 28);
  return w;
}

/** Draws the card; returns PNG bytes. */
export function renderShareCard(c: ShareCard): Buffer {
  fonts();
  const { width: W, height: H } = SHARE_IMAGE;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  // the night floor with a few food dots, and a cream sticker for the words
  ctx.fillStyle = NIGHT;
  ctx.fillRect(0, 0, W, H);
  const dots = [FOAM, SUN, '#F39B86', '#3C9A87'];
  for (let i = 0; i < 46; i++) {
    const x = (i * 263) % W;
    const y = (i * 151 + 37) % H;
    ctx.fillStyle = dots[i % dots.length];
    ctx.beginPath();
    ctx.arc(x, y, 5 + (i % 3) * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  // the coin, big, on the left (drawn at its origin)
  ctx.save();
  ctx.translate(250, 330);
  ctx.rotate(-0.08);
  drawRisoCoin(ctx as unknown as CanvasRenderingContext2D, lookForBasicSkin(c.skin), 165, { time: 0, lookX: 0.35, lookY: -0.1, expression: c.kind === 'kill' ? 'chomp' : 'happy', seed: 3 });
  ctx.restore();
  // the sticker
  const X = 470;
  const Y = 70;
  const PW = W - X - 60;
  const PH = H - Y - 70;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.roundRect(X + 10, Y + 10, PW, PH, 28);
  ctx.fill();
  ctx.fillStyle = CREAM;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(X, Y, PW, PH, 28);
  ctx.fill();
  ctx.stroke();
  const L = X + 40;
  const max = PW - 80;
  ctx.fillStyle = TEAL;
  ctx.font = '700 22px "DM Sans"';
  ctx.fillText(fit(ctx, `ELYMUM · ${c.room.toUpperCase()}`, (px) => `700 ${px}px "DM Sans"`, 22, max), L, Y + 56);
  ctx.fillStyle = INK;
  const head = fit(ctx, shareHeadline(c), (px) => `800 ${px}px Fraunces`, 78, max);
  ctx.fillText(head, L, Y + 140);
  const name = fit(ctx, c.name, (px) => `700 ${px}px "DM Sans"`, 36, max);
  ctx.fillText(name, L, Y + 196);
  let cx = L;
  if (c.wallet) cx += chip(ctx, cx, Y + 216, c.wallet, '#FFFFFF', INK) + 10;
  if (c.country) cx += chip(ctx, cx, Y + 216, c.country, FOAM, INK) + 10;
  if (c.holder) chip(ctx, cx, Y + 216, 'EMBLEM HOLDER', SUN, INK);
  ctx.fillStyle = INK;
  shareFacts(c).forEach((line, i) => {
    ctx.fillText(fit(ctx, line, (px) => `500 ${px}px "DM Sans"`, 32, max), L, Y + 310 + i * 44);
  });
  ctx.fillStyle = TEAL;
  ctx.font = '700 22px "DM Sans"';
  ctx.fillText('elymum.io · coin eats coin on Robinhood Chain', L, Y + PH - 30);
  return canvas.toBuffer('image/png');
}
