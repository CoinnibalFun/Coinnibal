/**
 * The web app's real routes, one list for both sides: the web picks the page a path renders from it (`main.tsx`,
 * the site router), and the server, which serves the bundle itself (`WEB_DIST`), answers a real route with 200 and
 * any other path with 404 (the same index.html, so the browser still draws the not-found page).
 *
 * Deep links ride on these paths, never on new ones: a private room invite is `/play?room=CODE`, the lobby pages
 * are hashes (`/play#ranks`), a guide section is `/docs#docs-<id>`, an admin tab is `/admin#<tab>`. The share cards
 * (`/share/<id>`), the API (`/api/*`) and the socket (`/ws`) are the server's own and never reach the app.
 */

/** The site's pages in reading order (a page turn goes left further in, right coming back). `/play` sits here for that order only. */
export const SITE_PATHS = ['/', '/play', '/mint', '/faucet', '/wl', '/collab', '/docs'] as const;
export type SitePath = (typeof SITE_PATHS)[number];

/** Paths that are their own entry of the bundle (a full page load, never a page turn of the site). */
export const ENTRY_PATHS = ['/play', '/admin'] as const;
export type EntryPath = (typeof ENTRY_PATHS)[number];

/** The pages the site app renders itself (`/` and the lazily loaded ones). */
export type SitePagePath = Exclude<SitePath, EntryPath>;

/** One spelling per page: trailing slashes off, lower case (`/Docs/` is `/docs`). */
export function normalizePath(pathname: string): string {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p.toLowerCase();
}

/** Which part of the bundle a path opens: the arena, the operator panel, or the site (whose router finds the page). */
export function appEntry(pathname: string): 'play' | 'admin' | 'site' {
  const p = normalizePath(pathname);
  return p === '/play' ? 'play' : p === '/admin' ? 'admin' : 'site';
}

/** A real page of the app: anything else is the not-found page (HTTP 404). */
export function isAppRoute(pathname: string): boolean {
  const p = normalizePath(pathname);
  return (SITE_PATHS as readonly string[]).includes(p) || (ENTRY_PATHS as readonly string[]).includes(p);
}
