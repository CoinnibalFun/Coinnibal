import { startTransition, useEffect, useState } from 'react';

interface MediaStore {
  subscribe: (fn: () => void) => () => void;
  get: () => boolean;
}

/** One store per query: its MediaQueryList and its subscribe function stay the same from render to render. */
const stores = new Map<string, MediaStore>();

function mediaStore(query: string): MediaStore {
  let s = stores.get(query);
  if (!s) {
    let made: typeof window.matchMedia | undefined;
    let mql: MediaQueryList | null = null;
    // made again only if `window.matchMedia` itself was replaced (a test's stand-in); a browser keeps one
    const list = (): MediaQueryList | null => {
      const fn = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia : undefined;
      if (fn !== made) {
        made = fn;
        mql = fn ? fn.call(window, query) : null;
      }
      return mql;
    };
    s = {
      subscribe: (fn) => {
        const m = list();
        m?.addEventListener('change', fn);
        return () => m?.removeEventListener('change', fn);
      },
      get: () => list()?.matches ?? false,
    };
    stores.set(query, s);
  }
  return s;
}

let hydrating = false;

/**
 * The site's mount (site/mount.tsx `hydrateLanding`): true while React hydrates the prerendered landing, false from
 * the hydration's commit on. A component rendered in that pass starts from the server's answer.
 */
export function setHydrating(on: boolean): void {
  hydrating = on;
}

/**
 * A media query (`(max-width: 639px)`, `(prefers-reduced-motion: reduce)`) as React state: one re-render when it
 * flips. The server render, and a browser hydrating the prerendered landing, read `false` (no media query matches on
 * the server: no reduced motion, the wide layout, which CSS adapts to the screen), and React re-renders right after
 * hydration with the real answer, so the first client render equals the HTML and React keeps it (the real answer in
 * the first render made a phone or a reduced-motion browser render something else, and React threw the HTML away).
 * A client-only render reads the real answer at once. So what a server render must agree with may not depend on
 * this: layout that differs by width belongs in CSS.
 *
 * Not `useSyncExternalStore`: its correction after hydration is a blocking render (React re-renders every component
 * whose answer differs at once, before the browser may paint: the bites, the nap and the dusk on a phone, 20-50 ms),
 * while a change here is a transition (rendered in slices, in the background).
 */
export function useMedia(query: string): boolean {
  const s = mediaStore(query);
  const [v, setV] = useState(() => (hydrating ? false : s.get()));
  useEffect(() => {
    const sync = () => {
      const now = s.get();
      startTransition(() => setV(now));
    };
    sync();
    return s.subscribe(sync);
  }, [s]);
  return v;
}
