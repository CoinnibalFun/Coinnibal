import { activeChain, chainInfo, setActiveChain } from '@elymum/shared';
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
    // one paragraph: the ticket, how it is lost, and the share card's line (the fee on profit is told by the rooms)
    const lede = screen.getByTestId('ld-money').textContent ?? '';
    expect(lede).toMatch(/^A paid room takes a ticket in tokens\./);
    expect(lede).toMatch(/whatever you’ve swallowed is yours\.$/);
    expect(screen.getByRole('heading', { level: 3, name: 'We take 20% of your profit' })).toBeTruthy();
    expect(screen.queryByText(/small change with a big appetite|Eat the food/)).toBeNull();
    // no welcome plate, no mono kicker: the wordmark is the first thing in the card
    expect(document.querySelector('.ld-plate1, .ld-hero .kicker, .ld-hero__money')).toBeNull();
    // the game itself: a muted loop of real play with a poster, no controls, nothing to focus
    const video = screen.getByTestId('ld-screen').querySelector('video')!;
    expect(video.muted).toBe(true);
    expect([video.loop, video.autoplay, video.controls]).toEqual([true, true, false]);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.getAttribute('poster')).toBe('/media/hero-loop-poster.webp');
    expect(video.getAttribute('aria-hidden')).toBe('true');
    expect([...video.querySelectorAll('source')].map((x) => [x.getAttribute('src'), x.getAttribute('type')])).toEqual([
      ['/media/hero-loop.webm', 'video/webm'],
      ['/media/hero-loop.mp4', 'video/mp4'],
    ]);
    expect(screen.getByTestId('ld-screen').textContent).toBe('Gameplay');
    // the hero links to the holder perks on the same page
    expect(screen.getByTestId('ld-why-link').getAttribute('href')).toBe('#why-nft');
    // the nav (and every button) follows the settings once they are in: Mint and WL are open here, collab and the game are not
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Join the WL/ }).length).toBeGreaterThan(0));
    expect(document.querySelector('a[href="/collab"]')).toBeNull();
    const wl = screen.getAllByRole('link', { name: /Join the WL/ });
    expect(wl.every((a) => a.getAttribute('href') === '/wl')).toBe(true);
    for (const h of ["You’re a coin in a room full of them", 'How a round plays out', 'Get the Coinnibal NFT', 'Why get the NFT?', 'How big is your appetite?', 'Asked around the pond'])
      expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    // no character cards with prices and jokes, no story lines under the rooms
    expect(document.querySelector('.ld-cast, .ld-suspect')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Asphodel|Lethe|Golden Bough|Isles|Elysi|obol|feast|Homer/i);
    // every holder perk as a row of the comparison: without the NFT, the perk, with the NFT
    const why = screen.getByTestId('why-nft');
    expect([...why.querySelectorAll('tbody tr')].map((c) => c.getAttribute('data-perk'))).toEqual(['fee', 'room', 'shop', 'uses', 'private', 'skin']);
    expect([...why.querySelectorAll('thead th')].map((c) => c.textContent)).toEqual(['youWithout the NFT', 'youWith the NFT']);
    expect(within(why).getByRole('rowheader', { name: 'Fee on your profit' }).closest('tr')?.textContent).toBe('20%Fee on your profit10%8% burned, 2% to the team wallet');
    // no stat cards and no unexplained laurel standing in for a number
    expect(why.querySelector('.nf-card, .nf-card__big')).toBeNull();
    { const m = document.body.textContent?.match(/.{0,60}(testnet|faucet|Short answers).{0,40}/i); expect(m?.[0] ?? null).toBeNull(); }
    // the team asked for NFT questions in the FAQ (what it gives, how many, is each one different)
    expect(screen.getByText('What does the Coinnibal NFT give me?')).toBeTruthy();
    expect(screen.getByText('How many NFTs are there?')).toBeTruthy();
    expect(screen.getByText('Is every NFT different?')).toBeTruthy();
    // the shared skin is one gold look, not the holder's own NFT art
    expect(why.textContent).toContain('The NFT skin and a holder badge');
    expect(why.textContent).not.toMatch(/wears your NFT/);
    // the four rooms, named by price, priced in US dollars (paid in the game token); the $10 one for NFT holders
    for (const [name, fee] of [['$1 Room', '$1'], ['$3 Room', '$3'], ['$5 Room', '$5'], ['$10 Room', '$10']]) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeTruthy();
      expect(within(screen.getByRole('heading', { level: 3, name }).closest('.ld-ticket') as HTMLElement).getByText(fee)).toBeTruthy();
    }
    expect(within(screen.getByRole('heading', { level: 3, name: '$10 Room' }).closest('.ld-ticket') as HTMLElement).getByText('NFT holders only')).toBeTruthy();
    // the closed state's one word, as everywhere on the site
    expect(document.querySelector('#arenas .ld-status')?.textContent).toBe('Soon');
    // the NFT plate links to the mint; the header has the nav and Connect
    expect(screen.getAllByRole('link', { name: 'Go to the mint' })[0].getAttribute('href')).toBe('/mint');
    const nav = screen.getByRole('navigation', { name: 'Site' });
    // the header nav is short and names only what is open: Mint · WL · Docs (the game is admins-only here)
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Mint', 'WL', 'Guide']);
    expect(screen.getByRole('button', { name: /Connect/ })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /@coinnibalfun/ }).some((a) => a.getAttribute('href') === 'https://x.com/coinnibalfun')).toBe(true);
    // no way into the closed game anywhere on the page, and no "live" round
    expect(document.querySelector('a[href="/play"], a[href="/faucet"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Live now/);
    // sound is off until the visitor turns it on
    expect(screen.getByRole('button', { name: /Sound off/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows Collab when collabs are open, and Play when the game is public', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, collabOpen: true, gameAccess: 'public' } } }));
    render(<Landing />);
    await waitFor(() => expect(within(document.querySelector('main')!).getByRole('link', { name: /^Play$/ }).getAttribute('href')).toBe('/play'));
    expect(screen.getByText('Live now')).toBeTruthy();
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
    expect(screen.getByText(/Gas is paid in ETH/)).toBeTruthy();
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
    // "How it works" goes down to the round on this page, not away to the guide
    const how = screen.getByTestId('ld-how-link');
    expect(how.getAttribute('href')).toBe('#round');
    expect(document.getElementById('round')?.contains(screen.getByRole('heading', { level: 2, name: 'How a round plays out' }))).toBe(true);
    expect(how.className).toContain('kb-btn--primary');
    expect(screen.getByTestId('ld-x-link').getAttribute('href')).toBe('https://x.com/coinnibalfun');
    expect(document.querySelector(closedLinks)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Join the WL|Go to the mint|WL → Mint → Play|Live now|WL is open|Play now/);
    expect(document.querySelector('.ld-flow, .ld-flowline, .ld-nft__ctas')).toBeNull();
    // the NFT's perks stay: they are information
    expect(screen.getByTestId('ld-why-link').getAttribute('href')).toBe('#why-nft');
    expect(screen.getByTestId('why-nft').querySelectorAll('tbody tr').length).toBeGreaterThan(3);
    // the NFT's heading gives the count (and claims nothing the cards can't show)
    expect(screen.getByRole('heading', { level: 2, name: '3,333 coin characters' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'The Coinnibal NFT.' })).toBeNull();
    // the header: Docs only, no wallet button; the footer: X and Docs
    expect([...screen.getByRole('navigation', { name: 'Site' }).querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Guide']);
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
    expect([...screen.getByRole('navigation', { name: 'Footer' }).querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://x.com/coinnibalfun', '/docs']);
    // the FAQ does not send anyone to the collab page
    expect(screen.queryByText('Can my community get WL spots?')).toBeNull();
    // each idea once: the round's timing belongs to the round's clock, not the hero (no 05:00 sticker, no "five minutes")
    const hero = document.querySelector('.ld-hero')?.textContent ?? '';
    expect(hero.match(/5-minute|five minutes?|0?5:00/gi)).toBeNull();
    const page = document.querySelector('main')!.textContent ?? '';
    expect(page.match(/Coins eating coins/g)).toHaveLength(1);
    expect(page.match(/Eat or be eaten/g)).toHaveLength(1);
    expect(document.querySelector('.st-foot')!.textContent).not.toMatch(/Coins eating coins|Eat or be eaten|Five minutes/);
    // no sentence-case "the ticket price becomes the value" said over and over: once, by the hero
    expect(page.match(/become (its|your coin’s) value/g)).toBeNull();
    // the fee's numbers: once for everyone (the rooms), once for holders (the NFT's first perk)
    expect(page.match(/15% burned/g)).toHaveLength(1);
    expect(page.match(/8% burned, 2% to the team wallet/g)).toHaveLength(1);
    // information only: no price of the mint, no date, no promise
    expect(screen.queryByText('How much is the NFT?')).toBeNull();
    // ("Soon" is only ever the closed state's label: the rooms' chip)
    const said = document.body.cloneNode(true) as HTMLElement;
    for (const chip of said.querySelectorAll('.ld-status, .st-soonset__tag, .st-soon')) chip.remove();
    expect(said.textContent).not.toMatch(/\bsoon\b|start date|post the date|at launch|mint it with|mint page shows/i);
  });

  it('everything closed: each fact once, the FAQ agrees with the guide, the hero money line is the same on every chain', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: CLOSED } }));
    const before = activeChain();
    try {
      // every build says the same: a paid room takes a ticket (no free-at-first phase, no test network)
      setActiveChain(chainInfo(4663));
      render(<Landing />);
      await settle();
      expect(screen.getByTestId('ld-money').textContent).toBe(
        'A paid room takes a ticket in tokens. Your coin carries it into the round, so getting eaten means losing it. Eat the coins smaller than you, and when the bell rings, whatever you’ve swallowed is yours.',
      );
    } finally {
      setActiveChain(before);
    }
    const faq = [...document.querySelectorAll('.ld-qa')];
    // the most asked first: is it open, what it costs, the NFT; then the wallet and the chain; the guide last
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
    // the guide's rule (the NFT isn't a ticket), told so it can't read as "the NFT is worthless"; the $10 Room is told by
    // its ticket and the comparison
    expect(answer('Do I need the NFT to play?')).toBe('No. The NFT only adds perks, and it’s never spent or put at risk in a round.');
    // the team asked for the NFT's questions: what it gives (D11), how many, every one different. Their answers add what
    // the comparison above does not say: how long the perks last and what one NFT covers, where the mint is, and that
    // rarity changes no perk
    expect(answer('What does the Coinnibal NFT give me?')).toBe('The perks above, while it’s in your wallet. One NFT covers one open ticket at a time, and its free room and power-up discount go to one wallet a day.');
    expect(faq.find((f) => f.querySelector('.ld-qa__text')?.textContent === 'What does the Coinnibal NFT give me?')!.querySelector('a')?.getAttribute('href')).toBe('#why-nft');
    expect(answer('How many NFTs are there?')).toBe('3,333 in all. The mint will be on OpenSea, and the only link to trust is the one @coinnibalfun posts.');
    expect(answer('Is every NFT different?')).toBe('Yes, every one is a coin character of its own. Some are rarer than others, but rarity never changes the perks.');
    // and in its own words: the NFT section above doesn't say it too
    expect(document.querySelector('#nft .ld-nft__text')?.textContent).not.toMatch(/rarer|its own coin character/);
    // the chain holds the money, the game runs on a server (as the guide says)
    expect(answer('What is Robinhood Chain?')).toMatch(/the game itself will run on our server/);
    // the cost, once: paid rooms take a ticket (the hero said how), practice rooms are free
    expect(answer('Does it cost money to play?')).toBe('In a paid room, yes. The ticket is what your coin plays with. Practice rooms are free.');
    // the owner's launch order: the NFT mint, then the token, then the game (no dates)
    expect(answer('Is the game open?')).toBe('Not yet. The NFT mint comes first, then the token, then the game. Follow @coinnibalfun for news.');
    const page = document.querySelector('main')!.textContent ?? '';
    expect(page.match(/Practice (stays|is|rooms are) free/g)).toHaveLength(1);
    expect(page.match(/explains every rule/g)).toBeNull();
    // the round's timing, once, on its clock (practice and private rooms run no 5-minute bell: the clock is the paid rooms')
    expect([...document.querySelectorAll('.ld-clock__phase')].map((p) => p.textContent)).toEqual(['0:00–4:00Play, joins open', '4:00–5:00Play, joins closed', '5:00–5:30The bell, then a break']);
    expect(page).toContain('Every paid room runs on this clock, round after round.');
    expect(document.querySelector('.ld-stops')?.textContent).not.toMatch(/\d+ (minutes|seconds)/);
    // the pond's snack pays tokens, never dollars
    expect(document.querySelector('.ld-chase__pop')?.textContent).toBe('+1,000');
    // the perks are a part of the NFT section: their heading ranks under it
    expect(screen.getByRole('heading', { level: 3, name: 'Why get the NFT?' })).toBeTruthy();
    // no kicker repeats a plate or a heading
    expect(document.querySelectorAll('.ld-feast__copy > .kicker, .ld-round__copy > .kicker, .ld-arenas__head .kicker, .ld-nft__copy > .kicker')).toHaveLength(0);
    // the stairs stand level (only their tickets tilt, in CSS)
    expect([...document.querySelectorAll<HTMLElement>('.ld-stair')].map((s) => s.style.getPropertyValue('--tilt'))).toEqual(['', '', '', '']);
  });

  it('lights each step of the round as the visitor reads down to it', async () => {
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
    const read = () => stops.map((s) => s.classList.contains('is-read'));
    expect(read()).toEqual([false, false, false, false]);
    const steps = made.find((o) => o.opts?.rootMargin === '0px 0px -40% 0px')!;
    const entry = (target: Element, isIntersecting: boolean, top: number) => ({ target, isIntersecting, boundingClientRect: { top } }) as unknown as IntersectionObserverEntry;
    act(() => steps.cb([entry(stops[0], true, 300), entry(stops[1], true, 420)], steps.io));
    expect(read()).toEqual([true, true, false, false]);
    // a step scrolled above the viewport stays read; the next one crosses the line
    act(() => steps.cb([entry(stops[0], false, -80), entry(stops[2], true, 500)], steps.io));
    expect(read()).toEqual([true, true, true, false]);
    // scrolling back up, a step that drops below the line goes dark again
    act(() => steps.cb([entry(stops[2], false, 700)], steps.io));
    expect(read()).toEqual([true, true, false, false]);
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
    expect(screen.getByTestId('ld-how-link').getAttribute('href')).toBe('#round');
  });

  it('each part comes back when the admin reopens it', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...CLOSED, mintOpen: true } } }));
    const first = render(<Landing />);
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Go to the mint' })[0].getAttribute('href')).toBe('/mint'));
    expect(document.querySelector('a[href="/play"], a[href="/faucet"], a[href="/wl"], a[href="/collab"]')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Get the Coinnibal NFT' })).toBeTruthy();
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
    for (const [path, line, title] of [
      // the mint: nothing about when the NFT is minted, only where (and which link to trust, in a callout of its own)
      ['/mint', 'The press is still chained shut. When it opens, the mint will be on OpenSea.', "The mint isn’t open yet"],
      // the faucet is hidden: a neutral notice that never names it
      ['/faucet', 'There’s nothing here for now. The guide explains how the game works.', 'Not open yet'],
      ['/collab', 'Run a community? This is where you’ll ask for WL spots. @coinnibalfun will say when it opens.', "Collabs aren’t open yet"],
    ]) {
      resetSiteSettings();
      ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: CLOSED } }));
      history.pushState(null, '', path);
      try {
        const view = render(<SiteApp />);
        expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
        expect(screen.getByText(line)).toBeTruthy();
        if (path === '/mint') {
          // its own scene (the locked press and its queue, not the sleepy coin's card) and the OpenSea rule as a callout
          expect(document.querySelector('main .mc-art')).toBeTruthy();
          expect(document.querySelector('main .cl__card')).toBeNull();
          expect(screen.getByRole('complementary', { name: 'One link to trust.' }).textContent).toContain(
            'Use only the OpenSea link that @coinnibalfun posts. A mint link in your DMs or in the replies isn’t ours.',
          );
          expect(document.querySelector('main')?.textContent).not.toMatch(/opensea\.io|royalt|per wallet|TBA/i);
        }
        // the one stamp of every closed part of the site: "Soon", the header chip's word
        expect(document.querySelector('main .cl-soon')?.textContent).toBe('Soon');
        // one label: the heading (no title strip over the notice)
        expect(document.querySelector('main .kb-plate')).toBeNull();
        expect(document.querySelector('main')?.textContent).not.toMatch(/faucet|test tokens?|testnet|on this page|mint(ed)? (here|on)|price|\bdate\b/i);
        expect(screen.getByRole('link', { name: /Back to home/ }).getAttribute('href')).toBe('/');
        expect(screen.getByRole('link', { name: /Read the guide/ }).getAttribute('href')).toBe('/docs');
        expect(screen.getByRole('link', { name: /Follow @coinnibalfun/ }).getAttribute('href')).toBe('https://x.com/coinnibalfun');
        expect(document.querySelector(closedLinks)).toBeNull();
        expect(screen.queryByText('Somebody ate this page')).toBeNull();
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

  const wait = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  const PLATES = ['#feast', '#round', '#arenas', '#nft', '#faq'];

  it('with motion, every plate waits for the scroll and plays once; its bite makes the header coin gulp', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: SETTINGS } }));
    render(<Landing />);
    for (const id of PLATES) expect(document.querySelector(id)?.getAttribute('data-seam')).toBe('wait');
    // one gesture per seam, the bite twice only: at Feast and FAQ, the seal at the NFT, the tablecloth (no overlay) at
    // Round, the dusk before the rooms
    expect(PLATES.map((id) => (document.querySelector(`${id} > .ld-bite`) ? 'bite' : document.querySelector(`${id} > .ld-seal`) ? 'seal' : '-'))).toEqual(['bite', '-', '-', 'seal', 'bite']);
    expect(document.querySelectorAll('.ld-nap')).toHaveLength(1);
    // the content stages wait too, and the long lists are armed card by card
    expect(document.querySelector('.ld-feast__copy')?.getAttribute('data-reveal')).toBe('wait');
    expect([...document.querySelectorAll('.ld-qa')].every((q) => q.getAttribute('data-reveal') === 'wait')).toBe(true);
    expect([...document.querySelectorAll('.ld-nft__why .nf-row')].every((c) => c.getAttribute('data-reveal') === 'wait')).toBe(true);

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
    expect(bites).toHaveLength(2);
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
    for (const h of ["You’re a coin in a room full of them", 'How a round plays out', 'How big is your appetite?', 'Why get the NFT?', 'Asked around the pond']) expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    // one label per section: the H2. No caption bar over it, no mono aside; the section's top line is a bare ink rule
    expect(document.querySelectorAll('main .kb-plate')).toHaveLength(0);
    const plates = [...document.querySelectorAll('main .ld-plate')];
    expect(plates.map((p) => p.id)).toEqual(['feast', 'round', 'arenas', 'nft', 'faq']);
    for (const p of plates) {
      expect(p.querySelector(':scope > .ld-rule')?.getAttribute('aria-hidden')).toBe('true');
      expect(p.querySelectorAll('h2')).toHaveLength(1);
    }
    // no headline ends on a full stop
    expect([...document.querySelectorAll('main h2, main h3')].map((h) => h.textContent ?? '').filter((h) => /\.$/.test(h))).toEqual([]);
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
      // no coin on a question: the characters act in the scene, not as list bullets
      expect(q.querySelector('.kb-coin')).toBeNull();
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
      expect(screen.getByRole('heading', { level: 1, name: 'Somebody ate this page' })).toBeTruthy();
      expect(screen.getByText('/Terrace-Nine', { selector: 'code' })).toBeTruthy();
      // one label: the heading (the 404 is on the sign in the picture; no title strip, no "Error 404" eyebrow)
      expect(document.querySelector('main .kb-plate, main .kicker')).toBeNull();
      expect(screen.getByRole('link', { name: /Back to home/ }).getAttribute('href')).toBe('/');
      await waitFor(() => expect(document.title).toBe('Page not found · Coinnibal'));
    } finally {
      history.pushState(null, '', '/');
    }
  });
});
