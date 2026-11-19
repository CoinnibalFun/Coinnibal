import { SITE_SETTINGS_DEFAULT } from '@coinnibal/shared';
import { act, StrictMode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStaticEntrance } from '../src/site/landing/hydrated';
import { SiteApp } from '../src/site/mount';
import { resetServerChain } from '../src/site/serverChain';
import { resetSiteSettings } from '../src/site/settings';
import { TOKEN_KEY } from '../src/site/storedSession';
import { setMatchingQueries, setReducedMotion } from '../src/test/media';
import { installDomStubs, mockFetch } from './site-helpers';

/**
 * S1 of the site's speed plan: `/` is prerendered at build time (site/landing/prerender.tsx) and the browser hydrates
 * it (site/mount.tsx). If the browser's first render differs from the HTML, React 19 throws the HTML away and renders
 * the page again (a flash, and the prerender's gain lost) or, for an attribute, keeps a stale one. Each case renders
 * the landing as the build does (the static-entrance flag on), puts the markup in the page and hydrates it in a
 * browser that differs from the build's assumptions: no recoverable error, no console error, and the server's nodes
 * are kept.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let restore = () => {};
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  installDomStubs();
  resetSiteSettings();
  resetServerChain();
  // the server answers the closed defaults the page was rendered with (it sends landing.html only then)
  ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SITE_SETTINGS_DEFAULT, xHandle: 'coinnibalfun' } } }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  restore();
  localStorage.clear();
  setStaticEntrance(false);
});

/**
 * The build's render (made here before the browser's conditions are set: the build runs in Node, with no stored
 * session, no media queries and no reduced motion), put in the page, then `browser()` turns this browser's conditions
 * on and the page is hydrated. Returns the markup, the spies and the nodes the HTML painted.
 */
async function hydrateLanding(browser: () => void = () => {}) {
  setStaticEntrance(true);
  const html = renderToString(
    <StrictMode>
      <SiteApp />
    </StrictMode>,
  );
  container = document.createElement('div');
  container.id = 'root';
  container.innerHTML = html;
  document.body.appendChild(container);
  const painted = container.querySelector('.ld-hero__lede');
  const card = container.querySelector('.ld-hero__drop');
  browser();
  const recoverable = vi.fn();
  const errors = vi.spyOn(console, 'error');
  try {
    await act(async () => {
      root = hydrateRoot(
        container!,
        <StrictMode>
          <SiteApp />
        </StrictMode>,
        { onRecoverableError: recoverable },
      );
    });
    // the effects after hydration: the settings arrive, the browser's real answers re-render
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    return { html, painted, card, recoverable, errors: errors.mock.calls.map((c) => c.map(String).join(' ')) };
  } finally {
    errors.mockRestore();
  }
}

/** What every case checks: no error, and React kept the nodes the HTML painted (it did not render the page again). */
function expectKept(r: Awaited<ReturnType<typeof hydrateLanding>>) {
  expect(r.recoverable).not.toHaveBeenCalled();
  expect(r.errors).toEqual([]);
  expect(r.painted).toBeTruthy();
  expect(container!.querySelector('.ld-hero__lede')).toBe(r.painted);
  expect(container!.querySelector('.ld-hero__drop')).toBe(r.card);
}

describe('hydrating the prerendered landing', { timeout: 30_000 }, () => {
  it('keeps the HTML: the hero card and its badge in their landed state, no hop, no drop', async () => {
    const r = await hydrateLanding();
    expectKept(r);
    // the HTML shows the card where it lands (opaque, its tilt) and the badge at full size, and so does the page after
    expect(r.html).toContain('<div class="ld-hero__drop" style="opacity:1;transform:rotate(-1.6deg)">');
    expect(r.html).toMatch(/<div class="ld-hero__badge-wrap" style="opacity:1;transform:none">/);
    const card = container!.querySelector<HTMLElement>('.ld-hero__drop')!;
    expect([card.style.opacity, card.style.transform]).toEqual(['1', 'rotate(-1.6deg)']);
    // the wordmark's letters start settled (no load hop), Plate I is printed already
    expect(container!.querySelector('.ld-hero__title')?.className).toContain('is-settled');
    expect(container!.querySelector('.ld-root')?.classList.contains('ld-root--static')).toBe(true);
    // closed defaults: no wallet button, the guide as the main action
    expect(container!.querySelector('.st-connect')).toBeNull();
    expect(container!.querySelector('[data-testid="ld-how-link"]')).toBeTruthy();
  });

  it('a stored session: no error, and the wallet button comes right after hydration', async () => {
    const r = await hydrateLanding(() =>
      localStorage.setItem(TOKEN_KEY, JSON.stringify({ address: '0x1111111111111111111111111111111111111111', token: 't', exp: Date.now() + 3600_000 })),
    );
    // the build's render had no button (no stored session on a server)
    expect(r.html).not.toContain('st-connect');
    expectKept(r);
    expect(container!.querySelector('.st-connect')).toBeTruthy();
  });

  it('reduced motion: no error, then the page settles into its still frame', async () => {
    const r = await hydrateLanding(() => setReducedMotion(true));
    expect(r.html).toContain('data-still="false"');
    expectKept(r);
    expect(container!.querySelector('.ld-pond')?.getAttribute('data-still')).toBe('true');
    expect(container!.querySelector('.ld-pond__hint')).toBeNull();
  });

  it('a phone: no error, then the bites take their phone size (the card tilt is CSS)', async () => {
    const r = await hydrateLanding(() => setMatchingQueries(['(max-width: 479px)', '(max-width: 639px)']));
    expectKept(r);
    // the build rendered the desktop bites; the phone re-renders them right after hydration
    expect(r.html).toContain('--bite-s:56px');
    expect(container!.querySelector<HTMLElement>('#feast .ld-bite')?.style.getPropertyValue('--bite-s')).toBe('40px');
    expect(container!.querySelector<HTMLElement>('.ld-hero__drop')?.style.transform).toBe('rotate(-1.6deg)');
  });
});
