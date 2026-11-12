/**
 * The pixel-art emblem (docs/NFT-DESIGN.md): the same genome drawn natively on a 64 × 64 grid (not a
 * downscaled vector), with the same palette, a 1 px ink outline around every shape (added by an outline
 * pass, so it is always one pixel and always ink), hand-authored sprites for faces, hats and accessories,
 * and a 3 × 5 pixel font for the tags. Output: a 512 × 512 SVG of crisp 8 px cells (row runs merged).
 */
import { NFT_NAME } from '@elymum/shared';
import { BLUSH, CREAM, HOLO, INK, MATERIAL_SPECS, P, SHADES, TIER_FRAME, WHITE, type MaterialSpec } from './palette';
import type { Genome } from './traits';

const N = 64;
const CELL = 8;
/** Coin centre and radius on the grid. */
const CX = 32;
const CY = 35;
const R = 17.5;

type Px = string | null;

class Layer {
  readonly px: Px[] = new Array<Px>(N * N).fill(null);
  set(x: number, y: number, c: Px): this {
    if (x >= 0 && y >= 0 && x < N && y < N) this.px[y * N + x] = c;
    return this;
  }
  get(x: number, y: number): Px {
    return x >= 0 && y >= 0 && x < N && y < N ? this.px[y * N + x] : null;
  }
  rect(x0: number, y0: number, w: number, h: number, c: string): this {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
    return this;
  }
  /** Pixels whose centre lies within `test`. */
  fill(test: (x: number, y: number) => boolean, c: string | ((x: number, y: number) => string)): this {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) if (test(x + 0.5, y + 0.5)) this.set(x, y, typeof c === 'string' ? c : c(x, y));
    return this;
  }
  /** A sprite: rows of characters, '.' transparent, others looked up in `map` ('o' is ink). */
  sprite(rows: readonly string[], x0: number, y0: number, map: Record<string, string>, flip = false): this {
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        const ch = row[flip ? row.length - 1 - dx : dx];
        if (ch === '.') continue;
        this.set(x0 + dx, y0 + dy, ch === 'o' ? INK : (map[ch] ?? INK));
      }
    });
    return this;
  }
  /** Adds the 1 px ink outline around every drawn pixel (4-neighbours). */
  outline(): this {
    const add: number[] = [];
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (this.get(x, y) !== null) continue;
        if (this.get(x - 1, y) !== null || this.get(x + 1, y) !== null || this.get(x, y - 1) !== null || this.get(x, y + 1) !== null) add.push(y * N + x);
      }
    for (const i of add) this.px[i] = INK;
    return this;
  }
  /** Draws `top` over this layer. */
  over(top: Layer): this {
    for (let i = 0; i < N * N; i++) if (top.px[i] !== null) this.px[i] = top.px[i];
    return this;
  }
}

/** `a` and `b` mixed at `t` (flat pixel colours stand in for the vector's translucent layers). */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0').toUpperCase()}`;
}

const inDisc = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const inEllipse = (cx: number, cy: number, rx: number, ry: number) => (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
/** A shape given by its radius at each angle around (cx, cy). */
const inPolar = (cx: number, cy: number, r: (a: number) => number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r(Math.atan2(y - cy, x - cx));

/* ------------------------------------------------------------------------------------------------ */
/* pixel font (3 × 5)                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

const FONT: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001',
  '5': '111100111001111', '6': '111100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001111',
  N: '101111111111101', o: '000000111101111', '.': '000000000000010', ' ': '000000000000000', R: '110101110101101', A: '010101111101101',
  E: '111100110100111', P: '110101110100100', I: '111010010010111', C: '011100100100011', L: '100100100100111', G: '011100101101011',
  D: '110101101101110', Y: '101101010010010', M: '101111111101101', T: '111010010010010', H: '101101111101101', O: '010101101101010',
};

function text(l: Layer, s: string, x0: number, y0: number, c: string): void {
  [...s].forEach((ch, i) => {
    const g = FONT[ch] ?? FONT[' '];
    for (let k = 0; k < 15; k++) if (g[k] === '1') l.set(x0 + i * 4 + (k % 3), y0 + Math.floor(k / 3), c);
  });
}

const textWidth = (s: string) => s.length * 4 - 1;

/* ------------------------------------------------------------------------------------------------ */
/* backgrounds                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

const STARS: [number, number][] = [
  [7, 9], [15, 16], [23, 6], [41, 7], [52, 12], [57, 21], [9, 26], [12, 37], [55, 32], [50, 5], [31, 5], [20, 23], [46, 18], [58, 45], [6, 47],
];

function starDots(l: Layer, c: string = CREAM, list = STARS): void {
  for (const [x, y] of list) l.set(x, y, c);
}

function twinkle(l: Layer, x: number, y: number, c: string): void {
  l.set(x, y, WHITE);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) l.set(x + dx, y + dy, c);
}

/** Wavy terraces: [top row, fill, phase]. Each band gets an ink top line. */
function terraces(l: Layer, bands: readonly [number, string, number][]): void {
  for (const [top, fill, ph] of bands) {
    for (let x = 0; x < N; x++) {
      const y0 = Math.round(top + Math.sin((x + ph) / 7) * 1.6);
      l.set(x, y0, INK);
      for (let y = y0 + 1; y < N; y++) l.set(x, y, fill);
    }
  }
}

function ringArc(l: Layer, y0: number, band: string, lights: string): void {
  // the ring's horizon arc: a quadratic from (-4, y0+18) through the top to (68, y0+18)
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    const x = Math.round((1 - t) ** 2 * -4 + 2 * (1 - t) * t * 32 + t * t * 68);
    const y = Math.round((1 - t) ** 2 * (y0 + 18) + 2 * (1 - t) * t * (y0 - 14) + t * t * (y0 + 18));
    l.set(x, y - 2, INK);
    l.set(x, y - 1, band);
    l.set(x, y, band);
    l.set(x, y + 1, INK);
    if (i % 22 === 0) l.set(x, y, lights);
  }
}

function cloud(l: Layer, x: number, y: number, c: string): void {
  const cl = new Layer().sprite(['...aaa....', '.aaaaaaa..', 'aaaaaaaaaa'], x, y, { a: c }).outline();
  l.over(cl);
}

function rays(l: Layer, a: string, b: string, cy: number, n: number): void {
  l.fill(() => true, (x, y) => (Math.floor(((Math.atan2(y + 0.5 - cy, x + 0.5 - CX) + Math.PI) / (Math.PI * 2)) * n) % 2 ? b : a));
}

function miniCoin(l: Layer, x: number, y: number, fill: string, shade: string): void {
  l.over(new Layer().sprite(['.ab.', 'aabb', 'abbb', '.bb.'], x, y, { a: fill, b: shade }).outline());
}

const BACKGROUNDS: Record<Genome['background'], (l: Layer) => void> = {
  'Dawn Plain': (l) => {
    l.rect(0, 0, N, N, P.mist);
    l.over(new Layer().fill(inDisc(48, 16, 5), P.sun).outline());
    cloud(l, 8, 12, CREAM);
    cloud(l, 46, 26, CREAM);
    terraces(l, [
      [40, P.meadow, 0],
      [48, P.clover, 9],
      [56, P.verdant, 3],
    ]);
    for (const [x, y] of [[8, 39], [11, 40], [55, 40]]) {
      l.over(new Layer().sprite(['.aa.', 'aaaa', '.aa.'], x - 2, y - 6, { a: P.forest }).outline());
      l.set(x - 1, y - 2, INK);
      l.set(x - 1, y - 1, INK);
    }
  },
  Shallows: (l) => {
    l.rect(0, 0, N, N, P.mist);
    cloud(l, 44, 12, WHITE);
    cloud(l, 8, 8, WHITE);
    l.rect(0, 40, N, 1, INK).rect(0, 41, N, N - 41, P.spray);
    for (const [x, y] of [[6, 45], [20, 50], [44, 46], [52, 54], [10, 57], [36, 58]]) l.rect(x, y, 3, 1, WHITE).set(x + 3, y - 1, WHITE);
  },
  Seigaiha: (l) => {
    l.rect(0, 0, N, N, P.linen);
    // concentric scales, 12 px wide, every 6 rows, alternate rows offset by half
    l.fill(() => true, (x, y) => {
      // later rows overlap earlier ones: the nearest scale below wins
      const row = Math.floor(y / 8);
      for (const dyRow of [1, 2]) {
        const cyS = (row + dyRow) * 8;
        const ox = (row + dyRow) % 2 ? 8 : 0;
        const cxS = Math.round((x - ox) / 16) * 16 + ox;
        const d = Math.hypot(x - cxS, y - cyS);
        if (d <= 8) return [7.5, 4.5, 1.5].some((r) => Math.abs(d - r) < 0.6) ? P.sand2 : P.linen;
      }
      return P.linen;
    });
  },
  'Night Ring': (l) => {
    l.rect(0, 0, N, N, P.trench);
    starDots(l);
    ringArc(l, 19, P.current, P.sun);
    terraces(l, [[52, P.reef, 4]]);
  },
  'Sunset Ring': (l) => {
    l.rect(0, 0, N, 18, P.coral).rect(0, 18, N, 13, P.blush).rect(0, 31, N, N - 31, P.sun);
    l.over(new Layer().fill((x, y) => inDisc(32, 48, 15)(x, y) && y < 52, CREAM).outline());
    ringArc(l, 21, P.coral, CREAM);
    terraces(l, [[50, P.copperS, 2]]);
  },
  'Deep Sea': (l) => {
    l.rect(0, 0, N, N, P.teal);
    const ray = mix(P.teal, P.foam, 0.18);
    l.fill((x, y) => [12, 40, 56].some((c) => Math.abs(x - (c - y * 0.12)) < 3), ray);
    terraces(l, [[54, P.current, 1]]);
    l.over(new Layer().fill((x, y) => y > 36 && y < 55 && Math.abs(x - (8 + Math.sin(y / 3) * 1.5)) < 1.6, P.verdant).outline());
    l.over(new Layer().fill((x, y) => y > 38 && y < 55 && Math.abs(x - (56 + Math.sin(y / 3 + 1) * 1.5)) < 1.6, P.forest).outline());
    for (const [x, y, r] of [[13, 20, 1.6], [10, 13, 1], [52, 25, 1.4], [50, 17, 0.9], [57, 12, 1.2]]) {
      l.over(new Layer().fill(inDisc(x, y, r + 0.3), P.mist).outline());
      l.set(Math.floor(x - 0.6), Math.floor(y - 0.6), WHITE);
    }
  },
  'Moon Night': (l) => {
    l.rect(0, 0, N, N, P.reef);
    starDots(l);
    twinkle(l, 10, 11, P.sun);
    twinkle(l, 55, 33, CREAM);
    l.over(new Layer().fill(inDisc(50, 15, 7), CREAM).outline());
    l.rect(47, 12, 2, 2, SHADES.cream).set(52, 17, SHADES.cream).set(53, 17, SHADES.cream).set(47, 18, SHADES.cream);
    terraces(l, [[51, P.trench, 6]]);
  },
  Aurora: (l) => {
    l.rect(0, 0, N, N, P.deep);
    starDots(l);
    const band = (y0: number, h: number, c: string, ph: number) => l.fill((x, y) => Math.abs(y - (y0 + Math.sin(x / 8 + ph) * 4)) < h, c);
    band(14, 2.6, P.violet, 0);
    band(22, 3.2, P.up, 1.4);
    band(30, 1.6, mix(P.deep, P.foam, 0.6), 2.6);
    const mt = new Layer().fill((x, y) => y > 52 - Math.max(0, 10 - Math.abs(((x + 4) % 22) - 11)) * 1.1, P.reef).outline();
    l.over(mt);
    l.fill((x, y) => mt.get(Math.floor(x), Math.floor(y)) === P.reef && mt.get(Math.floor(x), Math.floor(y) - 3) === null && y < 46, P.mist);
  },
  Treasury: (l) => {
    l.rect(0, 0, N, N, P.reef);
    l.fill((x, y) => (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 && (x % 8 < 1 || y % 8 < 1), P.current);
    for (const [x, y] of [[4, 56], [10, 58], [16, 60], [46, 58], [52, 56], [58, 59], [7, 52], [54, 52], [2, 49], [59, 50], [22, 61], [38, 61]])
      miniCoin(l, x, y, P.sun, SHADES.sun);
    twinkle(l, 8, 45, WHITE);
    twinkle(l, 56, 44, WHITE);
  },
  Cosmos: (l) => {
    l.rect(0, 0, N, N, P.deep);
    l.fill((x, y) => Math.abs(y - (16 + Math.sin(x / 9) * 5)) < 4, mix(P.deep, P.violet, 0.35));
    l.fill((x, y) => Math.abs(y - (40 + Math.sin(x / 10 + 2) * 4)) < 3, mix(P.deep, P.teal, 0.35));
    starDots(l);
    starDots(l, CREAM, [[4, 18], [26, 15], [37, 26], [61, 26], [17, 31], [45, 42], [7, 57], [59, 56]]);
    const planet = new Layer().fill(inDisc(12, 13, 5), P.coral).outline();
    l.over(planet);
    const ring = new Layer().fill((x, y) => {
      const u = (x - 12) * 0.95 + (y - 13) * 0.3;
      const v = -(x - 12) * 0.3 + (y - 13) * 0.95;
      const e = (u / 9.5) ** 2 + (v / 2.2) ** 2;
      return e <= 1 && e > 0.35 && !(v < 0 && Math.hypot(x - 12, y - 13) < 5.6);
    }, P.sun);
    l.over(ring);
    twinkle(l, 54, 10, CREAM);
    for (let i = 0; i < 9; i++) l.set(38 + i, 5 + Math.floor(i / 2.4), CREAM);
  },
  'Golden Rays': (l) => rays(l, P.sun, mix(P.sun, WHITE, 0.3), CY, 28),
  Eclipse: (l) => {
    l.rect(0, 0, N, N, INK);
    starDots(l);
    l.fill(inDisc(CX, CY, 22), mix(INK, P.sun, 0.18));
    l.over(new Layer().fill(inDisc(CX, CY, 20), P.sun).outline());
    l.fill(inDisc(CX, CY, 19), CREAM);
    l.over(new Layer().fill(inDisc(CX, CY, 18), P.deep).outline());
  },
  Abyss: (l) => {
    l.rect(0, 0, N, N, P.deep);
    for (const r of [20, 25, 30]) l.fill((x, y) => Math.abs(Math.hypot(x - CX, y - CY) - r) < 0.5, P.current);
    starDots(l, P.spray, STARS.map(([x, y]) => [x, (y * 1.7) % 62] as [number, number]));
  },
  Prism: (l) => {
    l.fill(() => true, (x, y) => HOLO[(((Math.floor((x + y * 0.5) / 5.5) % 5) + 5) % 5)]);
    starDots(l, WHITE);
  },
  Origin: (l) => {
    rays(l, P.mist, P.foam, 42, 36);
    terraces(l, [
      [48, P.meadow, 0],
      [56, P.verdant, 4],
    ]);
  },
};

/* ------------------------------------------------------------------------------------------------ */
/* the coin                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

const inCoin = inDisc(CX, CY, R);
const inLit = inDisc(CX - 2.3, CY - 3, R);

function body(spec: MaterialSpec): Layer {
  const l = new Layer();
  const at = (x: number, y: number) => Math.atan2(y + 0.5 - CY, x + 0.5 - CX);
  const dist = (x: number, y: number) => Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
  l.fill(inCoin, (x, y) => {
    const xc = x + 0.5;
    const yc = y + 0.5;
    const d = dist(x, y);
    const lit = inLit(xc, yc);
    let c = lit ? spec.fill : spec.shade;
    switch (spec.kind) {
      case 'paint':
        if (Math.abs(d - 14.2) < 0.55) c = spec.shade;
        break;
      case 'metal':
      case 'ancient':
        if (d > 15.8) c = (x + y) % 2 ? spec.shade : c;
        else if (Math.abs(d - 14.6) < 0.5) c = spec.shade;
        if (lit && d < 14 && (Math.abs(xc - CX + (yc - CY) * 0.55 + 6) < 1.4 || Math.abs(xc - CX + (yc - CY) * 0.55 + 1) < 0.6)) c = mix(spec.fill, WHITE, 0.55);
        if (spec.kind === 'ancient' && [[41, 44, 2.2], [21, 42, 1.5], [44, 29, 1.6]].some(([px, py, r]) => Math.hypot(xc - px, yc - py) < r)) c = spec.detail;
        break;
      case 'stone':
        if (Math.abs(yc - (CY - 4 + Math.sin(xc / 3) * 2) + (xc - CX) * 0.3) < 0.55 || Math.abs(yc - (CY + 9 + Math.sin(xc / 2.5) * 1.5)) < 0.55) c = spec.detail;
        if (Math.abs(d - 15) < 0.5) c = spec.shade;
        break;
      case 'pearl':
        if (lit && Math.hypot(xc - CX - 6, yc - CY + 6) < 6) c = mix(spec.fill, P.pink, 0.5);
        else if (lit && Math.hypot(xc - CX + 2, yc - CY - 12) < 3.5) c = mix(spec.fill, P.foam, 0.5);
        break;
      case 'glass': {
        const a = at(x, y);
        if (a > -2.6 && a < -1.9 && d > 9) c = spec.detail;
        if (a > 0.5 && a < 1.0 && d > 8) c = spec.detail;
        break;
      }
      case 'crystal': {
        const sector = Math.floor(((at(x, y) + Math.PI) / (Math.PI * 2)) * 6);
        c = [WHITE, spec.fill, P.mist, spec.shade, spec.fill, P.mist][sector];
        if (d < 4) c = WHITE;
        break;
      }
      case 'holo':
        c = HOLO[(((Math.floor((xc * 0.82 - yc * 0.57) / 3.6) % 5) + 5) % 5)];
        if (!lit) c = mix(c, INK, 0.16);
        break;
      case 'molten': {
        const crack =
          Math.abs(yc - CY - (xc - CX) * -0.25 + 1) < 0.7 && xc < CX + 4 ? 1 : Math.abs(xc - CX - 2 - (yc - CY) * 0.4) < 0.7 && yc > CY ? 1 : Math.abs(yc - CY + 6 - (xc - CX - 4) * -0.6) < 0.7 && xc > CX ? 1 : 0;
        if (crack) c = (x + y) % 3 ? P.sun : CREAM;
        break;
      }
      case 'void':
        if ([[24, 28], [38, 25], [42, 40], [27, 44], [34, 47], [20, 36], [45, 33]].some(([px, py]) => x === px && y === py)) c = CREAM;
        break;
      case 'moon':
        if ([[41, 28, 2.3], [24, 42, 2], [39, 46, 1.4]].some(([px, py, r]) => Math.hypot(xc - px, yc - py) < r)) c = spec.shade;
        break;
    }
    return c;
  });
  // the highlight arc (upper left), except on the dark glass
  if (spec.kind !== 'glass' && spec.kind !== 'void') {
    for (const [x, y] of [[19, 31], [19, 30], [20, 29], [20, 28], [21, 27], [22, 26], [23, 25]]) l.set(x, y, WHITE);
  } else {
    for (const [x, y] of [[18, 30], [19, 29], [19, 28], [20, 27], [21, 26], [22, 25], [23, 24]]) l.set(x, y, spec.glow);
  }
  l.outline();
  if (spec.dark) {
    // a rim light outside the ink line
    const rim = new Layer().fill((x, y) => Math.abs(Math.hypot(x - CX, y - CY) - (R + 1.4)) < 0.55 && y < CY + 6, spec.glow);
    for (let i = 0; i < N * N; i++) if (rim.px[i] && l.px[i] === null) l.px[i] = rim.px[i];
  }
  return l;
}

/* faces ---------------------------------------------------------------------------------------------- */

/** Eye sprites, 6 × 7, placed at (23, 29) and (35, 29). `w` white, `k` ink pupil, `f` body, `s` star, `h` heart, `g` glow. */
const EYE: Record<Genome['eyes'], readonly string[] | null> = {
  Round: ['.oooo.', 'owwwwo', 'owwkwo', 'owkkwo', 'owkkwo', 'owwwwo', '.oooo.'],
  Happy: ['......', '......', '.oooo.', 'o....o', '......', '......', '......'],
  Sleepy: ['......', '......', '......', 'o....o', '.oooo.', '......', '......'],
  Wink: null,
  Smug: ['.oooo.', 'offffo', 'offffo', 'oooooo', 'owwkko', 'owwkko', '.oooo.'],
  Determined: ['.oooo.', 'owwwwo', 'owkkwo', 'owkkwo', 'owwwwo', 'owwwwo', '.oooo.'],
  Dizzy: ['.oooo.', 'owwwwo', 'okwwko', 'owkkwo', 'okwwko', 'owwwwo', '.oooo.'],
  Star: ['.oooo.', 'owwswo', 'osssso', 'owsswo', 'owswso', 'owwwwo', '.oooo.'],
  Shades: null,
  Heart: ['......', '.hh.hh', 'hhhhhh', 'hhhhhh', '.hhhh.', '..hh..', '......'],
  Glow: ['.oooo.', 'oggggo', 'oggwgo', 'oggwgo', 'oggwgo', 'oggggo', '.oooo.'],
};

function face(l: Layer, g: Genome, spec: MaterialSpec): void {
  const map = { w: WHITE, k: INK, f: spec.fill, s: P.sun, h: P.coral, g: spec.glow };
  const lineMap = { o: spec.face };
  const eyes = new Layer();
  const draw = (rows: readonly string[], x: number, flip: boolean, lineColour: boolean) => {
    // closed eyes are lines in the face colour; open eyes keep the ink outline
    eyes.sprite(rows, x, 29, lineColour ? { ...map, ...lineMap } : map, flip);
    if (lineColour) rows.forEach((row, dy) => [...row].forEach((ch, dx) => ch === 'o' && eyes.set(x + (flip ? row.length - 1 - dx : dx), 29 + dy, spec.face)));
  };
  switch (g.eyes) {
    case 'Wink':
      draw(EYE.Round!, 23, false, false);
      draw(EYE.Happy!, 35, false, true);
      break;
    case 'Shades':
      eyes.rect(21, 30, 22, 1, INK).sprite(['oooooooo', 'oowwoooo', 'owwooooo', 'oooooooo', '.oooooo.'], 22, 31, { w: WHITE }).sprite(['oooooooo', 'oowwoooo', 'owwooooo', 'oooooooo', '.oooooo.'], 34, 31, { w: WHITE });
      break;
    case 'Happy':
    case 'Sleepy':
      draw(EYE[g.eyes]!, 23, false, true);
      draw(EYE[g.eyes]!, 35, false, true);
      break;
    default:
      draw(EYE[g.eyes]!, 23, false, false);
      draw(EYE[g.eyes]!, 35, g.eyes === 'Round' || g.eyes === 'Smug', false);
  }
  if (g.eyes === 'Determined') eyes.sprite(['oo....', '..oo..'], 22, 26, {}).sprite(['....oo', '..oo..'], 36, 26, {});
  if (g.eyes === 'Glow') {
    for (const [x, y] of [[22, 29], [29, 29], [22, 35], [29, 35], [34, 29], [41, 29], [34, 35], [41, 35]]) if (l.get(x, y)) l.set(x, y, mix(l.get(x, y)!, spec.glow, 0.5));
  }
  if (g.eyes !== 'Shades') l.rect(20, 38, 2, 1, BLUSH).rect(42, 38, 2, 1, BLUSH);
  l.over(eyes);
  const m: Record<Genome['mouth'], readonly string[]> = {
    Smile: ['o...o', '.ooo.'],
    Grin: ['ooooooo', 'owwwwwo', 'okkkkko', '.okbko.', '..ooo..'],
    Cat: ['o.o.o', '.o.o.'],
    Ooh: ['.oo.', 'okko', '.oo.'],
    Smirk: ['....o', 'o..o.', '.oo..'],
    Tongue: ['o...o', '.obo.', '.obo.', '..o..'],
    Fang: ['o.....o', '.ooooo.', '.w...w.'],
    Chomp: ['ooooooooo', 'owkkkkkwo', 'okkkkkkko', 'okkkkkkko', '.okkbbko.', '..ooooo..'],
    'Gold Tooth': ['ooooooo', 'owwyywo', 'okkkkko', '.okbko.', '..ooo..'],
  };
  const rows = m[g.mouth];
  const w = rows[0].length;
  const mouth = new Layer().sprite(rows, 32 - Math.floor(w / 2), 40, { w: WHITE, k: INK, b: BLUSH, y: P.sun });
  // open mouths keep their ink; lines take the face colour (cream on dark coins)
  if (spec.dark && (g.mouth === 'Smile' || g.mouth === 'Cat' || g.mouth === 'Smirk' || g.mouth === 'Tongue' || g.mouth === 'Fang')) {
    for (let i = 0; i < N * N; i++) if (mouth.px[i] === INK) mouth.px[i] = spec.face;
  }
  l.over(mouth);
}

/* headwear --------------------------------------------------------------------------------------------- */

/** Point-in-polygon (even-odd), pixel coordinates. */
const inPoly =
  (pts: readonly (readonly [number, number])[]) =>
  (x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

/** One outlined part: parts drawn in order keep an ink line between them. */
const part = (test: (x: number, y: number) => boolean, c: string | ((x: number, y: number) => string)) => new Layer().fill(test, c).outline();

/** Hats, drawn from shapes at the coin's scale (the head is rows 17..24, 24 px wide at row 22). */
const HATS: Record<Exclude<Genome['headwear'], 'None'>, (l: Layer) => void> = {
  Cap: (l) => {
    l.over(part((x, y) => inEllipse(32, 23.5, 12.5, 12)(x, y) && y < 23, P.coral));
    l.rect(31, 13, 1, 9, INK);
    l.over(part((x, y) => inEllipse(47, 22, 9.5, 2.4)(x, y) && x > 40, P.copperS));
    l.over(part(inEllipse(32, 11, 1.6, 1.1), P.sun));
  },
  Beanie: (l) => {
    l.over(part((x, y) => inEllipse(32, 24, 13.5, 13.5)(x, y) && y < 22, P.teal));
    l.over(part((x, y) => x > 18 && x < 46 && y > 19 && y < 24 && inEllipse(32, 24, 14.5, 14)(x, y + 2), (x) => (Math.floor(x) % 2 ? CREAM : SHADES.cream)));
    l.over(part(inDisc(32, 9.5, 2.8), CREAM));
  },
  Flower: (l) => {
    l.over(part(inEllipse(38, 25, 3.4, 1.6), P.clover));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      l.over(part(inDisc(44 + Math.cos(a) * 3.4, 20 + Math.sin(a) * 3.4, 2.3), WHITE));
    }
    l.over(part(inDisc(44, 20, 1.9), P.sun));
  },
  'Party Hat': (l) => {
    l.over(part(inPoly([[24, 22], [35, 7], [44, 21], [34, 23.5]]), (x, y) => (Math.floor((y - x * 0.35 + 40) / 4) % 2 ? P.violet : P.sun)));
    l.over(part(inDisc(35.5, 7, 2.3), P.sun));
  },
  Sprout: (l) => {
    l.rect(32, 10, 1, 9, INK);
    l.over(part(inEllipse(26.5, 10, 6, 3), P.clover));
    l.over(part(inEllipse(38.5, 8, 6, 3), P.verdant));
  },
  Propeller: (l) => {
    l.over(part((x, y) => inEllipse(32, 24, 12.5, 11)(x, y) && y < 23, (x) => (x < 32 ? P.coral : P.cyan)));
    l.over(part((x, y) => inEllipse(32, 24, 13, 11)(x, y) && y >= 20 && y < 23.5, P.sun));
    l.rect(32, 8, 1, 5, INK);
    l.over(part(inEllipse(25.5, 8, 6.5, 1.8), P.cyan));
    l.over(part(inEllipse(39.5, 8, 6.5, 1.8), P.cyan));
    l.over(part(inDisc(32.5, 8, 1.6), P.coral));
  },
  Cowboy: (l) => {
    l.over(part((x, y) => (x > 21 && x < 43 && y > 9 && y < 21 && !(y < 12 && Math.abs(x - 32) < 2.5)) || (inEllipse(32, 12, 10.5, 3)(x, y) && y > 10), P.tan));
    l.rect(22, 17, 21, 2, P.coral);
    l.over(part((x, y) => inEllipse(32, 21, 23, 3.4)(x, y) || inEllipse(10.5, 18.5, 2.4, 3)(x, y) || inEllipse(53.5, 18.5, 2.4, 3)(x, y), P.tan));
  },
  Headphones: (l) => {
    l.over(part((x, y) => y < 30 && Math.abs(Math.hypot(x - 32, y - 33) - 18.2) < 1.3, P.coral));
    l.over(part((x, y) => x > 11.5 && x < 17 && y > 27 && y < 40, P.cyan));
    l.over(part((x, y) => x > 47 && x < 52.5 && y > 27 && y < 40, P.cyan));
  },
  Viking: (l) => {
    for (const side of [-1, 1]) {
      l.over(
        part((x, y) => {
          // a horn: discs along a curve, thinning to the tip
          for (let t = 0; t <= 1; t += 0.05) {
            const cx = 32 + side * (11 + t * 8 - t * t * 2);
            const cy = 17 - t * 13 + t * t * 2;
            if (Math.hypot(x - cx, y - cy) < 2.8 * (1 - t) + 0.5) return true;
          }
          return false;
        }, CREAM),
      );
    }
    l.over(part((x, y) => inEllipse(32, 24, 13.5, 12)(x, y) && y < 20, P.silver));
    l.over(part((x, y) => inEllipse(32, 24, 14, 12)(x, y) && y >= 19 && y < 23.5, P.silverS));
    for (const x of [24, 28, 36, 40]) l.set(x, 21, P.silver);
  },
  Wizard: (l) => {
    l.over(part(inPoly([[22, 20], [30, 11], [37, 6], [45, 7], [40, 9], [37, 13], [42, 20]]), P.violet));
    l.rect(23, 18, 19, 2, P.sun);
    l.over(part(inEllipse(32, 21.5, 19, 2.6), P.violetS));
    l.set(31, 14, P.sun).set(30, 15, P.sun).set(31, 15, P.sun).set(32, 15, P.sun).set(31, 16, P.sun);
    l.set(38, 9, P.sun);
  },
  'Top Hat': (l) => {
    l.over(part((x, y) => x > 22.5 && x < 41.5 && y > 7 && y < 20, (x, y) => (y > 15 && y < 18 ? P.coral : P.reef)));
    for (let y = 9; y < 15; y++) l.set(25, y, P.current);
    l.over(part(inEllipse(32, 20.5, 17.5, 2.6), P.reef));
  },
  Laurel: (l) => {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + side * (0.42 + i * 0.27);
        const cx = 32 + Math.cos(a) * (R + 1.2);
        const cy = CY + Math.sin(a) * (R + 1.2);
        const ta = a + Math.PI / 2;
        l.over(
          part((x, y) => {
            const u = (x - cx) * Math.cos(ta) + (y - cy) * Math.sin(ta);
            const v = -(x - cx) * Math.sin(ta) + (y - cy) * Math.cos(ta);
            return (u / 2.8) ** 2 + (v / 1.5) ** 2 <= 1;
          }, i % 2 ? P.clover : P.verdant),
        );
      }
    }
    l.over(part(inDisc(32, 17, 1.6), P.coral));
  },
  Crown: (l) => {
    l.over(part(inPoly([[20, 22], [19, 11], [25, 15], [32, 9], [39, 15], [45, 11], [44, 22], [32, 23.5]]), (x, y) => (y > 19 ? SHADES.sun : P.sun)));
    l.over(part(inDisc(19.5, 10.5, 1.6), CREAM)).over(part(inDisc(32.5, 8.5, 1.8), CREAM)).over(part(inDisc(45.5, 10.5, 1.6), CREAM));
    l.over(part(inPoly([[32.5, 14], [35, 17], [32.5, 20], [30, 17]]), P.coral));
    l.set(24, 17, P.cyan).set(40, 17, P.cyan);
  },
  Halo: (l) => {
    l.over(part((x, y) => Math.abs(Math.hypot((x - 32.5) / 12.5, (y - 12.5) / 3.4) - 1) < 0.16, P.sun));
  },
};

function hat(g: Genome): Layer | null {
  if (g.headwear === 'None') return null;
  const l = new Layer();
  HATS[g.headwear](l);
  return l;
}

/* accessories ----------------------------------------------------------------------------------------- */

const ACCS: Record<Exclude<Genome['accessory'], 'None'>, [readonly string[], number, number, Record<string, string>]> = {
  Scarf: [['aa..................aa', 'aaaacaaacaaaacaaacaaaa', '.aaacaaacaaaacaaacaaa.', '...aaaaaaaaaaaaaaa.aa.', '..................aa..', '..................aac.', '..................aaa.'], 21, 43, { a: P.coral, c: CREAM }],
  Bandana: [['cc.......................', 'ccccccccccccccccccccccc..', '.cwcccccwcccccwccccccc...', '...ccccccccwccccccc......', '.....ccwcccccccwc........', '.......ccccccccc.........', '..........ccc............'], 20, 44, { c: P.cyan, w: WHITE }],
  'Bow Tie': [['aa...aa', 'aaabaaa', 'aaabaaa', 'aa...aa'], 29, 48, { a: P.coral, b: P.copperS }],
  Medal: [['bb.rr', '.brr.', '.yyy.', 'yyyyy', 'yycyy', '.yyy.'], 30, 46, { b: P.cyan, r: P.coral, y: P.sun, c: CREAM }],
  Monocle: [['.yyyy...', 'y....y..', 'y....y..', 'y....y..', 'y....y..', '.yyyy.y.', '.......y', '.......y'], 34, 28, { y: P.sun }],
  'Gold Chain': [['y...................y', '.y.................y.', '..y.y.y.y.y.y.y.y.y..', '.........yyy.........', '........yyoyy........', '.........yyy.........'], 22, 43, { y: P.sun }],
};

function acc(g: Genome): Layer | null {
  if (g.accessory === 'None') return null;
  const [rows, x, y, map] = ACCS[g.accessory];
  const l = new Layer().sprite(rows, x, y, map);
  if (g.accessory !== 'Monocle' && g.accessory !== 'Gold Chain') l.outline();
  return l;
}

/* effects -------------------------------------------------------------------------------------------- */

function sparkle(l: Layer, x: number, y: number, c: string): void {
  l.over(new Layer().sprite(['..c..', '..c..', 'ccwcc', '..c..', '..c..'], x - 2, y - 2, { c, w: WHITE }));
}

function effects(g: Genome): { back: Layer | null; front: Layer | null } {
  const back = new Layer();
  const front = new Layer();
  const spiky = (n: number, r0: number, r1: number) => (a: number) => r0 + (r1 - r0) * Math.abs(((((a / (Math.PI * 2)) * n) % 1) + 1) % 1 - 0.5) * 2;
  switch (g.effect) {
    case 'None':
      return { back: null, front: null };
    case 'Sparkles':
      sparkle(front, 11, 20, WHITE);
      sparkle(front, 53, 24, P.sun);
      sparkle(front, 52, 46, WHITE);
      sparkle(front, 12, 44, P.sun);
      break;
    case 'Bubbles':
      for (const [x, y, r] of [[10, 25, 2.2], [8, 17, 1.2], [53, 19, 1.8], [55, 37, 1], [11, 44, 1.3]]) {
        front.over(new Layer().fill(inDisc(x, y, r + 0.2), P.mist).outline());
        front.set(Math.floor(x - 0.5), Math.floor(y - 0.5), WHITE);
      }
      break;
    case 'Orbit Coins':
      back.fill((x, y) => {
        const u = (x - CX) * 0.98 + (y - CY - 1) * 0.2;
        const v = -(x - CX) * 0.2 + (y - CY - 1) * 0.98;
        return Math.abs(Math.hypot(u / 25, v / 6.5) - 1) < 0.045 && Math.floor(x) % 2 === 0;
      }, CREAM);
      miniCoin(front, 6, 37, P.sun, SHADES.sun);
      miniCoin(front, 45, 41, P.silver, P.silverS);
      miniCoin(front, 54, 29, P.rose, P.roseS);
      break;
    case 'Hearts':
      for (const [x, y, c] of [[8, 20, P.coral], [52, 16, P.blush], [53, 40, P.coral]] as const) front.over(new Layer().sprite(['aa.aa', 'aaaaa', '.aaa.', '..a..'], x, y, { a: c }).outline());
      break;
    case 'Notes':
      for (const [x, y] of [[8, 22], [52, 15], [53, 38]]) front.over(new Layer().sprite(['...oo.', '...o.o', '...o..', '.yyo..', 'yyyo..', '.yy...'], x, y, { y: P.sun }).outline());
      break;
    case 'Flames': {
      const flame = (k: number) => (a: number) => {
        // five tongues over the top half, sharp at the tips
        const tri = Math.abs(((((a + Math.PI) / (Math.PI * 2)) * 10 + 0.5) % 1) - 0.5) * 2;
        return (R + 2.5) * k + Math.max(0, -Math.sin(a)) ** 0.6 * (2 + 15 * (1 - tri) ** 2.2) * k;
      };
      back.over(new Layer().fill(inPolar(CX, CY + 1, flame(1.2)), P.coral).outline());
      back.over(new Layer().fill(inPolar(CX, CY + 1, flame(1.04)), P.sun).outline());
      back.over(new Layer().fill(inPolar(CX, CY + 1, flame(0.9)), CREAM));
      break;
    }
    case 'Lightning':
      for (const [x, y] of [[7, 12], [52, 20], [9, 38]]) front.over(new Layer().sprite(['...yyy', '..yyy.', '.yyy..', 'yyyyyy', '...yy.', '..yy..', '.yy...', '.y....'], x, y, { y: P.sun }).outline());
      break;
    case 'Starburst':
      back.over(new Layer().fill(inPolar(CX, CY, spiky(12, R + 4, R + 10)), CREAM).outline());
      break;
    case 'Corona':
      back.over(new Layer().fill(inPolar(CX, CY, spiky(16, R + 3, R + 9)), P.sun).outline());
      back.over(new Layer().fill(inDisc(CX, CY, R + 2.5), CREAM).outline());
      break;
    case 'Embers':
      back.fill(inDisc(CX, CY, R + 6), P.coral);
      for (const [x, y] of [[9, 20], [12, 12], [52, 14], [56, 27], [7, 38], [54, 44], [22, 8], [42, 7]]) front.over(new Layer().sprite(['.y.', 'yyy', '.y.'], x, y, { y: P.sun }).outline());
      return { back: dim(back, 0.3), front };
    case 'Starfall':
      for (const [x, y, c] of [[6, 14, P.sun], [52, 22, CREAM], [52, 45, P.sun]] as const) front.over(new Layer().sprite(['..a..', '.aaa.', 'aaaaa', '.aaa.', '.a.a.'], x, y, { a: c }).outline());
      sparkle(front, 10, 44, WHITE);
      break;
    case 'Prism Halo':
      back.fill((x, y) => Math.abs(Math.hypot(x - CX, y - CY) - (R + 4.5)) < 1.6, (x, y) => HOLO[Math.floor(((Math.atan2(y + 0.5 - CY, x + 0.5 - CX) + Math.PI) / (Math.PI * 2)) * 20) % 5]);
      back.outline();
      sparkle(front, 9, 15, WHITE);
      sparkle(front, 54, 47, WHITE);
      break;
  }
  return { back, front };
}

/** A translucent layer, flattened later against what is under it. */
function dim(l: Layer, alpha: number): Layer {
  const out = new Layer();
  for (let i = 0; i < N * N; i++) if (l.px[i]) out.px[i] = `${l.px[i]}@${alpha}`;
  return out;
}

function composite(base: Layer, top: Layer | null): void {
  if (!top) return;
  for (let i = 0; i < N * N; i++) {
    const c = top.px[i];
    if (!c) continue;
    const at = c.indexOf('@');
    base.px[i] = at < 0 ? c : mix(base.px[i] ?? INK, c.slice(0, at), Number(c.slice(at + 1)));
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* frame                                                                                                */
/* ------------------------------------------------------------------------------------------------ */

function frame(l: Layer, g: Genome, id: number | null): void {
  const [band, shade] = TIER_FRAME[g.tier];
  const f = new Layer();
  f.fill((x, y) => x < 4 || y < 4 || x >= N - 4 || y >= N - 4, (x, y) => (g.tier === 'Mythic' ? HOLO[Math.floor((x + y) / 3) % 5] : band));
  f.fill((x, y) => x < 1 || y < 1 || x >= N - 1 || y >= N - 1 || (x >= 3 && y >= 3 && x < N - 3 && y < N - 3 && (x < 4 || y < 4 || x >= N - 4 || y >= N - 4)), INK);
  // rounded corners: the four outer corner pixels are transparent
  for (const [x, y] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1]]) f.set(x, y, null);
  const studs = g.tier === 'Rare' ? 2 : g.tier === 'Epic' ? 4 : g.tier === 'Legendary' ? 9 : 0;
  for (let i = 0; i < studs; i++) {
    const v = studs === 2 ? [6, 57][i] : Math.round(6 + (i * 51) / (studs - 1));
    for (const [x, y] of [[v, 1], [v, N - 2], [1, v], [N - 2, v]]) f.set(x, y, g.tier === 'Legendary' ? CREAM : shade).set(x + 1, y, g.tier === 'Legendary' ? CREAM : shade);
  }
  l.over(f);
  const tag = (s: string, y: number, fill: string, ink: string) => {
    const w = textWidth(s) + 4;
    const x0 = Math.floor((N - w) / 2);
    l.rect(x0 - 1, y - 1, w + 2, 9, INK).rect(x0, y, w, 7, fill);
    text(l, s, x0 + 2, y + 1, ink);
  };
  if (g.tier !== 'Common') tag(g.tier.toUpperCase(), 1, g.tier === 'Mythic' ? INK : band, g.tier === 'Mythic' ? CREAM : INK);
  if (id !== null) tag(`No.${id}`, N - 8, CREAM, INK);
}

/** The 64 × 64 pixel grid of a genome (exported for the tests and the showcase script). */
export function pixelGrid(g: Genome, id: number | null): Px[] {
  const spec = MATERIAL_SPECS[g.material];
  const canvas = new Layer();
  BACKGROUNDS[g.background](canvas);
  const fx = effects(g);
  composite(canvas, fx.back);
  // shadow and feet
  canvas.fill(inEllipse(CX, CY + R + 2.6, 13, 1.4), mix(canvas.get(CX, CY + 20) ?? INK, INK, 0.3));
  canvas.over(new Layer().sprite(['.ffffff.', 'ffffffff', 'ffffffff'], 21, CY + 14, { f: spec.shade }).sprite(['.ffffff.', 'ffffffff', 'ffffffff'], 35, CY + 14, { f: spec.shade }).outline());
  const coin = body(spec);
  face(coin, g, spec);
  canvas.over(coin);
  const a = acc(g);
  if (a) canvas.over(a);
  const h = hat(g);
  if (h) canvas.over(h);
  composite(canvas, fx.front);
  frame(canvas, g, id);
  return canvas.px;
}

/** The pixel emblem (512 × 512 SVG of 8 px cells). */
export function pixelSvg(g: Genome, id: number | null): string {
  const px = pixelGrid(g, id);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N * CELL}" height="${N * CELL}" shape-rendering="crispEdges" role="img" aria-label="${NFT_NAME}${id === null ? '' : ` No. ${id}`}">`,
  ];
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const c = px[y * N + x];
      let e = x + 1;
      while (e < N && px[y * N + e] === c) e++;
      if (c) out.push(`<rect x="${x}" y="${y}" width="${e - x}" height="1" fill="${c}"/>`);
      x = e;
    }
  }
  out.push('</svg>');
  return out.join('');
}
