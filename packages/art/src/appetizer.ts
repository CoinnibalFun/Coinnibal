import { APPETIZER_IMAGE } from '@coinnibal/shared';
import { drawRisoCoin } from './coin';
import { hash32, lookForHandle, seeded } from './handleLook';
import { ELYSIUM, INK, SHADE, TEXT_INKS } from './palette';

/** What an Appetizer card shows: never the wallet. */
export interface AppetizerCardArt {
  no: number;
  /** Without `@`. */
  handle: string;
  /** Unix ms, when it was claimed. */
  at: number;
  /** The site host printed on the card (`coinnibal.fun`). */
  host: string;
}

/** The font families to draw with (the browser and the server register them under different names). */
export interface AppetizerFonts {
  display: string;
  body: string;
  mono: string;
}

/**
 * Optional, for the page's live preview and its reveal: `stamp` is the SERVED stamp's scale (0 leaves it off, 1 has it
 * landed, above 1 it is still in the air). A card with no number yet (`no` 0, the preview) never gets the stamp.
 */
export interface AppetizerDrawOpts {
  stamp?: number;
}

/*
 * The card: a menu card from the Coinnibal kitchen, taped on a teal gingham tablecloth. On the left the menu ("The
 * Appetizer", table for @handle, the order number, the day it was served); on the right the handle's own coin sits on
 * a plate with a napkin tucked under its chin, fork and knife beside it (in a world where coins eat coins, the guest
 * and the dish are the same thing). A red SERVED stamp lands on the menu. Laid out for 1200 × 675 and read at about
 * 500 px wide on X: big type, thick ink, nothing small that matters.
 */

const W = APPETIZER_IMAGE.width;
const H = APPETIZER_IMAGE.height;
const TAU = Math.PI * 2;
const STONE = ELYSIUM.stone;
const TEAL_INK = TEXT_INKS.day.teal;
const RED_INK = TEXT_INKS.day.down;
const SHADOW = 'rgba(2, 14, 17, 0.62)';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `22 Nov 2026` (UTC, so the browser and the server print the same day). */
export function appetizerDate(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `0042`: the card number as printed (`····` before there is one). */
export const appetizerNo = (no: number): string => (no > 0 ? String(Math.floor(no)).padStart(4, '0') : '····');

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Letter-spaced caps (canvas letterSpacing is not everywhere), left / centre / right of `x`. Returns the width. */
function caps(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, mono: string, align: CanvasTextAlign = 'left', weight = 600): number {
  ctx.font = `${weight} ${size}px ${mono}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  const chars = [...text.toUpperCase()];
  const gap = size * 0.12;
  const widths = chars.map((c) => ctx.measureText(c).width);
  const width = widths.reduce((w, c) => w + c + gap, -gap);
  let cx = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += widths[i] + gap;
  });
  return width;
}

/** The largest size from `size` down that fits `text` in `maxW`. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, family: string, size: number, maxW: number, min = 24): number {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/** The tablecloth: teal gingham, its bands printed twice where they cross. */
function drawTablecloth(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = ELYSIUM.teal;
  ctx.fillRect(0, 0, W, H);
  const band = 54;
  ctx.fillStyle = 'rgba(15, 42, 48, 0.36)';
  for (let x = band / 2; x < W; x += band * 2) ctx.fillRect(x, 0, band, H);
  for (let y = band / 2; y < H; y += band * 2) ctx.fillRect(0, y, W, band);
  // the weave: fine light threads along the bands' edges
  ctx.strokeStyle = 'rgba(219, 242, 249, 0.10)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = band / 2; x < W; x += band) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let y = band / 2; y < H; y += band) {
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();
}

/** A strip of masking tape centred at (x, y), `w` long, turned by `rot` radians, its ends torn. */
function tape(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, rot: number, seed: number): void {
  const r = seeded(seed);
  const h = 34;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h / 2);
  ctx.lineTo(w / 2, -h / 2);
  for (let i = 1; i <= 4; i++) ctx.lineTo(w / 2 + (r() - 0.5) * 7, -h / 2 + (h * i) / 4);
  ctx.lineTo(-w / 2, h / 2);
  for (let i = 3; i >= 0; i--) ctx.lineTo(-w / 2 + (r() - 0.5) * 7, -h / 2 + (h * i) / 4);
  ctx.closePath();
  ctx.fillStyle = 'rgba(219, 242, 249, 0.82)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(4, 24, 28, 0.28)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x + s * 0.18, y - s * 0.18, x + s, y);
  ctx.quadraticCurveTo(x + s * 0.18, y + s * 0.18, x, y + s);
  ctx.quadraticCurveTo(x - s * 0.18, y + s * 0.18, x - s, y);
  ctx.quadraticCurveTo(x - s * 0.18, y - s * 0.18, x, y - s);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.stroke();
}

/** A food bit on the cloth: a little seed with its ink edge and its one shade. */
function seed(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number, fill: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.ellipse(0, 0, s, s * 0.66, 0, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = SHADE.sun;
  ctx.beginPath();
  ctx.ellipse(s * 0.3, s * 0.32, s, s * 0.66, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.ellipse(0, 0, s, s * 0.66, 0, 0, TAU);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.restore();
}

/** The fork, upright, its handle's foot at (x, y). */
function fork(ctx: CanvasRenderingContext2D, x: number, y: number, len: number): void {
  ctx.save();
  ctx.translate(x, y);
  const path = () => {
    ctx.beginPath();
    // handle
    ctx.moveTo(-9, 0);
    ctx.quadraticCurveTo(-11, -len * 0.4, -6, -len * 0.58);
    // the neck widens into the head
    ctx.quadraticCurveTo(-20, -len * 0.66, -20, -len * 0.78);
    ctx.lineTo(-20, -len);
    ctx.lineTo(-13, -len);
    ctx.lineTo(-13, -len * 0.8);
    ctx.lineTo(-5, -len * 0.8);
    ctx.lineTo(-5, -len);
    ctx.lineTo(5, -len);
    ctx.lineTo(5, -len * 0.8);
    ctx.lineTo(13, -len * 0.8);
    ctx.lineTo(13, -len);
    ctx.lineTo(20, -len);
    ctx.lineTo(20, -len * 0.78);
    ctx.quadraticCurveTo(20, -len * 0.66, 6, -len * 0.58);
    ctx.quadraticCurveTo(11, -len * 0.4, 9, 0);
    ctx.quadraticCurveTo(0, 8, -9, 0);
    ctx.closePath();
  };
  ctx.save();
  ctx.translate(7, 7);
  path();
  ctx.fillStyle = SHADOW;
  ctx.fill();
  ctx.restore();
  path();
  ctx.fillStyle = ELYSIUM.mist;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = SHADE.mist;
  ctx.fillRect(2, -len - 4, 30, len + 16);
  ctx.restore();
  path();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

/** The knife, upright, its handle's foot at (x, y). */
function knife(ctx: CanvasRenderingContext2D, x: number, y: number, len: number): void {
  ctx.save();
  ctx.translate(x, y);
  const blade = () => {
    ctx.beginPath();
    ctx.moveTo(-7, -len * 0.44);
    ctx.lineTo(-7, -len * 0.9);
    ctx.quadraticCurveTo(-6, -len - 2, 6, -len);
    ctx.quadraticCurveTo(13, -len * 0.7, 9, -len * 0.44);
    ctx.closePath();
  };
  const handle = () => {
    ctx.beginPath();
    roundRect(ctx, -10, -len * 0.46, 20, len * 0.46 + 4, 9);
  };
  ctx.save();
  ctx.translate(7, 7);
  blade();
  ctx.fillStyle = SHADOW;
  ctx.fill();
  handle();
  ctx.fill();
  ctx.restore();
  blade();
  ctx.fillStyle = ELYSIUM.mist;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  handle();
  ctx.fillStyle = ELYSIUM.sun;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = SHADE.sun;
  ctx.fillRect(3, -len, 20, len + 10);
  ctx.restore();
  handle();
  ctx.stroke();
  // rivets
  ctx.fillStyle = INK;
  for (const k of [0.34, 0.16]) {
    ctx.beginPath();
    ctx.arc(0, -len * k, 2.6, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** The plate under the coin, centred at (x, y): a white dish with a blue rim line, seen from the diner's chair. */
function plate(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x + 10, y + 14, rx, ry, 0, 0, TAU);
  ctx.fillStyle = SHADOW;
  ctx.fill();
  // the rim, its front edge's thickness
  ctx.beginPath();
  ctx.ellipse(x, y + 8, rx, ry, 0, 0, TAU);
  ctx.fillStyle = SHADE.mist;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.fillStyle = ELYSIUM.white;
  ctx.fill();
  ctx.stroke();
  // the blue line round the rim
  ctx.beginPath();
  ctx.ellipse(x, y, rx * 0.89, ry * 0.86, 0, 0, TAU);
  ctx.lineWidth = 5;
  ctx.strokeStyle = ELYSIUM.cyan;
  ctx.stroke();
  // the well
  ctx.beginPath();
  ctx.ellipse(x, y + ry * 0.06, rx * 0.66, ry * 0.6, 0, 0, TAU);
  ctx.fillStyle = ELYSIUM.plain;
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = ELYSIUM.sand2;
  ctx.stroke();
  // a glint on the rim, upper left
  ctx.beginPath();
  ctx.ellipse(x, y, rx * 0.95, ry * 0.92, 0, Math.PI * 1.08, Math.PI * 1.26);
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.strokeStyle = ELYSIUM.mist;
  ctx.stroke();
  ctx.restore();
}

/** The napkin tucked under the coin's chin (a coin of radius r at the origin): coral gingham, two knot ears. */
function napkin(ctx: CanvasRenderingContext2D, r: number): void {
  const top = r * 0.62;
  const half = r * 0.7;
  const tip = r * 1.34;
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(-half, top);
    ctx.quadraticCurveTo(0, top + r * 0.1, half, top);
    ctx.quadraticCurveTo(half * 0.86, top + r * 0.42, r * 0.12, tip);
    ctx.quadraticCurveTo(0, tip + r * 0.06, -r * 0.12, tip);
    ctx.quadraticCurveTo(-half * 0.86, top + r * 0.42, -half, top);
    ctx.closePath();
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  shape();
  ctx.fillStyle = ELYSIUM.cream;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // gingham: coral bands both ways
  const b = r * 0.14;
  ctx.fillStyle = 'rgba(217, 113, 79, 0.55)';
  for (let x = -half - b; x < half + b; x += b * 2) ctx.fillRect(x, top - 4, b, tip - top + 20);
  for (let y = top + b * 0.5; y < tip + b; y += b * 2) ctx.fillRect(-half - 4, y, half * 2 + 8, b);
  // its one shade, lower right
  ctx.fillStyle = 'rgba(180, 85, 58, 0.30)';
  ctx.beginPath();
  ctx.moveTo(r * 0.05, tip + 10);
  ctx.quadraticCurveTo(half * 0.5, top + r * 0.4, half + 6, top);
  ctx.lineTo(half + 20, tip + 20);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  shape();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.stroke();
  // the knot's two ears, peeking out on each side of the neck
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * half * 0.92, top + 2);
    ctx.quadraticCurveTo(s * (half + r * 0.3), top - r * 0.2, s * (half + r * 0.26), top + r * 0.1);
    ctx.quadraticCurveTo(s * (half + r * 0.12), top + r * 0.16, s * half * 0.92, top + 2);
    ctx.closePath();
    ctx.fillStyle = ELYSIUM.coral;
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The "EARLY CARD" tag on the menu's top line: ink caps on a sun pill with an ink edge and a hard shadow, its text's
 * baseline at `baseline`, starting at `x`. Returns its width.
 */
function earlyTag(ctx: CanvasRenderingContext2D, x: number, baseline: number, fonts: AppetizerFonts): number {
  const size = 24;
  ctx.font = `800 ${size}px ${fonts.mono}`;
  const text = 'EARLY CARD';
  const gap = size * 0.12;
  const w = [...text].reduce((s, c) => s + ctx.measureText(c).width + gap, -gap) + 36;
  const h = 42;
  const top = baseline - size * 0.74 - (h - size * 0.74) / 2;
  ctx.save();
  ctx.translate(x, top);
  ctx.rotate(-0.03);
  roundRect(ctx, 4, 5, w, h, h / 2);
  ctx.fillStyle = INK;
  ctx.fill();
  roundRect(ctx, 0, 0, w, h, h / 2);
  ctx.fillStyle = ELYSIUM.sun;
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.translate(x, top);
  ctx.rotate(-0.03);
  caps(ctx, text, 18, (h + size * 0.74) / 2, size, INK, fonts.mono, 'left', 800);
  ctx.restore();
  return w;
}

/** The red SERVED stamp, centred at (x, y): a rubber stamp's double frame, pressed at `scale` (1 = landed). */
function servedStamp(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, fonts: AppetizerFonts): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.2 + (scale - 1) * 0.35);
  ctx.scale(scale, scale);
  ctx.globalAlpha = scale > 1 ? Math.max(0.25, 0.9 - (scale - 1) * 0.6) : 0.9;
  ctx.strokeStyle = RED_INK;
  ctx.fillStyle = RED_INK;
  ctx.lineWidth = 6;
  roundRect(ctx, -124, -60, 248, 120, 12);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  roundRect(ctx, -113, -49, 226, 98, 7);
  ctx.stroke();
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 52px ${fonts.display}`;
  ctx.textAlign = 'center';
  ctx.fillText('SERVED', 0, 19);
  caps(ctx, 'Coinnibal kitchen', 0, -27, 14, RED_INK, fonts.mono, 'center', 700);
  caps(ctx, 'Early card', 0, 40, 14, RED_INK, fonts.mono, 'center', 700);
  ctx.restore();
}

/**
 * Draws the Appetizer card at (0, 0), `APPETIZER_IMAGE` px, on any 2D canvas (the browser's, or @napi-rs/canvas on the
 * server: the share image). Pure drawing, no fonts loaded here: the caller has them ready. An empty handle draws the
 * blank card (the form's preview before anything is typed).
 */
export function drawAppetizerCard(ctx: CanvasRenderingContext2D, card: AppetizerCardArt, fonts: AppetizerFonts, opts: AppetizerDrawOpts = {}): void {
  const handle = card.handle.replace(/^@/, '');
  const name = handle || 'yourhandle';
  const served = card.no > 0;
  const look = lookForHandle(name);
  const r = seeded(hash32(`appetizer:${name.toLowerCase()}`));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  drawTablecloth(ctx);

  // crumbs on the cloth: a few food bits
  const bits: [number, number, number][] = [
    [770, 92, 11],
    [1150, 640, 10],
    [742, 628, 8],
    [1172, 96, 8],
  ];
  for (const [x, y, s] of bits) seed(ctx, x + (r() - 0.5) * 16, y + (r() - 0.5) * 12, s, r() * TAU, r() < 0.5 ? ELYSIUM.sun : ELYSIUM.blush);

  // ── the table setting, right ──
  const PX = 958;
  const PY = 470;
  fork(ctx, 760, 618, 250);
  knife(ctx, 1158, 618, 250);
  plate(ctx, PX, PY, 168, 104);

  // the coin's shadow in the well, then the coin, then its napkin
  const CR = 112;
  const CY = PY - CR + 26;
  ctx.beginPath();
  ctx.ellipse(PX + 8, PY + 22, CR * 0.86, CR * 0.2, 0, 0, TAU);
  ctx.fillStyle = 'rgba(4, 24, 28, 0.20)';
  ctx.fill();
  ctx.save();
  ctx.translate(PX, CY);
  drawRisoCoin(ctx, look, CR, { time: 0, lookX: -0.45, lookY: 0.15, expression: served ? 'hungry' : handle ? 'happy' : 'sleep', pxPerUnit: 1, seed: hash32(name) % 1000 });
  napkin(ctx, CR);
  ctx.restore();
  sparkle(ctx, PX - CR - 38, CY - CR * 0.55, 13, ELYSIUM.sun);
  sparkle(ctx, PX + CR + 34, CY - CR * 0.2, 10, ELYSIUM.cream);
  sparkle(ctx, PX + CR + 8, CY - CR - 30, 8, ELYSIUM.foam);

  // ── the menu card, left ──
  const X = 62;
  const Y = 50;
  const CW = 640;
  const CH = 572;
  ctx.save();
  ctx.translate(X + CW / 2, Y + CH / 2);
  ctx.rotate(-0.022);
  ctx.translate(-(X + CW / 2), -(Y + CH / 2));

  roundRect(ctx, X + 13, Y + 14, CW, CH, 20);
  ctx.fillStyle = SHADOW;
  ctx.fill();
  roundRect(ctx, X, Y, CW, CH, 20);
  ctx.fillStyle = ELYSIUM.cream;
  ctx.fill();
  // one hard shade along the foot of the stock
  ctx.save();
  ctx.clip();
  ctx.fillStyle = SHADE.cream;
  ctx.fillRect(X, Y + CH - 12, CW, 12);
  ctx.restore();
  roundRect(ctx, X, Y, CW, CH, 20);
  ctx.lineWidth = 7;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // the menu's printed frame: a fine double rule
  ctx.strokeStyle = TEAL_INK;
  ctx.lineWidth = 2.5;
  roundRect(ctx, X + 22, Y + 22, CW - 44, CH - 50, 10);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  roundRect(ctx, X + 30, Y + 30, CW - 60, CH - 66, 6);
  ctx.stroke();

  const L = X + 62;
  const R = X + CW - 62;
  // the card's kind, said first and loud: the house, then a sun tag "EARLY CARD"
  const LY = Y + 82;
  const house = caps(ctx, 'Coinnibal ·', L, LY, 20, TEAL_INK, fonts.mono, 'left', 700);
  earlyTag(ctx, L + house + 14, LY, fonts);

  // the dish
  ctx.font = `800 ${fit(ctx, 'The Appetizer', 800, fonts.display, 80, R - L)}px ${fonts.display}`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.fillText('The Appetizer', L - 3, Y + 162);

  // a little ornament under it: rule, sun diamond, rule
  const OY = Y + 194;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(L, OY);
  ctx.lineTo(L + 200, OY);
  ctx.moveTo(L + 240, OY);
  ctx.lineTo(R, OY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(L + 220, OY - 12);
  ctx.lineTo(L + 232, OY);
  ctx.lineTo(L + 220, OY + 12);
  ctx.lineTo(L + 208, OY);
  ctx.closePath();
  ctx.fillStyle = ELYSIUM.sun;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.stroke();

  // the guest
  caps(ctx, 'Table for', L, Y + 250, 18, STONE, fonts.mono);
  const at = `@${name}`;
  const size = fit(ctx, at, 800, fonts.display, 80, R - L, 16);
  ctx.font = `800 ${size}px ${fonts.display}`;
  ctx.fillStyle = handle ? INK : STONE;
  ctx.textAlign = 'left';
  ctx.fillText(at, L - 2, Y + 262 + Math.max(size, 56) * 0.84);

  // dashed rule, then the order's details
  const RY = Y + 362;
  ctx.setLineDash([12, 10]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = ELYSIUM.sand2;
  ctx.beginPath();
  ctx.moveTo(L, RY);
  ctx.lineTo(R, RY);
  ctx.stroke();
  ctx.setLineDash([]);
  caps(ctx, 'Order No.', L, RY + 42, 16, STONE, fonts.mono);
  ctx.font = `700 46px ${fonts.mono}`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.fillText(appetizerNo(card.no), L - 2, RY + 96);
  const DX = L + 196;
  caps(ctx, 'Served', DX, RY + 42, 16, STONE, fonts.mono);
  const day = served ? appetizerDate(card.at) : '…';
  ctx.font = `700 ${fit(ctx, day, 700, fonts.display, 30, 180, 20)}px ${fonts.display}`;
  ctx.fillStyle = INK;
  ctx.fillText(day, DX, RY + 90);

  // the house's address at the foot of the menu
  caps(ctx, card.host, L, Y + CH - 56, 16, STONE, fonts.mono, 'left', 500);

  // the stamp, pressed over the corner of the details
  const ss = opts.stamp ?? 1;
  if (served && ss > 0) servedStamp(ctx, R - 88, Y + CH - 80, ss * 0.92, fonts);
  ctx.restore(); // the card's tilt

  // the tape that holds the menu to the table
  tape(ctx, X + 70, Y + 6, 132, -0.62, hash32(`tape1:${name}`));
  tape(ctx, X + CW - 52, Y + 10, 132, 0.58, hash32(`tape2:${name}`));
  ctx.restore();
}
