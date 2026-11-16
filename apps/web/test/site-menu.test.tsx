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
    // on a phone they sit in the menu sheet, still not links
    fireEvent.click(screen.getByRole('button', { name: 'Open the menu' }));
    const sheet = screen.getByRole('navigation', { name: 'Site menu' });
    expect([...sheet.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/docs']);
    expect(sheet.querySelectorAll('.st-nav__link--soon')).toHaveLength(3);
    expect(container.querySelector('a[href="/play"], a[href="/mint"], a[href="/faucet"], a[href="/wl"], a[href="/collab"]')).toBeNull();
  });

});
