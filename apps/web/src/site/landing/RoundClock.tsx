import { ELYSIUM } from '@elymum/shared';
import type { CSSProperties } from 'react';
import { useT } from '../../i18n';
import { FACTS } from '../../ui/docs/facts';
import { GazeCoin } from './GazeCoin';

/** One round's clock in seconds: play, the moment joins close, the bell, and the end of the break (the next start). */
const PLAY = FACTS.rules.roundMin * 60;
const CLOSE = PLAY - FACTS.rules.joinCloseS;
const LAP = PLAY + FACTS.rules.breakS;
/** `240` → `4:00`. */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The dial: its centre and the ring the phases are painted on (the ring's length is one lap, in seconds). */
const C = 160;
const R = 118;
/** The gap between two phases on the ring, in seconds of the lap. */
const GAP = 2.4;

const PHASES = [
  { id: 'open', from: 0, to: CLOSE, paint: ELYSIUM.up, label: 'ld.clock.open' },
  { id: 'closed', from: CLOSE, to: PLAY, paint: ELYSIUM.sun, label: 'ld.clock.closed' },
  { id: 'break', from: PLAY, to: LAP, paint: ELYSIUM.coral, label: 'ld.clock.break' },
] as const;

/** A point on the dial `s` seconds into the lap, `r` from the centre (0:00 at the top, clockwise). */
const at = (s: number, r: number) => {
  const a = (s / LAP) * Math.PI * 2;
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) };
};

/**
 * How a round runs, as a stopwatch: one lap of the dial is a whole round and its break, painted by phase (joins open,
 * joins closed, the break after the bell), with the minutes round the inside. The hand sweeps a lap at ten times the
 * real speed while the plate is on screen, and the phase it is in lights up in the key beside it. The key is the text
 * (the dial is a picture of it); reduced motion stands the hand still.
 */
export function RoundClock({ live, still }: { live: boolean; still: boolean }) {
  const t = useT();
  const minutes = Array.from({ length: FACTS.rules.roundMin + 1 }, (_, m) => m);
  const lap = { '--lap': `${LAP / 10}s` } as CSSProperties;
  return (
    <div className={`ld-clock${still ? ' is-still' : ''}`} style={lap}>
      {/* a status only while the game is open to someone */}
      {live && <span className="ld-clock__tag">{t('ld.round.tag')}</span>}
      <div className="ld-clock__dial" aria-hidden="true">
        <svg viewBox={`0 0 ${C * 2} ${C * 2}`} className="ld-clock__svg" focusable="false">
          {/* the stopwatch: its crown on top, the case, the ring (ink under the painted phases) */}
          <rect className="ld-clock__crown" x={C - 15} y={0} width={30} height={20} rx={6} />
          <rect className="ld-clock__crown" x={C - 7} y={14} width={14} height={14} rx={3} />
          <circle className="ld-clock__case" cx={C} cy={C} r={R + 30} />
          <circle className="ld-clock__ring" cx={C} cy={C} r={R} />
          {PHASES.map((p) => (
            <circle
              key={p.id}
              className={`ld-clock__arc is-${p.id}`}
              cx={C}
              cy={C}
              r={R}
              stroke={p.paint}
              pathLength={LAP}
              strokeDasharray={`${p.to - p.from - GAP} ${LAP}`}
              strokeDashoffset={-(p.from + GAP / 2)}
              transform={`rotate(-90 ${C} ${C})`}
            />
          ))}
          {/* the minutes: a tick across the ring and its number inside it */}
          {minutes.map((m) => {
            const a = at(m * 60, R - 15);
            const b = at(m * 60, R + 15);
            const n = at(m * 60, R - 36);
            return (
              <g key={m}>
                <line className="ld-clock__tick" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                <text className="ld-clock__min" x={n.x} y={n.y} dy="0.36em" textAnchor="middle">
                  {m}
                </text>
              </g>
            );
          })}
          {/* the hand: from under the coin out to the ring, a sun bead riding the phases */}
          <g className="ld-clock__hand">
            <line x1={C} y1={C} x2={C} y2={C - R + 12} />
            <circle cx={C} cy={C - R} r={10} />
          </g>
        </svg>
        <span className="ld-clock__core">
          <GazeCoin paint="sun" mood="chomp" size={96} look={[2, 1]} reach={0.7} />
        </span>
      </div>
      <div className="ld-clock__side">
        <ol className="ld-clock__key" aria-label={t('ld.clock.aria')}>
          {PHASES.map((p) => (
            <li key={p.id} className={`ld-clock__phase is-${p.id}`}>
              <i className="ld-clock__swatch" style={{ background: p.paint }} aria-hidden="true" />
              <span className="ld-clock__when num">
                {mmss(p.from)}–{mmss(p.to)}
              </span>
              <span className="ld-clock__what">{t(p.label)}</span>
            </li>
          ))}
        </ol>
        <p className="ld-clock__note">{t('ld.clock.note')}</p>
      </div>
    </div>
  );
}
