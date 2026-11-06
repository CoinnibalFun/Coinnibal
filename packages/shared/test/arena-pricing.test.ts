import { describe, expect, it } from 'vitest';
import {
  ARENA_PRICING_DEFAULT,
  DEFAULT_ARENAS,
  REFERENCE_USD_PER_TOKEN,
  applyArenaPricing,
  arenaPriceDiff,
  arenaUsdLabel,
  formatUsd,
  formatUsdCents,
  parseUsdPrice,
  roundSigFigs,
  tokenRawToUsd,
  usdToTokenRaw,
  type ChainArenaState,
} from '../src';

const E18 = 10n ** 18n;

describe('USD tiers', () => {
  it('ships $1, $3, $5 and $10, the $10 arena for holders only', () => {
    expect(ARENA_PRICING_DEFAULT.tiers).toEqual([
      { arenaId: 1, usdCents: 100, holdersOnly: false },
      { arenaId: 2, usdCents: 300, holdersOnly: false },
      { arenaId: 3, usdCents: 500, holdersOnly: false },
      { arenaId: 4, usdCents: 1000, holdersOnly: true },
    ]);
    expect(ARENA_PRICING_DEFAULT).toMatchObject({ source: 'manual', manualUsdPerToken: null, sigFigs: 2 });
  });

  it('creates the arenas at the dollar price of the reference token price', () => {
    const price = parseUsdPrice(REFERENCE_USD_PER_TOKEN);
    for (const a of DEFAULT_ARENAS) expect(usdToTokenRaw(a.usdCents, price, 18, 2)).toBe(BigInt(a.entryTokens) * E18);
  });
});

describe('parseUsdPrice', () => {
  it('reads decimal prices exactly (18 decimals)', () => {
    expect(parseUsdPrice('1')).toBe(E18);
    expect(parseUsdPrice('0.00081')).toBe(810_000_000_000_000n);
    expect(parseUsdPrice(' 0.000000000000000001 ')).toBe(1n);
    expect(parseUsdPrice('12.5')).toBe(12_500_000_000_000_000_000n);
  });

  it('refuses zero, negatives, exponents, commas and more than 18 decimals', () => {
    for (const bad of ['0', '0.0', '-1', '1e-6', '1,5', '', 'abc', '0.0000000000000000001', '.5']) expect(() => parseUsdPrice(bad)).toThrow(RangeError);
  });
});

describe('usdToTokenRaw: USD to token entry, rounded', () => {
  it('rounds to significant figures of whole token amounts', () => {
    const p = parseUsdPrice('0.00081'); // $1 = 1,234.5679 tokens
    expect(usdToTokenRaw(100, p, 18, 2)).toBe(1_200n * E18);
    expect(usdToTokenRaw(100, p, 18, 3)).toBe(1_230n * E18);
    expect(usdToTokenRaw(100, p, 18, 4)).toBe(1_235n * E18); // 1234.57 rounds half up
    expect(usdToTokenRaw(300, p, 18, 2)).toBe(3_700n * E18); // 3,703.7
    expect(usdToTokenRaw(500, p, 18, 2)).toBe(6_200n * E18); // 6,172.8
    expect(usdToTokenRaw(1000, p, 18, 2)).toBe(12_000n * E18); // 12,345.7
  });

  it('a meme-coin price: millions of tokens a dollar', () => {
    const p = parseUsdPrice('0.000000737');
    expect(usdToTokenRaw(100, p, 18, 2)).toBe(1_400_000n * E18); // 1,356,852
    expect(usdToTokenRaw(1000, p, 18, 2)).toBe(14_000_000n * E18);
  });

  it('an expensive token: fractions of a token, still to the base unit', () => {
    const p = parseUsdPrice('3.07');
    // $1 = 0.325732899... tokens → 0.33
    expect(usdToTokenRaw(100, p, 18, 2)).toBe(330_000_000_000_000_000n);
    // 6 decimals: $1 = 325732.899 base units → 330000
    expect(usdToTokenRaw(100, p, 6, 2)).toBe(330_000n);
  });

  it('rounds half up and carries into a new digit', () => {
    expect(roundSigFigs(1250n, 2)).toBe(1300n);
    expect(roundSigFigs(1249n, 2)).toBe(1200n);
    expect(roundSigFigs(9960n, 2)).toBe(10000n);
    expect(roundSigFigs(7n, 2)).toBe(7n);
    // $1 at $0.0001001 a token: 9,990.0099 tokens → 10,000 with 2 figures
    expect(usdToTokenRaw(100, parseUsdPrice('0.0001001'), 18, 2)).toBe(10_000n * E18);
  });

  it('is exact: no floating point on the money path', () => {
    // 1/3 dollar a token, 0 decimals: $1 = 3 tokens, $10 = 30
    const p = parseUsdPrice('0.333333333333333333');
    expect(usdToTokenRaw(100, p, 0, 6)).toBe(3n);
    expect(usdToTokenRaw(1000, p, 0, 6)).toBe(30n);
    // the rounded entry is never more than half a step from the exact amount
    for (const price of ['0.00081', '0.0123', '0.000000737', '1.99']) {
      const q = parseUsdPrice(price);
      for (const cents of [100, 300, 500, 1000]) {
        const raw = usdToTokenRaw(cents, q, 18, 2);
        const usd = tokenRawToUsd(raw, q, 18);
        expect(Math.abs(usd - cents / 100) / (cents / 100)).toBeLessThan(0.05);
      }
    }
  });

  it('refuses amounts the contract cannot hold', () => {
    // a price so high that a dollar is less than one base unit
    expect(() => usdToTokenRaw(100, parseUsdPrice('999999999999'), 0, 2)).toThrow(/less than one base unit/);
    // a price so low that the entry overflows uint128
    expect(() => usdToTokenRaw(1_000_000, 1n, 30, 2)).toThrow(/uint128/);
    expect(() => usdToTokenRaw(0, E18, 18, 2)).toThrow(RangeError);
    expect(() => usdToTokenRaw(100, E18, 18, 0)).toThrow(RangeError);
    expect(() => usdToTokenRaw(100, E18, 18, 7)).toThrow(RangeError);
  });
});

describe('USD display', () => {
  it('formats tier prices and approximate values', () => {
    expect(formatUsdCents(100)).toBe('$1');
    expect(formatUsdCents(1000)).toBe('$10');
    expect(formatUsdCents(250)).toBe('$2.50');
    expect(formatUsdCents(123456)).toBe('$1,234.56');
    expect(formatUsd(0.9721)).toBe('$0.97');
    expect(formatUsd(3)).toBe('$3');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1234.5)).toBe('$1,235');
  });

  it('labels a ticket $1 when the chain asks the synced amount, else its approximate value', () => {
    const view = { usdPerToken: '0.00081', tiers: ARENA_PRICING_DEFAULT.tiers, sigFigs: 2 };
    expect(arenaUsdLabel(view, 1, 1_200n * E18, 18)).toEqual({ text: '$1', exact: true });
    expect(arenaUsdLabel(view, 4, 12_000n * E18, 18)).toEqual({ text: '$10', exact: true });
    // not synced yet (the old 1,000-token ticket): its value at the price
    expect(arenaUsdLabel(view, 1, 1_000n * E18, 18)).toEqual({ text: '≈ $0.81', exact: false });
    // an arena no tier names
    expect(arenaUsdLabel(view, 9, 2_000n * E18, 18)).toEqual({ text: '≈ $1.62', exact: false });
    // no price: no dollar label
    expect(arenaUsdLabel({ ...view, usdPerToken: null }, 1, 1_200n * E18, 18)).toBeNull();
    expect(arenaUsdLabel(null, 1, 1_200n * E18, 18)).toBeNull();
  });
});

describe('applyArenaPricing', () => {
  it('sets the manual price (stamped), tiers and rounding', () => {
    const r = applyArenaPricing(ARENA_PRICING_DEFAULT, { manualUsdPerToken: '0.00081', sigFigs: 3 }, 1234);
    expect(r).toMatchObject({ ok: true, settings: { manualUsdPerToken: '0.00081', manualSetAt: 1234, sigFigs: 3 } });
    if (!r.ok) return;
    // the same price again keeps its time
    const same = applyArenaPricing(r.settings, { manualUsdPerToken: '0.00081' }, 9999);
    expect(same.ok && same.settings.manualSetAt).toBe(1234);
    const cleared = applyArenaPricing(r.settings, { manualUsdPerToken: null }, 9999);
    expect(cleared.ok && cleared.settings).toMatchObject({ manualUsdPerToken: null, manualSetAt: null });
    const tiers = applyArenaPricing(r.settings, { tiers: [{ arenaId: 2, usdCents: 250 }, { arenaId: 1, usdCents: 50, holdersOnly: true }] }, 1);
    expect(tiers.ok && tiers.settings.tiers).toEqual([
      { arenaId: 1, usdCents: 50, holdersOnly: true },
      { arenaId: 2, usdCents: 250, holdersOnly: false },
    ]);
  });

  it('refuses bad values, the unwired TWAP source and unknown fields', () => {
    const bad = (patch: Record<string, unknown>) => applyArenaPricing(ARENA_PRICING_DEFAULT, patch, 1);
    expect(bad({ source: 'dex_twap' })).toMatchObject({ ok: false, field: 'source', message: expect.stringMatching(/not wired/) });
    expect(bad({ source: 'oracle' })).toMatchObject({ ok: false, field: 'source' });
    expect(bad({ manualUsdPerToken: '0' })).toMatchObject({ ok: false, field: 'manualUsdPerToken' });
    expect(bad({ manualUsdPerToken: 0.001 })).toMatchObject({ ok: false, field: 'manualUsdPerToken' });
    expect(bad({ sigFigs: 0 })).toMatchObject({ ok: false, field: 'sigFigs' });
    expect(bad({ sigFigs: 2.5 })).toMatchObject({ ok: false, field: 'sigFigs' });
    expect(bad({ tiers: [] })).toMatchObject({ ok: false, field: 'tiers' });
    expect(bad({ tiers: [{ arenaId: 1, usdCents: 100 }, { arenaId: 1, usdCents: 300 }] })).toMatchObject({ ok: false, field: 'tiers.1.arenaId' });
    expect(bad({ tiers: [{ arenaId: 1, usdCents: 0 }] })).toMatchObject({ ok: false, field: 'tiers.0.usdCents' });
    expect(bad({ tiers: [{ arenaId: 1, usdCents: 1.5 }] })).toMatchObject({ ok: false, field: 'tiers.0.usdCents' });
    expect(bad({ manualSetAt: 5 })).toMatchObject({ ok: false, field: 'manualSetAt' });
    expect(bad({ hacker: true })).toMatchObject({ ok: false, field: 'hacker' });
  });
});

describe('arenaPriceDiff: the admin sync', () => {
  const arena = (id: number, tokens: bigint, o: Partial<ChainArenaState> = {}): ChainArenaState => ({ id, exists: true, entryFee: tokens * E18, maxSessions: 300, enabled: true, openSessions: 0, holdersOnly: false, ...o });
  const base = { tiers: ARENA_PRICING_DEFAULT.tiers, price: parseUsdPrice('0.00081'), decimals: 18, sigFigs: 2, holderNft: true };

  it('old → new amount and USD for every tier, the holders-only flag, nothing else', () => {
    const rows = arenaPriceDiff({ ...base, arenas: [arena(1, 1_000n), arena(2, 3_700n), arena(3, 5_000n), arena(4, 10_000n), arena(9, 1n)] });
    expect(rows.map((r) => [r.arenaId, r.oldEntry, r.newEntry, r.entryChange, r.holdersOnlyChange, r.blocked])).toEqual([
      [1, 1_000n * E18, 1_200n * E18, true, null, null],
      [2, 3_700n * E18, 3_700n * E18, false, null, null],
      [3, 5_000n * E18, 6_200n * E18, true, null, null],
      [4, 10_000n * E18, 12_000n * E18, true, true, null],
    ]);
    expect(rows[0].oldUsd).toBeCloseTo(0.81, 6);
    expect(rows[0].newUsd).toBeCloseTo(0.972, 6);
    expect(rows[3].newUsd).toBeCloseTo(9.72, 6);
  });

  it('blocks a new entry fee while tickets are open (the contract would revert ArenaBusy)', () => {
    const rows = arenaPriceDiff({ ...base, arenas: [arena(1, 1_000n, { openSessions: 3 }), arena(2, 3_700n, { openSessions: 5 }), arena(3, 6_200n), arena(4, 12_000n, { holdersOnly: true })] });
    expect(rows[0].blocked).toMatch(/3 open tickets/);
    // no entry change: open tickets do not matter
    expect(rows[1].blocked).toBeNull();
    expect(rows.slice(1).every((r) => !r.entryChange && r.holdersOnlyChange === null)).toBe(true);
  });

  it('a missing arena, a missing holder NFT, a missing price', () => {
    const rows = arenaPriceDiff({ ...base, holderNft: false, arenas: [arena(1, 1_000n), arena(4, 10_000n)] });
    expect(rows.find((r) => r.arenaId === 2)!.blocked).toMatch(/does not exist/);
    expect(rows.find((r) => r.arenaId === 4)!.blocked).toMatch(/holder NFT/);
    const none = arenaPriceDiff({ ...base, price: null, arenas: [arena(1, 1_000n)] });
    expect(none[0]).toMatchObject({ newEntry: null, entryChange: false, error: expect.stringMatching(/no USD price/) });
  });
});
