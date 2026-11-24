import { WORLD_PRESETS } from './constants';
import { clamp } from './formulas';

/**
 * Dynamic map size: every room's square world grows a little with every person in it (and every practice bot
 * of a free custom room), and shrinks back as they leave, only when that is safe.
 *
 *   side(n) = min(max, base + perPlayer * n), rounded up to `MAP_SIDE_STEP`; never below `base`
 *
 * `base` is the side of an empty room (and the smallest side), `perPlayer` the side each person adds, `max` the
 * largest side. Food, rug cacti and power-ups follow the area at a practice pond's density (`worldForSide`, food
 * capped by `MAP_WORLD_CAPS`).
 *
 * Defaults (2026-11 owner: maps stay roomy and grow with every person): base 8000, 80 per person, max 12000.
 * 1 person 8080, 25 people 10000, 40 (a full pond) 11200, 50 (a full arena instance) and more 12000. The sides stay
 * within 8000..12000 as before, so the population caps (`MAP_WORLD_CAPS`) are unchanged: a 12000 room holds 4000
 * food (the cap; about 80 a person at 50), 40 cacti and 6 power-up slots. A server whose admin saved map sizes
 * (`DATA_DIR/site/maps.json`) keeps them.
 * The custom room sizes XS..XL (3000..9000) are chosen sizes and do not follow the model.
 *
 * When the side changes (`Room`): it grows during play by at most `MAP_GROW.maxStep` every `MAP_GROW.stepMs`.
 * An arena (a public instance or a ticket room) never shrinks during a round: it takes its new, possibly smaller,
 * size at the round start, right after the bell settled every coin. A room without rounds shrinks step by step
 * and only over empty floor (no person's coin near the band that goes), so nobody is ever trapped by the wall.
 */
export interface MapScaleSettings {
  /** The world follows the people in the room (off: the room keeps its mode's fixed preset). */
  auto: boolean;
  /** Side (world units) of an empty room, and the smallest side. */
  base: number;
  /** Side (world units) each person adds. */
  perPlayer: number;
  /** Largest side (world units, at most `MAP_SPACE`). */
  max: number;
}

/** The admin-tunable fields of `MapScaleSettings`, in the order the admin page shows them. */
export const MAP_SCALE_FIELDS = ['auto', 'base', 'perPlayer', 'max'] as const;

/**
 * Coordinate space (square, world units) of a resizable world: the playable square sits centred
 * inside it and grows outward on every side. The spatial grids are sized for the whole space once,
 * so a resize never rebuckets anything. Also the hard upper bound of `MapScaleSettings.max`.
 */
export const MAP_SPACE = 12_000;

/** Sides are rounded up to a multiple of this (several steps a person at the default growth). */
export const MAP_SIDE_STEP = 10;

/** Bounds of the admin values. */
export const MAP_SCALE_LIMITS = { perPlayerMin: 0, perPlayerMax: 300, sideMin: 2000, sideMax: MAP_SPACE } as const;

export const MAP_SCALE_DEFAULT: MapScaleSettings = { auto: true, base: 8000, perPlayer: 80, max: 12_000 };

/**
 * Pacing of growth during play: the room re-checks its expected count every `checkMs`, and grows by
 * at most `maxStep` (whole side) at most every `stepMs`, so a burst of joins opens the floor in a few
 * gentle steps rather than one jump. Clients ease the border over `animMs`.
 */
export const MAP_GROW = { checkMs: 1000, stepMs: 4000, maxStep: 600, animMs: 1500 } as const;

/** Upper bounds of an auto-sized world's food and cacti, whatever the size (the server is small). */
export const MAP_WORLD_CAPS = { food: 4000, viruses: 40, powerUps: 6 } as const;

/** The world side for `players` expected players (people plus a free custom room's practice bots). */
export function mapSideFor(players: number, s: Pick<MapScaleSettings, 'base' | 'perPlayer' | 'max'>): number {
  const n = Math.max(0, Number.isFinite(players) ? Math.floor(players) : 0);
  const hi = Math.min(MAP_SPACE, Math.max(s.base, s.max));
  const stepped = Math.ceil((s.base + s.perPlayer * n) / MAP_SIDE_STEP) * MAP_SIDE_STEP;
  return clamp(stepped, Math.min(s.base, hi), hi);
}

/** A practice pond's food and cacti per square unit (the density every auto-sized world keeps). */
const REF = WORLD_PRESETS.practice;
export const FOOD_PER_AREA = REF.foodTarget / (REF.width * REF.height);
export const VIRUS_PER_AREA = REF.virusTarget / (REF.width * REF.height);
/** One power-up slot per this much area (a pond 3, an arena 4). */
const AREA_PER_POWERUP = 16_000_000;

/** A world's size and population targets (`WORLD_PRESETS` shape). */
export interface WorldShape {
  width: number;
  height: number;
  foodTarget: number;
  virusTarget: number;
  maxPowerUps: number;
}

/**
 * The population of a square world of `side`: food and cacti at a practice pond's density (times
 * `foodMul` / `virusMul`), capped by `MAP_WORLD_CAPS`; power-ups one per 16 M square units (1..6).
 * A `virusMul` of 0 grows no cacti; otherwise at least 2.
 */
export function worldForSide(side: number, o: { foodMul?: number; virusMul?: number; caps?: { food: number; viruses: number } } = {}): WorldShape {
  const area = side * side;
  const caps = o.caps ?? MAP_WORLD_CAPS;
  const vm = o.virusMul ?? 1;
  return {
    width: side,
    height: side,
    foodTarget: Math.min(caps.food, Math.round(area * FOOD_PER_AREA * (o.foodMul ?? 1))),
    virusTarget: vm <= 0 ? 0 : Math.min(caps.viruses, Math.max(2, Math.round(area * VIRUS_PER_AREA * vm))),
    maxPowerUps: clamp(Math.round(area / AREA_PER_POWERUP), 1, MAP_WORLD_CAPS.powerUps),
  };
}

/** Checks one field of an admin patch; returns an error message or null. */
export function mapScaleFieldError(field: keyof MapScaleSettings, v: unknown): string | null {
  if (field === 'auto') return typeof v === 'boolean' ? null : 'must be true or false';
  const [lo, hi] = field === 'perPlayer' ? [MAP_SCALE_LIMITS.perPlayerMin, MAP_SCALE_LIMITS.perPlayerMax] : [MAP_SCALE_LIMITS.sideMin, MAP_SCALE_LIMITS.sideMax];
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? null : `must be a whole number from ${lo} to ${hi}`;
}
