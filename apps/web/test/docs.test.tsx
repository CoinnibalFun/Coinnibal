import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPACITY, RULES } from '@elymum/shared';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { chainStatus } from './evm-helpers';
import { Kb } from '../src/design';
import { pageFromUrl, urlForPage, useUi } from '../src/store';
import { DocsPage } from '../src/ui/docs/DocsPage';
import { docsEn } from '../src/ui/docs/content.en';
import { FACTS, SERVER, feeExample, payoutExample } from '../src/ui/docs/facts';

const initial = useUi.getState();
const en0 = docsEn();
afterEach(() => {
  act(() => useUi.setState(initial, true));
});

/** The section order the guide promises. */
const SECTION_IDS = ['play', 'rooms', 'value', 'payout', 'nft', 'token', 'fair', 'wallet', 'faq'];

describe('player guide facts', () => {
  it('works the fee example through splitPayout: entry 1,000 → fee 50 at the entry, coin 950, till 1,900 at the bell all paid', () => {
    expect(FACTS.example).toEqual({ entry: 1000, cashout: 1900 });
    expect(feeExample(500)).toEqual({ fee: 50n, value: 950n, player: 1900n });
    // the server's own rate when it differs
    expect(feeExample(450)).toEqual({ fee: 45n, value: 955n, player: 1900n });
  });

  it('works the payout example: 20 % of the winnings is the cut, 15 % burned and 5 % kept in the vault', () => {
    expect(FACTS.cut).toEqual({ bps: 2000, burnBps: 1500, vaultBps: 500 });
    // no entry fee rate (the recommended setup): the coin starts at 1,000, 900 won, 180 cut
    expect(payoutExample(0)).toMatchObject({ fee: 0, start: 1000, gross: 1900, profit: 900, burn: 135, vault: 45, cut: 180, net: 1720 });
    // with a 5 % entry fee rate the coin starts at 950 and 950 is won
    expect(payoutExample(500)).toMatchObject({ fee: 50, start: 950, profit: 950, burn: 142, vault: 47, net: 1711 });
    expect(FACTS.shop.prices).toEqual({ magnet: 600, leap: 900, speed: 600, invis: 1200 });
  });

  it('quotes the contract defaults', () => {
    expect(FACTS.fee).toEqual({ bps: 500, maxBps: 1000 });
    expect(FACTS.refundHours).toBe(24);
    expect(FACTS.rules).toMatchObject({ roundMin: 5, joinCloseS: 60, afkS: 45, lootMin: 3, lootMax: 24, lootEntryDiv: 4 });
    expect(FACTS.rules.roundMin).toBe(RULES.roundMs / 60_000);
    expect(FACTS.capacity).toEqual({ practice: CAPACITY.practice, private: CAPACITY.private, arena: 50 });
    // every default arena is open to everyone; they differ only by entry fee
    expect(FACTS.arenas.map((a) => [a.id, a.entry])).toEqual([
      [1, 1000],
      [2, 10000],
      [3, 50000],
      [4, 250000],
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

  it('explains the cut on winnings with the worked example, and the entry fee rate only when there is one', () => {
    const text = (c: typeof en) => JSON.stringify([c.dateline, c.sections]);
    const none = docsEn('$ELYMUM', 0);
    expect(text(none)).toContain('Cut 20% of winnings only');
    expect(text(none)).toContain('so you won 900: 135 is burned, 45 stays in the vault and you get 1,720');
    expect(text(none)).not.toContain('entry fee rate of');
    const live = docsEn('$ELYMUM', 300);
    expect(live.feeBps).toBe(300);
    expect(text(live)).toContain('entry fee rate of 3%');
    expect(text(live)).toContain('your coin starts at 970');
  });

  it('says what the live legacy arena takes when the server reports feeModel profit', () => {
    const legacy = docsEn('$ELYMUM', 500, 'profit');
    const payout = legacy.sections.find((s) => s.id === 'payout')!;
    expect(payout.blocks[0]).toMatchObject({ kind: 'note', title: 'The live arena takes its fee from the profit' });
    expect(JSON.stringify(docsEn('$ELYMUM').sections)).not.toContain('The live arena takes its fee from the profit');
  });

  it('covers the NFT and the token: what each is for, with the shop prices and holder perks from the code', () => {
    const nft = JSON.stringify(en.sections.find((s) => s.id === 'nft'));
    expect(nft).toContain('30% less');
    expect(nft).toContain('holders play first');
    const token = JSON.stringify(en.sections.find((s) => s.id === 'token'));
    expect(token).toContain('Magnet 600, Leap 900, Speed burst 600 and Invisibility 1,200 $ELYMUM');
    expect(token).toContain('15% of every winning payout is burned');
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

  it('uses no emoji and no Turkish, and names the network (Elysium, gas HYPE)', () => {
    const text = JSON.stringify(en);
    expect(text).not.toMatch(/\brent\b|token account/);
    expect(text).toContain('HYPE');
    expect(text).toContain('Elysium');
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
    expect(screen.getByRole('heading', { level: 3, name: 'Rounds, payout and the cut' })).toBeTruthy();
    // the receipt at the contract default rate (5 %): the coin starts at 950, 1,900 at the bell, 950 won
    expect(screen.getByText('−142')).toBeTruthy();
    expect(screen.getByText('−47')).toBeTruthy();
    expect(screen.getByText('1,711')).toBeTruthy();
    // the comic strips open the chapters that have drawings; the value flow has its moving diagram
    const strips = document.querySelectorAll('figure.cs');
    expect(strips).toHaveLength(6);
    for (const f of strips) expect(f.querySelectorAll('.cs__cap')).toHaveLength(3);
    expect(document.querySelector('figure.vf svg[aria-hidden="true"]')).toBeTruthy();
  }, 20_000);

  it("follows the server's fee rate (ChainStatus.feeBps)", () => {
    act(() =>
      useUi.setState({
        chain: chainStatus({ token: null, feeBps: 0 }),
      }),
    );
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    // no entry fee rate: no fee line, the coin starts at the whole 1,000 and 1,720 is paid
    expect(screen.getByText('1,720')).toBeTruthy();
    expect(screen.getByText('−135')).toBeTruthy();
    expect(screen.queryByText(/Entry fee rate/)).toBeNull();
  }, 20_000);
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
