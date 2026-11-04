/**
 * Emote stickers (no emoji in UI chrome), two pages: "Hype" (ids 0..7) and "Trash talk" (ids 8..15,
 * attitude in the same hand: cursing grawlix, fuming, shades, LOL, ROFL, skull, eye roll, take the L;
 * PG-13). Each system emote is a
 * die-cut risograph sticker: a card-stock border with an ink hairline, flat
 * riso inks with a misregistered second pass (multiply) and hand-lettered
 * stroke type (no fonts: SVG used as an image cannot load web fonts).
 *
 * The same markup feeds the HUD buttons (<img src>) and the canvas renderer
 * (decoded once into an Image and drawn above the cell).
 */

import { CARD_PAPER, INK as PALETTE_INK, RISO } from '@elymum/art';

const INK = PALETTE_INK;
const CARD = CARD_PAPER;
const PINK = RISO.fluoPink;
const TEAL = RISO.teal;
const MUSTARD = RISO.mustard;
const BLUE = RISO.blue;
const AQUA = RISO.aqua;
const ORANGE = RISO.orange;
const MINT = RISO.mint;
const RED = RISO.red;
/** Pale mint stock behind the rocket. */
const MINT_PALE = '#D6F7E8';

/** Stroke letters on a 10 × 14 cell (only the ones the stickers spell). */
const GLYPHS: Record<string, { d: string; w: number }> = {
  G: { d: 'M8.6 3.2C7.4 1.3 4.6.6 2.9 2.4 1 4.4.9 9.4 2.9 11.6c1.9 2 5.2 1.6 5.9-1V8.3H5.6', w: 10 },
  M: { d: 'M1 13V1.2l4 7.2 4-7.2V13', w: 10 },
  W: { d: 'M.6 1.2 2.6 13 5 5.2 7.4 13 9.4 1.2', w: 10 },
  A: { d: 'M1 13 5 1.2 9 13M2.5 9h5', w: 10 },
  I: { d: 'M2 1.2V13', w: 4 },
  L: { d: 'M2 1.2V13h7', w: 10 },
  // grawlix (the cursing sticker): # @ $ !
  '#': { d: 'M4 1.2 2.8 13M7.6 1.2 6.4 13M1 5h8.4M.6 9.2h8.4', w: 10 },
  '@': { d: 'M6.9 7.1a1.9 2.3 0 1 0 0 .1M6.9 4.8v3.6c0 1.6 2.6 1.6 2.6-1.2 0-3.8-2.2-6-4.6-6C2.2 1.2.6 3.8.6 7c0 3.6 2.2 6 5 6 1.2 0 2.2-.3 3-.9', w: 10 },
  $: { d: 'M8.2 3.4C7.2 1.6 2.6 1.2 2 3.8 1.4 6.6 8.8 6.6 8.4 9.8 8 12.8 3 13 1.6 10.6M5 .2v13.6', w: 10 },
  '!': { d: 'M2 1.2v7.6M2 12.6v.4', w: 4 },
};

/** Hand-lettered word centred on `cx`, cap height `h`. */
function letters(text: string, cx: number, top: number, h: number, color: string = INK, weight = 2.6): string {
  const s = h / 14;
  const gap = 1.6;
  const total = [...text].reduce((n, ch) => n + (GLYPHS[ch]?.w ?? 6) + gap, -gap) * s;
  let x = cx - total / 2;
  let out = '';
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) out += `<path d="${g.d}" transform="translate(${x.toFixed(2)} ${top}) scale(${s.toFixed(3)})" stroke-width="${(weight / s).toFixed(2)}"/>`;
    x += ((g?.w ?? 6) + gap) * s;
  }
  return `<g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">${out}</g>`;
}

/** Die-cut base: ink hairline, card border, then `fill`. */
function dieCut(shape: string, fill: string = CARD): string {
  return (
    `<g stroke-linejoin="round">` +
    `<g fill="${INK}" stroke="${INK}" stroke-width="9" opacity=".9">${shape}</g>` +
    `<g fill="${CARD}" stroke="${CARD}" stroke-width="6">${shape}</g>` +
    `<g fill="${fill}">${shape}</g>` +
    `</g>`
  );
}

/** A riso shape: the second ink peeks out from under the first (misregistration), ink outline. */
function riso(shape: string, ink: string, over: string, dx = 1.8, dy = 1.8, outline = 2): string {
  return (
    `<g transform="translate(${dx} ${dy})" fill="${over}">${shape}</g>` +
    `<g fill="${ink}">${shape}</g>` +
    `<g fill="none" stroke="${INK}" stroke-width="${outline}" stroke-linejoin="round">${shape}</g>`
  );
}

const face = (cx: number, cy: number, r: number, ink: string, over: string) => riso(`<circle cx="${cx}" cy="${cy}" r="${r}"/>`, ink, over);

const circleBase = `<circle cx="32" cy="32" r="27"/>`;

const BODIES: Record<number, string> = {
  // 0 · GM: a sun rising over a ruled horizon
  0:
    dieCut(circleBase) +
    `<g stroke="${INK}" stroke-width="2.2" stroke-linecap="round">` +
    [-60, -30, 0, 30, 60].map((a) => {
      const r0 = 14;
      const r1 = 19;
      const rad = ((a - 90) * Math.PI) / 180;
      return `<path d="M${(32 + Math.cos(rad) * r0).toFixed(1)} ${(30 + Math.sin(rad) * r0).toFixed(1)}L${(32 + Math.cos(rad) * r1).toFixed(1)} ${(30 + Math.sin(rad) * r1).toFixed(1)}"/>`;
    }).join('') +
    `</g>` +
    `<clipPath id="h"><rect x="0" y="0" width="64" height="35"/></clipPath>` +
    `<g clip-path="url(#h)">${face(32, 32, 10, MUSTARD, ORANGE)}</g>` +
    `<path d="M14 35h36" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<path d="M27.5 29.5q1.6-1.6 3.2 0M33.3 29.5q1.6-1.6 3.2 0" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>` +
    letters('GM', 32, 39, 11.5),
  // 1 · WAGMI: a pink ribbon banner
  1:
    dieCut(`<path d="M3 22h7v-4h44v4h7l-5 10 5 10h-7v4H10v-4H3l5-10z"/>`) +
    riso(`<path d="M10 18h44v28H10z"/>`, PINK, MUSTARD, 1.6, 1.6) +
    `<path d="M10 22H3l5 10-5 10h7M54 22h7l-5 10 5 10h-7" fill="${PINK}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
    letters('WAGMI', 32, 26.5, 10.5, INK, 2.3),
  // 2 · rocket, tilted for take-off
  2:
    dieCut(circleBase, MINT_PALE) +
    `<g transform="rotate(40 32 32)">` +
    `<path d="M27 44q5 12 5 14q0-2 5-14z" fill="${PINK}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>` +
    `<path d="M29.5 44q2.5 6 2.5 8q0-2 2.5-8z" fill="${MUSTARD}"/>` +
    riso(`<path d="M24 38l-5 7 7-1zM40 38l5 7-7-1z"/>`, TEAL, BLUE, 1, 1, 1.8) +
    riso(`<path d="M32 9c7 6 9 16 7 34h-14c-2-18 0-28 7-34z"/>`, CARD, AQUA, 1.6, 1.4) +
    `<path d="M26.4 18h11.2" stroke="${INK}" stroke-width="1.8"/>` +
    `<path d="M32 9c3 2.6 5 5.6 5.6 9H26.4c.6-3.4 2.6-6.4 5.6-9z" fill="${TEAL}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>` +
    face(32, 27, 4.4, AQUA, BLUE) +
    `</g>`,
  // 3 · diamond hands: a faceted gem with twinkles
  3:
    dieCut(circleBase) +
    riso(`<path d="M16 26l7-9h18l7 9-16 20z"/>`, AQUA, BLUE, 2, 2) +
    `<path d="M16 26h32M23 17l4 9 5-9 5 9 4-9M27 26l5 20 5-20" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<path d="M47 11l1.3 3.4 3.4 1.3-3.4 1.3L47 20.4l-1.3-3.4-3.4-1.3 3.4-1.3z" fill="${MUSTARD}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<path d="M15 41l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill="${PINK}" stroke="${INK}" stroke-width="1.1" stroke-linejoin="round"/>`,
  // 4 · rekt: a coin crying rivers
  4:
    dieCut(circleBase) +
    face(32, 32, 17, ORANGE, PINK) +
    `<path d="M22.5 27l5 2.5-5 2.5M41.5 27l-5 2.5 5 2.5" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M25 33c-1 5-2 9 0 14M39 33c1 5 2 9 0 14" fill="none" stroke="${AQUA}" stroke-width="3.2" stroke-linecap="round"/>` +
    `<path d="M27.5 41.5q4.5-4 9 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`,
  // 5 · yum: happy eyes, tongue out
  5:
    dieCut(circleBase) +
    face(32, 32, 17, MUSTARD, ORANGE) +
    `<path d="M23 29q3-4 6 0M35 29q3-4 6 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
    `<ellipse cx="21.5" cy="35" rx="3" ry="1.8" fill="${PINK}" opacity=".85"/><ellipse cx="42.5" cy="35" rx="3" ry="1.8" fill="${PINK}" opacity=".85"/>` +
    `<path d="M26 36q6 5 12 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
    `<path d="M33 38.6q.4 5.6 3.2 5.4 2.8-.2 2.2-6.6" fill="${PINK}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>`,
  // 6 · salute: a wink and a flat hand to the brow
  6:
    dieCut(circleBase) +
    face(30, 35, 15.5, TEAL, MINT) +
    `<ellipse cx="24.5" cy="33" rx="1.9" ry="2.6" fill="${INK}"/>` +
    `<path d="M32.5 33.5q2.5-2 5 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
    `<path d="M25.5 41.5q4 2.4 8 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
    `<path d="M47 22.5l7 8" stroke="${INK}" stroke-width="7" stroke-linecap="round"/><path d="M47 22.5l7 8" stroke="${TEAL}" stroke-width="3.6" stroke-linecap="round"/>` +
    `<g transform="rotate(-16 34 19)">` +
    riso(`<path d="M20.5 16h25a3.4 3.4 0 0 1 0 6.8h-25a3.4 3.4 0 0 1 0-6.8z"/><path d="M38 16q.6-4.6 4.4-4.2 2.2.4 1.6 4.2z"/>`, CARD, MUSTARD, 1.2, 1.2, 1.8) +
    `<path d="M22 19.4h21" stroke="${INK}" stroke-width="1.1" stroke-linecap="round" opacity=".6"/>` +
    `</g>`,
  // 7 · love: a heart die-cut
  7:
    dieCut(`<path d="M32 54C14 41 7 32 7 22.5 7 15 13 9.5 19.6 9.5c5.4 0 9.6 3.2 12.4 7.6 2.8-4.4 7-7.6 12.4-7.6C51 9.5 57 15 57 22.5 57 32 50 41 32 54z"/>`) +
    riso(
      `<path d="M32 48C18 38 13 31 13 23.6 13 18 17.3 14 22.2 14c4.4 0 7.6 2.8 9.8 6.6 2.2-3.8 5.4-6.6 9.8-6.6C46.7 14 51 18 51 23.6 51 31 46 38 32 48z"/>`,
      PINK,
      MUSTARD,
      2.2,
      2,
    ) +
    `<path d="M19.5 22q1-4.5 5.5-5" fill="none" stroke="${CARD}" stroke-width="2.6" stroke-linecap="round"/>`,  // ── "Trash talk" page (ids 8..15, protocol v11): attitude in the same riso hand, PG-13 ──
  // 8 · cursing: a red furious coin under a mustard banner of grawlix (#@$!), its mouth censored
  8:
    dieCut(`<circle cx="32" cy="38" r="22"/><rect x="7" y="3" width="50" height="19" rx="5"/>`) +
    face(32, 39, 16, RED, ORANGE) +
    `<path d="M21.5 31.5l7.5 3.4M42.5 31.5L35 34.9" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<circle cx="26" cy="37.6" r="2" fill="${INK}"/><circle cx="38" cy="37.6" r="2" fill="${INK}"/>` +
    `<rect x="23.5" y="43" width="17" height="6" rx="1.6" fill="${INK}"/>` +
    `<path d="M26 46h12" stroke="${CARD}" stroke-width="1.2" stroke-dasharray="2 1.6"/>` +
    riso(`<rect x="9.5" y="5.5" width="45" height="14" rx="3.5"/>`, MUSTARD, PINK, 1.4, 1.4, 1.8) +
    letters('#@$!', 32, 7.5, 10, INK, 2.3),
  // 9 · fuming: a scowling red coin blowing steam from both sides
  9:
    dieCut(circleBase) +
    face(32, 35, 16.5, RED, PINK) +
    `<g fill="${CARD}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round">` +
    `<path d="M9.5 21.5q-3.6-1.4-2-4.8 .4-3.8 4.4-3.2 2-3.4 5.6-1.2 3.4 0 2.8 3.6 2.4 2.6-.4 5.2z"/>` +
    `<path d="M54.5 21.5q3.6-1.4 2-4.8-.4-3.8-4.4-3.2-2-3.4-5.6-1.2-3.4 0-2.8 3.6-2.4 2.6.4 5.2z"/>` +
    `</g>` +
    `<path d="M21 28.5l8 3M43 28.5l-8 3" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>` +
    `<path d="M23.5 34.2h5M35.5 34.2h5" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M25 44.5q7-5.4 14 0" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`,
  // 10 · too cool: a sun coin in ink shades with a smirk
  10:
    dieCut(circleBase) +
    face(32, 33, 17, MUSTARD, ORANGE) +
    `<path d="M12.5 26.5h39v2.6c-1 6.6-3.6 9.4-8.6 9.4-5.4 0-7.6-4.4-8.4-8.4h-5c-.8 4-3 8.4-8.4 8.4-5 0-7.6-2.8-8.6-9.4z" fill="${INK}"/>` +
    `<path d="M18 30.5l3.6-2.4M38.6 30.5l3.6-2.4" stroke="${CARD}" stroke-width="1.8" stroke-linecap="round"/>` +
    `<path d="M26.5 44.5q6 3 11.5-2.2" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<path d="M49 12l1.2 3 3 1.2-3 1.2L49 20.4l-1.2-3-3-1.2 3-1.2z" fill="${CARD}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>`,
  // 11 · LOL: eyes squeezed shut, mouth wide open, tears flying
  11:
    dieCut(circleBase) +
    face(32, 33, 17, MUSTARD, ORANGE) +
    `<path d="M21.5 30l4.5-3.6 4.5 3.6M33.5 30l4.5-3.6 4.5 3.6" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M22.5 35.5h19c0 7.4-4.2 11.4-9.5 11.4s-9.5-4-9.5-11.4z" fill="${INK}"/>` +
    `<path d="M26.6 43.4q5.4-3.6 10.8 0q-2.2 2.6-5.4 2.6t-5.4-2.6z" fill="${PINK}"/>` +
    `<g fill="${AQUA}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round">` +
    `<path d="M14.5 27q-6 3.4-5.4 7.4 2.6 2.4 5.6-.6 1.4-3.4-.2-6.8z"/>` +
    `<path d="M49.5 27q6 3.4 5.4 7.4-2.6 2.4-5.6-.6-1.4-3.4.2-6.8z"/>` +
    `</g>`,
  // 12 · ROFL: the laughing coin rolled on its side, with motion strokes
  12:
    dieCut(circleBase, MINT_PALE) +
    `<path d="M8 50q4-1.4 8 0M48 14q4-1.4 8 0M50 21q3-1 6 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
    `<g transform="rotate(-32 32 34)">` +
    face(32, 34, 16, ORANGE, PINK) +
    `<path d="M22 31l4.4-3.4 4.4 3.4M33.2 31l4.4-3.4 4.4 3.4" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M23 36h18c0 6.8-4 10.6-9 10.6s-9-3.8-9-10.6z" fill="${INK}"/>` +
    `<path d="M27 43.2q5-3.4 10 0q-2 2.4-5 2.4t-5-2.4z" fill="${PINK}"/>` +
    `<path d="M15.6 28q-5.6 3-5 6.8 2.4 2.2 5.2-.6 1.2-3.2-.2-6.2z" fill="${AQUA}" stroke="${INK}" stroke-width="1.4"/>` +
    `</g>`,
  // 13 · dead: a cream skull with ink sockets
  13:
    dieCut(circleBase, MINT_PALE) +
    riso(`<path d="M32 10.5c-11.2 0-18.5 7.2-18.5 17.2 0 6 2.8 10.2 7 12.4v6.4c0 1.4 1 2.4 2.4 2.4h18.2c1.4 0 2.4-1 2.4-2.4v-6.4c4.2-2.2 7-6.4 7-12.4 0-10-7.3-17.2-18.5-17.2z"/>`, CARD, AQUA, 1.8, 1.8) +
    `<path d="M20.6 28.6c0-3.4 2.4-5.4 5-5.4s4.6 2.2 4.6 4.8c0 3-2.4 5.4-5.2 5.4-2.6 0-4.4-2-4.4-4.8zM43.4 28.6c0-3.4-2.4-5.4-5-5.4s-4.6 2.2-4.6 4.8c0 3 2.4 5.4 5.2 5.4 2.6 0 4.4-2 4.4-4.8z" fill="${INK}"/>` +
    `<path d="M32 34.5l-2.6 4.4h5.2z" fill="${INK}" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="M26.5 43.5v4.6M30.8 43.5v4.6M35.2 43.5v4.6M39.5 43.5v4.6" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>` +
    `<path d="M22 49.5h20" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>`,
  // 14 · eye roll: pupils parked at the top, a flat unimpressed mouth
  14:
    dieCut(circleBase) +
    face(32, 33, 17, TEAL, MINT) +
    `<circle cx="25" cy="30" r="5.4" fill="${CARD}" stroke="${INK}" stroke-width="1.8"/><circle cx="39" cy="30" r="5.4" fill="${CARD}" stroke="${INK}" stroke-width="1.8"/>` +
    `<circle cx="25.4" cy="26.6" r="2.4" fill="${INK}"/><circle cx="39.4" cy="26.6" r="2.4" fill="${INK}"/>` +
    `<path d="M20 22.4q4.4-2.6 9 -.6M35 21.8q4.6-2 9 .6" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
    `<path d="M26 42.6h10.4q2 0 3-1.4" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`,
  // 15 · take the L: a pink stamp with one big cream L
  15:
    dieCut(`<rect x="7" y="7" width="50" height="50" rx="9" transform="rotate(-6 32 32)"/>`) +
    `<g transform="rotate(-6 32 32)">` +
    riso(`<rect x="11.5" y="11.5" width="41" height="41" rx="6"/>`, PINK, MUSTARD, 1.8, 1.8) +
    `<g transform="translate(1.6 1.6)">${letters('L', 32, 15, 34, INK, 7.5)}</g>` +
    letters('L', 32, 15, 34, CARD, 7.5) +
    `<path d="M18 48.5h7M39 17.5h7" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>` +
    `</g>`,
};

/** Full SVG markup of an emote sticker (64 × 64 viewBox). */
export function stickerSvg(id: number, size = 64): string {
  const body = BODIES[id] ?? BODIES[0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${body}</svg>`;
}

const urls = new Map<number, string>();

/** A data URL for <img> / canvas use (cached). */
export function stickerUrl(id: number): string {
  let u = urls.get(id);
  if (!u) {
    u = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(stickerSvg(id, 128))}`;
    urls.set(id, u);
  }
  return u;
}

const images = new Map<number, HTMLImageElement>();

/** Decoded sticker image for the canvas, or null while it is still loading. */
export function stickerImage(id: number): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  let img = images.get(id);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = stickerUrl(id);
    images.set(id, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}
