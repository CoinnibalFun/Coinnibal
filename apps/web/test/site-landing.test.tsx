import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Landing } from '../src/site/landing/Landing';
import { SiteApp } from '../src/site/mount';
import { resetSiteSettings } from '../src/site/settings';
import { setReducedMotion } from '../src/test/media';
import { SETTINGS, installDomStubs, mockFetch } from './site-helpers';

let restore = () => {};
beforeEach(() => {
  installDomStubs();
  resetSiteSettings();
});
afterEach(() => restore());

describe('the landing (/)', { timeout: 30_000 }, () => {
  it('renders the hero, the sections, the CTAs and the footer, with no way into the game', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, collabOpen: false } } }));
    render(<Landing />);
    expect(screen.getByRole('heading', { level: 1, name: 'Coinnibal' })).toBeTruthy();
    expect(screen.getByText('Coins eating coins.')).toBeTruthy();
    expect(screen.getByText('Eat coins smaller than you. Run from the ones that are bigger. Five minutes later the bell rings and whatever you’ve swallowed is yours.')).toBeTruthy();
    expect(screen.queryByText(/small change with a big appetite|Eat the food/)).toBeNull();
    // the hero links to the holder perks on the same page
    expect(screen.getByTestId('ld-why-link').getAttribute('href')).toBe('#why-nft');
    // the nav (and every button) follows the settings once they are in: Mint and WL are open here, collab and the game are not
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Join the WL/ }).length).toBeGreaterThan(0));
    expect(document.querySelector('a[href="/collab"]')).toBeNull();
    const wl = screen.getAllByRole('link', { name: /Join the WL/ });
    expect(wl.every((a) => a.getAttribute('href') === '/wl')).toBe(true);
    for (const h of ['You are a coin.', 'Four steps, one round.', 'Get the Coinnibal NFT.', 'Why get the NFT?', 'Four rooms, one fee.', 'Good to know.'])
      expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    // no character cards with prices and jokes, no story lines under the rooms
    expect(document.querySelector('.ld-cast, .ld-suspect')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Asphodel|Lethe|Golden Bough|Isles|Elysi|obol|feast|Homer/i);
    // every holder perk as a card
    const why = screen.getByTestId('why-nft');
    expect([...why.querySelectorAll('.nf-card')].map((c) => c.getAttribute('data-perk'))).toEqual(['fee', 'room', 'shop', 'private', 'skin']);
    expect(why.textContent).toContain('Lower fee: 10% instead of 20%');
    { const m = document.body.textContent?.match(/.{0,60}(testnet|faucet|Short answers).{0,40}/i); expect(m?.[0] ?? null).toBeNull(); }
    expect(screen.getByText('What does the Coinnibal NFT give me?')).toBeTruthy();
    // the four rooms, named by price, priced in US dollars (paid in the game token); the $10 one for NFT holders
    for (const [name, fee] of [['$1 Room', '$1'], ['$3 Room', '$3'], ['$5 Room', '$5'], ['$10 Room', '$10']]) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeTruthy();
      expect(within(screen.getByRole('heading', { level: 3, name }).closest('.ld-ticket') as HTMLElement).getByText(fee)).toBeTruthy();
    }
    expect(within(screen.getByRole('heading', { level: 3, name: '$10 Room' }).closest('.ld-ticket') as HTMLElement).getByText('NFT holders only')).toBeTruthy();
    expect(screen.getByText('Not open yet')).toBeTruthy();
    // the NFT plate links to the mint; the header has the nav and Connect
    expect(screen.getAllByRole('link', { name: 'Go to the mint' })[0].getAttribute('href')).toBe('/mint');
    const nav = screen.getByRole('navigation', { name: 'Site' });
    // the header nav is short and names only what is open: Mint · WL · Docs (the game is admins-only here)
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Mint', 'WL', 'Guide']);
    expect(screen.getByRole('button', { name: /Connect/ })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /@coinnibalfun/ }).some((a) => a.getAttribute('href') === 'https://x.com/coinnibalfun')).toBe(true);
    // no way into the closed game anywhere on the page, and no "live" round
    expect(document.querySelector('a[href="/play"], a[href="/faucet"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Round 418/);
    // sound is off until the visitor turns it on
    expect(screen.getByRole('button', { name: /Sound off/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows Collab when collabs are open, and Play when the game is public', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, collabOpen: true, gameAccess: 'public' } } }));
    render(<Landing />);
    await waitFor(() => expect(within(document.querySelector('main')!).getByRole('link', { name: /^Play$/ }).getAttribute('href')).toBe('/play'));
    expect(screen.getByText('Round 418 · live')).toBeTruthy();
    expect(screen.getByText('WL → Mint → Play')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Collab/ })[0].getAttribute('href')).toBe('/collab');
  });

  it('animates the pond, the chase and the wordmark, and holds them still with reduced motion', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    const { unmount } = render(<Landing />);
    expect(document.querySelector('.ld-pond')?.getAttribute('data-still')).toBe('false');
    expect(document.querySelector('.ld-chase')?.classList.contains('is-still')).toBe(false);
    expect(document.querySelector('.ld-hero .kb-wordmark')?.classList.contains('kb-wordmark--playful')).toBe(true);
    unmount();
    setReducedMotion(true);
    render(<Landing />);
    expect(document.querySelector('.ld-pond')?.getAttribute('data-still')).toBe('true');
    expect(document.querySelector('.ld-chase')?.classList.contains('is-still')).toBe(true);
    expect(document.querySelector('.ld-hero .kb-wordmark')?.classList.contains('kb-wordmark--playful')).toBe(false);
  });

  it('takes the X handle in the footer and the FAQ from the settings', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, xHandle: 'feastbot' } } }));
    render(<Landing />);
    await waitFor(() => expect(screen.getAllByRole('link', { name: /@feastbot/ }).length).toBeGreaterThan(0));
    expect(screen.getAllByRole('link', { name: /@feastbot/ }).every((a) => a.getAttribute('href') === 'https://x.com/feastbot')).toBe(true);
    expect(screen.getByText(/using ETH for gas/)).toBeTruthy();
  });

  const CLOSED = { ...SETTINGS, wlOpen: false, collabOpen: false, mintOpen: false, gameAccess: 'admins' as const };
  const closedLinks = 'a[href="/play"], a[href="/mint"], a[href="/faucet"], a[href="/wl"], a[href="/collab"]';
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

  it('everything closed: an information page. "How it works" leads, X follows, nothing closed is linked or named as live', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: CLOSED } }));
    render(<Landing />);
    await settle();
    const how = screen.getByTestId('ld-how-link');
    expect(how.getAttribute('href')).toBe('/docs');
    expect(how.className).toContain('kb-btn--primary');
    expect(screen.getByTestId('ld-x-link').getAttribute('href')).toBe('https://x.com/coinnibalfun');
    expect(document.querySelector(closedLinks)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Join the WL|Go to the mint|WL → Mint → Play|Round 418|WL is open|Play now/);
    expect(document.querySelector('.ld-flow, .ld-flowline, .ld-nft__ctas')).toBeNull();
    // the NFT's perks stay: they are information
    expect(screen.getByTestId('ld-why-link').getAttribute('href')).toBe('#why-nft');
    expect(screen.getByTestId('why-nft').querySelectorAll('.nf-card').length).toBeGreaterThan(3);
    expect(screen.getByRole('heading', { name: 'The Coinnibal NFT.' })).toBeTruthy();
    // the header: Docs only, no wallet button; the footer: X and Docs
    expect([...screen.getByRole('navigation', { name: 'Site' }).querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Guide']);
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
    expect([...screen.getByRole('navigation', { name: 'Footer' }).querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://x.com/coinnibalfun', '/docs']);
    // the FAQ does not send anyone to the collab page
    expect(screen.queryByText('Can my community get WL spots?')).toBeNull();
    // each idea once: "five minutes" stays in the hero sentence and on its sticker, nowhere else in the hero or its title strip
    const hero = `${document.querySelector('.ld-plate1')?.textContent} ${document.querySelector('.ld-hero')?.textContent}`;
    expect(hero.match(/5-minute|five minutes?|0?5:00/gi)).toEqual(['Five minutes', '05:00']);
    const page = document.querySelector('main')!.textContent ?? '';
    expect(page.match(/Coins eating coins/g)).toHaveLength(1);
    expect(page.match(/Eat or be eaten/g)).toHaveLength(1);
    expect(document.querySelector('.st-foot')!.textContent).not.toMatch(/Coins eating coins|Eat or be eaten|Five minutes/);
    // the fee's numbers: once for everyone (the rooms), once for holders (the NFT's first perk)
    expect(page.match(/15% is burned and 5% goes to the team wallet/g)).toHaveLength(1);
    expect(page.match(/8% is burned and 2% goes to the team wallet/g)).toHaveLength(1);
    // information only: no price of the mint, no date, no promise
    expect(screen.queryByText('How much is the NFT?')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bsoon\b|start date|post the date|at launch|mint it with|mint page shows/i);
  });

  it('shows nothing closed while the settings are still loading, and stays closed when the server cannot be reached', async () => {
    ({ restore } = mockFetch({}));
    render(<Landing />);
    expect(document.querySelector(closedLinks)).toBeNull();
    await settle();
    expect(document.querySelector(closedLinks)).toBeNull();
    expect(screen.getByTestId('ld-how-link').getAttribute('href')).toBe('/docs');
  });

  it('each part comes back when the admin reopens it', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...CLOSED, mintOpen: true } } }));
    const first = render(<Landing />);
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Go to the mint' })[0].getAttribute('href')).toBe('/mint'));
    expect(document.querySelector('a[href="/play"], a[href="/faucet"], a[href="/wl"], a[href="/collab"]')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Get the Coinnibal NFT.' })).toBeTruthy();
    first.unmount();
    restore();
    resetSiteSettings();
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...CLOSED, wlOpen: true, collabOpen: true, gameAccess: 'holders' } } }));
    render(<Landing />);
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Join the WL/ })[0].getAttribute('href')).toBe('/wl'));
    expect(document.querySelector('main a[href="/collab"]')).toBeTruthy();
    expect(within(document.querySelector('main')!).getByRole('link', { name: 'Play (NFT holders)' }).getAttribute('href')).toBe('/play');
    expect(document.querySelector('a[href="/mint"]')).toBeNull();
    expect(screen.getByText('Can my community get WL spots?')).toBeTruthy();
  });

  it('a closed page says "not open yet" (never the real page or a 404); the same path opens when the admin opens it', async () => {
    for (const [path, line] of [
      ['/mint', 'The Coinnibal NFT is minted on this page. The guide explains what the NFT does.'],
      ['/faucet', 'The faucet gives free test tokens for the game. The guide explains how the game works.'],
      ['/collab', 'Communities ask for WL spots on this page. The guide explains how the game works.'],
    ]) {
      resetSiteSettings();
      ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: CLOSED } }));
      history.pushState(null, '', path);
      try {
        const view = render(<SiteApp />);
        expect(await screen.findByRole('heading', { level: 1, name: 'Not open yet.' })).toBeTruthy();
        expect(screen.getByText(line)).toBeTruthy();
        expect(screen.getByRole('link', { name: /Back to home/ }).getAttribute('href')).toBe('/');
        expect(screen.getByRole('link', { name: /Read the guide/ }).getAttribute('href')).toBe('/docs');
        expect(screen.getByRole('link', { name: /Follow @coinnibalfun/ }).getAttribute('href')).toBe('https://x.com/coinnibalfun');
        expect(document.querySelector(closedLinks)).toBeNull();
        expect(screen.queryByText('This page does not exist.')).toBeNull();
        await waitFor(() => expect(document.title).toBe('Not open yet · Coinnibal'));
        expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
        view.unmount();
      } finally {
        restore();
        history.pushState(null, '', '/');
      }
    }
    // reopened: the collab page itself
    resetSiteSettings();
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...CLOSED, collabOpen: true } } }));
    history.pushState(null, '', '/collab');
    try {
      render(<SiteApp />);
      await waitFor(() => expect(document.querySelector('.cb-root, [class*="cb-"]')).toBeTruthy(), { timeout: 8000 });
      expect(screen.queryByTestId('closed-page')).toBeNull();
      expect(screen.queryByTestId('admin-preview')).toBeNull();
    } finally {
      history.pushState(null, '', '/');
    }
  });

  it('a signed-in admin still gets a closed page (to check it before opening), with a tag that says so', async () => {
    const ADMIN = '0xAdA0000000000000000000000000000000000001';
    localStorage.setItem('elymum.auth.v1', JSON.stringify({ address: ADMIN, token: 'admin-token', exp: Date.now() + 3600_000 }));
    localStorage.setItem('elymum.site.admin.v1', ADMIN);
    resetSiteSettings();
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: CLOSED }, 'GET /api/auth/me': { address: ADMIN, admin: true } }));
    history.pushState(null, '', '/collab');
    try {
      const view = render(<SiteApp />);
      expect(await screen.findByTestId('admin-preview', {}, { timeout: 8000 })).toBeTruthy();
      expect(screen.queryByTestId('closed-page')).toBeNull();
      view.unmount();
      // the flag in the browser alone is not enough: the server says who is an admin
      restore();
      resetSiteSettings();
      ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: CLOSED }, 'GET /api/auth/me': { address: ADMIN, admin: false } }));
      render(<SiteApp />);
      expect(await screen.findByTestId('closed-page')).toBeTruthy();
      expect(screen.queryByTestId('admin-preview')).toBeNull();
    } finally {
      localStorage.clear();
      history.pushState(null, '', '/');
    }
  });

  it('feeds a pond coin on click and shuffles the NFT cards on demand', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    setReducedMotion(false);
    render(<Landing />);
    const hungry = document.querySelector('.ld-pond__c--hungry') as HTMLElement;
    fireEvent.click(hungry);
    expect(hungry.classList.contains('is-drop')).toBe(true);
    await waitFor(() => expect(hungry.classList.contains('is-chew')).toBe(true), { timeout: 4000 });
    expect(hungry.textContent).toContain('+a bite');
    const front = () => (document.querySelector('.ld-fan__card[data-slot="front"] .ld-emblem__coin') as HTMLElement).closest('.ld-fan__card')?.getAttribute('data-slot');
    const before = [...document.querySelectorAll('.ld-fan__card')].map((c) => c.getAttribute('data-slot')).join();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Shuffle' })));
    const after = [...document.querySelectorAll('.ld-fan__card')].map((c) => c.getAttribute('data-slot')).join();
    expect(after).not.toBe(before);
    expect(front()).toBe('front');
  });

  it('shows a plain not-found page for a path the site does not know', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    history.pushState(null, '', '/Terrace-Nine');
    try {
      render(<SiteApp />);
      expect(screen.getByRole('heading', { level: 1, name: 'This page does not exist.' })).toBeTruthy();
      expect(screen.getByText('/Terrace-Nine', { selector: 'code' })).toBeTruthy();
      expect(screen.getByRole('link', { name: /Back to home/ }).getAttribute('href')).toBe('/');
      await waitFor(() => expect(document.title).toBe('Page not found · Coinnibal'));
    } finally {
      history.pushState(null, '', '/');
    }
  });
});
