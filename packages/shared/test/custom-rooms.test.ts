import { describe, expect, it } from 'vitest';
import {
  CUSTOM_CAPACITY_STEPS,
  CUSTOM_DEFAULTS,
  CUSTOM_MAP_SIZES,
  CUSTOM_MAP_WIDTH,
  CUSTOM_SETTINGS_DEFAULT,
  CUSTOM_TRAPS,
  CUSTOM_TRAP_MUL,
  customCapacityChoices,
  customCapacityTiers,
  customRoomFee,
  customRoomPrice,
  customUsesFreeRoom,
  inviteUrl,
  joinTargetArena,
  paidRoomTarget,
  parseInviteCode,
  parseJoinTarget,
  quotePrice,
  validateCustomConfig,
} from '../src';

const ok = (o: Record<string, unknown> = {}) => validateCustomConfig({ ...CUSTOM_DEFAULTS, name: 'Friday Pond', ...o });

describe('custom room config', () => {
  it('accepts the defaults with a name and trims it', () => {
    const v = ok({ name: '  Friday   Pond ' });
    expect(v).toEqual({ ok: true, config: { ...CUSTOM_DEFAULTS, name: 'Friday Pond' } });
  });

  it('refuses every out-of-range choice, naming the field', () => {
    expect(ok({ name: 'x' })).toMatchObject({ ok: false, field: 'name' });
    expect(ok({ name: 'a'.repeat(25) })).toMatchObject({ ok: false, field: 'name' });
    expect(ok({ name: '<script>' })).toMatchObject({ ok: false, field: 'name' });
    expect(ok({ durationMin: 45 })).toMatchObject({ ok: false, field: 'durationMin' });
    expect(ok({ mapSize: 'XXL' })).toMatchObject({ ok: false, field: 'mapSize' });
    expect(ok({ mapSize: 5000 })).toMatchObject({ ok: false, field: 'mapSize' });
    expect(ok({ traps: 'lots' })).toMatchObject({ ok: false, field: 'traps' });
    expect(ok({ difficulty: 'insane' })).toMatchObject({ ok: false, field: 'difficulty' });
    expect(ok({ food: 'none' })).toMatchObject({ ok: false, field: 'food' });
    expect(ok({ bots: 13 })).toMatchObject({ ok: false, field: 'bots' });
    expect(ok({ bots: 1.5 })).toMatchObject({ ok: false, field: 'bots' });
    expect(ok({ maxPlayers: 1 })).toMatchObject({ ok: false, field: 'maxPlayers' });
    expect(ok({ maxPlayers: 101 })).toMatchObject({ ok: false, field: 'maxPlayers' });
    expect(ok({ maxPlayers: 20.5 })).toMatchObject({ ok: false, field: 'maxPlayers' });
    expect(ok({ kind: 'staked' })).toMatchObject({ ok: false, field: 'kind' });
    expect(ok({ kind: 'paid' })).toMatchObject({ ok: false, field: 'arenaId' });
    expect(ok({ kind: 'paid', arenaId: 0 })).toMatchObject({ ok: false, field: 'arenaId' });
    expect(ok({ kind: 'paid', arenaId: '2' })).toMatchObject({ ok: false, field: 'arenaId' });
    expect(ok({ kind: 'free', arenaId: 2 })).toMatchObject({ ok: false, field: 'arenaId' });
    expect(ok({ powerUps: 'yes' })).toMatchObject({ ok: false, field: 'powerUps' });
    expect(validateCustomConfig(null)).toMatchObject({ ok: false, field: 'config' });
  });

  it('capacity from 2 to 100; a free room by default, a paid room names its arena tier', () => {
    expect(ok({ maxPlayers: 2 })).toMatchObject({ ok: true, config: { maxPlayers: 2 } });
    expect(ok({ maxPlayers: 100 })).toMatchObject({ ok: true, config: { maxPlayers: 100 } });
    expect(ok({ maxPlayers: 37 })).toMatchObject({ ok: true, config: { maxPlayers: 37 } });
    expect(ok()).toMatchObject({ ok: true, config: { kind: 'free', arenaId: null } });
    expect(ok({ kind: 'paid', arenaId: 3 })).toMatchObject({ ok: true, config: { kind: 'paid', arenaId: 3 } });
    // rooms stored before kinds existed read as free rooms
    const { kind: _k, arenaId: _a, ...old } = CUSTOM_DEFAULTS;
    expect(validateCustomConfig({ ...old, name: 'Old Pond' })).toMatchObject({ ok: true, config: { kind: 'free', arenaId: null } });
    expect(CUSTOM_CAPACITY_STEPS[0]).toBe(2);
    expect(CUSTOM_CAPACITY_STEPS.at(-1)).toBe(100);
    expect(customCapacityChoices(50).at(-1)).toBe(50);
    expect(customCapacityChoices(36).at(-1)).toBe(36);
    expect(customCapacityChoices(36)).toContain(30);
  });

  it('food, traps and power-ups are optional (normal, normal, on)', () => {
    const { food: _f, powerUps: _p, traps: _t, ...rest } = CUSTOM_DEFAULTS;
    expect(validateCustomConfig({ ...rest, name: 'Pond' })).toMatchObject({ ok: true, config: { food: 'normal', traps: 'normal', powerUps: true } });
  });

  it('five map sizes from 3,000 to 9,000 units, smallest first; four trap levels', () => {
    expect(CUSTOM_MAP_SIZES).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    const widths = CUSTOM_MAP_SIZES.map((m) => CUSTOM_MAP_WIDTH[m]);
    expect(widths[0]).toBe(3000);
    expect(widths.at(-1)).toBe(9000);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    for (const m of CUSTOM_MAP_SIZES) expect(ok({ mapSize: m })).toMatchObject({ ok: true, config: { mapSize: m } });
    for (const tr of CUSTOM_TRAPS) expect(ok({ traps: tr })).toMatchObject({ ok: true, config: { traps: tr } });
    expect(CUSTOM_TRAP_MUL.none).toBe(0);
  });
});

describe('invites', () => {
  it('parses codes in any case and builds the share link; the code is a private-room join target', () => {
    expect(parseInviteCode(' ab2cd ')).toBe('AB2CD');
    expect(parseInviteCode('AB0CD')).toBeNull(); // no 0 / O / 1 / I in codes
    expect(parseInviteCode('ABCDEF')).toBeNull();
    expect(parseInviteCode(null)).toBeNull();
    expect(inviteUrl('https://elymum.io/', 'AB2CD')).toBe('https://elymum.io/play?room=AB2CD');
    expect(parseJoinTarget('private:AB2CD')).toEqual({ mode: 'private', code: 'AB2CD' });
  });

  it('a paid room is joined with a ticket of its arena: arena:<id>:<CODE>', () => {
    expect(paidRoomTarget(2, 'AB2CD')).toBe('arena:2:AB2CD');
    expect(parseJoinTarget('arena:2:AB2CD')).toEqual({ mode: 'arena', arenaId: 2, code: 'AB2CD' });
    expect(parseJoinTarget('arena:2:ab2cd')).toEqual({ mode: 'arena', arenaId: 2, code: 'AB2CD' });
    expect(parseJoinTarget('arena:2')).toEqual({ mode: 'arena', arenaId: 2 });
    for (const bad of ['arena:2:', 'arena:2:AB2C', 'arena:2:AB2CDE', 'arena::AB2CD', 'arena:2:AB-CD']) expect(parseJoinTarget(bad), bad).toBeNull();
    expect(joinTargetArena('arena:4:AB2CD')).toBe(4);
    expect(joinTargetArena('arena:4')).toBe(4);
    expect(joinTargetArena('private:AB2CD')).toBeNull();
  });
});

describe('room fee by capacity', () => {
  const base = 5n * 10n ** 16n;
  it('the base for up to 10 players, +50 % of the base for every started 10 above', () => {
    expect([1, 2, 10, 11, 20, 21, 30, 31, 50, 99, 100].map(customCapacityTiers)).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 5, 10, 10]);
    expect(customRoomFee(base, 2, 50)).toBe(base);
    expect(customRoomFee(base, 10, 50)).toBe(base);
    expect(customRoomFee(base, 11, 50)).toBe((base * 3n) / 2n);
    expect(customRoomFee(base, 20, 50)).toBe((base * 3n) / 2n);
    expect(customRoomFee(base, 21, 50)).toBe(base * 2n);
    expect(customRoomFee(base, 30, 50)).toBe(base * 2n);
    expect(customRoomFee(base, 31, 50)).toBe((base * 5n) / 2n);
    expect(customRoomFee(base, 100, 50)).toBe((base * 11n) / 2n);
    // fee = base * (1 + 0.5 * (ceil(cap / 10) - 1)) for every capacity
    for (let cap = 2; cap <= 100; cap++) {
      const tiers = Math.ceil(cap / 10);
      expect(customRoomFee(base, cap, 50), String(cap)).toBe((base * BigInt(2 + (tiers - 1))) / 2n);
    }
  });
  it('the step percent is the admin setting: 0 keeps one price, 100 doubles per tier', () => {
    expect(customRoomFee(base, 100, 0)).toBe(base);
    expect(customRoomFee(base, 25, 100)).toBe(base * 3n);
    expect(customRoomFee(1n, 11, 50)).toBe(1n); // rounded down to the wei
  });
  it('the live price of a quote applies the fee, then the holder perk', () => {
    const q = { priceWei: base.toString(), capacityStepPct: 50, holderPerk: 'discount' as const, holderDiscountPct: 50, holder: false, freeAvailable: false };
    expect(quotePrice(q, 10)).toBe(base);
    expect(quotePrice(q, 40)).toBe((base * 5n) / 2n);
    expect(quotePrice({ ...q, holder: true }, 40)).toBe((base * 5n) / 4n);
    // the holders' free room of the day covers the base size only
    const daily = { ...q, holderPerk: 'free_daily' as const, holder: true, freeAvailable: true };
    expect(quotePrice(daily, 10)).toBe(0n);
    expect(quotePrice(daily, 11)).toBe((base * 3n) / 2n);
    expect(customUsesFreeRoom(daily, true, true, 10)).toBe(true);
    expect(customUsesFreeRoom(daily, true, true, 12)).toBe(false);
  });
});

describe('room price', () => {
  const price = 5n * 10n ** 16n;
  it('holders get the perk the admin picked', () => {
    const s = CUSTOM_SETTINGS_DEFAULT;
    expect(customRoomPrice(price, s, false, false)).toBe(price);
    expect(customRoomPrice(price, s, true, false)).toBe(price / 2n);
    expect(customRoomPrice(price, { ...s, holderDiscountPct: 100 }, true, false)).toBe(0n);
    expect(customRoomPrice(price, { ...s, holderPerk: 'free_daily' }, true, true)).toBe(0n);
    expect(customRoomPrice(price, { ...s, holderPerk: 'free_daily' }, true, false)).toBe(price);
    expect(customRoomPrice(price, { ...s, holderPerk: 'none' }, true, true)).toBe(price);
  });
  it('defaults: 0.05 HYPE, a 50 % holder discount, 6 live rooms, 2 per wallet, +50 % per 10 players, rooms up to 50, 200 seats', () => {
    expect(CUSTOM_SETTINGS_DEFAULT).toMatchObject({ priceHype: '0.05', holderPerk: 'discount', holderDiscountPct: 50, maxLive: 6, maxPerWallet: 2, treasury: null });
    expect(CUSTOM_SETTINGS_DEFAULT).toMatchObject({ capacityStepPct: 50, maxPlayers: 50, maxSeats: 200, paidRooms: true });
  });
});
