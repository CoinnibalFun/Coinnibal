import { isFingerprint } from '@coinnibal/shared';
import { describe, expect, it, vi } from 'vitest';
import { fingerprint } from '../src/integrity/fingerprint';

describe('browser fingerprint', () => {
  it('is a hex hash the server accepts, stable in one browser, and keeps no readable data', async () => {
    fingerprint();
    await new Promise((r) => setTimeout(r, 50));
    const fp = fingerprint();
    expect(isFingerprint(fp)).toBe(true);
    expect(fp).toHaveLength(32);
    expect(fingerprint()).toBe(fp);
    // only a random install id is stored
    expect(localStorage.getItem('coinnibal.device.v1')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('audit: a browser without storage sent the same fingerprint as every phone like it (fixed)', () => {
  it('sends none when the install id cannot be kept', async () => {
    vi.resetModules();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      const fresh = await import('../src/integrity/fingerprint');
      fresh.fingerprint();
      await new Promise((r) => setTimeout(r, 50));
      // before: a hash of the coarse settings alone ("no-storage", language, time zone, screen, CPU count)
      expect(fresh.fingerprint()).toBeUndefined();
    } finally {
      get.mockRestore();
    }
  });
});
