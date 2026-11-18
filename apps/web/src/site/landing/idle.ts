import { useEffect, type RefObject } from 'react';
import { useReducedMotion } from '../../design';

/** The landing's parts that carry idle loops: the hero and every plate (the dusk pauses its own). */
const PARTS = ':scope > .ld-hero, :scope .ld-plate';

/**
 * The landing's idle budget: only the part of the page on screen keeps its loops running. Each part off screen gets
 * `data-paused`, and storybook.css pauses every CSS animation under it (blinks, bobs, jaws, sweat, bubbles). A part
 * comes back the moment any of it scrolls into view, so a reveal that started on screen finishes where it is seen.
 * Reduced motion runs no loops at all; without an IntersectionObserver everything stays as it is.
 */
export function useIdleBudget(root: RefObject<HTMLElement | null>): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const main = root.current;
    if (!main || reduced || typeof IntersectionObserver === 'undefined') return;
    const parts = [...main.querySelectorAll<HTMLElement>(PARTS)];
    // a part counts as on screen once 48 px of it are in (a sliver at the edge, or one just touching it, does not)
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          if (e.isIntersecting) el.removeAttribute('data-paused');
          else el.setAttribute('data-paused', '');
        }
      },
      { rootMargin: '-48px 0px' },
    );
    for (const el of parts) io.observe(el);
    return () => {
      io.disconnect();
      for (const el of parts) el.removeAttribute('data-paused');
    };
  }, [root, reduced]);
}
