import { DEFAULT_ARENAS, activeChain, chainInfo, setActiveChain } from '@coinnibal/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Landing } from '../src/site/landing/Landing';
import { SiteApp } from '../src/site/mount';
import { resetSiteSettings } from '../src/site/settings';
import { setReducedMotion } from '../src/test/media';
import { SETTINGS, installDomStubs, intersect, mockFetch } from './site-helpers';

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
    // the pitch never promises the whole amount (the fee is told in step 04 and on the fee card)
    // the founder's sentence (18 Nov), then the payoff with the word every other line uses ("alive")
    expect(screen.getByText('Eat coins smaller than you and run from the ones that are bigger. In a paid room, every coin still alive at the bell gets paid.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/swallowed is yours|is yours\./);
    expect(screen.queryByText(/small change with a big appetite|Eat the food/)).toBeNull();
    // the hero links to the holder perks on the same page
    expect(screen.getByTestId('ld-why-link').getAttribute('href')).toBe('#why-nft');
    // the nav (and every button) follows the settings once they are in: Mint and WL are open here, collab and the game are not
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Join the WL/ }).length).toBeGreaterThan(0));
    expect(document.querySelector('a[href="/collab"]')).toBeNull();
    const wl = screen.getAllByRole('link', { name: /Join the WL/ });
    expect(wl.every((a) => a.getAttribute('href') === '/wl')).toBe(true);
    for (const h of ['Meet Coinnibal.', 'Four steps, one round.', 'Get the Coinnibal NFT.', 'Why get the NFT?', 'Five rooms, one fee.', 'Good to know.'])
      expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    // the section titles are the top bars' sun tabs: no small aside repeats them on the right
    expect(document.querySelector('.kb-plate__aside')).toBeNull();
    // no character cards with prices and jokes, no story lines under the rooms
    expect(document.querySelector('.ld-cast, .ld-suspect')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Asphodel|Lethe|Golden Bough|Isles|Elysi|obol|feast|Homer/i);
    // every holder perk as a card
    const why = screen.getByTestId('why-nft');
    expect([...why.querySelectorAll('.nf-card')].map((c) => c.getAttribute('data-perk'))).toEqual(['fee', 'room', 'shop', 'private', 'skin']);
    expect(why.textContent).toContain('Lower fee: 10% instead of 20%');
    { const m = document.body.textContent?.match(/.{0,60}(testnet|faucet|Short answers).{0,40}/i); expect(m?.[0] ?? null).toBeNull(); }
    // the team asked for NFT questions in the FAQ (what it gives, how many, is each one different)
    expect(screen.getByText('What does the Coinnibal NFT give me?')).toBeTruthy();
    expect(screen.getByText('How many NFTs are there?')).toBeTruthy();
    expect(screen.getByText('Is every NFT different?')).toBeTruthy();
    // the shared skin is one gold look, not the holder's own NFT art
    expect(why.textContent).toContain('Your coin can wear the gold NFT skin, with a holder badge next to your name.');
    expect(why.textContent).not.toMatch(/wears your NFT/);
    // five tickets: free practice first (it carries the "You" tag: everyone starts there), then the four paid rooms,
    // named by price, priced in US dollars (paid in the game token); the $10 one for NFT holders
    const stairs = [...document.querySelectorAll('.ld-stair')];
    expect(stairs.map((s) => s.querySelector('.ld-ticket__name')?.textContent)).toEqual(['Free Practice', '$1 Room', '$3 Room', '$5 Room', '$10 Room']);
    expect(stairs[0].classList.contains('is-practice')).toBe(true);
    expect([...document.querySelectorAll('.ld-stair__you')].map((y) => y.closest('.ld-stair'))).toEqual([stairs[0]]);
    expect(stairs[0].textContent).toContain('No tokens needed');
    for (const [name, fee] of [['$1 Room', '$1'], ['$3 Room', '$3'], ['$5 Room', '$5'], ['$10 Room', '$10']]) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeTruthy();
      expect(within(screen.getByRole('heading', { level: 3, name }).closest('.ld-ticket') as HTMLElement).getByText(fee)).toBeTruthy();
    }
    // the lede counts the paid rooms: "four" stays true only while there are four
    expect(DEFAULT_ARENAS).toHaveLength(4);
    expect(document.querySelector('.ld-arenas__aside p')?.textContent).toMatch(/The four paid rooms/);
    // the fee card states the fee in the guide's words (a no-break space keeps "one fee" on one line), the no-profit case
    // as a sentence, and the holders' fee
    expect(document.querySelector('.ld-feecard')?.textContent).toMatch(/The game takes one\u00a0fee: 20% of your profit\.If you don't make a profit, you pay no fee\.With a Coinnibal NFT, the fee is 10%\./);
    expect(within(screen.getByRole('heading', { level: 3, name: '$10 Room' }).closest('.ld-ticket') as HTMLElement).getByText('NFT holders only')).toBeTruthy();
    expect(screen.getAllByText('Not open yet').length).toBeGreaterThan(0);
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
    // the orbit's tag names one round, never an invented live round number
    expect(screen.getByText('One round')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Round 418|· live/);
    expect(screen.getByText('WL → Mint → Play')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Collab/ })[0].getAttribute('href')).toBe('/collab');
    // the hero: two buttons and Play under them across both (an even block); Collab is a quiet link, not a button
    const ctas = document.querySelector('.ld-hero__ctas')!;
    expect(ctas.classList.contains('ld-hero__ctas--three')).toBe(true);
    expect([...ctas.querySelectorAll('a')].map((a) => a.textContent?.trim())).toEqual(['Join the WL', 'Why get the NFT?', 'Play']);
    expect(screen.getByTestId('ld-collab-link').textContent?.trim()).toBe('Communities can ask for WL spots');
    expect(screen.getByTestId('ld-collab-link').getAttribute('href')).toBe('/collab');
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
    expect(screen.getByText(/Network fees \(gas\) are paid in ETH\./)).toBeTruthy();
    // the safety line is a sentence of its own, not mono small print
    expect(document.querySelector('.st-foot__safety')?.textContent).toBe('We never DM you first, and we never ask for your seed phrase.');
    expect(document.querySelector('.st-foot__small')?.textContent).not.toMatch(/seed phrase/);
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
    // the NFT's heading gives the count instead of repeating its plate
    expect(screen.getByRole('heading', { level: 2, name: '3,333 coin characters.' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'The Coinnibal NFT.' })).toBeNull();
    // the header: Docs only, no wallet button; the footer: X and Docs
    expect([...screen.getByRole('navigation', { name: 'Site' }).querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Guide']);
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
    expect([...screen.getByRole('navigation', { name: 'Footer' }).querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://x.com/coinnibalfun', '/docs']);
    // the FAQ does not send anyone to the collab page
    expect(screen.queryByText('Can my community get WL spots?')).toBeNull();
    // each idea once: the round's length is the hero's sticker, nowhere else in the hero or its title strip
    const hero = `${document.querySelector('.ld-plate1')?.textContent} ${document.querySelector('.ld-hero')?.textContent}`;
    expect(hero.match(/5-minute|five minutes?|0?5:00/gi)).toEqual(['05:00']);
    const page = document.querySelector('main')!.textContent ?? '';
    expect(page.match(/Coins eating coins/g)).toHaveLength(1);
    expect(page.match(/Eat or be eaten/g)).toHaveLength(1);
    expect(document.querySelector('.st-foot')!.textContent).not.toMatch(/Coins eating coins|Eat or be eaten|Five minutes/);
    // the fee's numbers: once for everyone (the rooms), once for holders (the NFT's first perk)
    expect(page.match(/15% burned/g)).toHaveLength(1);
    expect(page.match(/8% of your profit is burned and 2% goes to the team wallet/g)).toHaveLength(1);
    // with nothing open, the NFT section says the launch order beside a "Not open yet" pill (the rooms have the other)
    expect(document.querySelector('.ld-nft__next')?.textContent).toBe('Not open yetThe NFT comes first, before the token and the game. The mint will be on OpenSea.');
    expect(screen.getAllByText('Not open yet')).toHaveLength(2);
    // information only: no price of the mint, no date, no promise
    expect(screen.queryByText('How much is the NFT?')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bsoon\b|start date|post the date|at launch|mint it with|mint page shows/i);
  });

  it('everything closed: each fact once, the FAQ agrees with the guide, the hero money line is the same on every chain', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: CLOSED } }));
    const before = activeChain();
    try {
      // every build says the same: a paid room takes a ticket (no free-at-first phase, no test network)
      setActiveChain(chainInfo(4663));
      render(<Landing />);
      await settle();
      expect(screen.getByTestId('ld-money').textContent).toBe('A paid room takes a ticket in tokens. If you get eaten, you lose it.');
    } finally {
      setActiveChain(before);
    }
    const faq = [...document.querySelectorAll('.ld-qa')];
    // the basic questions first (open? cost? need the NFT?), then the NFT, then wallet and chain, then the rules
    expect(faq.map((q) => q.querySelector('.ld-qa__text')?.textContent)).toEqual([
      'Is the game open?',
      'Does it cost money to play?',
      'Do I need the NFT to play?',
      'What does the Coinnibal NFT give me?',
      'How many NFTs are there?',
      'Is every NFT different?',
      'Which wallet do I need?',
      'What is Robinhood Chain?',
      'Where are all the rules?',
    ]);
    const answer = (q: string) => faq.find((f) => f.querySelector('.ld-qa__text')?.textContent === q)!.querySelector('.ld-qa__a')!.textContent;
    // true while the game is not open to holders only (then the question is hidden): the $10 Room is the exception
    expect(answer('Do I need the NFT to play?')).toBe('No. Anyone can practice for free or buy a ticket for a paid room. The NFT gives perks, and only NFT holders can join the $10 Room.');
    // the team asked for the NFT's questions: what it gives (D11), how many, every one different; full sentences
    expect(answer('What does the Coinnibal NFT give me?')).toBe('Holders pay a fee of 10% on profit instead of 20%, and only holders can join the $10 Room. They get 20% off power-ups and can use 3 power-ups in each paid round instead of 2. They also get one free private room a day and the NFT skin with a holder badge.');
    expect(answer('How many NFTs are there?')).toBe('The collection has 3,333 NFTs.');
    // the chain holds the money, the game runs on a server (as the guide says)
    expect(answer('What is Robinhood Chain?')).toMatch(/the game itself runs on our server/);
    // the cost, once: paid rooms take a ticket, practice is free
    expect(answer('Does it cost money to play?')).toBe('Yes. A paid room takes a ticket in tokens. Practice is free.');
    // the owner's launch order: the NFT mint, then the token, then the game (no dates)
    expect(answer('Is the game open?')).toBe('Not yet. First comes the NFT mint, then the token, then the game. We post news on @coinnibalfun.');
    const page = document.querySelector('main')!.textContent ?? '';
    // practice is free: in the rooms section (its ticket) and in the cost answer
    expect(page.match(/Practice (stays|is) free/g)).toHaveLength(2);
    expect(page.match(/explains every rule/g)).toBeNull();
    // practice and private rooms run no 5-minute bell
    expect(page).toContain('A round lasts 5 minutes in every paid room.');
    // the pond's snack pays tokens, never dollars
    expect(document.querySelector('.ld-chase__pop')?.textContent).toBe('+1,000');
    // the perks are a part of the NFT section: their heading ranks under it
    expect(screen.getByRole('heading', { level: 3, name: 'Why get the NFT?' })).toBeTruthy();
    // no kicker repeats a plate or a heading
    expect(document.querySelectorAll('.ld-feast__copy > .kicker, .ld-round__copy > .kicker, .ld-arenas__head .kicker, .ld-nft__copy > .kicker')).toHaveLength(0);
    // the stairs stand level (only their tickets tilt, in CSS)
    expect([...document.querySelectorAll<HTMLElement>('.ld-stair')].map((s) => s.style.getPropertyValue('--tilt'))).toEqual(['', '', '', '', '']);
    // the steps count up from the practice ticket: step 0 prints first
    expect([...document.querySelectorAll<HTMLElement>('.ld-stair')].map((s) => s.style.getPropertyValue('--step'))).toEqual(['0', '1', '2', '3', '4']);
  });

  it('lights each step of the round, and its station on the orbit, as the visitor reads down to it', async () => {
    const made: { cb: IntersectionObserverCallback; opts?: IntersectionObserverInit; io: IntersectionObserver }[] = [];
    const Base = globalThis.IntersectionObserver as unknown as new (cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) => IntersectionObserver;
    globalThis.IntersectionObserver = class extends Base {
      constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        super(cb, opts);
        made.push({ cb, opts, io: this });
      }
    } as unknown as typeof IntersectionObserver;
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    render(<Landing />);
    const stops = [...document.querySelectorAll('.ld-stop')];
    // the bell step keeps a number and its unit on one line ("30-second" broke at its hyphen)
    expect(stops[2].querySelector('.ld-nowrap')?.textContent).toBe('30-second');
    const read = () => stops.map((s) => s.classList.contains('is-read'));
    const done = () => document.querySelectorAll('.ld-orbit .kb-orbit__station.is-done').length;
    expect(read()).toEqual([false, false, false, false]);
    expect(done()).toBe(0);
    const steps = made.find((o) => o.opts?.rootMargin === '0px 0px -40% 0px')!;
    const entry = (target: Element, isIntersecting: boolean, top: number) => ({ target, isIntersecting, boundingClientRect: { top } }) as unknown as IntersectionObserverEntry;
    act(() => steps.cb([entry(stops[0], true, 300), entry(stops[1], true, 420)], steps.io));
    expect(read()).toEqual([true, true, false, false]);
    expect(done()).toBe(2);
    // a step scrolled above the viewport stays read; the next one crosses the line
    act(() => steps.cb([entry(stops[0], false, -80), entry(stops[2], true, 500)], steps.io));
    expect(read()).toEqual([true, true, true, false]);
    // scrolling back up, a step that drops below the line goes dark again
    act(() => steps.cb([entry(stops[2], false, 700)], steps.io));
    expect(read()).toEqual([true, true, false, false]);
    expect(done()).toBe(2);
  });

  it('jumps to a shared link to a part of the page once the sections are there', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    const jumped: string[] = [];
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      jumped.push(this.id);
    });
    history.pushState(null, '', '/#faq');
    try {
      render(<Landing />);
      await waitFor(() => expect(jumped).toContain('faq'));
    } finally {
      spy.mockRestore();
      history.pushState(null, '', '/');
    }
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
    // open to holders only: "Do I need the NFT to play?" would be answered yes, so it is not asked
    await waitFor(() => expect(screen.queryByText('Do I need the NFT to play?')).toBeNull());
    expect(screen.getByText('What does the Coinnibal NFT give me?')).toBeTruthy();
  });

  it('a closed page says "not open yet" (never the real page or a 404); the same path opens when the admin opens it', async () => {
    for (const [path, line, plate] of [
      // the mint: nothing about where or when the NFT is minted
      ['/mint', 'The Coinnibal NFT collection is coming. The mint will be on OpenSea. Use only the OpenSea link that @coinnibalfun posts.', 'Coinnibal NFT'],
      // the faucet is hidden: a neutral notice that never names it
      ['/faucet', 'There is nothing here for now. The guide explains how the game works.', 'Coinnibal'],
      ['/collab', 'This is where communities will ask for WL spots. The guide explains how the game works.', 'Collab'],
    ]) {
      resetSiteSettings();
      ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: CLOSED } }));
      history.pushState(null, '', path);
      try {
        const view = render(<SiteApp />);
        expect(await screen.findByRole('heading', { level: 1, name: 'Not open yet.' })).toBeTruthy();
        expect(screen.getByText(line)).toBeTruthy();
        expect(document.querySelector('main .kb-plate')?.textContent).toBe(plate);
        expect(document.querySelector('main')?.textContent).not.toMatch(/faucet|test tokens?|testnet|on this page|mint(ed)? (here|on)|price|\bdate\b/i);
        if (path === '/mint') {
          // the closed mint leads to what the NFT gives (on the landing), the guide second
          const perks = screen.getByRole('link', { name: /See what the NFT gives you/ });
          expect(perks.getAttribute('href')).toBe('/#why-nft');
          expect(perks.className).toContain('kb-btn--primary');
          expect(screen.getByRole('link', { name: /Read the guide/ }).className).toContain('kb-btn--secondary');
        } else {
          expect(screen.getByRole('link', { name: /Back to home/ }).getAttribute('href')).toBe('/');
          expect(screen.getByRole('link', { name: /Read the guide/ }).className).toContain('kb-btn--primary');
        }
        expect(screen.getByRole('link', { name: /Read the guide/ }).getAttribute('href')).toBe('/docs');
        expect(screen.getByRole('link', { name: /Follow @coinnibalfun/ }).getAttribute('href')).toBe('https://x.com/coinnibalfun');
        expect(document.querySelector('.kb-plate__aside')).toBeNull();
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
    localStorage.setItem('coinnibal.auth.v1', JSON.stringify({ address: ADMIN, token: 'admin-token', exp: Date.now() + 3600_000 }));
    localStorage.setItem('coinnibal.site.admin.v1', ADMIN);
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

  const wait = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  const PLATES = ['#feast', '#round', '#arenas', '#nft', '#faq'];

  it('with motion, every plate waits for the scroll and plays once; its bite makes the header coin gulp', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    render(<Landing />);
    for (const id of PLATES) expect(document.querySelector(id)?.getAttribute('data-seam')).toBe('wait');
    // one gesture per seam: a bite at Feast, Arenas and FAQ, the seal at the NFT, the tablecloth (no overlay) at Round
    expect(PLATES.map((id) => (document.querySelector(`${id} > .ld-bite`) ? 'bite' : document.querySelector(`${id} > .ld-seal`) ? 'seal' : '-'))).toEqual(['bite', '-', 'bite', 'seal', 'bite']);
    expect(document.querySelectorAll('.ld-nap')).toHaveLength(1);
    // the content stages wait too, and the long lists are armed card by card
    expect(document.querySelector('.ld-feast__copy')?.getAttribute('data-reveal')).toBe('wait');
    expect([...document.querySelectorAll('.ld-qa')].every((q) => q.getAttribute('data-reveal') === 'wait')).toBe(true);
    expect([...document.querySelectorAll('.ld-nft__why .nf-card')].every((c) => c.getAttribute('data-reveal') === 'wait')).toBe(true);

    const heard = vi.fn();
    window.addEventListener('ld:gulp', heard);
    try {
      const feast = document.querySelector('#feast')!;
      act(() => intersect(feast, 'line', true));
      expect(feast.getAttribute('data-seam')).toBe('in');
      // the others still wait: nothing plays before its own top reaches the line
      expect(document.querySelector('#round')?.getAttribute('data-seam')).toBe('wait');
      await wait(380);
      expect(heard).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.ld-rail__gulp')?.classList.contains('is-gulp')).toBe(true);
      await wait(480);
      expect(document.querySelector('.ld-rail__gulp')?.classList.contains('is-gulp')).toBe(false);
      // played once: leaving and coming back does not replay or hide it
      act(() => intersect(feast, 'line', false));
      expect(feast.getAttribute('data-seam')).toBe('in');
    } finally {
      window.removeEventListener('ld:gulp', heard);
    }
  });

  it('reduced motion: nothing is armed and every seam is a finished still', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    setReducedMotion(true);
    render(<Landing />);
    await wait(30);
    expect(document.querySelector('[data-reveal], [data-seam]')).toBeNull();
    const bites = [...document.querySelectorAll('.ld-bite')];
    expect(bites).toHaveLength(3);
    for (const b of bites) {
      expect(b.getAttribute('aria-hidden')).toBe('true');
      expect(b.querySelector('.ld-bite__face--after .kb-coin')).toBeTruthy();
    }
    expect(document.querySelector('.ld-seal')).toBeTruthy();
    expect(document.querySelector('.ld-nap')).toBeTruthy();
    // the fan is dealt, the header coin never gulps
    expect(document.querySelector('.ld-nft__fan')?.hasAttribute('data-dealt')).toBe(true);
    act(() => void window.dispatchEvent(new Event('ld:gulp')));
    expect(document.querySelector('.ld-rail__gulp')?.classList.contains('is-gulp')).toBe(false);
  });

  it('without an IntersectionObserver the page is finished at once', async () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    render(<Landing />);
    await wait(30);
    const armed = [...document.querySelectorAll('[data-reveal], [data-seam]')];
    expect(armed.length).toBeGreaterThan(20);
    expect(armed.filter((el) => (el.getAttribute('data-reveal') ?? el.getAttribute('data-seam')) !== 'set')).toEqual([]);
    expect(document.querySelector('.ld-nft__fan')?.hasAttribute('data-dealt')).toBe(true);
  });

  it('the fan is dealt from a deck, then hands over to the shuffle', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    render(<Landing />);
    const fan = document.querySelector('.ld-nft__fan')!;
    const slots = () => [...document.querySelectorAll('.ld-fan__card')].map((c) => c.getAttribute('data-slot')).join();
    expect(fan.getAttribute('data-reveal')).toBe('wait');
    expect(fan.hasAttribute('data-dealt')).toBe(false);
    // Shuffle works before the deal has landed
    const before = slots();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Shuffle' })));
    expect(slots()).not.toBe(before);
    act(() => intersect(fan, 'line', true));
    expect(fan.getAttribute('data-reveal')).toBe('in');
    expect(fan.hasAttribute('data-dealt')).toBe(false);
    await wait(1250);
    expect(fan.hasAttribute('data-dealt')).toBe(true);
    // the deal never changes which card sits where
    expect(new Set(slots().split(','))).toEqual(new Set(['left', 'front', 'right']));
  });

  it('keeps the decorations out of the way: hidden from assistive tech, no new text, the copy unchanged', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    render(<Landing />);
    for (const el of document.querySelectorAll('.ld-bite, .ld-seal, .ld-nap')) {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.textContent).toBe('');
    }
    for (const h of ['Meet Coinnibal.', 'Four steps, one round.', 'Five rooms, one fee.', 'Why get the NFT?', 'Good to know.']) expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    expect([...document.querySelectorAll('main .kb-plate__title')].map((t) => t.textContent)).toEqual([
      'Welcome to Coinnibal',
      'What is Coinnibal?',
      'How a round works',
      'Rooms and the fee',
      'The Coinnibal NFT',
      'Questions',
    ]);
  });

  it('floats the questions on a moonlit pond: still details and summaries, every coin and wave hidden from assistive tech', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    render(<Landing />);
    const faq = document.querySelector('#faq')!;
    // the scene (the moon, the water with its boat, bubbles and shore) is decoration: hidden, no text, nothing to focus
    const scene = [...faq.querySelectorAll('.ld-faq__coin, .ld-faq__water')];
    expect(scene).toHaveLength(2);
    for (const el of scene) {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.textContent).toBe('');
      expect(el.querySelector('a, button, input, [tabindex]')).toBeNull();
    }
    const cards = [...faq.querySelectorAll('.ld-qa')];
    expect(cards.length).toBeGreaterThan(5);
    for (const card of cards) {
      expect(card.tagName).toBe('DETAILS');
      const q = card.querySelector(':scope > summary.ld-qa__q')!;
      // one coin per card, hidden: it wonders until its answer opens, then it is happy (the CSS swaps them on [open])
      const face = q.querySelector('.ld-qa__face')!;
      expect(face.getAttribute('aria-hidden')).toBe('true');
      expect(face.querySelectorAll(':scope > .ld-qa__ask .kb-coin, :scope > .ld-qa__yay .kb-coin')).toHaveLength(2);
      // what a screen reader hears on the summary is the question alone
      const heard = [...q.childNodes].filter((n) => !(n instanceof Element && n.getAttribute('aria-hidden') === 'true')).map((n) => n.textContent).join('');
      expect(heard).toBe(q.querySelector('.ld-qa__text')!.textContent);
    }
  });

  it('shows a plain not-found page for a path the site does not know', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    history.pushState(null, '', '/Terrace-Nine');
    try {
      render(<SiteApp />);
      expect(screen.getByRole('heading', { level: 1, name: 'This page does not exist.' })).toBeTruthy();
      expect(screen.getByText('/Terrace-Nine', { selector: 'code' })).toBeTruthy();
      // the top bar is the sun tab alone: no path aside, no "Error 404" kicker over the title
      expect(document.querySelector('main .kb-plate')?.textContent).toBe('Page not found');
      expect(document.querySelector('main')?.textContent).not.toMatch(/Error 404/);
      expect(screen.getByRole('link', { name: /Back to home/ }).getAttribute('href')).toBe('/');
      await waitFor(() => expect(document.title).toBe('Page not found · Coinnibal'));
    } finally {
      history.pushState(null, '', '/');
    }
  });
});
