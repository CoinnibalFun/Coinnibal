import { ELYSIUM } from '@elymum/shared';
import { useEffect, useState, type ReactElement } from 'react';
import { SceneCoin, useOffscreenPause, useReducedMotion } from '../../design';
import type { DocStrip } from './facts';

const INK = ELYSIUM.abyss;
const ln = { stroke: INK, strokeWidth: 2.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/* ── props the panels share ──────────────────────────────────────────── */

const Ground = ({ y = 112 }: { y?: number }) => <path d={`M-4 ${y} Q100 ${y - 8} 204 ${y}`} fill="none" {...ln} />;

function Seed({ x, y, paint = ELYSIUM.up }: { x: number; y: number; paint?: string }) {
  return <ellipse cx={x} cy={y} rx={5} ry={6.5} fill={paint} {...ln} strokeWidth={2} />;
}

/** A panel's tiny speech bubble (SVG text, short). */
function Say({ x, y, text, w }: { x: number; y: number; text: string; w: number }) {
  return (
    <g className="cs-say">
      <path d={`M${x} ${y} h${w} a5 5 0 0 1 5 5 v12 a5 5 0 0 1 -5 5 H${x + w - 18} l-2 9 l-9 -9 H${x} a5 5 0 0 1 -5 -5 v-12 a5 5 0 0 1 5 -5 Z`} fill="#FFFFFF" {...ln} strokeWidth={2} />
      <text x={x + w / 2} y={y + 15} textAnchor="middle" className="cs-say__t">
        {text}
      </text>
    </g>
  );
}

/* ── the panels: 200 x 130, each a 4.8 s loop (static under reduced motion) ── */

type Panel = () => ReactElement;

const PANELS: Record<string, [Panel, Panel, Panel]> = {
  play: [
    () => (
      <g>
        <Ground />
        {[104, 128, 152].map((x, i) => (
          <g key={x} className={`cs-pop cs-pop--${i + 1}`} style={{ transformOrigin: `${x}px 96px` }}>
            <Seed x={x} y={96} paint={[ELYSIUM.up, ELYSIUM.sun, ELYSIUM.coral][i]} />
          </g>
        ))}
        <g className="cs-graze">
          <g className="cs-grow" style={{ transformOrigin: '50px 88px' }}>
            <SceneCoin x={50} y={84} r={22} paint="cyan" mood="chomp" look={[4, 0]} feet />
          </g>
        </g>
      </g>
    ),
    () => (
      <g>
        <Ground />
        <g className="cs-gulp" style={{ transformOrigin: '64px 70px' }}>
          <SceneCoin x={64} y={70} r={34} paint="sun" mood="chomp" look={[4, 1]} feet />
        </g>
        <g className="cs-slurp">
          <SceneCoin x={150} y={92} r={13} paint="spray" mood="scared" look={[-3, 0]} feet />
        </g>
      </g>
    ),
    () => (
      <g>
        <Ground />
        <g className="cs-chase">
          <SceneCoin x={52} y={64} r={38} paint="coral" mood="chomp" look={[4, 0]} feet />
        </g>
        <g className="cs-run">
          <path d="M120 84 h-16 M124 94 h-22 M118 104 h-14" {...ln} strokeWidth={2} className="cs-lines" />
          <SceneCoin x={146} y={94} r={14} paint="cyan" mood="scared" look={[4, 0]} feet />
        </g>
      </g>
    ),
  ],
  wallet: [
    () => (
      <g>
        <Ground />
        <SceneCoin x={150} y={86} r={22} paint="coral" mood="smile" look={[-4, 0]} feet />
        <path d="M124 70 h52 v-6 a4 4 0 0 0 -4 -4 h-44 a4 4 0 0 0 -4 4 Z" fill={INK} />
        <path d="M134 79 h12 M154 79 h12" stroke={INK} strokeWidth={6} strokeLinecap="round" />
        <Say x={74} y={14} w={96} text="your phrase?" />
        <SceneCoin x={46} y={94} r={14} paint="cyan" mood="scared" look={[4, 0]} feet />
      </g>
    ),
    () => (
      <g>
        <Ground />
        <SceneCoin x={70} y={84} r={26} paint="cyan" mood="worried" look={[3, 0]} feet />
        <g className="cs-stamp" style={{ transformOrigin: '146px 54px' }}>
          <g transform="rotate(-10 146 54)">
            <rect x={116} y={36} width={60} height={36} rx={7} fill="none" stroke={ELYSIUM.down} strokeWidth={4} />
            <text x={146} y={63} textAnchor="middle" className="cs-no">
              NO
            </text>
          </g>
        </g>
      </g>
    ),
    () => (
      <g>
        <Ground />
        <path d="M100 24 h64 v80 h-64 Z" fill="#FFFFFF" {...ln} />
        <path d="M108 38 h48 M108 48 h40 M108 58 h46" stroke={ELYSIUM.stone} strokeWidth={2} strokeLinecap="round" />
        <path className="cs-check" d="M112 80 l10 10 l22 -24" fill="none" stroke={ELYSIUM.up} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
        <SceneCoin x={56} y={86} r={22} paint="cyan" mood="happy" feet />
      </g>
    ),
  ],
};

/**
 * The comic strip that opens a guide section where a picture says it better than words (the basic rule, wallet
 * safety): three small panels of coins acting it out. Each panel loops a short scene while it is on screen; under
 * reduced motion the panels stand still. The captions are real text (content.en.ts), the drawings are decoration;
 * the strip's label is for screen readers (the section's title already names it on screen).
 */
export function ComicStrip({ id, strip }: { id: string; strip: DocStrip }) {
  const reduced = useReducedMotion();
  const [ref, visible] = useOffscreenPause<HTMLElement>();
  // the drawings mount the first time the strip comes near the screen (a long page stays light)
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setSeen(true);
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  const panels = PANELS[id];
  if (!panels) return null;
  return (
    <figure ref={ref} className={`cs${reduced ? ' is-still' : ''}`} data-paused={!visible || undefined} data-strip={id}>
      <figcaption className="dc-sr">{strip.label}</figcaption>
      <ol className="cs__row" tabIndex={0} aria-label={strip.label}>
        {panels.map((Art, i) => (
          <li key={i} className="cs__panel">
            <svg className="cs__art" viewBox="0 0 200 130" aria-hidden="true" focusable="false">
              <rect width={200} height={130} fill={[ELYSIUM.mist, ELYSIUM.cream, ELYSIUM.linen][i]} />
              {seen && <Art />}
            </svg>
            <p className="cs__cap">{strip.panels[i]}</p>
          </li>
        ))}
      </ol>
    </figure>
  );
}
