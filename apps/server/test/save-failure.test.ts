import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Leaderboards } from '../src/leaderboards';
import { ProfileStore } from '../src/profiles';

/** A path whose parent is a file: every write under it fails (ENOTDIR), as on a broken or full disk. */
function unwritable(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-savefail-'));
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, '');
  return join(blocker, name);
}

describe('a failing disk never throws out of a store save (a save timer would stop the server)', () => {
  it('leaderboards keep their boards in memory and do not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lb = new Leaderboards(unwritable('leaderboards.json'), 1_800_000_000_000);
    (lb as unknown as { dirty: boolean }).dirty = true;
    expect(() => lb.flush()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('profiles do not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ProfileStore(unwritable('profiles.json'));
    (store as unknown as { dirty: boolean }).dirty = true;
    expect(() => store.flush()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
