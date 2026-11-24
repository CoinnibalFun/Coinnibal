import { describe, expect, it } from 'vitest';
import { ARENA_META, DEFAULT_ARENAS, arenaMeta } from '../src';

describe('arena catalog', () => {
  it('ships the four USD tiers ($1, $3, $5, $10; the $10 one for holders), created at the reference price', () => {
    expect(DEFAULT_ARENAS).toEqual([
      { id: 1, usdCents: 100, entryTokens: 1000, maxSessions: 1500, holdersOnly: false },
      { id: 2, usdCents: 300, entryTokens: 3000, maxSessions: 1500, holdersOnly: false },
      { id: 3, usdCents: 500, entryTokens: 5000, maxSessions: 1500, holdersOnly: false },
      { id: 4, usdCents: 1000, entryTokens: 10000, maxSessions: 1500, holdersOnly: true },
    ]);
  });

  it('has display metadata for every default arena and nothing else', () => {
    expect(Object.keys(ARENA_META).map(Number)).toEqual(DEFAULT_ARENAS.map((a) => a.id));
    for (const a of DEFAULT_ARENAS) {
      const meta = arenaMeta(a.id);
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.ink).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('names the tiers by their ticket price, plainly', () => {
    expect(DEFAULT_ARENAS.map((a) => arenaMeta(a.id).name)).toEqual(['$1 Room', '$3 Room', '$5 Room', '$10 Room']);
  });

  it('uses the arena inks of the design spec', () => {
    expect(DEFAULT_ARENAS.map((a) => arenaMeta(a.id).ink)).toEqual(['#6FCDE8', '#93D9EE', '#F2C14E', '#3C9A87']);
    expect(arenaMeta(2).inkTo).toBe('#2D7388');
    expect(arenaMeta(1).inkTo).toBeUndefined();
  });

  it('gives every tier its own ink and keeps entry fees ascending', () => {
    expect(new Set(DEFAULT_ARENAS.map((a) => arenaMeta(a.id).ink)).size).toBe(DEFAULT_ARENAS.length);
    const fees = DEFAULT_ARENAS.map((a) => a.entryTokens);
    expect([...fees].sort((a, b) => a - b)).toEqual(fees);
  });

  it('falls back to a generic ticket for unknown arena ids', () => {
    const meta = arenaMeta(77);
    expect(meta.name).toBe('Arena #77');
    expect(meta.ink).toMatch(/^#[0-9A-F]{6}$/);
  });
});
