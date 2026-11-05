import { describe, expect, it } from 'vitest';
import {
  BOOST_KEYS,
  BOOST_KINDS,
  BOOST_RULES,
  CellFlag,
  EntityKind,
  PROTOCOL_VERSION,
  RULES,
  SHOP_DEFAULTS,
  decodeSnapshot,
  encodeSnapshot,
  isBoostKind,
  leapDistance,
  migrateBoostCounts,
  normalizeBoostKind,
  packPriceRaw,
  type ClientMessage,
  type ServerMessage,
} from '../src';

describe('boosts: wire', () => {
  it('the leap and invisible flags round-trip in a snapshot together with the other cell flags', () => {
    const flags = CellFlag.Leap | CellFlag.Invisible | CellFlag.Magnet | CellFlag.Pump | CellFlag.Shield;
    const snap = decodeSnapshot(
      encodeSnapshot({
        tick: 1,
        view: { x: 0, y: 0, h: 1000 },
        players: [{ id: 7, skin: 1, flags: 0, name: 'a' }],
        upserts: [{ id: 3, kind: EntityKind.Cell, x: 10, y: 10, r: 40, playerId: 7, flags }],
        removals: [],
      }),
    );
    expect(snap.upserts[0].flags).toBe(flags);
    expect(snap.upserts[0].flags! & CellFlag.Leap).toBe(32);
    expect(snap.upserts[0].flags! & CellFlag.Invisible).toBe(64);
  });

  it('the flag is a new bit that fits the u8 and clashes with none', () => {
    const bits = Object.values(CellFlag);
    expect(new Set(bits).size).toBe(bits.length);
    expect(Math.max(...bits)).toBeLessThan(256);
  });

  it('the messages keep their shape (v11: the kinds changed)', () => {
    expect(PROTOCOL_VERSION).toBe(12);
    const c: ClientMessage = { t: 'boost', kind: 'leap' };
    const s: ServerMessage[] = [
      { t: 'boost', kind: 'magnet', ok: true, ms: 8000 },
      { t: 'boost', kind: 'speed', ok: false, reason: 'round_limit' },
      {
        t: 'boosts',
        state: { usable: true, signedIn: true, charges: { magnet: 1, leap: 0, speed: 2, invis: 1 }, cooldownMs: { magnet: 0, leap: 0, speed: 0, invis: 0 }, arena: { left: 2, max: 2 } },
      },
    ];
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    expect(s).toHaveLength(3);
  });
});

describe('boosts: rules', () => {
  it('kinds, keys and validation', () => {
    expect(BOOST_KINDS).toEqual(['magnet', 'leap', 'speed', 'invis']);
    expect(isBoostKind('leap')).toBe(true);
    expect(isBoostKind('invis')).toBe(true);
    // the retired Shockwave is no kind any more, but a saved one reads as Leap
    expect(isBoostKind('shock')).toBe(false);
    expect(normalizeBoostKind('shock')).toBe('leap');
    expect(normalizeBoostKind('magnet')).toBe('magnet');
    expect(normalizeBoostKind('toString')).toBeNull();
    expect(normalizeBoostKind(3)).toBeNull();
    expect(isBoostKind('laser')).toBe(false);
    expect(BOOST_KEYS).toEqual({ magnet: 'KeyR', leap: 'KeyF', speed: 'KeyG', invis: 'KeyV' });
    // no clash with Space split, E tip, WASD, Q spectate, Enter chat, 1-8 emotes
    const taken = ['Space', 'KeyE', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'Enter', ...Array.from({ length: 8 }, (_, i) => `Digit${i + 1}`)];
    for (const k of Object.values(BOOST_KEYS)) expect(taken).not.toContain(k);
    expect(new Set(Object.values(BOOST_KEYS)).size).toBe(4);
  });

  it('tuning stays modest: short effects, long cooldowns, a magnet no stronger than the map one', () => {
    expect(BOOST_RULES.magnet.durationMs).toBeLessThanOrEqual(RULES.magnetMs);
    expect(BOOST_RULES.speed.durationMs).toBeLessThan(RULES.pumpMs);
    for (const k of BOOST_KINDS) expect(BOOST_RULES[k].cooldownMs).toBeGreaterThanOrEqual(10_000);
    expect(BOOST_RULES.invis.durationMs).toBe(10_000);
    expect(BOOST_RULES.invis.cooldownMs).toBeGreaterThan(BOOST_RULES.invis.durationMs);
  });

  it('a leap is about 5 starting-coin widths for a small coin, more for a big one, and capped', () => {
    const start = Math.sqrt(RULES.startMass) * 10;
    expect(leapDistance(start) / (start * 2)).toBeGreaterThan(4.5);
    expect(leapDistance(start) / (start * 2)).toBeLessThan(6);
    expect(leapDistance(300)).toBeGreaterThan(leapDistance(start));
    expect(leapDistance(5000)).toBe(BOOST_RULES.leap.max);
    expect(BOOST_RULES.leap.max / (start * 2)).toBeLessThan(10.5);
  });

  it('saved charges of the retired Shockwave become Leap charges 1:1', () => {
    expect(migrateBoostCounts({ magnet: 2, shock: 3, speed: 1 })).toEqual({ magnet: 2, leap: 3, speed: 1, invis: 0 });
    expect(migrateBoostCounts({ shock: 2, leap: 1 })).toMatchObject({ leap: 3 });
    expect(migrateBoostCounts({ magnet: -1, speed: 1.7, laser: 4, invis: 'x' })).toEqual({ magnet: 0, leap: 0, speed: 1, invis: 0 });
    expect(migrateBoostCounts(null)).toEqual({ magnet: 0, leap: 0, speed: 0, invis: 0 });
  });

  it('pack prices in base units, with the holder discount rounded down', () => {
    expect(packPriceRaw('300', 18, 0)).toBe(300n * 10n ** 18n);
    expect(packPriceRaw('300', 18, 30)).toBe(210n * 10n ** 18n);
    expect(packPriceRaw('0.000001', 6, 30)).toBe(0n);
    expect(packPriceRaw('12.5', 6, 0)).toBe(12_500_000n);
    expect(() => packPriceRaw('abc', 18, 0)).toThrow();
    expect(SHOP_DEFAULTS).toMatchObject({ packSize: 3, holderDiscountPct: 30, arenaUsesPerRound: 2, holderExtraArenaUses: 1 });
    // payments go to the arena contract (`pay`): there is no sink setting any more
    expect('sink' in SHOP_DEFAULTS).toBe(false);
    expect(SHOP_DEFAULTS.prices).toEqual({ magnet: '600', leap: '900', speed: '600', invis: '1200' });
    expect(Object.values(SHOP_DEFAULTS.kinds).every(Boolean)).toBe(true);
  });
});
