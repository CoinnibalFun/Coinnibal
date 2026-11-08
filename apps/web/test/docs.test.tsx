import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPACITY, DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, DEFAULT_PAYMENT_BURN_BPS, MAX_TOTAL_FEE_BPS, RULES, profitFee } from '@elymum/shared';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
const SECTION_IDS = ['play', 'rooms', 'value', 'payout', 'nft', 'token', 'fair', 'wallet', 'faq'];

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
    const text = (c: typeof en) => JSON.stringify([c.dateline, c.sections]);
    expect(en.rates).toEqual({ burnBps: 1500, vaultBps: 500 });
    expect(text(en)).toContain('Fee 20% of profit only');
    expect(text(en)).toContain('so your profit is 900: 135 is burned, 45 goes to the fee wallet and you get 1,720');
    expect(text(en)).toContain('there is no fee to enter');
    expect(text(en)).not.toMatch(/entry fee rate of|the cut|arena vault for the team|played by the team/);
    const live = docsEn('$ELYMUM', { burnBps: 1000, vaultBps: 200 });
    expect(live.rates).toEqual({ burnBps: 1000, vaultBps: 200 });
    expect(text(live)).toContain('Fee 12% of profit only');
    expect(text(live)).toContain('90 is burned, 18 goes to the fee wallet and you get 1,792');
  });

  it('says the arenas are played by people only', () => {
    const value = JSON.stringify(en.sections.find((s) => s.id === 'value'));
    expect(value).toContain('Every coin in an arena is a player who bought a ticket; the game fields no coins of its own there.');
  });

  it('covers the NFT and the token: what each is for, with the shop prices and holder perks from the code', () => {
    const nft = JSON.stringify(en.sections.find((s) => s.id === 'nft'));
    expect(nft).toContain('20% less');
    expect(nft).toContain('10 % instead of 20 %');
    expect(nft).toContain('one room a day for free');
    expect(nft).toContain('the $10 arena is for holders only');
    expect(nft).toContain('holders play first');
    const token = JSON.stringify(en.sections.find((s) => s.id === 'token'));
    expect(token).toContain('Magnet $0.60, Leap $0.90, Speed burst $0.60 and Invisibility $1.20 by default');
    expect(token).not.toContain('Nothing is sold during a game');
    expect(token).toContain('15% of every profit is burned');
    expect(token).toContain('which burns 50% of it and sends 50% to the fee wallet');
    expect(token).toContain('Nothing mints new $ELYMUM');
    const t = JSON.stringify([en.receipt, en.sections]);
    expect(t).toMatch(/what is left then is burned/);
    expect(t).toContain('Opening soon');
  });

  it('keeps to playing, the NFT, the token and the money: no internal mechanics', () => {
    const t = JSON.stringify(en);
    expect(t).not.toMatch(/\bbots?\b/i);
    expect(t).not.toMatch(/\bPass\b|season|prize pool|reveal/i);
  });

  it('describes timed rounds and promises no cash-out in arenas', () => {
    const all = JSON.stringify([en.dateline, en.sections]);
    expect(all).toContain('5-minute rounds');
    expect(all).toContain('There is no cash-out in an arena');
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
    expect(text).toContain('ETH on Robinhood Chain Testnet');
    expect(JSON.stringify(docsEn('$ELYMUM', undefined, 'Robinhood Chain'))).toContain('ETH on Robinhood Chain)');
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/record_game/);
    // the CI guard's Turkish letters, written as escapes so this file passes the guard itself
    expect(text).not.toMatch(/[\u00e7\u011f\u0131\u00f6\u015f\u00fc\u00c7\u011e\u0130\u00d6\u015e\u00dc]/);
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
    expect(within(toc).getAllByRole('button')).toHaveLength(SECTION_IDS.length);
    for (const s of en0.sections) expect(screen.getByRole('heading', { level: 3, name: s.title })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Rounds, payout and the fee' })).toBeTruthy();
    // the receipt at the contract default rates (15 % + 5 % of profit): 1,900 at the bell, 900 profit
    expect(screen.getByText('−135')).toBeTruthy();
    expect(screen.getByText('−45')).toBeTruthy();
    expect(screen.getByText('1,720')).toBeTruthy();
    // the comic strips open the chapters that have drawings; the value flow has its moving diagram
    const strips = document.querySelectorAll('figure.cs');
    expect(strips).toHaveLength(6);
    for (const f of strips) expect(f.querySelectorAll('.cs__cap')).toHaveLength(3);
    expect(document.querySelector('figure.vf svg[aria-hidden="true"]')).toBeTruthy();
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
