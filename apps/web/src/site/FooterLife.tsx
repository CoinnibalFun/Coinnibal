import { ELYSIUM, SHADE } from '@elymum/shared';
import type { ReactElement } from 'react';
import { useOffscreenPause, useReducedMotion } from '../design';

const INK = ELYSIUM.abyss;
/** The hand-inked wobble the RingScene's terraces wear (design/motifs/InkDefs, mounted by every Kb root). */
const WOBBLE = 'url(#kb-wobble)';

/** The RingScene's night paints for the front terraces, their props and the shore. */
const P = {
  terraces: [
    { fill: '#3F6E5E', lip: '#355F51' },
    { fill: '#335F51', lip: '#2A5245' },
    { fill: '#28503F', lip: '#204535' },
  ],
  shore: ELYSIUM.reef,
  shoreLip: ELYSIUM.trench,
  pebble: ELYSIUM.current,
  bush: '#173229',
  house: '#C9BFA6',
  roof: SHADE.coral,
  leaf: '#24503B',
  leafShine: '#3F7A5A',
  pine: '#1B4130',
};

/**
 * The scene's box: 1440 wide, 260 tall. Every band's top edge is the ring's curve, a quadratic from (-40, e) through
 * (720, c) to (1480, e): the ground rises at both ends, and its highest point (y 34, at the very ends) sits well under
 * the top of the box, so the sky shows above every edge at any width.
 */
const LAND_H = 260;
interface Band {
  e: number;
  c: number;
}
const BANDS: Band[] = [
  { e: 34, c: 150 },
  { e: 80, c: 200 },
  { e: 128, c: 248 },
];
const SHORE: Band = { e: 178, c: 292 };
/** The height of a band's top edge at x. */
const edge = (b: Band, x: number): number => {
  const t = (x + 40) / 1520;
  return b.e + 2 * t * (1 - t) * (b.c - b.e);
};
/** The band's top edge (moved down by dy). */
const top = (b: Band, dy = 0): string => `M-40 ${b.e + dy} Q 720 ${b.c + dy} 1480 ${b.e + dy}`;
/** A piece of the band's top edge from x0 to x1 (moved down by dy), as its own quadratic. */
const piece = (b: Band, x0: number, x1: number, dy = 0): string => {
  const m = (x0 + x1) / 2;
  const cy = 2 * edge(b, m) - (edge(b, x0) + edge(b, x1)) / 2;
  return `M${x0} ${edge(b, x0) + dy} Q ${m} ${cy + dy} ${x1} ${edge(b, x1) + dy}`;
};

type Kind = 'house' | 'lit' | 'glow' | 'tree' | 'pine' | 'bush';
/** Props on the terraces: kind, x, band (they stand a little under the band's lip). */
const PROPS: [Kind, number, number][] = [
  ['pine', 58, 0], ['pine', 82, 0], ['tree', 128, 0], ['glow', 180, 0], ['tree', 610, 0], ['house', 652, 0], ['tree', 792, 0],
  ['lit', 1262, 0], ['tree', 1304, 0], ['pine', 1370, 0], ['pine', 1394, 0],
  ['bush', 150, 1], ['tree', 262, 1], ['lit', 312, 1], ['tree', 914, 1], ['glow', 958, 1], ['tree', 1046, 1], ['pine', 1132, 1], ['bush', 1250, 1],
  ['pine', 168, 2], ['tree', 194, 2], ['bush', 560, 2], ['glow', 1182, 2], ['tree', 1224, 2],
];
/** Where the windmill stands (band 1, by the canal: inside the middle that a phone still shows). */
const MILL_X = 516;
/** The walking coin's road: band 2's top edge, a step above it. */
const WALK = top(BANDS[2], -1);
/** Fireflies over the front terrace and the shore: x, y, drift delay (s). */
const FLIES: [number, number, number][] = [
  [380, 206, 0],
  [520, 222, 1.6],
  [880, 226, 0.8],
  [1090, 206, 2.4],
  [1300, 196, 1.2],
];
const PEBBLES: [number, number, number][] = [
  [110, 236, 9],
  [292, 248, 6],
  [1160, 244, 8],
  [1336, 230, 6],
];

/** A house (lit: its window is lit; glow: a warm halo breathes round it too), lollipop tree, pine or bush at the origin
 * (base centre), ink-outlined. */
function Prop({ kind }: { kind: Kind }): ReactElement {
  if (kind === 'house' || kind === 'lit' || kind === 'glow') {
    return (
      <g>
        {kind === 'glow' && <circle className="st-life__glow" cx={0} cy={-7} r={18} fill={ELYSIUM.sun} />}
        <path d="M-12 0 V-16 L0 -27 L12 -16 V0 Z" fill={P.house} stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
        <path d="M-15 -14 L0 -29 L15 -14 L12 -16 L0 -27 L-12 -16Z" fill={P.roof} />
        <path d="M-15 -14 L0 -29 L15 -14" fill="none" stroke={INK} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        <rect x={-4} y={-11} width={8} height={8} rx={1.5} fill={kind === 'house' ? ELYSIUM.current : ELYSIUM.sun} stroke={INK} strokeWidth={2} />
      </g>
    );
  }
  if (kind === 'tree') {
    return (
      <g>
        <path d="M0 0 V-14" stroke={INK} strokeWidth={3} strokeLinecap="round" />
        <circle cx={0} cy={-24} r={12} fill={P.leaf} stroke={INK} strokeWidth={2.5} />
        <path d="M-5 -30 a8 8 0 0 1 8 -3" stroke={P.leafShine} strokeWidth={3} fill="none" strokeLinecap="round" />
      </g>
    );
  }
  if (kind === 'pine') {
    return (
      <g>
        <path d="M0 0 V-8" stroke={INK} strokeWidth={3} strokeLinecap="round" />
        <path d="M0 -40 L11 -8 H-11 Z" fill={P.pine} stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
        <path d="M-2 -32 L-6 -16" stroke={P.leafShine} strokeWidth={2.5} strokeLinecap="round" opacity={0.8} />
      </g>
    );
  }
  return <path d="M-16 0 a9 9 0 0 1 16 -6 a9 9 0 0 1 16 4 a7 7 0 0 1 -2 10 h-28 a6 6 0 0 1 -2 -8z" transform="translate(0 -8)" fill={P.bush} stroke={INK} strokeWidth={2.5} />;
}

/**
 * The footer's own stage: the ring's front terraces at night, drawn whole (every top edge curves up into the sky; nothing
 * is cut by the box), with the shore in front that the footer's last line stands on. Lit windows glow, a windmill
 * turns, a coin walks home along the front terrace with a lantern (turning round at the ends), fireflies drift over
 * the shore. `xMidYMax slice` in a box at least as tall as the art's own ratio: a narrow screen loses the far ends,
 * never the top or the shore. SMIL and CSS loops, paused off screen; reduced motion: the same picture standing still.
 * Decoration (aria-hidden).
 */
export function FooterLife() {
  const reduced = useReducedMotion();
  const [ref, visible] = useOffscreenPause<SVGSVGElement>();
  const live = !reduced;
  const millY = edge(BANDS[1], MILL_X) + 16;
  return (
    <svg
      ref={ref}
      className="st-life"
      viewBox={`0 0 1440 ${LAND_H}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
      data-paused={!visible || reduced || undefined}
    >
      {/* the terraces, back to front; each fill runs on under the box, so no edge but the top is ever drawn */}
      <g filter={WOBBLE}>
        {BANDS.map((b, i) => (
          <g key={i}>
            <path d={`${top(b)} V ${LAND_H + 20} H -40 Z`} fill={P.terraces[i].fill} stroke={INK} strokeWidth={3} />
            <path d={top(b, 12)} fill="none" stroke={P.terraces[i].lip} strokeWidth={9} />
            <path d={top(b, 27)} fill="none" stroke={P.terraces[i].lip} strokeWidth={3} strokeLinecap="round" strokeDasharray={i % 2 ? '60 40 120 90 30 160' : '140 70 50 120 90 60'} strokeDashoffset={i * 37} />
          </g>
        ))}
        {/* the canal across the middle terrace */}
        <path d={piece(BANDS[1], 560, 880, 24)} fill="none" stroke={INK} strokeWidth={13} strokeLinecap="round" />
        <path d={piece(BANDS[1], 560, 880, 24)} fill="none" stroke={ELYSIUM.cyan} strokeWidth={7} strokeLinecap="round" />
        <path d={piece(BANDS[1], 610, 650, 25)} fill="none" stroke={ELYSIUM.foam} strokeWidth={2.5} strokeLinecap="round" />
        <path d={piece(BANDS[1], 760, 782, 26)} fill="none" stroke={ELYSIUM.foam} strokeWidth={2.5} strokeLinecap="round" />
        {/* the shore: its top edge inked, its fill running on into the footer's last line (same paint, no seam) */}
        <path d={`${top(SHORE)} V ${LAND_H + 20} H -40 Z`} fill={P.shore} />
        <path d={top(SHORE, 9)} fill="none" stroke={P.shoreLip} strokeWidth={8} />
        <path d={top(SHORE)} fill="none" stroke={INK} strokeWidth={3} />
      </g>
      <g fill={P.pebble} stroke={INK} strokeWidth={2}>
        {PEBBLES.map(([x, y, r]) => (
          <ellipse key={x} cx={x} cy={y} rx={r} ry={r / 2} />
        ))}
      </g>
      {/* the dotted lane up the terraces on the right */}
      <path d="M1100 216 L1126 176 L1098 140 L1128 106 L1108 80" fill="none" stroke={ELYSIUM.sun} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 9" filter={WOBBLE} />
      {PROPS.map(([kind, x, b]) => (
        <g key={`${kind}${x}`} transform={`translate(${x} ${edge(BANDS[b], x) + 14})`}>
          <Prop kind={kind} />
        </g>
      ))}
      {/* the windmill */}
      <g transform={`translate(${MILL_X} ${millY})`} stroke={INK} strokeWidth={2.6} strokeLinejoin="round">
        <path d="M-11 0 L-7 -40 H7 L11 0Z" fill={ELYSIUM.cream} />
        <path d="M-9 -38 Q0 -52 9 -38Z" fill={ELYSIUM.coral} />
        <rect x={-3} y={-14} width={6} height={14} rx={2} fill={ELYSIUM.reef} />
        <rect x={-3} y={-30} width={6} height={6} rx={1.5} fill={ELYSIUM.sun} />
        <g transform="translate(0 -40)">
          <g>
            {[0, 90, 180, 270].map((a) => (
              <g key={a} transform={`rotate(${a})`}>
                <path d="M0 -2 V-30" />
                <path d="M1 -8 h9 v-20 h-9z" fill={ELYSIUM.mist} strokeWidth={2} />
              </g>
            ))}
            {live && <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="10s" repeatCount="indefinite" />}
          </g>
          <circle r={3.5} fill={ELYSIUM.sun} />
        </g>
      </g>
      {/* a coin walking home with a lantern */}
      <g>
        <g>
          <g className={live ? 'st-life__step' : undefined}>
            <path d="M6 -16 L16 -26" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
            <circle cx={17} cy={-21} r={9} fill={ELYSIUM.sun} opacity={0.3} className="st-life__lantern" />
            <rect x={13} y={-25} width={8} height={9} rx={2.5} fill={ELYSIUM.sun} stroke={INK} strokeWidth={2} />
            <path d="M-6 -1 v-3 M6 -1 v-3" stroke={INK} strokeWidth={3} strokeLinecap="round" />
            <circle cy={-14} r={11} fill={ELYSIUM.cyan} stroke={INK} strokeWidth={2.6} />
            <circle cx={-2} cy={-16} r={2.2} fill={INK} />
            <circle cx={5} cy={-16} r={2.2} fill={INK} />
            <path d="M-1 -9 q3 2 6 0" fill="none" stroke={INK} strokeWidth={1.8} strokeLinecap="round" />
          </g>
          {live && <animateTransform attributeName="transform" type="scale" values="1 1;-1 1" keyTimes="0;0.5" calcMode="discrete" dur="36s" repeatCount="indefinite" />}
        </g>
        {live ? (
          <animateMotion dur="36s" repeatCount="indefinite" path={WALK} keyPoints="0.3;0.68;0.3" keyTimes="0;0.5;1" calcMode="linear" />
        ) : (
          <animateMotion dur="1s" fill="freeze" path={WALK} keyPoints="0.42;0.42" keyTimes="0;1" calcMode="linear" />
        )}
      </g>
      {/* fireflies over the front terrace and the shore */}
      {FLIES.map(([x, y, d]) => (
        <g key={x} className="st-life__fly" style={{ animationDelay: `${-d}s` }}>
          <circle cx={x} cy={y} r={7} fill={ELYSIUM.sun} opacity={0.25} />
          <circle cx={x} cy={y} r={2.6} fill={ELYSIUM.sun} />
        </g>
      ))}
    </svg>
  );
}
