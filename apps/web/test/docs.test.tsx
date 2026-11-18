import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPACITY, DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, DEFAULT_PAYMENT_BURN_BPS, INTEGRITY_SETTINGS_DEFAULT, MAX_TOTAL_FEE_BPS, RULES, profitFee } from '@elymum/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chainStatus } from './evm-helpers';
import { Kb } from '../src/design';
import { pageFromUrl, urlForPage, useUi } from '../src/store';
import { DocsPage } from '../src/ui/docs/DocsPage';
import { docsEn } from '../src/ui/docs/content.en';
import { FACTS, SERVER, payoutExample } from '../src/ui/docs/facts';

const initial = useUi.getState();
const en0 = docsEn();
afterEach(() => {
  act(() => useUi.setState(initial, true));
});

/** The section order the guide promises. */
const SECTION_IDS = ['play', 'rooms', 'value', 'payout', 'powerups', 'nft', 'token', 'fair', 'wallet', 'profile', 'help'];

describe('player guide facts', () => {
  it('works the payout example through the shared fee module: entry 1,000, till 1,900, profit 900 → 135 burned, 45 to the fee wallet, 1,720 paid', () => {
    expect(FACTS.example).toEqual({ entry: 1000, cashout: 1900 });
    expect(payoutExample()).toEqual({ entry: 1000, payout: 1900, profit: 900, burned: 135, toVault: 45, fee: 180, net: 1720 });
    // the server's own rates when they differ (each share rounds down)
    expect(payoutExample({ burnBps: 1000, vaultBps: 0 })).toMatchObject({ burned: 90, toVault: 0, net: 1810 });
    expect(payoutExample({ burnBps: 333, vaultBps: 333 })).toMatchObject({ burned: 29, toVault: 29, net: 1842 });
    expect(FACTS.shop.prices).toEqual({ magnet: 600, leap: 900, speed: 600, invis: 1200 });
  });

  it('quotes the contract defaults', () => {
    expect(FACTS.fee).toEqual({ burnBps: 1500, vaultBps: 500, maxBps: 2500, paymentBurnBps: 5000 });
    expect(FACTS.refundHours).toBe(24);
    expect(FACTS.rules).toMatchObject({ roundMin: 5, joinCloseS: 60, breakS: 30, afkS: 45, lootMin: 3, lootMax: 24, lootEntryDiv: 4 });
    expect(FACTS.approve).toEqual({ choices: [1, 5, 10, 20], preselected: 5 });
    expect(FACTS.arenas.map((a) => [a.usdCents, a.holdersOnly])).toEqual([
      [100, false],
      [300, false],
      [500, false],
      [1000, true],
    ]);
    expect(FACTS.rules.roundMin).toBe(RULES.roundMs / 60_000);
    // the full 5 minutes of play, the 30-second break on top of it (a round every 5 minutes 30 seconds), in words, not a clock
    const play = JSON.stringify(en0);
    expect(play).toContain('A round is 5 minutes of play, then a 30-second break, so a new round starts every 5 minutes 30 seconds.');
    expect(play).not.toMatch(/\b5:00\b/);
    // durations in words, the number and its unit kept on one line (a no-break space), never "60 s"
    expect(play).toContain('close 60\u00a0seconds before the bell');
    // the split rules as a table of numbers: the figure, then what it means
    const split = en0.sections[0].blocks.find((x) => x.kind === 'table' && x.caption === 'Splitting and shields');
    expect(split?.kind === 'table' && split.rows.map((r) => [r[0], r[1]])).toEqual([
      ['Split', '35 mass'],
      ['Pieces', 'up to 16'],
      ['Merge', 'from 12\u00a0seconds'],
      ['Spawn shield', '5.5\u00a0seconds'],
    ]);
    expect(play).toContain('A new coin can’t eat or be eaten by other coins.');
    expect(play).not.toMatch(/\d s\b|\d\u00a0s\b/);
    // "a 5 minutes round" is not English: a duration before a noun is "5-minute"
    expect(play).not.toMatch(/\d (minutes|seconds) (rounds?|break|bell)\b/);
    expect(FACTS.capacity).toEqual({ practice: CAPACITY.practice, private: CAPACITY.private, arena: 50 });
    // the USD tiers ($1 / $3 / $5 / $10) at the reference token price
    expect(FACTS.arenas.map((a) => [a.id, a.entry])).toEqual([
      [1, 1000],
      [2, 3000],
      [3, 5000],
      [4, 10000],
    ]);
  });

  it('mirrors the server-only timings from the server source', () => {
    // vitest runs in apps/web (pnpm -r / -F run each package in its own directory)
    const src = (rel: string) => readFileSync(resolve(process.cwd(), '../server/src', rel), 'utf8');
    const manager = src('rooms/manager.ts');
    const room = src('rooms/room.ts');
    const gateway = src('chain/evm.ts');
    expect(manager).toMatch(new RegExp(`export const PRO_LEVEL = ${SERVER.proLevel};`));
    expect(manager).toMatch(new RegExp(`export const PROMOTE_MAX_MASS = ${SERVER.promoteMaxMass};`));
    expect(manager).toMatch(new RegExp(`export const PROMOTE_KILLS = ${SERVER.promoteKills};`));
    expect(manager).toMatch(new RegExp(`export const PROMOTION_MS = ${SERVER.promotionHours} \\* 3600_000;`));
    expect(manager).toMatch(new RegExp(`length: ${SERVER.privateCodeLength} }`));
    expect(room).toMatch(new RegExp(`export const MAX_STAKE_SESSION_AGE_S = ${SERVER.maxTicketHours} \\* 3600;`));
    expect(gateway).toMatch(new RegExp(`export const STALE_SESSION_AFTER_S = ${SERVER.staleTicketMinutes} \\* 60;`));
  });
});

describe('player guide content', () => {
  const en = docsEn('$ELYMUM');

  it('explains the fee on profit with the worked example, at the live rates', () => {
    const text = (c: typeof en) => JSON.stringify(c.sections);
    expect(en.rates).toEqual({ burnBps: 1500, vaultBps: 500 });
    expect(text(en)).toContain('The game takes one fee, 20% of your profit. Profit is your value at the bell minus the ticket price. 15% of the profit is burned and 5% goes to the team wallet. No profit, no fee.');
    // the network fees in ETH are not a game fee: the one-fee line says so instead of contradicting them
    expect(text(en)).toContain('The network fees in ETH go to the network, not to Coinnibal.');
    expect(text(en)).not.toMatch(/The only fee|buying a ticket has no fee/);
    // the receipt's caption reads right with any token name from the server ("a ticket of 1,000 tokens")
    expect(docsEn().receipt.caption).toBe('A ticket of 1,000 tokens, worth 1,900 tokens at the bell');
    expect(text(en)).not.toMatch(/entry fee|the cut|arena vault for the team|played by the team|fee wallet|\btill\b/);
    const live = docsEn('$ELYMUM', { burnBps: 1000, vaultBps: 200 });
    expect(live.rates).toEqual({ burnBps: 1000, vaultBps: 200 });
    expect(text(live)).toContain('The game takes one fee, 12% of your profit.');
    expect(text(live)).toContain('10% of the profit is burned and 2% goes to the team wallet');
    // the worked numbers stand once, on the receipt (the page test reads them there)
    expect(payoutExample(live.rates)).toMatchObject({ burned: 90, toVault: 18, net: 1792 });
  });

  it('says where bots play, in one place, and leaves the testnet test rooms out', () => {
    const all = JSON.stringify(en);
    expect(all).toContain('Bots play only in free private rooms.');
    expect(all).toContain('Bots are labelled BOT.');
    // one block speaks of bots, nothing else does
    const items = en.sections.flatMap((s) => s.blocks).flatMap((b): unknown[] => (b.kind === 'list' ? [...b.items] : [b]));
    const about = items.filter((it) => /\bbots?\b/i.test(JSON.stringify(it)));
    expect(about).toHaveLength(1);
    expect(all.replace(JSON.stringify(about[0]), '')).not.toMatch(/\bbots?\b/i);
    expect(all).not.toMatch(/test arena|test room|\bTEST\b|Test ·/);
  });

  it('never talks about the test network, and reads the same on every network', () => {
    const notes = (c: typeof en) => c.sections.flatMap((s) => s.blocks).filter((b) => b.kind === 'note');
    const test = docsEn('$NIBAL', undefined, 'Robinhood Chain Testnet', { testnet: true });
    // one notice, the risk, named for when it matters (no bare "Know the risk" label, no stamp on top of a title)
    expect(notes(test).map((n) => n.kind === 'note' && n.title)).toEqual(['Before you buy a ticket']);
    const text = JSON.stringify(test);
    expect(text).not.toMatch(/[Ff]aucet|test tokens|testnet|mainnet/i);
    expect(text.match(/haven’t been audited/g)).toHaveLength(1);
    const main = docsEn('$NIBAL', undefined, 'Robinhood Chain', { testnet: false });
    expect(notes(main).map((n) => n.kind === 'note' && n.title)).toEqual(['Before you buy a ticket']);
    expect(JSON.stringify(main)).not.toMatch(/[Ff]aucet|test tokens|testnet/i);
    expect(JSON.stringify(main).match(/haven’t been audited/g)).toHaveLength(1);
  });

  it('says each rule once: the fee split, the round clock, the holder fee, the refunds', () => {
    const t = JSON.stringify(en.sections);
    const once = (re: RegExp) => expect(t.match(new RegExp(re.source, `${re.flags}g`)) ?? [], String(re)).toHaveLength(1);
    once(/15% of the profit is burned/);
    once(/A round is 5 minutes of play/);
    once(/share one clock/);
    once(/goes into the room’s vault/);
    once(/unlimited amount/);
    once(/you lose it if your coin gets eaten/);
    expect(t).not.toMatch(/know the risk/i);
    // said twice before: in the same item, or again a few lines on
    expect(t).not.toMatch(/never play in paid rooms|never unlimited|Payout is at the bell only|The whole price goes into/);
    once(/8% burned/);
    once(/20% off/);
    once(/Collect payout/);
    once(/after about 15 minutes/);
    once(/24 hours after buying/);
    once(/no cash-out/i);
    once(/50% is burned/);
    once(/1, 5, 10 or 20 tickets/);
    // no questions-and-answers block restating the sections
    expect(en.sections.flatMap((s) => s.blocks).some((b) => b.kind === 'faq')).toBe(false);
  });

  it('uses one word per thing and does not tell the reader to play or mint now', () => {
    const t = JSON.stringify(en);
    expect(t).not.toMatch(/\barenas?\b|emblem|\btill\b|entry fee|fee wallet|stake/i);
    expect(t).not.toMatch(/play now|mint now|press Quick Play|coming soon|will be announced|roadmap/i);
    expect(t).toContain('COIN-7K2M9Q');
    expect(t).not.toContain('NIBAL');
    expect(t).toContain('$1 Room');
    expect(t).toContain('$10 Room');
  });

  it('names no mint price and no date: what the NFT does, never what it costs or when anything opens', () => {
    const t = JSON.stringify(en);
    // the mint: no price, no "the Mint page shows the price", no order of a sale
    expect(t).not.toMatch(/mint(ing)? (price|cost|fee)|price of the (nft|mint)|Mint page|minted on|allowlist|\bWL\b/i);
    const nft = JSON.stringify(en.sections.find((s) => s.id === 'nft'));
    expect(nft).not.toMatch(/\bprice from\b|\bcosts?\b|\d(\.\d+)? ?ETH\b/i);
    // no dates, launch timing or schedule words (the rules' own durations stay: 5:00, 30 s, 15 minutes, 24 hours)
    expect(t).not.toMatch(/\bsoon\b|at launch|launch(es|ing)?\b|\bopens (on|in|at|after|when)\b|\b(up)?coming\b|\bnot open yet\b|\bschedule|timeline|\b20\d\d\b|\bQ[1-4]\b/i);
    expect(t).not.toMatch(/january|february|march|april|\bmay \d|june|july|august|september|october|november|december|next (week|month|year)|start date/i);
  });

  it('covers the NFT and the token: what each is for, with the shop prices and holder perks from the code', () => {
    const nft = JSON.stringify(en.sections.find((s) => s.id === 'nft'));
    const table = en.sections.find((s) => s.id === 'nft')!.blocks.find((b) => b.kind === 'table');
    expect(table?.kind === 'table' && table.rows).toEqual([
      ['Fee on profit', '20%', '10% (8% burned, 2% team wallet)'],
      ['$10 Room', 'Closed', 'Open'],
      ['Power-up packs', 'Full price', '20% off'],
      ['Power-ups per round in a paid room', '2', '3'],
      ['Private room', 'Paid in ETH', '1 free a day, up to 10 players'],
      ['Coin look', 'Standard skins', 'Also the NFT skin and a holder badge'],
    ]);
    // the operator's access switch is not a game rule: the guide says nothing of a holders-only game (the landing FAQ
    // answers "Do I need the NFT to play? No.")
    expect(nft).not.toMatch(/holders only|Holders-only|needs the NFT to play/i);
    expect(nft).toContain('The collection has 3,333 NFTs.');
    expect(nft).not.toMatch(/ERC-721/);
    const pu = JSON.stringify(en.sections.find((s) => s.id === 'powerups'));
    // no power-up prices in the guide (the shop shows them)
    // the four power-ups in one table led by their keys, with the shared boost timings (how long, then the cooldown)
    const pus = en.sections.find((s) => s.id === 'powerups')!.blocks.find((b) => b.kind === 'table');
    expect(pus?.kind === 'table' && pus.keys).toBe(0);
    expect(pus?.kind === 'table' && pus.rows.map((r) => [r[0], r[1], r[3], r[4]])).toEqual([
      ['R', 'Magnet', '8\u00a0seconds', '20\u00a0seconds'],
      ['F', 'Leap', 'Instant', '12\u00a0seconds'],
      ['G', 'Speed burst', '3\u00a0seconds', '18\u00a0seconds'],
      ['V', 'Invisibility', '10\u00a0seconds', '30\u00a0seconds'],
    ]);
    expect(pu).toContain('Pulls nearby food to your coin.');
    expect(pu).not.toMatch(/\$\d/);
    expect(pu).toContain('Each pack holds 3 uses');
    expect(pu).toContain('50% is burned and 50% goes to the team wallet');
    expect(pu).toContain('you can use 2 power-ups per round (per game in a ticket room)');
    // the shop's power-ups are not the airdrops of section 01 (both have a Magnet, with different times)
    expect(pu).toContain('They aren’t the free airdrops on the map (see [How to play](#play))');
    // the shop is in the lobby only (GameHud's top bar sells nothing)
    expect(pu).toContain('nothing is sold during a game');
    const token = JSON.stringify(en.sections.find((s) => s.id === 'token'));
    expect(token).toContain('the game never creates new $ELYMUM');
    expect(token).toContain('The game token is set in the contract once and can never be changed.');
    // what the token pays for, and what ETH pays for, in one table
    const paid = en.sections.find((s) => s.id === 'token')!.blocks.find((b) => b.kind === 'table');
    expect(paid?.kind === 'table' && paid.rows.map((r) => r[1])).toEqual(['$ELYMUM', '$ELYMUM', 'ETH', 'ETH', 'ETH']);
    expect(token).not.toMatch(/Until it is set|token address/);
    // floor loot exists only where something without a ticket eats a coin (the testnet's test rooms): not in the guide
    expect(JSON.stringify(en)).not.toMatch(/loot/i);
  });

  it('keeps to playing, the NFT, the token and the money: no internal mechanics', () => {
    const t = JSON.stringify(en);
    expect(t).not.toMatch(/\bPass\b|season|prize pool|reveal/i);
  });

  it('describes timed rounds and promises no cash-out in arenas', () => {
    const all = JSON.stringify(en.sections);
    expect(all).toContain('A round is 5 minutes of play,');
    expect(all).toContain('you can’t leave a round early with your value');
    expect(all).not.toMatch(/cash out in|Press C|cash-out button|cashes out in|anytime/i);
    expect(JSON.stringify(en.sections)).not.toContain('"key":"C"');
  });

  it('describes collecting a settled payout, not a 24 h refund of the entry fee only', () => {
    const t = JSON.stringify(en.sections);
    expect(t).not.toMatch(/never includes winnings|create the token account rather|returns your entry fee only/);
    expect(t).toContain('Collect payout');
  });

  it('has every section in the promised order, each with a title and content', () => {
    expect(en.sections.map((s) => s.id)).toEqual(SECTION_IDS);
    for (const s of en.sections) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.blocks.length).toBeGreaterThan(0);
    }
  });

  it('uses no emoji and no Turkish, and names the network (the active chain and its gas token)', () => {
    const text = JSON.stringify(en);
    expect(text).not.toMatch(/\brent\b|token account/);
    expect(text).toContain('ETH on Robinhood Chain for network fees');
    expect(text).not.toMatch(/Testnet/);
    expect(JSON.stringify(docsEn('$ELYMUM', undefined, 'Robinhood Chain'))).toContain('ETH on Robinhood Chain for network fees');
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/record_game/);
    // the CI guard's Turkish letters, written as escapes so this file passes the guard itself
    expect(text).not.toMatch(/[\u00e7\u011f\u0131\u00f6\u015f\u00fc\u00c7\u011e\u0130\u00d6\u015e\u00dc]/);
  });

  it('ends with the official links, the OpenSea-only rule and the seed-phrase line (said there, not again in a chapter)', () => {
    const c = docsEn('tokens', undefined, 'Robinhood Chain', { site: 'coinnibal.fun', x: 'coinnibalfun' });
    expect(c.closing.lines).toEqual([
      'The only official links are coinnibal.fun and @coinnibalfun on X. The NFT mint will be on OpenSea, through the one link @coinnibalfun posts.',
      'Nobody from Coinnibal will ever ask for your seed phrase.',
    ]);
    expect(c.closing).toMatchObject({ follow: '@coinnibalfun', href: 'https://x.com/coinnibalfun' });
    const wallet = JSON.stringify(c.sections.find((s) => s.id === 'wallet'));
    expect(wallet).not.toMatch(/Official links|OpenSea|only mint|the game and the/);
    // one name for the phrase across the site (the footer says "seed phrase")
    expect(wallet).toContain('seed phrase');
    expect(JSON.stringify(en)).not.toMatch(/recovery phrase|To no one/i);
    // the X handle follows the site settings; the shared default without them
    expect(docsEn('tokens', undefined, undefined, { x: '@other' }).closing.lines[0]).toContain('@other on X.');
    expect(docsEn().closing.lines[0]).toContain('@coinnibalfun on X.');
  });

  it('gives every chapter a line under its title, and cuts the claim-colon-payoff habit', () => {
    for (const s of en.sections) expect(s.lede, s.id).toBeTruthy();
    expect(en.sections.find((s) => s.id === 'token')!.lede).toBe('The paid rooms and the shop run on it, and part of what they take is burned.');
    // a colon stays before a list, never as the hinge of a sentence
    const prose = en.sections.flatMap((s) => [s.lede ?? '', ...s.blocks.map((b) => (b.kind === 'p' ? b.text : ''))]).join(' ');
    expect(prose).not.toMatch(/The catch:|That’s all:|are free:|costs a little ETH:|one fee:|no cash-out:/);
    // typographic apostrophes in what the reader sees
    expect(JSON.stringify(en.sections)).not.toMatch(/[A-Za-z]'[A-Za-z]/);
  });

  it('matches the code on shields, holds, ticket rooms and private-room prices', () => {
    const t = JSON.stringify(en.sections);
    // a shield (airdrop or spawn) blocks eating both ways (world.ts eatDynamic)
    const airdrops = en.sections[0].blocks.find((b) => b.kind === 'table' && b.caption.startsWith('Airdrops'));
    expect(airdrops?.kind === 'table' && airdrops.rows.find((r) => r[0] === 'HODL Shield')).toEqual(['HODL Shield', '8\u00a0seconds', 'Other coins can’t eat you, but you can’t eat them either.']);
    // an auto-held winning payout (integrity/service.ts holdDecision) and its release after the default hours
    expect(t).toContain(`With no decision within ${INTEGRITY_SETTINGS_DEFAULT.autoReleaseHours} hours, it’s paid as usual.`);
    // a ticket room keeps one round number from its start to its end, so the power-up limit is per game there
    expect(t).toContain('(per game in a ticket room)');
    // only coins still alive at a ticket room's end are paid (an eaten coin's value already moved)
    expect(t).toContain('Coins still alive at the room’s end are paid, with the normal fee on profit.');
    expect(t).not.toMatch(/All tickets are paid/);
    // the admin re-prices private rooms as ETH moves: no fixed price in the guide
    expect(t).not.toMatch(/\d\.\d+ ETH|of that for every/);
    expect(t).toContain('Opening one costs a little ETH. Bigger rooms cost more, and the price shows before you pay.');
    // "open all day" read as "open now" while the game is closed
    expect(t).not.toMatch(/open all day/);
  });

  it('links a section to another one instead of naming it, and every link has a target', () => {
    const t = JSON.stringify(en.sections);
    const links = [...t.matchAll(/\[([^[\]]+)\]\(#([a-z]+)\)/g)];
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const [, label, id] of links) {
      const target = en.sections.find((s) => s.id === id);
      expect(target, id).toBeTruthy();
      expect(label).toBe(target!.title);
    }
    // no "(see X)" left as plain text
    expect(t).not.toMatch(/see (Power-ups|Rounds, payout and fee|How to play)\b/);
  });

  it('formats numbers in en-US', () => {
    expect(en.pct(500)).toBe('5%');
    expect(en.pct(450)).toBe('4.5%');
    expect(en.num(1950)).toBe('1,950');
    expect(en.num(250000)).toBe('250,000');
  });
});

describe('player guide page', () => {
  it('renders every section and the worked payout example', () => {
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    const toc = screen.getByRole('navigation', { name: en0.tocLabel });
    // every entry is a link to its section's address, so a section can be shared and bookmarked
    const entries = within(toc).getAllByRole('link');
    expect(entries.map((a) => a.getAttribute('href'))).toEqual(SECTION_IDS.map((id) => `/docs#docs-${id}`));
    // the first chapter is marked as the one being read
    expect(entries[0].getAttribute('aria-current')).toBe('location');
    expect(entries.filter((a) => a.hasAttribute('aria-current'))).toHaveLength(1);
    // the phones' fold button
    expect(within(toc).getByRole('button', { name: /Contents/ }).getAttribute('aria-expanded')).toBe('false');
    // no dateline strip under the head (it said four rules again that the chapters say)
    expect(document.querySelector('.dc-dateline, .kb-dateline')).toBeNull();
    for (const s of en0.sections) expect(screen.getByRole('heading', { level: 3, name: s.title })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Rounds, payout and fee' })).toBeTruthy();
    // the receipt at the contract default rates (15 % + 5 % of profit): 1,900 at the bell, 900 profit
    expect(screen.getByText('−135')).toBeTruthy();
    expect(screen.getByText('−45')).toBeTruthy();
    expect(screen.getByText('1,720')).toBeTruthy();
    // comics only where a picture says it better (the basic rule, wallet safety); the value flow keeps its diagram
    const strips = document.querySelectorAll('figure.cs');
    expect([...strips].map((f) => f.getAttribute('data-strip'))).toEqual(['play', 'wallet']);
    for (const f of strips) expect(f.querySelectorAll('.cs__cap')).toHaveLength(3);
    expect(document.querySelector('figure.vf svg[aria-hidden="true"]')).toBeTruthy();
    // one label per chapter: its title (no eyebrow over a strip, no stamp over a note, no cards of steps)
    expect(document.querySelectorAll('.cs__label, .dc-note__stamp, .dc-flow, .dc-cards')).toHaveLength(0);
    // the power-ups' keys are caps in their table; every cap looks the same (none pressed while nothing points at it)
    expect([...document.querySelectorAll('.dc-table--keys .dc-kbd')].map((k) => k.textContent)).toEqual(['R', 'F', 'G', 'V']);
  }, 20_000);

  it("follows the server's fee rates (ChainStatus.fees)", () => {
    act(() =>
      useUi.setState({
        chain: chainStatus({ token: null, fees: { ...chainStatus().fees!, burnBps: 1000, vaultBps: 0 } }),
      }),
    );
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    // 10 % burned, nothing to the fee wallet: 90 of the 900 profit burned, 1,810 paid
    expect(screen.getByText('1,810')).toBeTruthy();
    expect(screen.getByText('−90')).toBeTruthy();
    expect(screen.getByText('−0')).toBeTruthy();
    expect(screen.queryByText(/Entry fee rate/)).toBeNull();
  }, 20_000);
});

describe('player guide addresses', () => {
  const path0 = location.pathname + location.search + location.hash;
  afterEach(() => history.replaceState(null, '', path0));
  const scrolls: { el: string; opts: unknown }[] = [];
  const realScroll = Element.prototype.scrollIntoView;
  const realScrollTo = window.scrollTo;
  let top: unknown = null;
  beforeEach(() => {
    scrolls.length = 0;
    top = null;
    Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
      scrolls.push({ el: this.id, opts });
    };
    window.scrollTo = ((o: unknown) => {
      top = o;
    }) as typeof window.scrollTo;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = realScroll;
    window.scrollTo = realScrollTo;
  });

  it('writes the section into the address on /docs and marks it in the contents', () => {
    history.replaceState(null, '', '/docs');
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    const toc = screen.getByRole('navigation', { name: en0.tocLabel });
    const nft = within(toc).getByRole('link', { name: /The Coinnibal NFT/ });
    fireEvent.click(nft);
    expect(location.pathname + location.hash).toBe('/docs#docs-nft');
    expect(scrolls.map((s) => s.el)).toContain('docs-nft');
    expect(nft.getAttribute('aria-current')).toBe('location');
    // an in-text link goes the same way
    fireEvent.click(screen.getAllByRole('link', { name: 'Power-ups' })[0]);
    expect(location.hash).toBe('#docs-powerups');
    // back to the very top (not 61px under it), and the address loses the section
    fireEvent.click(screen.getByRole('button', { name: en0.backToTop }));
    expect(top).toMatchObject({ top: 0 });
    expect(location.pathname + location.hash).toBe('/docs');
  }, 20_000);

  it('lands on the section of a link opened from outside (/docs#docs-payout)', async () => {
    history.replaceState(null, '', '/docs#docs-payout');
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(scrolls.map((s) => s.el)).toContain('docs-payout');
    const toc = screen.getByRole('navigation', { name: en0.tocLabel });
    expect(within(toc).getByRole('link', { name: /Rounds, payout and fee/ }).getAttribute('aria-current')).toBe('location');
  }, 20_000);

  it('leaves the lobby address alone (/play#docs: the hash names the lobby page)', () => {
    history.replaceState(null, '', '/play#docs');
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    fireEvent.click(within(screen.getByRole('navigation', { name: en0.tocLabel })).getByRole('link', { name: /Wallet safety/ }));
    expect(location.pathname + location.hash).toBe('/play#docs');
    expect(scrolls.map((s) => s.el)).toContain('docs-wallet');
  }, 20_000);

  it('moves the contents mark once a chapter heading passes 30% of the window, not when it reaches the header', async () => {
    const rect = Element.prototype.getBoundingClientRect;
    const h = window.innerHeight;
    // chapter 1 above the window, chapter 2's heading 28% down, chapter 3's at 34%, the rest further down
    const tops: Record<string, number> = { 'docs-play-h': -400, 'docs-rooms-h': h * 0.28, 'docs-value-h': h * 0.34 };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const top = tops[this.id] ?? (this.id.endsWith('-h') ? h * 2 : 0);
      return { top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    try {
      render(
        <Kb theme="paper">
          <DocsPage />
        </Kb>,
      );
      const toc = screen.getByRole('navigation', { name: en0.tocLabel });
      const mark = () => within(toc).getAllByRole('link').find((a) => a.getAttribute('aria-current') === 'location')?.getAttribute('href');
      await act(async () => {
        window.dispatchEvent(new Event('scroll'));
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(mark()).toBe('/docs#docs-rooms');
      tops['docs-value-h'] = h * 0.29;
      await act(async () => {
        window.dispatchEvent(new Event('scroll'));
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(mark()).toBe('/docs#docs-value');
    } finally {
      Element.prototype.getBoundingClientRect = rect;
    }
  }, 20_000);

  it('ends with the closing block beside Back to top: the official links, the seed-phrase line, the X account', () => {
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    const foot = document.querySelector('.dc-foot') as HTMLElement;
    expect(foot.textContent).toContain('The NFT mint will be on OpenSea, through the one link @coinnibalfun posts.');
    expect(foot.textContent).toContain('Nobody from Coinnibal will ever ask for your seed phrase.');
    expect(within(foot).getByRole('link', { name: /@coinnibalfun/ }).getAttribute('href')).toBe('https://x.com/coinnibalfun');
    expect(within(foot).getByRole('button', { name: en0.backToTop })).toBeTruthy();
  }, 20_000);

  it('folds the contents into one button on phones', () => {
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    const nav = screen.getByRole('navigation', { name: en0.tocLabel });
    const toggle = within(nav).getByRole('button', { name: /Contents/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(nav.classList.contains('is-open')).toBe(true);
  }, 20_000);
});

describe('docs/ECONOMY.md', () => {
  it('the worked examples and defaults of docs/ECONOMY.md are what the code computes', () => {
    const doc = readFileSync(resolve(process.cwd(), '../../docs/ECONOMY.md'), 'utf8');
    const n = (c: string) => Number(c.replace(/[^\d]/g, ''));
    const rows = doc
      .split('\n')
      .filter((l: string) => /^\| [\d,]+ \| [\d,]+/.test(l))
      .map((l: string) => l.split('|').slice(1, -1).map((c: string) => c.trim()));
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const r of rows) {
      const holder = r[1].includes('holder');
      const f = profitFee(n(r[0]), n(r[1].split(' ')[0]), holder ? DEFAULT_HOLDER_FEE_RATES : DEFAULT_FEE_RATES);
      expect([n(r[2]), n(r[3].split(' ')[0]), n(r[4]), n(r[5])], r.join(' | ')).toEqual([f.profit, f.burned, f.toVault, f.net]);
    }
    expect(doc).toContain(`**15 % is burned**`);
    expect(DEFAULT_FEE_RATES).toEqual({ burnBps: 1500, vaultBps: 500 });
    expect(MAX_TOTAL_FEE_BPS).toBe(2500);
    expect(DEFAULT_PAYMENT_BURN_BPS).toBe(5000);
  });
});

describe('docs routes', () => {
  it('opens the guide at /docs and #docs', () => {
    expect(pageFromUrl('/docs', '')).toBe('docs');
    expect(pageFromUrl('/docs/', '')).toBe('docs');
    expect(pageFromUrl('/', '#docs')).toBe('docs');
    // the retired Pass page falls back to the front page
    expect(pageFromUrl('/', '#pass')).toBe('play');
    expect(pageFromUrl('/docs', '#ranks')).toBe('ranks');
    expect(pageFromUrl('/', '')).toBe('play');
    expect(pageFromUrl('/elsewhere', '')).toBe('play');
  });

  it('keeps /docs while on the guide and leaves it for the other pages', () => {
    expect(urlForPage('docs', '/', '')).toBe('/#docs');
    expect(urlForPage('docs', '/docs', '')).toBe('/docs');
    expect(urlForPage('profile', '/docs', '')).toBe('/#profile');
    expect(urlForPage('play', '/docs', '?x=1')).toBe('/?x=1');
    expect(urlForPage('ranks', '/', '')).toBe('/#ranks');
  });
});
