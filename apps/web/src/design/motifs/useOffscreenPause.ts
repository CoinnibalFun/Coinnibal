import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Pauses (or resumes) the SVG SMIL timelines at or under `el`. Resuming skips an SVG that something else keeps paused:
 * one still under a `[data-paused]` element (its own `useOffscreenPause` marks it off screen, and resumes it when it comes
 * on screen) or under a block that is off screen (`[data-offscreen]`, `useOffscreenPausedBlock`), and one that
 * `useSteppedSmil` drives (`[data-stepped]`, moved from script on a touch phone). A section that came on screen used to
 * resume the round's orbit while the orbit itself was still off screen, and its SMIL then ran at the full frame rate
 * (#round: 58-65 % of a throttled phone's idle main thread).
 */
function pauseSmil(el: Element | null, paused: boolean): void {
  const svgs: SVGSVGElement[] = el instanceof SVGSVGElement ? [el] : [...(el?.querySelectorAll('svg') ?? [])];
  for (const s of svgs) {
    if (typeof s.pauseAnimations !== 'function') continue;
    if (paused) s.pauseAnimations();
    else if (!s.closest('[data-paused], [data-offscreen]') && !s.hasAttribute('data-stepped')) s.unpauseAnimations();
  }
}

/*
 * A block's CSS loops, paused through the Web Animations API (`useOffscreenPausedBlock`). How many blocks hold each
 * animation paused, and the animations a block let go of while a motif inside it still had its own `[data-paused]`
 * (its CSS pause no longer applies to an animation paused from script: the motif plays them when it comes on screen).
 */
const holds = new WeakMap<Animation, number>();
const orphans = new WeakSet<Animation>();

/** The endless CSS animations at or under `el` (the loops: blinks, bobs, crawls); a reveal (finite) is not one. */
function loopsUnder(el: Element): Animation[] {
  return el
    .getAnimations({ subtree: true })
    .filter((a) => 'animationName' in a && a.effect?.getTiming().iterations === Infinity);
}

/** Its element sits under a motif that is off screen (storybook.css pauses that motif's loops). */
const underPausedMotif = (a: Animation): boolean => !!((a.effect as KeyframeEffect | null)?.target as Element | null | undefined)?.closest?.('[data-paused]');

/** Plays the loops a block let go of under `el`, once nothing holds them any more (a motif came on screen). */
function playOrphans(el: Element | null): void {
  if (!el || typeof el.getAnimations !== 'function') return;
  for (const a of loopsUnder(el)) {
    if (!orphans.has(a) || holds.has(a) || underPausedMotif(a)) continue;
    orphans.delete(a);
    if (a.playState === 'paused') a.play();
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
    if (visible) playOrphans(ref.current);
  }, [visible]);
  return [ref, visible];
}

/**
 * `useOffscreenPause` for a large block (a landing section) without a re-render: while the element is off screen its
 * endless CSS animations are paused from script (`Animation.pause()`, played again when it comes back) and the SVG
 * SMIL timelines under it are paused; it carries `data-offscreen` meanwhile, a marker no style rule reads.
 *
 * Not `data-paused`: storybook.css's `[data-paused] *` rule made the browser restyle every element of the block each
 * time it left or entered the screen (a ~1,200-node section is 45-50 ms on a throttled phone, all the landing's
 * sections together about 100 ms in one task right after hydration). A browser without `getAnimations` still gets
 * `data-paused`. Re-rendering a whole section each time it entered or left the screen cost long tasks too, hence no
 * React state here.
 */
export function useOffscreenPausedBlock(ref: RefObject<Element | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const mine = new Set<Animation>();
    const hold = () => {
      for (const a of loopsUnder(el)) {
        if (mine.has(a)) continue;
        const n = holds.get(a);
        if (n) holds.set(a, n + 1);
        else if (a.playState === 'running') {
          holds.set(a, 1);
          a.pause();
        } else continue; // paused by a style rule (a motif off screen, reduced motion): the style keeps it
        mine.add(a);
      }
    };
    const release = () => {
      for (const a of mine) {
        const n = (holds.get(a) ?? 1) - 1;
        if (n > 0) {
          holds.set(a, n);
          continue;
        }
        holds.delete(a);
        if (a.playState !== 'paused') continue;
        if (underPausedMotif(a)) orphans.add(a);
        else a.play();
      }
      mine.clear();
    };
    let shown = true;
    const io = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1].isIntersecting;
      if (visible === shown) return;
      shown = visible;
      if (typeof el.getAnimations !== 'function') {
        if (visible) el.removeAttribute('data-paused');
        else el.setAttribute('data-paused', '');
      } else if (visible) {
        el.removeAttribute('data-offscreen');
        release();
      } else {
        el.setAttribute('data-offscreen', '');
        hold();
      }
      pauseSmil(el, !visible);
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => {
      io.disconnect();
      release();
      el.removeAttribute('data-offscreen');
      el.removeAttribute('data-paused');
    };
  }, [ref]);
}
