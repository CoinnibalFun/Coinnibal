// Ring Storybook design system (spec §6): fonts, tokens (on :root and every `.kb`) and styles.
// Fraunces "full" carries the SOFT and WONK axes (display); DM Sans with optical sizes (body);
// Geist Mono (every number). The latin upright Fraunces comes from design/fonts (SOFT pinned at 100, the only value
// the site uses): imported after fontsource's faces, so it wins for latin text and the fontsource latin file is
// never fetched; fontsource still serves latin-ext letters (player names) and the italic.
import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/fraunces/full-italic.css';
import './design/fonts/fraunces-soft.css';
import '@fontsource-variable/dm-sans/opsz.css';
import '@fontsource-variable/dm-sans/opsz-italic.css';
import './design/fonts/dm-sans-fallback.css';
import '@fontsource-variable/geist-mono/wght.css';
import './design/tokens.css';
import './design/storybook.css';
import './chainText';
import { initLocale, t } from './i18n';
import { storageKey } from './storageKey';

const root = document.getElementById('root')!;
const params = new URLSearchParams(location.search);

const path = location.pathname.replace(/\/+$/, '') || '/';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The entry's own chunk failed (a tab or cache from before a deploy, or the network): reload once,
 * then say so plainly instead of leaving a blank page. The prerendered landing (`landing.html`) is
 * left as it is: it is already painted and works without script (plain links, the FAQ's
 * <details>), so a reload or the note would only take a readable page away.
 */
function bootFailed(err: unknown): void {
  console.error('the page failed to load', err);
  const first = root.firstElementChild;
  if (first !== null && !first.classList.contains('boot')) return;
  const KEY = storageKey('boot-reload.v1', 'session');
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (!last || Date.now() - last > 30_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      location.reload();
      return;
    }
  } catch {
    /* no storage: show the note */
  }
  root.innerHTML =
    '<main style="max-width:520px;margin:15vh auto;padding:24px;font-family:system-ui,sans-serif;text-align:center" role="alert" data-testid="boot-failed">' +
    `<h1 style="font-size:28px;margin:0 0 12px">${esc(t('boot.title'))}</h1>` +
    `<p style="margin:0 0 20px;line-height:1.5">${esc(t('boot.body'))}</p>` +
    `<button type="button" onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:12px;border:2px solid #0f2a30;background:#ffd23f;cursor:pointer">${esc(t('boot.reload'))}</button></main>`;
}

/** Mounts once the page's chunk and the visitor's language are both in (they download side by side). */
function boot<M>(page: Promise<M>, start: (m: M) => void): void {
  void Promise.all([page, initLocale()])
    .then(([m]) => start(m))
    .catch(bootFailed);
}

if (path === '/admin') {
  // Operator panel (chain admin, WL, collabs, site settings): its own lazy chunk, English only.
  void import('./admin/mount').then((m) => m.mount(root)).catch(bootFailed);
} else if (import.meta.env.DEV && params.has('gallery')) {
  // Design-system proof sheet (every component, both themes). The three proof sheets are dev-only: a production
  // build drops them (they carry old copy no visitor should see), so `/?gallery` there is the landing.
  boot(import('./design/Gallery'), (m) => m.startDesignGallery(root));
} else if (import.meta.env.DEV && params.has('coins')) {
  // Coin / world sprite sheet (was ?gallery before v2).
  boot(import('./gallery'), (m) => m.startGallery(root));
} else if (import.meta.env.DEV && params.has('flagskins')) {
  // Flag skin proof sheet (coins painted with their flags; `?flagskins=TR,US` for a list, `all` for every flag).
  boot(import('./flag-gallery'), (m) => m.startFlagGallery(root, params.get('flagskins') ?? ''));
} else if (path === '/play') {
  // The arena (lobby + game engine), behind the game gate: admins only until the game is public.
  boot(import('./site/play/start'), (m) => m.startPlay(root));
} else {
  // The site: the landing, the WL and collab applications, the mint and the player guide. No game engine.
  boot(import('./site/mount'), (m) => m.mount(root));
}
