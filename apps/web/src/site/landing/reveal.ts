import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useReducedMotion } from '../../design';

/**
 * The landing's one reveal engine: every plate seam, content stage and list item is armed here and played by CSS
 * (reveal.css). A target carries `data-reveal` (a content stage or item) or `data-seam` (a section: its ink rule,
 * title and bite) set to `wait`, then `in` (it plays) or `set` (it is finished without playing). An element with no
 * attribute, or with `set`, is the finished page, so reduced motion, print, a missing IntersectionObserver and old
 * browsers all see everything.
 *
 * Three shared observers, no React state:
 *  - line: plays a target once its top crosses 90 % of the viewport;
 *  - dwell: plays a target once any part of it has stayed on screen for 300 ms (a visitor who stops just short);
 *  - passed: finishes, without playing, a target that was jumped past (an anchor, scroll restoration).
 * Focus moving into a waiting target and `beforeprint` finish it at once. Everything plays once and never hides again.
 */

export type RevealAttr = 'data-reveal' | 'data-seam';
export interface RevealOpts {
  attr?: RevealAttr;
  /** A list item: items that cross the line together get `--rv-n` 0, 1, 2 ... (capped) for a batch stagger. */
  batch?: boolean;
  onIn?: () => void;
  onSet?: () => void;
}
type Pending = { attr: RevealAttr; batch: boolean; onIn?: () => void; onSet?: () => void; t?: number };

const MAX_BATCH = 5;
const DWELL_MS = 300;
const pending = new Map<Element, Pending>();
let line: IntersectionObserver | undefined;
let dwell: IntersectionObserver | undefined;
let passed: IntersectionObserver | undefined;

function forget(el: Element, p: Pending) {
  clearTimeout(p.t);
  pending.delete(el);
  line?.unobserve(el);
  dwell?.unobserve(el);
  passed?.unobserve(el);
}

function settle(el: Element, state: 'in' | 'set') {
  const p = pending.get(el);
  if (!p) return;
  forget(el, p);
  el.setAttribute(p.attr, state);
  (state === 'in' ? p.onIn : p.onSet)?.();
}

function settleAll() {
  for (const el of [...pending.keys()]) settle(el, 'set');
}

function ensure() {
  if (line) return;
  line = new IntersectionObserver(
    (es) => {
      let n = 0;
      for (const e of es) {
        const p = pending.get(e.target);
        if (!e.isIntersecting || !p) continue;
        if (p.batch) (e.target as HTMLElement).style.setProperty('--rv-n', String(Math.min(n++, MAX_BATCH)));
        settle(e.target, 'in');
      }
    },
    { rootMargin: '0px 0px -10% 0px' },
  );
  dwell = new IntersectionObserver((es) => {
    for (const e of es) {
      const p = pending.get(e.target);
      if (!p) continue;
      clearTimeout(p.t);
      if (e.isIntersecting) p.t = window.setTimeout(() => settle(e.target, 'in'), DWELL_MS);
    }
  });
  // jumped past: the root reaches far above the page, so a target above the viewport intersects it
  passed = new IntersectionObserver(
    (es) => {
      for (const e of es) if (e.isIntersecting && e.boundingClientRect.bottom < 0) settle(e.target, 'set');
    },
    { rootMargin: '100000px 0px 0px 0px' },
  );
  document.addEventListener('focusin', (ev) => {
    for (const el of [...pending.keys()]) if (el.contains(ev.target as Node)) settle(el, 'set');
  });
  window.addEventListener('beforeprint', settleAll);
}

/** Arms one element. Returns its cleanup: a target still waiting loses its attribute (the finished state). */
export function watch(el: Element, { attr = 'data-reveal', batch = false, onIn, onSet }: RevealOpts = {}): () => void {
  const was = el.getAttribute(attr);
  if (was === 'in' || was === 'set') return () => {};
  if (typeof IntersectionObserver === 'undefined' || el.getBoundingClientRect().bottom < 0) {
    el.setAttribute(attr, 'set');
    onSet?.();
    return () => {};
  }
  ensure();
  el.setAttribute(attr, 'wait');
  pending.set(el, { attr, batch, onIn, onSet });
  line!.observe(el);
  dwell!.observe(el);
  passed!.observe(el);
  return () => {
    const p = pending.get(el);
    if (!p) return;
    forget(el, p);
    el.removeAttribute(attr);
  };
}

/**
 * Arms the ref's element in a layout effect, so it is hidden before the first paint. Reduced motion: never armed (no
 * attribute at all), and `onSet` fires. Returns the ref (its own when none is given).
 */
export function useReveal<T extends Element>(ref?: RefObject<T | null>, opts: RevealOpts = {}): RefObject<T | null> {
  const own = useRef<T | null>(null);
  const r = ref ?? own;
  const reduced = useReducedMotion();
  const cb = useRef(opts);
  cb.current = opts;
  const attr = opts.attr ?? 'data-reveal';
  useLayoutEffect(() => {
    const el = r.current;
    if (!el) return;
    if (reduced) {
      cb.current.onSet?.();
      return;
    }
    return watch(el, { attr, onIn: () => cb.current.onIn?.(), onSet: () => cb.current.onSet?.() });
  }, [reduced, attr, r]);
  return r;
}

/** Arms every `selector` match under the ref as its own list item (batch stagger). `key` re-arms when the list changes. */
export function useRevealEach(ref: RefObject<Element | null>, selector: string, key?: unknown): void {
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || reduced) return;
    const offs = [...root.querySelectorAll(selector)].map((el) => watch(el, { batch: true }));
    return () => offs.forEach((off) => off());
  }, [reduced, selector, key, ref]);
}

/** The header's SeedRail coin gulps when a seam bites (`ld:gulp`), `ms` after the call. */
export const gulp = (ms = 0) => void window.setTimeout(() => window.dispatchEvent(new Event('ld:gulp')), ms);
/** A bite's first chomp, after its rise and lunge (reveal.css `ld-bite-coin`). */
export const BITE_GULP_MS = 340;
/** The seal's hit (reveal.css `ld-seal-hit`, 70 % of 420 ms). */
export const SEAL_GULP_MS = 280;
