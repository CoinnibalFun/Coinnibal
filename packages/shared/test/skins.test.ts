import { describe, expect, it } from 'vitest';
import {
  BASIC_SKINS,
  EMOTES,
  emoteForSlot,
  EMOTE_BAR,
  emoteEmoji,
  SKINS,
  defaultName,
  getSkin,
  isBasicSkin,
  sanitizeChat,
  sanitizeName,
  truncateUtf8,
  utf8Length,
} from '../src';

describe('skin catalog', () => {
  it('has 24 skins with sequential ids and the on-chain tier layout', () => {
    expect(SKINS).toHaveLength(24);
    SKINS.forEach((s, i) => {
      expect(s.id).toBe(i);
      const expected = i < 8 ? 'free' : i < 16 ? 'level' : 'premium';
      expect(s.tier).toBe(expected);
    });
    expect(SKINS.slice(8, 16).map((s) => s.level)).toEqual([2, 3, 5, 7, 10, 13, 16, 20]);
    expect(new Set(SKINS.map((s) => s.key)).size).toBe(24);
  });

  it('BASIC_SKINS are the 8 free skins, ids 0..7', () => {
    expect(BASIC_SKINS).toHaveLength(8);
    expect(BASIC_SKINS.map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(BASIC_SKINS.every((s) => s.tier === 'free')).toBe(true);
    expect(BASIC_SKINS.every((s, i) => s === SKINS[i])).toBe(true);
  });

  it('isBasicSkin accepts exactly ids 0..7', () => {
    for (let id = 0; id < 8; id++) expect(isBasicSkin(id)).toBe(true);
    for (const id of [8, 9, 15, 16, 23, 24, 999, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(isBasicSkin(id), String(id)).toBe(false);
  });

  it('falls back to skin 0 for unknown ids', () => {
    expect(getSkin(999).id).toBe(0);
  });

  it('emote ids stay put on the wire (0..15, the crown appended as 16); the bar is eight emoji on keys 1-8', () => {
    expect(EMOTES.map((e) => e.id)).toEqual(Array.from({ length: 17 }, (_, i) => i));
    expect(EMOTES.slice(0, 8).map((e) => e.key)).toEqual(['gm', 'wagmi', 'rocket', 'diamond', 'cry', 'yum', 'salute', 'love']);
    expect(EMOTE_BAR).toHaveLength(8);
    expect(emoteForSlot(0)).toBe(11);
    expect(emoteForSlot(3)).toBe(16);
    expect(emoteForSlot(8)).toBeNull();
    expect(emoteEmoji(16)).toBe('👑');
  });

});

describe('text sanitizing', () => {
  const FALLBACK = defaultName('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');

  it('cleans names', () => {
    expect(sanitizeName('  hello   world  ', FALLBACK)).toBe('hello world');
    expect(sanitizeName('‮evil\u0000', FALLBACK)).toBe('evil');
    expect(sanitizeName('', FALLBACK)).toBe(FALLBACK);
    expect(sanitizeName(42, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeName('abcdefghijklmnopqrstuvwxyz', FALLBACK)).toHaveLength(16);
    expect(sanitizeName('🚀'.repeat(20), FALLBACK)).toBe('🚀'.repeat(16));
  });

  it('blank-looking names fall back (Hangul fillers, braille blank, joiners)', () => {
    expect(sanitizeName('ㅤㅤㅤ', FALLBACK)).toBe(FALLBACK);
    expect(sanitizeName('⠀ᅟᅠﾠ͏᠎؜', FALLBACK)).toBe(FALLBACK);
    expect(sanitizeName('aㅤb', FALLBACK)).toBe('ab');
  });

  it('a player who set no name is "Coinie" and a tag of their own seed: stable, told apart, a valid name as it is', () => {
    const w = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(defaultName(w)).toMatch(/^Coinie-[0-9a-f]{4}$/);
    // the same wallet in any case is the same name (the client sends the checksummed address, the server may hold either)
    expect(defaultName(w.toLowerCase())).toBe(defaultName(w));
    expect(defaultName(w)).toBe(FALLBACK);
    // different players: different names, never one "Coinie" for everybody
    const wallets = Array.from({ length: 200 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    expect(new Set(wallets.map(defaultName)).size).toBeGreaterThanOrEqual(199);
    expect(defaultName('conn:1')).not.toBe(defaultName('conn:2'));
    // every name of that form passes the name rules untouched (hex tags: never reserved, within the length limit)
    const bad: string[] = [];
    for (let tag = 0; tag < 0x10000; tag++) {
      const name = `Coinie-${tag.toString(16).padStart(4, '0')}`;
      if (sanitizeName(name, '') !== name) bad.push(name);
    }
    expect(bad).toEqual([]);
  });

  it('cleans chat', () => {
    expect(sanitizeChat('  gm \n frens ')).toBe('gm frens');
    expect(sanitizeChat('x'.repeat(500))).toHaveLength(100);
    expect(sanitizeChat(null)).toBe('');
  });

  it('truncates utf8 safely', () => {
    expect(utf8Length('é')).toBe(2);
    expect(truncateUtf8('ééééééééé', 16)).toBe('éééééééé');
    expect(truncateUtf8('🚀🚀🚀🚀🚀', 16)).toBe('🚀🚀🚀🚀');
  });
});
