import { createRequire } from 'node:module';
import { drawRisoCoin, lookForBasicSkin } from '@elymum/art';
import { SHARE_IMAGE, eatenLine, ordinal, shareName, type ShareCard } from '@elymum/shared';
import type { SKRSContext2D } from '@napi-rs/canvas';

type Canvas = typeof import('@napi-rs/canvas');
let canvasLib: Canvas | null | undefined;
let canvasError: string | null = null;

/**
 * @napi-rs/canvas, loaded on first use: a native addon (a prebuilt binary per platform). When it cannot load
 * (a platform without a prebuilt binary, a missing system library) the server still starts and serves everything
 * else; share images then fall back to the site's own picture (`ShareService`). Null when it failed.
 */
function canvasModule(): Canvas | null {
  if (canvasLib !== undefined) return canvasLib;
  try {
    canvasLib = createRequire(import.meta.url)('@napi-rs/canvas') as Canvas;
  } catch (err) {
    canvasLib = null;
    canvasError = String((err as Error)?.message ?? err).split('\n')[0];
  }
  return canvasLib;
}

/**
 * Startup self-check: loads the canvas, registers the fonts and draws a tiny image. `ok: false` with the reason
 * when share cards cannot be drawn on this machine.
 */
export function shareCardSelfCheck(): { ok: true } | { ok: false; error: string } {
  const lib = canvasModule();
  if (!lib) return { ok: false, error: canvasError ?? 'unknown' };
  try {
    fonts();
    const c = lib.createCanvas(8, 8);
    const ctx = c.getContext('2d');
    ctx.fillStyle = SUN;
    ctx.fillRect(0, 0, 8, 8);
    ctx.font = '700 6px "DM Sans"';
    ctx.fillText('E', 1, 6);
    if (c.toBuffer('image/png').length < 8) throw new Error('empty PNG');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).split('\n')[0] };
  }
}

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
/** The TEST stamp: a loud coral nobody reads as a payout. */
const CORAL = '#E4572E';

let fontsReady = false;
function fonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  const require = createRequire(import.meta.url);
  const { GlobalFonts } = canvasModule()!;
  GlobalFonts.registerFromPath(require.resolve('@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2'), 'Fraunces');
  GlobalFonts.registerFromPath(require.resolve('@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2'), 'DM Sans');
}

/** The eaten coin of a kill card, cleaned, with its BOT tag (test arenas). */
const victimOf = (c: ShareCard) => (c.victim ? `${shareName(c.victim)}${c.victimBot ? ' (BOT)' : ''}` : null);

/** The card's headline: "1st of 42", "Ate Nakamoto!". */
export function shareHeadline(c: ShareCard): string {
  if (c.kind === 'kill') return `Ate ${victimOf(c) ?? 'a coin'}!`;
  return c.rank ? `${ordinal(c.rank)}${c.players ? ` of ${c.players}` : ''}` : 'Played';
}

/** The card's line of numbers. */
export function shareFacts(c: ShareCard): string[] {
  const n = (v: number) => v.toLocaleString('en-US');
  if (c.kind === 'kill') return [`${victimOf(c) ?? 'They'} weighed ${n(c.victimMass ?? 0)}`, `now ${n(c.mass)} mass · ${n(c.kills)} eaten`];
  // a test arena's card never shows a payout
  return [`${n(c.mass)} mass · ${n(c.kills)} eaten`, ...(c.paid && !c.test ? [`took home ${c.paid}`] : [])];
}

/** The result's "Ate: Penny, Rocky ×2 +3" (names cleaned again), or null when it ate nobody. */
export function shareEaten(c: ShareCard): string | null {
  if (c.kind === 'kill' || ((c.eaten?.length ?? 0) === 0 && !c.eatenMore)) return null;
  return `Ate: ${eatenLine(c.eaten ?? [], c.eatenMore ?? 0)}`;
}

/** The eaten line at its widest that fits: names drop off the end into "+N" (never cut mid-name). */
function fitEaten(ctx: SKRSContext2D, c: ShareCard, max: number): string | null {
  const all = c.eaten ?? [];
  for (let k = all.length; k >= 0; k--) {
    const line = shareEaten({ ...c, eaten: all.slice(0, k), eatenMore: (c.eatenMore ?? 0) + all.length - k });
    if (!line) return null;
    if (k === 0 || ctx.measureText(line).width <= max) return line;
  }
  return null;
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

/** The TEST stamp, top right of the sticker (`right`: its right edge): coral, tilted, impossible to miss. */
function testStamp(ctx: SKRSContext2D, right: number, top: number): void {
  ctx.save();
  ctx.font = '800 40px "DM Sans"';
  const w = ctx.measureText('TEST').width + 44;
  ctx.translate(right - w / 2, top + 34);
  ctx.rotate(0.08);
  ctx.fillStyle = CORAL;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -30, w, 60, 14);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.fillText('TEST', 0, 14);
  ctx.restore();
}

/** Draws the card; returns PNG bytes. Throws when the canvas cannot load (see `shareCardSelfCheck`). */
export function renderShareCard(c: ShareCard): Buffer {
  const lib = canvasModule();
  if (!lib) throw new Error(`@napi-rs/canvas is not available: ${canvasError}`);
  fonts();
  const { width: W, height: H } = SHARE_IMAGE;
  const canvas = lib.createCanvas(W, H);
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
  ctx.fillStyle = c.test ? CORAL : TEAL;
  ctx.font = '700 22px "DM Sans"';
  ctx.fillText(fit(ctx, `ELYMUM · ${c.test ? 'TESTNET TEST ARENA · ' : ''}${c.room.toUpperCase()}`, (px) => `700 ${px}px "DM Sans"`, 22, c.test ? max - 150 : max), L, Y + 56);
  ctx.fillStyle = INK;
  const head = fit(ctx, shareHeadline(c), (px) => `800 ${px}px Fraunces`, 78, max);
  ctx.fillText(head, L, Y + 140);
  const name = fit(ctx, shareName(c.name), (px) => `700 ${px}px "DM Sans"`, 36, max);
  ctx.fillText(name, L, Y + 196);
  let cx = L;
  if (c.wallet) cx += chip(ctx, cx, Y + 216, c.wallet, '#FFFFFF', INK) + 10;
  if (c.country) cx += chip(ctx, cx, Y + 216, c.country, FOAM, INK) + 10;
  if (c.holder) chip(ctx, cx, Y + 216, 'EMBLEM HOLDER', SUN, INK);
  ctx.fillStyle = INK;
  const facts = shareFacts(c);
  facts.forEach((line, i) => {
    ctx.fillText(fit(ctx, line, (px) => `500 ${px}px "DM Sans"`, 32, max), L, Y + 310 + i * 44);
  });
  ctx.font = '700 28px "DM Sans"';
  const ate = fitEaten(ctx, c, max);
  if (ate) {
    ctx.fillStyle = TEAL;
    ctx.fillText(fit(ctx, ate, (px) => `700 ${px}px "DM Sans"`, 28, max), L, Y + 310 + facts.length * 44 + 4);
  }
  ctx.fillStyle = c.test ? CORAL : TEAL;
  ctx.font = '700 22px "DM Sans"';
  ctx.fillText(c.test ? 'TESTNET TEST ARENA · practice tokens, no real money' : 'elymum.io · coin eats coin on Robinhood Chain', L, Y + PH - 30);
  if (c.test) testStamp(ctx, X + PW - 40, Y + 18);
  return canvas.toBuffer('image/png');
}
