import {
  ROBINHOOD_CHAIN_ID,
  INTEGRITY_SETTINGS_DEFAULT,
  INTEGRITY_THRESHOLD_RANGES,
  INTEGRITY_THRESHOLDS_DEFAULT,
  type IntegritySettings,
  type IntegrityThresholds,
} from '@coinnibal/shared';

/**
 * Settings read from disk: unknown or out-of-range values fall back to `defaults` (auto-hold: as saved, else the
 * default of the chain: on for the mainnet, off on a testnet; `integrityDefaults`).
 */
export function sanitizeSettings(raw: unknown, defaults: IntegritySettings = INTEGRITY_SETTINGS_DEFAULT): IntegritySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<IntegritySettings>;
  const th = { ...INTEGRITY_THRESHOLDS_DEFAULT };
  const src = (r.thresholds && typeof r.thresholds === 'object' ? r.thresholds : {}) as Partial<IntegrityThresholds>;
  for (const k of Object.keys(INTEGRITY_THRESHOLD_RANGES) as (keyof IntegrityThresholds)[]) {
    const v = src[k];
    const [lo, hi] = INTEGRITY_THRESHOLD_RANGES[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) th[k] = v;
  }
  const hold = typeof r.holdScore === 'number' && Number.isFinite(r.holdScore) && r.holdScore >= 50 && r.holdScore <= 100 ? r.holdScore : INTEGRITY_SETTINGS_DEFAULT.holdScore;
  const rel = typeof r.autoReleaseHours === 'number' && Number.isInteger(r.autoReleaseHours) && r.autoReleaseHours >= 0 && r.autoReleaseHours <= 23 ? r.autoReleaseHours : INTEGRITY_SETTINGS_DEFAULT.autoReleaseHours;
  return { autoHold: typeof r.autoHold === 'boolean' ? r.autoHold : defaults.autoHold, holdScore: hold, autoReleaseHours: rel, thresholds: th };
}

/** The integrity defaults of a chain: auto-hold on for Robinhood Chain (mainnet, 4663), off elsewhere. */
export function integrityDefaults(chainId: number | null): IntegritySettings {
  return { ...structuredClone(INTEGRITY_SETTINGS_DEFAULT), autoHold: chainId === ROBINHOOD_CHAIN_ID };
}

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/**
 * Applies an admin patch (`autoHold`, `holdScore`, `thresholds: {...}`, `reset: true`) strictly:
 * a wrong type or an out-of-range value is refused, never clamped silently.
 */
export function applySettingsPatch(cur: IntegritySettings, body: Record<string, unknown>, defaults: IntegritySettings = INTEGRITY_SETTINGS_DEFAULT): IntegritySettings {
  if (body.reset === true) return structuredClone(defaults);
  const next: IntegritySettings = { ...cur, thresholds: { ...cur.thresholds } };
  for (const key of Object.keys(body)) {
    if (key !== 'autoHold' && key !== 'holdScore' && key !== 'autoReleaseHours' && key !== 'thresholds') throw new SettingsError(`Unknown setting ${key}`, key);
  }
  if (body.autoReleaseHours !== undefined) {
    const v = body.autoReleaseHours;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23) throw new SettingsError('autoReleaseHours must be a whole number from 0 to 23', 'autoReleaseHours');
    next.autoReleaseHours = v;
  }
  if (body.autoHold !== undefined) {
    if (typeof body.autoHold !== 'boolean') throw new SettingsError('autoHold must be true or false', 'autoHold');
    next.autoHold = body.autoHold;
  }
  if (body.holdScore !== undefined) {
    const v = body.holdScore;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 50 || v > 100) throw new SettingsError('holdScore must be a number from 50 to 100', 'holdScore');
    next.holdScore = v;
  }
  if (body.thresholds !== undefined) {
    if (!body.thresholds || typeof body.thresholds !== 'object' || Array.isArray(body.thresholds)) throw new SettingsError('thresholds must be an object', 'thresholds');
    for (const [k, v] of Object.entries(body.thresholds as Record<string, unknown>)) {
      // own keys only: `constructor`, `toString` or `__proto__` must not pass as a threshold
      const range = Object.hasOwn(INTEGRITY_THRESHOLD_RANGES, k) ? INTEGRITY_THRESHOLD_RANGES[k as keyof IntegrityThresholds] : undefined;
      if (!range) throw new SettingsError(`Unknown threshold ${k}`, `thresholds.${k}`);
      if (typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) {
        throw new SettingsError(`${k} must be a number from ${range[0]} to ${range[1]}`, `thresholds.${k}`);
      }
      next.thresholds[k as keyof IntegrityThresholds] = v;
    }
  }
  return next;
}
