import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPACITY, DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, DEFAULT_PAYMENT_BURN_BPS, INTEGRITY_SETTINGS_DEFAULT, MAX_TOTAL_FEE_BPS, RULES, profitFee } from '@coinnibal/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chainStatus } from './evm-helpers';
import { SETTINGS, installDomStubs, mockFetch } from './site-helpers';
import { DocsRoute } from '../src/site/DocsRoute';
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
    expect(play).toContain('you can join a round until 60\u00a0seconds before the bell');
    expect(play).toContain('join again after 12\u00a0seconds or more');
    expect(play).toContain('cannot eat or be eaten by other coins for 5.5\u00a0seconds');
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
  const en = docsEn('$TOKEN');

  it('explains the fee on profit with the worked example, at the live rates', () => {
    const text = (c: typeof en) => JSON.stringify(c.sections);
    expect(en.rates).toEqual({ burnBps: 1500, vaultBps: 500 });
    expect(text(en)).toContain('The fee is 20% of the profit.');
    expect(text(en)).toContain(
      "The game takes one fee: 20% of your profit. Profit is your value at the bell minus the ticket price. 15% of the profit is burned and 5% goes to the team wallet. If you don't make a profit, you pay no fee. NFT holders pay 10% instead (see [The Coinnibal NFT](#nft)).",
    );
    // the founder did not understand the slogan: a full sentence instead
    expect(text(en)).not.toMatch(/No profit, no fee/);
    // the network fees in ETH are not a game fee: the one-fee line says so instead of contradicting them
    expect(text(en)).toContain('The network fees in ETH go to the network, not to Coinnibal.');
    expect(text(en)).not.toMatch(/The only fee|buying a ticket has no fee/);
    // the receipt's caption reads right with any token name from the server ("a ticket of 1,000 tokens")
    expect(docsEn().receipt.caption).toBe('Example: a ticket of 1,000 tokens that is worth 1,900 tokens at the bell');
    expect(text(en)).not.toMatch(/entry fee|the cut|arena vault for the team|played by the team|fee wallet|\btill\b/);
    const live = docsEn('$TOKEN', { burnBps: 1000, vaultBps: 200 });
    expect(live.rates).toEqual({ burnBps: 1000, vaultBps: 200 });
    expect(text(live)).toContain('The game takes one fee: 12% of your profit.');
    expect(text(live)).toContain('10% of the profit is burned and 2% goes to the team wallet');
    // the worked numbers stand once, on the receipt (the page test reads them there)
    expect(payoutExample(live.rates)).toMatchObject({ burned: 90, toVault: 18, net: 1792 });
  });

  it('says where bots play, in one line, without describing the bot system, and leaves the testnet test rooms out', () => {
    const all = JSON.stringify(en);
    expect(all).toContain('never play in the paid rooms or in ticket rooms. You meet them only in rooms where nothing of value can be won or lost, and every bot is labelled BOT.');
    // no counts, sizes or room names of the bot system
    expect(all).not.toMatch(/Practice with bots|\d+ bots|play only in free private rooms/);
    // one list item speaks of bots, nothing else does
    const items = en.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === 'list' ? b.items : []));
    const about = items.filter((it) => /\bbots?\b/i.test(JSON.stringify(it)));
    expect(about).toHaveLength(1);
    expect(all.replace(JSON.stringify(about[0]), '')).not.toMatch(/\bbots?\b/i);
    expect(all).not.toMatch(/test arena|test room|\bTEST\b|Test ·/);
  });

  it('never talks about the test network, and reads the same on every network', () => {
    const notes = (c: typeof en) => c.sections.flatMap((s) => s.blocks).filter((b) => b.kind === 'note');
    const test = docsEn('$NIBAL', undefined, 'Robinhood Chain Testnet', { testnet: true });
    expect(notes(test).map((n) => n.kind === 'note' && n.stamp)).toEqual(['Risk']);
    const text = JSON.stringify(test);
    expect(text).not.toMatch(/[Ff]aucet|test tokens|testnet|mainnet/i);
    expect(text.match(/not been audited/g)).toHaveLength(1);
    const main = docsEn('$NIBAL', undefined, 'Robinhood Chain', { testnet: false });
    expect(notes(main).map((n) => n.kind === 'note' && n.stamp)).toEqual(['Risk']);
    expect(JSON.stringify(main)).not.toMatch(/[Ff]aucet|test tokens|testnet/i);
    expect(JSON.stringify(main).match(/not been audited/g)).toHaveLength(1);
  });

  it('says each rule once: the fee split, the round clock, the holder fee, the refunds', () => {
    const t = JSON.stringify(en.sections);
    const once = (re: RegExp) => expect(t.match(new RegExp(re.source, `${re.flags}g`)) ?? [], String(re)).toHaveLength(1);
    once(/15% of the profit is burned/);
    once(/A round is 5 minutes of play/);
    once(/play their rounds at the same time/);
    once(/goes into the room's vault/);
    once(/unlimited amount/);
    once(/know the risk/i);
    // said twice before: in the same item, or again a few lines on
    expect(t).not.toMatch(/never play in paid rooms|never unlimited|Payout is at the bell only|The whole price goes into/);
    once(/8% burned/);
    once(/20% off/);
    once(/Collect payout/);
    once(/after about 15 minutes/);
    once(/24 hours after buying/);
    once(/No cash-out/);
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
      ['$10 Room', 'Cannot join', 'Can join'],
      ['Power-up packs', 'Full price', '20% off'],
      ['Power-ups per round in a paid room', '2', '3'],
      ['Private room', 'Paid in tokens', '1 free a day, up to 10 players'],
      ['Coin look', 'Standard skins', 'Also the NFT skin and a holder badge'],
    ]);
    // the operator's access switch is not a game rule: the guide says nothing of a holders-only game (the landing FAQ
    // answers "Do I need the NFT to play? No.")
    expect(nft).not.toMatch(/holders only|Holders-only|needs the NFT to play/i);
    expect(nft).toContain('The Coinnibal NFT collection has 3,333 NFTs.');
    expect(nft).not.toMatch(/ERC-721/);
    const pu = JSON.stringify(en.sections.find((s) => s.id === 'powerups'));
    // no power-up prices in the guide (the shop shows them)
    // the four power-ups as cards led by their keys, with the shared boost timings
    const cards = en.sections.find((s) => s.id === 'powerups')!.blocks.find((b) => b.kind === 'cards');
    expect(cards?.kind === 'cards' && cards.items.map((c) => [c.kind, c.key, c.title, c.meta])).toEqual([
      ['magnet', 'R', 'Magnet', 'Ready again after 20\u00a0seconds'],
      ['leap', 'F', 'Leap', 'Ready again after 12\u00a0seconds'],
      ['speed', 'G', 'Speed burst', 'Ready again after 18\u00a0seconds'],
      ['invis', 'V', 'Invisibility', 'Ready again after 30\u00a0seconds'],
    ]);
    // no jargon ("cooldown"), and Leap follows the steering (the pointer or the joystick), not "the pointer"
    expect(pu).not.toMatch(/[Cc]ooldown|toward the pointer/);
    expect(pu).toContain('in the direction you are steering');
    // the two Magnets, with both times (8 s bought, 10 s airdrop)
    expect(pu).toContain('the Magnet power-up pulls food for 8\u00a0seconds, and a Magnet airdrop pulls food for 10\u00a0seconds.');
    // a button shows while you own one (BoostBar `shownKinds`), never "uses left"
    expect(pu).toContain('Its button shows while you own at least one of it.');
    expect(pu).not.toMatch(/uses left|uses of it left/);
    expect(pu).toContain('Pulls nearby food to your coin for 8\u00a0seconds.');
    expect(pu).not.toMatch(/\$\d/);
    expect(pu).toContain('a pack holds 3 uses');
    expect(pu).toContain('50% is burned and 50% goes to the team wallet');
    expect(pu).toContain('you can use 2 power-ups per round (per game in a ticket room)');
    // the shop's power-ups are not the airdrops of section 01 (both have a Magnet, with different times)
    expect(pu).toContain('They are not the free airdrops on the map (see [How to play](#play))');
    // the shop is in the lobby only (GameHud's top bar sells nothing)
    expect(pu).toContain('Nothing is sold during a game');
    const token = JSON.stringify(en.sections.find((s) => s.id === 'token'));
    expect(token).toContain('The game never creates new $TOKEN');
    expect(token).toContain('the game token is set in the contract once and can never be changed.');
    expect(token).not.toMatch(/Until it is set|token address/);
    // floor loot exists only where something without a ticket eats a coin (the testnet's test rooms): not in the guide
    expect(JSON.stringify(en)).not.toMatch(/loot/i);
  });

  it('explains winning and losing tokens in full sentences, true to the value rules (only eating moves value)', () => {
    const v = en.sections.find((s) => s.id === 'value')!;
    // the founder asked "what is this, profit?": the title says what the chapter is about
    expect(v.title).toBe('Winning and losing tokens');
    expect(v.lede).toBe('In a paid room your coin holds $TOKEN, and the number of $TOKEN it holds is its value. Your coin wins $TOKEN when it eats a coin and loses them when it is eaten.');
    const t = JSON.stringify(v);
    // ledger.ts `transfer`: a whole coin gives all its value, a piece a share by its mass, the last piece the rest
    expect(t).toContain('Eat a whole coin and all of its value moves to your coin. Eat one piece of a split coin and you get part of its value: the bigger the piece, the bigger the part. Its last piece gives you everything it has left.');
    expect(t).toContain('only eating. Your coin gains value when it eats another coin or a piece of one, and loses value when another coin eats it or one of its pieces.');
    expect(t).toContain('Nothing else changes your value: not food, airdrops, power-ups, splitting, pushing out mass, a cactus, or the slow mass loss of big coins.');
    // the HUD's own words (en.ts `g.till`, `g.mass`), in every kind of room: ticket rooms are mode 'arena' like the paid
    // rooms, practice and free private rooms show the mass
    const where = v.blocks.flatMap((b) => (b.kind === 'list' ? b.items : [])).find((it) => typeof it !== 'string' && it.term === 'Where you see it:');
    expect(where && typeof where !== 'string' && where.text).toBe(
      'in a paid room or a ticket room, the yellow sticker at the top of the game shows your value next to "You\'re worth". In practice rooms and free private rooms, the same sticker shows your mass next to "You weigh".',
    );
    // the line the founder did not understand is gone, and no claim of what each thing does to mass
    expect(t).not.toMatch(/Mass is not value|do not change the value|breaking on a cactus/);
  });

  it('shows the controls as two tables, on a computer and on a phone, in the game\'s own words', () => {
    const play = en.sections.find((s) => s.id === 'play')!;
    const keys = play.blocks.filter((b) => b.kind === 'keys');
    expect(keys.map((k) => k.kind === 'keys' && [k.caption, k.touch === true])).toEqual([
      ['On a computer', false],
      ['On a phone', true],
    ]);
    const phone = keys[1].kind === 'keys' ? keys[1].rows : [];
    expect(phone.map((r) => r.key)).toEqual(['Joystick (bottom left)', 'Split', 'Tip', 'Power-up buttons', 'Sticker button', 'Chat button', 'Standings card (top left)']);
    const computer = keys[0].kind === 'keys' ? keys[0].rows : [];
    expect(computer.find((r) => r.key === 'R / F / G / V')?.action).toBe('Use a power-up: R Magnet, F Leap, G Speed burst, V Invisibility (see [Power-ups](#powerups))');
    expect(computer.find((r) => r.key === '1–8')?.action).toBe('Show a sticker over your coin');
    const t = JSON.stringify(play);
    // the table replaces the old "On phones:" line; "emote" and "push-out" were not the game's words
    expect(t).not.toMatch(/On phones:|emote|push-out/i);
    // world.ts: a coin breaks on a cactus only with at least 1.33 times its mass
    expect(t).toContain("a coin with at least 1.33 times a cactus's mass breaks into pieces when it moves over the cactus.");
  });

  it('keeps to playing, the NFT, the token and the money: no internal mechanics', () => {
    const t = JSON.stringify(en);
    expect(t).not.toMatch(/\bPass\b|season|prize pool|reveal/i);
  });

  it('describes timed rounds and promises no cash-out in arenas', () => {
    const all = JSON.stringify(en.sections);
    expect(all).toContain('A round is 5 minutes of play,');
    expect(all).toContain('you cannot leave a round early with your value');
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
    expect(JSON.stringify(docsEn('$TOKEN', undefined, 'Robinhood Chain'))).toContain('ETH on Robinhood Chain for network fees');
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/record_game/);
    // the CI guard's Turkish letters, written as escapes so this file passes the guard itself
    expect(text).not.toMatch(/[\u00e7\u011f\u0131\u00f6\u015f\u00fc\u00c7\u011e\u0130\u00d6\u015e\u00dc]/);
  });

  it('names the official links for the OpenSea mint, never a mint on this site', () => {
    const wallet = JSON.stringify(docsEn('tokens', undefined, 'Robinhood Chain', { site: 'coinnibal.fun', x: 'coinnibalfun' }).sections.find((s) => s.id === 'wallet'));
    expect(wallet).toContain('Official links:');
    expect(wallet).toContain('the site is coinnibal.fun and the X account is @coinnibalfun. The NFT mint will be on OpenSea. Use only the OpenSea link that @coinnibalfun posts.');
    expect(wallet).not.toMatch(/only mint|the game and the/);
    // one name for the phrase across the site (the footer says "seed phrase")
    expect(wallet).toContain('seed phrase');
    expect(JSON.stringify(en)).not.toMatch(/recovery phrase|To no one/i);
    // the X handle follows the site settings; the shared default without them
    expect(JSON.stringify(docsEn('tokens', undefined, undefined, { x: '@other' }))).toContain('the X account is @other.');
    expect(JSON.stringify(docsEn())).toContain('the X account is @coinnibalfun.');
  });

  it('matches the code on shields, holds, ticket rooms and private-room prices', () => {
    const t = JSON.stringify(en.sections);
    // a shield (airdrop or spawn) blocks eating both ways (world.ts eatDynamic)
    expect(t).toContain('HODL Shield stops other coins from eating you for 8\u00a0seconds, but you cannot eat them either.');
    // an auto-held winning payout (integrity/service.ts holdDecision) and its release after the default hours
    expect(t).toContain(`With no decision within ${INTEGRITY_SETTINGS_DEFAULT.autoReleaseHours} hours, it is paid as usual.`);
    // a ticket room keeps one round number from its start to its end, so the power-up limit is per game there
    expect(t).toContain('(per game in a ticket room)');
    // only coins still alive at a ticket room's end are paid (an eaten coin's value already moved)
    expect(t).toContain("Coins still alive at the room's end are paid, with the normal fee on profit.");
    expect(t).not.toMatch(/All tickets are paid/);
    // private rooms are paid in the game token (owner decision 2026-11-18), split like a power-up pack; the admin sets
    // the price, so no fixed price in the guide
    expect(t).not.toMatch(/\d\.\d+ ETH|of that for every|costs a little ETH/);
    // its price is a price, not a fee ("fee" is only the fee on profit); the holders' free room is the first tier only
    expect(t).toContain('Opening one costs tokens. Bigger rooms cost more, and you see the price before you pay.');
    expect(t).toContain('As with a power-up pack, 50% of the payment is burned and 50% goes to the team wallet. NFT holders open one room a day for free, for up to 10 players.');
    expect(t).not.toMatch(/small fee|of the fee is burned/);
    const token = JSON.stringify(en.sections.find((s) => s.id === 'token'));
    expect(token).toContain('power-up packs and opening a private room');
    expect(token).toContain('the NFT mint and network fees. These are paid in ETH.');
    expect(token).not.toMatch(/opening a private room and network fees/);
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
    // the comic strips open the chapters that have drawings; the value flow has its moving diagram
    const strips = document.querySelectorAll('figure.cs');
    expect(strips).toHaveLength(6);
    for (const f of strips) expect(f.querySelectorAll('.cs__cap')).toHaveLength(3);
    expect(document.querySelector('figure.vf svg[aria-hidden="true"]')).toBeTruthy();
    // the phones' contents button counts the chapters in words
    expect(within(toc).getByRole('button', { name: /Contents/ }).textContent).toContain('11 chapters');
    // the two controls tables, each named by its own caption (no id twice on the page)
    const tables = [...document.querySelectorAll<HTMLTableElement>('table.dc-keys')];
    expect(tables.map((t) => document.getElementById(t.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['On a computer', 'On a phone']);
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    // the phone's controls are still pills, not keys that press themselves
    expect(tables[1].querySelector('kbd')).toBeNull();
    expect([...tables[1].querySelectorAll('.dc-pill')].map((p) => p.textContent)).toContain('Tip');
    // every power-up card: its picture, then "Press [R]" on a keyboard and "Tap (picture) at the bottom right" on a phone
    const cards = [...document.querySelectorAll('.dc-card')];
    expect(cards).toHaveLength(4);
    const ways = (c: Element) => [...c.querySelectorAll('.dc-card__way')].map((w) => [w.querySelector('dt')?.textContent, w.querySelector('dd')?.textContent?.replace(/\s+/g, ' ').trim()]);
    expect(cards.map(ways)).toEqual(
      ['R', 'F', 'G', 'V'].map((k) => [
        ['Keyboard', `Press ${k}`],
        ['Phone', 'Tap at the bottom right'],
      ]),
    );
    expect(screen.getByRole('img', { name: 'the Magnet button' }).querySelector('path')).toBeTruthy();
    expect(cards[0].querySelector('.dc-card__key')?.tagName).toBe('KBD');
    // the two kinds of private room sit under "Private rooms"
    expect([...document.querySelectorAll('.dc-list li.is-sub strong')].map((s) => s.textContent)).toEqual(['Free room:', 'Ticket room:']);
    // the fee paragraph stands beside the receipt it explains
    const fee = document.querySelector('.dc-fee__grid')!;
    expect(fee.querySelector('.dc-p')?.textContent).toMatch(/^The game takes one fee: 20% of your profit\./);
    expect(fee.querySelector('.dc-fee__slip')).toBeTruthy();
    // the block titles are headings in the display face, not mono labels
    expect(document.querySelectorAll('.dc-cap.mono, .dc-table caption.mono, .dc-fee__cap.mono, .dc-flow__title.mono, .dc-card__meta.mono')).toHaveLength(0);
  }, 20_000);

  it('gives /docs one h1 (chapters h2, block titles h3) and keeps the lobby\'s levels', () => {
    const { unmount } = render(
      <Kb theme="paper">
        <DocsPage headingLevel={1} />
      </Kb>,
    );
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([en0.title]);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(en0.sections.map((s) => s.title));
    expect(screen.getByRole('heading', { level: 3, name: 'Magnet' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: /On the server/ })).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0);
    unmount();
    render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 2, name: en0.title })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Magnet' })).toBeTruthy();
  }, 20_000);

  it('says "tokens" on /docs even when the server names a ticker; the lobby keeps the server\'s symbol', async () => {
    installDomStubs();
    const fetched = mockFetch({ 'GET /api/config': { chain: chainStatus() }, 'GET /api/site/settings': { settings: SETTINGS } });
    try {
      act(() => useUi.setState({ chain: chainStatus() }));
      expect(useUi.getState().chain?.token?.symbol).toBe('$NIBAL');
      const { unmount } = render(
        <Kb theme="paper">
          <DocsRoute />
        </Kb>,
      );
      await waitFor(() => expect(fetched.calls.some((c) => c.path === '/api/config')).toBe(true));
      expect(document.body.textContent).not.toContain('NIBAL');
      expect(document.body.textContent).toContain('a pack holds 3 uses of one power-up. The shop shows each price, paid in tokens.');
      // the page's own title is its one h1, and the top bar has no aside
      expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([en0.title]);
      expect(document.querySelector('.kb-plate__aside')).toBeNull();
      unmount();
      render(
        <Kb theme="paper">
          <DocsPage />
        </Kb>,
      );
      expect(document.body.textContent).toContain('paid in $NIBAL');
    } finally {
      fetched.restore();
    }
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

  it('/docs lays out its chapters one at a time after the first paint, and all of them before a jump', async () => {
    history.replaceState(null, '', '/docs');
    const { container } = render(
      <Kb theme="paper">
        <DocsPage later />
      </Kb>,
    );
    const later = () => [...container.querySelectorAll('.dc-sec')].map((s) => s.hasAttribute('data-later'));
    // every chapter waits its turn (docs.css: content-visibility, so the browser lays out only those on screen)
    expect(later()).toEqual(Array(11).fill(true));
    // one chapter per idle moment
    await act(() => new Promise((r) => setTimeout(r, 80)));
    const left = later().filter(Boolean).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(11);
    // a jump lays out every chapter on the way before it aims the scroll
    fireEvent.click(within(screen.getByRole('navigation', { name: en0.tocLabel })).getByRole('link', { name: /The Coinnibal NFT/ }));
    expect(later().some(Boolean)).toBe(false);
    expect(scrolls.map((s) => s.el)).toContain('docs-nft');
  }, 20_000);

  it('/docs opened on a chapter (/docs#docs-payout) or the lobby: no chapter waits', () => {
    history.replaceState(null, '', '/docs#docs-payout');
    const a = render(
      <Kb theme="paper">
        <DocsPage later />
      </Kb>,
    );
    expect(a.container.querySelectorAll('.dc-sec[data-later]')).toHaveLength(0);
    a.unmount();
    history.replaceState(null, '', '/docs');
    const b = render(
      <Kb theme="paper">
        <DocsPage />
      </Kb>,
    );
    expect(b.container.querySelectorAll('.dc-sec[data-later]')).toHaveLength(0);
  });

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

describe('the guide stays light', () => {
  it('draws the power-up pictures from a module with no runtime import, so /docs pulls no game code for them', () => {
    const src = (rel: string) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');
    const glyphs = src('ui/game/boostGlyphs.ts');
    const imports = [...glyphs.matchAll(/^import\s+(type\s+)?.*$/gm)];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((m) => m[1])).toBe(true);
    // the guide takes the pictures from there, never from the HUD's BoostBar (which imports the engine)
    const page = src('ui/docs/DocsPage.tsx');
    expect(page).toContain("from '../game/boostGlyphs'");
    expect(page).not.toMatch(/from '\.\.\/game\/(BoostBar|index)'|from '\.\.\/\.\.\/game\//);
  });
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
