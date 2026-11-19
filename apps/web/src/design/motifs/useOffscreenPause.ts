import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Pauses (or resumes) the SVG SMIL timelines at or under `el`. Resuming skips an SVG that something else keeps paused:
 * one still under a `[data-paused]` element (its own `useOffscreenPause` marks it off screen, and resumes it when it comes
 * on screen) and one that `useSteppedSmil` drives (`[data-stepped]`, moved from script on a touch phone). A section that
 * came on screen used to resume the round's orbit while the orbit itself was still off screen, and its SMIL then ran at
 * the full frame rate (#round: 58-65 % of a throttled phone's idle main thread).
 */
function pauseSmil(el: Element | null, paused: boolean): void {
  const svgs: SVGSVGElement[] = el instanceof SVGSVGElement ? [el] : [...(el?.querySelectorAll('svg') ?? [])];
  for (const s of svgs) {
    if (typeof s.pauseAnimations !== 'function') continue;
    if (paused) s.pauseAnimations();
    else if (!s.closest('[data-paused]') && !s.hasAttribute('data-stepped')) s.unpauseAnimations();
  }
}

/**
 * Pauses a motif's loops while it is off screen: returns a ref and whether the
 * element is visible. Put `data-paused={!visible || undefined}` on the root;
 * storybook.css stops every CSS animation under `[data-paused]`, and SVG SMIL
 * timelines are paused through `pauseAnimations()`.
 */
export function useOffscreenPause<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setVisible(e.isIntersecting);
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    pauseSmil(ref.current, !visible);
  }, [visible]);
  return [ref, visible];
}

/**
 * `useOffscreenPause` for a large block (a landing section) without a re-render: while the element is off screen it
 * carries `data-paused`, set on the element itself (so do not also render a `data-paused` prop on it), and the SVG
 * SMIL timelines under it are paused. Re-rendering a whole section each time it entered or left the screen cost long
 * tasks while a phone scrolled.
 */
export function useOffscreenPausedBlock(ref: RefObject<Element | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let shown = true;
    const io = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1].isIntersecting;
      if (visible === shown) return;
      shown = visible;
      if (visible) el.removeAttribute('data-paused');
      else el.setAttribute('data-paused', '');
      pauseSmil(el, !visible);
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => {
      io.disconnect();
      el.removeAttribute('data-paused');
    };
  }, [ref]);
}
