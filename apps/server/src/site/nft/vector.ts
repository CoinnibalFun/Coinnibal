/**
 * The vector emblem (the house style, docs/NFT-DESIGN.md): a 512 × 512 SVG portrait of an Elymum coin in
 * the Ring Storybook language: flat cel fills with one hard shade, a single 3 px ink line everywhere, no
 * gradients, no blur. The picture depends on the genome only (equal DNA, equal SVG); the token number is a
 * small tag on the frame.
 */
import { NFT_NAME } from '@elymum/shared';
import { BLUSH, CREAM, HOLO, INK, MATERIAL_SPECS, P, SHADES, TIER_FRAME, WHITE, type MaterialSpec } from './palette';
import type { Genome } from './traits';

/** Coin centre and scale: the reference coin is 46 units in radius, drawn at about 112 px. */
const CX = 256;
const CY = 296;
const K = 2.5;
/** The ink line: 3 px on the 512 canvas, in coin units inside the coin group. */
const LW = 3;
const W = +(LW / K).toFixed(3);

const ink = (w = W, color: string = INK) => `stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const f = (n: number) => +n.toFixed(2);

/* ------------------------------------------------------------------------------------------------ */
/* small shapes                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

function star4(x: number, y: number, r: number, fill: string, w = W): string {
  const i = r * 0.32;
  return `<path d="M${f(x)} ${f(y - r)} Q${f(x + i * 0.4)} ${f(y - i * 0.4)} ${f(x + r)} ${f(y)} Q${f(x + i * 0.4)} ${f(y + i * 0.4)} ${f(x)} ${f(y + r)} Q${f(x - i * 0.4)} ${f(y + i * 0.4)} ${f(x - r)} ${f(y)} Q${f(x - i * 0.4)} ${f(y - i * 0.4)} ${f(x)} ${f(y - r)}Z" fill="${fill}" ${ink(w)}/>`;
}

function star5(x: number, y: number, r: number, fill: string, w = W, rot = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = ((i * 36 + rot - 90) * Math.PI) / 180;
    const rr = i % 2 === 0 ? r : r * 0.48;
    pts.push(`${f(x + Math.cos(a) * rr)} ${f(y + Math.sin(a) * rr)}`);
  }
  return `<path d="M${pts.join(' L')}Z" fill="${fill}" ${ink(w)}/>`;
}

function heart(x: number, y: number, s: number, fill: string, w = W): string {
  return `<path d="M${f(x)} ${f(y + s * 0.9)} C${f(x - s * 1.4)} ${f(y)} ${f(x - s * 0.9)} ${f(y - s * 1.1)} ${f(x)} ${f(y - s * 0.35)} C${f(x + s * 0.9)} ${f(y - s * 1.1)} ${f(x + s * 1.4)} ${f(y)} ${f(x)} ${f(y + s * 0.9)}Z" fill="${fill}" ${ink(w)}/>`;
}

/** A small round coin (orbit coins, the treasury), px or units depending on the group. */
function miniCoin(x: number, y: number, r: number, fill: string, shade: string, w: number): string {
  return (
    `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${shade}" ${ink(w)}/>` +
    `<circle cx="${f(x - r * 0.12)}" cy="${f(y - r * 0.14)}" r="${f(r * 0.8)}" fill="${fill}"/>` +
    `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 0.55)}" fill="none" stroke="${shade}" stroke-width="${f(w * 0.8)}"/>` +
    `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="none" ${ink(w)}/>`
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* backgrounds (px, inside the frame window)                                                           */
/* ------------------------------------------------------------------------------------------------ */

const PX = LW;

function stars(points: readonly [number, number, number][], color: string = CREAM): string {
  return `<g fill="${color}">${points.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>`;
}

const STARFIELD: [number, number, number][] = [
  [60, 70, 2.2], [120, 130, 1.6], [190, 52, 2], [330, 60, 1.8], [420, 96, 2.4], [455, 170, 1.5], [70, 210, 1.7], [100, 300, 1.4],
  [440, 260, 1.9], [400, 40, 1.4], [250, 40, 1.5], [160, 190, 1.2], [370, 150, 1.3], [470, 360, 1.5], [44, 380, 1.6],
];

/** The ring (the game world's horizon arc) with its little lights. */
function ringArc(y0: number, color: string, lights: string): string {
  return (
    `<path d="M-20 ${y0 + 150} Q256 ${y0 - 120} 532 ${y0 + 150}" fill="none" stroke="${INK}" stroke-width="22"/>` +
    `<path d="M-20 ${y0 + 150} Q256 ${y0 - 120} 532 ${y0 + 150}" fill="none" stroke="${color}" stroke-width="16"/>` +
    `<path d="M-20 ${y0 + 150} Q256 ${y0 - 120} 532 ${y0 + 150}" fill="none" stroke="${lights}" stroke-width="3" stroke-dasharray="2 14" stroke-linecap="round"/>`
  );
}

function hills(bands: readonly [number, string, number][]): string {
  // each band: a wavy terrace top at y, its fill, and the wave phase
  return bands
    .map(([y, fill, ph]) => {
      const a = 14;
      const d = `M0 ${y} C${90 + ph} ${y - a} ${170 + ph} ${y + a} ${256} ${y} S${430 - ph} ${y - a} 512 ${y + 4} L512 512 L0 512Z`;
      return `<path d="${d}" fill="${fill}" ${ink(PX)}/>`;
    })
    .join('');
}

function tree(x: number, y: number, s: number, fill: string): string {
  return `<path d="M${x} ${y} L${x} ${y - 10 * s}" ${ink(PX)}/><circle cx="${x}" cy="${y - 16 * s}" r="${8 * s}" fill="${fill}" ${ink(PX)}/>`;
}

function cloud(x: number, y: number, s: number, fill: string = CREAM): string {
  return `<path d="M${x - 34 * s} ${y} Q${x - 36 * s} ${y - 16 * s} ${x - 18 * s} ${y - 16 * s} Q${x - 12 * s} ${y - 32 * s} ${x + 6 * s} ${y - 26 * s} Q${x + 24 * s} ${y - 34 * s} ${x + 30 * s} ${y - 14 * s} Q${x + 42 * s} ${y - 12 * s} ${x + 38 * s} ${y} Z" fill="${fill}" ${ink(PX)}/>`;
}

function seigaiha(fill: string, line: string, step = 48): string {
  const out: string[] = [];
  for (let row = 0, y = 0; y < 560; row++, y += step / 2) {
    for (let x = row % 2 ? step / 2 : 0; x < 560; x += step) {
      out.push(
        `<path d="M${x - step / 2} ${y} A${step / 2} ${step / 2} 0 0 1 ${x + step / 2} ${y}Z" fill="${fill}" stroke="${line}" stroke-width="2.5"/>` +
          `<path d="M${x - step / 3} ${y} A${step / 3} ${step / 3} 0 0 1 ${x + step / 3} ${y} M${x - step / 6} ${y} A${step / 6} ${step / 6} 0 0 1 ${x + step / 6} ${y}" fill="none" stroke="${line}" stroke-width="2.5"/>`,
      );
    }
  }
  return out.join('');
}

function rays(n: number, a: string, b: string, cy: number): string {
  const out = [`<rect width="512" height="512" fill="${a}"/>`];
  for (let i = 0; i < n; i += 2) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    out.push(`<path d="M${CX} ${cy} L${f(CX + Math.cos(a0) * 800)} ${f(cy + Math.sin(a0) * 800)} L${f(CX + Math.cos(a1) * 800)} ${f(cy + Math.sin(a1) * 800)}Z" fill="${b}"/>`);
  }
  return out.join('');
}

const BACKGROUND: Record<Genome['background'], () => string> = {
  'Dawn Plain': () =>
    `<rect width="512" height="512" fill="${P.mist}"/>` +
    `<circle cx="392" cy="180" r="46" fill="${P.sun}" ${ink(PX)}/>` +
    cloud(110, 130, 1.1) +
    cloud(420, 84, 0.7) +
    hills([
      [330, P.meadow, 0],
      [392, P.clover, 40],
      [452, P.verdant, -30],
    ]) +
    tree(64, 330, 1, P.forest) +
    tree(92, 338, 0.8, P.verdant) +
    tree(446, 336, 1, P.forest),
  Shallows: () =>
    `<rect width="512" height="512" fill="${P.mist}"/>` +
    cloud(390, 120, 1.2, WHITE) +
    cloud(110, 80, 0.8, WHITE) +
    `<rect y="320" width="512" height="200" fill="${P.spray}" ${ink(PX)}/>` +
    `<g fill="none" stroke="${WHITE}" stroke-width="3" stroke-linecap="round">` +
    [350, 390, 430, 470].map((y, i) => `<path d="M${30 + i * 40} ${y} q12 -8 24 0 t24 0 M${330 - i * 30} ${y + 14} q12 -8 24 0 t24 0"/>`).join('') +
    `</g>`,
  Seigaiha: () => `<rect width="512" height="512" fill="${P.linen}"/>` + seigaiha(P.linen, P.sand2),
  'Night Ring': () =>
    `<rect width="512" height="512" fill="${P.trench}"/>` +
    stars(STARFIELD) +
    ringArc(150, P.current, P.sun) +
    `<path d="M0 420 Q140 380 256 400 T512 392 L512 512 L0 512Z" fill="${P.reef}" ${ink(PX)}/>`,
  'Sunset Ring': () =>
    `<rect width="512" height="512" fill="${P.coral}"/>` +
    `<path d="M0 150 Q256 120 512 150 L512 512 L0 512Z" fill="${P.blush}"/>` +
    `<path d="M0 250 Q256 222 512 250 L512 512 L0 512Z" fill="${P.sun}"/>` +
    `<circle cx="256" cy="380" r="120" fill="${P.cream}" ${ink(PX)}/>` +
    ringArc(170, P.coral, P.cream) +
    `<path d="M0 400 Q130 370 256 392 T512 384 L512 512 L0 512Z" fill="${P.copperS}" ${ink(PX)}/>`,
  'Deep Sea': () =>
    `<rect width="512" height="512" fill="${P.teal}"/>` +
    `<g fill="${P.foam}" opacity=".18"><path d="M90 0 L150 0 L60 512 L-10 512Z"/><path d="M300 0 L340 0 L300 512 L230 512Z"/><path d="M430 0 L470 0 L520 512 L450 512Z"/></g>` +
    `<path d="M0 430 Q120 400 256 420 T512 410 L512 512 L0 512Z" fill="${P.current}" ${ink(PX)}/>` +
    `<path d="M60 440 C40 380 80 350 60 290 C90 340 70 380 90 440Z" fill="${P.verdant}" ${ink(PX)}/>` +
    `<path d="M440 440 C460 390 420 350 446 300 C420 330 470 380 466 440Z" fill="${P.forest}" ${ink(PX)}/>` +
    [
      [110, 160, 9],
      [80, 110, 5],
      [420, 200, 7],
      [400, 140, 4],
      [452, 96, 6],
    ]
      .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${P.mist}" ${ink(PX)}/><circle cx="${x - r / 3}" cy="${y - r / 3}" r="${r / 3.5}" fill="${WHITE}"/>`)
      .join(''),
  'Moon Night': () =>
    `<rect width="512" height="512" fill="${P.reef}"/>` +
    stars(STARFIELD) +
    star4(80, 90, 9, P.sun, PX) +
    star4(440, 260, 6, P.cream, PX) +
    `<circle cx="400" cy="120" r="56" fill="${P.cream}" ${ink(PX)}/>` +
    `<circle cx="384" cy="104" r="11" fill="${SHADES.cream}" ${ink(PX)}/><circle cx="420" cy="140" r="8" fill="${P.sand2}" ${ink(PX)}/><circle cx="378" cy="146" r="5" fill="${P.sand2}" ${ink(PX)}/>` +
    `<path d="M0 410 Q120 370 240 396 T512 380 L512 512 L0 512Z" fill="${P.trench}" ${ink(PX)}/>`,
  Aurora: () =>
    `<rect width="512" height="512" fill="${P.deep}"/>` +
    stars(STARFIELD) +
    `<path d="M-10 170 C100 90 200 230 300 140 S460 90 530 150 L530 210 C430 160 380 260 280 220 S90 170 -10 250Z" fill="${P.up}" opacity=".9"/>` +
    `<path d="M-10 120 C110 60 190 160 300 100 S450 50 530 100 L530 130 C420 100 380 170 290 150 S100 110 -10 170Z" fill="${P.violet}" opacity=".85"/>` +
    `<path d="M-10 230 C120 180 220 290 330 220 S470 190 530 230 L530 250 C430 230 360 300 300 280 S120 230 -10 280Z" fill="${P.foam}" opacity=".6"/>` +
    `<path d="M0 420 L80 360 L140 410 L230 340 L320 420 L400 350 L512 430 L512 512 L0 512Z" fill="${P.reef}" ${ink(PX)}/>` +
    `<path d="M230 340 L250 360 L238 362 L222 352Z M80 360 L94 372 L70 374Z M400 350 L418 366 L392 364Z" fill="${P.mist}"/>`,
  Treasury: () =>
    `<rect width="512" height="512" fill="${P.reef}"/>` +
    `<g opacity=".5">${seigaiha(P.reef, P.current, 64)}</g>` +
    [
      [70, 470, 30], [130, 486, 26], [400, 472, 32], [460, 486, 28], [100, 432, 22], [430, 432, 24], [40, 420, 18], [480, 418, 18],
      [180, 494, 22], [330, 494, 22],
    ]
      .map(([x, y, r]) => miniCoin(x, y, r, P.sun, SHADES.sun, PX))
      .join('') +
    star4(70, 380, 10, WHITE, PX) +
    star4(446, 370, 8, WHITE, PX) +
    star4(150, 420, 6, WHITE, PX),
  Cosmos: () =>
    `<rect width="512" height="512" fill="${P.deep}"/>` +
    `<path d="M-20 120 C80 60 180 140 260 90 S420 40 540 90 L540 180 C420 140 330 220 230 180 S60 170 -20 220Z" fill="${P.violet}" opacity=".35"/>` +
    `<path d="M-20 300 C100 260 160 340 280 300 S440 260 540 300 L540 360 C430 330 330 390 240 360 S80 330 -20 370Z" fill="${P.teal}" opacity=".35"/>` +
    stars(STARFIELD) +
    stars([
      [30, 140, 1.3], [210, 120, 1.2], [300, 210, 1.1], [488, 210, 1.3], [140, 250, 1.1], [360, 340, 1.2], [60, 460, 1.3], [470, 450, 1.2],
    ]) +
    `<g transform="rotate(-18 96 110)"><ellipse cx="96" cy="110" rx="66" ry="14" fill="none" stroke="${INK}" stroke-width="12"/><ellipse cx="96" cy="110" rx="66" ry="14" fill="none" stroke="${P.sun}" stroke-width="7"/>` +
    `<circle cx="96" cy="110" r="34" fill="${P.coral}" ${ink(PX)}/><path d="M66 100 Q96 92 126 102" fill="none" stroke="${P.copperS}" stroke-width="4"/>` +
    `<path d="M30 110 A66 14 0 0 0 162 110" fill="none" stroke="${INK}" stroke-width="12"/><path d="M30 110 A66 14 0 0 0 162 110" fill="none" stroke="${P.sun}" stroke-width="7"/></g>` +
    star4(430, 80, 12, P.cream, PX) +
    `<path d="M300 40 L380 70" stroke="${P.cream}" stroke-width="3" stroke-linecap="round"/>` +
    star4(384, 72, 6, P.cream, PX),
  'Golden Rays': () => rays(28, P.sun, '#F7D27A', CY) + `<circle cx="${CX}" cy="${CY}" r="190" fill="none" stroke="${P.cream}" stroke-width="3" stroke-dasharray="3 12" stroke-linecap="round"/>`,
  Eclipse: () =>
    `<rect width="512" height="512" fill="${INK}"/>` +
    stars(STARFIELD) +
    `<circle cx="${CX}" cy="${CY}" r="176" fill="${P.sun}" opacity=".18"/>` +
    `<circle cx="${CX}" cy="${CY}" r="160" fill="${P.sun}" ${ink(PX)}/>` +
    `<circle cx="${CX}" cy="${CY}" r="150" fill="${P.cream}"/>` +
    `<circle cx="${CX}" cy="${CY}" r="146" fill="${P.deep}" ${ink(PX)}/>`,
  Abyss: () =>
    `<rect width="512" height="512" fill="${P.deep}"/>` +
    stars(STARFIELD.map(([x, y, r]) => [x, (y * 1.7) % 500, r + 0.6] as [number, number, number]), P.spray) +
    `<g fill="none" stroke="${P.current}" stroke-width="3">${[160, 200, 240].map((r) => `<circle cx="${CX}" cy="${CY}" r="${r}"/>`).join('')}</g>`,
  Prism: () => {
    const out = [`<rect width="512" height="512" fill="${HOLO[0]}"/>`];
    for (let i = -12; i < 24; i++) out.push(`<path d="M${i * 44} 0 L${i * 44 + 44} 0 L${i * 44 - 256} 512 L${i * 44 - 300} 512Z" fill="${HOLO[((i % 5) + 5) % 5]}"/>`);
    return out.join('') + stars(STARFIELD, WHITE);
  },
  Origin: () =>
    rays(36, P.mist, P.foam, 340) +
    hills([
      [380, P.meadow, 0],
      [440, P.verdant, 30],
    ]),
};

/* ------------------------------------------------------------------------------------------------ */
/* the coin (units: radius 46, centre 0 0)                                                             */
/* ------------------------------------------------------------------------------------------------ */

const R = 46;

function materialBody(spec: MaterialSpec): string {
  const clip = `clip-path="url(#coin)"`;
  const parts: string[] = [`<circle r="${R}" fill="${spec.shade}"/>`, `<g ${clip}>`, `<circle cx="-6" cy="-8" r="${R}" fill="${spec.fill}"/>`];
  switch (spec.kind) {
    case 'paint':
      parts.push(`<circle r="37.5" fill="none" stroke="${spec.shade}" stroke-width="2.5" opacity=".9"/>`);
      break;
    case 'metal':
    case 'ancient': {
      // the reeded edge, a stamped inner ring, two hard shine stripes
      const ticks: string[] = [];
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        ticks.push(`M${f(Math.cos(a) * 41)} ${f(Math.sin(a) * 41)} L${f(Math.cos(a) * 46)} ${f(Math.sin(a) * 46)}`);
      }
      parts.push(`<path d="${ticks.join(' ')}" stroke="${spec.shade}" stroke-width="1.3"/>`);
      parts.push(`<circle r="40.5" fill="none" stroke="${spec.shade}" stroke-width="1.6"/>`);
      parts.push(`<circle r="35" fill="none" stroke="${spec.shade}" stroke-width="1.1" stroke-dasharray="0.1 3.2" stroke-linecap="round"/>`);
      parts.push(`<path d="M-30 -42 L-14 -42 L-46 14 L-52 0Z M-6 -46 L0 -46 L-36 24 L-40 18Z" fill="${WHITE}" opacity=".5"/>`);
      if (spec.kind === 'ancient') {
        parts.push(`<g fill="${spec.detail}" opacity=".8"><ellipse cx="26" cy="26" rx="9" ry="5" transform="rotate(-30 26 26)"/><ellipse cx="-30" cy="22" rx="5" ry="3"/><ellipse cx="34" cy="-18" rx="4" ry="6"/><circle cx="12" cy="36" r="2.5"/></g>`);
      }
      break;
    }
    case 'stone':
      parts.push(
        `<g fill="none" stroke="${spec.detail}" stroke-width="1.6" stroke-linecap="round" opacity=".9">` +
          `<path d="M-46 -12 C-30 -20 -24 -4 -8 -12 S20 -30 30 -22"/><path d="M-40 26 C-24 16 -8 34 10 24 S34 30 46 18"/><path d="M14 -44 C10 -34 22 -30 18 -20"/>` +
          `</g><g fill="${spec.shade}" opacity=".55"><circle cx="30" cy="8" r="2.4"/><circle cx="-24" cy="38" r="1.8"/><circle cx="-36" cy="-24" r="1.5"/></g>`,
      );
      parts.push(`<circle r="40" fill="none" stroke="${spec.shade}" stroke-width="2" opacity=".9"/>`);
      break;
    case 'pearl':
      parts.push(
        `<ellipse cx="18" cy="-16" rx="24" ry="14" fill="${P.pink}" opacity=".45" transform="rotate(-30 18 -16)"/>` +
          `<ellipse cx="-20" cy="20" rx="22" ry="12" fill="${P.foam}" opacity=".45" transform="rotate(-30 -20 20)"/>` +
          `<ellipse cx="10" cy="26" rx="14" ry="8" fill="${P.lilac}" opacity=".35" transform="rotate(-30 10 26)"/>`,
      );
      parts.push(`<circle r="39" fill="none" stroke="${spec.shade}" stroke-width="2" opacity=".9"/>`);
      break;
    case 'glass':
      parts.push(
        `<g fill="${spec.detail}"><path d="M-46 -6 L-20 -40 L-6 -46 L-30 -4Z"/><path d="M10 46 L40 10 L46 18 L24 46Z"/><path d="M-8 8 L14 -10 L20 -2 L-2 16Z" opacity=".5"/></g>` +
          `<g fill="none" stroke="${P.obsidianS}" stroke-width="1.4"><path d="M-46 -6 L-30 -4 L-2 16 L24 46 M-30 -4 L-20 -40 M-2 16 L14 -10 L40 10"/></g>`,
      );
      parts.push(`<path d="M-40 -18 A42 42 0 0 1 -14 -40" fill="none" stroke="${P.spray}" stroke-width="2.4" stroke-linecap="round"/>`);
      break;
    case 'crystal':
      parts.push(
        `<g stroke="${WHITE}" stroke-width="1.6" stroke-linejoin="round">` +
          `<path d="M0 -46 L-24 -14 L0 4Z" fill="${WHITE}" opacity=".55"/><path d="M0 4 L24 -14 L46 6 L28 30Z" fill="${spec.shade}" opacity=".55"/>` +
          `<path d="M-24 -14 L-46 6 L-26 32 L0 4Z" fill="${P.mist}" opacity=".7"/><path d="M-26 32 L0 46 L28 30 L0 4Z" fill="${spec.shade}" opacity=".35"/>` +
          `<path d="M0 -46 L24 -14 L0 4" fill="none"/></g>`,
      );
      break;
    case 'holo': {
      const bands: string[] = [];
      for (let i = -8; i < 8; i++) bands.push(`<rect x="${i * 10}" y="-80" width="10.5" height="160" fill="${HOLO[((i % 5) + 5) % 5]}"/>`);
      parts.push(`<g transform="rotate(35)">${bands.join('')}</g>`);
      parts.push(`<path d="M${R} 0 A${R} ${R} 0 0 1 -12 44 A${R} ${R} 0 0 0 ${R - 6} -8Z" fill="${INK}" opacity=".14"/>`);
      parts.push(`<circle r="39" fill="none" stroke="${WHITE}" stroke-width="2" opacity=".8"/>`);
      break;
    }
    case 'molten':
      parts.push(
        `<g fill="none" stroke-linecap="round" stroke-linejoin="round">` +
          `<path d="M-46 -4 L-26 -10 L-18 6 L4 0 L10 -20 L30 -26 M4 0 L14 22 L36 26 M-18 6 L-26 30 L-10 44 M10 -20 L0 -44" stroke="${P.coral}" stroke-width="5"/>` +
          `<path d="M-46 -4 L-26 -10 L-18 6 L4 0 L10 -20 L30 -26 M4 0 L14 22 L36 26 M-18 6 L-26 30 L-10 44 M10 -20 L0 -44" stroke="${P.sun}" stroke-width="2.4"/>` +
          `</g>`,
      );
      break;
    case 'void':
      parts.push(
        stars([
          [-28, -20, 1], [20, -30, 1.2], [30, 18, 0.9], [-20, 30, 1], [6, 38, 0.8], [-38, 6, 0.8], [36, -6, 1.1], [-6, -38, 0.9],
        ]) +
          `<path d="M-10 26 C-30 20 -20 0 0 6 C14 10 6 26 -6 22" fill="none" stroke="${P.violet}" stroke-width="2" opacity=".9"/>`,
      );
      parts.push(`<path d="M-40 -18 A42 42 0 0 1 -14 -40" fill="none" stroke="${P.spray}" stroke-width="2.4" stroke-linecap="round"/>`);
      break;
    case 'moon':
      parts.push(
        `<g fill="${spec.shade}" stroke="${INK}" stroke-width="${W * 0.7}"><circle cx="26" cy="-20" r="6"/><circle cx="-30" cy="24" r="5"/><circle cx="20" cy="30" r="3.5"/><circle cx="-34" cy="-10" r="2.6"/></g>`,
      );
      break;
  }
  parts.push(`</g>`);
  if (spec.kind !== 'glass' && spec.kind !== 'void') {
    parts.push(`<path d="M-36 -10 A37 37 0 0 1 -18 -32" stroke="${WHITE}" stroke-width="5" fill="none" stroke-linecap="round" opacity=".85"/>`);
  }
  parts.push(`<circle r="${R}" fill="none" ${ink()}/>`);
  // dark materials get a rim light, so the silhouette holds on a night background
  if (spec.dark) parts.push(`<circle r="${R + W * 1.4}" fill="none" stroke="${spec.glow}" stroke-width="${W * 1.2}" opacity=".9"/>`);
  return parts.join('');
}

/* eyes ------------------------------------------------------------------------------------------- */

function eyeWhite(x: number, face: string, ry = 12.5): string {
  return `<ellipse cx="${x}" cy="-6" rx="10" ry="${ry}" fill="${WHITE}" ${ink(W, face === INK ? INK : INK)}/>`;
}

function roundEye(x: number, face: string, lx = 1.5, ly = 1, pupil = 6): string {
  return eyeWhite(x, face) + `<circle cx="${x + lx}" cy="${-5 + ly}" r="${pupil}" fill="${INK}"/><circle cx="${x + lx - 2.2}" cy="${-8 + ly}" r="2.1" fill="${WHITE}"/>`;
}

function eyes(g: Genome, spec: MaterialSpec): string {
  const face = spec.face;
  const line = ink(W, face);
  const arcUp = (x: number) => `<path d="M${x - 8} -4 Q${x} -15 ${x + 8} -4" fill="none" ${line}/>`;
  switch (g.eyes) {
    case 'Round':
      return roundEye(-15, face) + roundEye(15, face);
    case 'Happy':
      return arcUp(-15) + arcUp(15);
    case 'Sleepy':
      return `<path d="M-24 -6 Q-15 2 -6 -6 M6 -6 Q15 2 24 -6" fill="none" ${line}/><path d="M-21 -1 l-2 3 M-15 1 l0 3.5 M-9 -1 l2 3 M9 -1 l-2 3 M15 1 l0 3.5 M21 -1 l2 3" ${ink(W * 0.8, face)}/>`;
    case 'Wink':
      return roundEye(-15, face) + arcUp(15);
    case 'Smug':
      return [-15, 15]
        .map(
          (x) =>
            eyeWhite(x, face) +
            `<circle cx="${x + 3}" cy="-3" r="5.5" fill="${INK}"/><circle cx="${x + 1}" cy="-5" r="1.8" fill="${WHITE}"/>` +
            `<path d="M${x - 11} -6 L${x + 11} -6 A11 13 0 0 0 ${x - 11} -6Z" fill="${spec.fill}" ${ink()}/>`,
        )
        .join('');
    case 'Determined':
      return roundEye(-15, face, 1, -1) + roundEye(15, face, -1, -1) + `<path d="M-26 -24 L-8 -18 M26 -24 L8 -18" fill="none" ${ink(W * 1.25, face)}/>`;
    case 'Dizzy':
      return [-15, 15]
        .map((x) => eyeWhite(x, face) + `<path d="M${x} -6 m0 -1 a1.5 1.5 0 1 1 -1.5 1.5 a3 3 0 1 1 3 3 a4.6 4.6 0 1 1 -4.6 -4.6 a6.2 6.2 0 1 1 6.2 6.2" fill="none" ${ink(W * 0.8)}/>`)
        .join('');
    case 'Star':
      return [-15, 15].map((x) => eyeWhite(x, face) + star5(x, -5.5, 7.5, P.sun, W * 0.8)).join('');
    case 'Shades':
      return (
        `<path d="M-30 -14 L30 -14" ${ink(W * 1.4)}/>` +
        `<path d="M-28 -15 L-4 -15 Q-3 2 -16 3 Q-28 3 -28 -15Z M4 -15 L28 -15 Q28 3 16 3 Q3 2 4 -15Z" fill="${INK}" ${ink()}/>` +
        `<path d="M-22 -12 L-14 -12 L-20 -2Z M10 -12 L18 -12 L12 -2Z" fill="${WHITE}" opacity=".75"/>` +
        `<path d="M-4 -12 Q0 -15 4 -12" fill="none" ${ink()}/>`
      );
    case 'Heart':
      return [-15, 15].map((x) => heart(x, -6, 10, P.coral)).join('');
    case 'Glow':
      return [-15, 15]
        .map(
          (x) =>
            `<ellipse cx="${x}" cy="-6" rx="15" ry="17" fill="${spec.glow}" opacity=".35"/>` +
            `<ellipse cx="${x}" cy="-6" rx="10" ry="12.5" fill="${spec.glow}" ${ink()}/>` +
            `<ellipse cx="${x}" cy="-6" rx="4.5" ry="7" fill="${WHITE}"/>`,
        )
        .join('');
  }
}

/* mouths ----------------------------------------------------------------------------------------- */

function mouth(g: Genome, spec: MaterialSpec): string {
  const face = spec.face;
  const line = ink(W, face);
  const openFill = spec.dark ? INK : INK;
  switch (g.mouth) {
    case 'Smile':
      return `<path d="M-9 13 Q0 22 9 13" fill="none" ${line}/>`;
    case 'Grin':
      return `<path d="M-13 11 Q0 13 13 11 Q12 27 0 27 Q-12 27 -13 11Z" fill="${openFill}" ${line}/><path d="M-11.5 12 Q0 14 11.5 12 L11 16 Q0 18 -11 16Z" fill="${WHITE}"/><path d="M-6 23 Q0 19 6 23 Q3 26 0 26 Q-3 26 -6 23Z" fill="${BLUSH}"/>`;
    case 'Cat':
      return `<path d="M-10 14 Q-5 20 0 14 Q5 20 10 14" fill="none" ${line}/>`;
    case 'Ooh':
      return `<ellipse cx="0" cy="18" rx="4.5" ry="5.5" fill="${openFill}" ${line}/>`;
    case 'Smirk':
      return `<path d="M-7 16 Q3 20 12 11" fill="none" ${line}/><path d="M10 9 L13 12" ${line}/>`;
    case 'Tongue':
      return `<path d="M-10 13 Q0 20 10 13" fill="none" ${line}/><path d="M-2 16 L-2 22 Q2 28 6 22 L6 15" fill="${BLUSH}" ${line}/><path d="M2 18 L2 22" ${ink(W * 0.7)}/>`;
    case 'Fang':
      return `<path d="M-11 13 Q0 20 11 13" fill="none" ${line}/><path d="M-6 15.6 L-4 21 L-2 16.6Z M2 16.6 L4 21 L6 15.6Z" fill="${WHITE}" ${ink(W * 0.8)}/>`;
    case 'Chomp':
      return `<path d="M-20 8 Q0 4 20 8 Q20 38 0 38 Q-20 38 -20 8Z" fill="${openFill}" ${line}/><path d="M-14 8.6 l4 6 l4 -6 M6 8.6 l4 6 l4 -6" fill="${WHITE}"/><path d="M-10 32 Q0 25 10 32 Q5 36 0 36 Q-5 36 -10 32Z" fill="${BLUSH}"/>`;
    case 'Gold Tooth':
      return `<path d="M-13 11 Q0 13 13 11 Q12 27 0 27 Q-12 27 -13 11Z" fill="${openFill}" ${line}/><path d="M-11.5 12 Q0 14 11.5 12 L11 16 Q0 18 -11 16Z" fill="${WHITE}"/><rect x="2" y="12.4" width="5" height="4.6" fill="${P.sun}" ${ink(W * 0.6)}/><path d="M-6 23 Q0 19 6 23 Q3 26 0 26 Q-3 26 -6 23Z" fill="${BLUSH}"/>`;
  }
}

/* headwear (drawn over the coin) ------------------------------------------------------------------ */

function headwear(g: Genome, spec: MaterialSpec): { back: string; front: string } {
  const l = ink();
  switch (g.headwear) {
    case 'None':
      return { back: '', front: '' };
    case 'Cap':
      return {
        back: '',
        front:
          `<path d="M-34 -30 C-36 -62 28 -66 32 -34 Q0 -42 -34 -30Z" fill="${P.coral}" ${l}/>` +
          `<path d="M-2 -60 Q-6 -46 -6 -36" fill="none" ${ink(W * 0.8)}/>` +
          `<path d="M28 -36 Q48 -44 60 -34 Q50 -27 30 -30Z" fill="${P.copperS}" ${l}/>` +
          `<circle cx="-2" cy="-61" r="3" fill="${P.sun}" ${l}/>`,
      };
    case 'Beanie':
      return {
        back: '',
        front:
          `<path d="M-36 -26 C-40 -70 40 -70 36 -26Z" fill="${P.teal}" ${l}/>` +
          `<path d="M-38 -24 Q0 -38 38 -24 L36 -34 Q0 -46 -36 -34Z" fill="${P.cream}" ${l}/>` +
          `<path d="M-24 -38 L-24 -32 M-12 -41 L-12 -35 M0 -42 L0 -36 M12 -41 L12 -35 M24 -38 L24 -32" ${ink(W * 0.7)}/>` +
          `<circle cx="0" cy="-64" r="7" fill="${P.cream}" ${l}/>`,
      };
    case 'Flower':
      return {
        back: '',
        front: (() => {
          const cx = 26;
          const cy = -40;
          const petals = [0, 72, 144, 216, 288]
            .map((a) => `<ellipse cx="${cx}" cy="${cy - 8}" rx="5.5" ry="8" fill="${WHITE}" ${l} transform="rotate(${a + 10} ${cx} ${cy})"/>`)
            .join('');
          return `<path d="M${cx - 4} ${cy + 8} Q${cx - 12} ${cy + 12} ${cx - 16} ${cy + 6} Q${cx - 8} ${cy + 2} ${cx - 4} ${cy + 8}Z" fill="${P.clover}" ${l}/>` + petals + `<circle cx="${cx}" cy="${cy}" r="5.5" fill="${P.sun}" ${l}/>`;
        })(),
      };
    case 'Party Hat':
      return {
        back: '',
        front:
          `<g transform="rotate(14 8 -40)"><path d="M-12 -38 L8 -86 L28 -38 Q8 -32 -12 -38Z" fill="${P.violet}" ${l}/>` +
          `<path d="M-4 -56 L16 -60 M-8 -46 L22 -50 M1 -68 L13 -70" stroke="${P.sun}" stroke-width="4" stroke-linecap="round"/>` +
          `<path d="M-12 -38 L8 -86 L28 -38 Q8 -32 -12 -38Z" fill="none" ${l}/>` +
          `<circle cx="8" cy="-88" r="6" fill="${P.sun}" ${l}/></g>`,
      };
    case 'Sprout':
      return {
        back: '',
        front:
          `<path d="M0 -44 Q-2 -56 2 -66" fill="none" ${ink(W * 1.2)}/>` +
          `<path d="M2 -64 C-6 -80 -26 -78 -28 -70 C-20 -60 -4 -60 2 -64Z" fill="${P.clover}" ${l}/>` +
          `<path d="M2 -64 C10 -84 30 -82 32 -72 C22 -62 8 -62 2 -64Z" fill="${P.verdant}" ${l}/>`,
      };
    case 'Propeller':
      return {
        back: '',
        front:
          `<path d="M-30 -34 C-30 -62 30 -62 30 -34 Q0 -42 -30 -34Z" fill="${P.sun}" ${l}/>` +
          `<path d="M-30 -34 C-26 -52 -10 -58 0 -58 L0 -38 Q-16 -38 -30 -34Z" fill="${P.coral}"/>` +
          `<path d="M30 -34 C26 -52 10 -58 0 -58 L0 -38 Q16 -38 30 -34Z" fill="${P.cyan}"/>` +
          `<path d="M-30 -34 C-30 -62 30 -62 30 -34 Q0 -42 -30 -34Z" fill="none" ${l}/>` +
          `<path d="M0 -58 L0 -66" ${l}/>` +
          `<path d="M0 -67 Q-14 -76 -30 -70 Q-16 -62 0 -67Z M0 -67 Q14 -58 30 -64 Q16 -74 0 -67Z" fill="${P.cyan}" ${l}/>` +
          `<circle cx="0" cy="-67" r="3" fill="${P.coral}" ${l}/>`,
      };
    case 'Cowboy':
      return {
        back: '',
        front:
          `<path d="M-58 -36 Q-62 -50 -48 -46 Q0 -26 48 -46 Q62 -50 58 -36 Q0 -14 -58 -36Z" fill="${P.tan}" ${l}/>` +
          `<path d="M-28 -40 C-32 -76 -12 -70 0 -62 C12 -70 32 -76 28 -40 Q0 -32 -28 -40Z" fill="${P.tan}" ${l}/>` +
          `<path d="M-28 -44 Q0 -36 28 -44 L28.6 -50 Q0 -42 -29 -50Z" fill="${P.coral}" ${l}/>` +
          `<path d="M0 -62 L0 -54" ${ink(W * 0.8)}/>`,
      };
    case 'Headphones':
      return {
        back: '',
        front:
          `<path d="M-44 -6 C-48 -64 48 -64 44 -6" fill="none" ${ink(W * 4.2)}/>` +
          `<path d="M-44 -6 C-48 -64 48 -64 44 -6" fill="none" stroke="${P.coral}" stroke-width="${W * 2.2}" stroke-linecap="round"/>` +
          `<rect x="-56" y="-18" width="16" height="30" rx="7" fill="${P.cyan}" ${l}/><rect x="40" y="-18" width="16" height="30" rx="7" fill="${P.cyan}" ${l}/>` +
          `<rect x="-50" y="-12" width="6" height="18" rx="3" fill="${SHADES.cyan}"/><rect x="44" y="-12" width="6" height="18" rx="3" fill="${P.teal}"/>`,
      };
    case 'Viking':
      return {
        back: '',
        front:
          `<path d="M-30 -44 C-46 -50 -54 -66 -50 -84 C-44 -70 -34 -62 -20 -58Z" fill="${P.cream}" ${l}/>` +
          `<path d="M30 -44 C46 -50 54 -66 50 -84 C44 -70 34 -62 20 -58Z" fill="${P.cream}" ${l}/>` +
          `<path d="M-36 -30 C-38 -72 38 -72 36 -30 Q0 -40 -36 -30Z" fill="${P.silver}" ${l}/>` +
          `<path d="M-36 -30 Q0 -40 36 -30 L35 -38 Q0 -48 -35 -38Z" fill="${P.silverS}" ${l}/>` +
          `<path d="M0 -66 L0 -44" ${ink(W * 0.8)}/>` +
          `<g fill="${P.silverS}">${[-24, -12, 12, 24].map((x) => `<circle cx="${x}" cy="${-35 - (24 - Math.abs(x)) / 6}" r="1.6"/>`).join('')}</g>`,
      };
    case 'Wizard':
      return {
        back: '',
        front:
          `<path d="M-56 -34 Q0 -50 56 -34 Q0 -18 -56 -34Z" fill="${P.violetS}" ${l}/>` +
          `<path d="M-30 -38 Q-8 -70 4 -96 Q18 -110 34 -100 Q18 -96 16 -80 Q22 -58 30 -38 Q0 -30 -30 -38Z" fill="${P.violet}" ${l}/>` +
          star5(-4, -56, 6, P.sun, W * 0.8) +
          star5(14, -76, 4, P.sun, W * 0.8, 20) +
          `<path d="M-30 -38 Q0 -30 30 -38 L29 -45 Q0 -37 -29 -45Z" fill="${P.sun}" ${l}/>`,
      };
    case 'Top Hat':
      return {
        back: '',
        front:
          `<path d="M-46 -38 Q0 -52 46 -38 Q0 -26 -46 -38Z" fill="${P.reef}" ${l}/>` +
          `<path d="M-24 -42 L-26 -92 Q0 -98 26 -92 L24 -42 Q0 -36 -24 -42Z" fill="${P.reef}" ${l}/>` +
          `<path d="M-24.6 -50 Q0 -44 24.6 -50 L24.2 -58 Q0 -52 -24.4 -58Z" fill="${P.coral}" ${l}/>` +
          `<path d="M-18 -88 L-18 -64" stroke="${P.current}" stroke-width="4" stroke-linecap="round"/>`,
      };
    case 'Laurel': {
      const leaves: string[] = [];
      for (const side of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          const a = ((side < 0 ? 200 : 340) + side * -1 * i * 14) * (Math.PI / 180);
          const x = Math.cos(a) * 47;
          const y = Math.sin(a) * 47;
          const rot = (a * 180) / Math.PI + (side < 0 ? -60 : 60) + 90;
          leaves.push(`<ellipse cx="${f(x)}" cy="${f(y)}" rx="4" ry="9" fill="${i % 2 ? P.clover : P.verdant}" ${l} transform="rotate(${f(rot)} ${f(x)} ${f(y)})"/>`);
        }
      }
      return { back: '', front: leaves.join('') + `<circle cx="0" cy="-48" r="3.5" fill="${P.coral}" ${l}/>` };
    }
    case 'Crown':
      return {
        back: '',
        front:
          `<g transform="rotate(-8 0 -50)"><path d="M-30 -38 L-34 -76 L-17 -58 L0 -84 L17 -58 L34 -76 L30 -38 Q0 -32 -30 -38Z" fill="${P.sun}" ${l}/>` +
          `<path d="M-30 -38 Q0 -32 30 -38 L31 -46 Q0 -40 -31 -46Z" fill="${SHADES.sun}" ${l}/>` +
          `<circle cx="-34" cy="-78" r="3.5" fill="${P.cream}" ${l}/><circle cx="0" cy="-86" r="4" fill="${P.cream}" ${l}/><circle cx="34" cy="-78" r="3.5" fill="${P.cream}" ${l}/>` +
          `<path d="M0 -62 L5 -55 L0 -48 L-5 -55Z" fill="${P.coral}" ${l}/><circle cx="-17" cy="-50" r="3" fill="${P.cyan}" ${l}/><circle cx="17" cy="-50" r="3" fill="${P.cyan}" ${l}/></g>`,
      };
    case 'Halo':
      return {
        back: `<ellipse cx="0" cy="-62" rx="30" ry="9" fill="none" stroke="${spec.dark ? P.sun : P.sun}" stroke-width="16" opacity=".25"/>`,
        front: `<ellipse cx="0" cy="-62" rx="30" ry="9" fill="none" ${ink(W * 3.6)}/><ellipse cx="0" cy="-62" rx="30" ry="9" fill="none" stroke="${P.sun}" stroke-width="${W * 1.8}"/><path d="M-20 -68 Q-6 -71 6 -71" stroke="${WHITE}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
      };
  }
}

/* accessories ------------------------------------------------------------------------------------- */

function accessory(g: Genome, spec: MaterialSpec): string {
  const l = ink();
  switch (g.accessory) {
    case 'None':
      return '';
    case 'Scarf':
      return (
        `<path d="M-42 22 Q0 44 42 22 L40 34 Q0 54 -40 34Z" fill="${P.coral}" ${l}/>` +
        `<path d="M-30 32 L-26 42 M-16 37 L-13 47 M16 37 L13 47 M30 32 L26 42" stroke="${P.cream}" stroke-width="3"/>` +
        `<path d="M18 40 L30 62 L40 58 L30 36Z" fill="${P.coral}" ${l}/><path d="M24 50 L34 46" stroke="${P.cream}" stroke-width="3"/>`
      );
    case 'Bandana':
      return (
        `<path d="M-38 26 Q0 42 38 26 L0 52Z" fill="${P.cyan}" ${l}/>` +
        `<g fill="${WHITE}"><circle cx="-14" cy="34" r="1.8"/><circle cx="0" cy="40" r="1.8"/><circle cx="14" cy="34" r="1.8"/><circle cx="-4" cy="46" r="1.4"/><circle cx="6" cy="32" r="1.4"/></g>` +
        `<path d="M-38 26 Q-46 30 -50 24 Q-46 20 -38 26Z" fill="${P.cyan}" ${l}/>`
      );
    case 'Bow Tie':
      return `<path d="M0 38 L-16 30 L-16 48Z M0 38 L16 30 L16 48Z" fill="${P.coral}" ${l}/><rect x="-4" y="34" width="8" height="8" rx="2" fill="${P.copperS}" ${l}/>`;
    case 'Medal':
      return (
        `<path d="M-10 30 L-2 50 L6 50 L-2 30Z" fill="${P.cyan}" ${l}/><path d="M10 30 L2 50 L-6 50 L2 30Z" fill="${P.coral}" ${l}/>` +
        `<circle cx="0" cy="56" r="9" fill="${spec.kind === 'metal' && spec.fill === P.sun ? P.silver : P.sun}" ${l}/>` +
        star5(0, 56, 4.4, P.cream, W * 0.7)
      );
    case 'Monocle':
      return `<circle cx="15" cy="-6" r="13.5" fill="none" ${ink(W * 2.6)}/><circle cx="15" cy="-6" r="13.5" fill="none" stroke="${P.sun}" stroke-width="${W * 1.2}"/><path d="M27 2 Q36 24 30 44" fill="none" stroke="${P.sun}" stroke-width="1.6" stroke-dasharray="2 1.5"/>`;
    case 'Gold Chain': {
      const links: string[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const x = -34 + 68 * t;
        const y = 24 + Math.sin(t * Math.PI) * 14;
        links.push(`<ellipse cx="${f(x)}" cy="${f(y)}" rx="3.6" ry="2.6" fill="none" ${ink(W * 2.2)}/><ellipse cx="${f(x)}" cy="${f(y)}" rx="3.6" ry="2.6" fill="none" stroke="${P.sun}" stroke-width="${W}"/>`);
      }
      return links.join('') + `<circle cx="0" cy="46" r="8" fill="${P.sun}" ${l}/><path d="M-2.6 42 L2.6 42 M-2.6 46 L2 46 M-2.6 50 L2.6 50 M-2.6 42 L-2.6 50" ${ink(W * 0.8)}/>`;
    }
  }
}

/* effects ---------------------------------------------------------------------------------------- */

function effect(g: Genome): { back: string; front: string } {
  switch (g.effect) {
    case 'None':
      return { back: '', front: '' };
    case 'Sparkles':
      return { back: '', front: star4(-62, -40, 7, WHITE) + star4(64, -20, 5, P.sun) + star4(56, 44, 6, WHITE) + star4(-60, 34, 4, P.sun) };
    case 'Bubbles':
      return {
        back: '',
        front: [
          [-62, -30, 6],
          [-70, -54, 3.5],
          [62, -50, 5],
          [70, 10, 3],
          [-58, 30, 3.5],
        ]
          .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${P.mist}" ${ink()}/><circle cx="${x - r / 3}" cy="${y - r / 3}" r="${f(r / 3.5)}" fill="${WHITE}"/>`)
          .join(''),
      };
    case 'Orbit Coins':
      return {
        back: `<ellipse cx="0" cy="4" rx="70" ry="18" fill="none" stroke="${P.cream}" stroke-width="1.8" stroke-dasharray="3 3" transform="rotate(-12)"/>`,
        front: `<g transform="rotate(-12)">${miniCoin(-66, 8, 7, P.sun, SHADES.sun, W)}${miniCoin(40, 20, 6, P.silver, P.silverS, W)}${miniCoin(64, -6, 5, P.rose, P.roseS, W)}</g>`,
      };
    case 'Hearts':
      return { back: '', front: heart(-60, -36, 7, P.coral) + heart(62, -48, 5, P.blush) + heart(66, 22, 6, P.coral) };
    case 'Notes':
      return {
        back: '',
        front: [
          [-64, -30, -8],
          [60, -46, 10],
          [64, 14, -6],
        ]
          .map(
            ([x, y, r]) =>
              `<g transform="rotate(${r} ${x} ${y})"><path d="M${x + 3} ${y + 6} L${x + 3} ${y - 12} Q${x + 10} ${y - 10} ${x + 12} ${y - 4}" fill="none" ${ink(W * 1.1)}/><ellipse cx="${x}" cy="${y + 6}" rx="4.4" ry="3.4" fill="${P.sun}" ${ink()} transform="rotate(-20 ${x} ${y + 6})"/></g>`,
          )
          .join(''),
      };
    case 'Flames': {
      const flame = (s: number, fill: string) =>
        `<path d="M0 ${48 * s} C${-50 * s} ${48 * s} ${-70 * s} ${10 * s} ${-56 * s} ${-26 * s} C${-50 * s} ${-12 * s} ${-44 * s} ${-14 * s} ${-42 * s} ${-20 * s} C${-48 * s} ${-50 * s} ${-28 * s} ${-70 * s} ${-14 * s} ${-84 * s} C${-12 * s} ${-64 * s} ${-2 * s} ${-60 * s} 0 ${-64 * s} C${4 * s} ${-80 * s} ${18 * s} ${-92 * s} ${30 * s} ${-96 * s} C${24 * s} ${-74 * s} ${40 * s} ${-60 * s} ${44 * s} ${-44 * s} C${50 * s} ${-50 * s} ${54 * s} ${-56 * s} ${60 * s} ${-60 * s} C${74 * s} ${-30 * s} ${66 * s} ${48 * s} 0 ${48 * s}Z" fill="${fill}" ${ink()}/>`;
      return { back: flame(1.12, P.coral) + flame(0.96, P.sun) + flame(0.78, P.cream), front: '' };
    }
    case 'Lightning': {
      const bolt = (x: number, y: number, s: number) =>
        `<path d="M${x} ${y} L${x - 12 * s} ${y + 24 * s} L${x - 2 * s} ${y + 22 * s} L${x - 10 * s} ${y + 44 * s} L${x + 12 * s} ${y + 14 * s} L${x + 2 * s} ${y + 16 * s} L${x + 10 * s} ${y}Z" fill="${P.sun}" ${ink()}/>`;
      return { back: `<circle r="62" fill="${P.sun}" opacity=".18"/>`, front: bolt(-58, -56, 1.1) + bolt(66, -30, 0.9) + bolt(-66, 18, 0.6) + star4(56, 36, 5, WHITE) };
    }
    case 'Starburst': {
      const pts: string[] = [];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const r = i % 2 ? 58 : 76;
        pts.push(`${f(Math.cos(a) * r)} ${f(Math.sin(a) * r)}`);
      }
      return { back: `<path d="M${pts.join(' L')}Z" fill="${P.cream}" ${ink()}/>`, front: '' };
    }
    case 'Corona': {
      const pts: string[] = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const r = i % 2 ? 56 : 70 + (i % 4 === 0 ? 8 : 0);
        pts.push(`${f(Math.cos(a) * r)} ${f(Math.sin(a) * r)}`);
      }
      return { back: `<path d="M${pts.join(' L')}Z" fill="${P.sun}" ${ink()}/><circle r="54" fill="${P.cream}" ${ink()}/>`, front: '' };
    }
    case 'Embers':
      return {
        back: `<circle r="64" fill="${P.coral}" opacity=".3"/>`,
        front: [
          [-60, -40, 3],
          [-52, -64, 2],
          [56, -56, 3.4],
          [66, -20, 2],
          [-66, 10, 2.4],
          [60, 30, 2.6],
          [-30, -76, 1.8],
          [30, -80, 2.2],
        ]
          .map(([x, y, r]) => `<path d="M${x} ${y - r * 1.6} L${x + r} ${y} L${x} ${y + r * 1.6} L${x - r} ${y}Z" fill="${P.sun}" ${ink(W * 0.8)}/>`)
          .join(''),
      };
    case 'Starfall':
      return {
        back: '',
        front:
          star5(-62, -50, 7, P.sun, W, 10) +
          star5(64, -30, 5, P.cream, W, -10) +
          star5(56, 40, 4, P.sun, W) +
          star4(-58, 28, 5, WHITE) +
          `<path d="M-48 -42 L-30 -26 M70 -22 L80 -12" stroke="${P.cream}" stroke-width="1.6" stroke-linecap="round"/>`,
      };
    case 'Prism Halo': {
      const segs: string[] = [];
      for (let i = 0; i < 20; i++) {
        const a0 = (i / 20) * Math.PI * 2;
        const a1 = ((i + 1) / 20) * Math.PI * 2;
        segs.push(`<path d="M${f(Math.cos(a0) * 58)} ${f(Math.sin(a0) * 58)} A58 58 0 0 1 ${f(Math.cos(a1) * 58)} ${f(Math.sin(a1) * 58)}" fill="none" stroke="${HOLO[i % 5]}" stroke-width="9"/>`);
      }
      return { back: `<circle r="58" fill="none" ${ink(W * 10)}/>${segs.join('')}`, front: star4(-56, -52, 6, WHITE) + star4(60, 44, 5, WHITE) };
    }
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* frame                                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/** The tier band under everything (a holographic foil on the 1/1s). */
function frameBack(g: Genome): string {
  const [band] = TIER_FRAME[g.tier];
  const out = [`<rect x="1.5" y="1.5" width="509" height="509" rx="30" fill="${band}" ${ink(LW)}/>`];
  if (g.tier === 'Mythic') {
    for (let i = 0; i < 40; i++) {
      const x = i * 26 - 260;
      out.push(`<path d="M${x} 0 L${x + 26} 0 L${x + 286} 512 L${x + 260} 512Z" fill="${HOLO[i % 5]}"/>`);
    }
    out.push(`<rect x="1.5" y="1.5" width="509" height="509" rx="30" fill="none" ${ink(LW)}/>`);
  }
  return `<g clip-path="url(#card)">${out.join('')}</g>`;
}

/** Rivets: 4 on a Rare, 8 on an Epic, a full row on a Legendary. */
function rivets(g: Genome): [number, number][] {
  if (g.tier === 'Rare') return [[12, 12], [500, 12], [12, 500], [500, 500]];
  if (g.tier === 'Epic') return [[12, 12], [500, 12], [12, 500], [500, 500], [128, 11], [384, 11], [128, 501], [384, 501], [11, 256], [501, 256]];
  if (g.tier === 'Legendary') {
    return [...Array(9)].flatMap((_, i) => {
      const v = 40 + i * 54;
      return [[v, 11], [v, 501], [11, v], [501, v]] as [number, number][];
    });
  }
  return [];
}

/** The window line, rivets, the tier tag (top) and the number tag (bottom). */
function frameFront(g: Genome, id: number | null): string {
  const [band, shade] = TIER_FRAME[g.tier];
  const out: string[] = [`<rect x="20" y="20" width="472" height="472" rx="18" fill="none" ${ink(LW)}/>`];
  for (const [x, y] of rivets(g)) out.push(`<circle cx="${x}" cy="${y}" r="3.4" fill="${g.tier === 'Legendary' ? P.cream : shade}" ${ink(1.5)}/>`);
  const tag = (y: number, label: string, fill: string, text: string, weight: number) => {
    const w = Math.round(34 + label.length * 12.6);
    return (
      `<g transform="translate(${256 - w / 2} ${y})"><rect x="2" y="3" width="${w}" height="32" rx="10" fill="${INK}"/><rect width="${w}" height="32" rx="10" fill="${fill}" ${ink(LW)}/>` +
      `<text x="${w / 2}" y="22.5" text-anchor="middle" font-family="'Geist Mono', ui-monospace, Menlo, monospace" font-size="17" font-weight="${weight}" letter-spacing="1.8" fill="${text}">${label}</text></g>`
    );
  };
  if (g.tier !== 'Common') out.push(tag(4, g.tier.toUpperCase(), g.tier === 'Mythic' ? INK : band, g.tier === 'Mythic' ? CREAM : INK, 700));
  if (id !== null) out.push(tag(472, g.name ? `${g.name.toUpperCase()} · ${id}` : `No. ${id}`, CREAM, INK, 600));
  return out.join('');
}

/* ------------------------------------------------------------------------------------------------ */

/** The coin character (no background, no frame), in coin units around 0 0. */
function character(g: Genome): string {
  const spec = MATERIAL_SPECS[g.material];
  const hw = headwear(g, spec);
  const fx = effect(g);
  const feet = `<g fill="${spec.shade}" ${ink()}><path d="M-30 52 Q-30 41 -18 41 Q-6 41 -6 52Z"/><path d="M6 52 Q6 41 18 41 Q30 41 30 52Z"/></g>`;
  const cheekOpacity = spec.dark ? 0.55 : 0.75;
  const cheeks = g.eyes === 'Shades' ? '' : `<ellipse cx="-27" cy="9" rx="6" ry="3.6" fill="${BLUSH}" opacity="${cheekOpacity}"/><ellipse cx="27" cy="9" rx="6" ry="3.6" fill="${BLUSH}" opacity="${cheekOpacity}"/>`;
  return [
    `<defs><clipPath id="coin"><circle r="${R}"/></clipPath></defs>`,
    fx.back,
    hw.back,
    `<ellipse cx="0" cy="53" rx="34" ry="5" fill="${INK}" opacity=".25"/>`,
    feet,
    materialBody(spec),
    cheeks,
    eyes(g, spec),
    mouth(g, spec),
    accessory(g, spec),
    hw.front,
    fx.front,
  ].join('');
}

/** The vector emblem of a genome (512 × 512). `id` labels the frame (null: no number tag, e.g. showcases). */
export function vectorSvg(g: Genome, id: number | null): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="${NFT_NAME}${id === null ? '' : ` No. ${id}`}">`,
    `<defs><clipPath id="card"><rect x="0" y="0" width="512" height="512" rx="31"/></clipPath><clipPath id="window"><rect x="20" y="20" width="472" height="472" rx="18"/></clipPath></defs>`,
    frameBack(g),
    `<g clip-path="url(#window)">${BACKGROUND[g.background]()}<g transform="translate(${CX} ${CY}) scale(${K})">${character(g)}</g></g>`,
    frameFront(g, id),
    `</svg>`,
  ].join('');
}
