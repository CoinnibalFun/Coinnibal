// X profile set for Coinnibal: the food chain under the ring (banner) and the chomp mark (avatar).
// The banner keeps the night-ring look of the earlier set: the lit ring overhead, the moon, seigaiha waves and the
// green hill, with a line of coins climbing it, each about to eat the smaller one ahead of it. No X handle is
// written anywhere (it is not final); the site host comes from `BRAND_SITE` (default coinnibal.fun).
import { C, coin, page, seigaiha, star, starfield, wordmark } from './art.mjs';

const SITE = (process.env.BRAND_SITE || 'coinnibal.fun').replace(/^https?:\/\//, '').replace(/\/+$/, '');

const at = (x, y, html, extra = '') => `<div class="abs" style="left:${x}px;top:${y}px;${extra}">${html}</div>`;

/** The ring habitat as a band along an SVG path: ink edge, deck, a lit window strip. */
const band = (d, w = 30, extra = '') => `
  <path d="${d}" fill="none" stroke="${C.ink}" stroke-width="${w}" stroke-linecap="butt" ${extra}/>
  <path d="${d}" fill="none" stroke="${C.current}" stroke-width="${w - 8}" stroke-linecap="butt" ${extra}/>
  <path d="${d}" fill="none" stroke="${C.reef}" stroke-width="${(w - 8) / 3}" stroke-linecap="butt" transform="translate(0 ${w / 5})" ${extra}/>
  <path d="${d}" fill="none" stroke="${C.sun}" stroke-width="${w / 6}" stroke-dasharray="2 ${w / 2.2}" stroke-linecap="round" ${extra}/>`;

/* ------------------------------------------------------------------ the chomp mark */

/** The C of Coinnibal as a mouth (apps/web/src/design/motifs/Wordmark.tsx `ChompMark`): keep the two in step. */
const CHOMP_C = 'M19.3 -23 A30 30 0 1 0 19.3 23';
const CHOMP_TEETH = 'M12 -9 L15.5 0 L19.5 -9.5Z M21.5 -10 L24.5 -2 L28 -10.5Z M12 9 L15.5 0 L19.5 9.5Z M21.5 10 L24.5 2 L28 10.5Z';

/** The chomp mark as an SVG group in its own (-52..62, -54..58) box: the C bites a scared gold coin. */
function chompMark({ crumbs = true } = {}) {
  const ink = C.ink;
  return `
    <defs>
      <clipPath id="x3-lit"><circle cx="-8" cy="-10" r="42"/></clipPath>
      <clipPath id="x3-in"><circle r="22"/></clipPath>
    </defs>
    <circle r="22" fill="${ink}"/>
    <ellipse cx="2" cy="14" rx="14" ry="7" fill="${C.blush}" clip-path="url(#x3-in)"/>
    <g>
      <circle cx="35" cy="0" r="12.5" fill="${C.sun}" stroke="${ink}" stroke-width="4"/>
      <circle cx="35" cy="0" r="7.5" fill="none" stroke="${C.sunS}" stroke-width="2.5"/>
      <circle cx="37.5" cy="-2.5" r="2.8" fill="#fff" stroke="${ink}" stroke-width="1.6"/>
      <circle cx="43.5" cy="-2.5" r="2.8" fill="#fff" stroke="${ink}" stroke-width="1.6"/>
      <ellipse cx="40.5" cy="5" rx="1.8" ry="2.4" fill="${ink}"/>
    </g>
    ${
      crumbs
        ? `<g fill="${C.sun}" stroke="${ink}" stroke-width="2.5">
      <circle cx="53" cy="-15" r="4"/><circle cx="46" cy="-26" r="2.8"/><circle cx="54" cy="13" r="3"/></g>`
        : ''
    }
    <g fill="none" stroke-linecap="round">
      <path d="${CHOMP_C}" stroke="${ink}" stroke-width="33" transform="translate(4 4)"/>
      <path d="${CHOMP_C}" stroke="${ink}" stroke-width="33"/>
      <path d="${CHOMP_C}" stroke="${C.cyanS}" stroke-width="24"/>
      <path d="${CHOMP_C}" stroke="${C.cyan}" stroke-width="24" clip-path="url(#x3-lit)"/>
      <path d="M-35 12 A36 36 0 0 1 -30 -18" stroke="#fff" stroke-width="4.5" opacity=".85"/>
    </g>
    <path d="${CHOMP_TEETH}" fill="#fff" stroke="${ink}" stroke-width="2.2" stroke-linejoin="round"/>
    <circle cx="-10" cy="-28" r="10.5" fill="#fff" stroke="${ink}" stroke-width="4"/>
    <circle cx="-6" cy="-25.5" r="5" fill="${ink}"/>
    <circle cx="-4.5" cy="-27.2" r="1.5" fill="#fff"/>
    <path d="M-24 -44 L1 -37" fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>`;
}

/* ------------------------------------------------------------------ avatar */

/**
 * The profile picture: a window onto the banner. The same night sky (deep at the top, teal at the horizon), the lit
 * ring overhead, the seigaiha waves and the green hill; the chomp mark (the C eating a coin) stands on the hill like
 * the coins of the banner. Everything that matters sits inside the circle X crops to, and reads at 32-48 px.
 */
export function xAvatar3() {
  const S = 400;
  const floor = 'M-20 318 C 100 300, 300 290, 420 282 V 420 H -20 Z';
  const floor2 = 'M-20 352 C 120 340, 300 332, 420 326 V 420 H -20 Z';
  const body = `
    <svg class="abs" style="inset:0" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
      <defs><linearGradient id="a3-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${C.deep}"/><stop offset=".5" stop-color="${C.trench}"/><stop offset=".82" stop-color="${C.teal}"/></linearGradient></defs>
      <rect width="${S}" height="${S}" fill="url(#a3-sky)"/>
    </svg>
    <div class="abs" style="left:0;top:0;opacity:.9">${starfield(S, 200, 14, 21)}</div>
    <div class="abs" style="left:0;top:170px;opacity:.35;-webkit-mask-image:linear-gradient(to bottom,transparent,#000 60%);mask-image:linear-gradient(to bottom,transparent,#000 60%)">${seigaiha({ w: S, h: 150, r: 26, stroke: C.spray, width: 2.5 })}</div>
    <svg class="abs" style="inset:0" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
      ${band('M-60 250 C 20 -10, 380 -10, 460 250', 30)}
      ${star(330, 150, 1.0, C.sun)}${star(64, 168, 0.9)}
      <path d="${floor}" fill="${C.verdant}" stroke="${C.ink}" stroke-width="4"/>
      <path d="M-20 328 C 100 310, 300 300, 420 292" fill="none" stroke="#7DBB72" stroke-width="6"/>
      <path d="${floor2}" fill="${C.forest}" stroke="${C.ink}" stroke-width="4"/>
      <ellipse cx="196" cy="300" rx="92" ry="9" fill="${C.ink}" opacity=".25"/>
      <g transform="translate(192 190) scale(2.45)">${chompMark()}</g>
    </svg>`;
  return { w: S, h: S, html: page({ w: S, h: S, body, bg: C.trench }) };
}

/* ------------------------------------------------------------------ banner */

/**
 * The banner, 1500 x 500. The middle band (y 60..440) carries everything that must read on phones (X crops the
 * top and bottom there), and the bottom-left corner, where the profile picture sits, holds only scenery.
 */
export function xBanner3() {
  const w = 1500;
  const h = 500;
  const css = `
    .title{position:absolute;left:515px;top:46px;transform:rotate(-2deg)}
    .line{position:absolute;left:0;width:1500px;top:178px;text-align:center;font-family:var(--display);font-style:italic;
      font-variation-settings:"SOFT" 100,"WONK" 1;font-weight:500;font-size:32px;color:${C.cream};transform:rotate(-2deg);letter-spacing:-.01em}
    .line b{font-style:normal;font-weight:800;color:${C.sun}}
    .site{position:absolute;right:62px;top:44px;transform:rotate(3deg);padding:11px 16px 12px;background:${C.sun};border-radius:14px}
    .site .k{font-family:var(--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase;font-weight:700}
    .site .n{font-family:var(--display);font-variation-settings:"SOFT" 100,"WONK" 1,"opsz" 144;font-weight:800;font-size:30px;line-height:1;margin-top:4px}
    .gain{position:absolute;font-family:var(--mono);font-weight:700;font-size:17px;color:${C.ink};background:${C.sun};
      border:3px solid ${C.ink};border-radius:999px;padding:5px 12px 4px;box-shadow:3px 3px 0 ${C.ink};white-space:nowrap}
    .gain small{font-size:12px;opacity:.75}`;
  const arc = 'M-80 340 C 220 -30, 1280 -30, 1580 340';
  const floor = 'M-20 430 C 380 412, 900 370, 1520 300 V 520 H -20 Z';
  const floor2 = 'M-20 462 C 400 448, 920 418, 1520 362 V 520 H -20 Z';
  const food = (x, y, c) => `<g transform="translate(${x} ${y})"><circle r="9" fill="${c}" opacity=".25"/><circle r="4.5" fill="${c}" stroke="${C.ink}" stroke-width="2"/></g>`;
  // a little bite arc ("chomp" lines) in front of a mouth
  const chomp = (x, y, flip = 1) =>
    `<g transform="translate(${x} ${y}) scale(${flip} 1)" stroke="${C.cream}" stroke-width="3.5" stroke-linecap="round" fill="none">
      <path d="M0 -14 l-12 -6"/><path d="M-2 0 l-15 0"/><path d="M0 14 l-12 6"/></g>`;
  const crumb = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.sun}" stroke="${C.ink}" stroke-width="2.5"/>`;
  const body = `
    <svg class="abs" style="inset:0" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <defs><linearGradient id="b3-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${C.deep}"/><stop offset=".55" stop-color="${C.trench}"/><stop offset="1" stop-color="${C.teal}"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#b3-sky)"/>
    </svg>
    <div class="abs" style="left:0;top:0;opacity:.9">${starfield(w, 300, 46, 29)}</div>
    <div class="abs" style="left:0;top:250px;opacity:.35;-webkit-mask-image:linear-gradient(to bottom,transparent,#000 60%);mask-image:linear-gradient(to bottom,transparent,#000 60%)">${seigaiha({ w, h: 200, r: 34, stroke: C.spray, width: 2.5 })}</div>
    <svg class="abs" style="inset:0" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      ${band(arc, 40)}
      <circle cx="200" cy="150" r="30" fill="${C.cream}" stroke="${C.ink}" stroke-width="4"/>
      <circle cx="191" cy="143" r="6" fill="${C.creamS}"/><circle cx="210" cy="160" r="4" fill="${C.creamS}"/>
      <path d="${floor}" fill="${C.verdant}" stroke="${C.ink}" stroke-width="4"/>
      <path d="M-20 442 C 380 424, 900 382, 1520 312" fill="none" stroke="#7DBB72" stroke-width="7"/>
      <path d="${floor2}" fill="${C.forest}" stroke="${C.ink}" stroke-width="4"/>
      <path d="M-20 474 C 400 460, 920 430, 1520 374" fill="none" stroke="#4C8F58" stroke-width="7" stroke-dasharray="160 60 90 110"/>
      ${food(392, 418, C.sun)}${food(470, 414, C.cyan)}${food(1360, 318, C.blush)}${food(1440, 306, C.sun)}
    </svg>
    <div class="title">${wordmark({ width: 470, diecut: true })}</div>
    <div class="line">Coins eating coins. <b>Eat or be eaten.</b></div>

    ${at(468, 352, coin('foam', { mood: 'scared', look: [-5, -1], sweat: true, size: 50 }), 'transform:rotate(-8deg)')}
    ${at(548, 322, coin('cyan', { mood: 'chomp', look: [-6, 1], size: 76 }), 'transform:rotate(-6deg)')}
    ${at(660, 278, coin('up', { mood: 'chomp', look: [-6, 1], size: 112 }), 'transform:rotate(-4deg)')}
    ${at(830, 214, coin('sun', { mood: 'chomp', look: [-7, 2], size: 168 }), 'transform:rotate(-6deg)')}
    <svg class="abs" style="inset:0" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      ${chomp(543, 360)}${chomp(655, 336)}${chomp(815, 300)}
      ${crumb(1022, 250, 5)}${crumb(1040, 230, 3.5)}${crumb(1012, 228, 3)}
    </svg>
    ${at(1150, 282, coin('teal', { mood: 'smug', look: [-4, 0], size: 70 }), 'transform:rotate(4deg)')}
    ${at(1262, 270, coin('cream', { mood: 'sleepy', size: 54 }))}

    <div class="site sticker"><div class="k">On Robinhood Chain</div><div class="n">${SITE}</div></div>`;
  return { w, h, html: page({ w, h, body, css, bg: C.trench }) };
}
