import { ELYSIUM, RULES, SHADE, TEXT_INKS, activeChain } from '@coinnibal/shared';
import { BITTEN_COIN, WORD_COIN_SCALE, WORD_LETTERS, type BrandLetter } from '../../design/motifs/brandShapes';
import { ourXHandle, plainChainName, t } from '../../i18n';
import { drawCoinLook } from '../../render/coin';
import { hash32, lookForHandle, seeded, ticketNo } from '../coinLook';
import { siteHost } from '../settings';

/** The shareable WL card, a boarding-pass card: 1200 × 675 (X shows 16:9 images whole). */
export const CARD_W = 1200;
export const CARD_H = 675;

const DISPLAY = "'Fraunces Variable', 'Fraunces', Georgia, serif";
const MONO = "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace";
const INK = ELYSIUM.abyss;
const NIGHT_SHADOW = '#000507';
const STONE = ELYSIUM.stone;
const TEAL_INK = TEXT_INKS.day.teal;

/** Waits for the card's fonts (so the first draw is not in a fallback face). */
export async function cardFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`800 80px ${DISPLAY}`),
      document.fonts.load(`italic 500 20px ${DISPLAY}`),
      document.fonts.load(`600 30px ${MONO}`),
    ]);
  } catch {
    /* no font loading API: draw with what there is */
  }
}

/** The wordmark at (x, y) (top-left), `scale` × its WORD_W × WORD_H drawing (the `Wordmark` motif on canvas). */
function drawWordmark(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  if (typeof Path2D === 'undefined') return;
  ctx.save();
  ctx.translate(x + 6 * scale, y + 4 * scale);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const coin = new Path2D(BITTEN_COIN);
  const layer = (fn: (p: Path2D | null, l: BrandLetter) => void) => {
    for (const l of WORD_LETTERS) {
      ctx.save();
      ctx.translate(l.x, l.dy);
      ctx.translate(40, 56);
      ctx.rotate((l.rot * Math.PI) / 180);
      ctx.translate(-40, -56);
      fn(l.d ? new Path2D(l.d) : null, l);
      ctx.restore();
    }
  };
  /** The coin "O": the bitten coin scaled into the letter's cell. */
  const inCoin = (fn: () => void) => {
    ctx.save();
    ctx.translate(40, 56);
    ctx.scale(WORD_COIN_SCALE, WORD_COIN_SCALE);
    fn();
    ctx.restore();
  };
  // hard offset shadow, then the ink edge of every letter, then the paint (so letters overlap cleanly)
  layer((p) => {
    ctx.save();
    ctx.translate(5, 5);
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    if (p) {
      ctx.lineWidth = 30;
      ctx.stroke(p);
    } else
      inCoin(() => {
        ctx.lineWidth = 6 / WORD_COIN_SCALE;
        ctx.fill(coin);
        ctx.stroke(coin);
      });
    ctx.restore();
  });
  layer((p) => {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 30;
    if (p) ctx.stroke(p);
  });
  layer((p, l) => {
    if (!p) {
      inCoin(() => {
        ctx.fillStyle = SHADE.sun;
        ctx.fill(coin);
        ctx.save();
        ctx.clip(coin);
        ctx.fillStyle = ELYSIUM.sun;
        ctx.beginPath();
        ctx.arc(-5, -7, 44, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = SHADE.sun;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(0, 0, 30, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 6;
        ctx.stroke(new Path2D('M-36 -10 A37 37 0 0 1 -18 -32'));
        ctx.strokeStyle = INK;
        ctx.lineWidth = (6 / WORD_COIN_SCALE) * 1.2;
        ctx.stroke(coin);
      });
      return;
    }
    ctx.strokeStyle = SHADE.cyan;
    ctx.lineWidth = 24;
    ctx.stroke(p);
    ctx.save();
    ctx.translate(-1.6, -1.8);
    ctx.strokeStyle = ELYSIUM.cyan;
    ctx.lineWidth = 19;
    ctx.stroke(p);
    ctx.restore();
    if (l.shine) {
      ctx.save();
      ctx.translate(5, 0);
      ctx.strokeStyle = ELYSIUM.mist;
      ctx.lineWidth = 4.5;
      ctx.stroke(new Path2D(l.shine));
      ctx.restore();
    }
  });
  ctx.restore();
}

/** Text shrunk to fit `maxW`, starting at `size`. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, size: number, maxW: number): number {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 18 && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/** The boarding-pass outline: soft corners, a notch cut top and bottom at the perforation. */
function passPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, perf: number, notch: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(perf - notch, y);
  ctx.arc(perf, y, notch, Math.PI, 0, true);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(perf + notch, y + h);
  ctx.arc(perf, y + h, notch, 0, Math.PI, true);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Seigaiha wave scales, back to front, from `y0` to the bottom edge. */
function drawSeigaiha(ctx: CanvasRenderingContext2D, y0: number, r: number): void {
  const fills = [ELYSIUM.reef, ELYSIUM.current, ELYSIUM.reef];
  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = INK;
  for (let row = 0, y = y0; y < CARD_H + r; row++, y += r * 0.52) {
    const off = row % 2 ? r : 0;
    for (let x = -r + off; x < CARD_W + r; x += r * 2) {
      [1, 0.68, 0.36].forEach((k, i) => {
        ctx.beginPath();
        ctx.arc(x, y, r * k, 0, Math.PI * 2);
        ctx.fillStyle = fills[i];
        ctx.fill();
        ctx.stroke();
      });
    }
  }
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
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string = STONE, size = 17, align: CanvasTextAlign = 'left'): void {
  ctx.font = `600 ${size}px ${MONO}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  // letter-spaced caps, by hand (canvas letterSpacing is not everywhere yet)
  const chars = [...text.toUpperCase()];
  const gap = size * 0.1;
  const width = chars.reduce((w, c) => w + ctx.measureText(c).width + gap, -gap);
  let cx = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  ctx.textAlign = 'left';
  for (const c of chars) {
    ctx.fillText(c, cx, y);
    cx += ctx.measureText(c).width + gap;
  }
}

/** Draws the WL pass card for `handle` (normalised, no `@`; empty shows a blank pass). */
/**
 * How much of the pass to draw (the on-page "assembly": the pass prints itself piece by piece).
 * `upto`: 0 the night only, 1 + the blank pass, 2 + the wordmark and labels, 3 + the passenger
 * (typed out to `chars` characters), 4 + the flight details, 5 + the stub (number and coin),
 * 6 + the rubber stamp (pressed at `stampScale`, 1 = landed) and the Homer line. Default: all.
 */
export interface CardDrawOpts {
  upto?: number;
  chars?: number;
  stampScale?: number;
}

export function drawTicketCard(canvas: HTMLCanvasElement, handle: string, opts: CardDrawOpts = {}): void {
  const upto = opts.upto ?? 99;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (canvas.width !== CARD_W || canvas.height !== CARD_H) {
    canvas.width = CARD_W;
    canvas.height = CARD_H;
  }
  const name = handle || 'yourhandle';
  const look = lookForHandle(name);
  const no = handle ? ticketNo(handle) : '0000';
  const r = seeded(hash32(`sky:${name}`));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // night in orbit
  ctx.fillStyle = ELYSIUM.trench;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // the far ring arching overhead, its lights
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(CARD_W / 2, 980, 980, 930, 0, Math.PI * 1.08, Math.PI * 1.92);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 46;
  ctx.stroke();
  ctx.strokeStyle = ELYSIUM.current;
  ctx.lineWidth = 38;
  ctx.stroke();
  ctx.setLineDash([3, 26]);
  ctx.strokeStyle = ELYSIUM.sun;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // stars
  for (let i = 0; i < 26; i++) {
    const x = r() * CARD_W;
    const y = r() * 300;
    if (x > 60 && x < 1140 && y > 60) continue; // keep the sky over the pass clear
    ctx.globalAlpha = 0.5 + r() * 0.5;
    ctx.fillStyle = ELYSIUM.cream;
    ctx.beginPath();
    ctx.arc(x, y, 1.4 + r() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  sparkle(ctx, 1150, 44, 13, ELYSIUM.sun);
  sparkle(ctx, 40, 120, 9, ELYSIUM.foam);
  sparkle(ctx, 1162, 300, 8, ELYSIUM.cream);

  // the sea of scales at the foot
  drawSeigaiha(ctx, 638, 40);

  // the pass
  if (upto < 1) return;
  const X = 84;
  const Y = 70;
  const W = CARD_W - 168;
  const H = 476;
  const R = 30;
  const STUB = 304;
  const PERF = X + W - STUB;
  const NOTCH = 22;
  ctx.save();
  ctx.translate(CARD_W / 2, Y + H / 2);
  ctx.rotate(-0.018);
  ctx.translate(-CARD_W / 2, -(Y + H / 2));

  ctx.save();
  ctx.translate(13, 13);
  passPath(ctx, X, Y, W, H, R, PERF, NOTCH);
  ctx.fillStyle = NIGHT_SHADOW;
  ctx.fill();
  ctx.restore();

  passPath(ctx, X, Y, W, H, R, PERF, NOTCH);
  ctx.fillStyle = ELYSIUM.cream;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = ELYSIUM.sun;
  ctx.fillRect(PERF, Y, STUB, H);
  // one hard shade on the stub, lower right
  ctx.fillStyle = SHADE.sun;
  ctx.fillRect(PERF, Y + H - 16, STUB, 16);
  ctx.fillStyle = ELYSIUM.cream;
  ctx.restore();

  ctx.setLineDash([2, 16]);
  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.moveTo(PERF, Y + NOTCH + 18);
  ctx.lineTo(PERF, Y + H - NOTCH - 18);
  ctx.stroke();
  ctx.setLineDash([]);

  passPath(ctx, X, Y, W, H, R, PERF, NOTCH);
  ctx.lineWidth = 7;
  ctx.strokeStyle = INK;
  ctx.stroke();

  // the body
  const BX = X + 54;
  const maxW = PERF - BX - 44;
  if (upto < 2) {
    ctx.restore();
    return;
  }
  label(ctx, t('wp.img.title'), BX, Y + 62, TEAL_INK, 19);
  label(ctx, t('wp.img.motto'), PERF - 40, Y + 62, STONE, 17, 'right');
  drawWordmark(ctx, BX - 4, Y + 88, 0.48);

  label(ctx, t('wp.img.passenger'), BX, Y + 222);
  if (upto < 3) {
    ctx.restore();
    return;
  }
  const at = `@${name}`;
  const size = fitFont(ctx, at, '800', DISPLAY, 96, maxW);
  ctx.font = `800 ${size}px ${DISPLAY}`;
  ctx.fillStyle = handle ? INK : STONE;
  ctx.fillText(upto === 3 && opts.chars !== undefined ? at.slice(0, Math.max(0, opts.chars)) : at, BX - 2, Y + 230 + size * 0.86);
  if (upto < 4) {
    ctx.restore();
    return;
  }

  // dashed rule, then the flight details
  const RY = Y + 352;
  ctx.setLineDash([12, 10]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = ELYSIUM.sand2;
  ctx.beginPath();
  ctx.moveTo(BX, RY);
  ctx.lineTo(PERF - 40, RY);
  ctx.stroke();
  ctx.setLineDash([]);
  const cols: [string, string][] = [
    [t('wp.img.game'), 'Coinnibal'],
    [t('wp.img.rounds'), t('wp.img.roundsV', { min: Math.round(RULES.roundMs / 60_000) })],
    [t('wp.img.pass'), 'WL'],
    [t('wp.img.mint'), 'OpenSea'],
  ];
  const colW = (PERF - 40 - BX) / cols.length;
  cols.forEach(([k, v], i) => {
    const cx = BX + i * colW;
    label(ctx, k, cx, RY + 38, STONE, 16);
    ctx.font = `800 ${fitFont(ctx, v, '800', DISPLAY, 33, colW - 18)}px ${DISPLAY}`;
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.fillText(v, cx, RY + 80);
  });

  if (upto < 5) {
    ctx.restore();
    return;
  }
  // the stub: number, the handle's own coin, admit one
  const SX = PERF + STUB / 2;
  label(ctx, t('wp.img.no'), SX, Y + 58, INK, 17, 'center');
  ctx.font = `600 58px ${MONO}`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.fillText(no, SX, Y + 116);
  ctx.textAlign = 'left';

  const cy = Y + 262;
  ctx.fillStyle = 'rgba(4, 24, 28, 0.22)';
  ctx.beginPath();
  ctx.ellipse(SX + 4, cy + 92, 70, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  drawCoinLook(ctx, SX, cy, 84, look, { time: 0, lookX: -0.3, lookY: 0.1, expression: handle ? 'happy' : 'sleep', pxPerUnit: 1, seed: hash32(name) % 1000 });

  label(ctx, t('wp.img.admit'), SX, Y + H - 66, INK, 18, 'center');
  label(ctx, siteHost(), SX, Y + H - 38, INK, 15, 'center');

  if (upto < 6) {
    ctx.restore();
    return;
  }
  // the rubber stamp over the perforation
  const ss = opts.stampScale ?? 1;
  ctx.save();
  ctx.translate(PERF - 6, Y + H - 118);
  ctx.rotate(-0.24 + (ss - 1) * 0.3);
  ctx.scale(ss, ss);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = TEAL_INK;
  ctx.fillStyle = TEAL_INK;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(0, 0, 62, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, 51, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = `900 ${handle ? 34 : 24}px ${DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.fillText(handle ? 'WL' : t('wp.img.blank'), 0, handle ? 8 : 6);
  ctx.font = `600 13px ${MONO}`;
  ctx.fillText(handle ? plainChainName(activeChain().name).toUpperCase() : t('wp.img.addHandle'), 0, 30);
  ctx.fillText(t('wp.img.stampTop'), 0, -26);
  ctx.restore();

  ctx.restore(); // the tilt
  if (ss > 1.02) return; // the stamp is still in the air

  // the tagline under the pass, on the night
  ctx.font = `italic 500 21px ${DISPLAY}`;
  ctx.fillStyle = ELYSIUM.cream;
  ctx.textAlign = 'left';
  ctx.globalAlpha = 0.92;
  ctx.fillText(t('brand.tagline'), X + 6, 590);
  ctx.globalAlpha = 1;
  label(ctx, ourXHandle(), CARD_W - X - 4, 590, ELYSIUM.foam, 17, 'right');
}

/** The card as a PNG. */
export function cardBlob(handle: string): Promise<Blob | null> {
  const c = document.createElement('canvas');
  drawTicketCard(c, handle);
  return new Promise((resolve) => {
    try {
      c.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
}
