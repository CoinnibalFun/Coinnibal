// The pop-up list helpers (the country picker's): a bottom sheet on phones, a placed popover on wider screens.
import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Phones get the list as a bottom sheet (thumb reach, big rows); wider screens a popover. */
const SHEET_QUERY = '(max-width: 479px)';
const GAP = 8;
const EDGE = 8;

export function useSheetMode(): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(SHEET_QUERY).matches === true);
  useEffect(() => {
    const m = window.matchMedia?.(SHEET_QUERY);
    if (!m) return;
    const sync = () => setOn(m.matches);
    m.addEventListener('change', sync);
    return () => m.removeEventListener('change', sync);
  }, []);
  return on;
}

export type Place = { left: number; width: number; maxHeight: number; top?: number; bottom?: number };

/**
 * Where a popover list hangs: under its trigger (or over it near the bottom of the window), right
 * edges lined up, inside the screen; kept in place on resize and scroll. Null in sheet mode.
 */
export function usePopoverPlace(
  open: boolean,
  sheet: boolean,
  btn: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  guessHeight: number,
  minWidth = 244,
): Place | null {
  const [place, setPlace] = useState<Place | null>(null);
  const measure = useCallback(() => {
    const b = btn.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, minWidth), window.innerWidth - 2 * EDGE);
    const left = Math.min(Math.max(EDGE, r.right - width), window.innerWidth - width - EDGE);
    const h = panel.current?.scrollHeight ?? guessHeight;
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    // the side with room for the whole list (else the roomier one, the list scrolling inside)
    if (below < h && above > below) setPlace({ left, width, maxHeight: Math.min(420, above), bottom: window.innerHeight - r.top + GAP });
    else setPlace({ left, width, maxHeight: Math.min(420, below), top: r.bottom + GAP });
  }, [btn, panel, guessHeight, minWidth]);
  useLayoutEffect(() => {
    if (!open || sheet) return;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, sheet, measure]);
  return sheet ? null : place;
}
