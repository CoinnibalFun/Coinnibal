import { BOOST_KEY_LABELS, BOOST_KINDS, boostCooldownMs, type BoostKind } from '@elymum/shared';
import { useRef, useState } from 'react';
import { engine } from '../../game/instance';
import { useT } from '../../i18n';
import { useUi } from '../../store';
import { useTicker } from '../ticker';
import { Peek } from './Peek';

/** Bought power-up glyphs in the icon set's hand (24 grid, round 2.2 px strokes). */
export const BOOST_PATH: Record<BoostKind, string> = {
  magnet: 'M6.5 4.5v8a5.5 5.5 0 0 0 11 0v-8h-3.6v8a1.9 1.9 0 0 1-3.8 0v-8zM6.5 8.2h3.6M13.9 8.2h3.6',
  // a hop: the arc off the ground line, an arrowhead where it lands
  leap: 'M3 20.5h6M5 17.5C6.8 10.2 13 6.6 19.2 8.6M15.4 5 19.2 8.6l-4.3 2.6',
  speed: 'M13.5 2.8L5.8 13.2h5.4l-1.4 8 7.9-10.6h-5.5z',
  // an eye with a slash through it
  invis: 'M2.8 12s3.4-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.4 6.2-9.2 6.2S2.8 12 2.8 12zM12 9.4a2.6 2.6 0 1 1 0 5.2a2.6 2.6 0 1 1 0-5.2zM4.2 19.8 19.8 4.2',
};

/** Ring fraction still to recharge (1 = just used, 0 = ready). */
export function cooldownFrac(readyAt: number, now: number, kind: BoostKind): number {
  return Math.min(1, Math.max(0, (readyAt - now) / boostCooldownMs(kind)));
}

/**
 * The kinds the HUD shows: every power-up the player still owns a charge of (and the admin has not
 * switched off). Nothing is sold during a game, so a power-up with no charge left is not shown.
 */
export function shownKinds(charges: Record<BoostKind, number>, disabled: readonly BoostKind[] = []): BoostKind[] {
  return BOOST_KINDS.filter((k) => !disabled.includes(k) && charges[k] > 0);
}

/**
 * One power-up button: the glyph on a cream sticker, its key cap, the charges left, and a teal
 * ring that refills while it recharges (drawn through a ref every frame, no React render per frame).
 */
function BoostButton({ kind, touch }: { kind: BoostKind; touch: boolean }) {
  const t = useT();
  const n = useUi((s) => s.boosts?.charges[kind] ?? 0);
  const readyAt = useUi((s) => s.boostReady[kind]);
  const blocked = useUi((s) => s.boosts?.arena?.left === 0);
  const ring = useRef<SVGCircleElement>(null);
  const [cooling, setCooling] = useState(() => readyAt > Date.now());
  useTicker(() => {
    const f = cooldownFrac(readyAt, Date.now(), kind);
    ring.current?.setAttribute('stroke-dasharray', `${(f * 100).toFixed(1)} 100`);
    const c = f > 0;
    setCooling((prev) => (prev === c ? prev : c));
  }, readyAt > Date.now() || cooling);
  const name = t(`boost.${kind}` as 'boost.magnet');
  const label = t('boost.use', { name, key: BOOST_KEY_LABELS[kind], n });
  return (
    <button
      type="button"
      className={`g-boost g-boost--${kind}${cooling ? ' is-cooling' : ''}${n === 0 || blocked ? ' is-empty' : ''}${touch ? ' is-touch' : ''}`}
      onPointerDown={(e) => {
        // a tap must not steal the joystick's pointer or the canvas focus
        e.preventDefault();
        engine()?.boost(kind);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          engine()?.boost(kind);
        }
      }}
      aria-label={label}
      title={label}
      data-kind={kind}
    >
      <svg className="g-boost__ring" viewBox="0 0 40 40" aria-hidden="true">
        <circle ref={ring} cx="20" cy="20" r="17" pathLength="100" strokeDasharray={`${(cooldownFrac(readyAt, Date.now(), kind) * 100).toFixed(1)} 100`} />
      </svg>
      <svg className="g-boost__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={BOOST_PATH[kind]} />
      </svg>
      {!touch && <kbd className="g-boost__key mono">{BOOST_KEY_LABELS[kind]}</kbd>}
      <span className="g-boost__n num">{n}</span>
    </button>
  );
}

/**
 * The bought power-ups on the HUD: one button per owned power-up and the arena's "uses left this
 * round". Desktop: a compact row tucked in the right corner just above the minimap (key caps R / F / G / V);
 * touch: a group inside the Split / Tip cluster (`MobileControls`). Nothing at all when the player
 * owns no charge (guests included): power-ups are bought in the lobby, never during a game.
 */
export function BoostBar({ touch = false }: { touch?: boolean }) {
  const t = useT();
  const state = useUi((s) => s.boosts);
  const charges = useUi((s) => s.boosts?.charges);
  if (!state || !state.signedIn || !charges) return null;
  const kinds = shownKinds(charges, state.disabled);
  if (kinds.length === 0) return null;
  const bar = (
    <div className={`g-boosts${touch ? ' is-touch' : ' is-rail'}`} role="group" aria-label={t('boost.label')} data-testid="boost-bar">
      {state.arena && <span className={`g-boosts__arena mono${state.arena.left === 0 ? ' is-out' : ''}`}>{t('boost.arenaLeft', { left: state.arena.left, max: state.arena.max })}</span>}
      <span className="g-boosts__row">
        {kinds.map((k) => (
          <BoostButton key={k} kind={k} touch={touch} />
        ))}
      </span>
    </div>
  );
  if (touch) return bar;
  // desktop: open for the first seconds, then a tab of key caps that opens on hover
  return (
    <Peek
      className="g-boosts-dock"
      label={t('boost.label')}
      tab={kinds.map((k) => (
        <kbd key={k} className="kb-key">
          {BOOST_KEY_LABELS[k]}
        </kbd>
      ))}
    >
      {bar}
    </Peek>
  );
}
