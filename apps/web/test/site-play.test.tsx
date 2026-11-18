import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayGate, playAccess } from '../src/site/play/PlayGate';
import { TOKEN_KEY } from '../src/site/session';
import { resetSiteSettings } from '../src/site/settings';
import { SETTINGS, installDomStubs, json, mockFetch } from './site-helpers';

const ADMIN = '0xAdA0000000000000000000000000000000000001';
const USER = '0x1111111111111111111111111111111111111111';
const store = (address: string, token: string) => localStorage.setItem(TOKEN_KEY, JSON.stringify({ address, token, exp: Date.now() + 3600_000 }));

let restore = () => {};
beforeEach(() => {
  installDomStubs();
  localStorage.clear();
  resetSiteSettings();
});
afterEach(() => restore());

describe('the /play gate', { timeout: 30_000 }, () => {
  it('blocks a visitor with no session: "The game isn\'t open yet", the launch order, the guide, home and X; no WL or mint promise', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, wlOpen: false, collabOpen: false, mintOpen: false } } }));
    const onAllowed = vi.fn();
    render(<PlayGate onAllowed={onAllowed} />);
    expect(await screen.findByRole('heading', { level: 1, name: /The game isn’t open yet/ })).toBeTruthy();
    // the owner's launch order, no dates
    expect(screen.getByText("Even the guard's asleep. First comes the NFT mint, then the token, then the game, and the guide already has every rule.")).toBeTruthy();
    // one label: the heading (no title strip, no eyebrow over it)
    expect(document.querySelector('.kb-plate, .pg-kicker')).toBeNull();
    expect(document.querySelector('main')?.textContent ?? document.body.textContent).not.toMatch(/start date|soon|until then/i);
    expect(screen.getByRole('link', { name: 'Back to home' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: 'Read the guide' }).getAttribute('href')).toBe('/docs');
    expect(screen.getByRole('link', { name: /Follow @coinnibalfun/ }).getAttribute('href')).toBe('https://x.com/coinnibalfun');
    expect(document.querySelector('a[href="/wl"], a[href="/mint"], a[href="/collab"], a[href="/faucet"], a[href="/play"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Join the WL|Go to the mint/);
    // the same buttons as the site's other closed pages, and the same tab title
    expect(screen.getByRole('link', { name: 'Back to home' }).className).toContain('kb-btn');
    expect(document.title).toBe('Not open yet · Coinnibal');
    expect(onAllowed).not.toHaveBeenCalled();
  });

  it('maintenance: visitors see "Back soon" (no WL or mint pitch); the admin still gets in', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, gameAccess: 'maintenance' } } }));
    const onAllowed = vi.fn();
    render(<PlayGate onAllowed={onAllowed} />);
    expect(await screen.findByRole('heading', { name: /Back soon/ })).toBeTruthy();
    expect(screen.getByTestId('pg-maintenance')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Join the WL' })).toBeNull();
    expect(onAllowed).not.toHaveBeenCalled();
    restore();
    store(ADMIN, 'admin-token');
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, gameAccess: 'maintenance' } }, 'GET /api/auth/me': { address: ADMIN, admin: true } }));
    expect((await playAccess()).allowed).toBe(true);
  });

  it('blocks a signed-in wallet that is not an admin', async () => {
    store(USER, 'user-token');
    const { calls, restore: r } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS }, 'GET /api/auth/me': { address: USER, admin: false, canPlay: false } });
    restore = r;
    expect(await playAccess()).toEqual({ allowed: false, reason: 'closed', session: null });
    expect(calls.find((c) => c.path === '/api/auth/me')?.auth).toBe('Bearer user-token');
    // an expired token too
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS }, 'GET /api/auth/me': json(401, { error: 'unauthorized' }) }));
    expect((await playAccess()).allowed).toBe(false);
  });

  it('lets the admin in with their session (the game then authenticates with it)', async () => {
    store(ADMIN, 'admin-token');
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS }, 'GET /api/auth/me': { address: ADMIN, admin: true } }));
    const onAllowed = vi.fn();
    render(<PlayGate onAllowed={onAllowed} />);
    await waitFor(() => expect(onAllowed).toHaveBeenCalledWith({ address: ADMIN, token: 'admin-token', admin: true }));
    expect(screen.queryByRole('heading', { name: /game is not open/ })).toBeNull();
  });

  it('opens to everyone when the game is public', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, gameAccess: 'public' } } }));
    const onAllowed = vi.fn();
    render(<PlayGate onAllowed={onAllowed} />);
    await waitFor(() => expect(onAllowed).toHaveBeenCalledWith(null));
    expect(await playAccess()).toMatchObject({ allowed: true, reason: 'public' });
  });

  it('holders mode: a signed-in holder plays; anyone else is asked to sign in with the NFT wallet', async () => {
    const holders = { settings: { ...SETTINGS, gameAccess: 'holders' } };
    ({ restore } = mockFetch({ 'GET /api/site/settings': holders }));
    expect(await playAccess()).toEqual({ allowed: false, reason: 'holders', session: null });
    render(<PlayGate onAllowed={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: /NFT holders only/ })).toBeTruthy();
    // never the site's mint page (the NFT is not minted there), even with the mint door open; the WL, when open
    await waitFor(() => expect(screen.getByRole('link', { name: 'Join the WL' }).getAttribute('href')).toBe('/wl'));
    expect(screen.getByText('Sign in with the wallet that holds your Coinnibal NFT.')).toBeTruthy();
    const card = document.querySelector('.pg-card')!;
    expect(card.querySelector('a[href="/mint"]')).toBeNull();
    expect(card.textContent).not.toMatch(/Go to the mint|mint page|Mint to play/);
    restore();
    store(USER, 'holder-token');
    ({ restore } = mockFetch({ 'GET /api/site/settings': holders, 'GET /api/auth/me': { address: USER, admin: false, canPlay: true } }));
    expect(await playAccess()).toEqual({ allowed: true, reason: 'holder', session: { address: USER, token: 'holder-token', admin: false } });
    restore();
    // a non-holder stays outside
    ({ restore } = mockFetch({ 'GET /api/site/settings': holders, 'GET /api/auth/me': { address: USER, admin: false, canPlay: false } }));
    expect((await playAccess()).reason).toBe('holders');
  });
});
