import { lazy, Suspense, useEffect, useState } from 'react';
import { CoinCharacter, Icon, Tape } from '../../design';
import { useT } from '../../i18n';
import { useStoredAppetizer } from './stored';

/**
 * The sheet, its card drawing and its fonts: a chunk of their own, fetched when the visitor first shows interest in
 * the slip (hover, focus, a touch) or opens it, never with the landing itself.
 */
const loadSheet = () => import('./AppetizerSheet');
const AppetizerSheet = lazy(loadSheet);
let warmed = false;
const warm = () => {
  if (warmed) return;
  warmed = true;
  void loadSheet().catch(() => {
    warmed = false;
  });
};

const HASH = '#appetizer';

/**
 * The Appetizer's order slip, taped in the hero (Landing.tsx): "Early cards are out", and the visitor's own card
 * number once they hold one (with the step left while its post link is not in). A big chit with a slow wiggle and a
 * shine every few seconds (CSS, transform only, off with reduced motion). It opens the sheet; `/#appetizer` (where a
 * shared card's page sends people) scrolls to it and opens it once the settings are in. Rendered only while
 * `appetizerOpen`.
 */
export function AppetizerSlip({ ready, xHandle, postUrl }: { ready: boolean; xHandle: string; postUrl: string | null }) {
  const t = useT();
  const mine = useStoredAppetizer();
  const [open, setOpen] = useState(false);
  // the sheet stays mounted after the first open, so it can play its closing move
  const [mounted, setMounted] = useState(false);
  const show = () => {
    warm();
    setMounted(true);
    setOpen(true);
  };
  useEffect(() => {
    if (!ready) return;
    const fromHash = () => {
      if (location.hash === HASH) show();
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [ready]);
  const close = () => {
    setOpen(false);
    // the link's hash is spent: a reload does not open the sheet again
    if (location.hash === HASH) history.replaceState(history.state, '', location.pathname + location.search);
  };
  const no = mine ? String(mine.no).padStart(4, '0') : '';
  return (
    <div className="ld-ap" id="appetizer">
      <button
        type="button"
        className="ld-ap__slip"
        aria-haspopup="dialog"
        onClick={show}
        onPointerEnter={warm}
        onFocus={warm}
        onTouchStart={warm}
        data-testid="ld-appetizer"
      >
        <Tape className="ld-ap__tape" rotate={-5} width={96} />
        <span className="ld-ap__shine" aria-hidden="true" />
        <span className="ld-ap__plate" aria-hidden="true">
          <CoinCharacter paint="sun" mood={mine ? 'smug' : 'happy'} size={80} look={[-2, 1]} blink={false} />
        </span>
        <span className="ld-ap__text">
          <span className="ld-ap__kicker mono">{t('ld.ap.slipKicker')}</span>
          <span className="ld-ap__title">{mine ? t('ld.ap.slipMine', { no }) : t('ld.ap.slipTitle')}</span>
          <span className="ld-ap__cta">
            <span>{mine ? (mine.posted ? t('ld.ap.slipMineCta') : t('ld.ap.slipMineTodo')) : t('ld.ap.slipCta')}</span>
            <Icon name="arrow" size={18} />
          </span>
        </span>
      </button>
      {mounted && (
        <Suspense fallback={null}>
          <AppetizerSheet open={open} onClose={close} xHandle={xHandle} postUrl={postUrl} />
        </Suspense>
      )}
    </div>
  );
}
