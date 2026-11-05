import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAP_SCALE_DEFAULT, MAP_SCALE_FIELDS, mapScaleFieldError, type League, type MapScaleSettings, type RoomMode } from '@elymum/shared';

/**
 * The admin's dynamic map settings per room kind (`/api/admin/maps`, `DATA_DIR/site/maps.json`): on/off, `base`,
 * `perPlayer` and `max` of `map-scale.ts`. Custom rooms whose creator picked "Auto" follow the `private` settings
 * (always on); a chosen size is kept.
 *
 * Migration: these settings used to live in `site/bots.json` next to the house-bot settings (both are gone with
 * the house bots). When `maps.json` does not exist yet, the `maps` of an old `bots.json` are read once and written
 * to `maps.json`; every other field of that file (and any unknown field) is ignored. A kind saved in the former
 * square-root model (`perPlayer · √n` within `min..max`) keeps its `auto` and takes the new defaults.
 */

export const MAP_ROOM_KINDS = ['practiceRookie', 'practicePro', 'arena', 'private'] as const;
export type MapRoomKind = (typeof MAP_ROOM_KINDS)[number];

export type MapSettings = Record<MapRoomKind, MapScaleSettings>;

/** The map kind of a room. */
export function mapKindOf(mode: RoomMode, league?: League): MapRoomKind {
  if (mode === 'arena') return 'arena';
  if (mode === 'private') return 'private';
  return league === 'pro' ? 'practicePro' : 'practiceRookie';
}

/** Every kind on the default curve (auto on). */
export function defaultMapSettings(): MapSettings {
  const out = {} as MapSettings;
  for (const k of MAP_ROOM_KINDS) out[k] = { ...MAP_SCALE_DEFAULT };
  return out;
}

/** A bad admin value: `field` names it (`arena.perPlayer`, ...). */
export class MapSettingsError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Applies a partial update to `cur`: `{ <kind>: { auto?, perPlayer?, min?, max? } }`. With `strict` (an admin
 * request) unknown kinds or fields are refused; without it (a saved file) they are ignored. `min` never exceeds
 * `max` after the merge.
 */
export function applyMapSettings(cur: MapSettings, body: Record<string, unknown>, opts: { strict?: boolean } = {}): MapSettings {
  const strict = opts.strict !== false;
  const next = structuredClone(cur);
  for (const key of Object.keys(body)) {
    if (!(MAP_ROOM_KINDS as readonly string[]).includes(key)) {
      if (strict) throw new MapSettingsError(`unknown room kind ${key}`, key);
      continue;
    }
    const kind = key as MapRoomKind;
    const patch = body[kind];
    if (!isObj(patch)) {
      if (strict) throw new MapSettingsError(`${kind} must be an object`, kind);
      continue;
    }
    const m = next[kind];
    for (const [f, v] of Object.entries(patch)) {
      if (!(MAP_SCALE_FIELDS as readonly string[]).includes(f)) {
        if (strict) throw new MapSettingsError(`unknown field ${kind}.${f}`, `${kind}.${f}`);
        continue;
      }
      const err = mapScaleFieldError(f as keyof MapScaleSettings, v);
      if (err) {
        if (strict) throw new MapSettingsError(`${kind}.${f} ${err}`, `${kind}.${f}`);
        continue;
      }
      (m as unknown as Record<string, unknown>)[f] = v;
    }
    if (m.base > m.max) m.base = m.max;
  }
  return next;
}

export const MAP_SETTINGS_FILE = join('site', 'maps.json');
/** Where the map settings lived before (with the retired house-bot settings). */
export const LEGACY_BOT_SETTINGS_FILE = join('site', 'bots.json');

/** Persisted map settings, applied live: every `update` notifies the listeners (the room manager re-applies them). */
export class MapSettingsStore {
  private cur: MapSettings = defaultMapSettings();
  private readonly listeners: ((s: MapSettings) => void)[] = [];

  constructor(
    private readonly dataDir: string | null,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.load();
  }

  private file(name: string): string | null {
    return this.dataDir ? join(this.dataDir, name) : null;
  }

  private load(): void {
    const p = this.file(MAP_SETTINGS_FILE);
    if (!p) return;
    if (existsSync(p)) {
      this.cur = this.read(p, (raw) => raw);
      return;
    }
    const legacy = this.file(LEGACY_BOT_SETTINGS_FILE);
    if (legacy && existsSync(legacy)) {
      this.cur = this.read(legacy, (raw) => (isObj(raw.maps) ? raw.maps : {}));
      this.save();
      this.log(`maps: settings taken over from ${LEGACY_BOT_SETTINGS_FILE} (its bot settings are retired and ignored)`);
    }
  }

  private read(path: string, pick: (raw: Record<string, unknown>) => Record<string, unknown>): MapSettings {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isObj(raw)) throw new Error('not an object');
      const maps = pick(raw);
      // a kind saved in the former square-root model (`min` instead of `base`) keeps its `auto`, takes the new defaults
      for (const [k, m] of Object.entries(maps)) {
        if (isObj(m) && 'min' in m && !('base' in m)) maps[k] = { auto: typeof m.auto === 'boolean' ? m.auto : MAP_SCALE_DEFAULT.auto };
      }
      return applyMapSettings(defaultMapSettings(), maps, { strict: false });
    } catch (err) {
      const backup = `${path}.corrupt-${Date.now()}`;
      renameSync(path, backup);
      this.log(`maps: ${path} is unreadable (${(err as Error).message}); moved to ${backup}, using the defaults`);
      return defaultMapSettings();
    }
  }

  private save(): void {
    const p = this.file(MAP_SETTINGS_FILE);
    if (!p) return;
    mkdirSync(join(this.dataDir!, 'site'), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cur, null, 2));
    renameSync(tmp, p);
  }

  get settings(): MapSettings {
    return structuredClone(this.cur);
  }

  /** Dynamic map settings of a room kind. */
  mapScale(kind: MapRoomKind): MapScaleSettings {
    return { ...this.cur[kind] };
  }

  /** Validates, stores and applies an admin update; throws `MapSettingsError` on a bad field. */
  update(body: Record<string, unknown>): MapSettings {
    this.cur = applyMapSettings(this.cur, body);
    this.save();
    for (const fn of this.listeners) {
      try {
        fn(this.settings);
      } catch (err) {
        this.log(`maps: settings listener failed: ${(err as Error).message}`);
      }
    }
    return this.settings;
  }

  onChange(fn: (s: MapSettings) => void): void {
    this.listeners.push(fn);
  }
}
