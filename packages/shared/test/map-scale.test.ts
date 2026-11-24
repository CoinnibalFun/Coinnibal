import { describe, expect, it } from 'vitest';
import {
  CUSTOM_MAP_SIZES,
  CUSTOM_MAP_WIDTH,
  FOOD_PER_AREA,
  MAP_SCALE_DEFAULT,
  MAP_SCALE_LIMITS,
  MAP_SPACE,
  MAP_WORLD_CAPS,
  MAP_SCALE_FIELDS,
  MAP_SIDE_STEP,
  VIRUS_PER_AREA,
  WORLD_PRESETS,
  mapScaleFieldError,
  mapSideFor,
  validateCustomConfig,
  worldForSide,
} from '../src';

describe('dynamic map size: base + per person, at most max', () => {
  it('gives the documented sides for 0 / 1 / 25 / 40 / 50 / 100 / 400 people', () => {
    expect(MAP_SCALE_DEFAULT).toEqual({ auto: true, base: 8000, perPlayer: 80, max: 12_000 });
    expect([0, 1, 25, 40, 50, 100, 400].map((n) => mapSideFor(n, MAP_SCALE_DEFAULT))).toEqual([8000, 8080, 10_000, 11_200, 12_000, 12_000, 12_000]);
  });

  it('keeps every default side within the population caps: a full arena instance (50) still has food for everyone', () => {
    const full = worldForSide(mapSideFor(50, MAP_SCALE_DEFAULT));
    expect(full.foodTarget).toBe(MAP_WORLD_CAPS.food);
    expect(full.foodTarget / 50).toBeGreaterThanOrEqual(70);
    expect(full.virusTarget).toBe(MAP_WORLD_CAPS.viruses);
    expect(full.maxPowerUps).toBe(MAP_WORLD_CAPS.powerUps);
    // food per person never falls below what the former default (40 a person) gave a full instance at 10000
    for (let n = 1; n <= 50; n++) expect(worldForSide(mapSideFor(n, MAP_SCALE_DEFAULT)).foodTarget / n).toBeGreaterThanOrEqual(worldForSide(10_000).foodTarget / 50);
  });

  it('grows with every person (until max), is monotonic, stepped, and never leaves the coordinate space', () => {
    let last = 0;
    for (let n = 0; n <= 400; n++) {
      const s = mapSideFor(n, MAP_SCALE_DEFAULT);
      if (s < MAP_SCALE_DEFAULT.max) expect(s).toBeGreaterThan(last);
      else expect(s).toBeGreaterThanOrEqual(last);
      expect(s).toBeGreaterThanOrEqual(MAP_SCALE_DEFAULT.base);
      expect(s).toBeLessThanOrEqual(MAP_SCALE_DEFAULT.max);
      expect(s % MAP_SIDE_STEP).toBe(0);
      last = s;
    }
    expect(mapSideFor(1000, { base: 2000, perPlayer: 300, max: 99_999 })).toBe(MAP_SPACE);
    // a base above the max never shrinks the room below its base
    expect(mapSideFor(1, { base: 8000, perPlayer: 40, max: 5000 })).toBe(8000);
    // no growth: a fixed side
    expect(mapSideFor(77, { base: 6000, perPlayer: 0, max: 12_000 })).toBe(6000);
    expect(mapSideFor(Number.NaN, MAP_SCALE_DEFAULT)).toBe(8000);
    expect(mapSideFor(-5, MAP_SCALE_DEFAULT)).toBe(8000);
  });

  it('fits the coordinate space and the admin limits; the custom sizes (XS..XL) are fixed choices below the base', () => {
    expect(MAP_SCALE_DEFAULT.max).toBeLessThanOrEqual(MAP_SPACE);
    expect(MAP_SCALE_DEFAULT.max).toBeLessThanOrEqual(MAP_SCALE_LIMITS.sideMax);
    expect(MAP_SCALE_DEFAULT.perPlayer).toBeLessThanOrEqual(MAP_SCALE_LIMITS.perPlayerMax);
    expect(MAP_SCALE_FIELDS).toEqual(['auto', 'base', 'perPlayer', 'max']);
    expect(CUSTOM_MAP_WIDTH.XL).toBeLessThanOrEqual(MAP_SCALE_DEFAULT.base + MAP_SCALE_DEFAULT.perPlayer * 25);
  });

  it('a 10000..12000 room stays populated: food at pond density (capped), cacti and power-ups', () => {
    const at10 = worldForSide(10_000);
    expect(at10.foodTarget).toBe(Math.round(1e8 * FOOD_PER_AREA));
    expect(at10.foodTarget).toBeGreaterThan(3000);
    expect(at10.virusTarget).toBeGreaterThanOrEqual(25);
    expect(at10.maxPowerUps).toBe(MAP_WORLD_CAPS.powerUps);
    // 12000: the food cap holds (the server is small)
    expect(worldForSide(12_000).foodTarget).toBe(MAP_WORLD_CAPS.food);
  });
});

describe('population of a world of a given side', () => {
  it('matches a practice pond at its size and scales food and cacti with the area', () => {
    const pond = WORLD_PRESETS.practice;
    expect(worldForSide(pond.width)).toEqual(pond);
    const small = worldForSide(3000);
    const big = worldForSide(9000);
    expect(small.foodTarget).toBe(Math.round(9e6 * FOOD_PER_AREA));
    expect(big.foodTarget).toBe(Math.round(81e6 * FOOD_PER_AREA));
    // 9x the area: 9x the food (within rounding)
    expect(big.foodTarget / small.foodTarget).toBeCloseTo(9, 1);
    expect(big.virusTarget).toBe(Math.round(81e6 * VIRUS_PER_AREA));
    expect(small.virusTarget).toBeGreaterThanOrEqual(2);
    expect(small.maxPowerUps).toBe(1);
    expect(big.maxPowerUps).toBe(5);
  });

  it('caps food and cacti for the small server, and grows no cacti at 0', () => {
    const huge = worldForSide(MAP_SPACE, { foodMul: 2, virusMul: 3 });
    expect(huge.foodTarget).toBe(MAP_WORLD_CAPS.food);
    expect(huge.virusTarget).toBe(MAP_WORLD_CAPS.viruses);
    expect(worldForSide(5000, { virusMul: 0 }).virusTarget).toBe(0);
  });
});

describe('admin field checks and the custom "auto" choice', () => {
  it('checks every map field', () => {
    expect(mapScaleFieldError('auto', true)).toBeNull();
    expect(mapScaleFieldError('auto', 'yes')).toMatch(/true or false/);
    expect(mapScaleFieldError('perPlayer', 40)).toBeNull();
    expect(mapScaleFieldError('perPlayer', 0)).toBeNull();
    expect(mapScaleFieldError('perPlayer', MAP_SCALE_LIMITS.perPlayerMax + 1)).toMatch(/0 to 300/);
    expect(mapScaleFieldError('base', 2500.5)).toMatch(/whole number/);
    expect(mapScaleFieldError('base', 1999)).toMatch(/2000 to 12000/);
    expect(mapScaleFieldError('max', MAP_SPACE)).toBeNull();
    expect(mapScaleFieldError('max', MAP_SPACE + 1)).not.toBeNull();
  });

  it('accepts auto (the default) and every fixed size', async () => {
    const { CUSTOM_DEFAULTS, CUSTOM_MAP_CHOICES } = await import('../src');
    expect(CUSTOM_DEFAULTS.mapSize).toBe('auto');
    expect(CUSTOM_MAP_CHOICES).toEqual(['auto', ...CUSTOM_MAP_SIZES]);
    const v = validateCustomConfig({ ...CUSTOM_DEFAULTS, name: 'Auto pond' });
    expect(v).toMatchObject({ ok: true, config: { mapSize: 'auto' } });
    expect(validateCustomConfig({ ...CUSTOM_DEFAULTS, name: 'Fixed', mapSize: 'L' })).toMatchObject({ ok: true, config: { mapSize: 'L' } });
  });
});
