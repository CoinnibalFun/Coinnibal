import { createRequire } from 'node:module';
import { drawRisoCoin, lookForBasicSkin } from '@coinnibal/art';
import { BRAND_NAME, SHARE_IMAGE, SITE_HOST_DEFAULT, eatenLine, ordinal, shareName, xMention, type ShareBoardRow, type ShareCard } from '@coinnibal/shared';
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
 * Storybook art as the game (`@coinnibal/art` on @napi-rs/canvas), the result or the kill in the display face, the
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

/** The eaten coin of a kill card: its linked `@handle`, else its cleaned name, with its BOT tag (test arenas). */
const victimOf = (c: ShareCard) => (!c.victimBot && xMention(c.victimX)) || (c.victim ? `${shareName(c.victim)}${c.victimBot ? ' (BOT)' : ''}` : null);

/** The card's headline: "1st of 42", "Ate Nakamoto!". */
export function shareHeadline(c: ShareCard): string {
  if (c.kind === 'kill') return `Ate ${victimOf(c) ?? 'a coin'}!`;
  // a death's card has no place: the mass the coin reached
  return c.rank ? `${ordinal(c.rank)}${c.players ? ` of ${c.players}` : ''}` : `${c.mass.toLocaleString('en-US')} mass`;
}

/** The card's line of numbers. */
export function shareFacts(c: ShareCard): string[] {
  const n = (v: number) => v.toLocaleString('en-US');
  if (c.kind === 'kill') return [`${victimOf(c) ?? 'They'} weighed ${n(c.victimMass ?? 0)}`, `now ${n(c.mass)} mass · ${n(c.kills)} eaten`];
  if (!c.rank) return [`${n(c.kills)} eaten this game`];
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

/** The bitten coin of the brand mark (apps/web/src/design/motifs/brandShapes.ts BITTEN_COIN: radius 46 around 0,0). */
const BITTEN_COIN = 'M46 -0.63 A46 46 0 1 1 -7.36 -45.41 A15.64 15.64 0 0 0 13.63 -31.98 A16.27 16.27 0 0 0 29.13 -18.98 A15.64 15.64 0 0 0 46 -0.63Z';
const MARK_C = 'M13 -14 C8 -22 -13 -24 -13 0 C-13 24 8 22 13 14';

/** The Coinnibal coin mark (a cyan coin with a bite out of it and a cream C), centred at (x, y), `size` px across. */
function brandMark(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  const { Path2D } = canvasModule()!;
  const coin = new Path2D(BITTEN_COIN);
  const c = new Path2D(MARK_C);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.12);
  ctx.scale(size / 104, size / 104);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.save();
  ctx.translate(4, 4);
  ctx.fillStyle = INK;
  ctx.fill(coin);
  ctx.restore();
  ctx.fillStyle = '#2490B0';
  ctx.fill(coin);
  ctx.save();
  ctx.clip(coin);
  ctx.fillStyle = '#34B7DD';
  ctx.beginPath();
  ctx.arc(-5, -7, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.stroke(coin);
  ctx.translate(-4, 4);
  for (const [w, color, dx] of [[22, INK, 3], [22, INK, 0], [14, CREAM, 0]] as const) {
    ctx.save();
    ctx.translate(dx, dx);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke(c);
    ctx.restore();
  }
  ctx.restore();
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

/**
 * A picture (JPEG, PNG or WebP bytes) cut to its centre square and drawn at `px` x `px`: a plain RGBA PNG (the X picture
 * worn on the coin goes through `sanitizeAvatar` after this). Throws when the canvas cannot load or decode it.
 */
export async function squarePng(bytes: Buffer, px: number): Promise<Buffer> {
  const lib = canvasModule();
  if (!lib) throw new Error(`@napi-rs/canvas is not available: ${canvasError}`);
  const img = await lib.loadImage(bytes);
  const side = Math.min(img.width, img.height);
  if (!(side > 0)) throw new Error('empty picture');
  const canvas = lib.createCanvas(px, px);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, px, px);
  return canvas.toBuffer('image/png');
}

/** The night floor of every card, with a few food dots. */
function floor(ctx: SKRSContext2D, W: number, H: number): void {
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
}

/** The cream sticker the words sit on: ink edge and a hard ink shadow. */
function sticker(ctx: SKRSContext2D, X: number, Y: number, PW: number, PH: number): void {
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
}

/** Draws the card; returns PNG bytes. Throws when the canvas cannot load (see `shareCardSelfCheck`). */
export function renderShareCard(c: ShareCard, site: string = SITE_HOST_DEFAULT): Buffer {
  const lib = canvasModule();
  if (!lib) throw new Error(`@napi-rs/canvas is not available: ${canvasError}`);
  fonts();
  const { width: W, height: H } = SHARE_IMAGE;
  const canvas = lib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  // the night floor with a few food dots, and a cream sticker for the words
  floor(ctx, W, H);
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
  sticker(ctx, X, Y, PW, PH);
  const L = X + 40;
  const max = PW - 80;
  ctx.fillStyle = c.test ? CORAL : TEAL;
  ctx.font = '700 22px "DM Sans"';
  ctx.fillText(fit(ctx, `${BRAND_NAME.toUpperCase()} · ${c.test ? 'TESTNET TEST ARENA · ' : ''}${c.room.toUpperCase()}`, (px) => `700 ${px}px "DM Sans"`, 22, max - 150), L, Y + 56);
  if (!c.test) brandMark(ctx, X + PW - 62, Y + 50, 62);
  ctx.fillStyle = INK;
  const head = fit(ctx, shareHeadline(c), (px) => `800 ${px}px Fraunces`, 78, max);
  ctx.fillText(head, L, Y + 140);
  const name = fit(ctx, shareName(c.name), (px) => `700 ${px}px "DM Sans"`, 36, max);
  ctx.fillText(name, L, Y + 196);
  let cx = L;
  if (c.wallet) cx += chip(ctx, cx, Y + 216, c.wallet, '#FFFFFF', INK) + 10;
  if (c.country) cx += chip(ctx, cx, Y + 216, c.country, FOAM, INK) + 10;
  if (c.holder) chip(ctx, cx, Y + 216, 'NFT HOLDER', SUN, INK);
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
  ctx.fillText(c.test ? 'TESTNET TEST ARENA · practice tokens, no real money' : `${site} · coins that eat coins, on Robinhood Chain`, L, Y + PH - 30);
  if (c.test) testStamp(ctx, X + PW - 40, Y + 18);
  return canvas.toBuffer('image/png');
}

/** Rows per column of the standings picture (two columns: the top `SHARE_BOARD_ROWS`). */
const BOARD_COL_ROWS = 5;

/**
 * A result's second picture (1200 x 630 PNG, the same floor and sticker): the room's final standings, the top
 * `SHARE_BOARD_ROWS` in two columns (place, name with its BOT tag, value at the bell or mass), my own row marked in
 * sun; when I stood below them, my row on its own strip under the board. TEST stamp and line in a test arena.
 * Throws when the canvas cannot load.
 */
export function renderStandingsCard(c: ShareCard, site: string = SITE_HOST_DEFAULT): Buffer {
  const lib = canvasModule();
  if (!lib) throw new Error(`@napi-rs/canvas is not available: ${canvasError}`);
  fonts();
  const { width: W, height: H } = SHARE_IMAGE;
  const canvas = lib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  floor(ctx, W, H);
  const X = 56;
  const Y = 36;
  const PW = W - X * 2 - 10;
  const PH = H - Y * 2 - 10;
  sticker(ctx, X, Y, PW, PH);
  const L = X + 36;
  const max = PW - 72;
  ctx.fillStyle = c.test ? CORAL : TEAL;
  ctx.font = '700 22px "DM Sans"';
  ctx.fillText(fit(ctx, `${BRAND_NAME.toUpperCase()} · ${c.test ? 'TESTNET TEST ARENA · ' : ''}${c.room.toUpperCase()}`, (px) => `700 ${px}px "DM Sans"`, 22, max - 170), L, Y + 48);
  if (!c.test) brandMark(ctx, X + PW - 64, Y + 50, 60);
  ctx.fillStyle = INK;
  const head = `Final standings${c.players ? ` · ${c.players} players` : ''}`;
  ctx.fillText(fit(ctx, head, (px) => `800 ${px}px Fraunces`, 52, c.test ? max - 170 : max), L, Y + 108);

  const rows = c.board ?? [];
  const top = rows.filter((r) => r.rank <= BOARD_COL_ROWS * 2).slice(0, BOARD_COL_ROWS * 2);
  const below = rows.find((r) => r.you && r.rank > BOARD_COL_ROWS * 2) ?? null;
  const gap = 24;
  const colW = (max - gap) / 2;
  const rowH = 56;
  const top0 = Y + 134;
  top.forEach((r, i) => {
    const col = i < BOARD_COL_ROWS ? 0 : 1;
    boardRow(ctx, r, L + col * (colW + gap), top0 + (i % BOARD_COL_ROWS) * rowH, colW, rowH - 8);
  });
  if (below) {
    const y = top0 + BOARD_COL_ROWS * rowH + 6;
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(L, y - 6);
    ctx.lineTo(L + max, y - 6);
    ctx.stroke();
    ctx.restore();
    boardRow(ctx, below, L, y + 4, max, rowH - 8);
  }
  ctx.fillStyle = c.test ? CORAL : TEAL;
  ctx.font = '700 22px "DM Sans"';
  ctx.fillText(c.test ? 'TESTNET TEST ARENA · practice tokens, no real money' : `${site} · coins that eat coins, on Robinhood Chain`, L, Y + PH - 26);
  if (c.test) testStamp(ctx, X + PW - 36, Y + 16);
  return canvas.toBuffer('image/png');
}

/** One standings row: a place disc, the name (and its BOT tag), the value or mass on the right; mine in sun. */
function boardRow(ctx: SKRSContext2D, r: ShareBoardRow, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = r.you ? SUN : '#FFFFFF';
  ctx.strokeStyle = INK;
  ctx.lineWidth = r.you ? 4 : 2.5;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  ctx.stroke();
  const mid = y + h / 2;
  // the place: a disc, gold / foam for the podium
  const disc = r.rank === 1 ? SUN : r.rank <= 3 ? FOAM : CREAM;
  ctx.fillStyle = r.you && r.rank === 1 ? CREAM : disc;
  ctx.beginPath();
  ctx.arc(x + h / 2, mid, h / 2 - 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.font = `800 ${r.rank >= 100 ? 16 : 20}px "DM Sans"`;
  ctx.fillText(String(r.rank), x + h / 2, mid + 7);
  ctx.textAlign = 'right';
  const right = r.value ?? `${r.mass.toLocaleString('en-US')} mass`;
  const rightText = fit(ctx, right, (px) => `700 ${px}px "DM Sans"`, 22, w * 0.42);
  ctx.fillText(rightText, x + w - 20, mid + 8);
  const rightW = ctx.measureText(rightText).width;
  ctx.textAlign = 'left';
  const nameX = x + h + 6;
  let tagW = 0;
  ctx.font = '800 16px "DM Sans"';
  if (r.bot) tagW = ctx.measureText('BOT').width + 16;
  if (r.you) tagW += ctx.measureText('YOU').width + 16 + (r.bot ? 6 : 0);
  const nameMax = w - (nameX - x) - rightW - 36 - (tagW ? tagW + 8 : 0);
  const name = fit(ctx, r.name, (px) => `${r.you ? 800 : 700} ${px}px "DM Sans"`, 24, Math.max(40, nameMax));
  ctx.fillText(name, nameX, mid + 8);
  let tx = nameX + ctx.measureText(name).width + 8;
  const tag = (text: string, fill: string, ink: string) => {
    ctx.font = '800 16px "DM Sans"';
    const tw = ctx.measureText(text).width + 16;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(tx, mid - 13, tw, 26, 6);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.fillText(text, tx + 8, mid + 6);
    tx += tw + 6;
  };
  if (r.bot) tag('BOT', INK, CREAM);
  if (r.you) tag('YOU', TEAL, '#FFFFFF');
}
