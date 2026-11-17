import { useId, type CSSProperties } from 'react';
import { CoinCharacter, useOffscreenPause, type CoinMood } from '../../design';
import { useMedia } from '../../design/useMedia';

/**
 * A bite out of a section's top edge: one sun coin has eaten its way up into the plate above and sits in the hole it
 * made, a size bigger at every bite down the page (the landing's "bite by bite"). Pure decoration (aria-hidden,
 * pointer-events none). The finished frame is the rest state; reveal.css plays the bite when the parent section turns
 * `data-seam="in"` (rise, lunge, three chomps that open the cut, crumbs, then the after-mood), so it costs no React
 * state. Reduced motion, a missing IntersectionObserver and print see the finished scar.
 *
 * The hole is the wordmark O's three-tooth bite on a straight edge, filled with the section's own paper (so it flows up
 * into the cut with no line along the bottom) and inked on its cut edge only. A hard sticker shadow runs inside the
 * hole along its top-left edge: the sheet above casts it onto the plate below, which is what makes it read as a cut and
 * not as a cloud sitting on the line.
 */

export interface Bite {
  /** Centre of the bite, % of the section width (desktop, phone). */
  x: number;
  xm: number;
  /** The coin's box in px (desktop, phone); its body is 82 % of it. */
  size: number;
  sizeM: number;
  /** The coin's mood once it has swallowed, and where it looks. */
  after: CoinMood;
  look: [number, number];
  /** Crumbs: bits of the plate above (two land on the dashed rule, two fly off). */
  crumbs: [string, string, string, string];
}

export type BiteAt = 'feast' | 'arenas' | 'faq';

export const BITES: Record<BiteAt, Bite> = {
  feast: { x: 42, xm: 62, size: 56, sizeM: 40, after: 'happy', look: [-3, 2], crumbs: ['var(--sand)', 'var(--clover)', 'var(--sun)', 'var(--sand)'] },
  arenas: { x: 64, xm: 80, size: 72, sizeM: 48, after: 'smug', look: [2, 3], crumbs: ['var(--current)', 'var(--sun)', 'var(--reef)', 'var(--sun)'] },
  faq: { x: 60, xm: 80, size: 88, sizeM: 56, after: 'open', look: [2, 3], crumbs: ['var(--cream)', 'var(--foam)', 'var(--cream)', 'var(--teal)'] },
};

/**
 * The wordmark O's three-tooth bite on a straight edge, as tooth circles [cx, cy, r] in units of the coin body D
 * (y < 0 is up). The hole is a broad arch, 2.07 D wide at the seam and 0.72 D deep, cut into three SHALLOW scallops
 * whose cusps sit about 0.15-0.2 D below the tooth tops: each circle passes through two neighbouring points of the arch
 * and bulges out of it a little. (Three deep circles sitting on the line read as a cartoon cloud; shallow scallops with
 * sharp cusps read as tooth marks.)
 */
const TEETH = [
  [-0.443, 0.081, 0.613],
  [-0.009, -0.301, 0.417],
  [0.372, 0.128, 0.659],
] as const;
/** Half the hole's width at the seam, in D (the left tooth reaches furthest). */
const HALF = 1.05;
const BODY = 0.82;

/** The section's style: where its bite sits (reveal.css clamps it inside the page and keeps a phone title clear of it). */
export const biteVars = (b: Bite) =>
  ({ '--bx': `${b.x}%`, '--bxm': `${b.xm}%`, '--bxmv': `${b.xm}vw`, '--bh': `${HALF * BODY * b.size}px`, '--bhm': `${HALF * BODY * b.sizeM}px` }) as CSSProperties;

export function BiteSeam({ at }: { at: BiteAt }) {
  const b = BITES[at];
  // the coin is drawn at its real size on phones (not CSS-scaled), so its ink stays about 3 px
  const phone = useMedia('(max-width: 639px)');
  const [ref, visible] = useOffscreenPause<HTMLDivElement>();
  const id = `ld-bite-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const S = phone ? b.sizeM : b.size;
  const D = S * BODY;
  const box = Math.ceil(HALF * D + 6);
  const teeth = TEETH.map(([x, y, r], i) => <circle key={i} cx={x * D} cy={y * D} r={r * D} />);
  // the hard sticker shadow inside the cut: the hole's paper is offset down-right, the shadow shows top-left
  const [dx, dy] = phone ? [2, 4] : [3, 5];
  return (
    <div ref={ref} className="ld-bite" aria-hidden="true" style={{ '--bite-s': `${S}px`, '--bite-d': `${D}px` } as CSSProperties}>
      {/* its own viewport ends 4 px below the seam: only the part above the line (and over both 3 px borders) shows */}
      <svg className="ld-bite__cut" width={box * 2} height={box + 4} viewBox={`${-box} ${-box} ${box * 2} ${box + 4}`} style={{ left: -box, top: -box }} focusable="false">
        <defs>
          <clipPath id={id}>{teeth}</clipPath>
        </defs>
        {/* ink under the hole: a stroke twice the line width, so only the outer half shows, on the cut edge alone */}
        <g className="ld-bite__ink">{teeth}</g>
        <g clipPath={`url(#${id})`}>
          <rect className="ld-bite__shade" x={-box} y={-box} width={box * 2} height={box + 4} />
          <g className="ld-bite__hole" transform={`translate(${dx} ${dy})`}>
            {teeth}
          </g>
        </g>
      </svg>
      {b.crumbs.map((c, i) => (
        <i key={i} className="ld-bite__crumb" style={{ '--c': c } as CSSProperties} />
      ))}
      <span className="ld-bite__coin">
        <span className="ld-bite__face ld-bite__face--chomp">
          <CoinCharacter paint="sun" mood="chomp" size={S} look={[0, -2]} blink={false} />
        </span>
        {/* only the after-face loops (its bob): the bob pauses off screen, on an inner wrapper, so the one-shot face swap
            (ld-face-in on the face itself) always runs to the end, even when the visitor scrolls past mid-bite */}
        <span className="ld-bite__face ld-bite__face--after">
          <span className="ld-bite__bob" data-paused={!visible || undefined}>
            <CoinCharacter paint="sun" mood={b.after} size={S} look={b.look} bob />
          </span>
        </span>
      </span>
    </div>
  );
}
