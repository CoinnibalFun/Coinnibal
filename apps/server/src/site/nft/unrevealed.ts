/**
 * The sealed emblem: what every minted token shows until the collection seed is revealed (no trait, no tier,
 * nothing that could tell a rare apart). The coin is turned face-down: a blank, reeded coin with a question
 * mark, on the ring at night, in the style the collection will be revealed in.
 */
import { CREAM, INK, P } from './palette';
import type { ArtStyle } from './render';

function vector(id: number): string {
  const w = 3;
  const ticks: string[] = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    ticks.push(`M${(Math.cos(a) * 100).toFixed(1)} ${(Math.sin(a) * 100).toFixed(1)} L${(Math.cos(a) * 112).toFixed(1)} ${(Math.sin(a) * 112).toFixed(1)}`);
  }
  const tag = (y: number, label: string, fill: string, text: string) => {
    const tw = Math.round(30 + label.length * 10.4);
    return (
      `<g transform="translate(${256 - tw / 2} ${y})"><rect x="2" y="3" width="${tw}" height="28" rx="9" fill="${INK}"/><rect width="${tw}" height="28" rx="9" fill="${fill}" stroke="${INK}" stroke-width="${w}"/>` +
      `<text x="${tw / 2}" y="19.5" text-anchor="middle" font-family="'Geist Mono', ui-monospace, Menlo, monospace" font-size="14" font-weight="700" letter-spacing="1.6" fill="${text}">${label}</text></g>`
    );
  };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Elymum No. ${id} (sealed)">`,
    `<rect x="1.5" y="1.5" width="509" height="509" rx="30" fill="${P.reef}" stroke="${INK}" stroke-width="${w}"/>`,
    `<rect x="20" y="20" width="472" height="472" rx="18" fill="${P.trench}" stroke="${INK}" stroke-width="${w}"/>`,
    `<g fill="none" stroke="${P.current}" stroke-width="3">${[150, 182, 214].map((r) => `<circle cx="256" cy="270" r="${r}"/>`).join('')}</g>`,
    `<g fill="${CREAM}" opacity=".5"><circle cx="70" cy="80" r="2"/><circle cx="440" cy="96" r="2.4"/><circle cx="410" cy="430" r="1.8"/><circle cx="90" cy="420" r="2"/></g>`,
    `<ellipse cx="256" cy="402" rx="86" ry="11" fill="${INK}" opacity=".35"/>`,
    `<g transform="translate(256 270)">`,
    `<circle r="112" fill="${P.current}"/>`,
    `<circle cx="-14" cy="-18" r="112" fill="${P.teal}" clip-path="url(#seal)"/>`,
    `<clipPath id="seal"><circle r="112"/></clipPath>`,
    `<path d="${ticks.join(' ')}" stroke="${P.current}" stroke-width="3"/>`,
    `<circle r="98" fill="none" stroke="${P.current}" stroke-width="4"/>`,
    `<path d="M-86 -22 A90 90 0 0 1 -44 -78" stroke="${P.foam}" stroke-width="10" fill="none" stroke-linecap="round" opacity=".7"/>`,
    `<circle r="112" fill="none" stroke="${INK}" stroke-width="${w}"/>`,
    `<path d="M-30 -30 Q-30 -62 0 -62 Q30 -62 30 -32 Q30 -12 6 -2 Q0 2 0 14 L0 22" fill="none" stroke="${INK}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="M-30 -30 Q-30 -62 0 -62 Q30 -62 30 -32 Q30 -12 6 -2 Q0 2 0 14 L0 22" fill="none" stroke="${CREAM}" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<circle cx="0" cy="58" r="13" fill="${CREAM}" stroke="${INK}" stroke-width="${w}"/>`,
    `</g>`,
    tag(6, 'SEALED', P.sun, INK),
    tag(476, `No. ${id}`, CREAM, INK),
    `</svg>`,
  ].join('');
}

/** The pixel version: drawn from a small template on the same 64 grid. */
function pixel(id: number): string {
  const N = 64;
  const px: (string | null)[] = new Array(N * N).fill(null);
  const set = (x: number, y: number, c: string) => x >= 0 && y >= 0 && x < N && y < N && (px[y * N + x] = c);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const edge = x < 4 || y < 4 || x >= N - 4 || y >= N - 4;
      const line = x === 0 || y === 0 || x === N - 1 || y === N - 1 || ((x === 3 || y === 3 || x === N - 4 || y === N - 4) && !(x < 3 || y < 3 || x > N - 4 || y > N - 4));
      const d = Math.hypot(x + 0.5 - 32, y + 0.5 - 35);
      let c: string = edge ? P.reef : P.trench;
      if (!edge && (x * 7 + y * 13) % 41 === 0) c = P.current;
      if (d <= 17.5) {
        const lit = Math.hypot(x + 0.5 - 30, y + 0.5 - 32) <= 17.5;
        c = lit ? P.teal : P.current;
        if (d > 15.8) c = (x + y) % 2 ? P.current : c;
      } else if (d <= 18.5 && !edge) c = INK;
      if (line) c = INK;
      px[y * N + x] = c;
    }
  for (const [x, y] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1]]) px[y * N + x] = null;
  // the question mark (cream with an ink edge)
  const q = [
    '..ooooo..',
    '.occccco.',
    'occcoccco',
    'occo.occo',
    'oooo.occo',
    '....occco',
    '...occco.',
    '..occco..',
    '..occo...',
    '..oooo...',
    '.........',
    '..oooo...',
    '..occo...',
    '..occo...',
    '..oooo...',
  ];
  q.forEach((row, dy) => [...row].forEach((ch, dx) => ch !== '.' && set(28 + dx, 27 + dy, ch === 'o' ? INK : CREAM)));
  for (const [x, y] of [[19, 30], [20, 28], [21, 26], [22, 25]]) set(x, y, P.foam);
  // tags in the 3 x 5 pixel font
  const FONT: Record<string, string> = {
    S: '011100010001110', E: '111100110100111', A: '010101111101101', L: '100100100100111', D: '110101101101110', N: '101111111111101', o: '000000111101111', '.': '000000000000010',
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001111',
  };
  const tag = (s: string, y: number, fill: string) => {
    const w = s.length * 4 + 3;
    const x0 = Math.floor((N - w) / 2);
    for (let yy = y - 1; yy < y + 8; yy++) for (let xx = x0 - 1; xx < x0 + w + 1; xx++) set(xx, yy, yy === y - 1 || yy === y + 7 || xx === x0 - 1 || xx === x0 + w ? INK : fill);
    [...s].forEach((ch, i) => {
      const g = FONT[ch] ?? '0'.repeat(15);
      for (let k = 0; k < 15; k++) if (g[k] === '1') set(x0 + 2 + i * 4 + (k % 3), y + 1 + Math.floor(k / 3), INK);
    });
  };
  tag('SEALED', 1, P.sun);
  tag(`No.${id}`, N - 8, CREAM);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="512" height="512" shape-rendering="crispEdges" role="img" aria-label="Elymum No. ${id} (sealed)">`];
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

/** The sealed emblem of token `id` in `style`. */
export function unrevealedSvg(id: number, style: ArtStyle): string {
  return style === 'pixel' ? pixel(id) : vector(id);
}
