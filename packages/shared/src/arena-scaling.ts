/**
 * Auto-scaling of the official arena instances (`arena-<id>-<n>`): per arena (each ticket tier) the server watches
 * demand and opens another instance of the same arena when the open ones keep filling up, and consolidates (one
 * instance stops taking new seats and closes once its bell settled it) when they stay mostly empty. Nobody is ever
 * evicted and no ticket is ever dropped: a draining instance keeps playing its round, its tickets settle at the bell
 * like everywhere else, and it closes only when nothing of value is left in it.
 *
 * Scale up (any of):
 *  - an instance reached its capacity `fullHits` times within `windowMin` minutes while the arena was busy (at least
 *    `highPct` % of its open seats taken; a seat that finds every instance full counts too);
 *  - the arena's open instances were at least `highPct` % full for `sustainMin` minutes without a break.
 * Scale down: the arena's peak fill over the last `lowMin` minutes stayed under `lowPct` %, and one instance fewer
 * would still hold that peak at under `highPct` % (so the consolidation never triggers a scale-up right after).
 * Each arena acts at most once per `cooldownMin` minutes; `lowPct < highPct` (the gap is the hysteresis).
 *
 * Seating fills the fullest open instance that is not full first (rooms stay lively); a draining instance takes
 * no new seat (a live ticket still comes back to its own coin there). When every open instance is full a seat
 * re-opens a draining instance first, then opens a new one; at `maxInstances` a bought ticket still gets a seat
 * (an overflow instance, logged): a paid ticket is never left without a room.
 */
export interface ArenaScalingSettings {
  /** Off: no instance is opened ahead of demand; only full instances overflow, and empty extra instances close. */
  enabled: boolean;
  /** Instances every arena keeps open (from instance #1). */
  minInstances: number;
  /** Most instances the scaler opens per arena (an overflow seat may exceed it, see above). */
  maxInstances: number;
  /** Scale up after this many "an instance reached capacity" events… */
  fullHits: number;
  /** …within this many minutes. */
  windowMin: number;
  /** Scale up when the open instances stay at least this full (percent of their seats)… */
  highPct: number;
  /** …for this many minutes. */
  sustainMin: number;
  /** Scale down when the peak fill stays under this (percent)… */
  lowPct: number;
  /** …for this many minutes. */
  lowMin: number;
  /** At most one scaling action per arena this often (minutes). */
  cooldownMin: number;
}

export const ARENA_SCALING_DEFAULT: ArenaScalingSettings = {
  enabled: true,
  minInstances: 1,
  maxInstances: 30,
  fullHits: 3,
  windowMin: 10,
  highPct: 80,
  sustainMin: 2,
  lowPct: 35,
  lowMin: 10,
  cooldownMin: 3,
};

/** Bounds of the admin values (whole numbers). */
export const ARENA_SCALING_LIMITS: Record<Exclude<keyof ArenaScalingSettings, 'enabled'>, readonly [number, number]> = {
  minInstances: [1, 10],
  maxInstances: [1, 40],
  fullHits: [1, 50],
  windowMin: [1, 120],
  highPct: [10, 100],
  sustainMin: [1, 60],
  lowPct: [0, 90],
  lowMin: [1, 240],
  cooldownMin: [0, 60],
};

/**
 * Merges an admin patch into `cur`. Returns the settings, or `{ field, message }` for the first bad field. With
 * `strict` (an admin request) unknown fields are refused; without it (a saved file) bad and unknown fields are
 * skipped. The merged settings must keep `minInstances <= maxInstances` and `lowPct < highPct`.
 */
export function applyArenaScaling(
  cur: ArenaScalingSettings,
  body: Record<string, unknown>,
  strict = true,
): { ok: true; settings: ArenaScalingSettings } | { ok: false; field: string; message: string } {
  const next = { ...cur };
  for (const [k, v] of Object.entries(body)) {
    if (k === 'enabled') {
      if (typeof v === 'boolean') next.enabled = v;
      else if (strict) return { ok: false, field: k, message: 'enabled must be true or false' };
      continue;
    }
    const range = Object.hasOwn(ARENA_SCALING_LIMITS, k) ? ARENA_SCALING_LIMITS[k as keyof typeof ARENA_SCALING_LIMITS] : undefined;
    if (!range) {
      if (strict) return { ok: false, field: k, message: `unknown field ${k}` };
      continue;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < range[0] || v > range[1]) {
      if (strict) return { ok: false, field: k, message: `${k} must be a whole number from ${range[0]} to ${range[1]}` };
      continue;
    }
    next[k as keyof typeof ARENA_SCALING_LIMITS] = v;
  }
  if (next.minInstances > next.maxInstances) {
    if (strict) return { ok: false, field: 'minInstances', message: 'minInstances must be at most maxInstances' };
    next.minInstances = next.maxInstances;
  }
  if (next.lowPct >= next.highPct) {
    if (strict) return { ok: false, field: 'lowPct', message: 'lowPct must be below highPct (the gap keeps instances from flapping)' };
    next.lowPct = Math.max(0, next.highPct - 1);
  }
  return { ok: true, settings: next };
}

/** What the scaler did (`ArenaScalingView.log`, newest first). */
export interface ArenaScalingDecision {
  at: number;
  arenaId: number;
  /**
   * `open`: a new instance ahead of demand; `overflow`: a seat found every instance full; `drain`: an instance stops
   * taking seats; `undrain`: a draining instance takes seats again; `close`: a drained (or idle) instance closed.
   */
  action: 'open' | 'overflow' | 'drain' | 'undrain' | 'close';
  room: string;
  reason: string;
  /** People in the arena's public instances at that moment, and its instances taking seats after the action. */
  people: number;
  instances: number;
}

/** One public instance of an arena (`ArenaScalingView.arenas`). */
export interface ArenaInstanceView {
  id: string;
  instance: number;
  people: number;
  capacity: number;
  /** Takes no new seats; closes once its bell settled it. */
  draining: boolean;
  /** Room worker (`w1`..; absent: the main thread). */
  thread?: string;
}

export interface ArenaScalingArenaView {
  arenaId: number;
  name: string;
  instances: ArenaInstanceView[];
  /** People in the instances taking seats / their seats, percent. */
  fillPct: number;
  /** Capacity events counted in the current window. */
  fullHits: number;
  /** The last action (Unix ms), if any. */
  lastActionAt: number | null;
}

/** `GET` / `PUT /api/admin/arena-scaling`. */
export interface ArenaScalingView {
  settings: ArenaScalingSettings;
  defaults: ArenaScalingSettings;
  limits: typeof ARENA_SCALING_LIMITS;
  arenas: ArenaScalingArenaView[];
  log: ArenaScalingDecision[];
}
