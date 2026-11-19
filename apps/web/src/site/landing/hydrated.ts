/**
 * Whether the landing's first-viewport entrances start in their final state ("static entrance"). True while the build
 * prerenders `/` (`prerender.tsx` sets it before `renderToString`) and in a browser that hydrates that page
 * (`mount.tsx` sets it before `hydrateRoot`); false in a client-only render (dev, `/` while a door is open, the
 * fallback), which keeps the entrances.
 *
 * Why: the prerendered HTML paints before any script, so whatever it shows must already be the finished frame. motion
 * writes a `motion` element's `initial` variant into the server markup as inline styles, and React does not patch
 * attribute differences while it hydrates, so an entrance there would either be frozen in its first frame or jump at
 * hydration. While this is true the hero card and its badge render with `initial={false}` (no drop, no pop), the
 * wordmark's letters start settled (no hop), Plate I's title and rule do not slide in, and the reveal engine never
 * re-hides a target that is already on screen (`reveal.ts`).
 *
 * One value for the life of the page: it is read during render, so it must not change after the first render.
 */
let staticEntrance = false;

export function setStaticEntrance(on: boolean): void {
  staticEntrance = on;
}

export const isStaticEntrance = (): boolean => staticEntrance;
