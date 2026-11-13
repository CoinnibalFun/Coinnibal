import { RULES } from '@elymum/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { springs, useReducedMotion } from '../../design';
import { engine } from '../../game/instance';
import { COUNTDOWN_MS, formatCountdown, roundLengths, useRound, type RoundState } from '../../game/round';
import { useT } from '../../i18n';
import { useUi } from '../../store';
import { useRoomClosing } from './RoomClosing';

/** The arena round on screen (null outside arenas). */
function useArenaRound(): RoundState | null {
  const room = useUi((s) => s.room);
  const arena = room?.mode === 'arena';
  return useRound(arena ? (room.arenaId ?? null) : null, arena);
}

/** Seconds of the last-ten countdown, or null before it. */
const countOf = (r: RoundState): number | null => (r.msLeft <= COUNTDOWN_MS ? Math.max(1, Math.ceil(r.msLeft / 1000)) : null);

/**
 * The dial on the timer sticker: a cream face, an arc for the time left (teal, sun in the
 * final minute, coral in the last ten seconds), the ink rim and a hub. Drawn like the
 * reference's clock badge.
 */
export function RoundDial({ frac, phase, size = 46 }: { frac: number; phase: 'open' | 'closing' | 'count'; size?: number }) {
  const left = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <svg className="g-round__dial" viewBox="0 0 46 46" width={size} height={size} aria-hidden="true">
      <circle cx="23" cy="23" r="17" className="g-round__face" />
      <circle
        cx="23"
        cy="23"
        r="12.5"
        className={`g-round__arc is-${phase}`}
        pathLength={100}
        strokeDasharray={`${left.toFixed(2)} 100`}
        transform="rotate(-90 23 23)"
      />
      <circle cx="23" cy="23" r="17" className="g-round__rim" />
      <circle cx="23" cy="23" r="3" className="g-round__hub" />
    </svg>
  );
}

/**
 * The round clock on the HUD (arenas only): a cream sticker with a dial and `m:ss` "until the
 * bell". In the final minute (joins closed) it turns sun and says so; in the last ten seconds
 * the dial goes coral and the sticker shivers. A polite live region speaks the phase changes
 * only, never every second.
 */
export function RoundChip() {
  const t = useT();
  const round = useArenaRound();
  const info = useUi((s) => (s.room?.mode === 'arena' ? (s.room.round ?? null) : null));
  if (!round) return null;
  const time = formatCountdown(round.msLeft);
  const closing = round.phase === 'closing';
  const count = countOf(round);
  const roundMs = info ? roundLengths(info).roundMs : RULES.roundMs;
  const label = closing ? t('g.finalMinuteLeft', { time }) : t('g.roundEnds', { time });
  return (
    <>
      <div className={`g-round${closing ? ' is-closing' : ''}${count !== null ? ' is-count' : ''}`} role="timer" aria-label={label} data-phase={round.phase}>
        <RoundDial frac={round.msLeft / roundMs} phase={count !== null ? 'count' : closing ? 'closing' : 'open'} />
        <span className="g-round__text">
          <span className="g-round__time num" aria-hidden="true">
            {time}
          </span>
          <span className="g-round__label mono">{closing ? t('g.finalMinute') : info?.startsAt !== undefined ? t('g.roomUntilEnd') : t('g.round')}</span>
        </span>
      </div>
      {/* phase changes only: "Final minute", then "10 seconds left" */}
      <span className="sr-only" aria-live="polite">
        {count !== null ? t('g.countdown', { s: 10 }) : closing ? t('g.finalMinute') : ''}
      </span>
    </>
  );
}

/** Room left between the count's bottom edge and the top of my name tag (px): a power-up's "Pump!" pops in there. */
const COUNT_OVER_TAG = 40;
/** The count never rises higher than this under the top bar (px), however big my coin grows. */
const COUNT_UNDER_BAR = 8;

/**
 * Portrait phones: the count stands over my coin, its bottom edge `COUNT_OVER_TAG` px over the top of my name tag,
 * centred on the coin, followed frame by frame while it is up (only then). The column beside it is too narrow for it,
 * and anywhere in the middle of a 390 px screen a fixed spot meets my coin or its tag once the coin grows.
 */
function useOverMyCoin(ref: RefObject<HTMLDivElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el || !el.closest('.g-hud.is-narrow')) return;
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const tag = engine()?.myCoinBox();
      if (!tag) return;
      // the box the CSS's top / left are measured from (a transformed column holds a fixed child)
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const cbTop = r.top - (parseFloat(cs.top) || 0);
      const cbLeft = r.left - (parseFloat(cs.left) || 0);
      const bar = el.closest('.g-hud')?.querySelector('.g-topbar')?.getBoundingClientRect().bottom ?? 0;
      const top = Math.max(bar + COUNT_UNDER_BAR, tag.top - COUNT_OVER_TAG - r.height);
      const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, tag.x - r.width / 2));
      if (Math.abs(top - r.top) > 0.5) el.style.top = `${Math.round(top - cbTop)}px`;
      if (Math.abs(left - r.left) > 0.5) el.style.left = `${Math.round(left - cbLeft)}px`;
    };
    place();
    return () => {
      cancelAnimationFrame(raf);
      el.style.top = '';
      el.style.left = '';
    };
  }, [ref, on]);
}

/**
 * The last ten seconds: a big sticker numeral dropped in once a second over the top of the world. The arena's bell,
 * or a custom room's end (`useRoomClosing`): a ticket room closes on its bell, so the two count together. Never over
 * my coin or its name tag: in the centre column under the worth sticker (beside it on low windows and landscape
 * phones), over my coin's name tag on a portrait phone (`useOverMyCoin`).
 */
export function RoundCountdown() {
  const round = useArenaRound();
  const closing = useRoomClosing();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const count = (round ? countOf(round) : null) ?? (closing !== null ? Math.max(1, Math.ceil(closing / 1000)) : null);
  useOverMyCoin(ref, count !== null);
  return (
    <div ref={ref} className={`g-count${count !== null ? ' is-on' : ''}`} aria-hidden="true">
      <AnimatePresence initial={false}>
        {count !== null && (
          <motion.span
            key={count}
            className={`g-count__n display${count <= 3 ? ' is-last' : ''}`}
            data-testid="round-count"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.7, rotate: -10, y: -18 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, rotate: count % 2 ? -4 : 3, y: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, scale: 0.85, transition: { duration: 0.16 } }}
            transition={reduced ? { duration: 0.12 } : springs.drop}
          >
            {count}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
