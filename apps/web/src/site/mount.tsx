import { lazy, StrictMode, Suspense, useEffect, useState, type ComponentType } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { AdminPreviewTag, ClosedPage } from './Closed';
import { pageDoor, useAdminPreview, useDoors } from './doors';
import { setStaticEntrance } from './landing/hydrated';
import { Landing } from './landing/Landing';
import { NotFound } from './NotFound';
import { prefetchMintState } from './mint/mintState';
import { isLazyPage, loadPage, loadedPage, warmPage } from './pages';
import { installChunkRecovery, PageBoundary } from './recover';
import { isSitePath, normalizePath, usePath } from './router';
import { setPageHead } from './seo';
import { useClaimedTitle } from './pageTitle';
import { loadSiteSettings } from './settings';
import { SiteLoader } from './SiteLoader';
import { useLocale, useT, type TKey } from '../i18n';

// the form pages carry the wallet adapter; the landing does not. A page that was warmed (link
// hover / touch, see pages.ts) renders directly, without Suspense, so it never flashes the loader.
const lazies = new Map<string, ComponentType>();
function lazyPage(path: string): ComponentType {
  let c = lazies.get(path);
  if (!c) {
    // warm already: the page itself; else a lazy wrapper (once resolved it never suspends again).
    // A failed download rejects: the boundary reloads once (a stale tab after a deploy) or offers
    // a retry; it is never shown as "not found".
    c = loadedPage(path) ?? lazy(() => loadPage(path).then((p) => ({ default: p })));
    lazies.set(path, c);
  }
  return c;
}

/**
 * `/mint`'s stand-in while its heavy chunk (wallets, viem) downloads: a small chunk of its own with
 * the site frame and the skeleton card, so the page has its shape at once.
 */
const loadMintShell = () => import('./mint/MintShell').then((m) => ({ default: m.MintPageSkeleton }));
const MintShell = lazy(loadMintShell);
const SHELLS: Record<string, ComponentType> = { '/mint': MintShell };

/** After the landing has settled (idle), fetch the mint page's code so the click finds it ready (only while the mint page is open). */
function warmFromLanding(): () => void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  let idle: number | undefined;
  const timer = window.setTimeout(() => {
    const go = () => {
      void loadMintShell();
      void warmPage('/mint');
    };
    if (w.requestIdleCallback) idle = w.requestIdleCallback(go, { timeout: 4000 });
    else go();
  }, 1500);
  return () => {
    clearTimeout(timer);
    if (idle !== undefined) w.cancelIdleCallback?.(idle);
  };
}

const TITLES: Record<string, TKey> = {
  '/': 'site.title.home',
  '/wl': 'site.title.wl',
  '/collab': 'site.title.collab',
  '/docs': 'site.title.docs',
  '/mint': 'site.title.mint',
  '/faucet': 'site.title.faucet',
};

export function SiteApp() {
  const path = usePath();
  const t = useT();
  const locale = useLocale();
  const [attempt, setAttempt] = useState(0);
  const doors = useDoors();
  // a page the admin has not opened (`/mint`, `/faucet`, `/collab`): visitors get "not open yet"; a signed-in
  // admin gets the real page, to look it over before opening it
  const door = pageDoor(path);
  const shut = door !== null && doors.loaded && !doors[door];
  const admin = useAdminPreview(shut);
  const closed = shut && admin === false;
  // a page may claim its own tab title while it shows (the WL's closed card: pageTitle.ts)
  const claimed = useClaimedTitle();
  useEffect(() => {
    document.title = t(claimed ?? (closed ? 'site.title.closed' : (TITLES[path] ?? (isSitePath(path) ? TITLES['/'] : 'site.nf.docTitle'))));
    // /wl draws its own closed card (the WL door is not a page door), but shares and searches see a closed page too
    const wlShut = path === '/wl' && doors.loaded && !doors.wl;
    setPageHead(path, !closed && !shut && !wlShut && (path === '/' || isLazyPage(path)));
  }, [path, locale, t, claimed, closed, shut, doors.loaded, doors.wl]);
  useEffect(() => (path === '/' && doors.mint ? warmFromLanding() : undefined), [path, doors.mint]);
  if (path === '/')
    return (
      <PageBoundary resetKey={path}>
        <Landing />
      </PageBoundary>
    );
  if (!isLazyPage(path)) return <NotFound path={path} />;
  // the settings (or the admin check) are still on their way: the loader, never a flash of the wrong page
  if (door !== null && (!doors.loaded || (shut && admin === null))) return <SiteLoader />;
  if (closed) return <ClosedPage path={path} />;
  const Page = lazyPage(path);
  const Shell = SHELLS[path];
  return (
    <PageBoundary
      resetKey={`${path}#${attempt}`}
      onRetry={() => {
        // a failed lazy keeps its rejection: build a fresh one for the next try
        if (!loadedPage(path)) lazies.delete(path);
        setAttempt((n) => n + 1);
      }}
    >
      <Suspense fallback={<SiteLoader />}>
        {shut && <AdminPreviewTag />}
        {Shell ? (
          <Suspense fallback={<Shell />}>
            <Page />
          </Suspense>
        ) : (
          <Page />
        )}
      </Suspense>
    </PageBoundary>
  );
}

/**
 * The server sent the prerendered landing (`landing.html`, written by the build: vite.config.ts `prerenderLanding`):
 * `#root` holds the page's markup instead of the `.boot` loader. Only `/` is ever prerendered.
 */
export function isPrerendered(root: HTMLElement): boolean {
  const first = root.firstElementChild;
  return first !== null && !first.classList.contains('boot') && normalizePath(location.pathname) === '/';
}

/** The public site: `/`, `/mint`, `/faucet`, `/wl`, `/collab`, `/docs`. */
export function mount(root: HTMLElement): void {
  document.documentElement.dataset.theme = 'light';
  installChunkRecovery();
  if (isPrerendered(root)) {
    // React takes over the painted page as it is: the same tree as the build's render (prerender.tsx), with the same
    // settings (the closed defaults, which the server checked against landing.json before sending the page), and the
    // entrances in their final state (landing/hydrated.ts); every read of the window waits for the render after this
    setStaticEntrance(true);
    hydrateRoot(
      root,
      <StrictMode>
        <SiteApp />
      </StrictMode>,
    );
    return;
  }
  if ((location.pathname.replace(/\/+$/, '') || '/') === '/mint') {
    // an open mint page: its state, its code and its skeleton all start as soon as the settings say so
    void loadSiteSettings().then((s) => {
      if (!s.mintOpen) return;
      prefetchMintState();
      void loadMintShell();
      void warmPage('/mint');
    });
  }
  createRoot(root).render(
    <StrictMode>
      <SiteApp />
    </StrictMode>,
  );
}
