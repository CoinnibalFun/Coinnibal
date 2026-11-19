import { useEffect, type RefObject } from 'react';

/**
 * Stepped motion for touch phones. A running non-composited animation (an SVG `stroke-dashoffset` crawl, SMIL motion)
 * makes Chrome restyle, lay out and paint the whole page on every frame: on the landing a dashed line of lights alone
 * was 45 % of a throttled phone's main thread. Driven from script in a few steps a second, the same motion costs a few
 * frames a second. Desktops (any device that can hover) keep the smooth animations; reduced motion keeps everything
 * still, as before.
 */
export function steppedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: none)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A dashed line crawls four steps a second. */
export const CRAWL_TICK_MS = 250;

/**
 * A dashed line's crawl (`stroke-dashoffset` from 0 to `-span` in `lapMs`, then again) on a touch phone: from script, in
 * `CRAWL_TICK_MS` steps, with the path's own CSS animation switched off (inline `animation: none`), from the offset the
 * CSS animation had reached. Only while `on` (animated and on screen).
 */
export function useDashCrawl(path: RefObject<SVGElement | null>, on: boolean, span: number, lapMs: number): void {
  useEffect(() => {
    const el = path.current;
    if (!on || !el || !steppedMotion()) return;
    let offset = parseFloat(getComputedStyle(el).strokeDashoffset) || 0;
    el.style.animation = 'none';
    const step = (span * CRAWL_TICK_MS) / lapMs;
    const timer = window.setInterval(() => {
      offset = (offset - step) % span;
      el.style.strokeDashoffset = offset.toFixed(2);
    }, CRAWL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [path, on, span, lapMs]);
}

/** SMIL motion steps ten times a second. */
export const SMIL_TICK_MS = 100;

/**
 * An SVG's SMIL timeline on a touch phone: paused, and moved forward from script in `SMIL_TICK_MS` steps. Only while `on`
 * (animated and on screen). The SVG carries `data-stepped` meanwhile, so a `useOffscreenPause` around it does not resume
 * its timeline; each step still pauses it again, in case something else did.
 */
export function useSteppedSmil(svg: RefObject<SVGSVGElement | null>, on: boolean): void {
  useEffect(() => {
    const el = svg.current;
    if (!on || !el || typeof el.setCurrentTime !== 'function' || !steppedMotion()) return;
    const tick = () => {
      if (!el.animationsPaused()) el.pauseAnimations();
      el.setCurrentTime(el.getCurrentTime() + SMIL_TICK_MS / 1000);
    };
    el.setAttribute('data-stepped', '');
    el.pauseAnimations();
    const timer = window.setInterval(tick, SMIL_TICK_MS);
    return () => {
      window.clearInterval(timer);
      el.removeAttribute('data-stepped');
    };
  }, [svg, on]);
}
