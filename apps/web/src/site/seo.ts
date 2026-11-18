import { SITE_PATHS } from './router';

/**
 * Per-page head tags for the client-routed site. index.html ships one canonical / og:url (the root)
 * for every path the SPA rewrite serves: left alone, `/mint` or `/docs` would tell crawlers they are
 * duplicates of `/`, and an unknown path (served with a 200) would be indexed as the landing.
 */
function meta(selector: string, create: () => HTMLElement): HTMLElement {
  return document.head.querySelector<HTMLElement>(selector) ?? document.head.appendChild(create());
}

/** The site's origin as index.html names it (the build's `VITE_PUBLIC_URL`), else the page's. */
function origin(): string {
  const canon = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute('href');
  if (canon) {
    try {
      return new URL(canon).origin;
    } catch {
      /* relative or broken: fall through */
    }
  }
  return location.origin;
}

/** `PAGE_META`'s keys for the pages visitors cannot use (both `noindex`): a closed page, a path the site does not know. */
export const CLOSED_META = 'closed';
export const NOT_FOUND_META = 'not-found';

/**
 * A page's own title and description for search results and share cards. index.html ships the landing's; a page
 * listed here gets its own while it is shown, and every other page gets index.html's back. Keyed by path, plus
 * `CLOSED_META` (any closed page, whatever it is: a closed page never names itself) and `NOT_FOUND_META`.
 */
export const PAGE_META: Readonly<Record<string, { title: string; description: string }>> = {
  '/docs': {
    title: 'Player guide · Coinnibal',
    description: 'How Coinnibal works: rounds, rooms and tickets, the fee, power-ups and what the NFT gives you.',
  },
  [CLOSED_META]: {
    title: 'Not open yet · Coinnibal',
    description: 'This part of Coinnibal is not open yet. The player guide explains how the game works.',
  },
  [NOT_FOUND_META]: {
    title: 'Page not found · Coinnibal',
    description: 'There is no page here. The player guide explains how Coinnibal works.',
  },
};

/** The head tags that carry a page's title and description (`attr` holds the text). */
const META_TAGS = [
  { selector: 'meta[name="description"]', key: 'description' },
  { selector: 'meta[property="og:title"]', key: 'title' },
  { selector: 'meta[property="og:description"]', key: 'description' },
  { selector: 'meta[name="twitter:title"]', key: 'title' },
  { selector: 'meta[name="twitter:description"]', key: 'description' },
] as const;

/** Sets each title / description tag to `path`'s own text, or back to index.html's (kept in `data-default`). */
function setPageMeta(path: string): void {
  const own = PAGE_META[path];
  for (const { selector, key } of META_TAGS) {
    const tag = document.head.querySelector<HTMLMetaElement>(selector);
    if (!tag) continue;
    if (!tag.hasAttribute('data-default')) tag.setAttribute('data-default', tag.getAttribute('content') ?? '');
    tag.setAttribute('content', own ? own[key] : (tag.getAttribute('data-default') ?? ''));
  }
}

/**
 * Points canonical and og:url at `path` and marks the page `noindex` when `indexable` is false
 * (a closed page, or the not-found page). `path` is the normalised pathname (`/`, `/mint`, ...). A page in
 * `PAGE_META` also gets its own title and description in the share and search tags; a page that is not indexable
 * gets the closed or the not-found ones.
 */
export function setPageHead(path: string, indexable = true): void {
  if (typeof document === 'undefined') return;
  setPageMeta(indexable ? path : (SITE_PATHS as readonly string[]).includes(path) ? CLOSED_META : NOT_FOUND_META);
  const url = `${origin()}${path === '/' ? '/' : path}`;
  const canon = meta('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' }));
  canon.setAttribute('href', url);
  const og = meta('meta[property="og:url"]', () => {
    const m = document.createElement('meta');
    m.setAttribute('property', 'og:url');
    return m;
  });
  og.setAttribute('content', url);
  const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (indexable) robots?.remove();
  else meta('meta[name="robots"]', () => Object.assign(document.createElement('meta'), { name: 'robots' })).setAttribute('content', 'noindex');
}
