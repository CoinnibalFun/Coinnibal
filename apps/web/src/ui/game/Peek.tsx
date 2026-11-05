import { useEffect, useRef, useState, type ReactNode } from 'react';

/** How long a peeking bar stays open when the game starts (ms). */
export const PEEK_HOLD_MS = 10_000;
/** How long it stays open after the pointer leaves it (ms). */
const PEEK_LINGER_MS = 700;

/**
 * A HUD bar that shows itself for the first seconds of a game, then folds into a small tab; the
 * pointer over the tab (or keyboard focus inside) opens it again. The keys it lists keep working
 * while it is folded.
 */
export function Peek({ className = '', tab, label, children, holdMs = PEEK_HOLD_MS }: { className?: string; tab: ReactNode; label: string; children: ReactNode; holdMs?: number }) {
  const [open, setOpen] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    timer.current = setTimeout(() => setOpen(false), holdMs);
    return () => clearTimeout(timer.current);
  }, [holdMs]);
  const show = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  const fold = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), PEEK_LINGER_MS);
  };
  return (
    <div className={`g-peek ${className} ${open ? 'is-open' : 'is-folded'}`} onPointerEnter={show} onPointerLeave={fold} onFocus={show} onBlur={fold} data-peek={open ? 'open' : 'folded'}>
      {!open && (
        <button type="button" className="g-peek__tab mono" aria-label={label} aria-expanded={false} onClick={show}>
          {tab}
        </button>
      )}
      {open && children}
    </div>
  );
}
