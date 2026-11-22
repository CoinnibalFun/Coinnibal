import { APPETIZER_IMAGE } from '@coinnibal/shared';

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
 * Draws the Appetizer card at (0, 0), `APPETIZER_IMAGE` px, on any 2D canvas (the browser's, or @napi-rs/canvas on the
 * server: the share image). Pure drawing, no fonts loaded here: the caller has them ready.
 * PLACEHOLDER: the visitor-side work replaces this body with the real design; the signature stays.
 */
export function drawAppetizerCard(ctx: CanvasRenderingContext2D, card: AppetizerCardArt, fonts: AppetizerFonts): void {
  const { width: W, height: H } = APPETIZER_IMAGE;
  ctx.save();
  ctx.fillStyle = '#F5EBD8';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0B2A33';
  ctx.font = `700 72px ${fonts.display}`;
  ctx.fillText('Appetizer', 80, 200);
  ctx.font = `500 48px ${fonts.body}`;
  ctx.fillText(`@${card.handle}`, 80, 300);
  ctx.font = `500 32px ${fonts.mono}`;
  ctx.fillText(`No. ${String(card.no).padStart(4, '0')} · ${card.host}`, 80, 380);
  ctx.restore();
}
