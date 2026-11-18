import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteHeader } from '../src/site/Shell';
import { resetSiteSettings } from '../src/site/settings';
import { SETTINGS, mockFetch } from './site-helpers';

let restore = () => {};
beforeEach(() => resetSiteSettings());
afterEach(() => restore());

describe('the phone menu', () => {
  it('keeps Tab inside the open menu and gives focus back to its button on Escape', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, gameAccess: 'public' } } }));
    render(<SiteHeader />);
    const btn = await screen.findByRole('button', { name: 'Open the menu' });
    act(() => btn.click());
    btn.focus();
    const sheet = screen.getByRole('navigation', { name: 'Site menu' });
    // its links, the Play button last (English only: no language tag)
    const stops = [btn, ...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    expect(sheet.querySelector('[data-testid="lang-pick"]')).toBeNull();
    for (let i = 1; i <= stops.length; i++) {
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(document.activeElement).toBe(stops[i % stops.length]);
    }
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('navigation', { name: 'Site menu' })).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it('with everything closed: Docs is the one link; Play, WL and Collab are named with a Soon tag and link nowhere; no wallet button', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, wlOpen: false, collabOpen: false, mintOpen: false, gameAccess: 'admins' } } }));
    localStorage.clear();
    const { container } = render(<SiteHeader />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect([...screen.getByRole('navigation', { name: 'Site' }).querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/docs']);
    const soon = [...container.querySelectorAll('.st-nav .st-nav__link--soon')];
    expect(soon.map((s) => s.textContent)).toEqual(['PlaySoon', 'WLSoon', 'CollabSoon']);
    expect(soon.every((s) => s.tagName === 'SPAN' && s.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
    // on screen the three share one Soon chip (no dashed outline around them); a pointer or the keyboard's focus on one
    // shows its own tip with what it will be (no native title tooltip on top of it)
    expect(container.querySelectorAll('.st-nav .st-soonset__tag')).toHaveLength(1);
    expect(soon.every((s) => s.getAttribute('tabindex') === '0' && !s.hasAttribute('title'))).toBe(true);
    expect(soon.map((s) => document.getElementById(s.getAttribute('aria-describedby')!)?.textContent)).toEqual([
      'The game. It opens after the NFT mint and the token.',
      "Where you'll apply for the whitelist.",
      'Where communities ask for WL spots.',
    ]);
    // wide screens: the project's X account at the end of the nav
    expect(screen.getByRole('link', { name: '@coinnibalfun on X' }).getAttribute('href')).toBe('https://x.com/coinnibalfun');
    // on a phone the menu sheet holds the guide and X, each with a line on what is there, then the closed parts with
    // what each will be (still not links)
    fireEvent.click(screen.getByRole('button', { name: 'Open the menu' }));
    const sheet = screen.getByRole('navigation', { name: 'Site menu' });
    expect([...sheet.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/docs', 'https://x.com/coinnibalfun']);
    expect(sheet.textContent).toContain('Rules, fees, the risks and wallet safety');
    expect(sheet.textContent).toContain('News, and the one OpenSea link to trust');
    const rows = [...sheet.querySelectorAll('.st-nav__link--soon')];
    expect(rows.map((r) => r.textContent)).toEqual([
      'PlayThe game. It opens after the NFT mint and the token.Soon',
      "WLWhere you'll apply for the whitelist.Soon",
      'CollabWhere communities ask for WL spots.Soon',
    ]);
    expect(rows.every((r) => r.tagName === 'SPAN' && r.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(container.querySelector('a[href="/play"], a[href="/mint"], a[href="/faucet"], a[href="/wl"], a[href="/collab"]')).toBeNull();
  });

  it('locks the page behind the open menu, and lets it scroll again once the menu closes', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, gameAccess: 'admins' } } }));
    const view = render(<SiteHeader />);
    const btn = await screen.findByRole('button', { name: 'Open the menu' });
    expect(document.documentElement.classList.contains('st-menu-open')).toBe(false);
    act(() => btn.click());
    expect(document.documentElement.classList.contains('st-menu-open')).toBe(true);
    // the menu button turns into the close button (it stays above the dimmed page)
    act(() => screen.getByRole('button', { name: 'Close the menu', expanded: true }).click());
    expect(screen.queryByRole('navigation', { name: 'Site menu' })).toBeNull();
    expect(document.documentElement.classList.contains('st-menu-open')).toBe(false);
    act(() => btn.click());
    view.unmount();
    expect(document.documentElement.classList.contains('st-menu-open')).toBe(false);
  });

  it('on a closed page that has a Soon item, marks that item as the current place (still not a link)', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, wlOpen: false, collabOpen: false, mintOpen: false, gameAccess: 'admins' } } }));
    history.pushState(null, '', '/wl');
    try {
      const { container } = render(<SiteHeader />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      const here = [...container.querySelectorAll('.st-nav [aria-current="page"]')];
      expect(here.map((s) => [s.tagName, s.textContent, s.classList.contains('is-here')])).toEqual([['SPAN', 'WLSoon', true]]);
      expect(here[0].getAttribute('aria-disabled')).toBe('true');
    } finally {
      history.pushState(null, '', '/');
    }
  });

});
