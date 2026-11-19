// The build's server render of `/` (vite.config.ts `prerenderLanding` bundles this with `vite build --ssr` and runs it
// in plain Node, no DOM): the markup of the landing as a visitor's browser first renders it, which the build puts in
// `dist/landing.html` and the browser hydrates (mount.tsx). Plain Node on purpose: with a `window` (jsdom) every
// `typeof window` guard would take the browser's branch. The browser's own reads (media queries, the stored session,
// the page's host) go through `useSyncExternalStore`, whose server answer is what this render assumes.
import '../../chainText';
import type { SiteSettings } from '@coinnibal/shared';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { INK_DEFS_HTML } from '../../design/motifs/InkDefs';
import { SiteApp } from '../mount';
import { FALLBACK } from '../settings';
import { setStaticEntrance } from './hydrated';

/** The settings the page is rendered with (`dist/landing.json`): the server sends the page only while its own match. */
export type LandingSettings = Pick<SiteSettings, 'gameAccess' | 'mintOpen' | 'wlOpen' | 'collabOpen' | 'xHandle'>;

/**
 * The landing's markup (the inside of `#root`), the settings it assumed: the closed defaults with the build's X
 * handle (`FALLBACK`, what every page starts from until the server's settings are in), no server chain, and what goes
 * at the end of `<body>` (the inked-edge filters `Kb` adds when it mounts: with them in the HTML the terraces' edges do
 * not move at hydration). The path is `/` (the router's server answer; there is no `location` here).
 */
export function renderLanding(): { html: string; settings: LandingSettings; bodyEnd: string } {
  // the hero card, its badge, the wordmark and Plate I as they land (the browser sets the same before it hydrates)
  setStaticEntrance(true);
  const html = renderToString(
    <StrictMode>
      <SiteApp />
    </StrictMode>,
  );
  const { gameAccess, mintOpen, wlOpen, collabOpen, xHandle } = FALLBACK;
  return { html, settings: { gameAccess, mintOpen, wlOpen, collabOpen, xHandle }, bodyEnd: INK_DEFS_HTML };
}
